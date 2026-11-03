import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { test } from 'node:test';
import {
	checkProjectRoot,
	CONFIG_FILE,
	projectRoot,
	projectWorkdir,
	pushArgs,
	runCommand
} from './db.ts';

test('child processes run in the project root, and the push names an absolute workdir', async () => {
	const result = await runCommand(process.execPath, ['-e', 'console.log(process.cwd())'], {
		redact: (t) => t,
		capture: true
	});
	assert.equal(result.code, 0);
	assert.equal(result.stdout, projectRoot);
	assert.ok(isAbsolute(projectWorkdir));
	const args = pushArgs('cli.js', 'postgresql://x', projectWorkdir);
	assert.equal(args[args.indexOf('--workdir') + 1], projectWorkdir);
});

test('checkProjectRoot needs a folder named supabase, holding the config when asked', (t) => {
	const parent = mkdtempSync(join(tmpdir(), 'supabase-backup-test-'));
	t.after(() => rmSync(parent, { recursive: true, force: true }));
	const root = join(parent, 'supabase');
	mkdirSync(root);
	checkProjectRoot(false, root);
	assert.throws(() => checkProjectRoot(true, root), /supabase-backup\.json not found/);
	writeFileSync(join(root, CONFIG_FILE), '{}');
	checkProjectRoot(true, root);
	assert.throws(
		() => checkProjectRoot(false, parent),
		/run from the project's supabase folder \(found /
	);
});
