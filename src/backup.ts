import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import {
	checkBackupUser,
	checkKeyPrefix,
	checkManifest,
	checkToolVersion,
	etagOf,
	matchesADaily,
	migrationHash,
	missingTableData,
	objectKeys,
	parseBackupTarget,
	parseLosslessJSON,
	RELATION_NAME,
	refFor,
	required,
	s3apiArgs,
	type AuthTable,
	type BackupTarget,
	type Manifest
} from './backupCore.ts';
import {
	backedUpSchemas,
	readDatabaseState,
	sequenceNames,
	serverVersion,
	setReproducibleOutput
} from './backupDB.ts';
import {
	connect,
	hashFile,
	parseDBURL,
	pgEnv,
	pgTool,
	projectPath,
	runCommand,
	runOrThrow as run,
	stepTimer,
	type ParsedDBURL
} from './db.ts';
import type { Config } from './config.ts';
import { toolCommit } from './pins.ts';

/**
 * The nightly backup (`supabase-backup backup`, run by `.github/workflows/backup.yml`): dumps the schemas
 * `backup.schemas()` lists, reads the sign-in users through `backup.auth_rows()`, and uploads one age-encrypted
 * `.tar.age` (manifest, dump, auth rows) to R2. Runbook: README > Restore procedure.
 *
 * Invariants:
 * - **One snapshot.** The manifest's counts and hashes and the dump all come from one exported snapshot, so the
 *   restore's check can demand the restored data equal the manifest exactly.
 * - **Nothing goes unbacked-up silently.** The schema guard fails the run when a schema, a relation, a storage or
 *   Vault row, or a large object appears that the backup doesn't cover (`tests/backup_reader.sql` pins the same rules).
 * - **Verified before it counts.** The dump is fully read back before upload, and the upload is read back (size and
 *   MD5) before the run succeeds.
 * - **A dev run never writes under `production/`.** Keys are checked against `BACKUP_TARGET`.
 * - **No secrets in output.** Every line printed passes through `redact`, and on GitHub the password, decoded and as
 *   written in the URL, is also masked. The summary line holds names, counts, sizes, and hashes only.
 */

// Module scope: the CLI runs one backup per process.
const { steps, step } = stepTimer();

/**
 * The schema guard: everything the database holds outside the backup must be something the backup can do without.
 * `tests/backup_reader.sql` states the same rules on purpose: the test stops a migration that breaks them from
 * reaching dev, and this guard catches what the tests can't see, such as objects made outside migrations or rows
 * that appear in production only.
 *
 * Supabase-owned data the backup leaves out by design (sessions, refresh tokens, MFA factors; the runbook lists it) has
 * no guard: losing it means users sign in and enroll again, not lost records. Storage and Vault are guarded because
 * their rows would be records. If SSO or pg_cron is ever turned on, its tables need a row in `backup.unbacked_counts`.
 */
