/**
 * The buy flow (I and T) on a simulator sale of MANCI-E2E-42eac4 class A
 * (design-sim §1 "Buy flow"):
 *
 *   await.passport   KYC'd investors: wait for the passport (KycEntry, batched)
 *   buy.terms        GET /api/launchpad/terms?sale=… (409 = no published whitepaper yet)
 *   buy.send         account.wallets.transaction, then the app's
 *                    buildDocumentedPurchase (preparation tx first when needed)
 *   buy.record       launchpad.recordPurchase {sale_pubkey, investor_wallet, settled_tx};
 *                    a 202 is polled again (≤ 1 per 30 s), > 3 min is a lag finding
 *   buy.aggregate    POST /api/launchpad/commitment-aggregate (the progress bar)
 *
 * KYC'd investors buy on sale [0], no-KYC buyers, traders and transfer hubs
 * (cohort X, when they buy their own units) on sale [1].
 */
import type { Address } from "@solana/kit";
import type { SaleDocumentTerms } from "@/lib/document-terms";
import { SITE_ORIGIN, XFER_UNITS } from "../constants";
import { prng } from "../identity";
import type { UserState } from "../state";
import { CONSISTENCY_MS, actor, awaitOwner, check, finish, go, later, note, retry, walletPolicy, type SimCtx } from "./common";

export function saleFor(ctx: SimCtx, u: UserState): string {
  return u.plan.variant === "buyer-kyc" ? ctx.market.sales[0] : ctx.market.sales[1];
}

/** Units bought: seeded per user; traders buy enough to fund their offers and deal. */
export function buyUnits(runId: string, u: UserState): number {
  if (u.plan.variant === "maker") return 40;
  if (u.plan.variant === "taker") return 5;
  // A transfer hub buys exactly what a loan would have lent (every S/P amount assumes it).
  if (u.plan.cohort === "X") return Number(XFER_UNITS);
  const rand = prng("sim-buy", runId, u.plan.n);
  return u.plan.variant === "buyer-kyc" ? 10 + Math.floor(rand() * 51) : 5 + Math.floor(rand() * 36);
}

type Aggregate = { pledged?: string; settled?: string; backers?: number };
type Recorded = { id?: string | null; jobId?: string; status?: "pending" | "complete" };

/** After the buy: investors are done, traders continue with their offers, transfer hubs with their pair. */
function afterBuy(u: UserState): void {
  if (u.plan.variant === "maker") return go(u, "offer.create");
  if (u.plan.variant === "taker") return go(u, "offer.wait");
  if (u.plan.variant === "xfer-hub" || u.plan.variant === "xfer-buyer") return go(u, "xfer.ready");
  finish(u, "done", "bought and recorded");
}

export async function buyStep(ctx: SimCtx, u: UserState): Promise<boolean> {
  const a = actor(ctx, u);
  switch (u.stage) {
    case "await.passport": {
      // The KycEntry on the registry (one batched read for all waiting investors)…
      if ((await ctx.passport(u.wallet)) === true) return (go(u, "buy.terms"), true);
      // …or, when the site pins another registry, the passport request leaving the open queue.
      const r = await ctx.http.post<{ open?: unknown }>(a, { step: "poll.passport.status", route: "/api/passport/status", body: { wallet: u.wallet } });
      if (r.outcome === "ok" && r.data?.open === null) {
        note(ctx, u, "await.passport", "the passport request was decided but no KycEntry is visible on the configured registry (SIM_KYC_REGISTRY?)");
        return (go(u, "buy.terms"), true);
      }
      awaitOwner(ctx, u, "await.passport", `KYC passport for ${u.wallet}: ${SITE_ORIGIN}/admin/kyc → issue passport (approve_holder)`);
      return true;
    }
    case "await.market":
    case "buy.terms": {
      const sale = saleFor(ctx, u);
      if (!sale) return (retry(ctx, u, "the market setup has no sale yet"), true);
      const r = await ctx.http.get<SaleDocumentTerms>(a, { step: "launchpad.terms", route: `/api/launchpad/terms?sale=${sale}`, expect: [200, 409] });
      if (r.status === 409) {
        awaitOwner(ctx, u, "await.market", `publish a verified whitepaper for asset ${ctx.market.asset} (MANCI-E2E-42eac4) so /api/launchpad/terms?sale=${sale} answers 200`);
        return true;
      }
      const t = r.data;
      if (r.outcome !== "ok" || !t?.versionId || !t.sha256) return (retry(ctx, u, `launchpad.terms ${r.status}`), true);
      check(ctx, u, "launchpad.terms.sale", t.sale === sale && t.asset === ctx.market.asset, "terms name another sale or asset");
      u.data.sale = sale;
      u.data.terms = { versionId: t.versionId, sha256: t.sha256, sale: t.sale, asset: t.asset, url: t.url, verifiedAt: t.verifiedAt };
      go(u, "buy.send");
      return true;
    }
    case "buy.send": {
      if (!u.tx.buy && !(await walletPolicy(ctx, u, "buy"))) return true;
      const units = buyUnits(ctx.runId, u);
      u.data.buyUnits = units;
      const signature = await ctx.chain.buy(u, a.signer, u.data.sale as Address, BigInt(units), u.data.terms as unknown as SaleDocumentTerms);
      if (signature) u.data.buySig = signature;
      u.data.recordAttempts = 0;
      go(u, signature ? "buy.record" : "buy.aggregate");
      return true;
    }
    case "buy.record": {
      const r = await ctx.http.signed<Recorded>(a, {
        step: "launchpad.recordPurchase",
        route: "/api/launchpad/record-purchase",
        action: "launchpad.recordPurchase",
        params: { sale_pubkey: u.data.sale, investor_wallet: u.wallet, settled_tx: u.data.buySig },
        expect: [200, 202],
      });
      if (r.outcome !== "ok") return (retry(ctx, u, `recordPurchase ${r.status}`), true);
      if (r.status === 200 && r.data?.status === "complete") return (go(u, "buy.aggregate"), true);
      u.data.recordAttempts = (u.data.recordAttempts ?? 0) + 1;
      if (u.data.recordAttempts * 30_000 >= CONSISTENCY_MS) {
        check(ctx, u, "launchpad.recordPurchase.lag", false, `purchase ${u.data.buySig} still pending after ${u.data.recordAttempts} polls (> 3 min)`);
        return (go(u, "buy.aggregate"), true);
      }
      later(ctx, u, 30_000);
      return true;
    }
    case "buy.aggregate": {
      const r = await ctx.http.post<Aggregate>(a, { step: "commitment-aggregate", route: "/api/launchpad/commitment-aggregate", body: { sale_pubkey: u.data.sale } });
      if (r.outcome !== "ok") return (retry(ctx, u, `commitment-aggregate ${r.status}`), true);
      check(ctx, u, "commitment-aggregate", (r.data?.backers ?? 0) >= 1 && Number(r.data?.settled ?? 0) > 0, `progress bar shows no settled purchase after ${u.wallet}'s buy`);
      afterBuy(u);
      return true;
    }
    default:
      return false;
  }
}
