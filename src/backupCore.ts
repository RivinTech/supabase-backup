import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { comparable } from './comparable.ts';
import type { Config } from './config.ts';
import type { ParsedDBURL } from './db.ts';

/**
 * The backup, restore, and watchdog rules, with no I/O, so every branch is unit-tested (`backupCore.test.ts`).
 *
 * Imports values only from `comparable.ts` and Node built-ins. The `config.ts` and `db.ts` imports are types, so
 * `config.ts` can import `PROJECT_REF` from here without a cycle at run time.
 */

export type BackupTarget = 'production' | 'dev';

/** A Supabase project ref. */
export const PROJECT_REF = /^[a-z0-9]{20}$/;

/** The project ref a target backs up. */
export const refFor = (config: Config, target: BackupTarget) => config[target].ref;

/** The target whose project is `ref`, if any. */
export const targetFor = (config: Config, ref: string): BackupTarget | undefined =>
	ref === config.production.ref ? 'production' : ref === config.dev.ref ? 'dev' : undefined;

/** Plain lowercase identifiers (schema and auth column names), so a name needs no quoting anywhere it's used. */
export const PLAIN_NAME = /^[a-z_][a-z0-9_]*$/;

/**
 * Schemas that can't be backed up: Supabase's own (restored by the new project itself), the package's, and `public`,
 * which holds Supabase-managed objects alongside the app's (a v1 limitation; README > What it doesn't cover). Any
 * `pg_*` schema is reserved too.
 */
export const RESERVED_SCHEMAS = [
	'public',
	'backup',
	'extensions',
	'supabase_migrations',
	'auth',
	'storage',
	'vault',
	'realtime',
	'graphql',
	'graphql_public',
	'pgbouncer',
	'net',
	'cron',
	'pgsodium',
	'pgsodium_masks',
	'supabase_functions',
	'information_schema'
];

/** Why `name` can't be a backed-up schema, or null if it can. */
export function schemaNameProblem(name: unknown): string | null {
	if (typeof name !== 'string' || !PLAIN_NAME.test(name)) {
		return `${JSON.stringify(name)} isn't a plain lowercase schema name`;
	}
	if (RESERVED_SCHEMAS.includes(name) || name.startsWith('pg_')) {
		return `${name} is reserved and can't be backed up`;
	}
	return null;
}

/**
 * A table or sequence name the restore can handle. `pg_restore --list` prints names unquoted and space-separated, and
 * `schema.name` is split at its dot, so a space or dot in a name would break both.
 */
export const RELATION_NAME = /^[A-Za-z_][A-Za-z0-9_$]*$/;

/** Sorted the way PostgreSQL's `collate "C"` sorts these ASCII names. */
export const sortedNames = (names: string[]) => [...names].sort();

/** `BACKUP_TARGET` as a target; throws on anything else. */
export function parseBackupTarget(value: string | undefined): BackupTarget {
	if (value === 'production' || value === 'dev') return value;
	throw new Error(`BACKUP_TARGET must be production or dev; got ${value ?? 'nothing'}`);
}

/** The trimmed value of `env[name]`; throws naming it when it's unset or blank. */
export function required(env: Record<string, string | undefined>, name: string): string {
	const value = env[name]?.trim();
	if (!value) throw new Error(`${name} is required`);
	return value;
}

/**
 * Throws unless the URL logs in as the target project's `backup_reader` through the Supabase pooler in session mode
 * (port 5432): the exported snapshot and pg_dump's session settings need one server session throughout.
 */
export function checkBackupUser(
	config: Config,
	db: Pick<ParsedDBURL, 'user' | 'host'> & { config: Pick<ParsedDBURL['config'], 'port'> },
	target: BackupTarget
): void {
	const expected = `backup_reader.${refFor(config, target)}`;
	if (db.user !== expected)
		throw new Error(`the backup URL's user must be ${expected}; got ${db.user}`);
	if (!db.host.endsWith('.pooler.supabase.com')) {
		throw new Error(
			`the backup URL's host must be a Supabase pooler (*.pooler.supabase.com); got ${db.host}`
		);
	}
	if (db.config.port !== 5432) {
		throw new Error(
			`the backup URL must use the session pooler, port 5432; got port ${String(db.config.port)}`
		);
	}
}

