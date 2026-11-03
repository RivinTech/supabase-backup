import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import pg from 'pg';

/**
 * Database connection helpers shared by the dev runner, the backup, and the restore.
 *
 * Invariants:
 * - **Verified TLS.** Every connection uses the Supabase root CA in `certs/` with `rejectUnauthorized: true`. The
 *   `pg` config is built from the URL's parts, so any `sslmode` in it is ignored (pg 8 maps `require` to verify-full
 *   with a deprecation warning). URLs and environments handed to child processes carry `sslmode=verify-full` and the
 *   same CA. Never set `rejectUnauthorized: false`.
 * - **No secrets in output.** Errors name the environment variable, never its value, and every line a child process
 *   prints passes through the caller's `redact`.
 * - **No password on a command line.** Child processes get it through `PGPASSWORD`, so it never shows in a process
 *   listing.
 *
 * These commands print with `console.log`, not a leveled logger: each is a run a person reads start to finish (a
 * terminal, or the Actions step log), every line is part of that record, and none runs in a server to filter or ship
 * logs from. The guarantee that matters, redaction, holds for every line.
 */

/** The package folder, from `src/` (tests) or `dist/` (installed): it holds `certs/` and the shipped `tests/`. */
export const packageRoot = new URL('../', import.meta.url);
const caFile = new URL('certs/prod-ca-2021.crt', packageRoot);

/**
 * The project's `supabase` folder: the working directory, which the project's npm scripts set. Its migrations,
 * tests, perf script, `config.toml`, `.env`, and `backup/recipient.txt` live here.
 */
export const projectRoot = process.cwd();
export const projectPath = (...parts: string[]) => join(projectRoot, ...parts);

/**
 * `name` from the project's `.env`, and only from there: a value left in the shell (by an earlier restore drill, say)
 * must not silently win over the file the README says to edit. Throws if the file is missing, with `hint` saying what
 * to put in it.
 */
export function projectEnv(name: string, hint: string): string | undefined {
	const file = projectPath('.env');
	if (!existsSync(file)) throw new Error(`${file} is missing; create it with ${name}, ${hint}`);
	return parseEnv(readFileSync(file, 'utf8'))[name];
}
/** The supabase CLI's `--workdir`: it reads `<workdir>/supabase/`. Absolute, so it doesn't depend on a child's cwd. */
export const projectWorkdir = dirname(projectRoot);
export const CONFIG_FILE = 'supabase-backup.json';

/**
 * Fails unless the working directory is a folder named `supabase` (the supabase CLI is run with `--workdir ..` and
 * reads `<workdir>/supabase/`) holding `supabase-backup.json` when `needsConfig`.
 */
export function checkProjectRoot(needsConfig: boolean, root = projectRoot): void {
	if (basename(root) !== 'supabase') {
		throw new Error(`run from the project's supabase folder (found ${basename(root)})`);
	}
	if (needsConfig && !existsSync(join(root, CONFIG_FILE))) {
		throw new Error(
			`${CONFIG_FILE} not found in ${root}; run from the project's supabase folder (npm scripts do).`
		);
	}
}

export type ParsedDBURL = {
	user: string;
	password: string;
	host: string;
	/** The URL without its password, with verified TLS, for the Supabase CLI. */
	cliURL: string;
	config: pg.ClientConfig;
	/** The password as written in the URL and decoded, deduplicated: what a CI log must mask. */
	passwordForms: string[];
	redact: (text: string) => string;
};

