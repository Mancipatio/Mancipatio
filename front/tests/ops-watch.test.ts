// kritičar-13 / ops-qa-13: the operational watches of the alarm worker —
// SOL balances of the operational keys and the Squads multisig (its
// configuration and its open proposals). Chain reads are injected.
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/rpc", () => ({ getServerRpc: () => { throw new Error("not in tests"); } }));

import type { Address } from "@solana/kit";
import {
  PROPOSAL_WINDOW, balanceReport, opsWatchReports, parseBalanceWatch, parseSquadsWatch, type AccountFetcher, type WatchedAccount,
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
const run = (env: Record<string, string>, accounts: Record<string, WatchedAccount | null>, open: string[] = []) => {
  const { fetcher, asked } = chain(accounts);
  return opsWatchReports(incidents(open), "mainnet", AbortSignal.timeout(5_000), env, fetcher).then((reports) => ({
    reports, asked, by: Object.fromEntries(reports.map((r) => [r.check, `${r.state}/${r.severity}`])),
  }));
};

describe("configuration", () => {
  it("ALARM_BALANCE_WATCH: label:address[:minSol], at most 20, no duplicates", () => {
    expect(parseBalanceWatch(undefined)).toEqual([]);
    expect(parseBalanceWatch(`super-admin:${A}, kyc:${B}:0.5`)).toEqual([
      { label: "super-admin", address: A, minLamports: SOL / BigInt(10) },
      { label: "kyc", address: B, minLamports: SOL / BigInt(2) },
    ]);
    for (const bad of [`Admin:${A}`, `a:not-an-address`, `a:${A}:0`, `a:${A}:x`, `a:${A}:1:2`, `a:${A},b:${A}`,
      Array.from({ length: 21 }, (_, i) => `k${i}:${A}`).join(",")]) {
      expect(parseBalanceWatch(bad), bad).toBe("invalid");
    }
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
  it("matches the expected configuration and has no open proposal: both pass", async () => {
    const { by } = await run({ ALARM_SQUADS_CONFIG: JSON.stringify(squadsConfig) }, { [MULTISIG]: multisigAccount() });
    expect(by).toEqual({ [`squads-config:${MULTISIG}`]: "pass/critical", [`squads-proposals:${MULTISIG}`]: "pass/high" });
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

  it("an Active proposal is high, an Approved one critical; final and stale Active ones are ignored", async () => {
    const pda = (i: number) => squadsProposalPda(MULTISIG, BigInt(i));
    const accounts: Record<string, WatchedAccount | null> = {
      [MULTISIG]: multisigAccount({ transactionIndex: BigInt(4), stale: BigInt(2) }),
      [await pda(1)]: proposal(1, "Approved", [A, B]),
      [await pda(2)]: proposal(2, "Active"),
      [await pda(3)]: proposal(3, "Executed"),
      [await pda(4)]: proposal(4, "Active", [A]),
    };
    const { by, reports, asked } = await run({ ALARM_SQUADS_CONFIG: JSON.stringify(squadsConfig) }, accounts);
    expect(by[`squads-proposals:${MULTISIG}`]).toBe("fail/critical");
    const open = reports.find((r) => r.check === `squads-proposals:${MULTISIG}`)!;
    expect(open.evidence).toMatchObject({ open: [
      { index: "1", status: "Approved", approvals: 2, stale: true },
      { index: "4", status: "Active", approvals: 1, stale: false },
    ], scanned: ["1", "4"], time_lock: 86_400 });
    expect(open.summary).toContain("#1 Approved (2/2), #4 Active (1/2)");
    expect(asked[1]).toHaveLength(4);
    // Without the Approved one: high.
    accounts[await pda(1)] = proposal(1, "Cancelled");
    expect((await run({ ALARM_SQUADS_CONFIG: JSON.stringify(squadsConfig) }, accounts)).by[`squads-proposals:${MULTISIG}`]).toBe("fail/high");
  });

  it(`reads only the last ${PROPOSAL_WINDOW} transaction indexes`, async () => {
    const { asked } = await run({ ALARM_SQUADS_CONFIG: JSON.stringify(squadsConfig) },
      { [MULTISIG]: multisigAccount({ transactionIndex: BigInt(500) }) });
    expect(asked[1]).toHaveLength(PROPOSAL_WINDOW);
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
    const open = [`sol-balance:${B}`, `squads-proposals:${MULTISIG}`, `fx-stale:${A}`];
    expect((await run({ ALARM_BALANCE_WATCH: `kyc:${A}` }, { [A]: { owner: C, lamports: SOL, data: new Uint8Array() } }, open)).by).toEqual({
      [`sol-balance:${A}`]: "pass/high", [`sol-balance:${B}`]: "pass/high", [`squads-proposals:${MULTISIG}`]: "pass/high",
    });
    expect((await run({ ALARM_BALANCE_WATCH: "nope", ALARM_SQUADS_CONFIG: "{" }, {}, open)).by).toEqual({ "ops-watch-config": "fail/high" });
  });
});
