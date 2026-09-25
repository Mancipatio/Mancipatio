/**
 * T: OTC traders (design-sim §1, owner scope 25.9.: offers + 2 escrow deals,
 * no governance, no resell). Six pairs; every trader buys first.
 *
 *   maker i  offer o1: create_offer (10 units for 11.000000) → deposit_to_offer_escrow
 *            pair 1 also: offer o2 → deposit → cancel_offer
 *            pair 2 also: offer o2 with a ~3 min expiry → deposit (taker 2 expires it)
 *   taker i  waits for o1 of maker i → take_offer; taker 2 then expire_offer on o2
 *   deals    pair 3: the seller (maker 3) requests an escrow through otc.create,
 *            pair 4: the buyer (taker 4) does; both parties wait for the owner to
 *            open it in /admin/otc, then deposit (asset / payment) on-chain.
 *
 * Every send is preceded by the wallet-policy read, as in the UI.
 */
import type { Address } from "@solana/kit";
import { OfferStatus, OtcDealStatus } from "@/lib/generated/asset_registry";
import { PAYMENT_UNIT, SITE_ORIGIN } from "../constants";
import { prng } from "../identity";
import type { OfferRecord, UserState } from "../state";
import { CONSISTENCY_MS, actor, awaitOwner, check, finish, go, later, retry, walletPolicy, type SimCtx } from "./common";

const OFFER_UNITS = BigInt(10);
const OFFER_PRICE = BigInt(11) * PAYMENT_UNIT;
const EXTRA_UNITS = BigInt(5);
const EXTRA_PRICE = BigInt(6) * PAYMENT_UNIT;
/** The expiring offer lives this long (chain seconds) before taker 2 expires it. */
export const EXPIRY_SECONDS = BigInt(180);
export const DEAL_UNITS = 5;
export const DEAL_PRICE = 6 * Number(PAYMENT_UNIT);

/** Maker and taker of pair `pair` in this run's roster. */
export function partner(ctx: SimCtx, u: UserState): UserState | undefined {
  const want = u.plan.variant === "maker" ? "taker" : "maker";
  return Object.values(ctx.state.users).find((o) => o.plan.pair === u.plan.pair && o.plan.variant === want);
}

/** The pair's escrow deal: pair 3 (seller requests) and pair 4 (buyer requests). */
export function dealRole(u: UserState): { requester: boolean; side: "seller" | "buyer" } | null {
  const seller = u.plan.variant === "maker";
  if (u.plan.pair === 3) return { requester: seller, side: seller ? "seller" : "buyer" };
  if (u.plan.pair === 4) return { requester: !seller, side: seller ? "seller" : "buyer" };
  return null;
}

function offerId(runId: string, u: UserState, key: string): bigint {
  const rand = prng("sim-offer", runId, u.plan.n, key);
  return BigInt(1_000_000 + Math.floor(rand() * 2_000_000_000));
}

function afterOffers(u: UserState): void {
  const deal = dealRole(u);
  if (!deal) return finish(u, "done", "offers done");
  go(u, deal.requester ? "deal.request" : "await.deal");
}

type OtcRow = { id?: string; seller_wallet?: string; buyer_wallet?: string; status?: string; deal_pda?: string | null };

