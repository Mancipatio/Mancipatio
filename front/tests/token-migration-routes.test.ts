// The token migration routes (app/api/token-migrations) against an in-memory
// database: the holder's precheck and record, the admin's save, transitions,
// reconcile and settlement records, and the public reads. The routes, the
// server library (lib/server/token-migrations.ts), the evidence and the
// ratio run for real; the signature, the admin gate, the chain reads, the
// finalized-transaction read and the sanctions screen are stubbed, and the
// two recording functions of migration 0085 are emulated (their SQL is
// tested in tests/token-migrations.postgres.test.ts).
import { getAddressDecoder, getBase58Decoder } from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memorySupabase } from "./helpers/memory-supabase";

vi.mock("server-only", () => ({}));
const db = vi.hoisted(() => ({ ref: null as null | ReturnType<typeof import("./helpers/memory-supabase").memorySupabase> }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseAdmin: () => db.ref!.client }));
const signer = vi.hoisted(() => ({ wallet: "", params: {} as Record<string, unknown>, action: "" }));
vi.mock("@/lib/server/siws", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/siws")>()),
  verifySigned: vi.fn(async (_request: Request, action: string) => {
    signer.action = action;
    return { wallet: signer.wallet, params: signer.params, via: "signature" };
  }),
}));
const admins = vi.hoisted(() => ({ list: new Set<string>() }));
vi.mock("@/lib/server/admin-gate", async () => {
  const { SiwsError } = await import("@/lib/server/siws-error");
  return { requireAdmin: vi.fn(async (wallet: string) => { if (!admins.list.has(wallet)) throw new SiwsError(403, "Admin privileges required"); }) };
});
vi.mock("@/lib/server/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/audit")>()),
  writeServerAudit: vi.fn(async () => "audit-id"),
}));
const chain = vi.hoisted(() => ({
  readOldMint: vi.fn(),
  readExcludedBalances: vi.fn(),
  readShareClassFacts: vi.fn(),
  readDepositAccount: vi.fn(),
  readHolderBalance: vi.fn(),
  depositAccountPage: vi.fn(),
  readFinalizedSlot: vi.fn(),
}));
vi.mock("@/lib/server/token-migration-chain", () => chain);
const limiter = vi.hoisted(() => ({ result: "ok" as "ok" | "limited" | "unavailable" }));
vi.mock("@/lib/server/shared-rate-limit", () => ({ consumeSharedRateLimit: vi.fn(async () => limiter.result) }));
const txs = vi.hoisted(() => ({ map: new Map<string, unknown>(), pending: new Set<string>() }));
vi.mock("@/lib/server/chain-evidence", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/server/chain-evidence")>();
  return {
    ...real,
    readFinalizedTransaction: vi.fn(async (signature: string) => {
      if (txs.pending.has(signature)) throw new real.AwaitingFinalizationError("not finalized yet");
      const tx = txs.map.get(signature);
      if (!tx) throw new real.AwaitingFinalizationError("unknown");
      return tx;
    }),
  };
});
const screen = vi.hoisted(() => ({ listed: new Set<string>(), unavailable: false }));
vi.mock("@/lib/server/sanctions", async () => {
  const { SiwsError } = await import("@/lib/server/siws-error");
  return {
    requireSanctionsClear: vi.fn(async (_sb: unknown, input: { wallets: { wallet: string }[] }) => {
      if (screen.unavailable) throw new SiwsError(503, "Sanctions screening is unavailable");
      if (input.wallets.some((w) => screen.listed.has(w.wallet))) throw new SiwsError(403, "This wallet cannot be used on Manci");
    }),
    reportSanctionsHits: vi.fn(async (_sb: unknown, input: { wallets: { wallet: string }[] }) => ({
      hits: screen.unavailable ? [] : input.wallets.map((w) => w.wallet).filter((w) => screen.listed.has(w)),
      retryLater: screen.unavailable,
    })),
  };
});

import { PILOT_MODULE_ENV, moduleDisabledMessage } from "@/lib/features";
import { MEMO_PROGRAM_ADDRESS } from "@/lib/document-terms";
import { migrationMemoText, TOKEN_PROGRAM_2022, TOKEN_PROGRAM_CLASSIC } from "@/lib/token-migration/model";
import { associatedTokenAccount } from "@/lib/token-migration/transactions";
import { sha256Hex } from "@/lib/token-migration/report";
import { TOS_VERSION } from "@/lib/tos-version";
import { POST as precheck } from "@/app/api/token-migrations/precheck/route";
import { POST as recordDeposit } from "@/app/api/token-migrations/record/route";
import { POST as adminSave } from "@/app/api/token-migrations/admin/save/route";
import { POST as adminTransition } from "@/app/api/token-migrations/admin/transition/route";
import { POST as adminRecord } from "@/app/api/token-migrations/admin/record/route";
import { POST as adminReconcile } from "@/app/api/token-migrations/admin/reconcile/route";
import { POST as adminList } from "@/app/api/token-migrations/admin/list/route";
import { GET as publicRead } from "@/app/api/token-migrations/public/route";
import { GET as reportRead } from "@/app/api/token-migrations/report/route";

const key = (seed: number) => getAddressDecoder().decode(new Uint8Array(32).fill(seed)).toString();
const B = (v: number | string) => BigInt(v);
const b58 = getBase58Decoder();
const NOW = Date.parse("2027-02-01T12:00:00Z");

const ADMIN = key(1);
const HOLDER = key(2);
const OTHER = key(3);
const OLD_MINT = key(4);
const NEW_MINT = key(5);
const DEPOSIT_OWNER = key(6);
const TREASURY = key(7);
const SHARE_CLASS = key(8);
const ASSET = key(9);
const ISSUER = key(10);
const MIGRATION_ID = "3f2a9c1e-8b7d-4e6f-9a0b-1c2d3e4f5a6b";
const LOT = 5_000;
let sigN = 0;
const sig = () => `${++sigN}`.padStart(88, "5").replace(/0/g, "z");

