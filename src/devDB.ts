import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { missingSchemasFunction } from './backupDB.ts';
import { comparable } from './comparable.ts';
import type { Config } from './config.ts';
import {
	packageRoot,
	parseDBURL,
	projectEnv,
	projectPath,
	pushMigrations,
	withClient as connectWith,
	type ParsedDBURL
} from './db.ts';

/**
 * The dev database runner: `push`, `test`, and `perf` against the project's dev database
 * (`supabase-backup.json`'s `dev`).
 *
 * This is a terminal tool, so its output (TAP lines, timings, notices) goes straight to the
 * console instead of through a JSON logger.
 *
 * Invariants:
 * - **Dev only.** Every command parses `DEV_DB_URL` and throws before connecting unless its user is
 *   exactly `postgres.<dev ref>` and the production ref appears nowhere in it (an allowlist, so a
 *   mistyped URL for any other project fails too). The runner never touches production.
 * - **Verified TLS and no secrets in output**, as `db.ts` describes. Everything printed, including
 *   CLI output and error text, passes through `redact`.
 * - **Pushed migrations are frozen.** Every command runs the drift guard first, so an edited
 *   migration can't be tested, measured, or pushed.
 * - **Tests and perf never persist schema changes.** Each run applies the pending migrations,
 *   the fixtures, and the script inside one transaction that always rolls back. The one exception
 *   is `test` installing the pgTAP extension on dev, idempotently, which production never gets.
 * - **The shipped privilege test always runs.** After the project's own tests, `test` runs the
 *   package's `tests/backup_reader.sql` without the project's fixtures, so it can't depend on them.
 */

/** Free projects go read-only at 500 MB; `perf` refuses to start above this. */
const PERF_MAX_START_BYTES = 250 * 1024 * 1024;

/** The dev-only guard on `DEV_DB_URL`'s value. Throws before any connection is made. */
export function checkDevURL(config: Config, raw: string | undefined): ParsedDBURL {
	const trimmed = raw?.trim() ?? '';
	// Before parseDBURL: its message doesn't say where the variable goes, and the production check reads the raw URL.
	if (!trimmed) throw new Error('DEV_DB_URL is required in supabase/.env');
	if (trimmed.includes(config.production.ref)) {
		throw new Error('DEV_DB_URL points at production; refusing.');
	}
	const db = parseDBURL(trimmed, 'DEV_DB_URL');
	if (db.user !== `postgres.${config.dev.ref}`) {
		throw new Error(
			`DEV_DB_URL user must be postgres.${config.dev.ref}; got ${db.user}. Refusing.`
		);
	}
	return db;
}

const sqlFiles = (dir: string) =>
	readdirSync(dir)
		.filter((f) => f.endsWith('.sql'))
		.sort();
const readSQL = (dir: string, file: string) => readFileSync(join(dir, file), 'utf8');
const shippedTests = fileURLToPath(new URL('tests/', packageRoot));

/**
 * Returns the migration files not yet recorded in `supabase_migrations.schema_migrations`, in name
 * order. Drift guard: throws if an applied migration's file no longer matches what was pushed,
 * because tests would then pass against a file that production may later receive in a different form.
 */
async function pendingMigrations(client: pg.Client): Promise<string[]> {
	const migrations = projectPath('migrations');
	const files = sqlFiles(migrations);
	const { rows: exists } = await client.query<{ present: boolean }>(
		`select to_regclass('supabase_migrations.schema_migrations') is not null as present`
	);
	const applied = exists[0]?.present
		? (
				await client.query<{ version: string; statements: string[] | null }>(
					'select version, statements from supabase_migrations.schema_migrations'
				)
			).rows
		: [];
	const appliedByVersion = new Map(applied.map((m) => [m.version, m.statements]));
	const version = (file: string) => file.split('_')[0] ?? file;
	const drifted = files.filter((f) => {
		const statements = appliedByVersion.get(version(f));
		// Null statements (a version recorded by `migration repair`) can't be compared, so they count as unknown, not drift.
		return (
			statements != null && comparable(statements.join(';')) !== comparable(readSQL(migrations, f))
		);
	});
	if (drifted.length) {
		throw new Error(
			`Pushed migrations were edited (fix forward with a new migration): ${drifted.join(', ')}`
		);
	}
	return files.filter((f) => !appliedByVersion.has(version(f)));
}