/**
 * Throws unless the URL logs in to the session pooler (user `postgres.<targetRef>`, port 5432) of a project that is
 * neither production nor dev: `db push` and the single-transaction load can't run through the transaction pooler, and
 * the pooler routes by the user's ref, so the host needs no check. A direct connection (user `postgres`) is refused
 * because its user doesn't name the project.
 */
export function checkRestoreTarget(
	config: Config,
	db: Pick<ParsedDBURL, 'user'> & { config: Pick<ParsedDBURL['config'], 'port'> },
	targetRef: string
): void {
	if (targetFor(config, targetRef)) {
		throw new Error('restore into a new, empty project; never into an existing one');
	}
	const expected = `postgres.${targetRef}`;
	if (db.user !== expected)
		throw new Error(`RESTORE_DB_URL's user must be ${expected}; got ${db.user}`);
	if (db.config.port !== 5432) {
		throw new Error(
			`RESTORE_DB_URL must use the session pooler, port 5432; got port ${String(db.config.port)}`
		);
	}
}

/** R2 object keys for a backup taken at `now`, in UTC, so they sort chronologically as strings. */
export function objectKeys(
	target: BackupTarget,
	now: Date
): { daily: string; monthly?: string; month: string } {
	const stamp = now
		.toISOString()
		.replace(/\.\d{3}Z$/, 'Z')
		.replaceAll(':', '-');
	const month = monthOf(now);
	if (target === 'dev') return { daily: `dev/${stamp}.tar.age`, month };
	return {
		daily: `production/daily/${stamp}.tar.age`,
		monthly: `production/monthly/${month}.tar.age`,
		month
	};
}

/** Throws unless every key is under `<target>/`, so a dev run can never write under `production/`. */
export function checkKeyPrefix(
	keys: { daily: string; monthly?: string },
	target: BackupTarget
): void {
	for (const key of [keys.daily, keys.monthly]) {
		if (key !== undefined && !key.startsWith(`${target}/`)) {
			throw new Error(`object key ${key} isn't under ${target}/`);
		}
	}
}

/** UTC `YYYY-MM`. */
const monthOf = (date: Date) => date.toISOString().slice(0, 7);

export type TableState = { name: string; rows: number; hash: string };
export type AuthTable = 'users' | 'identities';

/** The package build that wrote a manifest; `commit` is null for a local (non-git) install. */
export type ToolInfo = { name: 'supabase-backup'; commit: string | null };

export type Manifest = {
	/** 1: written before the package existed (no `schemas` or `tool`). 2: written by the package. */
	formatVersion: 1 | 2;
	target: BackupTarget;
	ref: string;
	createdAt: string;
	serverVersion: string;
	pgDumpVersion: string;
	/** The project's commit. */
	gitCommit: string | null;
	/** The dumped schemas, sorted. Format 1 doesn't store it; `checkManifest` derives it from the tables and sequences. */
	schemas: string[];
	/** Format 2 only. */
	tool?: ToolInfo;
	/** The statements let the schema be rebuilt even if the repo were lost. */
	migrations: { version: string; name: string; hash: string; statements: string[] }[];
	/** `schema.table`, sorted. */
	tables: TableState[];
	/** `schema.sequence`, sorted. */
	sequences: string[];
	auth: Record<AuthTable, { rows: number; columns: string[] }>;
	policies: number;
	rlsDisabledTables: string[];
	files: Record<'app.dump' | 'auth.json', { bytes: number; sha256: string }>;
};

/** The state the restore recomputes on the target and compares. */
export type DatabaseState = Pick<Manifest, 'tables' | 'policies' | 'rlsDisabledTables'> & {
	auth: Record<AuthTable, { rows: number }>;
};

/**
 * A migration's hash, equal for the stored `statements.join(';')` and the repo file whenever `devDB.ts`'s drift guard
 * would pass.
 */
export const migrationHash = (sql: string) =>
	createHash('sha256').update(comparable(sql)).digest('hex');

