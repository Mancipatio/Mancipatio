// D1 / O-9 (design 8.3 §5, K1.4): a trade or transfer by a FROZEN issuer's
// authority wallet raises a high alert from the alarm queue. Pure detection,
// the account indices pinned to the IDL, and the job integration with a
// mocked Supabase.
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({ txs: {} as Record<string, unknown> }));
vi.mock("@/lib/network", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/network")>()),
  detectNetwork: () => "devnet",
}));
vi.mock("@/lib/server/sale-capacity-chain", () => ({
  finalizedTransaction: vi.fn(async (sig: string) => state.txs[sig] ?? null),
}));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseAdmin: () => { throw new Error("not in tests"); } }));

import type { Address } from "@solana/kit";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  getCreateOfferInstructionDataEncoder,
  getCreateOtcDealInstructionDataEncoder,
  getDepositOtcPaymentInstructionDataEncoder,
  getSetPauseFlagsInstructionDataEncoder,
  getTakeOfferInstructionDataEncoder,
} from "@/lib/generated/asset_registry";
import { TRANSFER_HOOK_PROGRAM_ADDRESS } from "@/lib/generated/transfer_hook";
import { findBlockEntryPda } from "@/lib/pdas";
import {
  FROZEN_WALLET_ACCOUNTS,
  HOOK_EXECUTE_DISCRIMINATOR,
  frozenIssuerActivity,
  frozenIssuerAlerts,
  isTradeOrTransfer,
  loadFrozenIssuerWallets,
  type FrozenIssuerWallets,
} from "@/lib/server/frozen-issuer-activity";
import { processEventJob, type EventJob } from "@/lib/server/onchain-alarms";
import { SOURCE_LABELS } from "@/lib/server/system-alerts";
import { buildTx, type Ix } from "./helpers/chain-tx";

const R = ASSET_REGISTRY_PROGRAM_ADDRESS;
const H = TRANSFER_HOOK_PROGRAM_ADDRESS;
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ISSUER_WALLET = "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2";
const ISSUER_PDA = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const OTHER = "8sHgqRqBEXaSkhcyzXtY3vBSfGqBbTeR2SkVFDcxrfd9";
const ADMIN = "Vote111111111111111111111111111111111111111";
const SIG = "5".repeat(88);
const filler = (n: number) => Array.from({ length: n }, (_, i) => ["Stake11111111111111111111111111111111111111", "Config1111111111111111111111111111111111111"][i % 2]);
const bytes = (e: { encode: (v: never) => ArrayLike<number> }, v: unknown) => new Uint8Array(e.encode(v as never));

let frozen: FrozenIssuerWallets;
beforeEach(async () => {
  state.txs = {};
  frozen = new Map([[ISSUER_WALLET, { issuer: ISSUER_PDA, blockEntry: await findBlockEntryPda(ISSUER_WALLET as Address) }]]);
});

const tx = (ixs: { ix: Ix; inner?: Ix[] }[], payer = OTHER) => buildTx({ signature: SIG, payer, instructions: ixs, logs: null }).tx;
const withAccount = (n: number, at: number, key: string) => filler(n).map((k, i) => (i === at ? key : k));

