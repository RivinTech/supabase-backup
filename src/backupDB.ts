import type pg from 'pg';
import {
	quoteIdent,
	schemaNameProblem,
	sortedNames,
	type DatabaseState,
	type TableState
} from './backupCore.ts';

/**
 * The database reads the backup and the restore share, so a restored database is measured exactly as its backup was.
 * Callers run them inside one transaction (the backup's snapshot, or the restore's read-only check).
 */

/** Whether `error` means `backup.schemas()` isn't there: no such function (42883) or no `backup` schema (3F000). */
export const missingSchemasFunction = (error: unknown) =>
	['42883', '3F000'].includes((error as { code?: string } | null)?.code ?? '');

/** What to throw when `select backup.schemas()` fails: the fix for a missing or unexecutable function, else `error`. */
export function schemasError(error: unknown): unknown {
	if (missingSchemasFunction(error)) {
		return new Error(
			'backup.schemas() is missing; generate the backup migration (npm exec --no -- supabase-backup migration --schemas …) and push it'
		);
	}
	if ((error as { code?: string } | null)?.code === '42501') {
		return new Error(
			"backup_reader can't execute backup.schemas(); re-run the generated migration's grants"
		);
	}
	return error;
}

/** `backup.schemas()`'s result, sorted; throws when it's empty or a name is unplain or reserved. */
export function checkSchemaList(schemas: unknown): string[] {
	if (!Array.isArray(schemas) || !schemas.length) {
		throw new Error('backup.schemas() returned no schemas');
	}
	const problems = schemas.map(schemaNameProblem).filter((p) => p !== null);
	if (problems.length) throw new Error(`backup.schemas(): ${problems.join('; ')}`);
	return sortedNames(schemas as string[]);
}

/** The backed-up schemas, from `backup.schemas()` (the generated migration's single source), sorted. */
export async function backedUpSchemas(client: pg.Client): Promise<string[]> {
	let schemas: unknown;
	try {
		schemas = (await client.query<{ schemas: unknown }>('select backup.schemas() as schemas'))
			.rows[0]?.schemas;
	} catch (error) {
		throw schemasError(error);
	}
	return checkSchemaList(schemas);
}

/**
 * Fixes every setting that changes a row's text form, so a table's hash is reproducible on another server. `local`, so
 * it ends with the transaction.
 */
export async function setReproducibleOutput(client: pg.Client): Promise<void> {
	await client.query(
		`set local timezone = 'UTC'; set local datestyle = 'ISO, YMD'; set local intervalstyle = 'postgres';
		 set local extra_float_digits = 1; set local bytea_output = 'hex'; set local lc_monetary = 'C';
		 set local search_path = ''`
	);
}

/** The names, `schema.name`, of the backed-up relations of `kind`, sorted. */
async function relationNames(
	client: pg.Client,
	schemas: string[],
	kind: 'r' | 'S'
): Promise<string[]> {
	const { rows } = await client.query<{ name: string }>(
		`select format('%s.%s', n.nspname, c.relname) as name
		 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
		 where n.nspname = any ($1) and c.relkind = $2
		 order by format('%s.%s', n.nspname, c.relname) collate "C"`,
		[schemas, kind]
	);
	return rows.map((r) => r.name);
}

/** The backed-up sequences, `schema.name`, sorted. */
export const sequenceNames = (client: pg.Client, schemas: string[]) =>
	relationNames(client, schemas, 'S');

/** `schema.name` as an SQL identifier; the backed-up names are plain identifiers, so quoting each part suffices. */
const quoted = (name: string) => name.split('.').map(quoteIdent).join('.');

/**
 * Every backed-up table's row count and content hash. Only kind `r`: pg_dump writes no data for a partitioned parent,
 * and its partitions are kind `r` themselves. Per-row digests keep the aggregate far below the 1 GB text limit, and
 * `collate "C"` makes their order independent of the database's collation. One query per table, so an error names
 * its table; the round trips are small next to hashing every row.
 */
async function tableStates(client: pg.Client, schemas: string[]): Promise<TableState[]> {
	const states: TableState[] = [];
	for (const name of await relationNames(client, schemas, 'r')) {
		const { rows } = await client.query<{ rows: string; hash: string }>(
			`select count(*) as rows, md5(coalesce(string_agg(h, '' order by h collate "C"), '')) as hash
			 from (select md5(t::text) as h from ${quoted(name)} t) d`
		);
		states.push({ name, rows: Number(rows[0]!.rows), hash: rows[0]!.hash });
	}
	return states;
}

/** Tables, policies, and RLS state; the caller adds the auth row counts, which it reads its own way. */
export async function readDatabaseState(
	client: pg.Client,
	schemas: string[]
): Promise<Omit<DatabaseState, 'auth'>> {
	// public too: its policies and RLS state are part of the app's security, though its tables aren't backed up.
	const checked = ['public', ...schemas];
	const { rows: policies } = await client.query<{ n: number }>(
		'select count(*)::int as n from pg_catalog.pg_policies where schemaname = any ($1)',
		[checked]
	);
	const { rows: noRLS } = await client.query<{ name: string }>(
		`select format('%s.%s', n.nspname, c.relname) as name
		 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
		 where n.nspname = any ($1) and c.relkind in ('r', 'p') and not c.relrowsecurity
		 order by format('%s.%s', n.nspname, c.relname) collate "C"`,
		[checked]
	);
	return {
		tables: await tableStates(client, schemas),
		policies: policies[0]!.n,
		rlsDisabledTables: noRLS.map((r) => r.name)
	};
}

/** The server's version, e.g. `17.6`, and its major. */
export async function serverVersion(
	client: pg.Client
): Promise<{ version: string; major: number }> {
	const { rows } = await client.query<{ version: string; num: string }>(
		`select current_setting('server_version') as version, current_setting('server_version_num') as num`
	);
	return { version: rows[0]!.version, major: Math.floor(Number(rows[0]!.num) / 10000) };
}