/**
 * The `kind` entries of `pg_restore --list` output, in the archive's (dependency) order. Lines look like
 * `3456; 0 16789 TABLE DATA ledger account postgres`; a commented-out (`;`-prefixed) line isn't an entry.
 */
const listEntries = (restoreList: string, kind: string) =>
	restoreList
		.split(/\r?\n/)
		.map((line) => new RegExp(`^\\d+; \\d+ \\d+ ${kind} (\\S+) (\\S+) `).exec(line))
		.filter((match) => match !== null)
		.map((match) => ({ schema: match[1]!, name: match[2]! }));

/** The manifest's tables and sequences that `pg_restore --list` output has no data for. */
export function missingTableData(
	manifest: Pick<Manifest, 'tables' | 'sequences'>,
	restoreList: string
): { tables: string[]; sequences: string[] } {
	const present = (kind: string) =>
		new Set(listEntries(restoreList, kind).map((e) => `${e.schema}.${e.name}`));
	const tables = present('TABLE DATA');
	const sequences = present('SEQUENCE SET');
	return {
		tables: manifest.tables.map((t) => t.name).filter((name) => !tables.has(name)),
		sequences: manifest.sequences.filter((name) => !sequences.has(name))
	};
}

/** The materialized views `pg_restore --list` output has data for, quoted, in the archive's (dependency) order. */
export const populatedMatviews = (restoreList: string): string[] =>
	listEntries(restoreList, 'MATERIALIZED VIEW DATA').map(
		(e) => `${quoteIdent(e.schema)}.${quoteIdent(e.name)}`
	);

const MIGRATION_VERSION = /^\d{14}$/;
// Names the CLI writes (letters, digits, `_`, `-`, `.`). The file is `<version>_<name>.sql`, so without a path
// separator the name can't leave `migrations/`.
const MIGRATION_NAME = /^[\w.-]+$/;
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;

/** The schema of a `schema.name`; throws unless the name after the dot is plain. */
function schemaOf(name: unknown): string {
	const dot = typeof name === 'string' ? name.indexOf('.') : -1;
	if (dot < 1 || !RELATION_NAME.test((name as string).slice(dot + 1)))
		throw new Error(`the manifest names ${JSON.stringify(name)}, which isn't schema.name`);
	return (name as string).slice(0, dot);
}

/**
 * A decrypted `manifest.json`, checked before any of it names a file: the archive is encrypted to a public key, so
 * anyone holding that key could have written it. Migration versions and names must be plain, so a path built from
 * them stays in `migrations/`, and the files must be exactly the two the backup writes. Schema names must be plain and
 * unreserved, and cover every table and sequence. Returns the manifest with `schemas` set, whatever its format.
 */