describe("frozen issuer activity (pure)", () => {
  it("pins every account index to the IDL account order", () => {
    const idl = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "idl", "asset_registry.json"), "utf8")) as { instructions: { name: string; accounts: { name: string }[] }[] };
    const expected: Record<string, string> = { "offer maker": "maker", "offer taker": "taker", "OTC seller": "seller", "OTC buyer": "buyer" };
    for (const spec of FROZEN_WALLET_ACCOUNTS) {
      const ix = idl.instructions.find((i) => i.name === spec.name)!;
      const name = ix.accounts[spec.index].name;
      if (spec.holds === "wallet") expect(name, `${spec.name}#${spec.index}`).toBe(expected[spec.role]);
      else expect(name, `${spec.name}#${spec.index}`).toBe(spec.role === "offer maker" ? "maker_block_entry" : "seller_block_entry");
    }
  });

  it("matches a frozen wallet as a signer, the maker of a taken offer, a named OTC party and a hooked transfer's source owner", async () => {
    // create_offer signed by the frozen wallet.
    const offer = { program: R, accounts: withAccount(10, 0, ISSUER_WALLET), data: bytes(getCreateOfferInstructionDataEncoder(), { offerId: 1, amount: 1, price: 1, expiresAt: 1 }) };
    expect(frozenIssuerActivity(tx([{ ix: offer }], ISSUER_WALLET), frozen)).toEqual([
      { wallet: ISSUER_WALLET, issuer: ISSUER_PDA, roles: ["offer maker", "signer"], instructions: ["create_offer", "transaction"] },
    ]);
    // take_offer by someone else: the maker is known only by its block-entry PDA.
    const take = { program: R, accounts: withAccount(14, 13, frozen.get(ISSUER_WALLET)!.blockEntry), data: bytes(getTakeOfferInstructionDataEncoder(), {}) };
    expect(frozenIssuerActivity(tx([{ ix: take }]), frozen)).toMatchObject([{ wallet: ISSUER_WALLET, roles: ["offer maker"], instructions: ["take_offer"] }]);
    // The buyer settles an OTC deal whose seller is frozen.
    const pay = { program: R, accounts: withAccount(15, 14, frozen.get(ISSUER_WALLET)!.blockEntry), data: bytes(getDepositOtcPaymentInstructionDataEncoder(), {}) };
    expect(frozenIssuerActivity(tx([{ ix: pay }]), frozen)).toMatchObject([{ roles: ["OTC seller"], instructions: ["deposit_otc_payment"] }]);
    // An Admin creates a deal naming the frozen wallet as seller.
    const deal = { program: R, accounts: withAccount(13, 0, ADMIN), data: bytes(getCreateOtcDealInstructionDataEncoder(), {
      dealId: 1, buyer: OTHER as Address, seller: ISSUER_WALLET as Address, amount: 1, price: 1, paymentMint: OTHER as Address, expiresAt: 1 }) };
    expect(frozenIssuerActivity(tx([{ ix: deal }], ADMIN), frozen)).toMatchObject([{ roles: ["OTC seller"], instructions: ["create_otc_deal"] }]);
    // A Token-2022 transfer: the hook's Execute (a CPI) names the source owner at 3, here a delegate signs.
    const execute = { program: H, accounts: [OTHER, OTHER, OTHER, ISSUER_WALLET, OTHER], data: new Uint8Array([...HOOK_EXECUTE_DISCRIMINATOR, 1, 0, 0, 0, 0, 0, 0, 0]) };
    const transfer = tx([{ ix: { program: TOKEN_2022, accounts: [OTHER], data: new Uint8Array([12]) }, inner: [execute] }]);
    expect(isTradeOrTransfer(transfer)).toBe(true);
    expect(frozenIssuerActivity(transfer, frozen)).toMatchObject([{ roles: ["transfer source owner"], instructions: ["token transfer"] }]);
  });

  it("nothing for another wallet, no freeze, or a transaction that neither trades nor transfers", () => {
    const offer = { program: R, accounts: withAccount(10, 0, OTHER), data: bytes(getCreateOfferInstructionDataEncoder(), { offerId: 1, amount: 1, price: 1, expiresAt: 1 }) };
    expect(frozenIssuerActivity(tx([{ ix: offer }]), frozen)).toEqual([]);
    expect(frozenIssuerActivity(tx([{ ix: offer }], ISSUER_WALLET), new Map())).toEqual([]);
    const pause = { program: R, accounts: filler(3), data: bytes(getSetPauseFlagsInstructionDataEncoder(), { setMask: 1, clearMask: 0 }) };
    expect(isTradeOrTransfer(tx([{ ix: pause }], ISSUER_WALLET))).toBe(false);
    expect(frozenIssuerActivity(tx([{ ix: pause }], ISSUER_WALLET), frozen)).toEqual([]);
  });

  it("alerts are high, minimal, one per issuer and transaction, with a known label", () => {
    const [alert] = frozenIssuerAlerts(SIG, [{ wallet: ISSUER_WALLET, issuer: ISSUER_PDA, roles: ["signer"], instructions: ["transaction"] }]);
    expect(alert).toMatchObject({ dedupKey: `onchain:${SIG}:frozen-issuer:${ISSUER_PDA}`, source: "onchain:frozen-issuer-activity", severity: "high",
      evidence: { issuer: ISSUER_PDA, roles: ["signer"] } });
    expect(JSON.stringify(alert.evidence)).not.toContain(ISSUER_WALLET);
    expect(SOURCE_LABELS[alert.source]).toMatchObject({ format: "minimal" });
  });
});