/** Parses a database URL from the environment variable `name`. The caller checks the user. */
export function parseDBURL(raw: string | undefined, name: string): ParsedDBURL {
	const trimmed = raw?.trim() ?? '';
	if (!trimmed) throw new Error(`${name} is required`);
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		throw new Error(`${name} is not a valid URL`);
	}
	const user = decodeURIComponent(parsed.username);
	const password = decodeURIComponent(parsed.password);
	if (!password) throw new Error(`${name} has no password`);
	const passwordForms = [...new Set([password, parsed.password])];
	const secrets = [...passwordForms, trimmed];
	const config: pg.ClientConfig = {
		host: parsed.hostname,
		port: Number(parsed.port || 5432),
		user,
		password,
		database: decodeURIComponent(parsed.pathname.slice(1)) || 'postgres',
		ssl: { ca: readFileSync(caFile, 'utf8'), rejectUnauthorized: true }
	};
	parsed.password = '';
	// The CLI's Go driver reads TLS settings from the URL: without these it defaults to `prefer`, which checks no
	// certificate and falls back to plaintext.
	parsed.searchParams.set('sslmode', 'verify-full');
	parsed.searchParams.set('sslrootcert', fileURLToPath(caFile));
	return {
		user,
		password,
		host: parsed.hostname,
		cliURL: parsed.toString(),
		config,
		passwordForms,
		// Every occurrence, however short the password: a mangled log line beats a leaked password, and the password
		// command generates long ones.
		redact: (text) => secrets.reduce((t, s) => t.replaceAll(s, '***'), text)
	};
}

/** The libpq environment for `pg_dump`, `pg_restore`, and `psql`: the connection, the password, and verified TLS. */
export const pgEnv = (db: ParsedDBURL): NodeJS.ProcessEnv => ({
	...process.env,
	PGHOST: db.host,
	PGPORT: String(db.config.port),
	PGUSER: db.user,
	PGPASSWORD: db.password,
	PGDATABASE: db.config.database,
	PGSSLMODE: 'verify-full',
	PGSSLROOTCERT: fileURLToPath(caFile)
});

/** Connects with verified TLS and prints notices, redacted. On a connection failure, adds `hint`. The caller ends it. */
export async function connect(
	db: Pick<ParsedDBURL, 'config' | 'redact'>,
	hint: string
): Promise<pg.Client> {
	const client = new pg.Client(db.config);
	client.on('notice', (n) => console.log(db.redact(`NOTICE: ${n.message}`)));
	try {
		await client.connect();
	} catch (error) {
		throw new Error(
			`Could not connect to ${db.config.host} as ${db.config.user}: ${String(error)}. ${hint}`
		);
	}
	return client;
}

/** `connect`, runs `body`, and always disconnects. */
export async function withClient<T>(
	db: Pick<ParsedDBURL, 'config' | 'redact'>,
	body: (client: pg.Client) => Promise<T>,
	hint: string
): Promise<T> {
	const client = await connect(db, hint);
	try {
		return await body(client);
	} finally {
		// Can't hide the body's error: pg's end() doesn't reject, even on a broken connection.
		await client.end();
	}
}

export type CommandResult = { code: number | null; ms: number; stdout: string; stderr: string };

/**
 * Runs a command. By default each output line is redacted and printed; with `capture`, stdout and stderr are
 * returned (redacted) instead. A command that can't start resolves with code null and the error in `stderr`.
 */
export async function runCommand(
	command: string,
	args: string[],
	options: {
		redact: (text: string) => string;
		env?: NodeJS.ProcessEnv;
		cwd?: string;
		capture?: boolean;
	}
): Promise<CommandResult> {
	const start = performance.now();
	const child = spawn(command, args, {
		cwd: options.cwd ?? projectRoot,
		env: options.env ?? process.env,
		stdio: ['ignore', 'pipe', 'pipe']
	});
	const captured = { stdout: [] as string[], stderr: [] as string[] };
	for (const which of ['stdout', 'stderr'] as const) {
		createInterface({ input: child[which] }).on('line', (raw) => {
			const line = options.redact(raw);
			if (options.capture) captured[which].push(line);
			else console.log(line);
		});
	}
	const code = await new Promise<number | null>((resolve) => {
		child.on('error', (error) => {
			const line = options.redact(String(error));
			if (options.capture) captured.stderr.push(line);
			else console.log(line);
			resolve(null);
		});
		child.on('close', resolve);
	});
	return {
		code,
		ms: Math.round(performance.now() - start),
		stdout: captured.stdout.join('\n'),
		stderr: captured.stderr.join('\n')
	};
}

