import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
	authColumnPlan,
	authContentDiff,
	authInsertSQL,
	checkAuthArchive,
	checkBackupUser,
	checkKeyPrefix,
	checkManifest,
	checkRestoreTarget,
	checkToolVersion,
	compareManifest,
	dailyTooOld,
	dailyTooSmall,
	etagOf,
	matchesADaily,
	migrationHash,
	missingTableData,
	populatedMatviews,
	monthlyMissing,
	monthlyUnmatched,
	NO_DAILIES,
	normalizeIdentity,
	objectKeys,
	parseLosslessJSON,
	parseBackupTarget,
	parsePasswordArgs,
	parseRestoreArgs,
	RESERVED_SCHEMAS,
	required,
	s3apiArgs,
	schemaNameProblem,
	sequenceFailures,
	sortedNames,
	targetFor,
	toolVersion,
	watchdogFailures,
	type DatabaseState,
	type R2Object
} from './backupCore.ts';
import type { Manifest } from './backupCore.ts';
import type { Config } from './config.ts';

const POOLER = 'aws-0-us-east-1.pooler.supabase.com';
const SCRATCH_REF = 'abcdefghijklmnopqrst';
const PRODUCTION_REF = 'prodprodprodprodprod';
const DEV_REF = 'devdevdevdevdevdevde';
const CONFIG: Config = {
	production: { ref: PRODUCTION_REF, name: 'Production' },
	dev: { ref: DEV_REF, name: 'Dev' }
};

test('parseBackupTarget accepts production and dev only', () => {
	assert.equal(parseBackupTarget('production'), 'production');
	assert.equal(parseBackupTarget('dev'), 'dev');
	assert.throws(() => parseBackupTarget('Production'), /must be production or dev/);
	assert.throws(() => parseBackupTarget(undefined), /got nothing/);
});

const SESSION = { port: 5432 };

test('checkBackupUser requires the target project backup_reader through the pooler', () => {
	checkBackupUser(
		CONFIG,
		{ user: `backup_reader.${PRODUCTION_REF}`, host: POOLER, config: SESSION },
		'production'
	);
	checkBackupUser(
		CONFIG,
		{ user: `backup_reader.${DEV_REF}`, host: POOLER, config: SESSION },
		'dev'
	);
	assert.throws(
		() =>
			checkBackupUser(
				CONFIG,
				{ user: `backup_reader.${DEV_REF}`, host: POOLER, config: SESSION },
				'production'
			),
		/must be backup_reader\.prodprodprodprodprod/
	);
	assert.throws(
		() =>
			checkBackupUser(
				CONFIG,
				{ user: `backup_reader.${PRODUCTION_REF}`, host: POOLER, config: SESSION },
				'dev'
			),
		/must be backup_reader\.devdevdevdevdevdevde/
	);
	assert.throws(
		() =>
			checkBackupUser(
				CONFIG,
				{ user: `postgres.${PRODUCTION_REF}`, host: POOLER, config: SESSION },
				'production'
			),
		/got postgres\./
	);
	assert.throws(
		() =>
			checkBackupUser(
				CONFIG,
				{
					user: `backup_reader.${PRODUCTION_REF}`,
					host: `db.${PRODUCTION_REF}.supabase.co`,
					config: SESSION
				},
				'production'
			),
		/Supabase pooler/
	);
	assert.throws(
		() =>
			checkBackupUser(
				CONFIG,
				{ user: `backup_reader.${PRODUCTION_REF}`, host: POOLER, config: { port: 6543 } },
				'production'
			),
		/session pooler, port 5432/
	);
});

test('checkRestoreTarget refuses production, dev, and any user but the target postgres, and the transaction pooler', () => {
	checkRestoreTarget(CONFIG, { user: `postgres.${SCRATCH_REF}`, config: SESSION }, SCRATCH_REF);
	for (const ref of [PRODUCTION_REF, DEV_REF]) {
		assert.throws(
			() => checkRestoreTarget(CONFIG, { user: `postgres.${ref}`, config: SESSION }, ref),
			/never into an existing one/
		);
	}
	assert.throws(
		() =>
			checkRestoreTarget(
				CONFIG,
				{ user: `backup_reader.${SCRATCH_REF}`, config: SESSION },
				SCRATCH_REF
			),
		/must be postgres\.abcdefghijklmnopqrst/
	);
	assert.throws(
		() => checkRestoreTarget(CONFIG, { user: `postgres.${DEV_REF}`, config: SESSION }, SCRATCH_REF),
		/got postgres\.devd/
	);
	assert.throws(
		() =>
			checkRestoreTarget(
				CONFIG,
				{ user: `postgres.${SCRATCH_REF}`, config: { port: 6543 } },
				SCRATCH_REF
			),
		/session pooler, port 5432/
	);
});

