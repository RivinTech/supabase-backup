import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { projectRoot } from './db.ts';

/**
 * Where a project pins this package: the reusable workflows' `uses:` lines and every lockfile's `supabase-backup`
 * entry. `verify-pins` fails unless they all name one repo at one full commit SHA, so a bump can't leave the nightly
 * workflow running different code from the tools that set its database up. Which repo is the right one isn't checked:
 * the package doesn't know its owner, and README > Updating the package has the person bumping it review the pin.
 */

export type Pin = { file: string; owner: string; repo: string; ref: string };
type Text = { file: string; text: string };

const SHA = /^[0-9a-f]{40}$/;
const USES =
	/^\s*(?:-\s*)?uses:\s*['"]?([\w.-]+)\/(supabase-backup)\/\.github\/workflows\/[\w.-]+@([^\s'"#]+)/gim;
// The forms npm writes for a GitHub git dependency; it writes git+ssh whatever URL was installed.
const RESOLVED =
	/^(?:git\+ssh:\/\/git@github\.com\/|git\+https:\/\/github\.com\/|github:)([\w.-]+)\/([\w.-]+?)(?:\.git)?#(.+)$/;
const ENTRY = 'node_modules/supabase-backup';

/** The repo and ref a lockfile's `resolved` names, or null when it isn't a GitHub git dependency. */
export function resolvedPin(resolved: unknown): Omit<Pin, 'file'> | null {
	const match = typeof resolved === 'string' ? RESOLVED.exec(resolved) : null;
	return match ? { owner: match[1]!, repo: match[2]!, ref: match[3]! } : null;
}

/** Every `uses: <owner>/supabase-backup/.github/workflows/<file>@<ref>` in a workflow file. */
export const workflowPins = ({ file, text }: Text): Pin[] =>
	[...text.matchAll(USES)].map((m) => ({ file, owner: m[1]!, repo: m[2]!, ref: m[3]! }));

/** A lockfile's `supabase-backup` entries (direct or nested), and the entries that aren't GitHub pins. */
export function lockPins({ file, text }: Text): { pins: Pin[]; problems: string[] } {
	let packages: Record<string, { resolved?: unknown }>;
	try {
		packages = (JSON.parse(text) as { packages?: typeof packages }).packages ?? {};
	} catch (error) {
		return { pins: [], problems: [`${file}: not valid JSON (${String(error)})`] };
	}
	const pins: Pin[] = [];
	const problems: string[] = [];
	for (const [key, entry] of Object.entries(packages)) {
		if (key !== ENTRY && !key.endsWith(`/${ENTRY}`)) continue;
		const pin = resolvedPin(entry.resolved);
		if (pin) pins.push({ file, ...pin });
		else {
			problems.push(`${file}: ${key} resolves to ${String(entry.resolved)}, not a GitHub commit`);
		}
	}
	return { pins, problems };
}

const describe = (p: Pin) => `${p.file}: ${p.owner}/${p.repo}@${p.ref}`;

/** Why the pins disagree; empty when every pin names the same repo at the same full SHA. */
export function pinProblems(workflowTexts: Text[], lockTexts: Text[]): string[] {
	const workflow = workflowTexts.flatMap(workflowPins);
	const locks = lockTexts.map(lockPins);
	const lock = locks.flatMap((l) => l.pins);
	const problems = locks.flatMap((l) => l.problems);
	if (!workflow.length) problems.push('no workflow uses supabase-backup/.github/workflows/…');
	if (!lock.length) problems.push('no package-lock.json resolves supabase-backup');
	const all = [...workflow, ...lock];
	for (const p of all.filter((p) => !SHA.test(p.ref))) {
		problems.push(`${describe(p)} isn't a full 40-character commit SHA`);
	}
	if (new Set(all.map((p) => `${p.owner}/${p.repo}`.toLowerCase())).size > 1) {
		problems.push(`the pins name different repos: ${all.map(describe).join('; ')}`);
	}
	if (new Set(all.map((p) => p.ref)).size > 1) {
		problems.push(`the pins differ: ${all.map(describe).join('; ')}`);
	}
	return problems;
}

/**
 * The commit of the installed package, from npm's hidden lockfile, or null when it isn't a git install (a tarball or
 * local path while developing). `package.json`'s version can't tell commits apart.
 */
export function toolCommit(root = projectRoot): string | null {
	try {
		const lock = JSON.parse(
			readFileSync(join(root, 'node_modules', '.package-lock.json'), 'utf8')
		) as {
			packages?: Record<string, { resolved?: unknown }>;
		};
		const ref = resolvedPin(lock.packages?.[ENTRY]?.resolved)?.ref;
		return ref && SHA.test(ref) ? ref : null;
	} catch {
		return null;
	}
}

/** Every `package-lock.json` under `dir`, skipping `node_modules` and `.git`. */
function lockfiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			return entry.name === 'node_modules' || entry.name === '.git' ? [] : lockfiles(path);
		}
		return entry.name === 'package-lock.json' ? [path] : [];
	});
}

/**
 * `verify-pins`: checks every workflow pin in the git repository holding the current folder against every lockfile
 * in it, or only `lockfile` when given. Prints the result and returns whether it passed.
 */
export function verifyPins(lockfile?: string): boolean {
	let top: string;
	try {
		top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe']
		}).trim();
	} catch {
		throw new Error('verify-pins checks a git repository; run it inside one');
	}
	const read = (path: string) => ({
		file: relative(top, path).replaceAll('\\', '/'),
		text: readFileSync(path, 'utf8')
	});
	const workflowsDir = join(top, '.github', 'workflows');
	const workflows = existsSync(workflowsDir)
		? readdirSync(workflowsDir)
				.filter((f) => /\.ya?ml$/.test(f))
				.map((f) => read(join(workflowsDir, f)))
		: [];
	const locks = (lockfile ? [resolve(lockfile)] : lockfiles(top)).map(read);
	const problems = pinProblems(workflows, locks);
	const pins = [...workflows.flatMap(workflowPins), ...locks.flatMap((l) => lockPins(l).pins)];
	for (const p of pins) console.log(describe(p));
	if (problems.length) {
		for (const problem of problems) console.error(`verify-pins: ${problem}`);
		return false;
	}
	console.log(`verify-pins: ${pins.length} pins agree`);
	return true;
}
