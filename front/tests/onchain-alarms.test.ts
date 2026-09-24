// Talas 4.4b: instruction-first on-chain alarms (design §4.1) and the
// onchain_event_jobs processing. RPC and Supabase are mocked.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({ txs: {} as Record<string, unknown>, rpcDown: false }));
vi.mock("@/lib/network", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/network")>()),
  detectNetwork: () => "devnet",
}));
vi.mock("@/lib/server/sale-capacity-chain", () => ({
  finalizedTransaction: vi.fn(async (sig: string) => {
    if (state.rpcDown) throw new Error("rpc https://secret.example/key down");
    return state.txs[sig] ?? null;
  }),
}));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseAdmin: () => { throw new Error("not in tests"); } }));

import { getAddressEncoder, getProgramDerivedAddress, type Address } from "@solana/kit";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  getAcceptPlatformAdminInstructionDataEncoder,
  getClawbackBlocklistedHolderInstructionDataEncoder,
  getClawbackFromHolderInstructionDataEncoder,
  getMintToTreasuryInstructionDataEncoder,
  getReclaimRentInstructionDataEncoder,
  getSetIssuerPermissionsInstructionDataEncoder,
  getSetPauseFlagsInstructionDataEncoder,
  getSetPauseInstructionDataEncoder,
  getSetProtocolTreasuryInstructionDataEncoder,
  getVerifyIssuerKybInstructionDataEncoder,
} from "@/lib/generated/asset_registry";
import {
  TRANSFER_HOOK_PROGRAM_ADDRESS,
  getAcceptBlocklistAuthorityInstructionDataEncoder,
} from "@/lib/generated/transfer_hook";
import {
  ALARM_INSTRUCTIONS,
  BPF_LOADER_UPGRADEABLE,
  alarmsForTransaction,
  processEventJob,
  programDataAddresses,
  type EventJob,
} from "@/lib/server/onchain-alarms";
import { b64, buildTx, encodeEvent, logTree, type Ix } from "./helpers/chain-tx";

const R = ASSET_REGISTRY_PROGRAM_ADDRESS;
const SQUADS = "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf";
const A = "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2";
const B = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const C = "8sHgqRqBEXaSkhcyzXtY3vBSfGqBbTeR2SkVFDcxrfd9";
const SIG = "5".repeat(88);
const accounts = (n: number) => Array.from({ length: n }, (_, i) => [A, B, C][i % 3]);
const bytes = (e: { encode: (v: never) => ArrayLike<number> }, v: unknown) => new Uint8Array(e.encode(v as never));

let PD: { assetRegistry: string; transferHook: string };
beforeEach(async () => {
  PD = await programDataAddresses();
  state.txs = {};
  state.rpcDown = false;
});

/** One invocation, optionally inside Squads, with its events logged (or no logs). */
function run(ixs: Ix[], opts: { inner?: boolean; events?: Uint8Array[][]; logs?: "none" | "truncated" } = {}) {
  const instructions = opts.inner ? [{ ix: { program: SQUADS, accounts: [A], data: new Uint8Array([0]) }, inner: ixs }] : ixs.map((ix) => ({ ix }));
  const frames = ixs.map((ix, k) => ({ program: ix.program, data: (opts.events?.[k] ?? []).map(b64) }));
  let logs: string[] | null = logTree(opts.inner ? [{ program: SQUADS, children: frames }] : frames);
  if (opts.logs === "none") logs = null;
  if (opts.logs === "truncated") logs = [`Program ${R} invoke [1]`, "Log truncated"];
  const { tx } = buildTx({ signature: SIG, instructions, logs });
  return alarmsForTransaction("devnet", SIG, tx, PD);
}
const pauseFlags = (setMask: number, clearMask: number) =>
  ({ program: R, accounts: accounts(3), data: bytes(getSetPauseFlagsInstructionDataEncoder(), { setMask, clearMask }) });
const one = (r: ReturnType<typeof run>) => {
  expect(r.alarms).toHaveLength(1);
  return r.alarms[0];
};

