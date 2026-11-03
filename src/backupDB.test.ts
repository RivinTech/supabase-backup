import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pgDumpArgs } from './backup.ts';
import { checkSchemaList, missingSchemasFunction, schemasError } from './backupDB.ts';

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