test('objectKeys are UTC and sort chronologically, across month and year boundaries', () => {
	assert.deepEqual(objectKeys('production', new Date('2026-12-31T23:59:59.999Z')), {
		daily: 'production/daily/2026-12-31T23-59-59Z.tar.age',
		monthly: 'production/monthly/2026-12.tar.age',
		month: '2026-12'
	});
	assert.deepEqual(objectKeys('production', new Date('2027-01-01T00:00:00.000Z')), {
		daily: 'production/daily/2027-01-01T00-00-00Z.tar.age',
		monthly: 'production/monthly/2027-01.tar.age',
		month: '2027-01'
	});
	assert.deepEqual(
		objectKeys('production', new Date('2026-10-31T23:30:00-04:00')).monthly,
		'production/monthly/2026-11.tar.age'
	);
	assert.deepEqual(objectKeys('dev', new Date('2026-10-30T07:17:03Z')), {
		daily: 'dev/2026-10-30T07-17-03Z.tar.age',
		month: '2026-10'
	});
	const keys = [
		'2026-09-30T23:59:59Z',
		'2026-10-01T00:00:00Z',
		'2026-10-01T09:00:00Z',
		'2027-01-01T00:00:00Z'
	].map((t) => objectKeys('production', new Date(t)).daily);
	assert.deepEqual([...keys].sort(), keys);
});

test('checkKeyPrefix keeps every key under its target', () => {
	checkKeyPrefix(objectKeys('production', new Date()), 'production');
	checkKeyPrefix(objectKeys('dev', new Date()), 'dev');
	assert.throws(
		() => checkKeyPrefix(objectKeys('production', new Date()), 'dev'),
		/isn't under dev\//
	);
	assert.throws(
		() =>
			checkKeyPrefix({ daily: 'dev/x.tar.age', monthly: 'production/monthly/x.tar.age' }, 'dev'),
		/production\/monthly/
	);
});

test('migrationHash matches the stored statements and the file whenever only whitespace differs', () => {
	const file =
		'create table a (id int);\n\n-- no comments in the stored form\ncreate index on a (id);\n';
	assert.notEqual(
		migrationHash(file),
		migrationHash(['create table a (id int)', 'create index on a (id)'].join(';'))
	);
	const plain = 'create table a (id int);\n\ncreate index on a (id);\n';
	assert.equal(
		migrationHash(plain),
		migrationHash(['create table a (id int)', 'create index on a (id)'].join(';'))
	);
	assert.notEqual(
		migrationHash(plain),
		migrationHash('create table a (id bigint);create index on a (id)')
	);
});

test('missingTableData finds tables and sequences pg_restore --list has no data for', () => {
	const list = [
		';',
		'; Archive created at 2026-10-30 07:17:05 UTC',
		'4120; 1259 17001 TABLE ledger account postgres',
		'4300; 0 17001 TABLE DATA ledger account postgres',
		'4301; 0 17002 TABLE DATA history row_history postgres',
		'4400; 0 0 SEQUENCE SET ledger account_account_id_seq postgres'
	].join('\r\n');
	const manifest = {
		tables: [
			{ name: 'ledger.account', rows: 1, hash: 'x' },
			{ name: 'history.row_history', rows: 1, hash: 'x' },
			{ name: 'sync.sync_run', rows: 1, hash: 'x' }
		],
		sequences: ['ledger.account_account_id_seq', 'sync.sync_run_sync_run_id_seq']
	};
	assert.deepEqual(missingTableData(manifest, list), {
		tables: ['sync.sync_run'],
		sequences: ['sync.sync_run_sync_run_id_seq']
	});
	assert.deepEqual(missingTableData({ tables: [], sequences: [] }, list), {
		tables: [],
		sequences: []
	});
});

const state = (): DatabaseState => ({
	tables: [
		{ name: 'ledger.account', rows: 2, hash: 'a' },
		{ name: 'sync.sync_run', rows: 1, hash: 'b' }
	],
	auth: { users: { rows: 1 }, identities: { rows: 1 } },
	policies: 30,
	rlsDisabledTables: []
});

test('compareManifest reports every kind of difference, and nothing for equal states', () => {
	assert.deepEqual(compareManifest(state(), state()), []);
	const actual = state();
	actual.tables[0]!.rows = 3;
	actual.tables[1]!.hash = 'changed';
	actual.tables.push({ name: 'ledger.extra', rows: 0, hash: 'c' });
	actual.auth.users.rows = 0;
	actual.auth.identities.rows = 2;
	actual.policies = 29;
	actual.rlsDisabledTables = ['ledger.account'];
	assert.deepEqual(compareManifest(state(), actual), [
		'ledger.account: 3 rows, expected 2',
		'sync.sync_run: content differs',
		'ledger.extra: not in the backup',
		'auth.users: 0 rows, expected 1',
		'auth.identities: 2 rows, expected 1',
		'policies: 29, expected 30',
		'tables without RLS: ledger.account, expected none'
	]);
	const missing = state();
	missing.tables.pop();
	assert.deepEqual(compareManifest(state(), missing), ['sync.sync_run: missing']);
	const reordered = state();
	reordered.rlsDisabledTables = ['b', 'a'];
	assert.deepEqual(compareManifest({ ...state(), rlsDisabledTables: ['a', 'b'] }, reordered), []);
});

