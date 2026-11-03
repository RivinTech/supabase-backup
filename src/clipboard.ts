import { spawnSync } from 'node:child_process';

/** The clipboard tools `password` can use, in the order it tries them. */

export type ClipboardCommand = { command: string; args: string[] };

/** The first clipboard tool for `platform` that `has` finds, or null. */
export function clipboardCommand(
	platform: NodeJS.Platform,
	has: (command: string) => boolean
): ClipboardCommand | null {
	const candidates: ClipboardCommand[] =
		platform === 'win32'
			? [{ command: 'clip.exe', args: [] }]
			: platform === 'darwin'
				? [{ command: 'pbcopy', args: [] }]
				: [
						{ command: 'wl-copy', args: [] },
						{ command: 'xclip', args: ['-selection', 'clipboard'] }
					];
	return candidates.find((c) => has(c.command)) ?? null;
}

export const NO_CLIPBOARD =
	'no clipboard tool found (clip.exe, pbcopy, wl-copy, xclip); nothing was changed';

/** Whether `command` is on PATH: `where` on Windows, `command -v` elsewhere. */
function onPath(command: string): boolean {
	const probe =
		process.platform === 'win32'
			? spawnSync('where', [command], { stdio: 'ignore' })
			: spawnSync('sh', ['-c', 'command -v "$1"', 'sh', command], { stdio: 'ignore' });
	return probe.status === 0;
}

/** This machine's clipboard tool; throws `NO_CLIPBOARD` when there is none. */
export function findClipboard(): ClipboardCommand {
	const found = clipboardCommand(process.platform, onPath);
	if (!found) throw new Error(NO_CLIPBOARD);
	return found;
}

/** Copies `text` with `tool`; throws when the tool fails. The text never reaches an argument or the terminal. */
export function copyToClipboard(tool: ClipboardCommand, text: string): void {
	// No output pipes: xclip and wl-copy leave a child serving the clipboard, and spawnSync would wait for it to close
	// an inherited pipe, which it never does.
	const result = spawnSync(tool.command, tool.args, {
		input: text,
		stdio: ['pipe', 'ignore', 'ignore']
	});
	if (result.status !== 0) {
		throw new Error(`couldn't copy to the clipboard (${tool.command} failed); nothing was changed`);
	}
}
