-- backup_reader, the nightly backup's login: it reads exactly what backup.schemas() lists, through the grants the
-- generated migration sets up, and can write to no table but its own temporary ones. Project-independent: it reads
-- the list from the database and uses no project fixtures. The runner wraps it in a transaction and rolls it back.
select plan(28);

select ok(current_setting('server_version_num')::int >= 170000, 'supabase-backup needs Postgres 17+');

select is(array_remove(array[
    case when cardinality(backup.schemas()) = 0 then 'the list is empty' end,
    case when backup.schemas() is distinct from
      (select array_agg(s order by s collate "C") from unnest(backup.schemas()) s) then 'the list is not sorted' end,
    (select 'missing or not owned by postgres: ' || string_agg(s, ', ')
      from unnest(backup.schemas()) s left join pg_namespace n on n.nspname = s
      where n.oid is null or pg_get_userbyid(n.nspowner) <> 'postgres')
  ], null), '{}', 'backup.schemas() is non-empty, sorted, and every schema in it exists and is owned by postgres');

select is_empty($$
  select format('%s.%s', n.nspname, c.relname), p.priv
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER'), ('MAINTAIN')) as p (priv)
  where n.nspname = any (backup.schemas()) and c.relkind in ('r', 'p', 'v', 'm', 'f')
    and has_table_privilege('backup_reader', c.oid, p.priv) <> (p.priv = 'SELECT')
$$, 'on every table and view in a backed-up schema, backup_reader has SELECT only');

select is_empty($$
  select format('%s.%s', n.nspname, c.relname), p.priv
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  cross join (values ('USAGE'), ('SELECT'), ('UPDATE')) as p (priv)
  where n.nspname = any (backup.schemas()) and c.relkind = 'S'
    and has_sequence_privilege('backup_reader', c.oid, p.priv) <> (p.priv = 'SELECT')
$$, 'on every sequence in a backed-up schema, backup_reader has SELECT only (pg_dump reads its value)');

-- A temp view, not a function: it is dropped with the rollback, and the checks below differ only in the schema.
-- Sequences have their own privileges (USAGE among them), so they're checked with has_sequence_privilege.
create temp view backup_reader_relation_privileges as
select n.nspname, c.relname, p.priv
from pg_class c join pg_namespace n on n.oid = c.relnamespace
cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER'), ('MAINTAIN')) as p (priv)
where c.relkind in ('r', 'p', 'v', 'm', 'f') and has_table_privilege('backup_reader', c.oid, p.priv)
union all
select n.nspname, c.relname, p.priv
from pg_class c join pg_namespace n on n.oid = c.relnamespace
cross join (values ('USAGE'), ('SELECT'), ('UPDATE')) as p (priv)
where c.relkind = 'S' and has_sequence_privilege('backup_reader', c.oid, p.priv);

select is_empty($$ select relname, priv from backup_reader_relation_privileges where nspname = 'public' $$,
  'backup_reader has no privilege on any relation in public');

select is_empty($$ select relname, priv from backup_reader_relation_privileges where nspname = 'auth' $$,
  'backup_reader has no privilege on any relation in auth: it reads auth rows only through backup.auth_rows');

select set_eq($$
  select format('%s %s', relname, priv) from backup_reader_relation_privileges where nspname = 'supabase_migrations'
$$, array['schema_migrations SELECT'], 'in supabase_migrations, backup_reader has SELECT on schema_migrations and nothing else');

select set_eq($$
  select nspname::text from pg_namespace
  where nspname not like 'pg\_temp\_%' and nspname not like 'pg\_toast\_temp\_%'
    and has_schema_privilege('backup_reader', oid, 'USAGE')
$$, $$
  select unnest(backup.schemas() || array['backup', 'information_schema', 'pg_catalog', 'public', 'supabase_migrations'])
$$, 'backup_reader has usage on exactly the backed-up schemas, backup, information_schema, pg_catalog, public, and supabase_migrations');

select is_empty($$
  select nspname from pg_namespace
  where nspname not like 'pg\_temp\_%' and nspname not like 'pg\_toast\_temp\_%'
    and has_schema_privilege('backup_reader', oid, 'CREATE')
$$, 'backup_reader may create objects in no schema');

select ok(not has_database_privilege('backup_reader', current_database(), 'CREATE'),
  'backup_reader may not create schemas in the database');

