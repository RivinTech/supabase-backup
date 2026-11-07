import assert from 'node:assert/strict';
import { test } from 'node:test';
import type pg from 'pg';
import { checkCoverage, pgDumpArgs } from './backup.ts';
import {
	checkSchemaList,
	missingSchemasFunction,
	schemasError,
	tableHashQuery
} from './backupDB.ts';

const pgError = (code: string) => Object.assign(new Error(`pg ${code}`), { code });

test('schemasError gives the fix for a missing or unexecutable backup.schemas()', () => {
	for (const code of ['42883', '3F000']) {
		assert.ok(missingSchemasFunction(pgError(code)));
		assert.match(String(schemasError(pgError(code))), /backup\.schemas\(\) is missing; generate/);
	}
	assert.match(String(schemasError(pgError('42501'))), /can't execute backup\.schemas\(\)/);
	const other = pgError('08006');
	assert.equal(schemasError(other), other);
	assert.equal(schemasError(null), null);
	assert.equal(missingSchemasFunction(null), false);
});

test('checkSchemaList sorts a non-empty list of plain, unreserved names', () => {
	assert.deepEqual(checkSchemaList(['zeta', 'app_history', 'app']), ['app', 'app_history', 'zeta']);
	for (const empty of [[], null, 'app']) {
		assert.throws(() => checkSchemaList(empty), /returned no schemas/);
	}
	assert.throws(
		() => checkSchemaList(['app', 'public']),
		/backup\.schemas\(\): .*public is reserved/
	);
	assert.throws(() => checkSchemaList(['App']), /isn't a plain lowercase/);
});

/**
 * A client whose queries return a clean database, except `missing` from the missing-schema query. The query itself is
 * SQL, checked against a real database; this pins that its parameter is the list and its rows fail the guard.
 */
function coverageClient(missing: string[]) {
	const params: unknown[][] = [];
	const client = {
		query: async (sql: string, values?: unknown[]) => {
			if (sql.includes('unnest(')) {
				params.push(values ?? []);
				return { rows: missing.map((name) => ({ name })) };
			}
			if (sql.includes('pg_largeobject_metadata')) return { rows: [{ count: '0' }] };
			return { rows: [] };
		}
	};
	return { client: client as unknown as pg.Client, params };
}

test('checkCoverage fails on a listed schema that is missing or not owned by postgres', async () => {
	const clean = coverageClient([]);
	await checkCoverage(clean.client, ['app', 'zeta']);
	assert.deepEqual(clean.params, [[['app', 'zeta']]]);

	const { client } = coverageClient(['zeta']);
	await assert.rejects(
		checkCoverage(client, ['app', 'zeta']),
		/^Error: schema guard: backup\.schemas\(\) lists zeta, which doesn't exist or isn't owned by postgres$/
	);
});

test('tableHashQuery hashes whole rows, so a column named t cannot stand in for the row', () => {
	const sql = tableHashQuery('app.note');
	assert.match(sql, /md5\(row\(t\.\*\)::text\) as h from "app"\."note" t\)/);
	assert.doesNotMatch(sql, /md5\(t::text\)/);
});

test('pgDumpArgs dumps exactly the listed schemas, strictly, from the snapshot', () => {
	assert.deepEqual(pgDumpArgs('00000003-1', ['app', 'app_history'], '/w/app.dump'), [
		'--snapshot=00000003-1',
		'-Fc',
		'--strict-names',
		'-n',
		'app',
		'-n',
		'app_history',
		'-f',
		'/w/app.dump'
	]);
});
