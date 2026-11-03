import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Config } from './config.ts';
import { checkDevURL } from './devDB.ts';

const CONFIG: Config = {
	production: { ref: 'prodprodprodprodprod', name: 'Production' },
	dev: { ref: 'devdevdevdevdevdevde', name: 'Dev' }
};
const url = (user: string) =>
	`postgresql://${user}:secret@aws-0-us-east-1.pooler.supabase.com:5432/postgres`;

test('checkDevURL accepts only the dev project as postgres', () => {
	assert.equal(
		checkDevURL(CONFIG, ` ${url('postgres.devdevdevdevdevdevde')} `).user,
		'postgres.devdevdevdevdevdevde'
	);
	for (const empty of [undefined, '', '   ']) {
		assert.throws(() => checkDevURL(CONFIG, empty), /DEV_DB_URL is required/);
	}
	assert.throws(
		() => checkDevURL(CONFIG, url('postgres.prodprodprodprodprod')),
		/points at production/
	);
	assert.throws(
		() => checkDevURL(CONFIG, url('backup_reader.devdevdevdevdevdevde')),
		/user must be postgres\.devdevdevdevdevdevde/
	);
});
