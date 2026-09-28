// kritičar-13 / ops-qa-13: the operational watches of the alarm worker —
// SOL balances of the operational keys and the Squads multisig (its
// configuration and its open proposals). Chain reads are injected.
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/rpc", () => ({ getServerRpc: () => { throw new Error("not in tests"); } }));

import type { Address } from "@solana/kit";
import {
  PROPOSAL_REPORTS_MAX, PROPOSAL_SWEEP_CHUNK, PROPOSAL_WINDOW, balanceReport, opsWatchReports, parseBalanceWatch, parseSquadsWatch,
  proposalScanIndexes, type AccountFetcher, type WatchedAccount,
} from "@/lib/server/ops-watch";
import { SQUADS_V4_PROGRAM, encodeMultisig, encodeProposal, squadsProposalPda, type DecodedProposal } from "@/scripts/chain/lib/squads";

const A = "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2" as Address;
const B = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin" as Address;
const C = "8sHgqRqBEXaSkhcyzXtY3vBSfGqBbTeR2SkVFDcxrfd9" as Address;
const MULTISIG = "75hbt6uvDqjPZ9WgFtMhBnTeyHw7cinoHiz4FD2vEz2d" as Address;
const SOL = BigInt(1_000_000_000);

const squadsConfig = { multisig: MULTISIG, vaultIndex: 0, vault: C, threshold: 2, timeLock: 86_400, configAuthority: null,
  members: [{ key: A, permissions: ["initiate", "vote", "execute"] }, { key: B, permissions: ["vote"] }] };
const multisigAccount = (over: Partial<{ threshold: number; timeLock: number; transactionIndex: bigint; stale: bigint; members: { key: Address; mask: number }[] }> = {}): WatchedAccount => ({
  owner: SQUADS_V4_PROGRAM, lamports: SOL, data: encodeMultisig({
    createKey: C, configAuthority: null, threshold: over.threshold ?? 2, timeLock: over.timeLock ?? 86_400,
    transactionIndex: over.transactionIndex ?? BigInt(0), staleTransactionIndex: over.stale ?? BigInt(0), rentCollector: null, bump: 255,
    members: over.members ?? [{ key: A, mask: 7 }, { key: B, mask: 2 }],
  }),
});
const proposal = (index: number, status: DecodedProposal["status"], approved: Address[] = []): WatchedAccount => ({
  owner: SQUADS_V4_PROGRAM, lamports: SOL,
  data: encodeProposal({ multisig: MULTISIG, transactionIndex: BigInt(index), status, approved, rejected: [], cancelled: [] }),
});

function chain(accounts: Record<string, WatchedAccount | null>) {
  const asked: string[][] = [];
  const fetcher: AccountFetcher = async (addresses) => {
    asked.push(addresses);
    return new Map(addresses.map((a) => [a, accounts[a] ?? null]));
  };
  return { fetcher, asked };
}
function incidents(keys: string[] = []) {
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "is", "not", "limit"]) b[m] = () => b;
  b.abortSignal = () => Promise.resolve({ data: keys.map((check_key) => ({ check_key })), error: null });
  return { from: () => b } as never;
}
const run = (env: Record<string, string>, accounts: Record<string, WatchedAccount | null>, open: string[] = [], now = 0) => {
  const { fetcher, asked } = chain(accounts);
  return opsWatchReports(incidents(open), "mainnet", AbortSignal.timeout(5_000), env, fetcher, { now }).then((reports) => ({
    reports, asked, by: Object.fromEntries(reports.map((r) => [r.check, `${r.state}/${r.severity}`])),
  }));
};
const pda = (i: number) => squadsProposalPda(MULTISIG, BigInt(i));