test('authColumnPlan inserts the shared columns in target order and reports the rest', () => {
	// confirmed_at is generated in the target, so it's neither inserted nor reported; new_col is newer than the backup.
	assert.deepEqual(
		authColumnPlan(
			'users',
			['id', 'email', 'confirmed_at', 'old_col', 'raw_app_meta_data'],
			['raw_app_meta_data', 'id', 'email', 'new_col'],
			['confirmed_at']
		),
		{
			insert: ['raw_app_meta_data', 'id', 'email'],
			onlyInTarget: ['new_col'],
			missingInTarget: ['old_col']
		}
	);
	assert.throws(() => authColumnPlan('users', ['id'], ['id', 'email'], []), /auth\.users .* email/);
	assert.throws(
		() =>
			authColumnPlan(
				'identities',
				['id', 'user_id', 'provider', 'provider_id'],
				['id', 'user_id', 'provider'],
				[]
			),
		/auth\.identities .* provider_id/
	);
	assert.deepEqual(
		authColumnPlan('identities', [], ['id', 'user_id', 'provider', 'provider_id'], []),
		{
			insert: [],
			onlyInTarget: [],
			missingInTarget: []
		}
	);
});

test('authContentDiff finds changed, missing, and extra rows, independent of key order', () => {
	const archive = [
		{
			id: 'u1',
			email: 'a@example.com',
			identity_data: { sub: '1', email: 'a@example.com' },
			skipped: 1
		},
		{ id: 'u2', email: 'b@example.com', identity_data: { sub: '2' } },
		{ id: 'u3', email: 'c@example.com', identity_data: null }
	];
	const columns = ['id', 'email', 'identity_data'];
	const reordered = archive.map((r) => ({
		identity_data: r.identity_data && Object.fromEntries(Object.entries(r.identity_data).reverse()),
		email: r.email,
		id: r.id,
		skipped: 2
	}));
	assert.deepEqual(authContentDiff(archive, reordered, columns), []);
	const target = [
		{ ...reordered[0]!, identity_data: { sub: '1', email: 'changed@example.com' } },
		reordered[2]!,
		{ id: 'u4', email: 'd@example.com', identity_data: null }
	];
	assert.deepEqual(authContentDiff(archive, target, columns), ['u1', 'u2', 'u4']);
});

test('parseLosslessJSON keeps jsonb numbers exact through stringify, the insert, and the comparison', () => {
	const source =
		'[{"id":"u1","raw_user_meta_data":{"provider_id":1234567890123456789,"rate":1.10,"n":[2.50,-0]}}]';
	const rows = parseLosslessJSON(source) as Record<string, unknown>[];
	assert.equal(JSON.stringify(rows), source);
	assert.ok(authInsertSQL('users', ['id'], rows, 'sb_0123456789abcdef').includes(source));
	const columns = ['id', 'raw_user_meta_data'];
	const rounded = parseLosslessJSON(source.replace('1.10', '1.1')) as Record<string, unknown>[];
	assert.deepEqual(authContentDiff(rows, rounded, columns), ['u1']);
	assert.deepEqual(authContentDiff(rows, parseLosslessJSON(source) as typeof rows, columns), []);
});

test('sequenceFailures flags only a sequence that would hand out an existing id', () => {
	const rows = [
		{ seq: 'ledger.a_seq', lastValue: 1n, isCalled: false, furthestId: null },
		{ seq: 'ledger.b_seq', lastValue: 6n, isCalled: false, furthestId: 5n },
		{ seq: 'ledger.c_seq', lastValue: 5n, isCalled: true, furthestId: 5n },
		{ seq: 'ledger.d_seq', lastValue: 5n, isCalled: false, furthestId: 5n },
		{ seq: 'ledger.e_seq', lastValue: 4n, isCalled: true, furthestId: 5n },
		{ seq: 'ledger.f_seq', lastValue: -6n, isCalled: false, furthestId: -5n, descending: true },
		{ seq: 'ledger.g_seq', lastValue: -5n, isCalled: true, furthestId: -5n, descending: true },
		{ seq: 'ledger.h_seq', lastValue: -4n, isCalled: true, furthestId: -5n, descending: true }
	].map((r) => ({ descending: false, ...r }));
	assert.deepEqual(
		sequenceFailures(rows).map((f) => f.split(':')[0]),
		['ledger.d_seq', 'ledger.e_seq', 'ledger.h_seq']
	);
	assert.match(sequenceFailures(rows)[2]!, /\(min -5\)$/);
});