async function checkCoverage(client: pg.Client, backedUp: string[]): Promise<void> {
	const problems: string[] = [];
	// Not RESERVED_SCHEMAS: these are the postgres-owned schemas the guard checks below, relation by relation.
	const { rows: schemas } = await client.query<{ name: string }>(
		`select nspname as name from pg_catalog.pg_namespace
		 where pg_catalog.pg_get_userbyid(nspowner) = 'postgres'
		   and nspname <> all ($1)`,
		[[...backedUp, 'backup', 'extensions', 'supabase_migrations']]
	);
	for (const s of schemas) {
		problems.push(
			`schema ${s.name} is owned by postgres but isn't backed up; generate a migration with the new schema list`
		);
	}
	// Before the dump: pg_dump --strict-names catches a missing schema too, but only after the snapshot's reads, and a
	// schema owned by another role could hold objects postgres can't recreate on restore.
	const { rows: missing } = await client.query<{ name: string }>(
		`select s as name from unnest($1::text[]) s
		 where not exists (select from pg_catalog.pg_namespace n
		                   where n.nspname = s and pg_catalog.pg_get_userbyid(n.nspowner) = 'postgres')`,
		[backedUp]
	);
	for (const s of missing) {
		problems.push(
			`backup.schemas() lists ${s.name}, which doesn't exist or isn't owned by postgres`
		);
	}
	const { rows: names } = await client.query<{ schema: string; name: string }>(
		`select n.nspname as schema, c.relname as name
		 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
		 where n.nspname = any ($1) and c.relkind in ('r', 'p', 'm', 'S')`,
		[backedUp]
	);
	for (const r of names.filter((r) => !RELATION_NAME.test(r.name))) {
		problems.push(
			`${r.schema}.${r.name} isn't a plain name (letters, digits, _ and $), which the restore needs`
		);
	}
	const { rows: publicRels } = await client.query<{ name: string }>(
		`select c.relname as name from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
		 where n.nspname = 'public' and c.relkind in ('r', 'p', 'm', 'f', 'S')`
	);
	// The kinds that hold data; views, indexes, and composite types don't.
	for (const r of publicRels)
		problems.push(
			`public.${r.name} may hold data that isn't backed up; only views belong in public`
		);
	// `backup` holds only functions. Of `supabase_migrations`, only `schema_migrations` is data: the manifest holds it,
	// and `db push` rebuilds it.
	const { rows: otherRels } = await client.query<{ name: string }>(
		`select format('%s.%s', n.nspname, c.relname) as name
		 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
		 where (n.nspname = 'backup')
		    or (n.nspname = 'supabase_migrations' and c.relkind in ('r', 'p', 'v', 'm', 'f') and c.relname <> 'schema_migrations')`
	);
	for (const r of otherRels) problems.push(`${r.name} is a relation the backup doesn't cover`);
	const { rows: extensionRels } = await client.query<{ name: string }>(
		`select c.relname as name from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
		 where n.nspname = 'extensions' and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
		   and not exists (select from pg_catalog.pg_depend d
		                   where d.classid = 'pg_catalog.pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')`
	);
	for (const r of extensionRels)
		problems.push(`extensions.${r.name} belongs to no extension and isn't backed up`);
	const { rows: unbacked } = await client.query<{ rel: string; row_count: string }>(
		'select rel, row_count from backup.unbacked_counts()'
	);
	const nonzero = unbacked.filter((r) => Number(r.row_count) > 0);
	if (nonzero.length) {
		problems.push(
			`storage/vault rows exist and aren't backed up; extend the backup first (${nonzero.map((r) => `${r.rel}: ${r.row_count}`).join(', ')})`
		);
	}
	// pg_dump -n leaves large objects out, so the backup can't carry them; nothing uses them today.
	const { rows: largeObjects } = await client.query<{ count: string }>(
		'select pg_catalog.count(*) as count from pg_catalog.pg_largeobject_metadata'
	);
	if (Number(largeObjects[0]!.count) > 0) {
		problems.push(`${largeObjects[0]!.count} large objects exist and aren't backed up`);
	}
	if (problems.length) throw new Error(`schema guard: ${problems.join('; ')}`);
}

type Snapshot = {
	client: pg.Client;
	id: string;
	schemas: string[];
	manifest: Omit<Manifest, 'files' | 'pgDumpVersion'>;
	authJSON: string;
};

/** Opens the snapshot session and reads everything the manifest needs from it. The caller ends the session. */
async function openSnapshot(
	config: Config,
	db: ParsedDBURL,
	target: Manifest['target'],
	pgDumpMajor: number
): Promise<Snapshot> {
	const client = await connect(
		db,
		`Check that BACKUP_DB_URL is the project's session pooler URL as backup_reader (supabase-backup password).`
	);
	try {
		await client.query('begin isolation level repeatable read read only');
		const { rows } = await client.query<{ id: string }>(
			'select pg_catalog.pg_export_snapshot() as id'
		);
		// The snapshot's time: everything in the archive is as of this moment.
		const createdAt = new Date().toISOString();
		await setReproducibleOutput(client);
		const server = await serverVersion(client);
		if (server.major > pgDumpMajor) {
			throw new Error(
				`the server is PostgreSQL ${server.version}, newer than pg_dump ${pgDumpMajor}`
			);
		}
		const schemas = await backedUpSchemas(client);
		await checkCoverage(client, schemas);

		const { rows: migrations } = await client.query<{
			version: string;
			name: string | null;
			statements: string[] | null;
		}>(
			'select version, name, statements from supabase_migrations.schema_migrations order by version'
		);
		const unknown = migrations.filter((m) => m.statements === null).map((m) => m.version);
		if (unknown.length) {
			throw new Error(
				`migrations recorded without statements (by migration repair) can't be checked against the repo: ${unknown.join(', ')}`
			);
		}
		// The restore looks for `<version>_<name>.sql`, so a migration needs a name.
		const unnamed = migrations.filter((m) => !m.name).map((m) => m.version);
		if (unnamed.length) {
			throw new Error(
				`migrations recorded without a name can't be matched to a file: ${unnamed.join(', ')}`
			);
		}

		const { rows: authRows } = await client.query<{
			table_name: AuthTable;
			row_data: string;
		}>('select table_name, row_data::text as row_data from backup.auth_rows()');
		const auth: Record<AuthTable, Record<string, unknown>[]> = { users: [], identities: [] };
		for (const r of authRows) {
			if (!(r.table_name in auth)) {
				throw new Error(
					`backup.auth_rows() returned a row of ${r.table_name}, which the backup doesn't know`
				);
			}
			auth[r.table_name].push(parseLosslessJSON(r.row_data) as Record<string, unknown>);
		}
		const columns = (table: AuthTable) => Object.keys(auth[table][0] ?? {});

		const state = await readDatabaseState(client, schemas);
		return {
			client,
			id: rows[0]!.id,
			schemas,
			authJSON: JSON.stringify(auth),
			manifest: {
				formatVersion: 2,
				target,
				ref: refFor(config, target),
				createdAt,
				serverVersion: server.version,
				gitCommit: process.env.GITHUB_SHA ?? null,
				schemas,
				tool: { name: 'supabase-backup', commit: toolCommit() },
				migrations: migrations.map((m) => ({
					version: m.version,
					name: m.name!,
					hash: migrationHash(m.statements!.join(';')),
					statements: m.statements!
				})),
				...state,
				sequences: await sequenceNames(client, schemas),
				auth: {
					users: { rows: auth.users.length, columns: columns('users') },
					identities: { rows: auth.identities.length, columns: columns('identities') }
				}
			}
		};
	} catch (error) {
		await client.end().catch(() => {});
		throw error;
	}
}

