#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { runBackup } from './backup.ts';
import { loadConfig, writeConfig, type Config } from './config.ts';
import { checkProjectRoot, projectRoot } from './db.ts';
import { runDevCommand } from './devDB.ts';
import { writeMigration } from './migration.ts';
import { runPassword } from './password.ts';
import { verifyPins } from './pins.ts';
import { runRestore } from './restore.ts';
import { runWatchdog } from './watchdog.ts';

/**
 * The `supabase-backup` command. Every command but `init` and `watchdog` runs from the project's `supabase` folder,
 * which holds `supabase-backup.json`; the project's npm scripts run it there.
 */

const USAGE = `Usage: supabase-backup <command> [options], from the project's supabase folder

Commands:
  init --production-ref <ref> --production-name <name> --dev-ref <ref> --dev-name <name>
                     write supabase-backup.json
  migration --schemas <a,b,c>
                     write the migration that sets up backup_reader and the backed-up schema list
  push               push pending migrations to the dev database
  test               run the project's tests/*.sql, then the package's backup_reader test, on dev
  perf               run perf/perf.sql on dev
  backup             back up the database (GitHub Actions only)
  watchdog           check the production backups in R2 (GitHub Actions only)
  password --ref <ref> --host <session pooler host>
                     give backup_reader a new password, copied to the clipboard
  restore --backup <file> --identity <key file> --target-ref <ref>
                     restore a backup into a new, empty project
  verify-pins [--lockfile <path>]
                     check that the workflows and lockfiles pin one commit of this package
  --help             show this

Run it with npm exec --no -- supabase-backup <command>; plain npx can fetch an unrelated package of the same name.`;

/** A bad command line: the usage is printed and the exit code is 2. */
class UsageError extends Error {}

/** Errors from `node:util` parseArgs, or a command's own "Usage: " errors (restore, password), are usage errors. */
function asUsage(error: unknown): unknown {
	const code = (error as { code?: unknown } | null)?.code;
	const parseError = typeof code === 'string' && code.startsWith('ERR_PARSE_ARGS');
	const usageLine = error instanceof Error && error.message.startsWith('Usage: ');
	return parseError || usageLine ? new UsageError((error as Error).message) : error;
}

function project(): Config {
	checkProjectRoot(true);
	return loadConfig(projectRoot);
}

function noArgs(command: string, argv: string[]): void {
	if (argv.length) throw new UsageError(`${command} takes no arguments (got ${argv.join(' ')})`);
}

/** Runs one command; returns the exit code. */
async function run(command: string | undefined, argv: string[]): Promise<number> {
	switch (command) {
		case undefined:
		case '--help':
		case '-h':
		case 'help':
			console.log(USAGE);
			return command === undefined ? 2 : 0;
		case 'init': {
			const { values: v } = parseArgs({
				args: argv,
				options: {
					'production-ref': { type: 'string' },
					'production-name': { type: 'string' },
					'dev-ref': { type: 'string' },
					'dev-name': { type: 'string' }
				}
			});
			checkProjectRoot(false);
			const path = writeConfig(projectRoot, {
				production: { ref: v['production-ref'] ?? '', name: v['production-name'] ?? '' },
				dev: { ref: v['dev-ref'] ?? '', name: v['dev-name'] ?? '' }
			});
			console.log(`Wrote ${path}`);
			return 0;
		}
		case 'migration': {
			const { schemas } = parseArgs({
				args: argv,
				options: { schemas: { type: 'string' } }
			}).values;
			if (!schemas) throw new UsageError('migration needs --schemas <a,b,c>');
			project();
			console.log(`Wrote ${writeMigration(schemas.split(',').map((s) => s.trim()))}`);
			return 0;
		}
		case 'push':
		case 'test':
		case 'perf':
			noArgs(command, argv);
			return (await runDevCommand(command, project())) ? 0 : 1;
		case 'backup':
			noArgs(command, argv);
			try {
				await runBackup(project());
				return 0;
			} catch (error) {
				// runBackup redacts what it throws once it knows the secrets; errors before that carry none.
				console.error(`backup failed: ${error instanceof Error ? error.message : String(error)}`);
				return 1;
			}
		case 'watchdog':
			noArgs(command, argv);
			try {
				return (await runWatchdog()) ? 0 : 1;
			} catch (error) {
				console.error(`watchdog failed: ${error instanceof Error ? error.message : String(error)}`);
				return 1;
			}
		case 'password':
			runPassword(project(), argv);
			return 0;
		case 'restore': {
			const config = project();
			try {
				return (await runRestore(config, argv)) ? 0 : 1;
			} catch (error) {
				const usage = asUsage(error);
				if (usage instanceof UsageError) throw usage;
				// runRestore redacts what it throws once it knows the URL; errors before that carry none.
				console.error(`restore failed: ${error instanceof Error ? error.message : String(error)}`);
				return 1;
			}
		}
		case 'verify-pins': {
			const { lockfile } = parseArgs({
				args: argv,
				options: { lockfile: { type: 'string' } }
			}).values;
			checkProjectRoot(false);
			return verifyPins(lockfile) ? 0 : 1;
		}
		default:
			throw new UsageError(`unknown command ${command}`);
	}
}

try {
	process.exitCode = await run(process.argv[2], process.argv.slice(3));
} catch (thrown) {
	const error = asUsage(thrown);
	if (error instanceof UsageError) {
		console.error(`${error.message}\n\n${USAGE}`);
		process.exitCode = 2;
	} else {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