describe("configuration", () => {
  it("ALARM_BALANCE_WATCH: label:address[:minSol], at most 20 entries", () => {
    expect(parseBalanceWatch(undefined)).toEqual([]);
    expect(parseBalanceWatch(`super-admin:${A}, kyc:${B}:0.5`)).toEqual([
      { label: "super-admin", address: A, minLamports: SOL / BigInt(10) },
      { label: "kyc", address: B, minLamports: SOL / BigInt(2) },
    ]);
    for (const bad of [`Admin:${A}`, `a:not-an-address`, `a:${A}:0`, `a:${A}:x`, `a:${A}:1:2`,
      Array.from({ length: 21 }, (_, i) => `k${i}:${A}`).join(",")]) {
      expect(parseBalanceWatch(bad), bad).toBe("invalid");
    }
  });

  it("one company wallet in every role: its entries merge into one watch (all labels, the highest threshold)", async () => {
    const env = `super-admin:${A},admin:${A}:0.5,kyc:${A},blocklist:${A},treasury:${A}:0.2,admin:${A},buffer:${B}`;
    expect(parseBalanceWatch(env)).toEqual([
      { label: "super-admin+admin+kyc+blocklist+treasury", address: A, minLamports: SOL / BigInt(2) },
      { label: "buffer", address: B, minLamports: SOL / BigInt(10) },
    ]);
    const { by, reports, asked } = await run({ ALARM_BALANCE_WATCH: env }, { [A]: { owner: C, lamports: SOL / BigInt(4), data: new Uint8Array() } });
    expect(by).toEqual({ [`sol-balance:${A}`]: "fail/high", [`sol-balance:${B}`]: "fail/high" });
    expect(asked).toEqual([[A, B]]);
    expect(reports[0].summary).toContain("super-admin+admin+kyc+blocklist+treasury");
  });

  it("ALARM_SQUADS_CONFIG: the role map's squads object", () => {
    expect(parseSquadsWatch("")).toBeNull();
    expect(parseSquadsWatch(JSON.stringify(squadsConfig))).toMatchObject({ multisig: MULTISIG, threshold: 2, timeLock: 86_400 });
    for (const bad of ["{", "[]", JSON.stringify({ ...squadsConfig, threshold: 0 }), JSON.stringify({ ...squadsConfig, members: [] }),
      JSON.stringify({ ...squadsConfig, members: [{ key: A, permissions: ["admin"] }] }), JSON.stringify({ ...squadsConfig, multisig: "x" })]) {
      expect(parseSquadsWatch(bad), bad).toBe("invalid");
    }
  });
});

describe("SOL balances", () => {
  it("fails below the threshold, holds up to 1.25 ×, passes above; a missing account is 0 SOL", async () => {
    const watch = { label: "kyc", address: A, minLamports: SOL / BigInt(10) };
    expect(balanceReport(watch, SOL / BigInt(20))).toMatchObject({ check: `sol-balance:${A}`, state: "fail", severity: "high",
      source: "onchain:low-balance", category: "onchain" });
    expect(balanceReport(watch, (SOL / BigInt(10)) + BigInt(1)).state).toBe("hold");
    expect(balanceReport(watch, SOL).state).toBe("pass");
    expect(balanceReport(watch, BigInt(5e7)).summary).toContain("has 0.05 SOL, below 0.1 SOL");
    const { by, asked } = await run({ ALARM_BALANCE_WATCH: `kyc:${A},admin:${B}:1` }, { [A]: { owner: C, lamports: SOL, data: new Uint8Array() } });
    expect(by).toEqual({ [`sol-balance:${A}`]: "pass/high", [`sol-balance:${B}`]: "fail/high" });
    expect(asked).toEqual([[A, B]]);
  });
});