export function checkManifest(parsed: unknown): Manifest {
	const m = parsed as Partial<Manifest> | null;
	if (m?.formatVersion !== 1 && m?.formatVersion !== 2) {
		throw new Error(`unknown manifest formatVersion ${String(m?.formatVersion)}`);
	}
	if (!Array.isArray(m.tables) || !Array.isArray(m.sequences)) {
		throw new Error("the manifest's tables and sequences aren't lists");
	}
	const prefixes = new Set([
		...m.tables.map((t) => schemaOf(t?.name)),
		...m.sequences.map(schemaOf)
	]);
	let schemas: string[];
	// Format 1 predates the stored list. Its only writer, OM's own backup, had a table in every schema it dumped, so
	// the prefixes are the list.
	if (m.formatVersion === 1) schemas = sortedNames([...prefixes]);
	else {
		if (!Array.isArray(m.schemas)) throw new Error("the manifest's schemas aren't a list");
		schemas = m.schemas;
		const outside = [...prefixes].filter((s) => !schemas.includes(s));
		if (outside.length) {
			throw new Error(
				`the manifest's tables or sequences are outside its schemas: ${outside.join(', ')}`
			);
		}
		if (new Set(schemas).size !== schemas.length) throw new Error("the manifest's schemas repeat");
		const tool = m.tool as Partial<ToolInfo> | undefined;
		if (
			tool?.name !== 'supabase-backup' ||
			(tool.commit !== null && !COMMIT.test(String(tool.commit)))
		) {
			throw new Error(
				`the manifest's tool isn't supabase-backup at a commit: ${JSON.stringify(tool)}`
			);
		}
	}
	// Without a schema, pg_restore would get no -n and load everything in the dump.
	if (!schemas.length) throw new Error('the manifest names no schemas');
	const problems = schemas.map(schemaNameProblem).filter((p) => p !== null);
	if (problems.length) throw new Error(`the manifest's schemas: ${problems.join('; ')}`);
	if (!Array.isArray(m.migrations)) throw new Error("the manifest's migrations aren't a list");
	const bad = m.migrations.filter(
		(x) => !MIGRATION_VERSION.test(String(x?.version)) || !MIGRATION_NAME.test(String(x?.name))
	);
	if (bad.length) {
		throw new Error(
			`the manifest's migrations aren't plain version_name pairs: ${bad.map((x) => JSON.stringify({ version: x?.version, name: x?.name })).join(', ')}`
		);
	}
	// The rest of what the restore reads, so a malformed manifest is refused here, not met as a TypeError or a
	// misleading verify failure later.
	if (m.migrations.some((x) => !SHA256.test(String(x.hash)) || !Array.isArray(x.statements))) {
		throw new Error("the manifest's migrations need a SHA-256 hash and a statements list");
	}
	if (m.tables.some((t) => !Number.isInteger(t.rows) || !/^[0-9a-f]{32}$/.test(String(t.hash)))) {
		throw new Error("the manifest's tables need integer rows and an MD5 hash");
	}
	if (!Number.isInteger(m.policies) || !Array.isArray(m.rlsDisabledTables)) {
		throw new Error('the manifest needs a policies count and an rlsDisabledTables list');
	}
	if (m.rlsDisabledTables.some((t) => typeof t !== 'string')) {
		throw new Error("the manifest's rlsDisabledTables aren't all names");
	}
	// The verify compares by name, so a repeated one would be checked once and counted twice.
	const relations = [...m.tables.map((t) => t.name), ...m.sequences];
	if (new Set(relations).size !== relations.length) {
		throw new Error("the manifest's tables or sequences repeat");
	}
	if ((m.target !== 'production' && m.target !== 'dev') || !PROJECT_REF.test(String(m.ref))) {
		throw new Error(
			`the manifest's target and ref aren't a project: ${JSON.stringify({ target: m.target, ref: m.ref })}`
		);
	}
	if (!/^\d+(\.\d+)*$/.test(String(m.pgDumpVersion))) {
		throw new Error(
			`the manifest's pgDumpVersion isn't a version: ${JSON.stringify(m.pgDumpVersion)}`
		);
	}
	if (!/^\d+(\.\d+)*$/.test(String(m.serverVersion))) {
		throw new Error(
			`the manifest's serverVersion isn't a version: ${JSON.stringify(m.serverVersion)}`
		);
	}
	if (typeof m.createdAt !== 'string' || Number.isNaN(Date.parse(m.createdAt))) {
		throw new Error(`the manifest's createdAt isn't a time: ${JSON.stringify(m.createdAt)}`);
	}
	// It names the commit the restore error says to check out.
	if (m.gitCommit !== null && !COMMIT.test(String(m.gitCommit))) {
		throw new Error(`the manifest's gitCommit isn't a commit: ${JSON.stringify(m.gitCommit)}`);
	}
	for (const table of ['users', 'identities'] as const) {
		const auth = m.auth?.[table];
		if (!Number.isInteger(auth?.rows) || !Array.isArray(auth?.columns)) {
			throw new Error(`the manifest's auth.${table} needs rows and a columns list`);
		}
		const odd = auth!.columns.filter((c) => typeof c !== 'string' || !PLAIN_NAME.test(c));
		if (odd.length) {
			throw new Error(`the manifest's auth.${table} columns aren't plain: ${JSON.stringify(odd)}`);
		}
	}
	const files = Object.keys(m.files ?? {}).sort();
	if (files.join(',') !== 'app.dump,auth.json') {
		throw new Error(
			`the manifest must list exactly app.dump and auth.json; got ${files.join(', ') || 'none'}`
		);
	}
	for (const [name, info] of Object.entries(m.files!)) {
		if (!Number.isInteger(info?.bytes) || !SHA256.test(String(info?.sha256))) {
			throw new Error(`the manifest's ${name} needs bytes and a SHA-256`);
		}
	}
	return { ...(m as Manifest), schemas: sortedNames(schemas) };
}

