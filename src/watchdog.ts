import {
	etagOf,
	newestDaily,
	objectKeys,
	required,
	s3apiArgs,
	watchdogFailures,
	type R2Object
} from './backupCore.ts';
import { runOrThrow } from './db.ts';

/**
 * The daily watchdog (`supabase-backup watchdog`, run by `.github/workflows/watchdog.yml`): lists the production
 * backups in R2 and fails, so GitHub emails the cron author, when the newest daily is too old or too small or a
 * monthly is missing or matches no daily (rules: `watchdogFailures`). Needs no `supabase-backup.json`: everything it
 * reads is in the environment. Its R2 key is read-only.
 */

/** Prints the status and the verdict; returns whether every rule passed. */
export async function runWatchdog(): Promise<boolean> {
	const r2 = {
		endpoint: required(process.env, 'R2_ENDPOINT'),
		bucket: required(process.env, 'R2_BUCKET')
	};
	const secret = required(process.env, 'AWS_SECRET_ACCESS_KEY');
	const redact = (text: string) => text.replaceAll(secret, '***');
	let stdout: string;
	try {
		// The aws CLI follows list-objects-v2's pagination itself.
		stdout = await runOrThrow(
			'aws',
			s3apiArgs(r2, ['list-objects-v2', '--prefix', 'production/']),
			redact
		);
	} catch (error) {
		throw new Error(
			`listing the bucket failed: ${error instanceof Error ? error.message : String(error)}`
		);
	}
	// An empty listing prints nothing.
	const listed = (stdout.trim() ? JSON.parse(stdout) : {}) as {
		Contents?: { Key: string; LastModified: string; Size: number; ETag: string }[];
	};
	const objects: R2Object[] = (listed.Contents ?? []).map((o) => ({
		key: o.Key,
		lastModified: new Date(o.LastModified),
		size: o.Size,
		etag: etagOf(o.ETag)
	}));
	const now = new Date();
	// Status lines for whoever reads the log; the verdict is `watchdogFailures` alone, which uses the same helpers.
	const newest = newestDaily(objects);
	const monthlyKey = objectKeys('production', now).monthly;
	console.log(
		newest
			? `Newest daily: ${newest.key}, ${((now.getTime() - newest.lastModified.getTime()) / 3_600_000).toFixed(1)} hours old, ${newest.size} bytes`
			: 'No daily backups'
	);
	console.log(`${monthlyKey}: ${objects.some((o) => o.key === monthlyKey) ? 'exists' : 'missing'}`);
	const failures = watchdogFailures(objects, now);
	for (const failure of failures) console.log(`FAIL ${failure}`);
	console.log(failures.length ? `FAIL (${failures.length})` : 'PASS');
	return !failures.length;
}
