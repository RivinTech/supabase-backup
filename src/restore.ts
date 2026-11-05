import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { finished, pipeline } from 'node:stream/promises';
import type pg from 'pg';
import {
	authColumnPlan,
	authContentDiff,
	authInsertSQL,
	checkAuthArchive,
	checkManifest,
	checkRestoreTarget,
	checkToolVersion,
	compareManifest,
	migrationHash,
	normalizeIdentity,
	parseLosslessJSON,
	populatedMatviews,
	parseRestoreArgs,
	sequenceFailures,
	type AuthTable,
	type DatabaseState
} from './backupCore.ts';
import { readDatabaseState, serverVersion, setReproducibleOutput } from './backupDB.ts';
import type { Config } from './config.ts';
import {
	hashFile,
	parseDBURL,
	pgEnv,
	pgTool,
	projectEnv,
	projectPath,
	pushMigrations,
	runOrThrow,
	stepTimer,
	withClient as connectWith,
	type ParsedDBURL
} from './db.ts';

/**
 * `supabase-backup restore --backup <path to .tar.age> --identity <path to key file> --target-ref <ref>`: restores a
 * backup into a new, empty Supabase project, then checks the result against the backup's manifest. Run by the user
 * only. Runbook: README > Restore procedure.
 *
 * Invariants:
 * - **Never into an existing project.** The target must be neither production nor dev, and must be empty.
 * - **The schema comes from the repo's migrations, the data from the backup.** Each backed-up migration must match
 *   its repo file, and `db push` applies only those; then one psql transaction loads all the data, or none of it.
 * - **Proven, not assumed.** PASS means every table's rows hash equal to the backup's, the auth rows match, the
 *   policies and RLS state match, and no sequence would hand out an existing id.
 * - **Decrypted data doesn't outlive the run.** It lives in one temp directory, removed in `finally` and on Ctrl+C.
 * - **No secrets in output.** Everything printed passes through `redact`; the key file is never printed.
 */

const AUTH_TABLES: AuthTable[] = ['users', 'identities'];
// Module scope, like `loading`: the CLI runs one restore per process.
const { steps, step } = stepTimer();
/** The load's psql and pg_restore, for the signal handler to kill. */
const loading: ChildProcess[] = [];

/** `withClient` with the restore's connection hint. */
const withClient = <T>(db: ParsedDBURL, body: (client: pg.Client) => Promise<T>) =>
	connectWith(
		db,
		body,
		"Check that RESTORE_DB_URL in supabase/.env is the new project's session pooler URL, as postgres."
	);

/** Restore needs 17.6 or later: pg_restore 17.6 writes `\restrict` lines that older psql rejects. */
async function checkTool(path: string, redact: (text: string) => string): Promise<void> {
	checkToolVersion(path, await runOrThrow(path, ['--version'], redact), 6);
}

/** Refuses any target that already holds one of the backed-up schemas, migrations, or users. */
async function checkEmpty(client: pg.Client, schemas: string[]): Promise<void> {
	const { rows } = await client.query<{
		schemas: string[];
		migrationsTable: boolean;
		users: number;
	}>(
		`select array(select s from unnest($1::text[]) s where to_regnamespace(s) is not null) as schemas,
		   to_regclass('supabase_migrations.schema_migrations') is not null as "migrationsTable",
		   (select count(*)::int from auth.users) as users`,
		[schemas]
	);
	const state = {
		...rows[0]!,
		migrations: rows[0]!.migrationsTable
			? (
					await client.query<{ n: number }>(
						'select count(*)::int as n from supabase_migrations.schema_migrations'
					)
				).rows[0]!.n
			: 0
	};
	const found = [
		...state.schemas.map((name) => `a ${name} schema`),
		state.migrations > 0 && `${state.migrations} applied migrations`,
		state.users > 0 && `${state.users} auth users`
	].filter(Boolean);
	if (found.length) {
		throw new Error(
			`the target isn't empty (it has ${found.join(', ')}); restore into a new, empty project`
		);
	}
}

/** The columns of `auth.<table>`, in table order: those an insert can set, and the generated ones. */
async function targetColumns(
	client: pg.Client,
	table: AuthTable
): Promise<{ insertable: string[]; generated: string[] }> {
	const { rows } = await client.query<{ name: string; generated: boolean }>(
		`select attname as name, attgenerated <> '' as generated from pg_catalog.pg_attribute
		 where attrelid = $1::regclass and attnum > 0 and not attisdropped
		 order by attnum`,
		[`auth.${table}`]
	);
	return {
		insertable: rows.filter((r) => !r.generated).map((r) => r.name),
		generated: rows.filter((r) => r.generated).map((r) => r.name)
	};
}