/**
 * A decrypted `auth.json`, checked like the manifest: a list of row objects per auth table, as many as the manifest
 * counted.
 */
export function checkAuthArchive(
	parsed: unknown,
	manifest: Pick<Manifest, 'auth'>
): Record<AuthTable, Record<string, unknown>[]> {
	const archive = parsed as Partial<Record<AuthTable, unknown>> | null;
	for (const table of ['users', 'identities'] as const) {
		const rows = archive?.[table];
		if (
			!Array.isArray(rows) ||
			rows.some((r) => typeof r !== 'object' || r === null || Array.isArray(r))
		) {
			throw new Error(`auth.json's ${table} isn't a list of rows`);
		}
		if (rows.length !== manifest.auth[table].rows) {
			throw new Error(
				`auth.json has ${rows.length} ${table} rows; the manifest counted ${manifest.auth[table].rows}`
			);
		}
	}
	return archive as Record<AuthTable, Record<string, unknown>[]>;
}

/** Human-readable differences between the backed-up state and the restored one. Empty means PASS. */
export function compareManifest(expected: DatabaseState, actual: DatabaseState): string[] {
	const differences: string[] = [];
	const actualTables = new Map(actual.tables.map((t) => [t.name, t]));
	for (const table of expected.tables) {
		const restored = actualTables.get(table.name);
		if (!restored) differences.push(`${table.name}: missing`);
		else if (restored.rows !== table.rows) {
			differences.push(`${table.name}: ${restored.rows} rows, expected ${table.rows}`);
		} else if (restored.hash !== table.hash) differences.push(`${table.name}: content differs`);
	}
	const expectedNames = new Set(expected.tables.map((t) => t.name));
	for (const table of actual.tables) {
		if (!expectedNames.has(table.name)) differences.push(`${table.name}: not in the backup`);
	}
	for (const table of ['users', 'identities'] as const) {
		if (actual.auth[table].rows !== expected.auth[table].rows) {
			differences.push(
				`auth.${table}: ${actual.auth[table].rows} rows, expected ${expected.auth[table].rows}`
			);
		}
	}
	if (actual.policies !== expected.policies) {
		differences.push(`policies: ${actual.policies}, expected ${expected.policies}`);
	}
	const list = (names: string[]) => [...names].sort().join(', ') || 'none';
	if (list(actual.rlsDisabledTables) !== list(expected.rlsDisabledTables)) {
		differences.push(
			`tables without RLS: ${list(actual.rlsDisabledTables)}, expected ${list(expected.rlsDisabledTables)}`
		);
	}
	return differences;
}

/** Columns a restored auth row can't do without. */
export const REQUIRED_AUTH_COLUMNS: Record<AuthTable, string[]> = {
	users: ['id', 'email'],
	identities: ['id', 'user_id', 'provider', 'provider_id']
};

/**
 * Which backed-up auth columns to insert: those the target can insert, in the target's order. The target is a new
 * project, so a backed-up column it lacks means Supabase dropped or renamed it; that's reported, not fatal, unless the
 * column is required. A generated column is in the backup (`to_jsonb` includes it) but the target recomputes it, so
 * it's neither inserted nor reported. A table with no rows backs up no columns, and has nothing to insert.
 */
export function authColumnPlan(
	table: AuthTable,
	backupColumns: string[],
	targetInsertableColumns: string[],
	targetGeneratedColumns: string[]
): { insert: string[]; onlyInTarget: string[]; missingInTarget: string[] } {
	if (!backupColumns.length) return { insert: [], onlyInTarget: [], missingInTarget: [] };
	const backup = new Set(backupColumns);
	const target = new Set([...targetInsertableColumns, ...targetGeneratedColumns]);
	const insert = targetInsertableColumns.filter((c) => backup.has(c));
	const missing = REQUIRED_AUTH_COLUMNS[table].filter((c) => !insert.includes(c));
	if (missing.length) {
		throw new Error(
			`auth.${table} can't be restored: required columns missing: ${missing.join(', ')}`
		);
	}
	return {
		insert,
		onlyInTarget: targetInsertableColumns.filter((c) => !backup.has(c)),
		missingInTarget: backupColumns.filter((c) => !target.has(c))
	};
}

