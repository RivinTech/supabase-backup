# supabase-backup

Encrypted off-site backups of a Supabase Postgres database, a verified restore into a new project, a daily watchdog,
and a dev test runner. Backups run nightly in GitHub Actions, are encrypted with [age](https://age-encryption.org),
and land in a Cloudflare R2 bucket whose lock rules no token can bypass.

This file is the runbook. Every step is meant to work with nobody else's help: commands are copy-pasteable, and
`<placeholders>` stand for your project's values.

All rights reserved.

- [What it does and doesn't cover](#what-it-does-and-doesnt-cover)
- [Install](#install)
- [Configure](#configure)
- [Setup](#setup)
- [Operations](#operations)
- [Restore procedure](#restore-procedure)
- [Yearly restore drill](#yearly-restore-drill)
- [Adding or removing a schema](#adding-or-removing-a-schema)
- [Updating the package](#updating-the-package)
- [Security model and invariants](#security-model-and-invariants)
- [Development](#development)

## What it does and doesn't cover

**Why you need it.** On Supabase's Free plan there are no backups at all: no dailies, no point-in-time recovery, and
deleting a project deletes everything in it. Pro adds 7 days of dailies, which don't include custom roles'
passwords. With this package, your bucket holds the only long-term copy.

**Backed up**, from one consistent snapshot:

- every schema `backup.schemas()` lists: schema and data (`app.dump`, pg_dump custom format);
- the migration list, with each migration's statements, and every table's row count and content hash
  (`manifest.json`);
- `auth.users` and `auth.identities` as JSON (`auth.json`), read through `backup.auth_rows()`. Password hashes stay
  in, so email users keep their passwords. One-time tokens are blanked to `''`.

**Not backed up:**

- **Storage and Vault.** The backup fails if `storage.objects`, `storage.buckets`, or `vault.secrets` ever holds a
  row, so they can't be lost silently. Extending the backup to them is future work.
- **Large objects** (`lo_create`, `pg_largeobject`). `pg_dump -n` leaves them out, so the backup fails if any exists.
- **Sessions, refresh tokens, MFA factors, and one-time tokens.** Users sign in again after a restore.
- **Role passwords.** Re-set them after a restore.
- **Project settings** (Auth providers, URLs, SSL enforcement). The restore procedure lists them.
- **Tables in `public`.** v1 limitation: `public` may hold only views, which the migrations rebuild. Keep app tables
  in their own schemas.

**Requirements:**

- Postgres 17 (the privilege checks use `MAINTAIN`, and the backup runs `pg_dump` 17, which can't dump a newer server);
- the project's migrations in `<repo>/supabase/migrations`, applied with the Supabase CLI;
- a GitHub repo with **environments** (a repo-secrets-only layout isn't supported);
- a Cloudflare account for R2.

## Install

Run everything in this README from your project's `supabase` folder (the one holding `migrations/`), unless a step
says otherwise.

1. Install the package, pinned to a full commit SHA from this repo's `main` (see
   [Updating the package](#updating-the-package) for how to pick one), and the Supabase CLI:

   ```
   npm install -D git+https://github.com/RivinTech/supabase-backup.git#<sha>
   npm install -D supabase@2.120.0
   ```

   npm may record the package in `package-lock.json` as `git+ssh://git@github.com/...`. That's harmless: it's the
   same commit, and `verify-pins` accepts both forms.

2. Add these scripts to `supabase/package.json`:

   ```json
   "push:dev": "supabase-backup push",
   "test": "supabase-backup test",
   "perf": "supabase-backup perf",
   "backup:password": "supabase-backup password",
   "restore": "supabase-backup restore",
   "verify-pins": "supabase-backup verify-pins"
   ```

3. Never run the tool through `npx`. The package name isn't on the npm registry, and `npx` would download and run
   any unrelated package that claims it. Use the npm scripts, or `npm exec --no -- supabase-backup <command>`, which
   refuses to download anything.

The dev commands (`push`, `test`, `perf`) read `DEV_DB_URL` from `supabase/.env`: the dev project's session pooler
URI, as `postgres`. They refuse any URL that isn't the configured dev project.

## Configure

1. **Name the two projects** (the refs are in each project's dashboard URL):

   ```
   npm exec --no -- supabase-backup init --production-ref <production ref> --production-name "<production name>" --dev-ref <dev ref> --dev-name "<dev name>"
   ```

   This writes `supabase-backup.json`. Commit it. Every command refuses a ref that isn't one of these two (the restore
   refuses both).

2. **Choose the schemas.** List every schema that holds your app's tables, views, and sequences. Not `public`, and
   none of Supabase's own (`auth`, `storage`, `extensions`, …). Every schema `postgres` owns must be either listed or
   one of `backup`, `extensions`, and `supabase_migrations`, or the backup refuses to run. Migrations must not insert
   rows into these schemas' tables: the backup holds every row, and the restore refuses a table that has rows once
   the migrations ran. Load seed or reference data some other way (once, through the app or an admin script).

3. **Generate the migration:**

   ```
   npm exec --no -- supabase-backup migration --schemas <schema1>,<schema2>
   ```

   It writes `migrations/<timestamp>_supabase_backup.sql`. Don't edit it. Every listed schema must already exist
   (created by an earlier migration), or the push fails. Push it to dev with `npm run push:dev`,
   then run `npm test`.

**What the migration does:**

- creates the `backup_reader` role (no login until you set its password), with `BYPASSRLS`, a 3-connection limit, a
  read-only default, and statement and idle-in-transaction timeouts;
- defines `backup.schemas()`, the list. The backup, restore, and test all read it from the database, so the
  migration is the only place it lives;
- grants `backup_reader` usage and SELECT on everything in the listed schemas, and SELECT on
  `supabase_migrations.schema_migrations`;
- sets **default privileges** for `postgres` in each listed schema, so tables and sequences created by later
  migrations are readable without another grant;
- defines `backup.auth_rows()` and `backup.unbacked_counts()`, the two `SECURITY DEFINER` functions through which
  `backup_reader` reads auth rows and checks that storage and Vault are empty;
- when the list shrinks, revokes everything from the schemas that left it.

**The test.** `npm test` runs your project's `tests/*.sql` (pgTAP, each in a rolled-back transaction with pending
migrations applied), then this package's `tests/backup_reader.sql`. That file checks that `backup_reader` can read
exactly the listed schemas and write to no table, that every `postgres`-owned schema is covered, that no data hides in
`public`, `extensions`, or `backup`, and that auth tokens come back blanked. It also creates a table in every listed
schema to prove the default privileges work. Its token check inserts two rows into `auth.users`, so any triggers your
project has on that table fire inside the test's rolled-back transaction. A grant made outside the generated migration's path (a table created by
another role, say) fails it.

## Setup

Once per project. Replace `<project>` with a short name for your project.

### 1. Cloudflare R2

In the Cloudflare dashboard:

1. **R2 Object Storage > Create bucket:** name `<project>-db-backups`, a location hint near your database, storage
   class Standard.
2. **The bucket > Settings > Bucket lock rules > Add rule**, twice:
   - prefix `production/daily/`, retention 35 days;
   - prefix `production/monthly/`, retention **Indefinite**.
3. **The bucket > Settings > Object lifecycle rules**, two rules:
   - prefix `production/daily/`: delete objects 36 days after upload;
   - prefix `dev/`: delete objects 14 days after upload.

   No rule for `production/monthly/`: monthlies are kept forever.

4. **R2 > Manage API tokens > Create API token**, twice. Both: **Apply to specific buckets only**, your bucket, TTL
   forever.
   - `<project>-backup-writer`, permission **Object Read & Write**;
   - `<project>-backup-watchdog`, permission **Object Read only**.

   Keep each token's Access Key ID and Secret Access Key on screen for step 4. Note the S3 endpoint,
   `https://<account id>.r2.cloudflarestorage.com`.

**Protect the Cloudflare account** with a strong password and 2FA: an account admin can remove the lock rules.

### 2. The age key pair

Install age and generate the key. **Windows (PowerShell):**

```powershell
winget install --id FiloSottile.age -e
age-keygen -o "$env:USERPROFILE\backup-age-key.txt"
```

**macOS / Linux:**

```sh
brew install age    # or: sudo apt-get install age
age-keygen -o ~/backup-age-key.txt
```

It prints `Public key: age1…`.

1. Save that public line (just `age1…`) as `supabase/backup/recipient.txt` and commit it. It isn't secret.
2. Store the private key in **two separate places**: the whole file's contents as a secure note in your password
   manager, and a printed copy in a safe (`notepad /p "$env:USERPROFILE\backup-age-key.txt"` on Windows,
   `lp ~/backup-age-key.txt` on macOS/Linux). The `AGE-SECRET-KEY-1…` line is uppercase letters and digits, so it
   can be typed back in. **Losing both makes every backup unreadable.**
3. Delete the file: `Remove-Item "$env:USERPROFILE\backup-age-key.txt"` (Windows) or `rm ~/backup-age-key.txt`.

Never put the private key in the repo, in GitHub, or anywhere an AI agent can read it.

### 3. GitHub notifications

At https://github.com/settings/notifications > **System > Actions**, choose **Email**, "Only notify for failed
workflows". Scheduled runs email whoever last edited the workflow's cron line.

### 4. GitHub environments

In your repo, **Settings > Environments > New environment**, three times. Give each **Deployment branches and tags:
Selected branches and tags**, with the rule `main`, so only workflows on `main` can read the secrets.

| Environment         | Secrets                                                                             | Variables                                                      |
| ------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `backup-production` | `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` (writer token); `BACKUP_DB_URL` (step 5) | `R2_ENDPOINT` = the S3 endpoint, `R2_BUCKET` = the bucket name |
| `backup-dev`        | The same writer token; `BACKUP_DB_URL` for dev (step 5)                             | The same                                                       |
| `backup-watchdog`   | `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` (read-only token)                        | The same                                                       |

One writer token serves both targets because R2 scopes tokens by bucket, not prefix. The backup refuses to write a
dev run outside `dev/`.

Anyone who can push to `main` can change a workflow and so read these secrets. Keep write access narrow, or protect
`main`.

### 5. The backup_reader password

For each target (dev first), in `supabase/`:

```
npm run backup:password -- --ref <ref> --host <session pooler host>
```

The host is on the project's dashboard: **Connect > Session pooler** (for example
`aws-0-us-east-1.pooler.supabase.com`). The command:

1. copies the backup URL to your clipboard. Paste it into that target's environment (`backup-dev` or
   `backup-production`) as the secret `BACKUP_DB_URL`, then clear clipboard history (Windows: Win+V > **Clear all**);
2. prints an `alter role backup_reader …` statement holding only a SCRAM verifier. Run it in that project's
   **SQL Editor**.

It needs a clipboard tool: `clip.exe` (Windows), `pbcopy` (macOS), or `wl-copy` or `xclip` (Linux). Without one it
changes nothing.

### 6. The caller workflows

Add these two files to your repo, with `<sha>` the same commit as in `package-lock.json`. The project folder must be
named `supabase`; if it isn't at the repo root (say, `db/supabase`), pass its path as `working-directory` under
`with:`.

```yaml
# .github/workflows/db-backup.yml
name: db-backup
on:
  schedule:
    - cron: '17 7 * * *'
  workflow_dispatch:
    inputs:
      target:
        {
          description: Database to back up,
          type: choice,
          options: [production, dev],
          default: production
        }
permissions:
  contents: read
concurrency:
  group: db-backup-${{ inputs.target || 'production' }}
  cancel-in-progress: false
jobs:
  backup:
    uses: RivinTech/supabase-backup/.github/workflows/backup.yml@<sha>
    with:
      target: ${{ inputs.target || 'production' }}
```

```yaml
# .github/workflows/db-backup-watchdog.yml
name: db-backup-watchdog
on:
  schedule:
    - cron: '43 13 * * *'
  workflow_dispatch:
permissions:
  contents: read
jobs:
  watchdog:
    uses: RivinTech/supabase-backup/.github/workflows/watchdog.yml@<sha>
```

Then run `npm run verify-pins`; it must print that the pins match.

If your GitHub organization restricts which actions may run (**Settings > Actions > General > Actions permissions**),
allow `RivinTech/supabase-backup/.github/workflows/*@*`.

### 7. First runs

1. Commit and push to `main`.
2. **Actions > db-backup > Run workflow**, branch `main`, target `dev`. It must go green. The last line of the
   **Back up** step is a JSON summary: keys, sizes, the encrypted file's SHA-256, timings, and row counts. No secrets.
3. Then the same with target `production`.
4. **Actions > db-backup-watchdog > Run workflow**: green.
5. Within the month, do a [restore drill](#yearly-restore-drill).

## Operations

- **Schedule (UTC):** the backup at 07:17 nightly (production), the watchdog at 13:43. Dev is backed up only on
  demand. GitHub can start scheduled runs hours late; the watchdog's limits absorb that.
- **Objects:**
  - `production/daily/<UTC timestamp>.tar.age`, one per night, kept 35 days (locked) and deleted at 36;
  - `production/monthly/<YYYY-MM>.tar.age`, a byte copy of the month's first daily, kept forever (locked);
  - `dev/<UTC timestamp>.tar.age`, deleted after 14 days.
- **The watchdog** lists `production/` with the read-only token and fails when:
  - there are no dailies, or the newest is over 72 hours old (two missed nights pass, three don't) or under 1 KB;
  - this month's monthly is missing after its first daily, or by the 3rd;
  - last month's monthly is missing, once backups predate this month;
  - a monthly's ETag matches no daily from its month while those dailies are kept (a planted monthly).
- **Failure emails** ("Run failed: db-backup") go to whoever last edited the workflow's cron line, not whoever
  dispatched the run. After anyone else edits a caller workflow, check who gets them. The log's last lines say why:
  `backup failed: …` or the watchdog's `FAIL …` lines.
- **By hand:** Actions > db-backup-watchdog > the latest run prints the newest daily's age and size and whether this
  month's monthly exists.

## Restore procedure

Restores go into a **new, empty project** only. Expect about an hour, most of it manual; the restore itself takes
seconds to minutes.

1. **Tools.** Install Git, Node 24 (https://nodejs.org/en/download), age, and the PostgreSQL 17 client, then clone
   your project's repo and run `npm ci` in its `supabase/` folder.

   **Windows (PowerShell):**

   ```powershell
   winget install --id Git.Git -e
   winget install --id FiloSottile.age -e
   winget install --id PostgreSQL.PostgreSQL.17 -e --override "--mode unattended --disable-components server,pgAdmin,stackbuilder"
   ```

   Open a new terminal; `age --version` must run and
   `& 'C:\Program Files\PostgreSQL\17\bin\psql.exe' --version` must print 17.

   **macOS:** `brew install git age postgresql@17`, then `export PG_BIN="$(brew --prefix postgresql@17)/bin"`.
   **Linux (Debian/Ubuntu):** `sudo apt-get install git age postgresql-client-17` (from the PGDG apt repo if your
   release lacks 17). The restore needs client 17.6 or later. If the tools aren't in a standard location, set
   `PG_BIN` to the folder holding `psql` and `pg_restore`.

   If GitHub or this package's repo is unavailable, see [Without GitHub](#without-github) below.

2. **New project** in the Supabase dashboard. On a Free org with 2 active projects, pause one first (Project
   Settings > General > Pause project).
   - a name such as `<project>-restored`, your region, any plan;
   - a strong database password of **letters and digits only**, so the URL needs no encoding;
   - the Postgres major version of the backup (the restore refuses any other);
   - the same **Data API** and **automatic RLS** choices as the original project.

   When it's ready: **Database > Settings > Enforce SSL**: on.

3. **`supabase/.env`.** Create it if it's missing. Click **Connect**, choose **Session pooler**, copy the URI
   (`postgresql://postgres.<ref>:[YOUR-PASSWORD]@<host>:5432/postgres`), replace `[YOUR-PASSWORD]`, brackets
   included, with the password, and add the line `RESTORE_DB_URL=<that URI>`.

4. **Pick the object.**
   - Choose the newest object whose key **and SHA-256** appear in a green db-backup run's summary line (Actions >
     db-backup > the run > the **Back up** step's last line).
   - Download it: Cloudflare dashboard > R2 Object Storage > your bucket > Objects > `production/` > `daily/` (or
     `monthly/`) > the object > **Download**, into a new folder outside the repo (`<restore folder>` below).
   - Check its hash: `Get-FileHash -Algorithm SHA256 <restore folder>\<file>` (Windows) or
     `shasum -a 256 <restore folder>/<file>` (macOS/Linux). It must match the summary.
   - A monthly older than 90 days has no run log left. Use one only if the Actions history shows no unexplained red
     db-backup or watchdog run from its month.
   - If GitHub itself is lost, accept an object only if all of these hold: it's under its prefix's lock rule, it was
     uploaded a few minutes after 07:17 UTC, a monthly's ETag equals a daily's (while that daily exists), and the
     restore's checks pass.

   Don't restore an object you can't match.

5. **Key file.** Copy the `AGE-SECRET-KEY-1…` line from the password manager, then:
   - **Windows:** `Get-Clipboard | Set-Content -Encoding ascii <restore folder>\key.txt`, then Win+V > **Clear all**;
   - **macOS:** `pbpaste > <restore folder>/key.txt`, then copy something harmless.

   From paper, type the line into a text editor and save it as that file. Any encoding or line ending works; if the
   restore says the file "must contain one AGE-SECRET-KEY-1… line", part of the key is missing.

6. **Restore**, in `supabase/`:

   ```
   npm run restore -- --backup <restore folder>/<file>.tar.age --identity <restore folder>/key.txt --target-ref <new ref>
   ```

   It decrypts and checks the archive, checks the target is new and empty, applies the backup's own migrations from
   your repo with `supabase db push`, loads the data and auth rows in one transaction (triggers off, so audit columns
   keep their values and no history is added), refreshes the materialized views the backup held populated, analyzes,
   then recomputes the manifest on the target. Confirm the printed SHA-256 matches step 4 and that it ends with
   `PASS`.

   A failure while loading rolls the load back. Any failure after the load, a view refresh or a `FAIL` from the
   verify, comes after the commit, so that project's data is suspect: don't point anything at it, delete it, fix the
   cause, and restore into another new project. A failure after `db push` started also leaves a project the next
   attempt refuses as not empty; delete it too and start from a new one.

7. **Clean up:** delete `<restore folder>` (it holds the key) and the `RESTORE_DB_URL` line.

8. **Post-restore:**
   - Edit `supabase-backup.json`: set `production.ref` (and `name`) to the new project. Land it on `main` through a
     reviewed commit before step 10; the password command and the backup refuse any other ref.
   - Set role passwords: `npm run backup:password -- --ref <new ref> --host <its session pooler host>` (paste into
     `backup-production` > `BACKUP_DB_URL`; run the printed `alter role` in the new project's SQL Editor), and the
     same for any other login roles your project has.
   - **Authentication** settings: sign-ups, anonymous sign-ins, providers and their client IDs and secrets, the Site
     URL, and the redirect allow list. For OAuth providers, add `https://<new ref>.supabase.co/auth/v1/callback` to
     the provider's authorized redirect URIs.
   - Every client's project URL and publishable key.

   The new project has new JWT signing keys, so every user signs in again.

9. **Newer migrations.** The restore applied only the backup's migrations. Push the rest from `main` to the new
   project, then check its security advisors.

10. **Actions > db-backup > Run workflow** (`main`, `production`), then **db-backup-watchdog**: both green.

11. Resume any project paused in step 2. Keep the old production project paused, not deleted, until you're sure it
    holds nothing more to recover.

### Without GitHub

The restore needs no GitHub, but it needs two things under `supabase/node_modules`: this package, built, and the
supabase CLI, which `db push` runs. The CLI's npm package downloads its binary from GitHub at install time, so with
GitHub down a fresh `npm install` can't get it. Any machine that ran `npm ci` in your project has both: restore from
there, or copy its `supabase/node_modules` folder to the restoring machine.

If only this package is missing, from any clone of this repo (a teammate's, or a backup of it):

```
git checkout <pinned sha>
npm ci
npm pack
```

`npm ci` builds it, and `npm pack` prints `supabase-backup-1.0.0.tgz`. In a folder named `supabase` that holds your
project's `supabase-backup.json`, `migrations/`, and `.env`, run `npm install <path to the .tgz>`. Don't use
`npm install <path to the clone>`: it only links the folder and skips the package's dependencies, so the command
fails on `pg`.

## Yearly restore drill

Once a year, and after any change to the restore, prove a backup restores.

1. **Actions > db-backup > Run workflow**, target `dev`. Note the summary line.
2. Follow the [restore procedure](#restore-procedure) steps 2–7 with that `dev/` object, into a scratch project.
   Re-create the key file from the password manager each time: that proves the stored copy works.
3. **Record:** the date, the object's key and size, the restore's step timings and `PASS`, and the per-table counts
   against the summary line.
4. Delete the scratch project and resume anything you paused.
5. **Rotate** the `backup_reader` passwords (setup step 5, for each target) and the two R2 tokens (create new ones,
   update the three environments, run the backup and watchdog, then delete the old tokens).

**Key rotation**, when needed: generate a new pair, commit the new `recipient.txt`, and keep the old private key as
long as backups encrypted to it exist. Monthlies are kept forever, so keep every old key forever.

## Adding or removing a schema

1. Generate a migration with the full new list:

   ```
   npm exec --no -- supabase-backup migration --schemas <the whole new list>
   ```

   Its version must be later than every existing migration; it refuses otherwise.

2. `npm run push:dev`, then `npm test`.
3. Push to production with your usual procedure, then run a dev and a production backup.

A schema removed from the list loses `backup_reader`'s grants. Restores of older backups still work: each backup
records its own schema list.

## Updating the package

**Review first.** This code runs with `BYPASSRLS` credentials and the R2 write key.

1. Read `https://github.com/RivinTech/supabase-backup/compare/<old sha>...<new sha>`.
2. In a clone of this repo, prove the new commit is on `main`:

   ```
   git fetch origin
   git merge-base --is-ancestor <new sha> origin/main
   ```

   It must exit 0 (`echo $?` prints `0`; in PowerShell, `$LASTEXITCODE`). GitHub resolves a SHA from any fork
   through the parent repo's name, so a SHA alone proves nothing.

3. Bump the SHA everywhere: `npm install -D git+https://github.com/RivinTech/supabase-backup.git#<new sha>` in every
   folder whose `package.json` depends on it, and both `uses:` lines.
4. `npm run verify-pins`: the pins must match.
5. `npm test` on dev.
6. Commit, push to `main`, and dispatch a dev backup.

The nightly backup also checks its own folder's pins after it runs, so a half-done bump fails loudly.

## Security model and invariants

- **`backup_reader`** is the backup's only login. It has `BYPASSRLS` (pg_dump runs with row security off and errors
  where RLS would apply) and SELECT on exactly the listed schemas and the migrations table. Nothing else: no writes to
  any table but its own temporary ones, no `auth` tables, no definer functions but the package's.
  `tests/backup_reader.sql` pins all of it. What `PUBLIC` holds on Supabase it holds too (temporary tables, creating
  large objects); any large object fails the nightly coverage check.
  - The policy alternative (`pg_dump --enable-row-security` with a `using (true)` policy per table) fails silently:
    a missing policy dumps, counts, and hashes the table as empty, and the restore check passes. `BYPASSRLS` can't go
    wrong that way, and grants no more than "every row of every backed-up table", which is what a backup is.
  - Its connection limit is 3. Its read-only default and timeouts guard against accidents only; the grants are the
    bound. It has no login until you set its password.
- **Auth rows** reach `backup_reader` only through `backup.auth_rows()`, a `SECURITY DEFINER` function owned by
  `postgres`, because `postgres` can't grant on `auth`. Only `backup_reader` and `postgres` may execute it.
- **Secrets never reach logs, the repo, or agents.** URLs and passwords are redacted from every error and log line.
  The password command prints only a SCRAM verifier. The age private key stays offline.
- **Verified TLS.** Every connection verifies the server against Supabase's root CA (`certs/prod-ca-2021.crt`).
- **One snapshot.** The hashes, counts, and dump come from one exported snapshot with fixed display settings, so the
  restore can demand byte-identical content, not just equal counts.
- **Coverage is checked every night.** Before dumping, the backup fails if any `postgres`-owned schema is unlisted,
  a listed schema is missing, `public` holds anything but views, storage or Vault holds rows, or a large object
  exists.
- **Archives are checked before anything is named.** The dump is read back in full before upload, the upload is read
  back (size and ETag), and the restore checks every archive member and the manifest before using them.
- **The restore refuses** production, dev, any non-empty target, and any Postgres major but the backup's.
- **Pins.** Callers pin the workflows and the package to one full SHA; `verify-pins` checks they agree.

## Development

```
npm ci
npm run check        # TypeScript
npm run lint         # Prettier (npm run format fixes)
npm run test:unit    # node:test, no database
```

To try a change against a project, build a tarball of your working copy (`npm pack`) and install it in the project's
`supabase/` folder with `npm install <path to the .tgz>`. Don't `npm install <path to the working copy>`: it links the
folder without the package's dependencies.

Run the project's `npm test` on dev after any change to the SQL the package generates or ships.
