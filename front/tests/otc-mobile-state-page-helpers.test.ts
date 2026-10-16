// The pure helpers behind three pages' new behaviour live inside the page
// modules, because a page module exports only its page (their natural homes
// are lib/offer-order.ts, a deals sibling and an admin sibling). They are
// exercised here as source: the helper block is cut between two anchors,
// type-stripped with the TypeScript compiler and evaluated with its imports
// injected, so the behaviour is tested, not just the text. A moved helper
// fails the anchor check loudly: move its describe to the new module then.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { getAddressDecoder, type Address } from "@solana/kit";
import { describe, expect, it, vi } from "vitest";
import { OfferStatus, type Offer, type OtcDeal } from "@/lib/generated/asset_registry";
import { remainingDeposit } from "@/lib/escrow-ledger";

function pageHelpers<T extends Record<string, unknown>>(
  file: string,
  start: string,
  end: string,
  scope: Record<string, unknown>,
  names: (keyof T & string)[],
): T {
  const src = readFileSync(join(process.cwd(), file), "utf8");
  const from = src.indexOf(start);
  const to = src.indexOf(end, from);
  expect(from, `${file}: ${start}`).toBeGreaterThan(-1);
  expect(to, `${file}: ${end}`).toBeGreaterThan(from);
  const block = src.slice(from, to);
  expect(block, "the helper block is import- and export-free").not.toMatch(/^(import|export) /m);
  const { outputText } = ts.transpileModule(block, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None },
  });
  const factory = new Function(
    ...Object.keys(scope),
    `${outputText}\nreturn { ${names.join(", ")} };`,
  );
  return factory(...Object.values(scope)) as T;
}

/** Besides the default export, the page modules export nothing. */
function expectOnlyPageExport(file: string, name: string) {
  const src = readFileSync(join(process.cwd(), file), "utf8");
  expect(src.match(/^export /gm)).toEqual(["export "]);
  expect(src).toMatch(new RegExp(`^export default function ${name}`, "m"));
}

const key = (n: number) =>
  getAddressDecoder().decode(new Uint8Array(32).fill(n)) as Address;

// ── /portfolio/offers: the maker's order ─────────────────────────────────────

type OfferRow = { offer: Offer; closed: boolean; closedAt?: string | null };
type OffersHelpers = {
  offerKey: (o: Pick<Offer, "shareClass" | "offerId">) => string;
  makerOfferRank: (row: {
    offer: Pick<Offer, "status" | "amount" | "deposited">;
    closed: boolean;
  }) => 0 | 1 | 2 | 3;
  sortMakerOffers: <T extends OfferRow>(rows: readonly T[], pinnedKey: string | null) => T[];
};

function offer(offerId: number, status: OfferStatus, deposited = 8): Offer {
  return {
    maker: key(1),
    shareClass: key(2),
    mint: key(3),
    escrow: key(4),
    paymentMint: key(5),
    amount: BigInt(8),
    deposited: BigInt(deposited),
    price: BigInt(90),
    status,
    offerId: BigInt(offerId),
    expiresAt: BigInt(0),
    version: 1,
    bump: 255,
  } as Offer;
}

