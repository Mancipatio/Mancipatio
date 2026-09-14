-- 0030: Delivery request status-transition guard (defense in depth).
--
-- All delivery_requests writes now go through server routes using the service
-- role, which already enforce who may write. This trigger additionally pins the
-- legal state machine at the database level so that no code path (present or
-- future) can jump states or resurrect a terminal request:
--
--   requested    -> vault_opened | cancelled
--   vault_opened -> deposited    | cancelled
--   deposited    -> in_delivery  | delivered | returned
--   in_delivery  -> delivered    | returned
--   delivered / cancelled / returned : terminal, status immutable
--
-- deposited -> delivered is DIRECT because the admin custody "Confirm delivery"
-- button is offered while status = 'deposited' ('Mark in delivery' is optional),
-- and confirmDelivery() sends the trigger+realize tx (which BURNS the escrowed
-- tokens on-chain, irreversibly) BEFORE writing status='delivered'. If the DB
-- rejected that transition the tokens would already be burned while the row
-- stayed 'deposited' — a permanent ledger/chain desync with no UI recovery. So
-- the matrix must accept it.
--
-- The legacy 'approved' state is dead in the front-end (dropped from the UI +
-- type union) but the column CHECK still allows it; any pre-existing 'approved'
-- rows may move on exactly as 'requested' rows would.

create or replace function public.delivery_requests_guard_status()
returns trigger
language plpgsql
as $$
begin
  if new.status is distinct from old.status then
    if not (
      (old.status = 'requested'    and new.status in ('vault_opened', 'cancelled')) or
      -- legacy rows only; the 'approved' state is no longer produced.
      (old.status = 'approved'     and new.status in ('vault_opened', 'cancelled')) or
      (old.status = 'vault_opened' and new.status in ('deposited', 'cancelled')) or
      -- deposited -> delivered is direct: the on-chain burn happens before the
      -- DB write, so this transition must never be rejected (see header).
      (old.status = 'deposited'    and new.status in ('in_delivery', 'delivered', 'returned')) or
      (old.status = 'in_delivery'  and new.status in ('delivered', 'returned'))
    ) then
      raise exception 'illegal delivery status transition: % -> %', old.status, new.status;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists delivery_requests_status_guard on public.delivery_requests;
create trigger delivery_requests_status_guard
  before update on public.delivery_requests
  for each row execute function public.delivery_requests_guard_status();
