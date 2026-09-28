// lib/pause-gate.ts: the emergency pause and the pilot scope are read BEFORE
// a wallet signs. PAUSE_BIT_FLOWS is the one map of pause bits to
// instructions; it must equal the program's own checks
// (`platform.is_paused(MASK)` per instruction file, MASK one constant or
// several ORed) for every bit the front defines, conditional exactly where
// the program's check is (`x || !platform.is_paused(..)`). A bit the front
// does not define yet (8.3 adds 0x40) is 8.3's front part: add the constant
// to lib/pause-flags.ts and one entry per check to PAUSE_BIT_FLOWS (with
// `when` for a conditional one). MODULE_FLOWS maps each pilot-scope module
// to the on-chain entries it owns.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  AssetRegistryInstruction,
  BUY_DISCRIMINATOR,
  CANCEL_OFFER_DISCRIMINATOR,
  CREATE_OFFER_DISCRIMINATOR,
  CREATE_PROPOSAL_DISCRIMINATOR,
  TAKE_OFFER_DISCRIMINATOR,
  getOpenCustodyVaultInstructionDataEncoder,
  RaiseType,
  RealizeAction,
  VaultType,
} from "@/lib/generated/asset_registry";
import { PILOT_MODULE_ENV, PILOT_MODULES, moduleDisabledMessage } from "@/lib/features";
import * as PAUSE from "@/lib/pause-flags";
import {
  assertInstructionsInScope,
  assertInstructionsNotPaused,
  clearPauseFlagsCache,
  heldBit,
  MODULE_FLOWS,
  ModuleDisabledFlowError,
  outOfScopeInstruction,
  PAUSE_BIT_FLOWS,
  PAUSE_FLAGS_TTL_MS,
  pauseFlowsFor,
  pauseMaskFor,
  pausedFlowFor,
  pausedInstruction,
  PausedFlowError,
  readPauseFlags,
  type PauseFlow,
} from "@/lib/pause-gate";
import { explainSendError } from "@/lib/tx-error";

const INSTRUCTIONS_DIR = join(process.cwd(), "../program/programs/asset_registry/src/instructions");
const pascal = (snake: string) => snake.split("_").map((w) => w[0].toUpperCase() + w.slice(1)).join("");
const FRONT_BITS: Record<string, number> = Object.fromEntries(
  Object.entries(PAUSE).filter(([name, value]) => /^PAUSE_[A-Z_]+$/.test(name) && name !== "PAUSE_FLAGS_ALL" && typeof value === "number"),
) as Record<string, number>;

type Check = { constant: string; conditional: boolean };

/**
 * The pause checks of one instruction file: every constant of every
 * `is_paused(A | B)` mask, and whether the check is conditional (anything
 * but the plain `constraint = !platform.is_paused(..)` account constraint).
 */
function parseChecks(source: string): Check[] {
  const out: Check[] = [];
  for (const m of source.matchAll(/is_paused\(([^)]*)\)/g)) {
    const before = source.slice(Math.max(0, m.index - 80), m.index);
    const conditional = !/constraint\s*=\s*!\s*platform\s*\.\s*$/.test(before);
    for (const constant of m[1].split("|").map((c) => c.trim())) {
      expect(constant, `a pause constant in "${m[0]}"`).toMatch(/^PAUSE_[A-Z_]+$/);
      if (!out.some((c) => c.constant === constant && c.conditional === conditional)) out.push({ constant, conditional });
    }
  }
  return out;
}

/** instruction (PascalCase) → the pause checks its handler makes. */
function programChecks(): Map<string, Check[]> {
  const out = new Map<string, Check[]>();
  for (const file of readdirSync(INSTRUCTIONS_DIR).filter((f) => f.endsWith(".rs") && f !== "mod.rs")) {
    const checks = parseChecks(readFileSync(join(INSTRUCTIONS_DIR, file), "utf8"));
    if (checks.length) out.set(pascal(file.replace(/\.rs$/, "")), checks);
  }
  return out;
}

const constantOf = (bit: number) => Object.entries(FRONT_BITS).find(([, value]) => value === bit)?.[0];

const ix = (discriminator: Uint8Array, programAddress: string = ASSET_REGISTRY_PROGRAM_ADDRESS) => ({
  programAddress,
  data: new Uint8Array([...discriminator, ...new Uint8Array(64)]),
});

beforeEach(() => clearPauseFlagsCache());

