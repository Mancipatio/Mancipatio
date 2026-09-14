begin read only;
set local statement_timeout = '15s';
select jsonb_build_object(
  'checked_at', clock_timestamp(),
  'server_version', current_setting('server_version'),
  'read_only', current_setting('transaction_read_only'),
  'migration_history_exists', to_regclass('supabase_migrations.schema_migrations') is not null,
  'public_table_count', (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p')),
  'cron_schema_exists', exists(select 1 from pg_namespace where nspname='cron')
) as preflight;
rollback;