type Handler = (r: Request) => Promise<Response>;
async function call(handler: Handler, wallet: string, params: Record<string, unknown>) {
  signer.wallet = wallet;
  signer.params = params;
  const res = await handler(new Request("https://manci.test/api/x", { method: "POST", body: "{}" }));
  return { status: res.status, body: (await res.json()) as { ok: boolean; error?: string; code?: string; data?: Record<string, unknown> } };
}
async function get(handler: (r: Request) => Promise<Response>, query = "") {
  const res = await handler(new Request(`https://manci.test/api/x${query}`));
  return { status: res.status, res };
}

let depositAta = "";
let holderAta = "";
let treasuryAta = "";
let holderNewAta = "";

function campaign(over: Record<string, unknown> = {}) {
  return {
    id: MIGRATION_ID, network: "mainnet", slug: "acme", status: "open", company_name: "Acme d.o.o.",
    issuer_pda: ISSUER, asset_pda: ASSET, share_class_pda: SHARE_CLASS, new_mint: NEW_MINT,
    old_chain: "solana", old_mint: OLD_MINT, old_token_program: TOKEN_PROGRAM_CLASSIC, old_decimals: 0, old_symbol: "OLD", old_name: "Old token",
    old_total_supply: "1000000000", excluded_wallets: [OTHER], excluded_wallet_amount: "400000000", excluded_manual_amount: "0", excluded_amount: "400000000",
    excluded_note: "", supply_read_at: "2027-01-01T00:00:00.000Z", equity_bps: 1200, granularity: 1_000_000, lot_base_units: String(LOT), units_cap: "120000",
    source: "founder_transfer", unclaimed_policy: "return_to_source", deposit_owner: DEPOSIT_OWNER, deposit_ata: depositAta,
    window_opens_at: "2027-01-15T00:00:00.000Z", window_closes_at: "2027-03-31T00:00:00.000Z",
    terms_doc_sha256: "ab".repeat(32), terms_doc_url: "https://example.com/swap-terms.pdf", treasury_wallet: TREASURY,
    final_report: null, final_report_sha256: null, old_tokens_burn_tx: null, old_tokens_burned: null, created_by: ADMIN, updated_by: null,
    opened_slot: 100, reconcile_cursor: null, reconcile_sweep_top: null, reconcile_sweep_before: null,
    opened_at: "2027-01-15T00:00:00.000Z", closed_at: null, completed_at: null, cancelled_at: null,
    created_at: "2027-01-01T00:00:00.000Z", updated_at: "2027-01-15T00:00:00.000Z",
    ...over,
  };
}
const migrations = () => db.ref!.rows("token_migrations");
const deposits = () => db.ref!.rows("token_migration_deposits");

/** A finalized transaction: the holder's deposit of `lots` lots (memo lots override with memoLots). */
function depositTx(signature: string, opts: { lots: number; from?: string; memoLots?: number; blockTime?: number } ) {
  const from = opts.from ?? HOLDER;
  const amount = opts.lots * LOT;
  const keys = [from, MEMO_PROGRAM_ADDRESS, TOKEN_PROGRAM_CLASSIC, holderAta, depositAta, OLD_MINT];
  const memo = new TextEncoder().encode(migrationMemoText(MIGRATION_ID, B(opts.memoLots ?? opts.lots)));
  const tx = {
    slot: 900 + sigN,
    blockTime: opts.blockTime ?? Math.floor(NOW / 1000) - 60,
    transaction: {
      signatures: [signature],
      message: {
        header: { numRequiredSignatures: 1 },
        accountKeys: keys,
        instructions: [{ programIdIndex: 1, accounts: [0], data: b58.decode(memo) }],
      },
    },
    meta: {
      err: null,
      innerInstructions: [],
      preTokenBalances: [{ accountIndex: 3, mint: OLD_MINT, owner: from, uiTokenAmount: { amount: String(amount * 3), decimals: 0 } }],
      postTokenBalances: [
        { accountIndex: 3, mint: OLD_MINT, owner: from, uiTokenAmount: { amount: String(amount * 2), decimals: 0 } },
        { accountIndex: 4, mint: OLD_MINT, owner: DEPOSIT_OWNER, uiTokenAmount: { amount: String(amount), decimals: 0 } },
      ],
    },
  };
  txs.map.set(signature, tx);
  return tx;
}

/** A finalized transaction moving share-class units from the treasury to holders. */
function deliveryTx(signature: string, paid: Array<{ ata: string; owner: string; units: number }>, treasuryDecrease?: number) {
  const total = paid.reduce((s, p) => s + p.units, 0);
  const keys = [TREASURY, TOKEN_PROGRAM_2022, treasuryAta, NEW_MINT, ...paid.map((p) => p.ata)];
  txs.map.set(signature, {
    slot: 1000,
    blockTime: Math.floor(NOW / 1000),
    transaction: { signatures: [signature], message: { header: { numRequiredSignatures: 1 }, accountKeys: keys, instructions: [] } },
    meta: {
      err: null,
      innerInstructions: [],
      preTokenBalances: [{ accountIndex: 2, mint: NEW_MINT, owner: TREASURY, uiTokenAmount: { amount: "1000000", decimals: 0 } }],
      postTokenBalances: [
        { accountIndex: 2, mint: NEW_MINT, owner: TREASURY, uiTokenAmount: { amount: String(1_000_000 - (treasuryDecrease ?? total)), decimals: 0 } },
        ...paid.map((p, i) => ({ accountIndex: 4 + i, mint: NEW_MINT, owner: p.owner, uiTokenAmount: { amount: String(p.units), decimals: 0 } })),
      ],
    },
  });
}

