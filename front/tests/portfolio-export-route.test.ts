// POST /api/portfolio/export: the signer's own records only (verified
// purchases, its side of its OTC deals, its conversions without contact or
// notes), bound to the active network, with the platform's daily EUR rates;
// a record read that fails answers 503, unreadable rates only empty the EUR
// columns. A session read, open in KYC-only mode (this suite also runs in
// the kyc-only-on project).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memorySupabase, type Row } from "./helpers/memory-supabase";

vi.mock("server-only", () => ({}));
const db = vi.hoisted(() => ({ ref: null as null | ReturnType<typeof import("./helpers/memory-supabase").memorySupabase> }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseAdmin: () => db.ref!.client }));
const signer = vi.hoisted(() => ({ wallet: "" }));
vi.mock("@/lib/server/siws", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/siws")>()),
  verifySigned: vi.fn(async () => ({ wallet: signer.wallet, params: {}, via: "session" })),
}));

import { verifySigned } from "@/lib/server/siws";
import { SESSION_READ_ACTIONS } from "@/lib/siws-session";
import { parsePortfolioExportRecords, type PortfolioExportRecords } from "@/lib/portfolio-export";
import { POST } from "@/app/api/portfolio/export/route";

const HOLDER = "DAWSeqUCPJRJ3CFSm8hfwrsu1LdhrvEQGv9K2864pMpp";
const STRANGER = "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2";
const SALE = "Sa1e111111111111111111111111111111111111111";
const CLASS = "C1ass11111111111111111111111111111111111111";
const MINT = "4KcVAsHCdcCPpDxYPHV7ZLcTU1sfKZBLZTz3H1B5mMhx";
const USDC_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const NOW = Date.parse("2026-11-08T12:00:00Z");
const TX = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW";

const rows = (table: string): Row[] => db.ref!.rows(table);

async function call(): Promise<{ status: number; body: { ok?: boolean; data?: unknown; error?: string }; cache: string | null }> {
  const res = await POST(new Request("https://manci.test/api/portfolio/export", { method: "POST", body: "{}" }));
  return { status: res.status, body: await res.json(), cache: res.headers.get("cache-control") };
}

