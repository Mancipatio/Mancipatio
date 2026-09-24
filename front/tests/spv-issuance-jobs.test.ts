// Talas 5.1: the ledger stage (spv_issuance_jobs). The chain (RPC) and
// Supabase are mocked; lib/server/sale-capacity.ts runs for real.
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const s = vi.hoisted(() => ({
  sale: null as Record<string, unknown> | null,
  txs: {} as Record<string, unknown>,
  sigs: [] as Array<{ signature: string; blockTime: number; err: null }>,
  tables: {} as Record<string, Record<string, unknown>[]>,
  rpc: {} as Record<string, unknown>,
  rpcErrors: {} as Record<string, { code: string; message: string }>,
  calls: [] as Array<{ kind: string; target: string; args: unknown }>,
}));
vi.mock("@/lib/network", async (orig) => ({ ...(await orig<typeof import("@/lib/network")>()), detectNetwork: () => "devnet" }));
vi.mock("@/lib/server/rpc", () => ({
  getServerRpc: () => ({ getSignaturesForAddress: () => ({ send: async () => s.sigs }) }),
}));
vi.mock("@/lib/server/maintenance", () => ({ readMaintenance: async () => ({ enabled: false, fresh: true }) }));
vi.mock("@/lib/server/sale-capacity-chain", () => ({
  finalizedTransaction: vi.fn(async (sig: string) => s.txs[sig] ?? null),
  listFinalizedSignatures: vi.fn(async () => ({ signatures: [], complete: true })),
  listLiveApprovals: vi.fn(async () => []),
  readApprovalAndSale: vi.fn(async () => ({ approval: null, sale: null })),
}));
vi.mock("@/lib/generated/asset_registry", async (orig) => {
  const o = await orig<typeof import("@/lib/generated/asset_registry")>();
  const acc = (data: Record<string, unknown> | null) => (data ? { exists: true, programAddress: o.ASSET_REGISTRY_PROGRAM_ADDRESS, data } : { exists: false });
  return {
    ...o,
    fetchMaybeSale: vi.fn(async () => acc(s.sale)),
    fetchMaybeShareClass: vi.fn(async () => acc({ asset: ASSET })),
    fetchMaybeAsset: vi.fn(async () => acc({ issuer: ISSUER })),
  };
});
vi.mock("@/lib/supabase-server", () => ({
  getSupabaseAdmin: () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      const f: Record<string, unknown> = {};
      for (const k of ["select", "in", "lte", "gte", "order", "limit", "neq", "not", "is"]) b[k] = () => b;
      b.eq = (c: string, v: unknown) => { f[c] = v; return b; };
      const write = (kind: string) => (args: unknown) => { s.calls.push({ kind, target: table, args }); return b; };
      b.update = write("update"); b.insert = write("insert"); b.upsert = write("upsert");
      // The mint-key lookup filters on mint_signature; everything else returns the table.
      const rows = () => (s.tables[table] ?? []).filter((r) => !("mint_signature" in f) || r.mint_signature === f.mint_signature);
      b.maybeSingle = () => ({ ...Promise.resolve(), abortSignal: undefined, then: (r: (v: unknown) => unknown) => Promise.resolve({ data: rows()[0] ?? null, error: null }).then(r) });
      b.abortSignal = () => b;
      b.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: rows(), error: null }).then(resolve);
      return b;
    },
    rpc: (fn: string, args: unknown) => {
      s.calls.push({ kind: "rpc", target: fn, args });
      const result = s.rpcErrors[fn] ? { data: null, error: s.rpcErrors[fn] } : { data: s.rpc[fn] ?? null, error: null };
      return Object.assign(Promise.resolve(result), { abortSignal: () => Promise.resolve(result) });
    },
  }),
}));

import { getSupabaseAdmin } from "@/lib/supabase-server";
import {
  CLOSE_SALE_DISCRIMINATOR,
  RaiseType,
  SaleStatus,
  getMintToTreasuryInstructionDataEncoder,
} from "@/lib/generated/asset_registry";
import { processIssuanceJob, type IssuanceJob } from "@/lib/server/spv-issuance-jobs";
import { buildTx } from "./helpers/chain-tx";