/** Supabase: the two mirror reads, the alert rpc and the job update. */
function mockSb(mirror: { freezes?: { issuer_pda: string }[]; issuers?: { pda: string; authority: string }[]; error?: string } = {}) {
  const calls: { kind: string; table?: string; fn?: string; args?: unknown }[] = [];
  const read = (table: string) => {
    calls.push({ kind: "select", table });
    const rows = table === "issuer_freezes" ? mirror.freezes ?? [] : mirror.issuers ?? [];
    const b: Record<string, unknown> = {};
    for (const m of ["eq", "neq", "in", "lte", "order", "limit", "select"]) b[m] = () => b;
    b.abortSignal = () => Promise.resolve(mirror.error === table ? { data: null, error: { code: "08006" } } : { data: rows, error: null });
    return b;
  };
  const write = (kind: string, table: string, args: unknown) => {
    calls.push({ kind, table, args });
    const b: Record<string, unknown> = {};
    for (const m of ["eq", "neq", "in", "lte", "order", "limit", "select"]) b[m] = () => b;
    b.abortSignal = () => Promise.resolve({ data: null, error: null });
    return b;
  };
  const sb = {
    from: (table: string) => ({
      select: () => read(table),
      update: (args: unknown) => write("update", table, args),
      upsert: (args: unknown) => write("upsert", table, args),
    }),
    rpc: (fn: string, args: unknown) => {
      calls.push({ kind: "rpc", fn, args });
      return { abortSignal: () => Promise.resolve({ data: { id: "a", inserted: true }, error: null }) };
    },
  };
  return { sb: sb as never, calls };
}
const job = (): EventJob => ({
  id: "0b6f7a52-3c1d-4e8f-9a2b-5c6d7e8f9a0b", network: "devnet", signature: SIG, source: "webhook", status: "pending",
  attempts: 0, created_at: new Date().toISOString(),
});

describe("processEventJob: frozen issuer activity", () => {
  const takeByFrozenMaker = async () => {
    const take = { program: R, accounts: withAccount(14, 13, await findBlockEntryPda(ISSUER_WALLET as Address)), data: bytes(getTakeOfferInstructionDataEncoder(), {}) };
    state.txs[SIG] = tx([{ ix: take }]);
  };

  it("raises one high alert when a frozen issuer's offer is taken, and counts it on the job", async () => {
    await takeByFrozenMaker();
    const { sb, calls } = mockSb({ freezes: [{ issuer_pda: ISSUER_PDA }], issuers: [{ pda: ISSUER_PDA, authority: ISSUER_WALLET }] });
    expect(await processEventJob(job(), AbortSignal.timeout(5_000), Date.now() + 5_000, sb)).toBe("complete");
    const alerts = calls.filter((c) => c.fn === "raise_system_alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0].args).toMatchObject({ p_source: "onchain:frozen-issuer-activity", p_severity: "high", p_tx_signature: SIG,
      p_evidence: { issuer: ISSUER_PDA, roles: ["offer maker"] } });
    expect(calls.filter((c) => c.kind === "update").at(-1)?.args).toMatchObject({ status: "complete", alerts: 1 });
  });

  it("no freeze: no alert; an unreadable mirror keeps the job pending (never a silent miss)", async () => {
    await takeByFrozenMaker();
    let m = mockSb();
    expect(await processEventJob(job(), AbortSignal.timeout(5_000), Date.now() + 5_000, m.sb)).toBe("complete");
    expect(m.calls.some((c) => c.fn === "raise_system_alert")).toBe(false);
    m = mockSb({ freezes: [{ issuer_pda: ISSUER_PDA }], error: "issuers" });
    expect(await processEventJob(job(), AbortSignal.timeout(5_000), Date.now() + 5_000, m.sb)).toBe("pending");
    expect(m.calls.filter((c) => c.kind === "update").at(-1)?.args).toMatchObject({ last_error: "DB_UNAVAILABLE" });
  });

  it("a transaction that neither trades nor transfers never reads the mirror", async () => {
    state.txs[SIG] = tx([{ ix: { program: R, accounts: filler(3), data: bytes(getSetPauseFlagsInstructionDataEncoder(), { setMask: 1, clearMask: 0 }) } }], ISSUER_WALLET);
    const { sb, calls } = mockSb({ freezes: [{ issuer_pda: ISSUER_PDA }], issuers: [{ pda: ISSUER_PDA, authority: ISSUER_WALLET }] });
    expect(await processEventJob(job(), AbortSignal.timeout(5_000), Date.now() + 5_000, sb)).toBe("complete");
    expect(calls.some((c) => c.kind === "select")).toBe(false);
  });

  it("loadFrozenIssuerWallets: empty before 0079, the issuers' authorities with their block-entry PDAs", async () => {
    const missing = { from: () => ({ select: () => { const b: Record<string, unknown> = {}; for (const m of ["eq", "limit", "in"]) b[m] = () => b; b.abortSignal = () => Promise.resolve({ data: null, error: { code: "42P01" } }); return b; } }) };
    expect((await loadFrozenIssuerWallets(missing as never, "devnet", AbortSignal.timeout(1_000))).size).toBe(0);
    const { sb } = mockSb({ freezes: [{ issuer_pda: ISSUER_PDA }], issuers: [{ pda: ISSUER_PDA, authority: ISSUER_WALLET }] });
    const wallets = await loadFrozenIssuerWallets(sb, "devnet", AbortSignal.timeout(1_000));
    expect(wallets.get(ISSUER_WALLET)).toEqual({ issuer: ISSUER_PDA, blockEntry: await findBlockEntryPda(ISSUER_WALLET as Address) });
  });
});