function seed() {
  rows("commitments").push(
    { id: "c-1", network: "devnet", investor_wallet: HOLDER, sale_pubkey: SALE, status: "settled", evidence_verified: true,
      created_at: "2026-10-02T09:00:00.000Z", units: 10, amount_atomic: 25_000_000, payment_mint: USDC_DEVNET, payment_decimals: 6, settled_tx: TX,
      terms_acceptance: { signature: TX }, amount: 25 },
    // Unverified, another wallet, another network: never exported.
    { id: "c-2", network: "devnet", investor_wallet: HOLDER, sale_pubkey: SALE, status: "settled", evidence_verified: false,
      created_at: "2026-10-03T09:00:00.000Z", units: 5, amount_atomic: 1, payment_mint: USDC_DEVNET, payment_decimals: 6, settled_tx: TX },
    { id: "c-3", network: "devnet", investor_wallet: STRANGER, sale_pubkey: SALE, status: "settled", evidence_verified: true,
      created_at: "2026-10-04T09:00:00.000Z", units: 7, amount_atomic: 1, payment_mint: USDC_DEVNET, payment_decimals: 6, settled_tx: TX },
    { id: "c-4", network: "mainnet", investor_wallet: HOLDER, sale_pubkey: SALE, status: "settled", evidence_verified: true,
      created_at: "2026-10-05T09:00:00.000Z", units: 9, amount_atomic: 1, payment_mint: USDC_DEVNET, payment_decimals: 6, settled_tx: TX },
  );
  rows("sales").push({ pda: SALE, network: "devnet", share_class_pda: CLASS, mint: MINT });
  rows("otc_requests").push(
    { id: "o-1", network: "devnet", created_at: "2026-10-06T00:00:00.000Z", updated_at: "2026-10-07T00:00:00.000Z", share_class_pda: CLASS,
      mint: MINT, asset_label: "Asset", seller_wallet: HOLDER, buyer_wallet: STRANGER, amount: 3, price: 30_000_000, payment_mint: USDC_DEVNET,
      status: "completed", deal_pda: "Dea1111111111111111111111111111111111111111", admin_note: "internal" },
    { id: "o-2", network: "devnet", created_at: "2026-10-08T00:00:00.000Z", updated_at: "2026-10-09T00:00:00.000Z", share_class_pda: CLASS,
      mint: MINT, asset_label: "Asset", seller_wallet: STRANGER, buyer_wallet: HOLDER, amount: 1, price: 9_000_000, payment_mint: USDC_DEVNET,
      status: "created", deal_pda: "Dea2222222222222222222222222222222222222222" },
    // Never reached an escrow; and a deal between two strangers.
    { id: "o-3", network: "devnet", created_at: "2026-10-08T00:00:00.000Z", updated_at: "2026-10-09T00:00:00.000Z", share_class_pda: CLASS,
      mint: MINT, asset_label: "Asset", seller_wallet: HOLDER, buyer_wallet: STRANGER, amount: 1, price: 1, payment_mint: USDC_DEVNET,
      status: "requested", deal_pda: null },
    { id: "o-4", network: "devnet", created_at: "2026-10-08T00:00:00.000Z", updated_at: "2026-10-09T00:00:00.000Z", share_class_pda: CLASS,
      mint: MINT, asset_label: "Asset", seller_wallet: STRANGER, buyer_wallet: STRANGER, amount: 1, price: 1, payment_mint: USDC_DEVNET,
      status: "completed", deal_pda: "Dea3333333333333333333333333333333333333333" },
  );
  rows("conversion_requests").push(
    { id: "r-1", network: "devnet", holder_wallet: HOLDER, created_at: "2026-10-01T00:00:00.000Z", updated_at: "2026-10-10T00:00:00.000Z",
      share_class_pda: CLASS, mint: MINT, asset_label: "Asset", amount: 2, status: "converted", vault_pda: "Vau1t11111111111111111111111111111111111111",
      deposit_tx: TX, outcome_tx: TX, contact: "+381 64 1234567", note: "passport P123", admin_note: "KYC fine", client_id: "client-1" },
    { id: "r-2", network: "devnet", holder_wallet: STRANGER, created_at: "2026-10-01T00:00:00.000Z", updated_at: "2026-10-10T00:00:00.000Z",
      share_class_pda: CLASS, mint: MINT, asset_label: "Asset", amount: 2, status: "requested", vault_pda: null, deposit_tx: null, outcome_tx: null },
  );
  rows("fx_rates").push({ network: "devnet", payment_mint: USDC_DEVNET, kind: "rate", eur_per_token: 0.85, as_of: "2026-11-05T08:00:00.000Z" });
  rows("fx_rate_observations").push(
    { network: "devnet", payment_mint: USDC_DEVNET, status: "accepted", eur_per_token: 0.861, observed_at: "2026-11-08T09:00:00.000Z" },
    { network: "devnet", payment_mint: USDC_DEVNET, status: "accepted", eur_per_token: 0.862, observed_at: "2026-11-08T11:59:00.000Z" },
    { network: "devnet", payment_mint: USDC_DEVNET, status: "refused", eur_per_token: null, observed_at: "2026-11-07T10:00:00.000Z" },
    { network: "devnet", payment_mint: USDC_DEVNET, status: "accepted", eur_per_token: 0.87, observed_at: "2026-10-01T10:00:00.000Z" },
    { network: "mainnet", payment_mint: USDC_DEVNET, status: "accepted", eur_per_token: 0.9, observed_at: "2026-11-06T10:00:00.000Z" },
  );
}