const R = "FJs1EM1ND89L9sUXaS8VBKYXjmoXCkkVSJKRE19hmYxS";
const ADMIN = "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2";
const ISSUER = "Issuer111111111111111111111111111111111111";
const ASSET = "Asset11111111111111111111111111111111111111";
const SC = "ShareC1ass111111111111111111111111111111111";
const MINT = "EURCmint11111111111111111111111111111111111";
const SALE = "SysvarRent111111111111111111111111111111111";
const APPROVAL = "Approva1111111111111111111111111111111111111";
const DEST = "Dest111111111111111111111111111111111111111";
const SIG = "5".repeat(88);
const RID = "1b6f7a52-3c1d-4e8f-9a2b-5c6d7e8f9a0c";
const CLOSE_SIG = "3".repeat(88);
const BLOCK = 1_760_000_000; // 2025-10-09

const job = (over: Partial<IssuanceJob> = {}): IssuanceJob => ({
  id: "0b6f7a52-3c1d-4e8f-9a2b-5c6d7e8f9a0b", network: "devnet", kind: "sale_close", ref: SALE, share_class_pda: SC,
  observed_signature: null, closed_at: null, closed_signature: null, issued_at_source: null, status: "pending", attempts: 0,
  created_at: new Date().toISOString(), ...over,
});
const reservation = (over: Record<string, unknown> = {}) => ({
  id: RID, network: "devnet", kind: "sale", share_class_pda: SC, approval_pda: APPROVAL, sale_pda: SALE, issuer_pda: ISSUER,
  subject: `issuer:${ISSUER}`, spv_id: null, payment_mint: MINT, payment_decimals: 6, max_gross_raise: "1000000",
  status: "consumed", fx_kind: "eur_peg", fx_rate: 1, amount_eur: 1, reserved_by: ADMIN, created_at: new Date().toISOString(), ...over,
});
const closedSale = () => ({
  saleApproval: APPROVAL, shareClass: SC, saleId: BigInt(4), paymentMint: MINT, pricePerUnit: BigInt(10), totalForSale: BigInt(100_000), sold: BigInt(40_000),
  status: SaleStatus.Closed, raiseType: RaiseType.Mature, cliffMonths: 0, vestingMonths: 0, applicationHash: new Uint8Array(32),
});
const closeTx = (sig: string, sale = SALE) => buildTx({ signature: sig, blockTime: BLOCK,
  instructions: [{ ix: { program: R, accounts: [ADMIN, sale], data: new Uint8Array(CLOSE_SALE_DISCRIMINATOR) } }] }).tx;
const mintTx = (units: bigint[], owner = ADMIN, inner = false) => {
  const data = new Uint8Array(getMintToTreasuryInstructionDataEncoder().encode({ amount: units[0] }));
  const mint = { program: R, accounts: [ADMIN, "AdminRec1111111111111111111111111111111111", ISSUER, ASSET, SC, "Mint111111111111111111111111111111111111111", DEST, "Tok11111111111111111111111111111111111111111", "P1atform11111111111111111111111111111111111"], data };
  const ixs = units.map((u) => ({ ...mint, data: new Uint8Array(getMintToTreasuryInstructionDataEncoder().encode({ amount: u })) }));
  const built = buildTx({ signature: SIG, blockTime: BLOCK, payer: ADMIN,
    instructions: inner ? [{ ix: { program: "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf", accounts: [], data: new Uint8Array([1]) }, inner: ixs }] : ixs.map((ix) => ({ ix })) });
  built.tx.meta.postTokenBalances = [{ accountIndex: built.keys.indexOf(DEST), mint: "Mint111111111111111111111111111111111111111", owner }];
  return built.tx;
};
const rpcArgs = (fn: string) => s.calls.filter((c) => c.kind === "rpc" && c.target === fn).map((c) => c.args as Record<string, unknown>);
const jobUpdate = () => s.calls.filter((c) => c.kind === "update" && c.target === "spv_issuance_jobs").at(-1)?.args as Record<string, unknown>;
const run = (j: IssuanceJob) => processIssuanceJob(getSupabaseAdmin(), j, AbortSignal.timeout(5_000), Date.now() + 5_000);