function emulateRecordingFunctions() {
  const rows = () => deposits();
  db.ref!.rpcs.record_token_migration_deposit = (args) => {
    const m = migrations().find((r) => r.id === args.p_migration_id);
    if (!m) throw new Error("MIGRATION_NOT_FOUND");
    const existing = rows().find((d) => d.deposit_tx === args.p_deposit_tx);
    if (existing) return { created: false, id: existing.id, status: existing.status, reason_code: existing.reason_code, units_due: existing.units_due };
    if (!["open", "closed", "cancelled"].includes(m.status as string)) throw new Error("MIGRATION_NOT_RECORDING");
    let status = args.p_reason_code ? "irregular" : "accepted";
    let reason = args.p_reason_code as string | null;
    let units = status === "accepted" ? String(args.p_lots) : "0";
    const taken = rows().filter((d) => d.migration_id === m.id && (d.status === "accepted" || d.status === "delivered")).reduce((s, d) => s + B(d.units_due as string), B(0));
    if (status === "accepted" && taken + B(units) > B(m.units_cap as string)) { status = "irregular"; reason = "over_cap"; units = "0"; }
    const row = {
      id: `00000000-0000-4000-8000-${String(rows().length + 1).padStart(12, "0")}`, migration_id: m.id, network: m.network, holder_wallet: args.p_holder_wallet,
      deposit_tx: args.p_deposit_tx, deposit_slot: args.p_deposit_slot, block_time: args.p_block_time, amount_base: args.p_amount_base, units_due: units,
      status, reason_code: reason, reason: args.p_reason, delivery_tx: null, refund_tx: null, recorded_via: args.p_recorded_via,
      delivered_at: null, refunded_at: null, created_at: new Date(NOW).toISOString(),
    };
    rows().push(row);
    return { created: true, id: row.id, status, reason_code: reason, units_due: units };
  };
  db.ref!.rpcs.record_token_migration_refund = (args) => {
    const ids = args.p_deposit_ids as string[];
    const recorded = rows().filter((d) => d.refund_tx === args.p_refund_tx).map((d) => d.id).sort();
    if (recorded.length) {
      if (JSON.stringify(recorded) === JSON.stringify([...ids].sort())) return { created: false, count: recorded.length };
      throw new Error("REFUND_TX_ALREADY_RECORDED");
    }
    const chosen = rows().filter((d) => ids.includes(d.id as string) && d.status === "irregular");
    if (chosen.length !== ids.length || new Set(chosen.map((d) => d.holder_wallet)).size !== 1) throw new Error("REFUND_DEPOSITS_NOT_REFUNDABLE");
    for (const d of chosen) Object.assign(d, { status: "refunded", refund_tx: args.p_refund_tx });
    return { created: true, count: chosen.length };
  };
  db.ref!.rpcs.record_token_migration_delivery = (args) => {
    const ids = args.p_deposit_ids as string[];
    const recorded = rows().filter((d) => d.delivery_tx === args.p_delivery_tx).map((d) => d.id).sort();
    if (recorded.length) {
      if (JSON.stringify(recorded) === JSON.stringify([...ids].sort())) return { created: false, count: recorded.length };
      throw new Error("DELIVERY_TX_ALREADY_RECORDED");
    }
    const chosen = rows().filter((d) => ids.includes(d.id as string) && d.status === "accepted");
    if (chosen.length !== ids.length) throw new Error("DELIVERY_DEPOSITS_NOT_ACCEPTED");
    for (const d of chosen) Object.assign(d, { status: "delivered", delivery_tx: args.p_delivery_tx });
    return { created: true, count: chosen.length };
  };
}

function seedDeposit(over: Record<string, unknown>) {
  const row = {
    id: `11111111-1111-4111-8111-${String(deposits().length + 1).padStart(12, "0")}`, migration_id: MIGRATION_ID, network: "mainnet", holder_wallet: HOLDER,
    deposit_tx: sig(), deposit_slot: 10 + deposits().length, block_time: "2027-01-20T00:00:00.000Z", amount_base: String(LOT), units_due: "1", status: "accepted",
    reason_code: null, reason: null, delivery_tx: null, refund_tx: null, recorded_via: "holder", delivered_at: null, refunded_at: null, created_at: "2027-01-20T00:00:01.000Z",
    ...over,
  };
  deposits().push(row);
  return row;
}