-- Column grants aren't seen by has_table_privilege, so a column-level INSERT or UPDATE would slip past the checks above.
select is_empty($$
  select format('%s.%s', n.nspname, c.relname), p.priv
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  cross join (values ('INSERT'), ('UPDATE'), ('REFERENCES')) as p (priv)
  where (n.nspname = any (backup.schemas()) or n.nspname in ('public', 'auth', 'supabase_migrations'))
    and c.relkind in ('r', 'p', 'v', 'm', 'f')
    and has_any_column_privilege('backup_reader', c.oid, p.priv)
$$, 'backup_reader has no column-level INSERT, UPDATE, or REFERENCES in a backed-up schema, public, auth, or supabase_migrations');

select set_eq($$
  select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'backup' and has_function_privilege('backup_reader', p.oid, 'EXECUTE')
$$, array['backup.auth_rows()', 'backup.schemas()', 'backup.unbacked_counts()'],
  'in backup, backup_reader may execute exactly auth_rows, schemas, and unbacked_counts');

-- Invoker functions run with backup_reader's own read-only rights, so only definer ones matter. Trigger and event
-- trigger functions can't be called directly (a new project with automatic RLS gets public.rls_auto_enable(), an
-- event trigger function PUBLIC may execute).
select is_empty($$
  select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where (n.nspname = 'public' or n.nspname = any (backup.schemas())) and p.prosecdef
    and p.prorettype not in ('trigger'::regtype, 'event_trigger'::regtype)
    and has_function_privilege('backup_reader', p.oid, 'EXECUTE')
$$, 'backup_reader may execute no security definer function in public or a backed-up schema');

-- auth_rows and unbacked_counts run as postgres, which can read auth, storage, and vault, so only backup_reader (and
-- the owner) may call them.
create function pg_temp.backup_function_problems(fn regprocedure, definer boolean) returns text[]
language sql as $$
  select array_remove(array[
    case when p.prosecdef <> definer then 'security ' || case when p.prosecdef then 'definer' else 'invoker' end end,
    case when pg_get_userbyid(p.proowner) <> 'postgres' then 'owner is ' || pg_get_userbyid(p.proowner)::text end,
    case when p.proconfig is distinct from array['search_path=""'] then 'proconfig is ' || coalesce(p.proconfig::text, 'null') end,
    case when (
      select array_agg(distinct coalesce(r.rolname::text, 'PUBLIC') order by coalesce(r.rolname::text, 'PUBLIC'))
      from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a left join pg_roles r on r.oid = a.grantee
      where a.privilege_type = 'EXECUTE'
    ) is distinct from array['backup_reader', 'postgres'] then 'EXECUTE grantees aren''t exactly backup_reader and postgres' end
  ], null)
  from pg_proc p where p.oid = fn
$$;
select is(pg_temp.backup_function_problems('backup.auth_rows()', true), '{}',
  'backup.auth_rows is security definer, owned by postgres, sets search_path = '''', and only backup_reader may execute it');
select is(pg_temp.backup_function_problems('backup.unbacked_counts()', true), '{}',
  'backup.unbacked_counts is security definer, owned by postgres, sets search_path = '''', and only backup_reader may execute it');
