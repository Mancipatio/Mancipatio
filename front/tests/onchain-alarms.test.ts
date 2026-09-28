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
  RaiseType,
  RealizeAction,
  VaultType,
  getAcceptPlatformAdminInstructionDataEncoder,
  getAddAdminInstructionDataEncoder,
  getApproveHolderInstructionDataEncoder,
  getApproveSaleInstructionDataEncoder,
  getCancelAdminProposalInstructionDataEncoder,
  getCancelCustodyAuthorityTransferInstructionDataEncoder,
  getCancelPlatformAdminTransferInstructionDataEncoder,
  getCancelPlatformRecoveryInstructionDataEncoder,
  getClawbackBlocklistedHolderInstructionDataEncoder,
  getClawbackFromHolderInstructionDataEncoder,
  getCreateProposalInstructionDataEncoder,
  getExecutePlatformRecoveryInstructionDataEncoder,
  getFreezeIssuerProceedsInstructionDataEncoder,
  getLockSupplyInstructionDataEncoder,
  getMintToTreasuryInstructionDataEncoder,
  getOpenCustodyVaultInstructionDataEncoder,
  getOpenVaultVoteInstructionDataEncoder,
  getProposeAdminInstructionDataEncoder,
  getProposePlatformAdminInstructionDataEncoder,
  getProposePlatformRecoveryInstructionDataEncoder,
  getPublishMilestoneInstructionDataEncoder,
  getRealizeCustodyVaultInstructionDataEncoder,
  getReclaimRentInstructionDataEncoder,
  getRevertCustodyVaultInstructionDataEncoder,
  getRevokeHolderInstructionDataEncoder,
  getRouteYieldInstructionDataEncoder,
  getSetIssuerPermissionsInstructionDataEncoder,
  getSetPauseFlagsInstructionDataEncoder,
  getSetPauseInstructionDataEncoder,
  getSetProtocolTreasuryInstructionDataEncoder,
  getTriggerCustodyVaultInstructionDataEncoder,
  getUnfreezeIssuerProceedsInstructionDataEncoder,
  getVerifyIssuerKybInstructionDataEncoder,
} from "@/lib/generated/asset_registry";
import {
  TRANSFER_HOOK_PROGRAM_ADDRESS,
  getAcceptBlocklistAuthorityInstructionDataEncoder,
  getAddToBlocklistInstructionDataEncoder,
  getCancelBlocklistAuthorityTransferInstructionDataEncoder,
  getCancelBlocklistRecoveryInstructionDataEncoder,
  getExecuteBlocklistRecoveryInstructionDataEncoder,
  getProposeBlocklistAuthorityInstructionDataEncoder,
  getProposeBlocklistRecoveryInstructionDataEncoder,
  getRemoveFromBlocklistInstructionDataEncoder,
} from "@/lib/generated/transfer_hook";
import { USDC } from "@/lib/payment-mints";
import {
  ALARM_INSTRUCTIONS,
  BPF_LOADER_UPGRADEABLE,
  LOADER_TAGS,
  LOADER_V4,
  SALE_APPROVAL_HIGH_USDC_UNITS,
  alarmsForTransaction,
  processEventJob,
  programDataAddresses,
  type EventJob,
} from "@/lib/server/onchain-alarms";
import { SOURCE_LABELS } from "@/lib/server/system-alerts";
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
function run(ixs: Ix[], opts: { inner?: boolean; events?: Uint8Array[][]; logs?: "none" | "truncated"; blockTime?: number | null } = {}) {
  const instructions = opts.inner ? [{ ix: { program: SQUADS, accounts: [A], data: new Uint8Array([0]) }, inner: ixs }] : ixs.map((ix) => ({ ix }));
  const frames = ixs.map((ix, k) => ({ program: ix.program, data: (opts.events?.[k] ?? []).map(b64) }));
  let logs: string[] | null = logTree(opts.inner ? [{ program: SQUADS, children: frames }] : frames);
  if (opts.logs === "none") logs = null;
  if (opts.logs === "truncated") logs = [`Program ${R} invoke [1]`, "Log truncated"];
  const { tx } = buildTx({ signature: SIG, instructions, logs, blockTime: opts.blockTime });
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
    // Minimal format: never the holder's wallet or the clawed-back amount (design §4.1, §8.5).
    for (const alarm of [one(run([claw], { events: [[same]] })), one(run([fromHolder]))]) {
      expect(alarm.evidence).not.toHaveProperty("holder");
      expect(alarm.evidence).not.toHaveProperty("args");
      expect(JSON.stringify(alarm.evidence)).not.toMatch(/"(holder|amount)"/);
    }
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
    // Migrate (tag 8) moves the program to loader v4, out of this loader's sight: critical.
    expect(LOADER_TAGS[8]).toEqual({ name: "Migrate", severity: "critical" });
    expect(one(run([loader(8, PD.assetRegistry)], { inner: true }))).toMatchObject({ severity: "critical", summary: expect.stringMatching(/Migrate/) });
  });

  it("any loader-v4 instruction on one of our programs is critical; on another program it is nothing", () => {
    const v4 = (tag: number, program: string) => {
      const data = new Uint8Array(8);
      new DataView(data.buffer).setUint32(0, tag, true);
      return { program: LOADER_V4, accounts: [program, A, B], data };
    };
    for (const tag of [0, 3, 4, 5, 6, 42]) {
      expect(one(run([v4(tag, R)], { inner: true }))).toMatchObject({ source: "onchain:program-upgrade", severity: "critical",
        evidence: { target_program: "asset_registry" } });
    }
    expect(one(run([v4(5, TRANSFER_HOOK_PROGRAM_ADDRESS)])).summary).toMatch(/TransferAuthority on the transfer_hook/);
    expect(run([v4(3, SQUADS)]).alarms).toEqual([]);
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

// prog-vlast-9: Admin actions that move money or tokens (owner decision D6
// keeps blocklist add/remove and approve/revoke_holder out).
describe("admin money and token actions", () => {
  const root = new Uint8Array(32).fill(7);
  const ix = (encoder: { encode: (v: never) => ArrayLike<number> }, args: unknown, n = 12, program: string = R) =>
    ({ program, accounts: accounts(n), data: bytes(encoder, args) });
  const DAY = 86_400;

  it("open_vault_vote: a voting period under 72 h is critical, a longer one high; minimal, with the period and root", () => {
    const vote = (votingPeriod: number) => ix(getOpenVaultVoteInstructionDataEncoder(),
      { snapshotRoot: root, totalWeight: BigInt(1_000), votingPeriod: BigInt(votingPeriod) });
    expect(one(run([vote(DAY)]))).toMatchObject({ source: "onchain:vault-vote", severity: "critical", format: "minimal",
      evidence: { voting_period_seconds: DAY, total_weight: "1000", snapshot_root: "07".repeat(32) } });
    expect(one(run([vote(7 * DAY)])).severity).toBe("high");
    // Inside Squads (inner) too: instruction-first.
    expect(one(run([vote(DAY)], { inner: true })).severity).toBe("critical");
  });

  it("route_yield and publish_milestone are high; create_proposal is medium unless its window is under 72 h", () => {
    expect(one(run([ix(getRouteYieldInstructionDataEncoder(), { amount: BigInt(5_000_000), investorRoot: root, totalWeight: BigInt(9) })])))
      .toMatchObject({ source: "onchain:yield-route", severity: "high", evidence: { amount: "5000000", investor_root: "07".repeat(32) } });
    expect(one(run([ix(getPublishMilestoneInstructionDataEncoder(), { index: 2, merkleRoot: root, amountPool: BigInt(10), unlockTs: BigInt(0) })])))
      .toMatchObject({ source: "onchain:milestone", severity: "high", evidence: { index: 2, amount_pool: "10" } });
    // buildTx's default block time: the window runs from the later of start_ts and it.
    const BLOCK = 1_700_000_000;
    const proposal = (start: number, end: number) => ix(getCreateProposalInstructionDataEncoder(), {
      proposalId: BigInt(1), metadataHash: root, snapshotSlot: BigInt(5), snapshotRoot: root, startTs: BigInt(start), endTs: BigInt(end) });
    expect(one(run([proposal(BLOCK + DAY, BLOCK + 8 * DAY)]))).toMatchObject({ source: "onchain:proposal", severity: "medium",
      evidence: { voting_window_seconds: 7 * DAY, block_time: BLOCK } });
    expect(one(run([proposal(BLOCK + DAY, BLOCK + 2 * DAY)])).severity).toBe("high");
    // start_ts 0 (the admin UI: "open now") or any past start: voting opens at creation.
    expect(one(run([proposal(0, BLOCK + 60)]))).toMatchObject({ severity: "high", evidence: { voting_window_seconds: 60 } });
    expect(one(run([proposal(0, BLOCK + 7 * DAY)])).severity).toBe("medium");
    // Already over (end_ts in the past), or the block time unknown: short.
    expect(one(run([proposal(0, BLOCK - 10)])).severity).toBe("high");
    expect(one(run([proposal(BLOCK + DAY, BLOCK + 8 * DAY)], { blockTime: null })).severity).toBe("high");
  });

  it("lock_supply is high; custody open, trigger and realize are medium; open never names the beneficiary", () => {
    expect(one(run([ix(getLockSupplyInstructionDataEncoder(), {})]))).toMatchObject({ source: "onchain:supply-lock", severity: "high" });
    const open = one(run([ix(getOpenCustodyVaultInstructionDataEncoder(), {
      vaultId: BigInt(3), vaultType: VaultType.DeliveryEscrow, realizeAction: RealizeAction.BurnAndAttest,
      amount: BigInt(777), deadline: BigInt(0), metadataHash: root, beneficiary: C as Address })]));
    expect(open).toMatchObject({ source: "onchain:custody-vault", severity: "medium", format: "minimal",
      evidence: { vault_type: "DeliveryEscrow", realize_action: "BurnAndAttest", vault_id: "3" } });
    expect(JSON.stringify(open.evidence)).not.toContain("777");
    expect(open.evidence).not.toHaveProperty("args");
    expect(open.evidence).not.toHaveProperty("beneficiary");
    expect(one(run([ix(getTriggerCustodyVaultInstructionDataEncoder(), {})])).severity).toBe("medium");
    expect(one(run([ix(getRealizeCustodyVaultInstructionDataEncoder(), {})])).severity).toBe("medium");
  });

  it("revert_custody_vault: a burn (or no event) is high, an empty vault low", () => {
    const revert = ix(getRevertCustodyVaultInstructionDataEncoder(), {});
    expect(one(run([revert], { events: [[encodeEvent("CustodyReverted", { burned: 5 })]] })))
      .toMatchObject({ source: "onchain:custody-vault", severity: "high", evidence: { burned: true } });
    expect(one(run([revert], { events: [[encodeEvent("CustodyReverted", { burned: 0 })]] })).severity).toBe("low");
    expect(one(run([revert], { logs: "none" }))).toMatchObject({ severity: "high", evidence: { burned: null } });
  });

  it("approve_sale: medium below 500,000 USDC, high at or above it or for another payment mint", () => {
    const usdc = USDC.devnet!.mint;
    const approve = (maxGrossRaise: bigint, mint: string = usdc) => {
      const i = ix(getApproveSaleInstructionDataEncoder(), {
        saleId: BigInt(4), maxGrossRaise, minPricePerUnit: BigInt(1), maxPricePerUnit: BigInt(2), raiseType: RaiseType.Mature,
        expiresAt: BigInt(0), applicationHash: root, cliffMonths: 0, vestingMonths: 0 }, 9);
      i.accounts[5] = mint;
      return i;
    };
    expect(one(run([approve(SALE_APPROVAL_HIGH_USDC_UNITS - BigInt(1))])))
      .toMatchObject({ source: "onchain:sale-approval", severity: "medium", evidence: { raise_type: "Mature", sale_id: "4" } });
    expect(one(run([approve(SALE_APPROVAL_HIGH_USDC_UNITS)])).severity).toBe("high");
    expect(one(run([approve(BigInt(1), A)])).severity).toBe("high");
  });

  it("blocklist add/remove and approve/revoke_holder raise nothing (D6); every new source has a fixed label", () => {
    const H = TRANSFER_HOOK_PROGRAM_ADDRESS;
    expect(run([ix(getAddToBlocklistInstructionDataEncoder(), { wallet: B as Address }, 6, H)]).alarms).toEqual([]);
    expect(run([ix(getRemoveFromBlocklistInstructionDataEncoder(), { wallet: B as Address }, 6, H)]).alarms).toEqual([]);
    expect(run([ix(getApproveHolderInstructionDataEncoder(), { holder: B as Address, jurisdiction: 688, accreditationLevel: 0,
      expiry: BigInt(0), providerId: 0, externalRefHash: root })]).alarms).toEqual([]);
    expect(run([ix(getRevokeHolderInstructionDataEncoder(), { holder: B as Address })]).alarms).toEqual([]);
    for (const source of ["vault-vote", "yield-route", "milestone", "proposal", "supply-lock", "custody-vault", "sale-approval"]) {
      expect(SOURCE_LABELS[`onchain:${source}`], source).toMatchObject({ format: "minimal" });
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

// ── v1.0.0-rc (8.3): timelocked role changes, recoveries, the proceeds freeze ──

describe("v1.0.0-rc role changes (D1, D3, D4)", () => {
  const H = TRANSFER_HOOK_PROGRAM_ADDRESS;
  const ix = (encoder: { encode: (v: never) => ArrayLike<number> }, args: unknown, n = 10, program: string = R) =>
    ({ program, accounts: accounts(n), data: bytes(encoder, args) });
  const critical: [string, Ix][] = [
    ["propose_admin", ix(getProposeAdminInstructionDataEncoder(), { newAdmin: C as Address })],
    ["add_admin", ix(getAddAdminInstructionDataEncoder(), { newAdmin: C as Address })],
    ["cancel_admin_proposal", ix(getCancelAdminProposalInstructionDataEncoder(), {})],
    ["propose_platform_admin", ix(getProposePlatformAdminInstructionDataEncoder(), { newAdmin: C as Address })],
    ["accept_platform_admin", ix(getAcceptPlatformAdminInstructionDataEncoder(), {})],
    ["cancel_platform_admin_transfer", ix(getCancelPlatformAdminTransferInstructionDataEncoder(), {})],
    ["freeze_issuer_proceeds", ix(getFreezeIssuerProceedsInstructionDataEncoder(), { reasonHash: new Uint8Array(32).fill(9) })],
    ["unfreeze_issuer_proceeds", ix(getUnfreezeIssuerProceedsInstructionDataEncoder(), {})],
    ["propose_platform_recovery", ix(getProposePlatformRecoveryInstructionDataEncoder(), { newAdmin: C as Address })],
    ["cancel_platform_recovery", ix(getCancelPlatformRecoveryInstructionDataEncoder(), {})],
    ["execute_platform_recovery", ix(getExecutePlatformRecoveryInstructionDataEncoder(), {})],
    ["propose_blocklist_authority", ix(getProposeBlocklistAuthorityInstructionDataEncoder(), { newAuthority: C as Address }, 4, H)],
    ["accept_blocklist_authority", ix(getAcceptBlocklistAuthorityInstructionDataEncoder(), {}, 4, H)],
    ["cancel_blocklist_authority_transfer", ix(getCancelBlocklistAuthorityTransferInstructionDataEncoder(), {}, 3, H)],
    ["propose_blocklist_recovery", ix(getProposeBlocklistRecoveryInstructionDataEncoder(), { newAuthority: C as Address }, 6, H)],
    ["cancel_blocklist_recovery", ix(getCancelBlocklistRecoveryInstructionDataEncoder(), {}, 4, H)],
    ["execute_blocklist_recovery", ix(getExecuteBlocklistRecoveryInstructionDataEncoder(), {}, 7, H)],
  ];

  it("every step is critical, top-level or inside Squads, with or without logs", () => {
    for (const [name, i] of critical) {
      for (const opts of [{}, { inner: true }, { logs: "none" as const }]) {
        const alarm = one(run([i], opts));
        expect(alarm.severity, `${name} ${JSON.stringify(opts)}`).toBe("critical");
        expect(alarm.evidence.instruction, name).toBe(name);
      }
    }
  });

  it("each new source has a fixed label in the entry's format", () => {
    for (const [name, i] of critical) {
      const alarm = one(run([i]));
      expect(SOURCE_LABELS[alarm.source], name).toMatchObject({ format: alarm.format });
    }
    expect(ALARM_INSTRUCTIONS.find((e) => e.name === "freeze_issuer_proceeds")?.format).toBe("minimal");
  });

  it("propose_admin names the window from AdminProposed, or the open bootstrap window", () => {
    const i = critical[0][1];
    const eta = 1_700_172_800;
    const ev = encodeEvent("AdminProposed", { new_admin: C, eta, expires_at: eta + 1_209_600, bootstrap_open: false });
    expect(one(run([i], { events: [[ev]] }))).toMatchObject({ source: "onchain:admin-grant", format: "platform",
      summary: expect.stringContaining("executable from 2023-11-16 22:13 UTC until 2023-11-30 22:13 UTC"),
      evidence: { new_admin: C, eta: String(eta), bootstrap_open: false, args: { newAdmin: C } } });
    const boot = encodeEvent("AdminProposed", { new_admin: C, eta, expires_at: eta + 1, bootstrap_open: true });
    expect(one(run([i], { events: [[boot]] })).summary).toMatch(/bootstrap window open/);
    // No event: still critical, window unknown.
    expect(one(run([i], { logs: "none" }))).toMatchObject({ severity: "critical", evidence: { eta: null, bootstrap_open: null } });
  });

  it("add_admin is the executor (new admin signs), evidence from AdminAdded; the cancels name who cancelled", () => {
    const added = one(run([critical[1][1]], { events: [[encodeEvent("AdminAdded", { admin: C, added_by: B, proposed_at: 5 })]] }));
    expect(added).toMatchObject({ source: "onchain:admin-record", evidence: { admin: C, added_by: B, proposed_at: "5",
      accounts: { new_admin: A, pending_admin: C, proposer: A, admin_record: B } } });
    const cancelled = one(run([critical[2][1]], { events: [[encodeEvent("AdminProposalCancelled", { new_admin: C, proposed_by: A, cancelled_by: B })]] }));
    expect(cancelled).toMatchObject({ source: "onchain:admin-grant", summary: `Admin grant for ${C} cancelled by ${A}` });
    const rotation = one(run([critical[5][1]], { events: [[encodeEvent("AuthorityProposalCancelled", { kind: 0, cancelled_new_authority: C })]] }));
    expect(rotation).toMatchObject({ source: "onchain:platform-admin", evidence: { cancelled_new_authority: C } });
  });

  it("recovery: the proposal names who replaces whom and when; the execute names the old admin", () => {
    const ev = encodeEvent("PlatformRecoveryProposed", { current_admin: B, new_admin: C, eta: 1_700_604_800, expires_at: 1_701_814_400 });
    expect(one(run([critical[8][1]], { events: [[ev]] }))).toMatchObject({ source: "onchain:platform-recovery",
      summary: expect.stringMatching(new RegExp(`${C} replaces ${B} \\(executable from .+ UTC until .+ UTC\\) unless`)),
      evidence: { current_admin: B, new_admin: C } });
    const changed = encodeEvent("PlatformAdminChanged", { old_admin: B, new_admin: A, kind: 1 });
    expect(one(run([critical[10][1]], { events: [[changed]] }))).toMatchObject({ evidence: { old_admin: B, kind: "recovery" } });
    expect(one(run([critical[14][1]]))).toMatchObject({ source: "onchain:blocklist-recovery", evidence: { args: { newAuthority: C } } });
  });

  it("freeze and unfreeze are minimal: the reason's hash and who froze, never the raw arguments", () => {
    const frozen = encodeEvent("IssuerProceedsFrozen", { issuer: B, frozen_by: A, frozen_at: 7, reason_hash: new Uint8Array(32).fill(9) });
    const alarm = one(run([critical[6][1]], { events: [[frozen]] }));
    expect(alarm).toMatchObject({ source: "onchain:issuer-freeze", format: "minimal",
      evidence: { frozen_by: A, frozen_at: "7", reason_hash: "09".repeat(32), accounts: { issuer: A, issuer_freeze: B } } });
    expect(alarm.evidence).not.toHaveProperty("args");
    // No event: the hash from the arguments, the signer as the freezer.
    expect(one(run([critical[6][1]], { logs: "none" })).evidence).toMatchObject({ reason_hash: "09".repeat(32), frozen_by: A });
    expect(one(run([critical[7][1]]))).toMatchObject({ source: "onchain:issuer-freeze", format: "minimal", severity: "critical" });
  });

  it("set_pause_flags: switching the payout modules (0x40) on or off is critical; a set that leaves 0x40 alone is judged by its other bits", () => {
    expect(one(run([pauseFlags(0, 0x40)]))).toMatchObject({ severity: "critical", summary: expect.stringMatching(/Payout modules switched ON/) });
    expect(one(run([pauseFlags(0, 0x40)], { events: [[encodeEvent("PauseFlagsChanged", { old: 0x00, new: 0x00 })]] })).severity).toBe("low");
    expect(one(run([pauseFlags(0x40, 0)]))).toMatchObject({ severity: "critical", summary: expect.stringMatching(/switched off/) });
    // Mainnet keeps 0x40 set: an admin pausing primary issuance with 0x40 in the mask changes only 0x02.
    const primary = one(run([pauseFlags(0x42, 0)], { events: [[encodeEvent("PauseFlagsChanged", { old: 0x40, new: 0x42 })]] }));
    expect(primary).toMatchObject({ severity: "high", summary: expect.stringMatching(/^Pause flags set/) });
    // The full pause stays "Pause flags set", critical.
    expect(one(run([pauseFlags(0x7f, 0)], { events: [[encodeEvent("PauseFlagsChanged", { old: 0x40, new: 0x7f })]] })))
      .toMatchObject({ severity: "critical", summary: expect.stringMatching(/^Pause flags set/) });
  });

  it("a custody rotation cancel is high", () => {
    const cancel = ix(getCancelCustodyAuthorityTransferInstructionDataEncoder(), {}, 6);
    expect(one(run([cancel]))).toMatchObject({ source: "onchain:custody-authority", severity: "high" });
  });
});
