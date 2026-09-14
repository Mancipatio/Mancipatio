-- 0027: EUR 3M annual cap enforcement on SPV issuances (DB-level, defense in depth).
--
-- - spv_issuances.source: 'manual' (admin registry form) or 'sale' (auto-booked
--   after close_sale via recordSaleIssuance).
-- - spv_issuances.cap_override: false by default. A BEFORE INSERT trigger blocks
--   any insert that would push the SPV's calendar-year total (per issued_at)
--   over spvs.annual_cap_eur. Setting cap_override = true bypasses the block,
--   but the column stays on the row as a permanent record of the override
--   (the front only sets it via a super-admin ConfirmModal with an audited reason).

alter table public.spv_issuances
  add column if not exists source text not null default 'manual';

alter table public.spv_issuances
  add column if not exists cap_override boolean not null default false;

create index if not exists spv_issuances_source_idx on public.spv_issuances(source);

create or replace function public.enforce_spv_annual_cap()
returns trigger
language plpgsql
as $$
declare
  cap numeric(18, 2);
  year_start date;
  year_end date;
  year_total numeric(18, 2);
begin
  if new.cap_override then
    return new; -- explicit, recorded bypass
  end if;

  -- Lock the SPV row FOR UPDATE before summing: the SUM below only sees
  -- COMMITTED rows, so two concurrent inserts for the same SPV would otherwise
  -- each read year_total independently and both pass, jointly exceeding the cap
  -- with no override recorded. The row lock serializes same-SPV inserts — the
  -- second waits for the first to commit, then its SUM includes that row.
  select annual_cap_eur into cap from public.spvs where id = new.spv_id for update;
  if cap is null then
    return new; -- no SPV row / no cap configured — nothing to enforce (FK handles missing SPV)
  end if;

  year_start := date_trunc('year', new.issued_at)::date;
  year_end := (year_start + interval '1 year')::date;

  select coalesce(sum(amount_eur), 0) into year_total
  from public.spv_issuances
  where spv_id = new.spv_id
    and issued_at >= year_start
    and issued_at < year_end;

  if year_total + new.amount_eur > cap then
    raise exception
      'SPV annual issuance cap exceeded: % already issued in %, adding % would exceed the cap of % EUR. Use cap_override to record anyway.',
      year_total, extract(year from new.issued_at)::int, new.amount_eur, cap;
  end if;

  return new;
end;
$$;

drop trigger if exists spv_issuances_cap_guard on public.spv_issuances;
create trigger spv_issuances_cap_guard
  before insert on public.spv_issuances
  for each row execute function public.enforce_spv_annual_cap();