select is(pg_temp.backup_function_problems('backup.schemas()', false), '{}',
  'backup.schemas is security invoker, owned by postgres, sets search_path = '''', and only backup_reader may execute it');

-- rolcanlogin isn't tested: the user enables it when setting the password. These two are also what catches a
-- backup_reader that existed before the migration, whose create is guarded by "if not exists".
select ok((select rolbypassrls and not (rolsuper or rolcreaterole or rolcreatedb or rolreplication) from pg_roles where rolname = 'backup_reader')
  and not exists (select from pg_auth_members m join pg_roles r on r.oid = m.member where r.rolname = 'backup_reader'),
  'backup_reader has bypassrls (pg_dump needs it) and nothing else: no superuser, createrole, createdb, or replication, and a member of no role');

-- The other direction: a member could SET ROLE backup_reader and read past RLS. PostgreSQL 16 makes the role's
-- creator, postgres, a member; no API role (anon, authenticated, authenticator, service_role) may be one.
select is_empty($$
  select r.rolname::text from pg_auth_members m
    join pg_roles g on g.oid = m.roleid join pg_roles r on r.oid = m.member
  where g.rolname = 'backup_reader' and r.rolname <> 'postgres'
$$, 'no role but postgres is a member of backup_reader');

select ok((select rolconnlimit = 3
    and (select array_agg(c order by c) from unnest(rolconfig) c)
      = array['default_transaction_read_only=on', 'idle_in_transaction_session_timeout=25min', 'statement_timeout=15min']
  from pg_roles where rolname = 'backup_reader'),
  'backup_reader is bounded: 3 connections, read-only by default, 15-minute statement and 25-minute idle-in-transaction timeouts');

-- What the backup covers. The backup checks the same rule before every dump.
select is_empty($$
  select nspname::text from pg_namespace where pg_get_userbyid(nspowner) = 'postgres'
  except select unnest(backup.schemas() || array['backup', 'extensions', 'supabase_migrations'])
$$, 'every schema postgres owns is backed up (for a new schema, generate a migration with the new schema list)');

select is_empty($$
  select c.relname, c.relkind from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p', 'm', 'f', 'S')
$$, 'public holds no tables, materialized views, foreign tables, or sequences, so no data hides there');

-- The kind filter skips composite types: pgTAP's _time_trial_type is the one relation there no extension owns.
select is_empty($$
  select c.relname, c.relkind from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'extensions' and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
    and not exists (select from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
$$, 'every table, view, and sequence in extensions belongs to an extension, so no data hides there');

select is_empty($$
  select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'backup'
$$, 'the backup schema holds no relations, so no data hides there');

select set_eq($$ select rel, row_count from backup.unbacked_counts() $$,
  $$ values ('storage.objects', 0::bigint), ('storage.buckets', 0::bigint), ('vault.secrets', 0::bigint) $$,
  'backup.unbacked_counts reports storage.objects, storage.buckets, and vault.secrets, all empty');

-- pg_dump -n leaves large objects out. PUBLIC may create them (lo_create, lo_from_bytea), so backup_reader can too;
-- the nightly coverage check fails while any exists, and so does this.
select is_empty($$ select oid from pg_largeobject_metadata $$, 'no large objects exist, since the backup leaves them out');

-- One user with every one-time token set and one with every token null, which GoTrue can't load after a restore.
insert into auth.users (id, email, confirmation_token, recovery_token, email_change_token_new, email_change_token_current,
    phone_change_token, reauthentication_token)
values
  ('00000000-0000-4000-8000-00000000b4c0', 'zz-backup-probe-set@example.com', 't1', 't2', 't3', 't4', 't5', 't6'),
  ('00000000-0000-4000-8000-00000000b4c1', 'zz-backup-probe-null@example.com', null, null, null, null, null, null);
select is((
    select array_agg(u.row_data ->> 'id' order by u.row_data ->> 'id') from backup.auth_rows() u
    where u.table_name = 'users' and u.row_data ->> 'id' like '00000000-0000-4000-8000-00000000b4c_'
      and (select bool_and(coalesce(u.row_data -> k = '""'::jsonb, false)) from unnest(array['confirmation_token', 'recovery_token',
        'email_change_token_new', 'email_change_token_current', 'phone_change_token', 'reauthentication_token']) k)
  ), array['00000000-0000-4000-8000-00000000b4c0', '00000000-0000-4000-8000-00000000b4c1'],
  'backup.auth_rows returns both probe users, set and null, with each one-time token blanked to ""');

-- Default privileges: a table created later in any backed-up schema is readable without a new grant.
do $$
declare
  s text;
begin
  foreach s in array backup.schemas() loop
    execute format('create table %I.zz_backup_probe (id bigint generated always as identity primary key)', s);
  end loop;
end
$$;
select is_empty($$
  select s, p.priv from unnest(backup.schemas()) s
  cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER'), ('MAINTAIN')) as p (priv)
  where has_table_privilege('backup_reader', format('%I.zz_backup_probe', s), p.priv) <> (p.priv = 'SELECT')
$$, 'default privileges give backup_reader SELECT only on a new table in every backed-up schema');
select is_empty($$
  select s, p.priv from unnest(backup.schemas()) s
  cross join (values ('USAGE'), ('SELECT'), ('UPDATE')) as p (priv)
  where has_sequence_privilege('backup_reader', pg_get_serial_sequence(format('%I.zz_backup_probe', s), 'id'), p.priv)
    <> (p.priv = 'SELECT')
$$, 'default privileges give backup_reader SELECT only on a new table''s sequence in every backed-up schema');

select * from finish();