beforeEach(async () => {
  vi.unstubAllEnvs();
  vi.stubEnv("NEXT_PUBLIC_NETWORK", "mainnet");
  vi.stubEnv("NEXT_PUBLIC_FEATURE_KYC_ONLY", "off");
  vi.stubEnv(PILOT_MODULE_ENV.tokenMigration, "true");
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  db.ref = memorySupabase();
  emulateRecordingFunctions();
  admins.list = new Set([ADMIN]);
  screen.listed = new Set();
  screen.unavailable = false;
  txs.map.clear();
  txs.pending.clear();
  for (const fn of Object.values(chain)) fn.mockReset();
  limiter.result = "ok";
  depositAta = await associatedTokenAccount(DEPOSIT_OWNER, OLD_MINT, TOKEN_PROGRAM_CLASSIC);
  holderAta = await associatedTokenAccount(HOLDER, OLD_MINT, TOKEN_PROGRAM_CLASSIC);
  treasuryAta = await associatedTokenAccount(TREASURY, NEW_MINT, TOKEN_PROGRAM_2022);
  holderNewAta = await associatedTokenAccount(HOLDER, NEW_MINT, TOKEN_PROGRAM_2022);
  chain.readHolderBalance.mockResolvedValue({ amount: B(1_000_000), frozen: false });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("POST /api/token-migrations/precheck", () => {
  const ask = (lots: unknown = "2", wallet = HOLDER) => call(precheck, wallet, { migration_id: MIGRATION_ID, lots });
  const accept = (wallet = HOLDER) => db.ref!.rows("tos_acceptances").push({ id: `tos-${wallet}`, wallet, version: TOS_VERSION });

  it("answers the exact deposit to sign once every check passes (session read, module gate first)", async () => {
    migrations().push(campaign());
    accept();
    const res = await ask();
    expect(res.status).toBe(200);
    expect(signer.action).toBe("tokenMigration.precheck");
    expect(res.body.data).toEqual({
      migration_id: MIGRATION_ID, lots: "2", amount_base: "10000", units: "2", deposit_owner: DEPOSIT_OWNER, deposit_ata: depositAta,
      old_mint: OLD_MINT, old_token_program: TOKEN_PROGRAM_CLASSIC, old_decimals: 0, memo: `manci:migration:v1:${MIGRATION_ID}:2`,
    });
    // Off, the module refuses before anything else.
    vi.stubEnv(PILOT_MODULE_ENV.tokenMigration, "");
    expect(await ask()).toMatchObject({ status: 403, body: { error: moduleDisabledMessage("tokenMigration", "mainnet") } });
  });

  it("refuses a campaign that is not open, a window that has not started or has ended, and an excluded wallet", async () => {
    migrations().push(campaign({ status: "closed" }));
    accept();
    accept(OTHER);
    expect((await ask()).status).toBe(409);
    migrations()[0].status = "open";
    migrations()[0].window_opens_at = "2027-02-02T00:00:00.000Z";
    expect(await ask()).toMatchObject({ status: 409, body: { error: expect.stringMatching(/window opens/) } });
    migrations()[0].window_opens_at = "2027-01-01T00:00:00.000Z";
    migrations()[0].window_closes_at = "2027-02-01T00:00:00.000Z";
    expect(await ask()).toMatchObject({ status: 409, body: { error: expect.stringMatching(/window closed/) } });
    migrations()[0].window_closes_at = "2027-03-31T00:00:00.000Z";
    expect(await ask("1", OTHER)).toMatchObject({ status: 403, body: { error: expect.stringMatching(/excluded/) } });
  });

  it("screens the wallet, keeps to the cap and the balance, and checks the Terms last", async () => {
    migrations().push(campaign({ units_cap: "120000" }));
    screen.listed.add(HOLDER);
    expect((await ask()).status).toBe(403);
    screen.listed.clear();
    seedDeposit({ units_due: "119999", amount_base: String(119_999 * LOT) });
    expect(await ask("2")).toMatchObject({ status: 409, body: { error: expect.stringMatching(/Only 1 unit is left/) } });
    chain.readHolderBalance.mockResolvedValueOnce({ amount: B(4_999), frozen: false });
    expect(await ask("1")).toMatchObject({ status: 400, body: { error: expect.stringMatching(/less than 1 lots/) } });
    // Mainnet: no acceptance of the Terms in force, no deposit.
    expect(await ask("1")).toMatchObject({ status: 409, body: { error: expect.stringMatching(/Terms of Service/) } });
    expect((await ask("0")).status).toBe(400);
    expect((await ask("1.5")).status).toBe(400);
  });
});

describe("POST /api/token-migrations/record", () => {
  const record = (signature: string, wallet = HOLDER) => call(recordDeposit, wallet, { migration_id: MIGRATION_ID, signature });

  it("records the signer's own deposit through the serialized insert, once", async () => {
    migrations().push(campaign());
    const s = sig();
    depositTx(s, { lots: 2 });
    const res = await record(s);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ created: true, deposit: { holder_wallet: HOLDER, amount_base: "10000", units_due: "2", status: "accepted", deposit_tx: s, reason: null } });
    expect(deposits()).toHaveLength(1);
    expect(deposits()[0]).toMatchObject({ recorded_via: "holder", block_time: new Date((Math.floor(NOW / 1000) - 60) * 1000).toISOString() });
    // Recorded once: the same receipt answers the same row; another wallet cannot claim it.
    expect((await record(s)).body.data).toMatchObject({ created: false });
    expect(await record(s, OTHER)).toMatchObject({ status: 403 });
    expect(deposits()).toHaveLength(1);
  });

  it("records an irregular deposit with its reason, and a sanctions hit as a compliance hold", async () => {
    migrations().push(campaign());
    const wrongMemo = sig();
    depositTx(wrongMemo, { lots: 2, memoLots: 3 });
    expect((await record(wrongMemo)).body.data).toMatchObject({ deposit: { status: "irregular", reason: "Missing campaign memo", units_due: "0" } });
    const listed = sig();
    depositTx(listed, { lots: 1 });
    screen.listed.add(HOLDER);
    expect((await record(listed)).body.data).toMatchObject({ deposit: { status: "irregular", reason: "Held for review" } });
    expect(deposits()[1].reason_code).toBe("compliance_hold");
  });

  it("is rate-limited per wallet", async () => {
    migrations().push(campaign());
    const s = sig();
    depositTx(s, { lots: 1 });
    limiter.result = "limited";
    expect(await record(s)).toMatchObject({ status: 429 });
    expect(deposits()).toHaveLength(0);
  });

  it("refuses to record unscreened, before finalization, and what is not a deposit", async () => {
    migrations().push(campaign());
    const s = sig();
    depositTx(s, { lots: 1 });
    screen.unavailable = true;
    expect(await record(s)).toMatchObject({ status: 503 });
    expect(deposits()).toHaveLength(0);
    screen.unavailable = false;
    const pending = sig();
    txs.pending.add(pending);
    expect(await record(pending)).toMatchObject({ status: 409, body: { code: "awaiting_finalization" } });
    const foreign = sig();
    depositTx(foreign, { lots: 1, from: OTHER });
    expect(await record(foreign)).toMatchObject({ status: 400, body: { error: "This deposit did not come from your wallet" } });
    migrations()[0].status = "draft";
    expect((await record(s)).status).toBe(409);
  });
});

