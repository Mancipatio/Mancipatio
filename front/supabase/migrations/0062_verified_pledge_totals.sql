-- Public launchpad progress counts only pledges from verified investors.
--
-- Product policy 2026-09-23: a soft commitment (/api/launchpad/commit) no
-- longer requires KYC. Until then every pending/confirmed pledge came from a
-- KYC-verified client, and commitment_totals published them as social proof
-- ("X% pledged", "Pledgers N") through the unsigned
-- /api/launchpad/commitment-aggregate route. A pledge now costs only a free
-- SIWS signature, so throwaway wallets could push a raise to "100% pledged".
--
-- commitment_totals keeps its signature and every existing key. `pledged`,
-- `confirmed` and `pledgers` now count only pledges whose wallet resolves to
-- a LIVE verified dossier on the same network, resolved like
-- lib/server/kyc-gate.ts fetchClientRow + evaluateKycLookup:
--   * the wallet's own clients rows; when it has none, the rows of the
--     account it is linked to (account_wallets -> clients.account_id);
--   * any suspended or rejected row disqualifies;
--   * otherwise the oldest row decides: kyc_status = 'verified' with
--     kyc_expires_at strictly in the future.
-- Pledges that do not qualify are still recorded and are reported
-- separately as `unverifiedPledged` (amount) and `unverifiedPledgers`
-- (distinct wallets). They are unrelated to the existing `unverified` key,
-- which counts settled rows whose chain evidence is not verified. Settled
-- figures are unchanged: they already require verified on-chain evidence.
--
-- Evaluated at read time: a pledger who verifies later starts counting, and
-- one whose verification lapses or is suspended stops counting.
-- Deploy order does not matter: the front treats missing unverified* keys
-- as "server predates 0062" and shows the totals as before.
begin;

create or replace function public.commitment_totals(p_network text,p_sale text) returns jsonb language sql stable set search_path='' as $$
  with active as (
    select distinct investor_wallet as wallet from public.commitments
    where network=p_network and sale_pubkey=p_sale and status in ('pending','confirmed')
  ), own as (
    select a.wallet,c.id,c.created_at,c.kyc_status,c.kyc_expires_at
    from active a join public.clients c on c.network=p_network and c.wallet=a.wallet
  ), dossier as (
    select wallet,id,created_at,kyc_status,kyc_expires_at from own
    union all
    select a.wallet,c.id,c.created_at,c.kyc_status,c.kyc_expires_at
    from active a
    join public.account_wallets w on w.network=p_network and w.wallet=a.wallet
    join public.clients c on c.network=p_network and c.account_id=w.account_id
    where not exists(select 1 from own o where o.wallet=a.wallet)
  ), verified as (
    select wallet from dossier group by wallet
    having not bool_or(coalesce(kyc_status in ('suspended','rejected'),false))
      and coalesce((array_agg(kyc_status='verified' and kyc_expires_at>now() order by created_at,id))[1],false)
  ), pledges as (
    select m.amount,m.status,m.investor_wallet,m.evidence_verified,m.payment_mint,
      (v.wallet is not null) as verified_pledger
    from public.commitments m left join verified v on v.wallet=m.investor_wallet
    where m.network=p_network and m.sale_pubkey=p_sale
  )
  select jsonb_build_object(
    'pledged',coalesce(sum(amount) filter(where status='pending' and verified_pledger),0)::text,
    'confirmed',coalesce(sum(amount) filter(where status='confirmed' and verified_pledger),0)::text,
    'settled',coalesce(sum(amount) filter(where status='settled' and evidence_verified),0)::text,
    'backers',count(distinct investor_wallet) filter(where status='settled' and evidence_verified),
    'pledgers',count(distinct investor_wallet) filter(where status in ('pending','confirmed') and verified_pledger),
    'unverifiedPledged',coalesce(sum(amount) filter(where status in ('pending','confirmed') and not verified_pledger),0)::text,
    'unverifiedPledgers',count(distinct investor_wallet) filter(where status in ('pending','confirmed') and not verified_pledger),
    'paymentMint',min(payment_mint) filter(where status='settled' and evidence_verified),
    'unverified',count(*) filter(where status='settled' and not evidence_verified)
  ) from pledges;
$$;
revoke all on function public.commitment_totals(text,text) from public,anon,authenticated;
grant execute on function public.commitment_totals(text,text) to service_role;

commit;
