// Talas 6.3b/c on v1.0.0-rc: the e2e groups G4–G8 (conversion and
// delivery, distributions / vesting / rights / governance under the payout
// modules bit, clawback, the pause matrix, rotations and recoveries) and the
// localnet clock warp they need. Offline: the matrix data, the E2E_WARP /
// E2E_DEVNET_G4_G6 gates, the warp slot arithmetic and the clock helper.
import { describe, expect, it } from "vitest";
import { readE2eConfig } from "@/scripts/chain/lib/e2e/config";
import { ANCHOR_ACCOUNT_NOT_INITIALIZED, E2E_STEPS, stepSpec, stepsFor } from "@/scripts/chain/lib/e2e/matrix";
import { implementedGroups } from "@/scripts/chain/lib/e2e/tool";
import { DEFAULT_RATE_MICRO, decodeClock, decodeEpochSchedule, localnetWarp, observedRate, planWarp } from "@/scripts/chain/lib/e2e/warp";
import { MAX_CLOCK_WAIT_S, WARP_MIN_GAP_S, reachChainTime, type World } from "@/scripts/chain/lib/e2e/world";
import type { Journal } from "@/scripts/chain/lib/journal";
import type { ChainRpc } from "@/scripts/chain/lib/rpc";

const PAYER = "CekAgg4nCW8tgUETKstwBxKXcWDC5SFRTaZPyQ1vM8vA";
const ROOT = "/nonexistent-root";

/** "<networks> <ok | code name>" of a step, for compact expectations. */
function outcome(id: string): string {
  const spec = stepSpec(id);
  return `${spec.networks.join("+")} ${spec.expect.ok ? "ok" : `${spec.expect.program === "transfer_hook" ? "hook " : ""}${spec.expect.code} ${spec.expect.name}`}`;
}