describe("POST /api/token-migrations/admin/save", () => {
  const draftParams = (over: Record<string, unknown> = {}) => ({
    slug: "acme-pilot", company_name: "Acme d.o.o.", share_class_pda: SHARE_CLASS, old_mint: OLD_MINT, old_symbol: "OLD", old_name: "Old token",
    excluded_wallets: [OTHER], excluded_manual_amount: "100000000", excluded_note: "Team vesting and burned supply",
    equity_bps: 1200, granularity: 1_000_000, source: "founder_transfer", unclaimed_policy: "return_to_source",
    deposit_owner: ADMIN, treasury_wallet: TREASURY, window_opens_at: "2027-02-05T00:00:00Z", window_closes_at: "2027-04-21T00:00:00Z",
    // A lot from the browser is never used.
    lot_base_units: "1",
    ...over,
  });
  beforeEach(() => {
    chain.readShareClassFacts.mockResolvedValue({ shareClass: SHARE_CLASS, asset: ASSET, issuer: ISSUER, mint: NEW_MINT, assetName: "Acme", maxSupply: B(1_000_000) });
    chain.readOldMint.mockResolvedValue({ ok: true, tokenProgram: TOKEN_PROGRAM_CLASSIC, decimals: 0, supply: B(1_000_000_000), mintAuthority: null, freezeAuthority: null, extensions: [], refusals: [], warnings: [] });
    chain.readExcludedBalances.mockResolvedValue([{ address: OTHER, kind: "owner", amount: B(300_000_000) }]);
    db.ref!.defaults.token_migrations = () => ({
      id: MIGRATION_ID, status: "draft", final_report_sha256: null, old_tokens_burn_tx: null, old_tokens_burned: null,
      opened_at: null, closed_at: null, completed_at: null, cancelled_at: null, created_at: new Date(NOW).toISOString(), updated_at: new Date(NOW).toISOString(),
    });
  });

  it("is admin only", async () => {
    expect((await call(adminSave, HOLDER, draftParams())).status).toBe(403);
  });

  it("computes the ratio on the server from what the chain shows, and warns about a deposit owner that is the admin's own wallet", async () => {
    const res = await call(adminSave, ADMIN, draftParams());
    expect(res.status).toBe(200);
    expect(res.body.data!.migration).toMatchObject({
      status: "draft", lot_base_units: "5000", units_cap: "120000", excluded_amount: "400000000", excluded_wallet_amount: "300000000",
      excluded_manual_amount: "100000000", deposit_ata: await associatedTokenAccount(ADMIN, OLD_MINT, TOKEN_PROGRAM_CLASSIC),
      new_mint: NEW_MINT, issuer_pda: ISSUER, old_token_program: TOKEN_PROGRAM_CLASSIC, created_by: ADMIN,
    });
    expect((res.body.data!.warnings as string[]).join(" ")).toMatch(/your own wallet/);
  });

  it("refuses a token V1 cannot migrate, a window outside 60–90 days, a cap above the class's supply, and an edit after opening", async () => {
    chain.readOldMint.mockResolvedValueOnce({ ok: false, tokenProgram: TOKEN_PROGRAM_2022, decimals: 6, supply: B(1), mintAuthority: null, freezeAuthority: null, extensions: ["TransferFeeConfig"], refusals: [{ extension: "TransferFeeConfig", reason: "It charges a transfer fee." }], warnings: [] });
    expect(await call(adminSave, ADMIN, draftParams())).toMatchObject({ status: 409, body: { error: expect.stringMatching(/transfer fee/) } });
    expect(await call(adminSave, ADMIN, draftParams({ window_closes_at: "2027-04-01T00:00:00Z" }))).toMatchObject({ status: 400, body: { error: expect.stringMatching(/60 and 90 days/) } });
    chain.readShareClassFacts.mockResolvedValueOnce({ shareClass: SHARE_CLASS, asset: ASSET, issuer: ISSUER, mint: NEW_MINT, assetName: "Acme", maxSupply: B(10_000) });
    expect(await call(adminSave, ADMIN, draftParams())).toMatchObject({ status: 409, body: { error: expect.stringMatching(/supply cap/) } });
    migrations().push(campaign({ status: "open" }));
    expect(await call(adminSave, ADMIN, draftParams({ id: MIGRATION_ID, slug: "acme" }))).toMatchObject({ status: 409, body: { error: expect.stringMatching(/Only a draft/) } });
  });

  it("takes a custom G (a joint-stock company's number of shares) and refuses one outside 100..10^12 or not whole", async () => {
    // 37,000 shares, E 12 %: N_target 4,440, lot 200,000, cap 3,000, all computed on the server.
    const shares = await call(adminSave, ADMIN, draftParams({ granularity: "37000" }));
    expect(shares.status).toBe(200);
    expect(shares.body.data!.migration).toMatchObject({ granularity: 37_000, lot_base_units: "200000", units_cap: "3000" });
    expect((shares.body.data!.warnings as string[]).join(" ")).toContain("leaves the holders ≈ 8.1081 % instead of the decided 12.0000 %");
    for (const bad of [99, "99", 1_000_000_000_001, "1000000000001", 37_000.5, "37000.5", "37,000", "-37000", -37_000, "3.7e4", null, undefined]) {
      expect(await call(adminSave, ADMIN, draftParams({ slug: "acme-shares", granularity: bad })), String(bad)).toMatchObject({
        status: 400,
        body: { error: "granularity must be a whole number of units from 100 to 1000000000000 (a joint-stock company: its number of shares)" },
      });
    }
    // E below one unit of a small G is refused with the smallest E that works.
    expect(await call(adminSave, ADMIN, draftParams({ slug: "acme-tiny", granularity: 300, equity_bps: 33 }))).toMatchObject({
      status: 400,
      body: { error: expect.stringMatching(/E must be at least 0\.34 %/) },
    });
  });
});