describe("Squads multisig", () => {
  it("matches the expected configuration and has no open proposal: the config passes, no proposal incident", async () => {
    const { by, asked } = await run({ ALARM_SQUADS_CONFIG: JSON.stringify(squadsConfig) }, { [MULTISIG]: multisigAccount() });
    expect(by).toEqual({ [`squads-config:${MULTISIG}`]: "pass/critical" });
    expect(asked).toEqual([[MULTISIG]]);
  });

  it("a changed threshold, time lock or member is a critical config incident; so is a missing or foreign account", async () => {
    const changed = await run({ ALARM_SQUADS_CONFIG: JSON.stringify(squadsConfig) },
      { [MULTISIG]: multisigAccount({ threshold: 1, timeLock: 0, members: [{ key: A, mask: 7 }, { key: C, mask: 7 }] }) });
    expect(changed.by[`squads-config:${MULTISIG}`]).toBe("fail/critical");
    const summary = changed.reports[0].summary;
    for (const text of ["threshold 1", "time_lock 0", `member ${B} missing`]) expect(summary).toContain(text);
    expect((await run({ ALARM_SQUADS_CONFIG: JSON.stringify(squadsConfig) }, {})).by)
      .toEqual({ [`squads-config:${MULTISIG}`]: "fail/critical" });
    const foreign = { ...multisigAccount(), owner: C };
    expect((await run({ ALARM_SQUADS_CONFIG: JSON.stringify(squadsConfig) }, { [MULTISIG]: foreign })).by[`squads-config:${MULTISIG}`])
      .toBe("fail/critical");
  });

  it("one incident per open proposal: Active high, Approved critical; final and stale Active ones are not open", async () => {
    const accounts: Record<string, WatchedAccount | null> = {
      [MULTISIG]: multisigAccount({ transactionIndex: BigInt(4), stale: BigInt(2) }),
      [await pda(1)]: proposal(1, "Approved", [A, B]),
      [await pda(2)]: proposal(2, "Active"),
      [await pda(3)]: proposal(3, "Executed"),
      [await pda(4)]: proposal(4, "Active", [A]),
    };
    const { by, reports, asked } = await run({ ALARM_SQUADS_CONFIG: JSON.stringify(squadsConfig) }, accounts);
    expect(by).toEqual({ [`squads-config:${MULTISIG}`]: "pass/critical",
      [`squads-proposal:${await pda(1)}`]: "fail/critical", [`squads-proposal:${await pda(4)}`]: "fail/high" });
    const first = `squads-proposal:${await pda(1)}`;
    const approved = reports.find((r) => r.check === first)!;
    expect(approved.evidence).toMatchObject({ multisig: MULTISIG, index: "1", status: "Approved", approvals: 2, threshold: 2, stale: true,
      time_lock: 86_400, open_proposals: 2 });
    expect(approved.summary).toContain("proposal #1 is Approved (2/2 approvals, stale)");
    expect(asked[1]).toHaveLength(4);
  });

  it("a new proposal while another is open (or acknowledged) is an incident of its own; a finished one passes", async () => {
    const accounts: Record<string, WatchedAccount | null> = {
      [MULTISIG]: multisigAccount({ transactionIndex: BigInt(2) }),
      [await pda(1)]: proposal(1, "Approved", [A, B]),
      [await pda(2)]: proposal(2, "Active", [A]),
    };
    const open = [`squads-proposal:${await pda(1)}`];
    const second = await run({ ALARM_SQUADS_CONFIG: JSON.stringify(squadsConfig) }, accounts, open);
    expect(second.by[`squads-proposal:${await pda(2)}`]).toBe("fail/high");
    expect(second.by[`squads-proposal:${await pda(1)}`]).toBe("fail/critical");
    accounts[await pda(1)] = proposal(1, "Executed");
    const done = await run({ ALARM_SQUADS_CONFIG: JSON.stringify(squadsConfig) }, accounts, open);
    expect(done.by[`squads-proposal:${await pda(1)}`]).toBe("pass/high");
    // A closed (missing) account passes too; one that never had an incident reports nothing.
    accounts[await pda(1)] = null;
    expect((await run({ ALARM_SQUADS_CONFIG: JSON.stringify(squadsConfig) }, accounts, open)).by[`squads-proposal:${await pda(1)}`]).toBe("pass/high");
    expect((await run({ ALARM_SQUADS_CONFIG: JSON.stringify(squadsConfig) }, accounts)).by).not.toHaveProperty(`squads-proposal:${await pda(1)}`);
  });

  it(`reads the newest ${PROPOSAL_WINDOW} indexes and one older chunk of ${PROPOSAL_SWEEP_CHUNK} in rotation, so a flood cannot hide one`, async () => {
    expect(proposalScanIndexes(BigInt(40), 0)).toEqual({ recent: Array.from({ length: 40 }, (_, i) => BigInt(i + 1)), sweep: [] });
    // 350 transactions: the newest 100, and 250 older ones in 3 chunks, one per minute.
    const chunks = [0, 1, 2, 3].map((minute) => proposalScanIndexes(BigInt(350), minute * 60_000).sweep);
    expect(chunks.map((c) => [c[0], c.at(-1)])).toEqual([
      [BigInt(1), BigInt(100)], [BigInt(101), BigInt(200)], [BigInt(201), BigInt(250)], [BigInt(1), BigInt(100)],
    ]);
    expect(proposalScanIndexes(BigInt(350), 0).recent[0]).toBe(BigInt(251));
    // The malicious #7, then 300 empty transactions: found by the sweep.
    const accounts = { [MULTISIG]: multisigAccount({ transactionIndex: BigInt(307) }), [await pda(7)]: proposal(7, "Active", [A]) };
    const { by, asked } = await run({ ALARM_SQUADS_CONFIG: JSON.stringify(squadsConfig) }, accounts, [], 0);
    expect(asked.map((a) => a.length)).toEqual([1, PROPOSAL_WINDOW, PROPOSAL_SWEEP_CHUNK]);
    expect(by[`squads-proposal:${await pda(7)}`]).toBe("fail/high");
  });

  it("a proposal whose incident is open is read wherever its index is, and keeps failing while open", async () => {
    const accounts = { [MULTISIG]: multisigAccount({ transactionIndex: BigInt(500) }), [await pda(7)]: proposal(7, "Approved", [A, B]) };
    // Minute 3: the sweep reads 301–400, not #7.
    const { by, asked } = await run({ ALARM_SQUADS_CONFIG: JSON.stringify(squadsConfig) }, accounts, [`squads-proposal:${await pda(7)}`], 3 * 60_000);
    expect(asked.at(-1)).toEqual([await pda(7)]);
    expect(by[`squads-proposal:${await pda(7)}`]).toBe("fail/critical");
  });

  it(`reports at most ${PROPOSAL_REPORTS_MAX} open proposals a run, executable first; the rest keep their incidents`, async () => {
    const accounts: Record<string, WatchedAccount | null> = { [MULTISIG]: multisigAccount({ transactionIndex: BigInt(30) }) };
    for (let i = 1; i <= 30; i++) accounts[await pda(i)] = proposal(i, i === 2 ? "Approved" : "Active");
    const open = [`squads-proposal:${await pda(1)}`];
    const { reports, by } = await run({ ALARM_SQUADS_CONFIG: JSON.stringify(squadsConfig) }, accounts, open);
    const proposals = reports.filter((r) => r.check.startsWith("squads-proposal:"));
    expect(proposals).toHaveLength(PROPOSAL_REPORTS_MAX);
    expect(proposals[0].check).toBe(`squads-proposal:${await pda(2)}`);
    // #1 is still open, over the cap: no pass that would clear it.
    expect(by).not.toHaveProperty(`squads-proposal:${await pda(1)}`);
  });

  it("an undecodable Squads-owned proposal account is critical; one the Squads program does not own is not a proposal", async () => {
    const accounts: Record<string, WatchedAccount | null> = {
      [MULTISIG]: multisigAccount({ transactionIndex: BigInt(2) }),
      [await pda(1)]: { owner: SQUADS_V4_PROGRAM, lamports: SOL, data: new Uint8Array(12) },
      [await pda(2)]: { owner: "11111111111111111111111111111111", lamports: SOL, data: new Uint8Array() },
    };
    const { by } = await run({ ALARM_SQUADS_CONFIG: JSON.stringify(squadsConfig) }, accounts);
    expect(by).toEqual({ [`squads-config:${MULTISIG}`]: "pass/critical", [`squads-proposal:${await pda(1)}`]: "fail/critical" });
  });
});