/** pg_dump's arguments: the listed schemas only, read in the exported snapshot, as a custom-format archive. */
export const pgDumpArgs = (snapshotId: string, schemas: string[], file: string) => [
	`--snapshot=${snapshotId}`,
	'-Fc',
	// A listed schema that matches nothing fails the dump instead of being skipped.
	'--strict-names',
	...schemas.flatMap((s) => ['-n', s]),
	'-f',
	file
];

type ObjectHead = { ContentLength: number; ETag: string };

/**
 * One backup run, configured by the environment (see the module comment). Throws on any failure, with the message
 * redacted once the secrets are known; returns once the backup is uploaded and checked.
 */
export async function runBackup(config: Config): Promise<void> {
	const target = parseBackupTarget(process.env.BACKUP_TARGET);
	// Before parseDBURL, whose empty-URL error can't say where this one is set.
	if (!process.env.BACKUP_DB_URL?.trim()) {
		throw new Error(`no backup URL: set secret BACKUP_DB_URL in environment backup-${target}`);
	}
	const db = parseDBURL(process.env.BACKUP_DB_URL, 'BACKUP_DB_URL');
	checkBackupUser(config, db, target);
	if (process.env.GITHUB_ACTIONS) {
		for (const secret of db.passwordForms) console.log(`::add-mask::${secret}`);
	}
	const r2 = {
		endpoint: required(process.env, 'R2_ENDPOINT'),
		bucket: required(process.env, 'R2_BUCKET')
	};
	const awsSecret = required(process.env, 'AWS_SECRET_ACCESS_KEY');
	const redact = (text: string) => db.redact(text.replaceAll(awsSecret, '***'));
	try {
		await backUp(config, target, db, r2, redact);
	} catch (error) {
		throw new Error(redact(error instanceof Error ? error.message : String(error)));
	}
}