describe("instruction catalogue (design §4.1)", () => {
  it("pins every entry's evidence accounts to the IDL account order", async () => {
    const { readFileSync } = await import("node:fs");
    const registry = JSON.parse(readFileSync("idl/asset_registry.json", "utf8")) as { instructions: { name: string; accounts: { name: string }[] }[] };
    const hook = JSON.parse(readFileSync("idl/transfer_hook.json", "utf8")) as typeof registry;
    for (const entry of ALARM_INSTRUCTIONS) {
      const idl = (entry.program === R ? registry : hook).instructions.find((i) => i.name === entry.name);
      expect(idl, entry.name).toBeDefined();
      for (const [name, index] of Object.entries(entry.accounts)) expect(idl!.accounts[index]?.name, `${entry.name}.${name}`).toBe(name);
    }
  });

  it("pause: set is high, the full set critical, a clear (unpause) critical, a no-op low — events only refine", () => {
    expect(one(run([pauseFlags(0x02, 0)]))).toMatchObject({ source: "onchain:pause", severity: "high", format: "platform",
      dedupKey: `onchain:${SIG}:0` });
    expect(one(run([pauseFlags(0x3f, 0)])).severity).toBe("critical");
    expect(one(run([pauseFlags(0x02, 0)], { events: [[encodeEvent("PauseFlagsChanged", { old: 0x3d, new: 0x3f })]] })).severity).toBe("critical");
    expect(one(run([pauseFlags(0x02, 0)], { events: [[encodeEvent("PauseFlagsChanged", { old: 0x02, new: 0x02 })]] })).severity).toBe("low");
    // Truncated logs: a clear stays critical (the event can only lower it).
    expect(one(run([pauseFlags(0, 0x04)], { logs: "truncated" }))).toMatchObject({ severity: "critical", evidence: { event_state: "truncated" } });
    const setPause = (paused: boolean) => ({ program: R, accounts: accounts(2), data: bytes(getSetPauseInstructionDataEncoder(), { paused }) });
    expect(one(run([setPause(true)])).severity).toBe("high");
    expect(one(run([setPause(false)])).severity).toBe("critical");
  });

  it("treasury change and a super-admin accept are critical, even with no logs at all", () => {
    const treasury = { program: R, accounts: accounts(2), data: bytes(getSetProtocolTreasuryInstructionDataEncoder(), { newTreasury: C as Address }) };
    expect(one(run([treasury], { logs: "none" }))).toMatchObject({ source: "onchain:treasury", severity: "critical",
      evidence: { new_treasury: C, event_state: "missing" } });
    const accept = { program: R, accounts: accounts(6), data: bytes(getAcceptPlatformAdminInstructionDataEncoder(), {}) };
    expect(one(run([accept]))).toMatchObject({ source: "onchain:platform-admin", severity: "critical" });
    const hookAccept = { program: TRANSFER_HOOK_PROGRAM_ADDRESS, accounts: accounts(3), data: bytes(getAcceptBlocklistAuthorityInstructionDataEncoder(), {}) };
    expect(one(run([hookAccept]))).toMatchObject({ source: "onchain:blocklist-authority", severity: "critical" });
  });

  it("issuer permissions: the MINT bit critical, other caps high, a revoke medium; KYB rejection high, approval low", () => {
    const perms = (capabilities: number) => ({ program: R, accounts: accounts(5), data: bytes(getSetIssuerPermissionsInstructionDataEncoder(), { capabilities }) });
    expect(one(run([perms(1)]))).toMatchObject({ source: "onchain:issuer-permissions", severity: "critical", format: "minimal" });
    expect(one(run([perms(2)])).severity).toBe("high");
    expect(one(run([perms(0)])).severity).toBe("medium");
    const kyb = (approved: boolean) => ({ program: R, accounts: accounts(3), data: bytes(getVerifyIssuerKybInstructionDataEncoder(), { approved }) });
    expect(one(run([kyb(false)]))).toMatchObject({ source: "onchain:issuer-kyb", severity: "high" });
    expect(one(run([kyb(true)])).severity).toBe("low");
  });

  it("blocklist clawback: one key blocking and seizing is high, two keys medium, no event high", () => {
    const claw = { program: R, accounts: accounts(11), data: bytes(getClawbackBlocklistedHolderInstructionDataEncoder(), { holder: B as Address, amount: BigInt(5) }) };
    const same = encodeEvent("BlocklistClawback", { blocked_by: A, admin: A });
    const two = encodeEvent("BlocklistClawback", { blocked_by: A, admin: B });
    expect(one(run([claw], { events: [[same]] }))).toMatchObject({ source: "onchain:clawback", severity: "high", evidence: { blocked_by: A, admin: A } });
    expect(one(run([claw], { events: [[two]] })).severity).toBe("medium");
    expect(one(run([claw], { logs: "none" })).severity).toBe("high");
    const fromHolder = { program: R, accounts: accounts(12), data: bytes(getClawbackFromHolderInstructionDataEncoder(), { holder: B as Address, amount: BigInt(5) }) };
    expect(one(run([fromHolder])).severity).toBe("medium");
  });

  it("reclaim_rent alarms (low) only for a KYC entry, or when the kind is unknown", () => {
    const reclaim = { program: R, accounts: accounts(7), data: bytes(getReclaimRentInstructionDataEncoder(), {}) };
    expect(one(run([reclaim], { events: [[encodeEvent("RentReclaimed", { kind: 3 })]] }))).toMatchObject({ source: "onchain:kyc-reclaim", severity: "low" });
    expect(run([reclaim], { events: [[encodeEvent("RentReclaimed", { kind: 0 })]] }).alarms).toEqual([]);
    expect(one(run([reclaim], { logs: "none" })).summary).toMatch(/kind unknown/);
  });

  it("an event LAYOUT error adds an onchain:decode alarm in the minimal format", () => {
    const claw = { program: R, accounts: accounts(11), data: bytes(getClawbackBlocklistedHolderInstructionDataEncoder(), { holder: B as Address, amount: BigInt(5) }) };
    const drifted = encodeEvent("BlocklistClawback", {}).slice(0, -1);
    const r = run([claw], { events: [[drifted]] });
    expect(r.alarms.map((a) => [a.source, a.severity, a.format, a.dedupKey])).toEqual([
      ["onchain:clawback", "high", "minimal", `onchain:${SIG}:0`],
      ["onchain:decode", "medium", "minimal", `onchain:${SIG}:0:decode`],
    ]);
  });

  it("loader Upgrade and SetAuthority on our ProgramData through Squads are critical; another program's upgrade is nothing", async () => {
    const loader = (tag: number, programData: string) => {
      const data = new Uint8Array(4);
      new DataView(data.buffer).setUint32(0, tag, true);
      return { program: BPF_LOADER_UPGRADEABLE, accounts: [programData, A, B], data };
    };
    expect(one(run([loader(3, PD.assetRegistry)], { inner: true }))).toMatchObject({ source: "onchain:program-upgrade", severity: "critical",
      evidence: { target_program: "asset_registry", inner: true } });
    expect(one(run([loader(4, PD.transferHook)], { inner: true })).severity).toBe("critical");
    expect(one(run([loader(6, PD.assetRegistry)])).severity).toBe("medium");
    const [foreign] = await getProgramDerivedAddress({ programAddress: BPF_LOADER_UPGRADEABLE as Address, seeds: [getAddressEncoder().encode(SQUADS as Address)] });
    expect(run([loader(3, foreign)], { inner: true }).alarms).toEqual([]);
  });

  it("mint_to_treasury, top-level or inner, becomes one ledger job for the transaction (no alarm)", () => {
    const mint = { program: R, accounts: accounts(9), data: bytes(getMintToTreasuryInstructionDataEncoder(), { amount: BigInt(10) }) };
    for (const inner of [false, true]) {
      const r = run([mint, mint], { inner });
      expect(r.alarms).toEqual([]);
      expect(r.ledgerJobs).toEqual([{ kind: "treasury_mint", ref: SIG, sharePda: mint.accounts[4] }]);
    }
  });
});

