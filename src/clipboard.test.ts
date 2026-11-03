import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clipboardCommand } from './clipboard.ts';

const having =
	(...found: string[]) =>
	(command: string) =>
		found.includes(command);

test('clipboardCommand picks the platform tool, then wl-copy before xclip elsewhere', () => {
	assert.deepEqual(clipboardCommand('win32', having('clip.exe')), {
		command: 'clip.exe',
		args: []
	});
	assert.deepEqual(clipboardCommand('darwin', having('pbcopy')), { command: 'pbcopy', args: [] });
	assert.deepEqual(clipboardCommand('linux', having('wl-copy', 'xclip')), {
		command: 'wl-copy',
		args: []
	});
	assert.deepEqual(clipboardCommand('linux', having('xclip')), {
		command: 'xclip',
		args: ['-selection', 'clipboard']
	});
});

test('clipboardCommand returns null when the platform has none of its tools', () => {
	assert.equal(clipboardCommand('win32', having('pbcopy', 'xclip')), null);
	assert.equal(clipboardCommand('darwin', having('clip.exe', 'wl-copy')), null);
	assert.equal(clipboardCommand('linux', having()), null);
	assert.equal(clipboardCommand('freebsd', having('pbcopy')), null);
});