beforeEach(() => {
  Object.assign(s, { sale: closedSale(), txs: {}, sigs: [], tables: {}, rpcErrors: {}, calls: [] });
  s.rpc = { book_sale_reservation: reservation({ status: "booked", booked_amount_eur: 400 }), sale_capacity_spv: null };
});

describe("sale_close jobs", () => {
  it("a closed-unsold (backfilled) sale is complete: no adoption, no booking, no alert", async () => {
    s.tables.sale_capacity_reservations = [reservation({ status: "released", release_reason: "closed_unsold" })];
    expect(await run(job({ closed_at: new Date().toISOString() }))).toBe("complete");
    expect(rpcArgs("adopt_sale_approval")).toEqual([]);
    expect(rpcArgs("book_sale_reservation")).toEqual([]);
    expect(rpcArgs("raise_system_alert")).toEqual([]);
    expect(jobUpdate()).toMatchObject({ status: "complete", reservation_id: RID, subject: `issuer:${ISSUER}` });
  });

  it("proves the close date from the observed signature and books at that UTC date", async () => {
    s.txs[CLOSE_SIG] = closeTx(CLOSE_SIG);
    s.tables.sale_capacity_reservations = [reservation()];
    expect(await run(job({ observed_signature: CLOSE_SIG }))).toBe("complete");
    const proof = s.calls.find((c) => c.kind === "update" && c.target === "spv_issuance_jobs")!.args;
    expect(proof).toMatchObject({ closed_signature: CLOSE_SIG, issued_at_source: "chain", closed_at: new Date(BLOCK * 1000).toISOString() });
    expect(rpcArgs("book_sale_reservation")[0]).toMatchObject({ p_id: RID, p_gross_base_units: "400000", p_issued_at: "2025-10-09" });
  });

  it("finds the close by scanning the sale's signatures, else falls back to the observation date", async () => {
    s.sigs = [{ signature: "6".repeat(88), blockTime: BLOCK + 10, err: null }, { signature: CLOSE_SIG, blockTime: BLOCK, err: null }];
    s.txs[CLOSE_SIG] = closeTx(CLOSE_SIG);
    s.txs["6".repeat(88)] = closeTx("6".repeat(88), "Other1111111111111111111111111111111111111");
    s.tables.sale_capacity_reservations = [reservation()];
    await run(job({ observed_signature: "4".repeat(88) }));
    expect(s.calls.find((c) => c.target === "spv_issuance_jobs")!.args).toMatchObject({ closed_signature: CLOSE_SIG, issued_at_source: "chain" });
    s.calls = []; s.sigs = [];
    await run(job());
    expect(s.calls.find((c) => c.target === "spv_issuance_jobs")!.args).toMatchObject({ closed_signature: null, issued_at_source: "observed" });
  });

  it("adopts an uncovered sale, alerts ADOPTED, and books it", async () => {
    s.rpc.adopt_sale_approval = reservation({ status: "reserved", action: "inserted", over_cap: true, adopted: true });
    s.rpc.consume_sale_reservation = reservation({ status: "consumed" });
    expect(await run(job({ closed_at: new Date().toISOString() }))).toBe("complete");
    expect(rpcArgs("adopt_sale_approval")[0]).toMatchObject({ p_sale_pda: SALE, p_approval_pda: APPROVAL });
    expect(rpcArgs("raise_system_alert")[0]).toMatchObject({ p_source: "ledger:adopted", p_severity: "critical" });
    expect(rpcArgs("book_sale_reservation")).toHaveLength(1);
  });

  it("no EUR rate: the subject is put on hold, fx-missing raised, the job waits 30 minutes (then unblocks)", async () => {
    s.rpcErrors.adopt_sale_approval = { code: "P0001", message: "FX_RATE_MISSING" };
    const before = Date.now();
    expect(await run(job({ closed_at: new Date().toISOString() }))).toBe("pending");
    expect(rpcArgs("place_capacity_hold")[0]).toMatchObject({ p_subject: `issuer:${ISSUER}`, p_ref: SALE, p_code: "ADOPTION_PENDING", p_payment_mint: MINT });
    expect(rpcArgs("report_incident")[0]).toMatchObject({ p_check: `fx-missing:${MINT}`, p_state: "fail", p_severity: "high" });
    expect(jobUpdate()).toMatchObject({ last_error: "FX_RATE_MISSING" });
    expect(Date.parse(String(jobUpdate().next_attempt_at)) - before).toBeGreaterThanOrEqual(30 * 60_000 - 1000);
    // The rate exists now: adopted, booked, the hold cleared.
    s.rpcErrors = {}; s.calls = [];
    s.rpc.adopt_sale_approval = reservation({ status: "reserved", action: "inserted", over_cap: false });
    s.rpc.consume_sale_reservation = reservation({ status: "consumed" });
    expect(await run(job({ closed_at: new Date().toISOString() }))).toBe("complete");
    expect(rpcArgs("clear_capacity_hold").map((a) => a.p_ref)).toContain(SALE);
  });

  it("flags over_cap and a linked legacy row with a different amount", async () => {
    s.tables.sale_capacity_reservations = [reservation()];
    s.rpc.book_sale_reservation = reservation({ status: "booked", over_cap: true, linked_existing: true, amount_mismatch: true, linked_amount_eur: 70, booked_amount_eur: 400 });
    await run(job({ closed_at: new Date().toISOString() }));
    const sources = rpcArgs("raise_system_alert").map((a) => `${a.p_source}/${a.p_severity}`);
    expect(sources).toEqual(["ledger:over-cap/critical", "ledger:linked-existing/high"]);
  });
});