/**
 * The state of every sequence a column owns (identity or serial), with its table's largest value. A partitioned table
 * is read through its parent, which owns the sequence; partitions are skipped. A `nextval` default on a sequence no
 * column owns isn't tied to one column, so it isn't checked.
 */
async function sequenceStates(client: pg.Client, schemas: string[]) {
	const { rows: columns } = await client.query<{ rel: string; col: string; seq: string }>(
		`select rel, col, seq from (
		   select format('%I.%I', n.nspname, c.relname) as rel, format('%I', a.attname) as col,
		     pg_catalog.pg_get_serial_sequence(format('%I.%I', n.nspname, c.relname), a.attname) as seq
		   from pg_catalog.pg_attribute a
		   join pg_catalog.pg_class c on c.oid = a.attrelid
		   join pg_catalog.pg_namespace n on n.oid = c.relnamespace
		   where n.nspname = any ($1) and a.attnum > 0 and not a.attisdropped
			     and (a.attidentity <> '' or a.atthasdef)
		     and c.relkind in ('r', 'p') and not c.relispartition
		 ) owned
		 where seq is not null
		 order by 1, 2`,
		[schemas]
	);
	const states = [];
	for (const { rel, col, seq } of columns) {
		const { rows } = await client.query<{
			last_value: string;
			is_called: boolean;
			descending: boolean;
			furthest_id: string | null;
		}>(
			`select s.last_value::text, s.is_called, q.seqincrement < 0 as descending,
			   (select (case when q.seqincrement < 0 then min(${col}) else max(${col}) end)::text from ${rel}) as furthest_id
			 from ${seq} s, pg_catalog.pg_sequence q where q.seqrelid = $1::regclass`,
			[seq]
		);
		const r = rows[0]!;
		states.push({
			seq,
			lastValue: BigInt(r.last_value),
			isCalled: r.is_called,
			descending: r.descending,
			furthestId: r.furthest_id === null ? null : BigInt(r.furthest_id)
		});
	}
	return states;
}

/**
 * Streams the data, then the auth inserts, into one psql transaction. Rejects unless both tools exit 0.
 *
 * It spawns its own children rather than using `runCommand`: it pipes one into the other and has to decide psql's end
 * of input from pg_restore's exit, which a run-to-completion helper can't express. Its only output, stderr, goes
 * through the same `redact`. `VERBOSITY=terse` keeps each psql error to its primary message: without it a failed COPY
 * or insert prints `DETAIL: Failing row contains …` and the COPY input line as `CONTEXT`, which would put password
 * hashes and emails in the terminal. A primary message can still quote one bad value (`invalid input syntax for type
 * uuid: "…"`); that's the operator's own data in their own terminal, and the run fails there.
 */
async function loadIntoTarget(
	db: ParsedDBURL,
	schemas: string[],
	dump: string,
	authSQL: string
): Promise<void> {
	const psql = spawn(
		pgTool('psql'),
		[
			'-X',
			'-q',
			'-v',
			'ON_ERROR_STOP=1',
			'-v',
			'VERBOSITY=terse',
			'--single-transaction',
			'-f',
			'-'
		],
		{
			env: pgEnv(db),
			stdio: ['pipe', 'ignore', 'pipe']
		}
	);
	const restore = spawn(
		pgTool('pg_restore'),
		['--data-only', ...schemas.flatMap((s) => ['-n', s]), '-f', '-', dump],
		{ stdio: ['ignore', 'pipe', 'pipe'] }
	);
	for (const [name, child] of [
		['psql', psql],
		['pg_restore', restore]
	] as const) {
		createInterface({ input: child.stderr }).on('line', (line) =>
			console.log(db.redact(`${name}: ${line}`))
		);
	}
	const exited = (child: typeof psql | typeof restore) =>
		new Promise<number | null>((resolve) => {
			child.on('error', (error) => {
				console.log(db.redact(String(error)));
				resolve(null);
			});
			child.on('close', resolve);
		});
	loading.push(psql, restore);
	const psqlExit = exited(psql);
	const restoreExit = exited(restore);
	let streamError: unknown;
	try {
		// A `SET`, not set_config: Supabase refuses set_config for this setting.
		psql.stdin.write('set session_replication_role = replica;\n');
		await pipeline(restore.stdout, psql.stdin, { end: false });
		// pg_restore failing midway still ends its stdout cleanly, and psql commits on end of input, so psql's input
		// ends only after pg_restore succeeded; otherwise killing psql drops the connection and rolls the load back.
		// Through the pooler the server may end that transaction a moment later, but COMMIT is never sent, so no row
		// of it is ever visible; a retry at worst waits on its locks.
		if ((await restoreExit) === 0) {
			psql.stdin.end(authSQL);
			await finished(psql.stdin);
		} else psql.kill();
	} catch (error) {
		// psql exiting early (an SQL error) breaks the pipe; its exit code and stderr say why.
		streamError = error;
		// Kill before closing its input: psql reads a closed pipe as end of input and would commit what it has.
		psql.kill();
		restore.kill();
		psql.stdin.destroy();
	}
	const [psqlCode, restoreCode] = await Promise.all([psqlExit, restoreExit]);
	if (psqlCode !== 0 || restoreCode !== 0) {
		throw new Error(
			`the load rolled back (psql exited ${psqlCode}, pg_restore exited ${restoreCode})`
		);
	}
	if (streamError) throw new Error(db.redact(`streaming to psql failed: ${String(streamError)}`));
}