/**
 * Parses JSON keeping every number as its source text (`JSON.rawJSON`), so `JSON.stringify` writes it back unchanged.
 * Auth rows are jsonb from PostgreSQL, whose numerics a double would round (an id like 1234567890123456789, or the
 * scale of 1.10); parsed this way they survive the archive, the insert, and the verify's comparison exactly.
 */
// Node has had these since 21; TypeScript's lib doesn't declare them yet.
const { rawJSON, isRawJSON } = JSON as JSON & {
	rawJSON(text: string): object;
	isRawJSON(value: unknown): boolean;
};
export const parseLosslessJSON = (text: string): unknown =>
	JSON.parse(text, (_key, value, context?: { source?: string }) =>
		typeof value === 'number' && context?.source !== undefined ? rawJSON(context.source) : value
	);

/** JSON with object keys sorted at every depth, so equal values serialize equally. */
function canonicalJSON(value: unknown): string {
	if (isRawJSON(value)) return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
	if (value !== null && typeof value === 'object') {
		const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJSON(v)}`).join(',')}}`;
	}
	return JSON.stringify(value);
}

/**
 * The ids of auth rows that differ between the archive and the target, restricted to `columns`, or that only one side
 * has. Sorted.
 */
export function authContentDiff(
	archiveRows: Record<string, unknown>[],
	targetRows: Record<string, unknown>[],
	columns: string[]
): string[] {
	const byId = (rows: Record<string, unknown>[]) =>
		new Map(
			rows.map((row) => [
				String(row.id),
				canonicalJSON(Object.fromEntries(columns.map((c) => [c, row[c] ?? null])))
			])
		);
	const archive = byId(archiveRows);
	const target = byId(targetRows);
	const ids = new Set([...archive.keys(), ...target.keys()]);
	return [...ids].filter((id) => archive.get(id) !== target.get(id)).sort();
}

export type SequenceState = {
	seq: string;
	lastValue: bigint;
	isCalled: boolean;
	/** A negative increment: the sequence counts down. */
	descending: boolean;
	/** The id furthest along the sequence's direction: the table's largest, or its smallest when descending. */
	furthestId: bigint | null;
};

/**
 * Sequences whose next value could be an existing id. Not compared with the backup: sequences aren't transactional,
 * so pg_dump's `setval` can be later than the snapshot.
 */
export function sequenceFailures(rows: SequenceState[]): string[] {
	return rows
		.filter((r) => {
			if (r.furthestId === null) return false;
			const past = r.descending ? r.lastValue < r.furthestId : r.lastValue > r.furthestId;
			return !(past || (r.lastValue === r.furthestId && r.isCalled));
		})
		.map(
			(r) =>
				`${r.seq}: last_value ${r.lastValue} (is_called ${r.isCalled}) would hand out an existing id (${r.descending ? 'min' : 'max'} ${r.furthestId})`
		);
}

/** `name` as a quoted SQL identifier. */
export const quoteIdent = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** One insert of every row into `auth.<table>`, with the JSON inside a `$<tag>$` dollar quote. */
export function authInsertSQL(
	table: AuthTable,
	columns: string[],
	rows: Record<string, unknown>[],
	tag: string
): string {
	if (!/^sb_[0-9a-f]{16}$/.test(tag)) throw new Error(`invalid dollar-quote tag ${tag}`);
	const json = JSON.stringify(rows);
	if (json.includes(`$${tag}$`))
		throw new Error(`the auth.${table} rows contain the dollar-quote tag; retry`);
	const cols = columns.map(quoteIdent).join(', ');
	return `insert into auth.${table} (${cols}) select ${cols} from jsonb_populate_recordset(null::auth.${table}, $${tag}$${json}$${tag}$::jsonb);\n`;
}