test('authInsertSQL quotes columns, dollar-quotes the rows, and refuses a colliding or malformed tag', () => {
	const tag = 'sb_0123456789abcdef';
	assert.equal(
		authInsertSQL('users', ['id', 'we"ird'], [{ id: 'u1', 'we"ird': "it's" }], tag),
		`insert into auth.users ("id", "we""ird") select "id", "we""ird" from jsonb_populate_recordset(null::auth.users, $${tag}$[{"id":"u1","we\\"ird":"it's"}]$${tag}$::jsonb);\n`
	);
	assert.throws(
		() => authInsertSQL('users', ['id'], [{ id: `x$${tag}$y` }], tag),
		/contain the dollar-quote tag/
	);
	assert.throws(() => authInsertSQL('users', ['id'], [], 'sb_x$'), /invalid dollar-quote tag/);
});

test('normalizeIdentity reads the key line through BOMs, UTF-16, and CRLF', () => {
	// A dummy, built at runtime so no key-shaped string sits in the repo for secret scanners to flag.
	const key = `AGE-SECRET-KEY-1${'Q'.repeat(58)}`;
	const file = `# created: 2026-10-30T12:00:00-04:00\r\n# public key: age1example\r\n${key}\r\n`;
	assert.equal(normalizeIdentity(Buffer.from(file)), key);
	assert.equal(normalizeIdentity(Buffer.from(`﻿${key}\r\n`)), key);
	assert.equal(
		normalizeIdentity(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(file, 'utf16le')])),
		key
	);
	assert.equal(
		normalizeIdentity(
			Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(file, 'utf16le').swap16()])
		),
		key
	);
	assert.equal(
		normalizeIdentity(
			Buffer.concat([
				Buffer.from([0xfe, 0xff]),
				Buffer.from(file, 'utf16le').swap16(),
				Buffer.from([0x0a])
			])
		),
		key
	);
	assert.equal(normalizeIdentity(Buffer.from(`  ${key}  `)), key);
	for (const bad of ['', key.slice(0, -1).toLowerCase(), `${key}\n${key}`]) {
		assert.throws(() => normalizeIdentity(Buffer.from(bad)), /must contain one AGE-SECRET-KEY-1/);
	}
});

const NOW = new Date('2026-10-15T13:43:00Z');
const hoursBefore = (hours: number, from = NOW) => new Date(from.getTime() - hours * 3_600_000);
const object = (key: string, lastModified: Date, etag = 'e0', size = 50_000): R2Object => ({
	key,
	lastModified,
	size,
	etag
});
/** A healthy October: a daily from this morning, this month's and last month's monthlies matching their dailies. */
const healthy = (): R2Object[] => [
	object('production/daily/2026-09-30T07-17-00Z.tar.age', new Date('2026-09-30T07:17:30Z'), 'sep'),
	object('production/monthly/2026-09.tar.age', new Date('2026-09-01T07:17:40Z'), 'sep-first'),
	object(
		'production/daily/2026-09-01T07-17-00Z.tar.age',
		new Date('2026-09-01T07:17:30Z'),
		'sep-first'
	),
	object('production/daily/2026-10-01T07-17-00Z.tar.age', new Date('2026-10-01T07:17:30Z'), 'oct'),
	object('production/monthly/2026-10.tar.age', new Date('2026-10-01T07:17:40Z'), 'oct'),
	object('production/daily/2026-10-15T07-17-00Z.tar.age', hoursBefore(6.4), 'today')
];

test('watchdog: a healthy listing passes, and a lock-test file is ignored', () => {
	assert.deepEqual(watchdogFailures(healthy(), NOW), []);
	const withLockTest = [
		...healthy(),
		object('production/monthly/lock-test.txt', new Date('2026-08-01T00:00:00Z'), 'x', 5)
	];
	assert.deepEqual(watchdogFailures(withLockTest, NOW), []);
});

test('watchdog: the newest daily may be up to 72 hours old', () => {
	for (const hours of [6.4, 30, 54, 71.9]) {
		const objects = healthy().filter((o) => !o.key.includes('2026-10-15'));
		objects.push(object('production/daily/x.tar.age', hoursBefore(hours), 'x'));
		assert.deepEqual(watchdogFailures(objects, NOW), [], `${hours} hours`);
	}
	for (const hours of [72.1, 78]) {
		const objects = healthy().filter((o) => !o.key.includes('2026-10-15'));
		objects.push(object('production/daily/x.tar.age', hoursBefore(hours), 'x'));
		assert.deepEqual(
			watchdogFailures(objects, NOW),
			[dailyTooOld(hours.toFixed(1))],
			`${hours} hours`
		);
	}
	assert.equal(dailyTooOld('72.1'), 'newest daily is 72.1 hours old (limit 72)');
});