/**
 * Runs `body` in one transaction after applying `pending`, and always rolls back.
 * Returns the milliseconds `body` took.
 */
async function inRolledBackTransaction<T>(
	client: pg.Client,
	pending: string[],
	body: () => Promise<T>
): Promise<{ result: T; ms: number }> {
	await client.query('begin');
	try {
		for (const file of pending) await client.query(readSQL(projectPath('migrations'), file));
		const start = performance.now();
		const result = await body();
		return { result, ms: Math.round(performance.now() - start) };
	} finally {
		await client.query('rollback');
	}
}

/** `pg` returns one result for a single statement and an array for several. */
const resultList = (r: pg.QueryResult | pg.QueryResult[]) => (Array.isArray(r) ? r : [r]);

/** Matches pgTAP output lines; other single-column results (such as `set_config`) are not TAP. */
const TAP_LINE = /^(ok|not ok|1\.\.\d+|\s*#)/;

/** Extracts TAP lines from every single-column text result of a multi-statement query. */
function tapLines(results: pg.QueryResult[]): string[] {
	return results
		.filter((r) => r.fields.length === 1)
		.flatMap((r) => r.rows.map((row) => Object.values(row)[0]))
		.filter((v): v is string => typeof v === 'string')
		.flatMap((v) => v.split('\n'))
		.filter((line) => TAP_LINE.test(line));
}

/**
 * Returns why a file's TAP output fails, or null when it passes. pgTAP's `finish(true)` could raise
 * instead, but this also catches a file that never declares a plan.
 */
function tapFailure(lines: string[]): string | null {
	const planned = Number(lines.find((l) => l.startsWith('1..'))?.slice(3));
	if (Number.isNaN(planned)) return 'no plan';
	const failed = lines.filter((l) => l.startsWith('not ok')).length;
	if (failed) return `${failed} failed`;
	const ran = lines.filter((l) => /^(ok|not ok)\b/.test(l)).length;
	if (planned !== ran) return `planned ${planned}, ran ${ran}`;
	return null;
}

type TestFile = { dir: string; file: string; label: string; fixtures: string };

/**
 * The project's `tests/*.sql` (except `_*` files), each after `tests/_fixtures.sql` if it exists, then the shipped
 * test without fixtures. A project needs neither folder.
 */
function testFiles(): TestFile[] {
	const dir = projectPath('tests');
	const project = existsSync(dir) ? sqlFiles(dir).filter((f) => !f.startsWith('_')) : [];
	const fixtures = existsSync(join(dir, '_fixtures.sql')) ? readSQL(dir, '_fixtures.sql') : '';
	return [
		...project.map((file) => ({ dir, file, label: file, fixtures })),
		{
			dir: shippedTests,
			file: 'backup_reader.sql',
			label: 'supabase-backup/tests/backup_reader.sql',
			fixtures: ''
		}
	];
}

/** `test`: runs each test file in its own rolled-back transaction. */
async function runTests(db: ParsedDBURL, client: pg.Client): Promise<boolean> {
	// pgTAP is a dev-only tool; production never gets it.
	await client.query('create extension if not exists pgtap with schema extensions');
	const pending = await pendingMigrations(client);
	const files = testFiles();
	let failedFiles = 0;
	// Each file re-applies the pending migrations in its own transaction: slower before a push, but no file can see
	// another's leftovers. After a push nothing is pending, so it costs nothing.
	for (const { dir, file, label, fixtures } of files) {
		let failure: string | null;
		let ms = 0;
		try {
			const run = await inRolledBackTransaction(client, pending, async () => {
				if (fixtures) await client.query(fixtures);
				return tapLines(resultList(await client.query(readSQL(dir, file))));
			});
			for (const line of run.result) console.log(db.redact(line));
			failure = tapFailure(run.result);
			ms = run.ms;
		} catch (error) {
			failure = db.redact(`threw: ${String(error)}`);
		}
		if (failure) failedFiles++;
		console.log(
			`${failure ? 'FAIL' : 'PASS'} ${label} (${ms} ms, ${pending.length} migrations applied in transaction)` +
				(failure ? `: ${failure}` : '')
		);
	}
	console.log(`\n${files.length - failedFiles}/${files.length} files passed`);
	return failedFiles === 0;
}

const databaseBytes = async (client: pg.Client) =>
	Number(
		(await client.query<{ size: string }>('select pg_database_size(current_database()) as size'))
			.rows[0]?.size
	);
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** Every table in the backed-up schemas, quoted and comma-separated; null if there are none. */
async function backedUpTables(client: pg.Client): Promise<string | null> {
	try {
		const { rows } = await client.query<{ names: string | null }>(
			`select string_agg(format('%I.%I', schemaname, tablename), ', ') as names from pg_tables
			 where schemaname = any (backup.schemas())`
		);
		return rows[0]?.names ?? null;
	} catch (error) {
		if (!missingSchemasFunction(error)) throw error;
		console.log('backup.schemas() is not pushed yet; skipping the vacuum.');
		return null;
	}
}

/**
 * `perf`: runs `perf/perf.sql` in a rolled-back transaction, printing its notices and EXPLAIN
 * output. Disk guard: refuses to start above `PERF_MAX_START_BYTES`, then vacuums every table in
 * the backed-up schemas afterward so the rolled-back rows' space is reusable.
 */
async function runPerf(client: pg.Client): Promise<boolean> {
	const perf = projectPath('perf');
	if (!existsSync(join(perf, 'perf.sql'))) {
		throw new Error(`${join(perf, 'perf.sql')} not found; perf runs that file`);
	}
	const before = await databaseBytes(client);
	console.log(`Database size before: ${mb(before)}`);
	if (before > PERF_MAX_START_BYTES) {
		console.log(`Refusing to run: above the ${mb(PERF_MAX_START_BYTES)} start limit.`);
		return false;
	}
	const pending = await pendingMigrations(client);
	let failure: unknown;
	try {
		const { result, ms } = await inRolledBackTransaction(client, pending, async () =>
			resultList(await client.query(readSQL(perf, 'perf.sql')))
		);
		for (const r of result.filter((r) => r.fields[0]?.name === 'QUERY PLAN')) {
			console.log(r.rows.map((row: Record<string, string>) => row['QUERY PLAN']).join('\n') + '\n');
		}
		console.log(`perf.sql: ${ms} ms total, ${pending.length} migrations applied in transaction`);
	} catch (error) {
		failure = error;
	}
	// Also after a failure: the rolled-back rows' space is reusable only once vacuumed. vacuum can't run inside a
	// transaction, so this is its own statement. Before the first push the tables existed only inside the
	// rolled-back transaction, so there's nothing to vacuum.
	try {
		const names = await backedUpTables(client);
		if (names) await client.query(`vacuum ${names}`);
		console.log(`Database size after vacuum: ${mb(await databaseBytes(client))}`);
	} catch (error) {
		// perf.sql's error is the one to fix; reported alone, the vacuum's would hide it. Thrown, not printed, so the
		// caller redacts it.
		if (failure === undefined) throw error;
		throw new Error(`${String(failure)}; the vacuum after it failed too: ${String(error)}`);
	}
	if (failure !== undefined) throw failure;
	return true;
}

type WithClient = <T>(body: (client: pg.Client) => Promise<T>) => Promise<T>;

/** `push`: runs `supabase db push` against dev, with the CLI's output redacted. */
async function runPush(db: ParsedDBURL, withClient: WithClient): Promise<boolean> {
	// `db push` silently skips versions it has applied, so an edited migration would reach production unnoticed.
	const pending = await withClient(pendingMigrations);
	console.log(`${pending.length} pending: ${pending.join(', ') || 'none'}`);
	const { code, ms } = await pushMigrations({
		cliURL: db.cliURL,
		password: db.password,
		redact: db.redact
	});
	console.log(`push exited with ${code} after ${ms} ms`);
	return code === 0;
}

export type DevCommand = 'push' | 'test' | 'perf';

/** Runs a dev command against `DEV_DB_URL` from the project's `.env`. Returns whether it passed. */
export async function runDevCommand(command: DevCommand, config: Config): Promise<boolean> {
	const db = checkDevURL(
		config,
		projectEnv('DEV_DB_URL', "the dev project's session pooler URL as postgres")
	);
	const withClient: WithClient = (body) =>
		connectWith(
			db,
			body,
			`Free projects pause after about a week idle: restore ${config.dev.name} in the dashboard and retry.`
		);
	try {
		if (command === 'test') return await withClient((client) => runTests(db, client));
		if (command === 'perf') return await withClient(runPerf);
		return await runPush(db, withClient);
	} catch (error) {
		// No `cause`: printing it would show the unredacted error.
		throw new Error(db.redact(String(error)));
	}
}
