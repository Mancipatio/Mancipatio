-- 0034: Conversion requests (equity / real-estate ownership conversion).
--
-- Mirror of delivery_requests (0020) for the conversion flow: a token holder
-- of an equity or real-estate (ownership) share class asks to convert tokens
-- into the off-chain right (share-register entry / titled ownership). Admin
-- approves by opening a conversion escrow — a DeliveryEscrow-TYPE custody
-- vault on purpose (Burn & attest, beneficiary = holder, mandatory deadline):
-- on-chain, only DeliveryEscrow supports return_custody_vault (escrow back to
-- the holder; permissionless after the deadline) and bans revert (which BURNS
-- the escrow). The holder deposits tokens, and the vault is realized (burn)
-- once the off-chain conversion is executed, or returned if it falls through.
--
-- PRIVACY / RLS: unlike delivery_requests, this table gets NO anon policies at
-- all (default-deny, same stance as custom_inquiries / compliance_alerts in
-- 0025/0031). Rows carry holder contact details (PII), so even SELECT goes
-- through signed routes:
--   reads:  /api/conversion/list-mine  (signed; caller's own rows only)
--           /api/conversion/admin-list (signed + on-chain admin gate)
--   writes: /api/conversion/create | /cancel | /deposited (signed, holder-
--           bound) and /api/conversion/admin-update (signed + admin gate) —
--           all service-role; the anon key can neither read nor write.

create table if not exists public.conversion_requests (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  network text not null default 'devnet',
  holder_wallet text not null,
  client_id uuid references public.clients(id) on delete set null,
  share_class_pda text not null,
  mint text not null,
  asset_pda text,
  asset_label text not null default '',
  amount numeric(36, 0) not null,
  contact text not null default '',
  note text not null default '',
  status text not null default 'requested' check (status in (
    'requested', 'approved', 'vault_opened', 'deposited',
    'converted', 'cancelled', 'returned'
  )),
  vault_pda text,
  vault_id numeric(20, 0),
  admin_note text,
  decided_by text,
  decided_at timestamptz,
  deposit_tx text,
  outcome_tx text
);

drop trigger if exists conversion_requests_touch on public.conversion_requests;
create trigger conversion_requests_touch before update on public.conversion_requests
  for each row execute function public.touch_updated_at();

create index if not exists conversion_requests_wallet_idx on public.conversion_requests(holder_wallet);
create index if not exists conversion_requests_status_idx on public.conversion_requests(status);
create index if not exists conversion_requests_network_idx on public.conversion_requests(network);

-- ---------------------------------------------------------------------------
-- Status-transition guard (0030 style — defense in depth under the routes).
--
--   requested    -> vault_opened | cancelled   (approval == opening the vault)
--   approved     -> vault_opened | cancelled   (state allowed by the CHECK for
--                                               parity with 0020/0030; the
--                                               front never produces it)
--   vault_opened -> deposited    | cancelled
--   deposited    -> converted    | returned
--   converted / cancelled / returned : terminal, status immutable
--
-- deposited -> converted is DIRECT: the admin "Confirm conversion" button
-- sends the trigger+realize transaction (which BURNS the escrowed tokens
-- on-chain, irreversibly) BEFORE writing status='converted'. If the DB
-- rejected that transition the tokens would already be burned while the row
-- stayed 'deposited' — a permanent ledger/chain desync — so the matrix must
-- accept it (same reasoning as delivery's deposited -> delivered in 0030).
-- ---------------------------------------------------------------------------

create or replace function public.conversion_requests_guard_status()
returns trigger
language plpgsql
as $$
begin
  if new.status is distinct from old.status then
    if not (
      (old.status = 'requested'    and new.status in ('vault_opened', 'cancelled')) or
      -- 'approved' is never produced by the front; kept movable like 0030's
      -- legacy handling so a manually-seeded row cannot get stuck.
      (old.status = 'approved'     and new.status in ('vault_opened', 'cancelled')) or
      (old.status = 'vault_opened' and new.status in ('deposited', 'cancelled')) or
      -- deposited -> converted is direct: the on-chain burn happens before
      -- the DB write, so this transition must never be rejected (see header).
      (old.status = 'deposited'    and new.status in ('converted', 'returned'))
    ) then
      raise exception 'illegal conversion status transition: % -> %', old.status, new.status;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists conversion_requests_status_guard on public.conversion_requests;
create trigger conversion_requests_status_guard
  before update on public.conversion_requests
  for each row execute function public.conversion_requests_guard_status();

-- ---------------------------------------------------------------------------
-- RLS: enable and deliberately create NO policies — default-deny for anon and
-- authenticated. Contact details are PII; every read and write goes through
-- the signed service-role routes listed in the header (service role bypasses
-- RLS). Do NOT add an anon SELECT here later without stripping the contact
-- column from what it exposes.
-- ---------------------------------------------------------------------------

alter table public.conversion_requests enable row level security;