describe("POST /api/token-migrations/admin/transition", () => {
  const go = (to: string) => call(adminTransition, ADMIN, { id: MIGRATION_ID, to });

  it("opens a draft only with the module on, the Terms set and a clean deposit account", async () => {
    migrations().push(campaign({ status: "draft", terms_doc_sha256: null, terms_doc_url: null, opened_at: null, window_opens_at: "2027-01-30T00:00:00.000Z", window_closes_at: "2027-04-15T00:00:00.000Z" }));
    chain.readOldMint.mockResolvedValue({ ok: true, tokenProgram: TOKEN_PROGRAM_CLASSIC, decimals: 0, supply: B(1_000_000_000), refusals: [], warnings: [], extensions: [], mintAuthority: null, freezeAuthority: null });
    vi.stubEnv(PILOT_MODULE_ENV.tokenMigration, "");
    expect(await go("open")).toMatchObject({ status: 403, body: { error: moduleDisabledMessage("tokenMigration", "mainnet") } });
    vi.stubEnv(PILOT_MODULE_ENV.tokenMigration, "true");
    expect(await go("open")).toMatchObject({ status: 409, body: { error: expect.stringMatching(/Swap Terms/) } });
    Object.assign(migrations()[0], { terms_doc_sha256: "cd".repeat(32), terms_doc_url: "https://example.com/t.pdf" });
    // Opened two days after its window started, the holders would lose part of it.
    expect(await go("open")).toMatchObject({ status: 409, body: { error: expect.stringMatching(/opened more than a day ago/) } });
    migrations()[0].window_opens_at = "2027-02-01T06:00:00.000Z";
    chain.readDepositAccount.mockResolvedValueOnce({ ok: false, problem: "The deposit account already holds tokens" });
    expect(await go("open")).toMatchObject({ status: 409, body: { error: "The deposit account already holds tokens" } });
    chain.readDepositAccount.mockResolvedValueOnce({ ok: true, amount: B(0) });
    chain.readFinalizedSlot.mockResolvedValueOnce(B(4242));
    expect((await go("open")).body.data!.migration).toMatchObject({ status: "open", opened_slot: 4242 });
    expect(signer.action).toBe("tokenMigration.adminTransition");
  });

  it("closes after the window or once every unit is claimed; never jumps a step", async () => {
    migrations().push(campaign());
    expect(await go("closed")).toMatchObject({ status: 409, body: { error: expect.stringMatching(/window is open until/) } });
    expect(await go("completed")).toMatchObject({ status: 409 });
    seedDeposit({ units_due: "120000", amount_base: String(120_000 * LOT) });
    expect((await go("closed")).body.data!.migration).toMatchObject({ status: "closed" });
  });

  it("completes only a settled campaign, with the final report and its SHA-256", async () => {
    migrations().push(campaign({ status: "closed" }));
    const accepted = seedDeposit({});
    expect(await go("completed")).toMatchObject({ status: 409, body: { error: expect.stringMatching(/1 deposit\(s\) still wait/) } });
    Object.assign(accepted, { status: "delivered", delivery_tx: sig() });
    const res = await go("completed");
    expect(res.status).toBe(200);
    const stored = migrations()[0];
    expect(stored.status).toBe("completed");
    expect(typeof stored.final_report).toBe("string");
    expect(stored.final_report_sha256).toBe(await sha256Hex(stored.final_report as string));
    expect(JSON.parse(stored.final_report as string).totals).toMatchObject({ units_delivered: "1", units_unclaimed: "119999" });
    // The row keeps the completion time the report states, so the report can be rebuilt from the row.
    expect(JSON.parse(stored.final_report as string).completed_at).toBe(stored.completed_at);
  });
});