test('watchdog: an empty listing, a listing with no dailies, and a tiny daily fail', () => {
	assert.deepEqual(watchdogFailures([], NOW), [NO_DAILIES, monthlyMissing('2026-10')]);
	assert.equal(NO_DAILIES, 'no production daily backups');
	const tiny = healthy();
	tiny[5]!.size = 1023;
	assert.deepEqual(watchdogFailures(tiny, NOW), [dailyTooSmall(1023)]);
	assert.equal(dailyTooSmall(1023), 'newest daily is 1023 bytes (minimum 1024)');
});

test("watchdog: this month's monthly is required from its first daily, or from the 3rd", () => {
	const september = healthy().filter((o) => o.key.includes('2026-09'));
	for (const now of [new Date('2026-10-01T13:43:00Z'), new Date('2026-10-02T13:43:00Z')]) {
		assert.deepEqual(
			watchdogFailures(september, now),
			[],
			`${now.toISOString()} with no daily yet this month`
		);
	}
	const day1 = [
		...september,
		object('production/daily/2026-10-01T07-17-00Z.tar.age', new Date('2026-10-01T07:17:30Z'), 'oct')
	];
	assert.deepEqual(watchdogFailures(day1, new Date('2026-10-01T13:43:00Z')), [
		monthlyMissing('2026-10')
	]);
	assert.equal(monthlyMissing('2026-10'), 'monthly 2026-10 missing');
	// A run that started before midnight wrote September's monthly, though its daily landed in October.
	const lateSeptember = [
		...september,
		object(
			'production/daily/2026-09-30T23-58-00Z.tar.age',
			new Date('2026-10-01T00:04:00Z'),
			'late'
		)
	];
	assert.deepEqual(watchdogFailures(lateSeptember, new Date('2026-10-01T13:43:00Z')), []);
	const day3 = new Date('2026-10-03T13:43:00Z');
	assert.deepEqual(watchdogFailures(september, day3), [
		dailyTooOld('78.4'),
		monthlyMissing('2026-10')
	]);
});

test("watchdog: last month's monthly is required once backups predate this month", () => {
	const noSeptemberMonthly = healthy().filter(
		(o) => o.key !== 'production/monthly/2026-09.tar.age'
	);
	assert.deepEqual(watchdogFailures(noSeptemberMonthly, NOW), [monthlyMissing('2026-09')]);
	const firstMonth = healthy().filter((o) => o.key.includes('2026-10'));
	assert.deepEqual(watchdogFailures(firstMonth, NOW), []);
	// A September-keyed daily uploaded after midnight still predates October, by key.
	const lateUpload = { ...firstMonth[0]!, key: 'production/daily/2026-09-30T23-58-00Z.tar.age' };
	lateUpload.lastModified = new Date('2026-10-01T00:04:00Z');
	assert.deepEqual(watchdogFailures([...firstMonth, lateUpload], NOW), [monthlyMissing('2026-09')]);
});

test("watchdog: a monthly must match a daily from its month, while that month's dailies are kept", () => {
	const planted = healthy();
	planted[4]!.etag = 'planted';
	assert.deepEqual(watchdogFailures(planted, NOW), [monthlyUnmatched('2026-10')]);
	assert.equal(monthlyUnmatched('2026-10'), 'monthly 2026-10 matches no daily from that month');
	// Its dailies expired: nothing to match against.
	const old = [
		object('production/monthly/2026-01.tar.age', new Date('2026-01-01T07:17:40Z'), 'gone'),
		...healthy()
	];
	assert.deepEqual(watchdogFailures(old, NOW), []);
	// Its source daily expired but later dailies from that month remain: they never match, so nothing is checked.
	const sourceExpired = healthy().filter((o) => !o.key.includes('daily/2026-09-01'));
	assert.deepEqual(watchdogFailures(sourceExpired, NOW), []);
	// A source-era daily that doesn't match is still caught.
	const septemberPlanted = healthy();
	septemberPlanted[1]!.etag = 'planted';
	assert.deepEqual(watchdogFailures(septemberPlanted, NOW), [monthlyUnmatched('2026-09')]);
});

test('toolVersion reads the major and minor of a PostgreSQL client tool', () => {
	assert.deepEqual(toolVersion('pg_dump (PostgreSQL) 17.6 (Ubuntu 17.6-1.pgdg24.04+1)'), {
		version: '17.6',
		major: 17,
		minor: 6
	});
	assert.deepEqual(toolVersion('psql (PostgreSQL) 17.10'), {
		version: '17.10',
		major: 17,
		minor: 10
	});
	assert.equal(toolVersion('age v1.2.1'), null);
});

