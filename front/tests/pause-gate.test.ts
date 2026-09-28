// lib/pause-gate.ts: the emergency pause is read BEFORE a wallet signs.
// PAUSE_BIT_FLOWS is the one map of pause bits to instructions; it must equal
// the program's own checks (`platform.is_paused(PAUSE_X)` per instruction
// file) for every bit the front defines. A bit the front does not define yet
// (8.3 adds 0x40 and 0x80) is 8.3's front part: add the constant to
// lib/pause-flags.ts and its entry to PAUSE_BIT_FLOWS.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  AssetRegistryInstruction,
  BUY_DISCRIMINATOR,
  CANCEL_OFFER_DISCRIMINATOR,
  TAKE_OFFER_DISCRIMINATOR,
  getOpenCustodyVaultInstructionDataEncoder,
  RealizeAction,
  VaultType,
} from "@/lib/generated/asset_registry";
import * as PAUSE from "@/lib/pause-flags";
import {
  assertInstructionsNotPaused,
  clearPauseFlagsCache,
  PAUSE_BIT_FLOWS,
  PAUSE_FLAGS_TTL_MS,
  pauseBitFor,
  pausedFlowFor,
  pausedInstruction,
  PausedFlowError,
  readPauseFlags,
} from "@/lib/pause-gate";
import { explainSendError } from "@/lib/tx-error";

const INSTRUCTIONS_DIR = join(process.cwd(), "../program/programs/asset_registry/src/instructions");
const pascal = (snake: string) => snake.split("_").map((w) => w[0].toUpperCase() + w.slice(1)).join("");
const FRONT_BITS: Record<string, number> = Object.fromEntries(
  Object.entries(PAUSE).filter(([name, value]) => /^PAUSE_[A-Z_]+$/.test(name) && name !== "PAUSE_FLAGS_ALL" && typeof value === "number"),
) as Record<string, number>;

/** instruction (PascalCase) → the PAUSE_* constants its handler checks. */
function programChecks(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const file of readdirSync(INSTRUCTIONS_DIR).filter((f) => f.endsWith(".rs") && f !== "mod.rs")) {
    const source = readFileSync(join(INSTRUCTIONS_DIR, file), "utf8");
    const names = [...source.matchAll(/is_paused\((PAUSE_[A-Z_]+)\)/g)].map((m) => m[1]);
    if (names.length) out.set(pascal(file.replace(/\.rs$/, "")), [...new Set(names)]);
  }
  return out;
}

const ix = (discriminator: Uint8Array, programAddress: string = ASSET_REGISTRY_PROGRAM_ADDRESS) => ({
  programAddress,
  data: new Uint8Array([...discriminator, ...new Uint8Array(64)]),
});

beforeEach(() => clearPauseFlagsCache());