/** Recomputes the manifest's state on the target, and diffs the auth rows, in one read-only transaction. */
async function verify(
	client: pg.Client,
	schemas: string[],
	plans: Record<AuthTable, string[]>,
	archive: Record<AuthTable, Record<string, unknown>[]>
): Promise<{ state: DatabaseState; authDiffs: string[]; sequences: string[] }> {
	// Read only, and the caller closes the connection, so a failure needs no rollback; one in a `finally` could fail
	// too (an aborted transaction, a dropped connection) and hide the real error.
	await client.query('begin isolation level repeatable read read only');
	await setReproducibleOutput(client);
	const authRows = {} as Record<AuthTable, Record<string, unknown>[]>;
	const authDiffs: string[] = [];
	for (const table of AUTH_TABLES) {
		const { rows } = await client.query<{ row: string }>(
			// t.*, not t: a column named t would win over the alias.
			`select to_jsonb(t.*)::text as row from auth.${table} t`
		);
		authRows[table] = rows.map((r) => parseLosslessJSON(r.row) as Record<string, unknown>);
		const ids = authContentDiff(archive[table], authRows[table], plans[table]);
		if (ids.length)
			authDiffs.push(`auth.${table}: ${ids.length} rows differ (ids ${ids.join(', ')})`);
	}
	const state: DatabaseState = {
		...(await readDatabaseState(client, schemas)),
		auth: {
			users: { rows: authRows.users.length },
			identities: { rows: authRows.identities.length }
		}
	};
	const sequences = sequenceFailures(await sequenceStates(client, schemas));
	await client.query('rollback');
	return { state, authDiffs, sequences };
}

/**
 * One restore into `work`, configured by the arguments and `supabase/.env`. Returns whether the verify passed; throws
 * on any other failure, with the message redacted once the URL is known.
 */
async function main(
	config: Config,
	args: ReturnType<typeof parseRestoreArgs>,
	work: string
): Promise<boolean> {
	const db = parseDBURL(
		projectEnv('RESTORE_DB_URL', "the new project's session pooler URL as postgres"),
		'RESTORE_DB_URL'
	);
	checkRestoreTarget(config, db, args.targetRef);
	try {
		return await restore(work, args, db);
	} catch (error) {
		throw new Error(db.redact(error instanceof Error ? error.message : String(error)));
	}
}