/** The one `AGE-SECRET-KEY-1…` line of a key file, whatever encoding and line endings it was saved with. */
export function normalizeIdentity(bytes: Buffer): string {
	let text: string;
	if (bytes[0] === 0xff && bytes[1] === 0xfe) text = bytes.subarray(2).toString('utf16le');
	else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
		// swap16 needs whole code units; a stray trailing byte is dropped, as the little-endian decode drops it.
		text = Buffer.from(bytes.subarray(2, bytes.length - (bytes.length % 2)))
			.swap16()
			.toString('utf16le');
	} else text = bytes.toString('utf8').replace(/^﻿/, '');
	const keys = text
		.replaceAll('\r\n', '\n')
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => /^AGE-SECRET-KEY-1[0-9A-Z]+$/.test(line));
	if (keys.length !== 1) throw new Error('the key file must contain one AGE-SECRET-KEY-1… line');
	return keys[0]!;
}

/** A client tool's version from its `--version` line, e.g. `pg_dump (PostgreSQL) 17.6 (Ubuntu 17.6-1.pgdg24.04+1)`. */
export function toolVersion(
	line: string
): { version: string; major: number; minor: number } | null {
	const match = /\(PostgreSQL\) (\d+)\.(\d+)/.exec(line);
	return match
		? { version: `${match[1]}.${match[2]}`, major: Number(match[1]), minor: Number(match[2]) }
		: null;
}

/** The version in the `--version` output of the tool at `path`; throws unless it's 17.`minMinor` or a later 17.x. */
export function checkToolVersion(
	path: string,
	output: string,
	minMinor: number
): { version: string; major: number; minor: number } {
	const found = toolVersion(output);
	if (!found || found.major !== 17 || found.minor < minMinor) {
		throw new Error(
			`${path} must be PostgreSQL 17.${minMinor} or later 17.x; got ${found?.version ?? 'unknown'}`
		);
	}
	return found;
}

/**
 * An `aws s3api` command line against the R2 bucket, with JSON output and timeouts: the CLI retries throttling (429)
 * and 503s itself, and the timeouts stop a stalled connection from holding the job until its own timeout.
 */
export const s3apiArgs = (r2: { endpoint: string; bucket: string }, args: string[]) => [
	's3api',
	...args,
	'--endpoint-url',
	r2.endpoint,
	'--bucket',
	r2.bucket,
	'--output',
	'json',
	'--cli-connect-timeout',
	'30',
	'--cli-read-timeout',
	'300'
];

export type R2Object = { key: string; lastModified: Date; size: number; etag: string };

/** An S3 ETag without its quotes; for a single-part upload it's the object's MD5. */
export const etagOf = (raw: string) => raw.replaceAll('"', '');

/** Whether a production daily from `month` (`YYYY-MM`) has `etag`, i.e. holds the same bytes. */
export const matchesADaily = (
	month: string,
	etag: string,
	dailies: Pick<R2Object, 'key' | 'etag'>[]
) => dailies.some((d) => d.key.startsWith(`production/daily/${month}`) && d.etag === etag);

const DAILY_AGE_LIMIT_HOURS = 72;
const DAILY_MIN_BYTES = 1024;
// The watchdog's failure messages, shared with the tests.
export const NO_DAILIES = 'no production daily backups';
export const dailyTooOld = (hours: string) =>
	`newest daily is ${hours} hours old (limit ${DAILY_AGE_LIMIT_HOURS})`;
export const dailyTooSmall = (bytes: number) =>
	`newest daily is ${bytes} bytes (minimum ${DAILY_MIN_BYTES})`;
export const monthlyMissing = (month: string) => `monthly ${month} missing`;
export const monthlyUnmatched = (month: string) =>
	`monthly ${month} matches no daily from that month`;

const isDaily = (o: R2Object) =>
	o.key.startsWith('production/daily/') && o.key.endsWith('.tar.age');

/** The most recently written production daily, if any. */
export const newestDaily = (objects: R2Object[]): R2Object | undefined =>
	objects
		.filter(isDaily)
		.reduce<R2Object | undefined>(
			(a, b) => (a && a.lastModified >= b.lastModified ? a : b),
			undefined
		);

