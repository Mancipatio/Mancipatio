-- 0092: names of the platform's operator wallets (/admin/admins).
--
-- The Super Admin names a wallet when it adds it as an Admin (or later, from
-- the list), so the list of Admins says who holds each key. A name is a note
-- for operators only: it grants nothing, every role is read from the chain,
-- and a wallet keeps its name after a revoke (a later grant shows it again).
-- One row per (network, wallet). Wallets linked to a Manci account also show
-- that account's display name, read from account_profiles; nothing is copied.
--
-- Access: RLS on, nothing for anon and authenticated; only service_role reads
-- and writes it (app/api/admin/wallet-labels: any Admin reads over its wallet
-- session, only the Super Admin writes, with a fresh wallet signature, and
-- each write leaves a server audit row).
--
-- Network: default public.deployment_network(), guarded (0071 rules 1-2).
-- Deploy order: either. A front without this table shows no names (the list
-- of Admins and the grants work as before); the table without the front is
-- unused.
-- Re-runnable: every statement is idempotent.
begin;
set local lock_timeout = '15s';

do $$
begin
  if to_regprocedure('public.deployment_network()') is null
     or to_regprocedure('mancipatio_ops.install_network_guards()') is null
     or to_regprocedure('public.touch_updated_at()') is null then
    raise exception 'Apply 0002 and 0070-0071 before 0092';
  end if;
end;
$$;

create table if not exists public.admin_wallet_labels (
  network    text not null default public.deployment_network()
               check (network in ('mainnet', 'devnet', 'testnet', 'localnet')),
  wallet     text not null check (wallet ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  -- Trimmed, 1-80 characters, no control characters (the route checks the same).
  label      text not null
               check (char_length(label) between 1 and 80
                      and label = btrim(label)
                      and label !~ '[[:cntrl:]]'),
  -- The Super Admin that wrote the current name.
  set_by     text not null check (set_by ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (network, wallet)
);
comment on table public.admin_wallet_labels is
  'Operator names of platform wallets (0092), shown on /admin/admins. Grants nothing: roles come from the chain. service_role only.';

drop trigger if exists admin_wallet_labels_touch on public.admin_wallet_labels;
create trigger admin_wallet_labels_touch before update on public.admin_wallet_labels
  for each row execute function public.touch_updated_at();

alter table public.admin_wallet_labels enable row level security;
revoke all on public.admin_wallet_labels from public, anon, authenticated, service_role;
grant select, insert, update, delete on public.admin_wallet_labels to service_role;

select mancipatio_ops.install_network_guards();

commit;