test('checkToolVersion requires 17 at or past the minimum minor', () => {
	assert.equal(checkToolVersion('pg_dump', 'pg_dump (PostgreSQL) 17.0', 0).version, '17.0');
	assert.equal(checkToolVersion('psql', 'psql (PostgreSQL) 17.10', 6).minor, 10);
	assert.throws(
		() => checkToolVersion('psql', 'psql (PostgreSQL) 17.5', 6),
		/17\.6 or later 17\.x; got 17\.5/
	);
	assert.throws(() => checkToolVersion('pg_dump', 'pg_dump (PostgreSQL) 18.0', 0), /got 18\.0/);
	assert.throws(() => checkToolVersion('pg_dump', 'not a version', 0), /got unknown/);
});

const MANIFEST_V1 = JSON.parse(
	readFileSync(new URL('fixtures/manifest-v1.json', import.meta.url), 'utf8')
) as Record<string, unknown>;
const MANIFEST_V2 = {
	...MANIFEST_V1,
	formatVersion: 2,
	schemas: ['app', 'app_history'],
	tool: { name: 'supabase-backup', commit: null }
};

test('checkManifest reads a format 1 manifest, deriving its schemas from the tables and sequences', () => {
	const checked = checkManifest(MANIFEST_V1);
	assert.deepEqual(checked.schemas, ['app', 'app_history']);
	assert.deepEqual({ ...checked, schemas: undefined }, { ...MANIFEST_V1, schemas: undefined });
	assert.throws(
		() => checkManifest({ ...MANIFEST_V1, tables: [{ name: 'public.x', rows: 0, hash: 'h' }] }),
		/public is reserved/
	);
	assert.throws(
		() => checkManifest({ ...MANIFEST_V1, sequences: ['noschema'] }),
		/"noschema", which isn't schema\.name/
	);
	for (const name of ['app.a b', 'app.a.b', 'app.']) {
		assert.throws(
			() => checkManifest({ ...MANIFEST_V1, sequences: [name] }),
			/which isn't schema\.name/
		);
	}
});