describe("POST /api/token-migrations/admin/record", () => {
  const rec = (params: Record<string, unknown>) => call(adminRecord, ADMIN, { id: MIGRATION_ID, ...params });

  it("delivery: takes each paid holder's accepted deposits from the transaction and checks the units exactly", async () => {
    migrations().push(campaign());
    const a = seedDeposit({ units_due: "2", amount_base: String(2 * LOT) });
    const b = seedDeposit({ units_due: "3", amount_base: String(3 * LOT) });
    const short = sig();
    deliveryTx(short, [{ ata: holderNewAta, owner: HOLDER, units: 4 }]);
    expect(await rec({ kind: "delivery", signature: short })).toMatchObject({ status: 400, body: { error: expect.stringMatching(/did not receive exactly 5 units/) } });
    const s = sig();
    deliveryTx(s, [{ ata: holderNewAta, owner: HOLDER, units: 5 }]);
    expect((await rec({ kind: "delivery", signature: s })).body.data).toEqual({ created: true, deposits: 2, holders: 1, units: "5" });
    expect([a.status, b.status, a.delivery_tx]).toEqual(["delivered", "delivered", s]);
    expect((await rec({ kind: "delivery", signature: s })).body.data).toMatchObject({ created: false });
    // A transaction that paid nobody with units due.
    const none = sig();
    deliveryTx(none, [{ ata: holderNewAta, owner: HOLDER, units: 1 }]);
    expect(await rec({ kind: "delivery", signature: none })).toMatchObject({ status: 400, body: { error: expect.stringMatching(/paid no holder/) } });
  });

  /** A finalized refund: `amount` from the deposit account back to `owner`, at `slot`. */
  function refundTx(signature: string, amount: number, slot = 2_000, owner = HOLDER) {
    txs.map.set(signature, {
      slot, blockTime: Math.floor(NOW / 1000), transaction: { signatures: [signature], message: { header: { numRequiredSignatures: 1 }, accountKeys: [DEPOSIT_OWNER, depositAta, holderAta], instructions: [] } },
      meta: { err: null, innerInstructions: [],
        preTokenBalances: [{ accountIndex: 1, mint: OLD_MINT, owner: DEPOSIT_OWNER, uiTokenAmount: { amount: "50000", decimals: 0 } }],
        postTokenBalances: [{ accountIndex: 1, mint: OLD_MINT, owner: DEPOSIT_OWNER, uiTokenAmount: { amount: String(50_000 - amount), decimals: 0 } }, { accountIndex: 2, mint: OLD_MINT, owner, uiTokenAmount: { amount: String(amount), decimals: 0 } }] },
    });
  }

  it("refund: irregular deposits back in full, a compliance hold only on the compliance decision, never before the deposit", async () => {
    migrations().push(campaign());
    const held = seedDeposit({ status: "irregular", units_due: "0", reason_code: "compliance_hold", amount_base: "1234" });
    const s = sig();
    refundTx(s, 1234);
    expect(await rec({ kind: "refund", signature: s, deposit_id: held.id })).toMatchObject({ status: 409, body: { error: expect.stringMatching(/compliance/) } });
    expect((await rec({ kind: "refund", signature: s, deposit_id: held.id, compliance_cleared: true })).body.data).toEqual({ created: true, deposits: 1, amount_base: "1234" });
    expect(held).toMatchObject({ status: "refunded", refund_tx: s });
    const accepted = seedDeposit({});
    expect(await rec({ kind: "refund", signature: sig(), deposit_id: accepted.id })).toMatchObject({ status: 409, body: { error: expect.stringMatching(/unless the campaign is cancelled/) } });
    // An older transfer between the same accounts is not the refund of a later deposit.
    const late = seedDeposit({ status: "irregular", units_due: "0", reason_code: "outside_window", amount_base: "77", deposit_slot: 3_000 });
    const early = sig();
    refundTx(early, 77, 2_500);
    expect(await rec({ kind: "refund", signature: early, deposit_ids: [late.id] })).toMatchObject({ status: 400, body: { error: expect.stringMatching(/not later than the deposits/) } });
  });

  it("refund: one transaction returns several small deposits of one holder, never two holders'", async () => {
    migrations().push(campaign());
    const dust = [1, 2, 3].map((n) => seedDeposit({ status: "irregular", units_due: "0", reason_code: "not_lot_multiple", amount_base: String(n) }));
    const stranger = seedDeposit({ status: "irregular", units_due: "0", reason_code: "not_lot_multiple", amount_base: "4", holder_wallet: OTHER });
    expect(await rec({ kind: "refund", signature: sig(), deposit_ids: [dust[0].id, stranger.id] })).toMatchObject({ status: 400, body: { error: expect.stringMatching(/one holder/) } });
    const s = sig();
    refundTx(s, 6);
    expect((await rec({ kind: "refund", signature: s, deposit_ids: dust.map((d) => d.id) })).body.data).toEqual({ created: true, deposits: 3, amount_base: "6" });
    expect(dust.every((d) => d.status === "refunded" && d.refund_tx === s)).toBe(true);
    expect((await rec({ kind: "refund", signature: s, deposit_ids: dust.map((d) => d.id) })).body.data).toMatchObject({ created: false });
  });

  it("burn: only after the window, once", async () => {
    migrations().push(campaign());
    const s = sig();
    const burnData = new Uint8Array(10);
    burnData[0] = 15;
    new DataView(burnData.buffer).setBigUint64(1, B(10_000), true);
    txs.map.set(s, {
      slot: 7_000, blockTime: Math.floor(NOW / 1000), transaction: { signatures: [s], message: { header: { numRequiredSignatures: 1 }, accountKeys: [DEPOSIT_OWNER, TOKEN_PROGRAM_CLASSIC, depositAta, OLD_MINT], instructions: [{ programIdIndex: 1, accounts: [2, 3, 0], data: b58.decode(burnData) }] } },
      meta: { err: null, innerInstructions: [],
        preTokenBalances: [{ accountIndex: 2, mint: OLD_MINT, owner: DEPOSIT_OWNER, uiTokenAmount: { amount: "10000", decimals: 0 } }],
        postTokenBalances: [{ accountIndex: 2, mint: OLD_MINT, owner: DEPOSIT_OWNER, uiTokenAmount: { amount: "0", decimals: 0 } }] },
    });
    expect(await rec({ kind: "burn", signature: s })).toMatchObject({ status: 409, body: { error: expect.stringMatching(/close the campaign first/) } });
    Object.assign(migrations()[0], { status: "closed", closed_at: new Date(NOW - 3_600_000).toISOString() });
    // Not while a deposit still waits for its refund.
    const pending = seedDeposit({ status: "irregular", units_due: "0", reason_code: "outside_window" });
    expect(await rec({ kind: "burn", signature: s })).toMatchObject({ status: 409, body: { error: expect.stringMatching(/every deposit is settled/) } });
    Object.assign(pending, { status: "refunded", refund_tx: sig() });
    // Not a burn from before the close.
    Object.assign(migrations()[0], { closed_at: new Date(NOW + 3_600_000).toISOString() });
    expect(await rec({ kind: "burn", signature: s })).toMatchObject({ status: 400, body: { error: expect.stringMatching(/before the campaign closed/) } });
    Object.assign(migrations()[0], { closed_at: new Date(NOW - 3_600_000).toISOString() });
    expect((await rec({ kind: "burn", signature: s })).body.data).toEqual({ created: true, burned: "10000" });
    expect(migrations()[0]).toMatchObject({ old_tokens_burn_tx: s, old_tokens_burned: "10000" });
    expect(await rec({ kind: "burn", signature: sig() })).toMatchObject({ status: 409, body: { error: expect.stringMatching(/already recorded/) } });
  });
});