// ── Job processing ─────────────────────────────────────────────────────────

type Call = { kind: string; table?: string; fn?: string; args: unknown };
function mockSb(opts: { failAlert?: boolean } = {}) {
  const calls: Call[] = [];
  const chain = (kind: string, table: string, args: unknown) => {
    calls.push({ kind, table, args });
    const b: Record<string, unknown> = {};
    for (const m of ["eq", "neq", "in", "lte", "order", "limit", "select"]) b[m] = () => b;
    b.abortSignal = () => Promise.resolve({ data: null, error: null });
    return b;
  };
  const sb = {
    from: (table: string) => ({
      update: (args: unknown) => chain("update", table, args),
      upsert: (args: unknown) => chain("upsert", table, args),
    }),
    rpc: (fn: string, args: unknown) => {
      calls.push({ kind: "rpc", fn, args });
      return { abortSignal: () => Promise.resolve(opts.failAlert ? { data: null, error: { code: "08006" } } : { data: { id: "a", inserted: true }, error: null }) };
    },
  };
  return { sb: sb as never, calls };
}
const job = (over: Partial<EventJob> = {}): EventJob => ({
  id: "0b6f7a52-3c1d-4e8f-9a2b-5c6d7e8f9a0b", network: "devnet", signature: SIG, source: "webhook", status: "pending",
  attempts: 0, created_at: new Date().toISOString(), ...over,
});
const update = (calls: Call[]) => calls.filter((c) => c.kind === "update").at(-1)?.args as Record<string, unknown>;
const signal = () => AbortSignal.timeout(5_000);