describe("e2e matrix G4–G8 (v1.0.0-rc)", () => {
  it("G4: the retired conversion vault, the delivery deadline bounds, the beneficiary's deposit, realize only with a passport, the return", () => {
    expect(["4.0", "4.1", "4.3a", "4.3b", "4.5", "4.8", "4.10", "4.11d", "4.11e", "4.12c", "4.12d"].map(outcome)).toEqual([
      "devnet ok",
      "devnet+localnet 6142 VaultTypeRetired",
      "devnet+localnet 6148 DeliveryDeadlineOutOfRange",
      "devnet+localnet 6148 DeliveryDeadlineOutOfRange",
      "devnet+localnet 6084 DepositorNotBeneficiary",
      `devnet+localnet ${ANCHOR_ACCOUNT_NOT_INITIALIZED} AccountNotInitialized`,
      "devnet+localnet ok",
      `devnet+localnet ${ANCHOR_ACCOUNT_NOT_INITIALIZED} AccountNotInitialized`,
      "devnet+localnet ok",
      "localnet 6052 ReturnNotAllowed",
      "localnet ok",
    ]);
    // The passport is issued between the refused and the landing realize.
    const g4 = stepsFor("localnet", [4]).map((s) => s.id);
    expect(g4.indexOf("4.8")).toBeLessThan(g4.indexOf("4.9"));
    expect(g4.indexOf("4.9")).toBeLessThan(g4.indexOf("4.10"));
  });

  it("G5: 0x40 refuses the payout modules (6000), is cleared on its own by the SA and set again at the end; the vault vote runs at least 7 days (6147)", () => {
    expect(["5.2e", "5.3c", "5.3e", "5.4b", "5.4c", "5.4d", "5.5d", "5.6d", "5.6f", "5.6g", "5.7"].map(outcome)).toEqual([
      "devnet+localnet 6100 VestingNothingToClaim",
      "devnet+localnet 6030 InvalidMerkleProof",
      "devnet+localnet 6031 ProposalNotEnded",
      "localnet 6000 PlatformPaused",
      "localnet 6000 PlatformPaused",
      "localnet ok",
      "localnet 6032 MilestoneLocked",
      "localnet 6038 UpdateRequired",
      "localnet 6147 VotingPeriodTooShort",
      "localnet ok",
      "localnet ok",
    ]);
    expect(stepSpec("5.4d").signer).toBe("superAdmin");
    expect(stepSpec("5.7").signer).toBe("admin");
    const g5 = stepsFor("localnet", [5]).map((s) => s.id);
    // Refused while set, cleared before any payout-module entry lands, set again last.
    expect(g5.indexOf("5.4c")).toBeLessThan(g5.indexOf("5.4d"));
    expect(g5.indexOf("5.4d")).toBeLessThan(g5.indexOf("5.5a"));
    expect(g5[g5.length - 1]).toBe("5.7");
    // Devnet runs the distribution, vesting and governance subset only.
    expect(stepsFor("devnet", [5]).every((s) => /^5\.[0-3]/.test(s.id))).toBe(true);
  });

  it("G6: clawback is refused on an Open class (6080) and for a holder who is not blocked (6137); a blocked sender stops in the hook (6003); a valid or graced passport is not clawed back (6079)", () => {
    expect(["6.2", "6.3", "6.4b", "6.6b", "6.6c", "6.6d", "6.6e"].map(outcome)).toEqual([
      "devnet+localnet 6080 ClawbackNotKycGated",
      "devnet+localnet 6137 ClawbackHolderNotBlocked",
      "localnet hook 6003 SenderBlocked",
      "localnet ok",
      "localnet 6079 ClawbackHolderStillEligible",
      "localnet 6079 ClawbackHolderStillEligible",
      "localnet ok",
    ]);
    expect(stepsFor("devnet", [6]).map((s) => s.id)).toEqual(["6.1", "6.2", "6.3"]);
  });

  it("G7: each emergency bit is set by an Admin, refuses its entries (6000) and is cleared by the SA; under 0x7F the exits land; 0x40 clears only on its own (6154)", () => {
    const g7 = stepsFor("localnet", [7]);
    expect(stepsFor("devnet", [7])).toEqual([]);
    for (const prefix of ["7.2", "7.3", "7.4", "7.5", "7.6", "7.7"]) {
      const round = g7.filter((s) => s.id.startsWith(`${prefix}`));
      expect(round[0].title, prefix).toMatch(/^set_pause_flags\(set /);
      expect(round[0].signer).toBe("admin");
      expect(round[round.length - 1].title, prefix).toMatch(/^set_pause_flags\(clear /);
      expect(round[round.length - 1].signer).toBe("superAdmin");
      for (const entry of round.slice(1, -1)) expect(outcome(entry.id), entry.id).toBe("localnet 6000 PlatformPaused");
    }
    expect(g7.filter((s) => s.id.startsWith("7.1")).map((s) => outcome(s.id))).toEqual(Array(3).fill("localnet 6000 PlatformPaused"));
    expect(outcome("7.8b")).toBe("localnet 6119 PauseClearNotAllowed");
    expect(outcome("7.9a")).toBe("localnet 6154 PayoutModulesClearNotExplicit");
    for (const exit of g7.filter((s) => /^7\.8[c-s]$/.test(s.id))) expect(exit.expect.ok, exit.id).toBe(true);
    const ids = g7.map((s) => s.id);
    expect(ids.indexOf("7.8a")).toBeLessThan(ids.indexOf("7.8c"));
    expect(ids.slice(-3)).toEqual(["7.9a", "7.9b", "7.9c"]);
  });

  it("G8: rotations refuse the old key, timelocks (6150, 6131) and a pending recovery (6155, hook 6020); the issuer recovery executes before the Super Admin recovery", () => {
    expect(["8.1e", "8.2g", "8.3b", "8.3c", "8.4c", "8.5b", "8.6b", "8.6f", "8.6g", "8.7b", "8.7c", "8.8e", "8.9c", "8.9h", "8.7f"].map(outcome)).toEqual([
      "localnet 6001 Unauthorized",
      "localnet 6112 InvalidProposedAuthority",
      "localnet 6001 Unauthorized",
      "localnet 6120 InvalidProtocolTreasury",
      "localnet hook 6004 Unauthorized",
      "localnet 6131 IssuerRecoveryTimelockActive",
      "localnet 6150 TimelockActive",
      `localnet ${ANCHOR_ACCOUNT_NOT_INITIALIZED} AccountNotInitialized`,
      "localnet 6114 CannotRevokePlatformAdmin",
      "localnet 6150 TimelockActive",
      "localnet 6155 PlatformRecoveryPending",
      "localnet 6001 Unauthorized",
      "localnet hook 6020 RecoveryPending",
      "localnet hook 6004 Unauthorized",
      "localnet 6001 Unauthorized",
    ]);
    const g8 = stepsFor("localnet", [8]).map((s) => s.id);
    expect(stepsFor("devnet", [8])).toEqual([]);
    // execute_issuer_recovery needs its proposer (SA1) to still be the Super Admin.
    expect(g8.indexOf("8.5e")).toBeLessThan(g8.indexOf("8.8d"));
    // A cancel, then a new proposal, before each recovery executes.
    for (const [cancel, again, execute] of [["8.5c", "8.5d", "8.5e"], ["8.8b", "8.8c", "8.8d"], ["8.9e", "8.9f", "8.9g"]]) {
      expect(g8.indexOf(cancel)).toBeLessThan(g8.indexOf(again));
      expect(g8.indexOf(again)).toBeLessThan(g8.indexOf(execute));
    }
    expect(g8[g8.length - 1]).toBe("8.7h");
  });

  it("covers every group 0..8 and keeps the localnet-only steps off devnet", () => {
    expect(new Set(E2E_STEPS.map((s) => s.group))).toEqual(new Set([0, 1, 2, 3, 4, 5, 6, 7, 8]));
    expect(stepsFor("devnet", [4, 5, 6]).length).toBeGreaterThan(0);
    expect(stepsFor("devnet", [4, 5, 6]).every((s) => s.networks.includes("devnet"))).toBe(true);
  });
});

describe("groups per network and the new E2E_* switches", () => {
  it("localnet implements 0..8; devnet 4–6 only with E2E_DEVNET_G4_G6, never 7–8", () => {
    expect(implementedGroups("localnet", false)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(implementedGroups("devnet", false)).toEqual([0, 1, 2, 3]);
    expect(implementedGroups("devnet", true)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("E2E_WARP is localnet only; E2E_DEVNET_G4_G6 only means something on devnet", () => {
    expect(readE2eConfig({ E2E_PAYER: PAYER, E2E_WARP: "1" }, "localnet", ROOT).warp).toBe(true);
    expect(readE2eConfig({ E2E_PAYER: PAYER }, "localnet", ROOT).warp).toBe(false);
    expect(() => readE2eConfig({ E2E_PAYER: PAYER, E2E_WARP: "1" }, "devnet", ROOT)).toThrow(/localnet only/);
    expect(readE2eConfig({ E2E_PAYER: PAYER, E2E_DEVNET_G4_G6: "1" }, "devnet", ROOT).devnetG4G6).toBe(true);
    expect(readE2eConfig({ E2E_PAYER: PAYER, E2E_DEVNET_G4_G6: "1" }, "localnet", ROOT).devnetG4G6).toBe(false);
  });
});

describe("localnet warp", () => {
  const L = BigInt(20_000_000);
  const flat = { slotsPerEpoch: L, warmup: false, firstNormalEpoch: BigInt(0), firstNormalSlot: BigInt(0) };
  const GENESIS = BigInt(1_790_000_000);

  it("resets first: in epoch 0, when the clock stopped, or when its epoch is no longer fresh", () => {
    const reset = { kind: "reset", slot: BigInt(3) * L };
    // A fresh ledger in epoch 0 (the clock follows the votes there).
    const epoch0 = { slot: BigInt(4_000), epoch: BigInt(0), epochStartTimestamp: GENESIS, unixTimestamp: GENESIS + BigInt(1_600) };
    expect(planWarp({ clock: epoch0, moving: true, schedule: flat, target: epoch0.unixTimestamp + BigInt(90_000), rateMicro: DEFAULT_RATE_MICRO })).toEqual(reset);
    // Stopped after a jump: a reset, whether or not the target is reached.
    const stopped = { slot: BigInt(310_000), epoch: BigInt(0), epochStartTimestamp: GENESIS, unixTimestamp: GENESIS + BigInt(120_000) };
    expect(planWarp({ clock: stopped, moving: false, schedule: flat, target: GENESIS + BigInt(90_000), rateMicro: DEFAULT_RATE_MICRO })).toEqual(reset);
    expect(planWarp({ clock: stopped, moving: false, schedule: flat, target: GENESIS + BigInt(500_000), rateMicro: DEFAULT_RATE_MICRO })).toEqual(reset);
    // 14M slots into epoch 6: even the smallest warp there would move the clock by weeks.
    const late = { slot: BigInt(134_190_798), epoch: BigInt(6), epochStartTimestamp: GENESIS, unixTimestamp: GENESIS + BigInt(9_000_000) };
    expect(planWarp({ clock: late, moving: true, schedule: flat, target: late.unixTimestamp + BigInt(604_800), rateMicro: DEFAULT_RATE_MICRO })).toEqual({
      kind: "reset",
      slot: BigInt(9) * L,
    });
  });

  it("jumps from a fresh epoch's first slot by (target + margin − now) / rate slots; done only when there and moving", () => {
    const fresh = { slot: BigInt(3) * L + BigInt(450), epoch: BigInt(3), epochStartTimestamp: GENESIS, unixTimestamp: GENESIS + BigInt(100_000) };
    // 7 days + the margin at 0.1875 s per slot: 3,227,200 slots from the epoch's first slot.
    expect(planWarp({ clock: fresh, moving: true, schedule: flat, target: fresh.unixTimestamp + BigInt(604_800), rateMicro: DEFAULT_RATE_MICRO })).toEqual({
      kind: "jump",
      slot: BigInt(3) * L + BigInt(3_227_200),
    });
    // A near target still clears the slot guard; a far one stops at the epoch's end.
    expect(planWarp({ clock: fresh, moving: true, schedule: flat, target: fresh.unixTimestamp + BigInt(1), rateMicro: DEFAULT_RATE_MICRO })).toEqual({
      kind: "jump",
      slot: fresh.slot + BigInt(2_000),
    });
    expect(planWarp({ clock: fresh, moving: true, schedule: flat, target: fresh.unixTimestamp + BigInt(60 * 86_400), rateMicro: DEFAULT_RATE_MICRO })).toEqual({
      kind: "jump",
      slot: BigInt(4) * L - BigInt(2_000),
    });
    expect(planWarp({ clock: fresh, moving: true, schedule: flat, target: fresh.unixTimestamp - BigInt(1), rateMicro: DEFAULT_RATE_MICRO })).toEqual({ kind: "done" });
    expect(planWarp({ clock: fresh, moving: false, schedule: flat, target: fresh.unixTimestamp - BigInt(1), rateMicro: DEFAULT_RATE_MICRO })).toEqual({
      kind: "reset",
      slot: BigInt(6) * L,
    });
  });

  it("learns the rate a jump showed from its epoch's first slot", () => {
    // The G8 jump of the first full run: 2,780,825 s over 14,830,996 slots from slot 120M.
    const before = { slot: BigInt(134_190_798), epoch: BigInt(6), epochStartTimestamp: BigInt(0), unixTimestamp: BigInt(1_800_361_269) };
    const after = { ...before, slot: BigInt(134_830_996), unixTimestamp: BigInt(1_803_142_094) };
    expect(observedRate(before, after, BigInt(120_000_000))).toBe(BigInt(187_500));
    expect(observedRate(before, { ...after, unixTimestamp: before.unixTimestamp }, BigInt(120_000_000))).toBeNull();
    expect(observedRate(before, after, after.slot)).toBeNull();
  });

  it("decodes the Clock and EpochSchedule sysvars; a warmup schedule is refused", () => {
    const clock = new Uint8Array(40);
    const view = new DataView(clock.buffer);
    view.setBigUint64(0, BigInt(77), true);
    view.setBigInt64(8, BigInt(1_000), true);
    view.setBigUint64(16, BigInt(2), true);
    view.setBigInt64(32, BigInt(1_234), true);
    expect(decodeClock(clock)).toEqual({ slot: BigInt(77), epochStartTimestamp: BigInt(1_000), epoch: BigInt(2), unixTimestamp: BigInt(1_234) });
    expect(() => decodeClock(new Uint8Array(39))).toThrow(/truncated/);
    const data = new Uint8Array(33);
    const sched = new DataView(data.buffer);
    sched.setBigUint64(0, L, true);
    sched.setBigUint64(8, L, true);
    expect(decodeEpochSchedule(data)).toEqual(flat);
    expect(() => decodeEpochSchedule(new Uint8Array(10))).toThrow(/truncated/);
    const warm = { slotsPerEpoch: BigInt(432_000), warmup: true, firstNormalEpoch: BigInt(14), firstNormalSlot: BigInt(524_256) };
    const early = { slot: BigInt(100), epoch: BigInt(2), epochStartTimestamp: GENESIS, unixTimestamp: GENESIS };
    expect(() => planWarp({ clock: early, moving: true, schedule: warm, target: GENESIS + BigInt(10), rateMicro: DEFAULT_RATE_MICRO })).toThrow(/warmup/);
  });

  it("is off unless enabled, and restarts only the loopback validator on the script's RPC port", () => {
    const base = {
      enabled: true,
      network: "localnet",
      rpcUrl: "http://127.0.0.1:18300",
      env: { E2E_RPC_PORT: "18300" },
      frontDir: "/nonexistent-front",
      rpc: {} as ChainRpc,
      journal: { append: () => undefined } as unknown as Journal,
      log: () => undefined,
    };
    expect(localnetWarp({ ...base, enabled: false })).toBeNull();
    expect(typeof localnetWarp(base)).toBe("function");
    expect(() => localnetWarp({ ...base, network: "devnet" })).toThrow(/localnet only/);
    expect(() => localnetWarp({ ...base, rpcUrl: "http://10.0.0.5:18300" })).toThrow(/127\.0\.0\.1/);
    expect(() => localnetWarp({ ...base, rpcUrl: "http://127.0.0.1:8999" })).toThrow(/not the e2e-localnet\.sh RPC port 18300/);
    // Without E2E_RPC_PORT the script's default port is 8999.
    expect(typeof localnetWarp({ ...base, rpcUrl: "http://127.0.0.1:8999", env: {} })).toBe("function");
  });
});

describe("reachChainTime", () => {
  function world(start: bigint, warp: ((target: bigint) => void) | null) {
    let now = start;
    const clock = () => {
      const data = Buffer.alloc(40);
      data.writeBigInt64LE(now, 32);
      return data.toString("base64");
    };
    const warps: bigint[] = [];
    const sleeps: number[] = [];
    const w = {
      rpc: { getAccountInfo: () => ({ send: async () => ({ value: { data: [clock(), "base64"] } }) }) },
      warp: warp
        ? async (target: bigint) => {
            warps.push(target);
            warp(target);
            now = target + BigInt(300);
          }
        : null,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        now += BigInt(ms / 1000);
      },
      signal: new AbortController().signal,
      log: () => undefined,
    } as unknown as World;
    return { w, warps, sleeps };
  }

  it("warps far targets, waits near ones, and says why it cannot without a warp", async () => {
    const far = world(BigInt(1_000), () => undefined);
    await expect(reachChainTime(far.w, BigInt(1_000) + BigInt(7 * 86_400), "7 days")).resolves.toBeNull();
    expect(far.warps).toEqual([BigInt(1_000 + 7 * 86_400)]);

    const near = world(BigInt(1_000), () => undefined);
    await expect(reachChainTime(near.w, BigInt(1_000) + WARP_MIN_GAP_S, "near")).resolves.toBeNull();
    expect(near.warps).toEqual([]);
    expect(near.sleeps.length).toBeGreaterThan(0);

    const none = world(BigInt(1_000), null);
    await expect(reachChainTime(none.w, BigInt(1_000) + MAX_CLOCK_WAIT_S + BigInt(1), "30 days")).resolves.toMatch(/needs a warp \(E2E_WARP=1 on localnet\)/);
    const passed = world(BigInt(5_000), null);
    await expect(reachChainTime(passed.w, BigInt(4_000), "past")).resolves.toBeNull();
    expect(passed.sleeps).toEqual([]);
  });
});
