import { randomBytes } from 'node:crypto';
import { checkBackupUser, parsePasswordArgs, targetFor } from './backupCore.ts';
import { copyToClipboard, findClipboard } from './clipboard.ts';
import type { Config } from './config.ts';
import { parseDBURL } from './db.ts';
import { scramVerifier } from './scram.ts';

/**
 * `supabase-backup password --ref <project-ref> --host <session-pooler-host>`: gives `backup_reader` a new random
 * password without the plaintext ever reaching a file, the terminal, the database, or an agent.
 *
 * - Copies `BACKUP_DB_URL` (with the password) to the clipboard, for pasting into the GitHub secret. It writes no
 *   file: the backup runs on GitHub, so nothing local needs the URL.
 * - Prints only where to paste it and the `alter role` statement to run in the project's SQL Editor. The statement
 *   carries a SCRAM verifier, from which the password can't practically be recovered (32 random bytes).
 *
 * Run by the user only. Running it again rotates the password: the old one stops working once the statement runs.
 */
export function runPassword(config: Config, argv: string[]): void {
	const args = parsePasswordArgs(argv);
	const target = targetFor(config, args.ref);
	if (!target) {
		throw new Error(
			`--ref must be production (${config.production.ref}) or dev (${config.dev.ref})`
		);
	}
	// Before generating anything, so a machine without a clipboard tool changes nothing.
	const clipboard = findClipboard();

	const password = randomBytes(32).toString('base64url');
	const url = `postgresql://backup_reader.${args.ref}:${password}@${args.host}:5432/postgres`;
	// The backup's own checks, so a URL it would refuse is never handed out.
	checkBackupUser(config, parseDBURL(url, 'BACKUP_DB_URL'), target);
	copyToClipboard(clipboard, url);

	console.log(`The new BACKUP_DB_URL for ${target} is on the clipboard. Paste it into GitHub:`);
	console.log(`  environment backup-${target}, secret BACKUP_DB_URL.\n`);
	if (process.platform === 'win32') {
		console.log(
			'Windows clipboard history (Win+V) keeps a copy, and if Settings > System > Clipboard > "Sync across your devices" is on,'
		);
		console.log("Microsoft's cloud does too. After pasting, clear it: Win+V > Clear all.\n");
	}
	console.log(
		`The backup fails until this runs. Then run it in the SQL Editor of project ${args.ref}:\n`
	);
	console.log(
		`alter role backup_reader with login password '${scramVerifier(password, randomBytes(16))}';\n`
	);
}