describe("processEventJob", () => {
  it("writes the alarms and the ledger jobs first, then completes the job", async () => {
    const mint = { program: R, accounts: accounts(9), data: bytes(getMintToTreasuryInstructionDataEncoder(), { amount: BigInt(10) }) };
    state.txs[SIG] = buildTx({ signature: SIG, instructions: [{ ix: pauseFlags(0x02, 0) }, { ix: mint }], logs: null }).tx;
    const { sb, calls } = mockSb();
    expect(await processEventJob(job(), signal(), Date.now() + 5_000, sb)).toBe("complete");
    expect(calls.map((c) => c.fn ?? `${c.kind}:${c.table}`)).toEqual(["raise_system_alert", "upsert:spv_issuance_jobs", "update:onchain_event_jobs"]);
    expect(calls[0].args).toMatchObject({ p_dedup_key: `onchain:${SIG}:0`, p_category: "onchain", p_source: "onchain:pause", p_severity: "high", p_tx_signature: SIG });
    expect(JSON.stringify(calls[0].args)).not.toMatch(/p_wallet|p_client/);
    expect(update(calls)).toMatchObject({ status: "complete", alerts: 1 });
  });

  it("a webhook job not finalized yet retries in 30 s, then is invalid after 30 min; a gap-scan job keeps trying for a day", async () => {
    let m = mockSb();
    expect(await processEventJob(job(), signal(), Date.now() + 5_000, m.sb)).toBe("pending");
    expect(update(m.calls)).toMatchObject({ last_error: "NOT_FINALIZED" });
    expect(Date.parse(String(update(m.calls).next_attempt_at)) - Date.now()).toBeLessThanOrEqual(30_000);
    m = mockSb();
    expect(await processEventJob(job({ created_at: new Date(Date.now() - 31 * 60_000).toISOString() }), signal(), Date.now() + 5_000, m.sb)).toBe("invalid");
    expect(update(m.calls)).toMatchObject({ status: "invalid", last_error: "NOT_FINALIZED" });
    m = mockSb();
    expect(await processEventJob(job({ source: "gap-scan", created_at: new Date(Date.now() - 3 * 3_600_000).toISOString() }), signal(), Date.now() + 5_000, m.sb)).toBe("pending");
    expect(update(m.calls)).toMatchObject({ last_error: "RPC_UNAVAILABLE" });
    m = mockSb();
    expect(await processEventJob(job({ source: "gap-scan", created_at: new Date(Date.now() - 25 * 3_600_000).toISOString() }), signal(), Date.now() + 5_000, m.sb)).toBe("invalid");
  });

  it("an RPC error backs off with a fixed code (never the message); a failed transaction completes with no alert", async () => {
    state.rpcDown = true;
    let m = mockSb();
    expect(await processEventJob(job({ attempts: 2 }), signal(), Date.now() + 5_000, m.sb)).toBe("pending");
    expect(update(m.calls)).toMatchObject({ last_error: "RPC_UNAVAILABLE", attempts: 3 });
    expect(JSON.stringify(m.calls)).not.toMatch(/secret/);
    state.rpcDown = false;
    state.txs[SIG] = buildTx({ signature: SIG, instructions: [{ ix: pauseFlags(0x02, 0) }], err: { InstructionError: [0, "Custom"] } }).tx;
    m = mockSb();
    expect(await processEventJob(job(), signal(), Date.now() + 5_000, m.sb)).toBe("complete");
    expect(m.calls.some((c) => c.fn === "raise_system_alert")).toBe(false);
  });

  it("an exhausted deadline writes no verdict; an alert write failure keeps the job pending; a rerun is idempotent", async () => {
    state.txs[SIG] = buildTx({ signature: SIG, instructions: [{ ix: pauseFlags(0x02, 0) }], logs: null }).tx;
    let m = mockSb();
    expect(await processEventJob(job(), signal(), Date.now() - 1, m.sb)).toBe("pending");
    expect(m.calls).toEqual([]);
    m = mockSb({ failAlert: true });
    expect(await processEventJob(job(), signal(), Date.now() + 5_000, m.sb)).toBe("pending");
    expect(update(m.calls)).toMatchObject({ last_error: "DB_UNAVAILABLE" });
    m = mockSb();
    await processEventJob(job(), signal(), Date.now() + 5_000, m.sb);
    const again = mockSb();
    await processEventJob(job(), signal(), Date.now() + 5_000, again.sb);
    expect(again.calls.find((c) => c.fn)?.args).toEqual(m.calls.find((c) => c.fn)?.args);
  });

  it("refuses a job of another network, and a transaction whose signature differs", async () => {
    await expect(processEventJob(job({ network: "mainnet" }), signal(), Date.now() + 5_000, mockSb().sb)).rejects.toThrow(/another network/);
    state.txs[SIG] = buildTx({ signature: "4".repeat(88), instructions: [{ ix: pauseFlags(0x02, 0) }] }).tx;
    const m = mockSb();
    expect(await processEventJob(job(), signal(), Date.now() + 5_000, m.sb)).toBe("invalid");
    expect(update(m.calls)).toMatchObject({ last_error: "SIGNATURE_MISMATCH" });
  });
});