/** The restore once its target is checked; `main` redacts whatever it throws. */
async function restore(
	work: string,
	args: { backup: string; identity: string; targetRef: string },
	db: ParsedDBURL
): Promise<boolean> {
	const totalStart = performance.now();
	const redact = db.redact;
	const file = (name: string) => join(work, name);

	const target = await step('guard', async () => {
		await checkTool(pgTool('pg_restore'), redact);
		await checkTool(pgTool('psql'), redact);
		await runOrThrow('age', ['--version'], redact);
		return withClient(db, async (client) => {
			const server = await serverVersion(client);
			console.log(`Target ${args.targetRef}: PostgreSQL ${server.version}`);
			return server;
		});
	});

	// Before the slow decrypt: the migrations step copies it into the push folder.
	if (!existsSync(projectPath('config.toml'))) {
		throw new Error(
			`${projectPath('config.toml')} is missing; run the restore in the project's checkout`
		);
	}

	const { manifest, archive } = await step('decrypt', async () => {
		console.log(
			`Backup SHA-256: ${(await hashFile(args.backup, ['sha256'])).sha256} (match it against the backup run's summary)`
		);
		const identity = file('identity.txt');
		writeFileSync(identity, `${normalizeIdentity(readFileSync(args.identity))}\n`, { mode: 0o600 });
		try {
			await runOrThrow(
				'age',
				['-d', '-i', identity, '-o', file('backup.tar'), args.backup],
				redact
			);
		} catch (error) {
			throw new Error(
				`age couldn't decrypt (most often the key doesn't match this backup's recipient, or the file is damaged): ${error instanceof Error ? error.message : String(error)}`
			);
		}
		// Relative to `work`: GNU tar (Git for Windows puts one on PATH) reads `C:\…` as a remote host. Only the three
		// members the backup writes, so an archive can't plant files (say, under supabase/migrations/, which db push
		// applies), and each must be a plain file, not a link out of `work`.
		const members = ['manifest.json', 'app.dump', 'auth.json'];
		await runOrThrow('tar', ['-xf', 'backup.tar', ...members], redact, work);
		rmSync(file('backup.tar'));
		for (const member of members) {
			if (!lstatSync(file(member)).isFile())
				throw new Error(`${member} in the backup isn't a plain file`);
		}
		const parsed = checkManifest(JSON.parse(readFileSync(file('manifest.json'), 'utf8')));
		for (const [name, expected] of Object.entries(parsed.files)) {
			if ((await hashFile(file(name), ['sha256'])).sha256 !== expected.sha256) {
				throw new Error(`${name} doesn't match its SHA-256 in the manifest; the backup is damaged`);
			}
		}
		// Checked here, before anything touches the target, like the manifest.
		const archive = checkAuthArchive(
			parseLosslessJSON(readFileSync(file('auth.json'), 'utf8')),
			parsed
		);
		console.log(
			`Backup of ${parsed.target} (${parsed.ref}) taken ${parsed.createdAt} on PostgreSQL ${parsed.serverVersion}, commit ${parsed.gitCommit ?? 'unknown'}, schemas ${parsed.schemas.join(', ')}`
		);
		return { manifest: parsed, archive };
	});
	const { schemas } = manifest;
	const backupMajor = Number(manifest.serverVersion.split('.')[0]);
	if (target.major !== backupMajor) {
		throw new Error(
			`the target is PostgreSQL ${target.version} but the backup is ${manifest.serverVersion}: create the project on Postgres ${backupMajor}`
		);
	}
	// After the decrypt, which leaves the target untouched: the backed-up schemas come from the manifest.
	await step('check target', () => withClient(db, (client) => checkEmpty(client, schemas)));

	await step('migrations', async () => {
		const backedUp = manifest.migrations.map((m) => ({ ...m, file: `${m.version}_${m.name}.sql` }));
		const mismatched = backedUp.filter((m) => {
			const path = projectPath('migrations', m.file);
			return !existsSync(path) || migrationHash(readFileSync(path, 'utf8')) !== m.hash;
		});
		if (mismatched.length) {
			throw new Error(
				`these backed-up migrations are missing from supabase/migrations/ or differ: ${mismatched.map((m) => m.file).join(', ')}. Check out commit ${manifest.gitCommit ?? '(unknown)'} and retry`
			);
		}
		const migrations = join(work, 'supabase', 'migrations');
		mkdirSync(migrations, { recursive: true });
		copyFileSync(projectPath('config.toml'), join(work, 'supabase', 'config.toml'));
		for (const m of backedUp)
			copyFileSync(projectPath('migrations', m.file), join(migrations, m.file));
		const { code } = await pushMigrations({
			cliURL: db.cliURL,
			password: db.password,
			workdir: work,
			redact
		});
		if (code !== 0) throw new Error(`supabase db push exited with ${code}`);
		// The data load copies every row of every backed-up table, so a migration that seeds one would duplicate or
		// collide with the backup's copy. Seed rows belong in the backup (README > Configure says so); refusing here
		// is cheaper than a half-loaded target. The full state read, though only counts matter: right after the push
		// every table is empty, so it's cheap.
		const nonEmpty = await withClient(db, async (client) =>
			(await readDatabaseState(client, schemas)).tables.filter((t) => t.rows > 0).map((t) => t.name)
		);
		if (nonEmpty.length) {
			throw new Error(
				`after the migrations these tables already have rows: ${nonEmpty.join(', ')}`
			);
		}
	});

	const plans = await step('authPlan', () =>
		withClient(db, async (client) => {
			const plans = {} as Record<AuthTable, string[]>;
			for (const table of AUTH_TABLES) {
				const columns = await targetColumns(client, table);
				const plan = authColumnPlan(
					table,
					manifest.auth[table].columns,
					columns.insertable,
					columns.generated
				);
				for (const column of plan.missingInTarget) {
					const nonNull = archive[table].filter((row) => row[column] != null).length;
					console.log(
						`auth.${table}.${column} isn't in the target and is dropped (${nonNull} non-null values)`
					);
				}
				if (plan.onlyInTarget.length) {
					console.log(
						`auth.${table} columns that get their defaults: ${plan.onlyInTarget.join(', ')}`
					);
				}
				plans[table] = plan.insert;
			}
			return plans;
		})
	);

	await step('load', () => {
		const tag = `sb_${randomBytes(8).toString('hex')}`;
		const authSQL = AUTH_TABLES.filter((t) => archive[t].length)
			.map((t) => authInsertSQL(t, plans[t], archive[t], tag))
			.join('');
		return loadIntoTarget(db, schemas, file('app.dump'), authSQL);
	});

	await step('analyze', () =>
		withClient(db, async (client) => {
			// pg_restore --data-only skips materialized view data (a post-data item), so refresh, from the loaded
			// tables, exactly the views the backup held populated, in the archive's dependency order. This runs after
			// the load committed: a refresh that fails fails the restore, and the new project is discarded and redone.
			// Listing the archive again costs well under a second; keeping the guard step's list would thread it through.
			const list = await runOrThrow(pgTool('pg_restore'), ['--list', file('app.dump')], redact);
			for (const view of populatedMatviews(list)) {
				await client.query(`refresh materialized view ${view}`);
			}
			const { rows } = await client.query<{ rel: string }>(
				`select format('%I.%I', schemaname, tablename) as rel from pg_catalog.pg_tables where schemaname = any ($1)`,
				[schemas]
			);
			// A bare `analyze` would cover the whole database. The tables of the manifest's schemas, which the restore
			// trusts, so not devDB's backedUpTables, which reads backup.schemas() and tolerates its absence.
			if (rows.length) await client.query(`analyze ${rows.map((r) => r.rel).join(', ')}`);
		})
	);

	const result = await step('verify', () =>
		withClient(db, (client) => verify(client, schemas, plans, archive))
	);
	const failures = [
		...compareManifest(manifest, result.state),
		...result.authDiffs,
		...result.sequences
	];
	for (const failure of failures) console.log(`FAIL ${failure}`);
	console.log(failures.length ? `FAIL (${failures.length} differences)` : 'PASS');
	console.log(JSON.stringify({ steps, totalMs: Math.round(performance.now() - totalStart) }));
	return failures.length === 0;
}

/** `restore` with its command-line arguments. Returns whether the verify passed; `main` redacts whatever it throws. */
export async function runRestore(config: Config, argv: string[]): Promise<boolean> {
	const args = parseRestoreArgs(argv);
	let work: string | undefined;
	const cleanUp = () => {
		if (!work) return;
		try {
			rmSync(work, { recursive: true, force: true });
		} catch {
			// On Windows a child still holding a file makes this fail.
			console.error(`couldn't remove ${work}; it holds decrypted data, so delete it by hand`);
		}
	};
	// The shell's convention, 128 + the signal number. The load's children die first, psql before its input closes as
	// this process exits: psql reads a closed pipe as end of input and would commit what it has.
	for (const [signal, number] of [
		['SIGINT', 2],
		['SIGTERM', 15]
	] as const) {
		process.on(signal, () => {
			for (const child of loading) child.kill();
			cleanUp();
			process.exit(128 + number);
		});
	}
	try {
		work = mkdtempSync(join(tmpdir(), 'supabase-backup-restore-'));
		console.log(
			`Working in ${work} (holds decrypted data; delete it by hand if this process is killed)`
		);
		return await main(config, args, work);
	} finally {
		cleanUp();
	}
}