describe("treasury_mint jobs", () => {
  const tjob = () => job({ kind: "treasury_mint", ref: SIG });

  it("matches the reservation and books it at the block date", async () => {
    s.txs[SIG] = mintTx([BigInt(500)]);
    s.tables.sale_capacity_reservations = [reservation({ kind: "treasury_mint", status: "reserved", amount_units: "500", mint_signature: null })];
    s.rpc.book_treasury_mint = reservation({ kind: "treasury_mint", status: "booked" });
    expect(await run(tjob())).toBe("complete");
    expect(rpcArgs("book_treasury_mint")[0]).toMatchObject({ p_id: RID, p_signature: SIG, p_issued_at: "2025-10-09" });
  });

  it("an unreserved mint (also inside a Squads CPI) is adopted at the floor and alerted; an escrow mint is not counted", async () => {
    s.txs[SIG] = mintTx([BigInt(500)], ADMIN, true);
    s.rpc.adopt_treasury_mint = { ...reservation({ kind: "treasury_mint", status: "booked" }), action: "adopted", basis: "minimum", fx_stale: false, over_cap: false };
    expect(await run(tjob())).toBe("complete");
    expect(rpcArgs("adopt_treasury_mint")[0]).toMatchObject({ p_mint_key: SIG, p_authority: ADMIN, p_amount_units: "500", p_issued_at: "2025-10-09" });
    expect(rpcArgs("raise_system_alert")[0]).toMatchObject({ p_source: "ledger:unreserved-mint", p_severity: "critical" });
    s.calls = [];
    s.txs[SIG] = mintTx([BigInt(500)], "Someone111111111111111111111111111111111111");
    expect(await run(tjob())).toBe("complete");
    expect(rpcArgs("adopt_treasury_mint")).toEqual([]);
  });

  it("a transaction with two mints counts each under its own key (sig:<ordinal>)", async () => {
    s.txs[SIG] = mintTx([BigInt(500), BigInt(7)]);
    s.rpc.adopt_treasury_mint = { ...reservation({ kind: "treasury_mint", status: "booked" }), action: "adopted", basis: "sale_price", fx_stale: false, over_cap: false };
    await run(tjob());
    expect(rpcArgs("adopt_treasury_mint").map((a) => a.p_mint_key)).toEqual([`${SIG}:0`, `${SIG}:1`]);
  });

  it("no EUR rate for the floor's mint: hold and pending", async () => {
    s.txs[SIG] = mintTx([BigInt(500)]);
    s.rpcErrors.adopt_treasury_mint = { code: "P0001", message: "FX_RATE_MISSING" };
    s.rpc.treasury_mint_floor = { payment_mint: MINT };
    expect(await run(tjob())).toBe("pending");
    expect(rpcArgs("place_capacity_hold")[0]).toMatchObject({ p_ref: SIG, p_code: "ADOPTION_PENDING", p_payment_mint: MINT });
  });
});