/** Runs a command whose output is only needed on failure; returns its stdout, or throws with its redacted output. */
export async function runOrThrow(
	command: string,
	args: string[],
	redact: (text: string) => string,
	cwd?: string
): Promise<string> {
	const result = await runCommand(command, args, { redact, cwd, capture: true });
	if (result.code !== 0) {
		throw new Error(
			`${command} ${args[0] ?? ''} exited with ${result.code}: ${result.stderr || result.stdout}`
		);
	}
	return result.stdout;
}

/** A file's size and its hex digests, read as a stream so a large dump or archive is never held in memory. */
export async function hashFile<A extends string>(
	path: string,
	algorithms: A[]
): Promise<{ bytes: number } & Record<A, string>> {
	const hashes = algorithms.map((a) => createHash(a));
	let bytes = 0;
	for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) {
		bytes += chunk.length;
		for (const hash of hashes) hash.update(chunk);
	}
	const digests = Object.fromEntries(algorithms.map((a, i) => [a, hashes[i]!.digest('hex')]));
	return { bytes, ...digests } as { bytes: number } & Record<A, string>;
}

/** Times named steps: `await step('dump', () => …)` records the milliseconds in `steps`, also when the step throws. */
export function stepTimer() {
	const steps: Record<string, number> = {};
	const step = async <T>(name: string, body: () => Promise<T>): Promise<T> => {
		const start = performance.now();
		try {
			return await body();
		} finally {
			steps[name] = Math.round(performance.now() - start);
		}
	};
	return { steps, step };
}

/** The project's own supabase CLI (an optional peer dependency, so each project pins its version). */
export function supabaseCLI(root = projectRoot): string {
	try {
		const manifest = createRequire(join(root, 'package.json')).resolve('supabase/package.json');
		return join(dirname(manifest), 'dist', 'supabase.js');
	} catch {
		throw new Error(`the supabase CLI isn't installed; add "supabase" to devDependencies`);
	}
}

/** The `supabase db push` arguments. `workdir` is absolute, so they don't depend on the child's cwd. */
export const pushArgs = (cli: string, cliURL: string, workdir: string) => [
	cli,
	'db',
	'push',
	'--db-url',
	cliURL,
	'--workdir',
	workdir,
	'--yes'
];

/**
 * Runs `supabase db push` against `cliURL`, with the migrations under `<workdir>/supabase/` (by default the project's
 * own, `projectWorkdir`). `--yes` skips the confirmation prompt so output can be piped through `redact`.
 */
export async function pushMigrations(options: {
	cliURL: string;
	password: string;
	workdir?: string;
	redact: (text: string) => string;
}): Promise<CommandResult> {
	return runCommand(
		process.execPath,
		pushArgs(supabaseCLI(), options.cliURL, options.workdir ?? projectWorkdir),
		{ redact: options.redact, env: { ...process.env, PGPASSWORD: options.password } }
	);
}

/** The path of a PostgreSQL 17 client tool: `PG_BIN` if set, otherwise the platform's standard install location. */
export function pgTool(name: 'pg_dump' | 'pg_restore' | 'psql'): string {
	const file = process.platform === 'win32' ? `${name}.exe` : name;
	const tried = process.env.PG_BIN
		? [join(process.env.PG_BIN, file)]
		: process.platform === 'win32'
			? [join('C:\\Program Files\\PostgreSQL\\17\\bin', file)]
			: [join('/usr/lib/postgresql/17/bin', file)];
	const found = tried.find((path) => existsSync(path));
	if (!found) throw new Error(`${name} not found; tried ${tried.join(', ')}`);
	return found;
}