beforeEach(() => {
  db.ref = memorySupabase();
  db.ref.ordered = true;
  signer.wallet = HOLDER;
  vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  seed();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("POST /api/portfolio/export", () => {
  it("is a signed session read of the signer's own records, never cached", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.cache).toBe("private, no-store");
    expect(vi.mocked(verifySigned).mock.calls.at(-1)?.[1]).toBe("portfolio.export");
    expect(SESSION_READ_ACTIONS.has("portfolio.export")).toBe(true);
    const data = parsePortfolioExportRecords(res.body.data) as PortfolioExportRecords;
    expect(data).not.toBeNull();
    expect(data).toMatchObject({ network: "devnet", wallet: HOLDER, truncated: false });
  });

  it("exports verified purchases of this wallet and network only, with the sale's mint", async () => {
    const data = (await call()).body.data as PortfolioExportRecords;
    expect(data.purchases).toEqual([{
      id: "c-1", created_at: "2026-10-02T09:00:00.000Z", sale: SALE, share_class_pda: CLASS, mint: MINT, units: "10",
      amount_atomic: "25000000", payment_mint: USDC_DEVNET, payment_decimals: 6, signature: TX,
    }]);
  });

  it("exports the wallet's side of deals that reached an escrow, never the counterparty", async () => {
    const data = (await call()).body.data as PortfolioExportRecords;
    expect(data.otc.map((o) => [o.id, o.side, o.status, o.price])).toEqual([["o-1", "seller", "completed", "30000000"], ["o-2", "buyer", "created", "9000000"]]);
    expect(JSON.stringify(data.otc)).not.toContain(STRANGER);
    expect(JSON.stringify(data.otc)).not.toContain("internal");
  });

  it("exports conversions without contact, note, admin note or dossier link", async () => {
    const data = (await call()).body.data as PortfolioExportRecords;
    expect(data.conversions.map((c) => c.id)).toEqual(["r-1"]);
    const json = JSON.stringify(data.conversions);
    for (const secret of ["+381", "passport", "KYC fine", "client-1", "contact", "note"]) expect(json).not.toContain(secret);
  });

  it("gives each day of the window its last accepted automatic rate, else the manual rate dated that day", async () => {
    const data = (await call()).body.data as PortfolioExportRecords;
    // 2026-10-01 is outside the 31-day window; the refused run and the other network never count.
    expect(data.fx).toEqual({
      payment_mint: USDC_DEVNET,
      available: true,
      rates: [
        { day: "2026-11-05", eur_per_token: "0.85", source: "manual" },
        { day: "2026-11-08", eur_per_token: "0.862", source: "auto" },
      ],
    });
  });

  it("reads the manual rate alone before 0080 (no observations table)", async () => {
    db.ref!.failReads.add("fx_rate_observations");
    db.ref!.readErrorCodes.fx_rate_observations = "42P01";
    const data = (await call()).body.data as PortfolioExportRecords;
    expect(data.fx.available).toBe(true);
    expect(data.fx.rates).toEqual([{ day: "2026-11-05", eur_per_token: "0.85", source: "manual" }]);
  });

  it("still answers when the rates cannot be read: the EUR columns stay empty", async () => {
    db.ref!.failReads.add("fx_rates");
    const res = await call();
    expect(res.status).toBe(200);
    expect((res.body.data as PortfolioExportRecords).fx).toEqual({ payment_mint: USDC_DEVNET, rates: [], available: false });
  });

  it.each(["commitments", "sales", "otc_requests", "conversion_requests"])("answers 503 when %s cannot be read", async (table) => {
    db.ref!.failReads.add(table);
    const res = await call();
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/unavailable/);
  });

  it("answers 503 for a row it cannot read rather than dropping it", async () => {
    rows("commitments")[0].units = "ten";
    expect((await call()).status).toBe(503);
  });

  it("returns empty lists for a wallet without records", async () => {
    signer.wallet = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
    const data = (await call()).body.data as PortfolioExportRecords;
    expect(data).toMatchObject({ purchases: [], otc: [], conversions: [] });
  });
});
