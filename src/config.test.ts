import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { configJSON, loadConfig, parseConfig, writeConfig, type Config } from './config.ts';

const CONFIG: Config = {
	production: { ref: 'prodprodprodprodprod', name: 'Production' },
	dev: { ref: 'devdevdevdevdevdevde', name: 'Dev' }
};
const file = (config: Config) => JSON.parse(configJSON(config)) as Record<string, unknown>;

test('parseConfig reads the two projects', () => {
	assert.deepEqual(parseConfig(file(CONFIG)), CONFIG);
});

test('parseConfig names the first bad field', () => {
	const cases: [unknown, RegExp][] = [
		[null, /the file must be an object/],
		[[], /the file must be an object/],
		[{ projects: CONFIG, extra: 1 }, /unknown key extra/],
		[{}, /projects must be an object/],
		[{ projects: { ...CONFIG, staging: CONFIG.dev } }, /unknown key projects\.staging/],
		[{ projects: { dev: CONFIG.dev } }, /projects\.production must be an object/],
		[
			{ projects: { ...CONFIG, dev: { ...CONFIG.dev, region: 'x' } } },
			/unknown key projects\.dev\.region/
		],
		[
			{ projects: { ...CONFIG, dev: { ...CONFIG.dev, ref: 'short' } } },
			/projects\.dev\.ref must be a 20-character project ref/
		],
		[
			{ projects: { ...CONFIG, dev: { ...CONFIG.dev, ref: 'DEVDEVDEVDEVDEVDEVDE' } } },
			/projects\.dev\.ref/
		],
		[
			{ projects: { ...CONFIG, production: { ...CONFIG.production, name: ' ' } } },
			/projects\.production\.name must be a non-empty string/
		],
		[{ projects: { ...CONFIG, dev: CONFIG.production } }, /must differ/]
	];
	for (const [value, message] of cases) assert.throws(() => parseConfig(value), message);
});

test('writeConfig validates, writes what loadConfig reads, and never replaces a file', (t) => {
	const dir = mkdtempSync(join(tmpdir(), 'supabase-backup-test-'));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	assert.throws(() => writeConfig(dir, { ...CONFIG, dev: CONFIG.production }), /must differ/);
	assert.throws(() => loadConfig(dir), /Could not read/);
	const path = writeConfig(dir, CONFIG);
	assert.deepEqual(loadConfig(dir), CONFIG);
	assert.equal(readFileSync(path, 'utf8'), configJSON(CONFIG));
	assert.throws(() => writeConfig(dir, CONFIG), /already exists/);
	writeFileSync(path, '{not json');
	assert.throws(() => loadConfig(dir), /Could not read/);
});