/**
 * What the watchdog fails on. The backup runs at 07:17 UTC and the watchdog at 13:43: a normal day shows a newest
 * daily about 6.4 hours old, and 72 tolerates two missed nights (54) but not three (78). Only `.tar.age` keys count.
 */
export function watchdogFailures(objects: R2Object[], now: Date): string[] {
	const backups = objects.filter((o) => o.key.endsWith('.tar.age'));
	const dailies = backups.filter(isDaily);
	const failures: string[] = [];
	const newest = newestDaily(objects);
	if (!newest) failures.push(NO_DAILIES);
	else {
		const hours = (now.getTime() - newest.lastModified.getTime()) / 3_600_000;
		if (hours > DAILY_AGE_LIMIT_HOURS) failures.push(dailyTooOld(hours.toFixed(1)));
		if (newest.size < DAILY_MIN_BYTES) failures.push(dailyTooSmall(newest.size));
	}

	const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
	const thisMonth = monthOf(now);
	const lastMonth = monthOf(new Date(monthStart.getTime() - 1));
	const monthlies = new Map(
		backups
			.map((o) => [/^production\/monthly\/(\d{4}-\d{2})\.tar\.age$/.exec(o.key)?.[1], o] as const)
			.filter((entry): entry is readonly [string, R2Object] => entry[0] !== undefined)
	);
	// The copy step runs with the month's first daily; the 3rd allows the same two missed nights as the dailies.
	const dailyThisMonth = dailies.some((d) => d.lastModified >= monthStart);
	if (!monthlies.has(thisMonth) && (dailyThisMonth || now.getUTCDate() >= 3)) {
		failures.push(monthlyMissing(thisMonth));
	}
	// Only once backups predate this month, so the first month of rollout isn't flagged.
	if (!monthlies.has(lastMonth) && backups.some((o) => o.lastModified < monthStart)) {
		failures.push(monthlyMissing(lastMonth));
	}
	// A monthly is a byte copy of the daily its run wrote just before it, so it's checked while some same-month daily
	// from no later than the monthly is kept. Once its source expires (36 days) only later dailies remain, and those
	// never match.
	for (const [month, monthly] of [...monthlies].sort(([a], [b]) => (a < b ? -1 : 1))) {
		const sameMonth = dailies.filter((d) => d.key.startsWith(`production/daily/${month}`));
		const sourceKept = sameMonth.some((d) => d.lastModified <= monthly.lastModified);
		if (sourceKept && !matchesADaily(month, monthly.etag, sameMonth)) {
			failures.push(monthlyUnmatched(month));
		}
	}
	return failures;
}

/** `--backup <path> --identity <path> --target-ref <ref>`, all required. */
export function parseRestoreArgs(args: string[]): {
	backup: string;
	identity: string;
	targetRef: string;
} {
	const { values } = parseArgs({
		args,
		strict: true,
		allowPositionals: false,
		options: {
			backup: { type: 'string' },
			identity: { type: 'string' },
			'target-ref': { type: 'string' }
		}
	});
	const { backup, identity, 'target-ref': targetRef } = values;
	if (!backup || !identity || !targetRef || !PROJECT_REF.test(targetRef)) {
		throw new Error(
			'Usage: npm exec --no -- supabase-backup restore --backup <path to .tar.age> --identity <path to key file> --target-ref <20-character project ref>'
		);
	}
	return { backup, identity, targetRef };
}

/** `--ref <ref> --host <session pooler host>`, both required. */
export function parsePasswordArgs(args: string[]): { ref: string; host: string } {
	const { values } = parseArgs({
		args,
		strict: true,
		allowPositionals: false,
		options: { ref: { type: 'string' }, host: { type: 'string' } }
	});
	const { ref, host } = values;
	if (
		!ref ||
		!host ||
		!PROJECT_REF.test(ref) ||
		!/^[a-z0-9.-]+\.pooler\.supabase\.com$/.test(host)
	) {
		throw new Error(
			'Usage: npm exec --no -- supabase-backup password --ref <20-character project ref> --host <session pooler host, e.g. aws-0-us-east-1.pooler.supabase.com>'
		);
	}
	return { ref, host };
}