test('checkManifest reads a format 2 manifest, whose schemas must cover its tables and sequences', () => {
	assert.deepEqual(checkManifest(MANIFEST_V2), MANIFEST_V2);
	assert.deepEqual(checkManifest({ ...MANIFEST_V2, schemas: ['app_history', 'app'] }), MANIFEST_V2);
	// A listed schema may hold nothing yet.
	assert.deepEqual(
		checkManifest({ ...MANIFEST_V2, schemas: ['app', 'app_history', 'empty'] }).schemas,
		['app', 'app_history', 'empty']
	);
	assert.throws(
		() => checkManifest({ ...MANIFEST_V2, schemas: ['app'] }),
		/outside its schemas: app_history/
	);
	assert.throws(
		() => checkManifest({ ...MANIFEST_V2, schemas: ['app', 'app', 'app_history'] }),
		/schemas repeat/
	);
	assert.throws(
		() => checkManifest({ ...MANIFEST_V2, schemas: undefined }),
		/schemas aren't a list/
	);
	for (const bad of ['App', 'a-b', 'auth', 'pg_temp']) {
		assert.throws(
			() => checkManifest({ ...MANIFEST_V2, schemas: ['app', 'app_history', bad] }),
			/the manifest's schemas:/
		);
	}
	assert.throws(
		() => checkManifest({ ...MANIFEST_V2, schemas: [], tables: [], sequences: [] }),
		/names no schemas/
	);
	const commit = 'a'.repeat(40);
	assert.equal(
		checkManifest({ ...MANIFEST_V2, tool: { name: 'supabase-backup', commit } }).tool?.commit,
		commit
	);
	for (const tool of [
		undefined,
		{ name: 'other', commit: null },
		{ name: 'supabase-backup', commit: 'main' },
		{ name: 'supabase-backup' }
	]) {
		assert.throws(() => checkManifest({ ...MANIFEST_V2, tool }), /tool isn't supabase-backup/);
	}
});

test('checkManifest requires auth row counts and plain column lists', () => {
	const auth = MANIFEST_V1.auth as Manifest['auth'];
	for (const bad of [
		undefined,
		{ ...auth, identities: undefined },
		{ ...auth, users: { rows: 1 } },
		{ ...auth, users: { rows: '1', columns: [] } }
	]) {
		assert.throws(() => checkManifest({ ...MANIFEST_V2, auth: bad }), /needs rows and a columns/);
	}
	assert.throws(
		() =>
			checkManifest({
				...MANIFEST_V2,
				auth: { ...auth, users: { rows: 0, columns: ['id', 'x"; drop'] } }
			}),
		/columns aren't plain/
	);
});

test('checkManifest accepts only plain migrations and exactly the two backed-up files', () => {
	const good = MANIFEST_V2;
	const dotted = {
		...good,
		migrations: [
			{ version: '20261031034437', name: 'add_v1.2-fields', hash: 'f'.repeat(64), statements: [] }
		]
	};
	assert.deepEqual(checkManifest(dotted), dotted);
	assert.throws(() => checkManifest({ ...good, formatVersion: 3 }), /formatVersion 3/);
	assert.throws(() => checkManifest(null), /formatVersion undefined/);
	assert.throws(
		() => checkManifest({ ...good, tables: undefined }),
		/tables and sequences aren't lists/
	);
	for (const migration of [
		{ version: '20261031034437', name: '../../x' },
		{ version: '../x', name: 'a' },
		{ version: '2026', name: 'a' }
	]) {
		assert.throws(() => checkManifest({ ...good, migrations: [migration] }), /plain version_name/);
	}
	assert.throws(() => checkManifest({ ...good, migrations: [null] }), /plain version_name/);
	for (const migrations of [undefined, {}, 'x']) {
		assert.throws(() => checkManifest({ ...good, migrations }), /migrations aren't a list/);
	}
	assert.throws(
		() => checkManifest({ ...good, files: { 'app.dump': {}, '../auth.json': {} } }),
		/exactly app\.dump and auth\.json/
	);
	assert.throws(() => checkManifest({ ...good, files: { 'app.dump': {} } }), /got app\.dump$/);
	const files = MANIFEST_V1.files as Manifest['files'];
	for (const entry of [
		null,
		{ bytes: 1 },
		{ bytes: '1', sha256: files['app.dump'].sha256 },
		{ bytes: 1, sha256: 'x' }
	]) {
		assert.throws(
			() => checkManifest({ ...good, files: { ...files, 'app.dump': entry } }),
			/app\.dump needs bytes and a SHA-256/
		);
	}
});

test('checkManifest refuses malformed fields the restore reads', () => {
	const good = MANIFEST_V2;
	assert.equal(checkManifest({ ...good, gitCommit: 'b'.repeat(40) }).gitCommit, 'b'.repeat(40));
	const migration = { version: '20261031034437', name: 'a', hash: 'f'.repeat(64), statements: [] };
	const table = { name: 'app.t', rows: 1, hash: '0'.repeat(32) };
	for (const [change, message] of [
		[{ migrations: [{ ...migration, hash: 'h' }] }, /SHA-256 hash and a statements list/],
		[{ migrations: [{ ...migration, statements: undefined }] }, /SHA-256 hash and a statements/],
		[{ tables: [{ ...table, rows: '1' }] }, /integer rows and an MD5 hash/],
		[{ tables: [{ ...table, hash: 'x' }] }, /integer rows and an MD5 hash/],
		[{ policies: undefined }, /policies count/],
		[{ rlsDisabledTables: null }, /rlsDisabledTables list/],
		[{ rlsDisabledTables: [1] }, /rlsDisabledTables aren't all names/],
		[{ tables: [table, table] }, /tables or sequences repeat/],
		[{ target: 'staging' }, /target and ref aren't a project/],
		[{ ref: 'abc' }, /target and ref aren't a project/],
		[{ pgDumpVersion: undefined }, /pgDumpVersion isn't a version/],
		[{ serverVersion: undefined }, /serverVersion isn't a version/],
		[{ serverVersion: '17.6; drop' }, /serverVersion isn't a version/],
		[{ createdAt: 'yesterday' }, /createdAt isn't a time/],
		[{ gitCommit: 'main && curl' }, /gitCommit isn't a commit/]
	] as const) {
		assert.throws(() => checkManifest({ ...good, ...change }), message);
	}
});

test('checkAuthArchive accepts row lists the manifest counted and refuses anything else', () => {
	const manifest = {
		auth: { users: { rows: 1, columns: ['id'] }, identities: { rows: 0, columns: [] } }
	};
	const good = { users: [{ id: 'u1' }], identities: [] };
	assert.deepEqual(checkAuthArchive(good, manifest), good);
	for (const [archive, message] of [
		[null, /users isn't a list of rows/],
		[{ users: [{ id: 'u1' }] }, /identities isn't a list of rows/],
		[{ ...good, users: ['u1'] }, /users isn't a list of rows/],
		[{ ...good, users: [] }, /0 users rows; the manifest counted 1/]
	] as const) {
		assert.throws(() => checkAuthArchive(archive, manifest), message);
	}
});

test('populatedMatviews lists the populated views in archive order, quoted', () => {
	const list = [
		'3456; 0 16789 TABLE DATA app account postgres',
		'3457; 0 16790 MATERIALIZED VIEW DATA app totals postgres',
		';3458; 0 16791 MATERIALIZED VIEW DATA app skipped postgres',
		'3459; 0 16792 MATERIALIZED VIEW DATA app_history Daily postgres'
	].join('\r\n');
	assert.deepEqual(populatedMatviews(list), ['"app"."totals"', '"app_history"."Daily"']);
	assert.deepEqual(populatedMatviews(''), []);
});

test('schemaNameProblem allows plain lowercase names that are not reserved', () => {
	for (const name of ['app', 'app_history', '_x', 'a1'])
		assert.equal(schemaNameProblem(name), null);
	for (const name of ['App', '1a', 'a-b', 'a.b', '', 'a b', 'x"y', 3, null]) {
		assert.match(schemaNameProblem(name) ?? '', /isn't a plain lowercase schema name/);
	}
	for (const name of [...RESERVED_SCHEMAS, 'pg_catalog', 'pg_toast', 'pg_whatever']) {
		assert.match(schemaNameProblem(name) ?? '', /is reserved/);
	}
});

test('sortedNames sorts like collate "C" and leaves its input alone', () => {
	const names = ['zeta', 'app_history', 'app', '_z', 'a1'];
	assert.deepEqual(sortedNames(names), ['_z', 'a1', 'app', 'app_history', 'zeta']);
	assert.deepEqual(names, ['zeta', 'app_history', 'app', '_z', 'a1']);
});

test('required trims and names the missing variable', () => {
	assert.equal(required({ A: ' x ' }, 'A'), 'x');
	assert.throws(() => required({ A: '  ' }, 'A'), /^Error: A is required$/);
	assert.throws(() => required({}, 'B'), /B is required/);
});

test('s3apiArgs targets the bucket with JSON output and timeouts', () => {
	const args = s3apiArgs({ endpoint: 'https://e', bucket: 'b' }, ['head-object', '--key', 'k']);
	assert.deepEqual(args.slice(0, 4), ['s3api', 'head-object', '--key', 'k']);
	assert.equal(args[args.indexOf('--endpoint-url') + 1], 'https://e');
	assert.equal(args[args.indexOf('--bucket') + 1], 'b');
	assert.equal(args[args.indexOf('--output') + 1], 'json');
	assert.ok(args.includes('--cli-read-timeout') && args.includes('--cli-connect-timeout'));
});

test('targetFor maps only the production and dev refs', () => {
	assert.equal(targetFor(CONFIG, PRODUCTION_REF), 'production');
	assert.equal(targetFor(CONFIG, DEV_REF), 'dev');
	assert.equal(targetFor(CONFIG, SCRATCH_REF), undefined);
});

test('matchesADaily compares unquoted ETags of dailies from that month only', () => {
	const dailies = [
		{ key: 'production/daily/2026-10-01T07-17-00Z.tar.age', etag: etagOf('"abc"') },
		{ key: 'production/daily/2026-09-30T07-17-00Z.tar.age', etag: 'old' }
	];
	assert.ok(matchesADaily('2026-10', 'abc', dailies));
	assert.ok(!matchesADaily('2026-10', 'old', dailies));
	assert.ok(!matchesADaily('2026-10', '"abc"', dailies));
});

test('parseRestoreArgs and parsePasswordArgs take exactly their flags', () => {
	assert.deepEqual(
		parseRestoreArgs(['--backup', 'b.tar.age', '--identity', 'k.txt', '--target-ref', SCRATCH_REF]),
		{
			backup: 'b.tar.age',
			identity: 'k.txt',
			targetRef: SCRATCH_REF
		}
	);
	assert.throws(() => parseRestoreArgs(['--backup', 'b', '--identity', 'k']), /Usage/);
	assert.throws(
		() => parseRestoreArgs(['--backup', 'b', '--identity', 'k', '--target-ref', 'short']),
		/Usage/
	);
	assert.throws(() =>
		parseRestoreArgs(['--backup', 'b', '--identity', 'k', '--target-ref', SCRATCH_REF, 'extra'])
	);
	assert.throws(() =>
		parseRestoreArgs(['--backup', 'b', '--identity', 'k', '--target-ref', SCRATCH_REF, '--force'])
	);
	assert.deepEqual(parsePasswordArgs(['--ref', DEV_REF, '--host', POOLER]), {
		ref: DEV_REF,
		host: POOLER
	});
	assert.throws(
		() => parsePasswordArgs(['--ref', DEV_REF, '--host', `db.${DEV_REF}.supabase.co`]),
		/Usage/
	);
	assert.throws(() => parsePasswordArgs(['--ref', DEV_REF]), /Usage/);
});