describe("POST /api/token-migrations/admin/reconcile", () => {
  /** The deposit account's history, newest first, served page by page like getSignaturesForAddress. */
  function history(newestFirst: string[]) {
    chain.depositAccountPage.mockImplementation(async (_ata: string, opts: { before: string | null; until: string | null; limit: number }) => {
      let list = newestFirst;
      if (opts.until) list = list.slice(0, Math.max(0, list.indexOf(opts.until)));
      if (opts.before) list = list.slice(list.indexOf(opts.before) + 1);
      const page = list.slice(0, opts.limit);
      return { entries: page.map((signature) => ({ signature, slot: B(5_000), failed: false })), exhausted: page.length < opts.limit || page.length === list.length };
    });
  }
  /** A transaction that touched the deposit account without moving the old token (noise). */
  function noise(signature: string) {
    txs.map.set(signature, {
      slot: 5_000, blockTime: 1, transaction: { signatures: [signature], message: { header: { numRequiredSignatures: 1 }, accountKeys: [OTHER, depositAta], instructions: [] } },
      meta: { err: null, innerInstructions: [], preTokenBalances: [], postTokenBalances: [] },
    });
  }

  it("records the deposits nobody recorded, passes over what is known, and skips what is not a deposit", async () => {
    migrations().push(campaign());
    const known = seedDeposit({});
    const fresh = sig();
    depositTx(fresh, { lots: 1 });
    const creation = sig();
    noise(creation);
    history([fresh, known.deposit_tx as string, creation]);
    const res = await call(adminReconcile, ADMIN, { id: MIGRATION_ID });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ examined: 2, complete: true, stopped: null });
    expect((res.body.data!.results as Array<{ outcome: string }>).map((r) => r.outcome)).toEqual(["recorded", "not_a_deposit"]);
    expect(deposits().find((d) => d.deposit_tx === fresh)).toMatchObject({ recorded_via: "reconcile", status: "accepted" });
    // The sweep is complete: its newest signature is the cursor, and the next run reads nothing again.
    expect(migrations()[0]).toMatchObject({ reconcile_cursor: fresh, reconcile_sweep_top: null, reconcile_sweep_before: null });
    expect((await call(adminReconcile, ADMIN, { id: MIGRATION_ID })).body.data).toMatchObject({ examined: 0, complete: true });
    expect((await call(adminReconcile, HOLDER, { id: MIGRATION_ID })).status).toBe(403);
  });

  it("cannot be stalled by noise: a sweep resumes where the last run stopped until it reaches the deposits", async () => {
    migrations().push(campaign());
    // 100 noise transactions on top of an unrecorded deposit (the oldest).
    const deposit = sig();
    depositTx(deposit, { lots: 2 });
    const spam = Array.from({ length: 100 }, () => sig());
    spam.forEach(noise);
    history([...spam].reverse().concat(deposit));
    const first = await call(adminReconcile, ADMIN, { id: MIGRATION_ID });
    expect(first.body.data).toMatchObject({ examined: 40, complete: false });
    expect(migrations()[0].reconcile_sweep_top).toBe(spam[spam.length - 1]);
    const second = await call(adminReconcile, ADMIN, { id: MIGRATION_ID });
    expect(second.body.data).toMatchObject({ examined: 40, complete: false });
    const third = await call(adminReconcile, ADMIN, { id: MIGRATION_ID });
    expect(third.body.data).toMatchObject({ examined: 21, complete: true });
    expect(deposits().find((d) => d.deposit_tx === deposit)).toMatchObject({ status: "accepted", units_due: "2" });
    expect(migrations()[0]).toMatchObject({ reconcile_cursor: spam[spam.length - 1], reconcile_sweep_top: null });
    // A new deposit later: the next sweep reads only what came after the cursor.
    const later = sig();
    depositTx(later, { lots: 1 });
    history([later, ...[...spam].reverse(), deposit]);
    expect((await call(adminReconcile, ADMIN, { id: MIGRATION_ID })).body.data).toMatchObject({ examined: 1, complete: true });
  });

  it("stops at a screen that cannot answer and reads that transaction again next time", async () => {
    migrations().push(campaign());
    const a = sig();
    depositTx(a, { lots: 1 });
    history([a]);
    screen.unavailable = true;
    expect((await call(adminReconcile, ADMIN, { id: MIGRATION_ID })).status).toBe(503);
    expect(migrations()[0]).toMatchObject({ reconcile_cursor: null, reconcile_sweep_top: null });
    screen.unavailable = false;
    expect((await call(adminReconcile, ADMIN, { id: MIGRATION_ID })).body.data).toMatchObject({ examined: 1, complete: true });
  });

  it("records one transaction the operator names, and never one from before the opening", async () => {
    migrations().push(campaign());
    const named = sig();
    depositTx(named, { lots: 1 });
    expect((await call(adminReconcile, ADMIN, { id: MIGRATION_ID, signature: named })).body.data).toMatchObject({ results: [{ outcome: "recorded" }] });
    migrations()[0].opened_slot = 1_000_000;
    const old = sig();
    depositTx(old, { lots: 1 });
    expect((await call(adminReconcile, ADMIN, { id: MIGRATION_ID, signature: old })).body.data).toMatchObject({ results: [{ outcome: "not_a_deposit", detail: expect.stringMatching(/before the campaign opened/) }] });
  });
});

describe("public reads", () => {
  it("lists campaigns without drafts or the operator wallet, with public reasons only", async () => {
    migrations().push(campaign(), campaign({ id: "9f2a9c1e-8b7d-4e6f-9a0b-1c2d3e4f5a6b", slug: "secret-draft", status: "draft" }));
    seedDeposit({});
    seedDeposit({ status: "irregular", units_due: "0", reason_code: "compliance_hold", reason: "Sanctions screening hit" });
    const list = await get(publicRead);
    const body = await list.res.json();
    expect(body.data.map((m: { slug: string }) => m.slug)).toEqual(["acme"]);
    expect(body.data[0]).not.toHaveProperty("created_by");
    expect(body.data[0].progress).toMatchObject({ holders: 1, unitsDue: "1", refundsDue: 1 });
    const one = await (await get(publicRead, "?slug=acme")).res.json();
    expect(one.data.deposits.map((d: { reason: string | null }) => d.reason)).toEqual([null, "Held for review"]);
    expect(JSON.stringify(one)).not.toMatch(/Sanctions/);
    expect((await get(publicRead, "?slug=secret-draft")).status).toBe(404);
  });

  it("serves the final report as stored, with its hash, and only for a completed campaign", async () => {
    migrations().push(campaign());
    expect((await get(reportRead, "?slug=acme")).status).toBe(404);
    const text = '{"kind":"manci.token-migration.final-report"}';
    Object.assign(migrations()[0], { status: "completed", final_report: text, final_report_sha256: await sha256Hex(text) });
    const ok = await get(reportRead, "?slug=acme");
    expect(ok.status).toBe(200);
    expect(await ok.res.text()).toBe(text);
    expect(ok.res.headers.get("X-Content-SHA256")).toBe(await sha256Hex(text));
    migrations()[0].final_report = `${text} `;
    expect((await get(reportRead, "?slug=acme")).status).toBe(500);
  });

  it("the admin list shows drafts and internal reasons to an admin only", async () => {
    migrations().push(campaign({ status: "draft" }));
    expect((await call(adminList, HOLDER, {})).status).toBe(403);
    const res = await call(adminList, ADMIN, {});
    expect((res.body.data!.migrations as Array<{ status: string }>).map((m) => m.status)).toEqual(["draft"]);
    expect(signer.action).toBe("tokenMigration.adminList");
  });
});