/** The run once its configuration is checked; `runBackup` redacts whatever it throws. */
async function backUp(
	config: Config,
	target: BackupTarget,
	db: ParsedDBURL,
	r2: { endpoint: string; bucket: string },
	redact: (text: string) => string
): Promise<void> {
	const totalStart = performance.now();
	const awsArgs = (args: string[]) => s3apiArgs(r2, args);
	const aws = async (args: string[]) =>
		JSON.parse((await run('aws', awsArgs(args), redact)) || '{}');

	const pgDump = pgTool('pg_dump');
	const pgRestore = pgTool('pg_restore');
	const dumpVersion = checkToolVersion(pgDump, await run(pgDump, ['--version'], redact), 0);
	// pg_restore reads the archive back; an older one can't read pg_dump 17's format.
	checkToolVersion(pgRestore, await run(pgRestore, ['--version'], redact), 0);
	await run('age', ['--version'], redact);
	const recipient = projectPath('backup', 'recipient.txt');
	// `\r?`: age reads a CRLF recipients file too.
	if (!existsSync(recipient) || !/^age1[0-9a-z]+\r?$/m.test(readFileSync(recipient, 'utf8'))) {
		throw new Error('supabase/backup/recipient.txt must hold the age public key (an age1… line)');
	}

	const keys = objectKeys(target, new Date());
	checkKeyPrefix(keys, target);
	const work = mkdtempSync(join(tmpdir(), 'supabase-backup-backup-'));
	try {
		const file = (name: string) => join(work, name);
		const snapshot = await step('snapshot', () =>
			openSnapshot(config, db, target, dumpVersion.major)
		);
		const dumpCode = await (async () => {
			try {
				return (
					await step('dump', () =>
						runCommand(pgDump, pgDumpArgs(snapshot.id, snapshot.schemas, file('app.dump')), {
							redact,
							env: pgEnv(db)
						})
					)
				).code;
			} finally {
				// Read-only, so there's nothing to commit; a failure to close doesn't undo a good dump.
				await snapshot.client
					.end()
					.catch((error) =>
						console.log(redact(`warning: closing the snapshot session: ${String(error)}`))
					);
			}
		})();
		if (dumpCode !== 0) throw new Error(`pg_dump exited with ${dumpCode}`);

		await step('verify', async () => {
			const missing = missingTableData(
				snapshot.manifest,
				await run(pgRestore, ['--list', file('app.dump')], redact)
			);
			if (missing.tables.length || missing.sequences.length) {
				throw new Error(
					`the dump has no data for: ${[...missing.tables, ...missing.sequences].join(', ')}`
				);
			}
		});
		// --list reads only the table of contents; this decompresses every data block, so a corrupt dump fails tonight.
		await step('readBack', () =>
			run(pgRestore, ['--data-only', '-f', devNull, file('app.dump')], redact)
		);

		writeFileSync(file('auth.json'), snapshot.authJSON);
		const fileInfo = (name: string) => hashFile(file(name), ['sha256']);
		const [dumpInfo, authInfo] = await Promise.all([fileInfo('app.dump'), fileInfo('auth.json')]);
		const manifest: Manifest = {
			...snapshot.manifest,
			pgDumpVersion: dumpVersion.version,
			files: { 'app.dump': dumpInfo, 'auth.json': authInfo }
		};
		// The restore's own check, run tonight: a manifest it would refuse fails this run, not a disaster recovery.
		checkManifest(manifest);
		const encrypted = file('backup.tar.age');
		// Two whole copies on disk for a moment (the tar and its encryption). The runner's disk dwarfs a dump this size,
		// and two plain commands fail more legibly than a tar | age pipe.
		await step('package', async () => {
			writeFileSync(file('manifest.json'), JSON.stringify(manifest, null, '\t'));
			await run(
				'tar',
				['-cf', file('backup.tar'), '-C', work, 'manifest.json', 'app.dump', 'auth.json'],
				redact
			);
			await run('age', ['-R', recipient, '-o', encrypted, file('backup.tar')], redact);
			rmSync(file('backup.tar'));
		});
		const local = await hashFile(encrypted, ['md5', 'sha256']);

		const head = async (key: string): Promise<ObjectHead> => aws(['head-object', '--key', key]);
		const upload = async (key: string) => {
			await aws(['put-object', '--key', key, '--body', encrypted]);
			// A single-part PUT's ETag is the body's MD5, and s3api put-object is always single-part. A monthly that
			// failed this check stays locked forever and fails every later run that month, but the daily upload runs the
			// same check first, so a broken assumption here fails the daily, which expires, before any monthly is written.
			const uploaded = await head(key);
			if (uploaded.ContentLength !== local.bytes || etagOf(uploaded.ETag) !== local.md5) {
				throw new Error(`the uploaded ${key} doesn't match the local file (size or MD5)`);
			}
		};
		await step('upload', () => upload(keys.daily));
		let monthly: 'uploaded' | 'exists' | undefined;
		if (keys.monthly) {
			const monthlyKey = keys.monthly;
			monthly = await step('monthly', async () => {
				const existing = await runCommand('aws', awsArgs(['head-object', '--key', monthlyKey]), {
					redact,
					capture: true
				});
				if (existing.code === 254 && /\b404\b|Not Found/.test(existing.stderr)) {
					await upload(monthlyKey);
					return 'uploaded';
				}
				if (existing.code !== 0)
					throw new Error(`head-object ${monthlyKey} failed: ${existing.stderr}`);
				const listed: { Contents?: { Key: string; ETag: string }[] } = await aws([
					'list-objects-v2',
					'--prefix',
					`production/daily/${keys.month}`
				]);
				const dailies = (listed.Contents ?? []).map((o) => ({ key: o.Key, etag: etagOf(o.ETag) }));
				const etag = etagOf((JSON.parse(existing.stdout) as ObjectHead).ETag);
				if (!matchesADaily(keys.month, etag, dailies)) {
					throw new Error(
						`monthly ${monthlyKey} doesn't match any daily from its month; it may have been planted`
					);
				}
				return 'exists';
			});
		}

		console.log(
			redact(
				JSON.stringify({
					target,
					keys: { ...keys, monthlyStatus: monthly },
					bytes: {
						'app.dump': manifest.files['app.dump'].bytes,
						'auth.json': manifest.files['auth.json'].bytes,
						encrypted: local.bytes
					},
					sha256: local.sha256,
					gitCommit: manifest.gitCommit,
					steps,
					totalMs: Math.round(performance.now() - totalStart),
					tables: Object.fromEntries(manifest.tables.map((t) => [t.name, t.rows])),
					auth: { users: manifest.auth.users.rows, identities: manifest.auth.identities.rows }
				})
			)
		);
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}