describe("opsWatchReports", () => {
  it("nothing configured and nothing open: no report, no chain read", async () => {
    const { reports, asked } = await run({}, {});
    expect(reports).toEqual([]);
    expect(asked).toEqual([]);
  });

  it("an unparseable value is its own incident; fixed, it clears", async () => {
    expect((await run({ ALARM_BALANCE_WATCH: "nope" }, {})).by).toEqual({ "ops-watch-config": "fail/high" });
    const fixed = await run({}, {}, ["ops-watch-config"]);
    expect(fixed.by).toEqual({ "ops-watch-config": "pass/high" });
  });

  it("open incidents of keys or a multisig no longer watched report pass; an invalid value keeps them", async () => {
    const open = [`sol-balance:${B}`, `squads-config:${MULTISIG}`, `squads-proposal:${await pda(1)}`, `fx-stale:${A}`];
    expect((await run({ ALARM_BALANCE_WATCH: `kyc:${A}` }, { [A]: { owner: C, lamports: SOL, data: new Uint8Array() } }, open)).by).toEqual({
      [`sol-balance:${A}`]: "pass/high", [`sol-balance:${B}`]: "pass/high", [`squads-config:${MULTISIG}`]: "pass/critical",
      [`squads-proposal:${await pda(1)}`]: "pass/high",
    });
    expect((await run({ ALARM_BALANCE_WATCH: "nope", ALARM_SQUADS_CONFIG: "{" }, {}, open)).by).toEqual({ "ops-watch-config": "fail/high" });
  });

  it("a hanging chain read fails the watch within its own timeout, even if the fetcher ignores the signal", async () => {
    const hang: AccountFetcher = () => new Promise(() => {});
    const started = Date.now();
    await expect(opsWatchReports(incidents(), "mainnet", AbortSignal.timeout(30_000), { ALARM_BALANCE_WATCH: `kyc:${A}` }, hang,
      { rpcTimeoutMs: 50 })).rejects.toThrow(/timed out/);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
