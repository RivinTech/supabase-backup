import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { lockPins, pinProblems, resolvedPin, toolCommit, workflowPins } from './pins.ts';

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

const workflow = (ref: string, owner = 'RivinTech') => ({
	file: '.github/workflows/db-backup.yml',
	text: `jobs:
  backup:
    uses: ${owner}/supabase-backup/.github/workflows/backup.yml@${ref}
  watchdog:
    uses: '${owner}/supabase-backup/.github/workflows/watchdog.yml@${ref}' # pinned
`
});
const lock = (resolved: string, key = 'node_modules/supabase-backup') => ({
	file: 'supabase/package-lock.json',
	text: JSON.stringify({ packages: { '': {}, [key]: { resolved } } })
});

test('resolvedPin reads the GitHub forms npm writes, and nothing else', () => {
	const pin = { owner: 'RivinTech', repo: 'supabase-backup', ref: SHA };
	assert.deepEqual(
		resolvedPin(`git+ssh://git@github.com/RivinTech/supabase-backup.git#${SHA}`),
		pin
	);
	assert.deepEqual(resolvedPin(`git+https://github.com/RivinTech/supabase-backup.git#${SHA}`), pin);
	assert.deepEqual(resolvedPin(`github:RivinTech/supabase-backup#${SHA}`), pin);
	assert.equal(
		resolvedPin('https://registry.npmjs.org/supabase-backup/-/supabase-backup-1.0.0.tgz'),
		null
	);
	assert.equal(resolvedPin('file:../supabase-backup'), null);
	assert.equal(resolvedPin(undefined), null);
});

test('workflowPins finds every uses: line, quoted or not', () => {
	assert.deepEqual(
		workflowPins(workflow(SHA)).map((p) => p.ref),
		[SHA, SHA]
	);
	assert.deepEqual(workflowPins({ file: 'x.yml', text: 'uses: actions/checkout@v4' }), []);
});

test('lockPins finds direct and nested entries and flags non-GitHub ones', () => {
	assert.equal(lockPins(lock(`github:RivinTech/supabase-backup#${SHA}`)).pins.length, 1);
	const nested = lock(
		`github:RivinTech/supabase-backup#${SHA}`,
		'node_modules/other/node_modules/supabase-backup'
	);
	assert.equal(lockPins(nested).pins.length, 1);
	assert.match(lockPins(lock('file:../x')).problems[0]!, /not a GitHub commit/);
	assert.match(lockPins({ file: 'p.json', text: '{' }).problems[0]!, /not valid JSON/);
	assert.deepEqual(
		lockPins(lock(`github:RivinTech/supabase-backup#${SHA}`, 'node_modules/supabase-backup-x')),
		{
			pins: [],
			problems: []
		}
	);
});

test('pinProblems passes only when every pin names one repo at one full SHA', () => {
	const good = lock(`git+ssh://git@github.com/rivintech/supabase-backup.git#${SHA}`);
	assert.deepEqual(pinProblems([workflow(SHA)], [good]), []);
	assert.match(pinProblems([], [good]).join(), /no workflow uses/);
	assert.match(pinProblems([workflow(SHA)], []).join(), /no package-lock\.json resolves/);
	assert.match(
		pinProblems([workflow('main')], [lock('github:RivinTech/supabase-backup#main')]).join(),
		/full 40-character/
	);
	assert.match(pinProblems([workflow(SHA, 'someone')], [good]).join(), /different repos/);
	assert.match(pinProblems([workflow(OTHER)], [good]).join(), /the pins differ/);
});

test("toolCommit reads the installed commit from npm's hidden lockfile", (t) => {
	const root = mkdtempSync(join(tmpdir(), 'supabase-backup-test-'));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	assert.equal(toolCommit(root), null);
	mkdirSync(join(root, 'node_modules'));
	const hidden = join(root, 'node_modules', '.package-lock.json');
	writeFileSync(hidden, lock(`git+ssh://git@github.com/RivinTech/supabase-backup.git#${SHA}`).text);
	assert.equal(toolCommit(root), SHA);
	writeFileSync(hidden, lock('file:../supabase-backup').text);
	assert.equal(toolCommit(root), null);
	writeFileSync(hidden, lock('github:RivinTech/supabase-backup#main').text);
	assert.equal(toolCommit(root), null);
});

test('pinProblems flags a lockfile that resolves another repo', () => {
	assert.match(
		pinProblems([workflow(SHA)], [lock(`github:RivinTech/other-backup#${SHA}`)]).join(),
		/name different repos/
	);
});