describe("/portfolio/offers orders the maker's offers by what still needs the maker", () => {
  const { offerKey, makerOfferRank, sortMakerOffers } = pageHelpers<OffersHelpers>(
    "app/portfolio/offers/page.tsx",
    "function offerKey(",
    "export default function MyOffersPage",
    { OfferStatus, remainingDeposit },
    ["offerKey", "makerOfferRank", "sortMakerOffers"],
  );
  const unfunded: OfferRow = { offer: offer(1, OfferStatus.Open, 0), closed: false };
  const funded: OfferRow = { offer: offer(2, OfferStatus.Open), closed: false };
  const filled: OfferRow = { offer: offer(3, OfferStatus.Filled), closed: false };
  const archivedNewer: OfferRow = {
    offer: offer(4, OfferStatus.Cancelled),
    closed: true,
    closedAt: "2026-09-23T00:00:00Z",
  };
  const archivedOlder: OfferRow = {
    offer: offer(5, OfferStatus.Expired),
    closed: true,
    closedAt: "2026-09-01T00:00:00Z",
  };
  const archivedStaleOpen: OfferRow = { offer: offer(6, OfferStatus.Open), closed: true, closedAt: null };
  const ids = (rows: OfferRow[]) => rows.map((r) => Number(r.offer.offerId));

  it("keys an offer by share class and id, the key the page already uses", () => {
    expect(offerKey(unfunded.offer)).toBe(`${key(2).toString()}-1`);
  });

  it("ranks: Open unfunded, Open funded, terminal live, archived (a stale-Open archive row included)", () => {
    expect(makerOfferRank(unfunded)).toBe(0);
    expect(makerOfferRank(funded)).toBe(1);
    expect(makerOfferRank(filled)).toBe(2);
    expect(makerOfferRank(archivedNewer)).toBe(3);
    expect(makerOfferRank(archivedStaleOpen)).toBe(3);
  });

  it("sorts mixed rows by rank, archived rows newest closedAt first (null last), the same from any input order", () => {
    const mixed = [archivedOlder, filled, archivedStaleOpen, funded, archivedNewer, unfunded];
    expect(ids(sortMakerOffers(mixed, null))).toEqual([1, 2, 3, 4, 5, 6]);
    expect(ids(sortMakerOffers([...mixed].reverse(), null))).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("puts a smaller-id unfunded offer above a larger-id funded one; ties by id descending", () => {
    expect(ids(sortMakerOffers([funded, unfunded], null))).toEqual([1, 2]);
    const other: OfferRow = { offer: offer(9, OfferStatus.Open, 0), closed: false };
    expect(ids(sortMakerOffers([unfunded, other], null))).toEqual([9, 1]);
  });

  it("pins the just-created offer first whatever its rank", () => {
    expect(
      ids(sortMakerOffers([unfunded, funded, archivedOlder], offerKey(archivedOlder.offer))),
    ).toEqual([5, 1, 2]);
  });

  it("the page uses it instead of a random-id 'newest first', reads the created offer back, and exports only its page", () => {
    const page = readFileSync(join(process.cwd(), "app/portfolio/offers/page.tsx"), "utf8");
    expect(page).not.toContain("Number(b.offer.offerId - a.offer.offerId)");
    expect(page).toMatch(/return sortMakerOffers\(\s*\[\.\.\.live, \.\.\.closed\],\s*justCreated \? offerKey\(justCreated\) : null,\s*\);/);
    expect(page).toContain("key={offerKey(o)}");
    expect(page).toContain('title="Just created — fund its escrow so it can be taken."');
    // The chain read after the send has its own catch: a failed read never
    // reports a created offer as failed.
    const create = page.slice(page.indexOf("async function create()"), page.indexOf("if (!wallet) return null;"));
    expect(create).toMatch(/fetchMaybeOffer\(client\.runtime\.rpc, pda, \{ commitment: "confirmed" \}\)/);
    expect(create).toMatch(/\.catch\(\(\) => null\);\s*onSuccess\(created\);/);
    expect(create.indexOf('toast.showTx(sig ?? "", { title: "Offer created" })')).toBeLessThan(create.indexOf("fetchMaybeOffer("));
    expectOnlyPageExport("app/portfolio/offers/page.tsx", "MyOffersPage");
  });
});

// ── /portfolio/deals: declined requests in the party view ────────────────────

type DeclinedRow = { id: string; status: string; deal_pda: string | null; updated_at: string };
type DealsHelpers = {
  DECLINED_REQUEST_DAYS: number;
  recentlyDeclinedRequests: <T extends DeclinedRow>(rows: readonly T[], nowMs: number, days?: number) => T[];
};

describe("/portfolio/deals shows the requests the platform declined", () => {
  const { DECLINED_REQUEST_DAYS, recentlyDeclinedRequests } = pageHelpers<DealsHelpers>(
    "app/portfolio/deals/page.tsx",
    "const DECLINED_REQUEST_DAYS",
    "export default function MyDealsPage",
    {},
    ["DECLINED_REQUEST_DAYS", "recentlyDeclinedRequests"],
  );
  const NOW = Date.parse("2026-10-16T12:00:00Z");
  const DAY = 86_400_000;
  const row = (id: string, status: string, daysAgo: number, deal_pda: string | null = null): DeclinedRow => ({
    id,
    status,
    deal_pda,
    updated_at: new Date(NOW - daysAgo * DAY).toISOString(),
  });

  it("keeps a declined request for 30 days", () => {
    expect(DECLINED_REQUEST_DAYS).toBe(30);
  });

  it("shows requested → cancelled rows (no deal), newest first, and nothing else", () => {
    const rows = [
      row("old", "cancelled", 31),
      row("a", "cancelled", 3),
      row("deal-cancelled", "cancelled", 1, "DealPda111"),
      row("b", "cancelled", 1),
      row("waiting", "requested", 1),
      row("open", "created", 1, "DealPda222"),
      row("done", "completed", 1, "DealPda333"),
      row("expired", "expired", 1, "DealPda444"),
      row("edge", "cancelled", 30),
    ];
    expect(recentlyDeclinedRequests(rows, NOW).map((r) => r.id)).toEqual(["b", "a", "edge"]);
    expect(recentlyDeclinedRequests(rows, NOW, 2).map((r) => r.id)).toEqual(["b"]);
  });

  it("the page renders them after the waiting ones, keeps the empty state off, and exports only its page", () => {
    const page = readFileSync(join(process.cwd(), "app/portfolio/deals/page.tsx"), "utf8");
    expect(page).toContain("recentlyDeclinedRequests(requests ?? [], nowMs)");
    const waiting = page.indexOf("Waiting for the platform");
    const declined = page.indexOf("Declined by the platform\n");
    expect(waiting).toBeGreaterThan(-1);
    expect(declined).toBeGreaterThan(waiting);
    expect(page).toMatch(/Declined by the platform — no escrow was opened, nothing\s+was deposited/);
    expect(page).toMatch(/sortedDeals\.length === 0 &&\s+pendingRequests\.length === 0 &&\s+declinedRequests\.length === 0 \?/);
    expectOnlyPageExport("app/portfolio/deals/page.tsx", "MyDealsPage");
  });
});

// ── /admin/otc: one deal per request, honest cancel bookkeeping ──────────────

type DealTerms = Pick<OtcDeal, "shareClass" | "mint" | "seller" | "buyer" | "amount" | "price" | "paymentMint">;
type RequestTerms = {
  share_class_pda: string;
  mint: string;
  seller_wallet: string;
  buyer_wallet: string;
  amount: number;
  price: number;
  payment_mint: string;
};
type AdminHelpers = {
  dealMatchesRequest: (deal: DealTerms, req: RequestTerms) => boolean;
  flipCancelledDealRequest: (
    dealPda: string,
    io: {
      listCreated: () => Promise<{ id: string; deal_pda: string | null }[]>;
      update: (requestId: string) => Promise<boolean>;
    },
  ) => Promise<"flipped" | "no-request" | "failed">;
};

describe("/admin/otc pure helpers", () => {
  const { dealMatchesRequest, flipCancelledDealRequest } = pageHelpers<AdminHelpers>(
    "app/admin/otc/page.tsx",
    "function dealMatchesRequest(",
    "// Escrows opened on-chain whose request flip did not land",
    {},
    ["dealMatchesRequest", "flipCancelledDealRequest"],
  );
  const deal: DealTerms = {
    shareClass: key(2),
    mint: key(3),
    seller: key(4),
    buyer: key(5),
    amount: BigInt(10),
    price: BigInt(25_000_000),
    paymentMint: key(6),
  };
  const req: RequestTerms = {
    share_class_pda: key(2).toString(),
    mint: key(3).toString(),
    seller_wallet: key(4).toString(),
    buyer_wallet: key(5).toString(),
    amount: 10,
    price: 25_000_000,
    payment_mint: key(6).toString(),
  };

  it("dealMatchesRequest: every term must match (the server's otcDealMismatch rule, on the client)", () => {
    expect(dealMatchesRequest(deal, req)).toBe(true);
    // numeric round-trips are truncated like the builder does
    expect(dealMatchesRequest(deal, { ...req, amount: 10.7 })).toBe(true);
    expect(dealMatchesRequest({ ...deal, shareClass: key(9) }, req)).toBe(false);
    expect(dealMatchesRequest({ ...deal, mint: key(9) }, req)).toBe(false);
    expect(dealMatchesRequest({ ...deal, seller: key(9) }, req)).toBe(false);
    expect(dealMatchesRequest({ ...deal, buyer: key(9) }, req)).toBe(false);
    expect(dealMatchesRequest({ ...deal, amount: BigInt(11) }, req)).toBe(false);
    expect(dealMatchesRequest({ ...deal, price: BigInt(25) }, req)).toBe(false);
    expect(dealMatchesRequest({ ...deal, paymentMint: key(9) }, req)).toBe(false);
  });

  it("flipCancelledDealRequest: flips the one created row that records the deal, and never throws", async () => {
    const update = vi.fn(async () => true);
    const rows = [
      { id: "other", deal_pda: "DealPda999" },
      { id: "mine", deal_pda: "DealPda111" },
    ];
    await expect(
      flipCancelledDealRequest("DealPda111", { listCreated: async () => rows, update }),
    ).resolves.toBe("flipped");
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith("mine");

    const untouched = vi.fn(async () => true);
    await expect(
      flipCancelledDealRequest("DealPda222", { listCreated: async () => rows, update: untouched }),
    ).resolves.toBe("no-request");
    expect(untouched).not.toHaveBeenCalled();

    await expect(
      flipCancelledDealRequest("DealPda111", { listCreated: async () => rows, update: async () => false }),
    ).resolves.toBe("failed");
    await expect(
      flipCancelledDealRequest("DealPda111", {
        listCreated: async () => rows,
        update: async () => {
          throw new Error("route down");
        },
      }),
    ).resolves.toBe("failed");
    await expect(
      flipCancelledDealRequest("DealPda111", {
        listCreated: async () => {
          throw new Error("list down");
        },
        update,
      }),
    ).resolves.toBe("failed");
  });

  it("the admin page exports only its page", () => {
    expectOnlyPageExport("app/admin/otc/page.tsx", "AdminOtcPage");
  });
});