describe("PAUSE_BIT_FLOWS equals the program's checks", () => {
  it("every instruction the program pauses under a bit the front defines is mapped to that bit", () => {
    const checks = programChecks();
    expect(checks.size).toBeGreaterThan(15);
    for (const [name, constants] of checks) {
      const known = constants.filter((c) => c in FRONT_BITS);
      if (known.length === 0) continue; // a bit the front does not define yet
      expect(known, name).toHaveLength(1);
      const instruction = AssetRegistryInstruction[name as keyof typeof AssetRegistryInstruction];
      expect(instruction, `${name} is an instruction of the generated client`).toBeDefined();
      expect(pauseBitFor(instruction), name).toBe(FRONT_BITS[known[0]]);
    }
  });

  it("every mapped instruction is really paused by the program under that bit", () => {
    const checks = programChecks();
    for (const { bit, instructions } of PAUSE_BIT_FLOWS) {
      const constant = Object.entries(FRONT_BITS).find(([, value]) => value === bit)?.[0];
      for (const instruction of instructions) {
        const name = AssetRegistryInstruction[instruction];
        expect(checks.get(name), name).toContain(constant);
      }
    }
  });

  it("covers every defined bit, and no instruction twice", () => {
    expect(PAUSE_BIT_FLOWS.map((f) => f.bit).sort()).toEqual(PAUSE.PAUSE_FLAGS.map((f) => f.bit).sort());
    const all = PAUSE_BIT_FLOWS.flatMap((f) => f.instructions);
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("pausedInstruction", () => {
  it("holds back an entry flow whose bit is set, and nothing else", () => {
    expect(pausedInstruction(PAUSE.PAUSE_PRIMARY, [ix(BUY_DISCRIMINATOR)])).toEqual({
      instruction: AssetRegistryInstruction.Buy,
      bit: PAUSE.PAUSE_PRIMARY,
    });
    expect(pausedInstruction(PAUSE.PAUSE_SECONDARY, [ix(BUY_DISCRIMINATOR)])).toBeNull();
    expect(pausedInstruction(PAUSE.PAUSE_FLAGS_ALL, [ix(CANCEL_OFFER_DISCRIMINATOR)])).toBeNull(); // an exit
    expect(pausedInstruction(PAUSE.PAUSE_SECONDARY, [ix(CANCEL_OFFER_DISCRIMINATOR), ix(TAKE_OFFER_DISCRIMINATOR)])?.instruction).toBe(
      AssetRegistryInstruction.TakeOffer,
    );
  });

  it("ignores other programs and unknown data", () => {
    expect(pausedInstruction(PAUSE.PAUSE_FLAGS_ALL, [ix(BUY_DISCRIMINATOR, "11111111111111111111111111111111")])).toBeNull();
    expect(pausedInstruction(PAUSE.PAUSE_FLAGS_ALL, [ix(new Uint8Array(8).fill(9))])).toBeNull();
  });

  it("lets a burn-only quarantine vault through the custody pause, as the program does", () => {
    const open = (vaultType: VaultType, realizeAction: RealizeAction) => ({
      programAddress: ASSET_REGISTRY_PROGRAM_ADDRESS,
      data: new Uint8Array(getOpenCustodyVaultInstructionDataEncoder().encode({
        vaultId: BigInt(1), vaultType, realizeAction, amount: BigInt(1), deadline: BigInt(0),
        metadataHash: new Uint8Array(32), beneficiary: "11111111111111111111111111111111" as never,
      })),
    });
    expect(pausedInstruction(PAUSE.PAUSE_CUSTODY_ENTRY, [open(VaultType.RedemptionQueue, RealizeAction.BurnAndAttest)])).toBeNull();
    expect(pausedInstruction(PAUSE.PAUSE_CUSTODY_ENTRY, [open(VaultType.DeliveryEscrow, RealizeAction.BurnAndAttest)])?.bit).toBe(
      PAUSE.PAUSE_CUSTODY_ENTRY,
    );
  });
});

describe("the cached read and the gate", () => {
  const rpc = {};

  it("reuses a read for a few seconds, never caches a failure, and shares one in flight", async () => {
    const read = vi.fn(async () => PAUSE.PAUSE_PRIMARY);
    const [a, b] = await Promise.all([readPauseFlags(rpc, { now: 0, read }), readPauseFlags(rpc, { now: 0, read })]);
    expect([a, b]).toEqual([PAUSE.PAUSE_PRIMARY, PAUSE.PAUSE_PRIMARY]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(await readPauseFlags(rpc, { now: PAUSE_FLAGS_TTL_MS - 1, read })).toBe(PAUSE.PAUSE_PRIMARY);
    expect(read).toHaveBeenCalledTimes(1);
    expect(await readPauseFlags(rpc, { now: PAUSE_FLAGS_TTL_MS, read })).toBe(PAUSE.PAUSE_PRIMARY);
    expect(read).toHaveBeenCalledTimes(2);

    clearPauseFlagsCache();
    const failing = vi.fn(async () => { throw new Error("rpc down"); });
    expect(await readPauseFlags(rpc, { now: 0, read: failing })).toBeNull();
    expect(await readPauseFlags(rpc, { now: 1, read: failing })).toBeNull();
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it("refuses a paused flow before the wallet, in words, and fails open on a failed read", async () => {
    const paused = async () => PAUSE.PAUSE_PRIMARY;
    const err = await assertInstructionsNotPaused(rpc, [ix(BUY_DISCRIMINATOR)], { read: paused }).catch((e) => e);
    expect(err).toBeInstanceOf(PausedFlowError);
    expect(err.message).toBe(
      "Primary issuance is paused on Manci (emergency pause). Nothing was sent to your wallet. " + PAUSE.PAUSE_EXITS_OPEN,
    );
    // explainSendError shows it as it is, also when an SDK wraps it.
    expect(explainSendError(new Error("send failed", { cause: err }))).toBe(err.message);

    clearPauseFlagsCache();
    await expect(assertInstructionsNotPaused(rpc, [ix(BUY_DISCRIMINATOR)], { read: async () => { throw new Error("down"); } })).resolves.toBeUndefined();
    clearPauseFlagsCache();
    await expect(assertInstructionsNotPaused(rpc, [ix(CANCEL_OFFER_DISCRIMINATOR)], { read: paused })).resolves.toBeUndefined();
  });

  it("does not read the chain for a transaction without a Manci instruction", async () => {
    const read = vi.fn(async () => PAUSE.PAUSE_FLAGS_ALL);
    await assertInstructionsNotPaused(rpc, [ix(BUY_DISCRIMINATOR, "11111111111111111111111111111111")], { read });
    expect(read).not.toHaveBeenCalled();
  });

  it("pausedFlowFor gives a page its banner text (null when unread or not paused)", () => {
    expect(pausedFlowFor(null, AssetRegistryInstruction.Buy)).toBeNull();
    expect(pausedFlowFor(0, AssetRegistryInstruction.Buy)).toBeNull();
    expect(pausedFlowFor(PAUSE.PAUSE_PRIMARY, AssetRegistryInstruction.Buy)).toMatch(/^Primary issuance is paused/);
    expect(pausedFlowFor(PAUSE.PAUSE_FLAGS_ALL, AssetRegistryInstruction.ClaimRefund)).toBeNull();
  });
});