export async function traderStep(ctx: SimCtx, u: UserState): Promise<boolean> {
  const a = actor(ctx, u);
  const offers = (u.data.offers ??= {});
  const flow = (key: "o1" | "o2", stage: string) => `${key}.${stage}`;
  switch (u.stage) {
    // ── maker ────────────────────────────────────────────────────────────
    case "offer.create":
    case "offer2.create": {
      const key = u.stage === "offer.create" ? "o1" : "o2";
      if (!offers[key]) {
        const id = offerId(ctx.runId, u, key);
        const extra = key === "o2";
        const expiresAt = extra && u.plan.pair === 2 ? (await ctx.chain.now()) + EXPIRY_SECONDS : BigInt(0);
        offers[key] = {
          offerId: id.toString(),
          pda: await ctx.chain.offerPda(id),
          amount: (extra ? EXTRA_UNITS : OFFER_UNITS).toString(),
          price: (extra ? EXTRA_PRICE : OFFER_PRICE).toString(),
          expiresAt: expiresAt.toString(),
        };
        ctx.persist();
      }
      if (!(await walletPolicy(ctx, u, flow(key, "create")))) return true;
      await ctx.chain.createOffer(u, a.signer, key, offers[key]);
      go(u, key === "o1" ? "offer.deposit" : "offer2.deposit");
      return true;
    }
    case "offer.deposit":
    case "offer2.deposit": {
      const key = u.stage === "offer.deposit" ? "o1" : "o2";
      if (!(await walletPolicy(ctx, u, flow(key, "deposit")))) return true;
      await ctx.chain.depositOffer(u, a.signer, key, offers[key]);
      const view = await ctx.chain.offer(offers[key].pda as Address);
      check(ctx, u, flow(key, "deposit.check"), view?.status === OfferStatus.Open && view.deposited >= BigInt(offers[key].amount), "offer escrow does not show the deposit");
      if (key === "o1") {
        if (u.plan.pair === 1 || u.plan.pair === 2) return (go(u, "offer2.create"), true);
        return (afterOffers(u), true);
      }
      if (u.plan.pair === 1) return (go(u, "offer2.cancel"), true);
      return (afterOffers(u), true);
    }
    case "offer2.cancel": {
      if (!(await walletPolicy(ctx, u, "o2.cancel"))) return true;
      await ctx.chain.cancelOffer(u, a.signer, "o2", offers.o2);
      const view = await ctx.chain.offer(offers.o2.pda as Address);
      check(ctx, u, "o2.cancel.check", view?.status === OfferStatus.Cancelled, "cancelled offer does not show Cancelled");
      afterOffers(u);
      return true;
    }
    // ── taker ────────────────────────────────────────────────────────────
    case "offer.wait": {
      const maker = partner(ctx, u);
      const ready = maker?.tx["o1.deposit"]?.status === "landed" ? maker.data.offers?.o1 : undefined;
      if (!ready) return (later(ctx, u, 30_000), true);
      u.data.offers = { ...offers, taken: ready };
      go(u, "offer.take");
      return true;
    }
    case "offer.take": {
      const target = offers.taken as OfferRecord;
      if (!(await walletPolicy(ctx, u, "o1.take"))) return true;
      await ctx.chain.takeOffer(u, a.signer, "o1", target.pda as Address);
      const view = await ctx.chain.offer(target.pda as Address);
      check(ctx, u, "o1.take.check", view?.status === OfferStatus.Filled, "taken offer does not show Filled");
      if (u.plan.pair === 2) return (go(u, "offer.expire.wait"), true);
      afterOffers(u);
      return true;
    }
    case "offer.expire.wait": {
      const maker = partner(ctx, u);
      const target = maker?.tx["o2.deposit"]?.status === "landed" ? maker.data.offers?.o2 : undefined;
      if (!target) return (later(ctx, u, 30_000), true);
      const now = await ctx.chain.now();
      const left = BigInt(target.expiresAt) + BigInt(10) - now;
      if (left > BigInt(0)) return (later(ctx, u, Number(left) * 1_000), true);
      u.data.offers = { ...offers, expiring: target };
      go(u, "offer.expire");
      return true;
    }
    case "offer.expire": {
      const target = offers.expiring as OfferRecord;
      if (!(await walletPolicy(ctx, u, "o2.expire"))) return true;
      await ctx.chain.expireOffer(u, a.signer, "o2", target.pda as Address);
      const view = await ctx.chain.offer(target.pda as Address);
      check(ctx, u, "o2.expire.check", view?.status === OfferStatus.Expired, "expired offer does not show Expired");
      afterOffers(u);
      return true;
    }
    // ── escrow deals ─────────────────────────────────────────────────────
    case "deal.request": {
      const other = partner(ctx, u);
      if (!other) return (finish(u, "failed", "deal partner missing from the roster"), true);
      const side = dealRole(u)!.side;
      const seller = side === "seller" ? u.wallet : other.wallet;
      const buyer = side === "buyer" ? u.wallet : other.wallet;
      // Read-then-write: an earlier run may have filed the request already.
      const mine = await ctx.http.read<OtcRow[]>(a, { step: "otc.list.before", route: "/api/otc/list", action: "otc.list", params: { scope: "mine" } });
      if (mine.outcome !== "ok") return (retry(ctx, u, `otc.list ${mine.status}`), true);
      const existing = (mine.data ?? []).find((r) => r.seller_wallet === seller && r.buyer_wallet === buyer && r.status !== "cancelled" && r.status !== "expired");
      if (existing?.id) {
        u.data.dealRequestId = existing.id;
        return (go(u, "await.deal"), true);
      }
      const r = await ctx.http.signed<{ id?: string }>(a, {
        step: "otc.create",
        route: "/api/otc/create",
        action: "otc.create",
        params: {
          share_class_pda: ctx.market.classA,
          mint: ctx.market.mintA,
          asset_label: "SIM MANCI-E2E class A",
          seller_wallet: seller,
          buyer_wallet: buyer,
          amount: DEAL_UNITS,
          price: DEAL_PRICE,
          payment_mint: ctx.market.paymentMint,
          expires_at: new Date(ctx.now() + 3 * 86_400_000).toISOString(),
        },
      });
      if (r.outcome !== "ok" || !r.data?.id) return (retry(ctx, u, `otc.create ${r.status}`), true);
      u.data.dealRequestId = r.data.id;
      go(u, "await.deal");
      return true;
    }
    case "await.deal": {
      const other = partner(ctx, u);
      const mine = await ctx.http.read<OtcRow[]>(a, { step: "poll.otc.list", route: "/api/otc/list", action: "otc.list", params: { scope: "mine" } });
      if (mine.outcome !== "ok") return (retry(ctx, u, `otc.list ${mine.status}`), true);
      const row = (mine.data ?? []).find((r) => r.seller_wallet === (dealRole(u)!.side === "seller" ? u.wallet : other?.wallet) && r.buyer_wallet === (dealRole(u)!.side === "buyer" ? u.wallet : other?.wallet));
      if (u.data.dealRequestId && !u.data.flags?.dealListed) {
        // The requester's own list must show the request (consistency, design §6).
        check(ctx, u, "otc.list.after-create", Boolean(row && row.id === u.data.dealRequestId), "otc.list does not show the request just created");
        u.data.flags = { ...(u.data.flags ?? {}), dealListed: true };
      }
      if (row?.status === "cancelled" || row?.status === "expired") return (finish(u, "done", `escrow request ${row.status}`), true);
      if (row?.status === "created" && row.deal_pda) {
        u.data.dealPda = row.deal_pda;
        return (go(u, dealRole(u)!.side === "seller" ? "deal.deposit.asset" : "deal.deposit.payment"), true);
      }
      awaitOwner(
        ctx,
        u,
        "await.deal",
        `open the OTC escrow in ${SITE_ORIGIN}/admin/otc for request ${row?.id ?? u.data.dealRequestId ?? "(pending)"}: ${DEAL_UNITS} units of class A for 6.000000 (seller ${dealRole(u)!.side === "seller" ? u.wallet : other?.wallet})`,
      );
      return true;
    }
    case "deal.deposit.asset":
    case "deal.deposit.payment": {
      const pda = u.data.dealPda as Address;
      if (!(await walletPolicy(ctx, u, "deal.deposit"))) return true;
      if (u.stage === "deal.deposit.asset") await ctx.chain.depositDealAsset(u, a.signer, pda);
      else await ctx.chain.depositDealPayment(u, a.signer, pda);
      u.data.pollCount = 0;
      go(u, "deal.settle.check");
      return true;
    }
    case "deal.settle.check": {
      const view = await ctx.chain.deal(u.data.dealPda as Address);
      if (view?.status === OtcDealStatus.Completed) return (finish(u, "done", "escrow deal settled"), true);
      u.data.pollCount = (u.data.pollCount ?? 0) + 1;
      if (u.data.pollCount * 60_000 > CONSISTENCY_MS * 10) return (finish(u, "done", "deposited; the counterparty has not settled"), true);
      later(ctx, u, 60_000);
      return true;
    }
    default:
      return false;
  }
}