describe("PAUSE_BIT_FLOWS equals the program's checks", () => {
  it("every check the program makes under a bit the front defines is mapped, conditional exactly where the program's is", () => {
    const checks = programChecks();
    expect(checks.size).toBeGreaterThan(15);
    for (const [name, list] of checks) {
      for (const { constant, conditional } of list) {
        if (!(constant in FRONT_BITS)) continue; // a bit the front does not define yet
        const instruction = AssetRegistryInstruction[name as keyof typeof AssetRegistryInstruction];
        expect(instruction, `${name} is an instruction of the generated client`).toBeDefined();
        const flows = pauseFlowsFor(instruction).filter((f) => f.bit === FRONT_BITS[constant]);
        expect(flows, `${name} under ${constant}`).toHaveLength(1);
        expect(flows[0].when !== undefined, `${name} under ${constant} is conditional`).toBe(conditional);
      }
    }
  });

  it("every mapped instruction is really paused by the program under that bit", () => {
    const checks = programChecks();
    for (const { bit, instructions } of PAUSE_BIT_FLOWS) {
      const constant = constantOf(bit);
      expect(constant, `bit ${bit} is a constant of lib/pause-flags.ts`).toBeDefined();
      for (const instruction of instructions) {
        const name = AssetRegistryInstruction[instruction];
        expect(checks.get(name)?.map((c) => c.constant), name).toContain(constant);
      }
    }
  });

  it("covers every defined bit, and no instruction twice under one bit", () => {
    expect(new Set(PAUSE_BIT_FLOWS.map((f) => f.bit))).toEqual(new Set(PAUSE.PAUSE_FLAGS.map((f) => f.bit)));
    const pairs = PAUSE_BIT_FLOWS.flatMap((f) => f.instructions.map((i) => `${f.bit}:${i}`));
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  it("reads the program's other forms: a combined mask and a check that depends on an account (8.3)", () => {
    expect(parseChecks("constraint = !platform.is_paused(PAUSE_DISTRIBUTIONS | PAUSE_PAYOUT_MODULES) @ RegistryError::PlatformPaused,")).toEqual([
      { constant: "PAUSE_DISTRIBUTIONS", conditional: false },
      { constant: "PAUSE_PAYOUT_MODULES", conditional: false },
    ]);
    expect(parseChecks(
      "constraint = !platform.is_paused(PAUSE_PRIMARY) @ RegistryError::PlatformPaused,\n" +
      "ctx.accounts.sale.raise_type != crate::state::RaiseType::Startup\n    || !ctx.accounts.platform.is_paused(PAUSE_PAYOUT_MODULES),",
    )).toEqual([
      { constant: "PAUSE_PRIMARY", conditional: false },
      { constant: "PAUSE_PAYOUT_MODULES", conditional: true },
    ]);
  });
});

describe("the mask model (several bits per instruction, conditional checks)", () => {
  // 8.3's shapes, on a flow list of their own: RouteYield under two bits, and
  // Buy under 0x40 only for a Startup sale (a field of the Sale account).
  const PAYOUT = 0x40;
  const flows: PauseFlow[] = [
    { bit: PAUSE.PAUSE_DISTRIBUTIONS, instructions: [AssetRegistryInstruction.RouteYield] },
    { bit: PAYOUT, instructions: [AssetRegistryInstruction.RouteYield] },
    { bit: PAUSE.PAUSE_PRIMARY, instructions: [AssetRegistryInstruction.Buy] },
    {
      bit: PAYOUT,
      instructions: [AssetRegistryInstruction.Buy],
      when: ({ facts }) => (facts.raiseType === undefined ? null : facts.raiseType === RaiseType.Startup),
    },
  ];
  const held = (flags: number, instruction: AssetRegistryInstruction, raiseType?: RaiseType) =>
    heldBit(flags, instruction, { data: null, facts: raiseType === undefined ? {} : { raiseType } }, flows);

  it("an instruction under two bits is held by either", () => {
    expect(held(PAUSE.PAUSE_DISTRIBUTIONS, AssetRegistryInstruction.RouteYield)).toBe(PAUSE.PAUSE_DISTRIBUTIONS);
    expect(held(PAYOUT, AssetRegistryInstruction.RouteYield)).toBe(PAYOUT);
    expect(held(PAUSE.PAUSE_PRIMARY, AssetRegistryInstruction.RouteYield)).toBeNull();
  });

  it("a conditional check holds back only when it can tell, and fails open otherwise", () => {
    expect(held(PAYOUT, AssetRegistryInstruction.Buy)).toBeNull();
    expect(held(PAYOUT, AssetRegistryInstruction.Buy, RaiseType.Mature)).toBeNull();
    expect(held(PAYOUT, AssetRegistryInstruction.Buy, RaiseType.Startup)).toBe(PAYOUT);
    expect(held(PAUSE.PAUSE_PRIMARY | PAYOUT, AssetRegistryInstruction.Buy)).toBe(PAUSE.PAUSE_PRIMARY);
  });

  it("pauseMaskFor ORs every bit that can stop an instruction", () => {
    expect(pauseMaskFor(AssetRegistryInstruction.Buy)).toBe(PAUSE.PAUSE_PRIMARY);
    expect(pauseMaskFor(AssetRegistryInstruction.OpenCustodyVault)).toBe(PAUSE.PAUSE_CUSTODY_ENTRY);
    expect(pauseMaskFor(AssetRegistryInstruction.CancelOffer)).toBe(0);
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

describe("the pilot scope before the wallet (MODULE_FLOWS)", () => {
  afterEach(() => vi.unstubAllEnvs());
  const clearModules = () => { for (const name of Object.values(PILOT_MODULE_ENV)) vi.stubEnv(name, ""); };
  const openVault = (vaultType: VaultType, realizeAction: RealizeAction = RealizeAction.BurnAndAttest) => ({
    programAddress: ASSET_REGISTRY_PROGRAM_ADDRESS,
    data: new Uint8Array(getOpenCustodyVaultInstructionDataEncoder().encode({
      vaultId: BigInt(1), vaultType, realizeAction, amount: BigInt(1), deadline: BigInt(0),
      metadataHash: new Uint8Array(32), beneficiary: "11111111111111111111111111111111" as never,
    })),
  });

  it("maps every module, and no exit", () => {
    expect(new Set(MODULE_FLOWS.map((f) => f.module))).toEqual(new Set(PILOT_MODULES));
    for (const { instructions } of MODULE_FLOWS) {
      for (const instruction of instructions) {
        expect(AssetRegistryInstruction[instruction]).not.toMatch(/^(Cancel|Expire|Claim|Withdraw|Return|Reclaim|Revert|Close|Finalize)/);
      }
    }
  });

  it("mainnet by default: an on-chain OTC offer or a proposal is refused before the wallet; exits and primary buys pass", () => {
    clearModules();
    const err = (() => { try { assertInstructionsInScope([ix(CREATE_OFFER_DISCRIMINATOR)], "mainnet"); } catch (e) { return e; } })();
    expect(err).toBeInstanceOf(ModuleDisabledFlowError);
    expect((err as Error).message).toBe(`${moduleDisabledMessage("secondaryTrading", "mainnet")} Nothing was sent to your wallet.`);
    expect(explainSendError(new Error("send failed", { cause: err }))).toBe((err as Error).message);
    expect(outOfScopeInstruction([ix(TAKE_OFFER_DISCRIMINATOR)], "mainnet")?.module).toBe("secondaryTrading");
    expect(outOfScopeInstruction([ix(CREATE_PROPOSAL_DISCRIMINATOR)], "mainnet")?.module).toBe("governance");
    expect(outOfScopeInstruction([ix(CANCEL_OFFER_DISCRIMINATOR)], "mainnet")).toBeNull();
    expect(outOfScopeInstruction([ix(BUY_DISCRIMINATOR)], "mainnet")).toBeNull();
    expect(outOfScopeInstruction([ix(CREATE_OFFER_DISCRIMINATOR, "11111111111111111111111111111111")], "mainnet")).toBeNull();
  });

  it("a switched-on module passes; devnet is on unless switched off", () => {
    clearModules();
    vi.stubEnv(PILOT_MODULE_ENV.secondaryTrading, "true");
    expect(() => assertInstructionsInScope([ix(CREATE_OFFER_DISCRIMINATOR)], "mainnet")).not.toThrow();
    clearModules();
    expect(() => assertInstructionsInScope([ix(CREATE_OFFER_DISCRIMINATOR)], "devnet")).not.toThrow();
    vi.stubEnv(PILOT_MODULE_ENV.secondaryTrading, "off");
    expect(() => assertInstructionsInScope([ix(CREATE_OFFER_DISCRIMINATOR)], "devnet")).toThrow(ModuleDisabledFlowError);
  });

  it("custody vaults by type: conversion and delivery are modules, the clawback quarantine vault is not", () => {
    clearModules();
    expect(outOfScopeInstruction([openVault(VaultType.ConversionPending)], "mainnet")?.module).toBe("custodyConversion");
    expect(outOfScopeInstruction([openVault(VaultType.DeliveryEscrow)], "mainnet")?.module).toBe("custodyDelivery");
    expect(outOfScopeInstruction([openVault(VaultType.RedemptionQueue)], "mainnet")).toBeNull();
    vi.stubEnv(PILOT_MODULE_ENV.custodyDelivery, "true");
    expect(outOfScopeInstruction([openVault(VaultType.DeliveryEscrow)], "mainnet")).toBeNull();
  });
});
