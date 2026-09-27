import fs from "node:fs";
import path from "node:path";
import { createKeyPairSignerFromBytes, getAddressEncoder, signBytes, type Address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  findAdminRecordPda,
  findPlatformPda,
  getAdminEncoder,
  getKycRegistryEncoder,
  getPlatformEncoder,
} from "@/lib/generated/asset_registry";
import {
  RestrictionMode,
  findBlockEntryPda,
  findBlocklistAuthorityPda,
  findConfigPda,
  getBlocklistAuthorityEncoder,
  getTransferHookConfigDecoder,
  getTransferHookConfigEncoder,
} from "@/lib/generated/transfer_hook";
import { CLUSTER_GENESIS_HASHES } from "@/lib/network-identity";
import { runTool } from "@/scripts/chain/lib/context";
import { compareIdlInstruction, emergencyTool, parsePauseBits, probeEmergencyState, readEmergencyRequest } from "@/scripts/chain/lib/emergency";
import { messageHash, openNodeHidLedger, type LedgerDevice } from "@/scripts/chain/lib/ledger";
import type { ChainEnv } from "@/scripts/chain/lib/safety";
import { HOOK, REGISTRY, key, rent } from "./helpers/chain-fake";
import { deps, env, localIdl, rpcFor, seedIdl, world, type World } from "./helpers/chain-world";

/** A bootstrapped chain: SA, one more Admin (the kycAuthority test key), the BA. */
async function seeded(pauseFlags = 0) {
  const w = await world();
  const [platform] = await findPlatformPda();
  w.chain.set(platform, {
    owner: REGISTRY,
    lamports: rent(94),
    data: new Uint8Array(
      getPlatformEncoder().encode({ admin: w.keys.superAdmin, protocolTreasury: w.keys.vault, protocolFeeBps: 0, pauseFlags, issuersCount: 0, version: 2, bump: 255 }),
    ),
  });
  for (const admin of [w.keys.superAdmin, w.keys.kycAuthority]) {
    const [record] = await findAdminRecordPda({ authority: admin });
    w.chain.set(record, { owner: REGISTRY, lamports: rent(81), data: new Uint8Array(getAdminEncoder().encode({ admin, addedBy: w.keys.superAdmin, bump: 255 })) });
  }
  const [ba] = await findBlocklistAuthorityPda();
  w.chain.set(ba, { owner: HOOK, lamports: rent(41), data: new Uint8Array(getBlocklistAuthorityEncoder().encode({ authority: w.keys.blocklistAuthority, bump: 255 })) });
  return w;
}

async function platformFlags(w: World) {
  const [platform] = await findPlatformPda();
  return w.chain.get(platform)!.data[74];
}

async function dry(w: World, extra: ChainEnv, lines: string[] = []) {
  return runTool("emergency", env(w, extra), emergencyTool, deps(w, lines));
}

async function send(w: World, extra: ChainEnv, signer: ChainEnv, options: { ledger?: () => Promise<LedgerDevice> } = {}) {
  const plan = await dry(w, extra);
  expect(plan.error ?? null).toBeNull();
  return runTool(
    "emergency",
    env(w, { ...extra, CHAIN_SEND: "1", CHAIN_CONFIRM_PLAN: plan.planDigest as string, ...signer }),
    emergencyTool,
    { ...deps(w), ledger: options.ledger },
  );
}

/** A Ledger stand-in that signs with a test keypair file and records its calls. */
function fakeLedger(file: string, calls: string[]): () => Promise<LedgerDevice> {
  return async () => {
    const bytes = new Uint8Array(JSON.parse(fs.readFileSync(file, "utf8")));
    const signer = await createKeyPairSignerFromBytes(bytes);
    return {
      getPublicKey: async (p) => {
        calls.push(`address ${p}`);
        return new Uint8Array(getAddressEncoder().encode(signer.address));
      },
      signMessage: async (p, message) => {
        calls.push(`sign ${p} ${messageHash(message)}`);
        return new Uint8Array(await signBytes(signer.keyPair.privateKey, message));
      },
      close: async () => {
        calls.push("close");
      },
    };
  };
}

describe("chain:emergency inputs", () => {
  it("parses the op, the signer and each op's arguments", () => {
    const base = { CHAIN_EMERGENCY_SIGNER: key(1) };
    expect(readEmergencyRequest({ ...base, CHAIN_EMERGENCY_OP: "pause", CHAIN_PAUSE_BITS: "primary,secondary" })).toEqual({ op: "pause", signer: key(1), mask: 0x06 });
    expect(readEmergencyRequest({ ...base, CHAIN_EMERGENCY_OP: "pause", CHAIN_PAUSE_BITS: "all" })).toMatchObject({ mask: 0x3f });
    expect(readEmergencyRequest({ ...base, CHAIN_EMERGENCY_OP: "unpause", CHAIN_PAUSE_BITS: "all" })).toMatchObject({ mask: "all" });
    expect(readEmergencyRequest({ ...base, CHAIN_EMERGENCY_OP: "block", CHAIN_WALLET: key(2) })).toMatchObject({ wallet: key(2), confirmWallet: null });
    expect(readEmergencyRequest({ ...base, CHAIN_EMERGENCY_OP: "hook-mode", CHAIN_MINT: key(3), CHAIN_HOOK_MODE: "kyc-gated", CHAIN_KYC_REGISTRY: key(4) })).toMatchObject({
      mode: RestrictionMode.KycGated,
      registry: key(4),
    });
    expect(parsePauseBits("0x20", false)).toBe(0x20);
    const refuse = (value: ChainEnv, pattern: RegExp) => expect(() => readEmergencyRequest({ ...base, ...value })).toThrow(pattern);
    refuse({ CHAIN_EMERGENCY_OP: "drain" }, /CHAIN_EMERGENCY_OP must be one of/);
    refuse({ CHAIN_EMERGENCY_OP: "pause", CHAIN_PAUSE_BITS: "everything" }, /unknown area "everything"/);
    refuse({ CHAIN_EMERGENCY_OP: "pause", CHAIN_PAUSE_BITS: "0x40" }, /only defined bits/);
    refuse({ CHAIN_EMERGENCY_OP: "pause" }, /CHAIN_PAUSE_BITS is required/);
    refuse({ CHAIN_EMERGENCY_OP: "hook-mode", CHAIN_MINT: key(3), CHAIN_HOOK_MODE: "open", CHAIN_KYC_REGISTRY: key(4) }, /must be unset for open/);
    refuse({ CHAIN_EMERGENCY_OP: "hook-mode", CHAIN_MINT: key(3), CHAIN_HOOK_MODE: "kyc-gated" }, /CHAIN_KYC_REGISTRY must be a valid address/);
    expect(() => readEmergencyRequest({ CHAIN_EMERGENCY_OP: "pause", CHAIN_PAUSE_BITS: "all" })).toThrow(/CHAIN_EMERGENCY_SIGNER/);
  });
});

describe("chain:emergency pause (ops-qa-8)", () => {
  it("an Admin pauses with a keypair: dry run, reviewed digest, one signed and simulated send, checked at finalized", async () => {
    const w = await seeded();
    const op = { CHAIN_EMERGENCY_OP: "pause", CHAIN_EMERGENCY_SIGNER: w.keys.kycAuthority, CHAIN_PAUSE_BITS: "primary,secondary" };
    const lines: string[] = [];
    const plan = await dry(w, op, lines);
    expect(plan.status).toBe("awaiting");
    expect(plan.planDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(plan.simulation).toMatch(/simulated ok/);
    expect(plan.role).toBe("Admin or super admin");
    // No canonical IDL on the fake devnet: recorded, not refused.
    expect((plan.idl as { check: string }).check).toBe("no-canonical-idl");
    expect(plan.idlUnchecked).toBe(true);
    expect(w.chain.calls).not.toContain("sendTransaction");

    const sent = await send(w, op, { CHAIN_KEYPAIR: w.pairs.kycAuthority.path });
    expect(sent.error ?? null).toBeNull();
    expect(sent.status).toBe("completed");
    expect((sent.steps as { outcome: string; postCheck: boolean }[])[0]).toMatchObject({ outcome: "finalized", postCheck: true });
    expect(await platformFlags(w)).toBe(0x06);
    expect(fs.readdirSync(path.join(w.dir, "state"))).toEqual([]);
    // Once every bit is set there is nothing to do.
    const again = await dry(w, op);
    expect(again.status).toBe("completed");
    expect(again.noop).toMatch(/already set/);
  });

  it("only the super admin clears; `all` also clears undefined bits", async () => {
    const w = await seeded(0xff);
    const byAdmin = await dry(w, { CHAIN_EMERGENCY_OP: "unpause", CHAIN_EMERGENCY_SIGNER: w.keys.kycAuthority, CHAIN_PAUSE_BITS: "all" });
    expect(byAdmin.error).toMatch(/Only the super admin clears pause bits/);
    const stranger = await dry(w, { CHAIN_EMERGENCY_OP: "pause", CHAIN_EMERGENCY_SIGNER: key(9), CHAIN_PAUSE_BITS: "all" });
    expect(stranger.error).toMatch(/neither the super admin nor an Admin/);
    const op = { CHAIN_EMERGENCY_OP: "unpause", CHAIN_EMERGENCY_SIGNER: w.keys.superAdmin, CHAIN_PAUSE_BITS: "all" };
    const sent = await send(w, op, { CHAIN_KEYPAIR: w.pairs.superAdmin.path });
    expect(sent.error ?? null).toBeNull();
    expect(await platformFlags(w)).toBe(0);
  });

  it("a Ledger (CHAIN_SIGNER) must hold the expected key; the device sees the exact message and is closed", async () => {
    const w = await seeded();
    const op = { CHAIN_EMERGENCY_OP: "pause", CHAIN_EMERGENCY_SIGNER: w.keys.superAdmin, CHAIN_PAUSE_BITS: "all" };
    const calls: string[] = [];
    const sent = await send(w, op, { CHAIN_SIGNER: "usb://ledger?key=0" }, { ledger: fakeLedger(w.pairs.superAdmin.path, calls) });
    expect(sent.error ?? null).toBeNull();
    expect(await platformFlags(w)).toBe(0x3f);
    expect(calls[0]).toBe("address 44'/501'/0'");
    expect(calls[1]).toMatch(/^sign 44'\/501'\/0' [1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(calls.at(-1)).toBe("close");

    const v = await seeded();
    const wrong: string[] = [];
    const refused = await send(v, { ...op, CHAIN_EMERGENCY_SIGNER: v.keys.superAdmin }, { CHAIN_SIGNER: "usb://ledger?key=1" }, {
      ledger: fakeLedger(v.pairs.blocklistAuthority.path, wrong),
    });
    expect(refused.error).toMatch(/The Ledger key at 44'\/501'\/1' is .*, not the expected signer/);
    expect(wrong).toEqual(["address 44'/501'/1'", "close"]);
    expect(v.chain.calls).not.toContain("sendTransaction");
  });

  it("refuses a digest that is not the reviewed one", async () => {
    const w = await seeded();
    const op = { CHAIN_EMERGENCY_OP: "pause", CHAIN_EMERGENCY_SIGNER: w.keys.superAdmin, CHAIN_PAUSE_BITS: "all" };
    const refused = await runTool(
      "emergency",
      env(w, { ...op, CHAIN_SEND: "1", CHAIN_CONFIRM_PLAN: "0".repeat(64), CHAIN_KEYPAIR: w.pairs.superAdmin.path }),
      emergencyTool,
      deps(w),
    );
    expect(refused.error).toMatch(/CHAIN_CONFIRM_PLAN does not match/);
    expect(w.chain.calls).not.toContain("sendTransaction");
  });
});

describe("chain:emergency blocklist and hook mode (prog-vlast-8)", () => {
  it("the BA blocks and unblocks; nobody else can; an off-curve wallet needs CHAIN_CONFIRM_WALLET", async () => {
    const w = await seeded();
    const wallet = w.keys.deployer;
    const op = { CHAIN_EMERGENCY_OP: "block", CHAIN_EMERGENCY_SIGNER: w.keys.blocklistAuthority, CHAIN_WALLET: wallet };
    const notBa = await dry(w, { ...op, CHAIN_EMERGENCY_SIGNER: w.keys.superAdmin });
    expect(notBa.error).toMatch(/is not the blocklist authority/);
    const blocked = await send(w, op, { CHAIN_KEYPAIR: w.pairs.blocklistAuthority.path });
    expect(blocked.error ?? null).toBeNull();
    const [entry] = await findBlockEntryPda({ wallet });
    expect(w.chain.get(entry)).toBeTruthy();
    const unblocked = await send(w, { ...op, CHAIN_EMERGENCY_OP: "unblock" }, { CHAIN_KEYPAIR: w.pairs.blocklistAuthority.path });
    expect(unblocked.error ?? null).toBeNull();
    expect(w.chain.get(entry)).toBeUndefined();
    // A program-derived address (here the Squads vault) stands for an escrow PDA.
    const pda = await dry(w, { ...op, CHAIN_WALLET: w.keys.vault });
    expect(pda.error).toMatch(/off-curve .*set CHAIN_CONFIRM_WALLET/);
    const confirmed = await dry(w, { ...op, CHAIN_WALLET: w.keys.vault, CHAIN_CONFIRM_WALLET: w.keys.vault });
    expect(confirmed.error ?? null).toBeNull();
  });

  it("the BA switches a class between Open and KycGated against a live registry", async () => {
    const w = await seeded();
    const mint = key(60);
    const registry = key(61);
    const [config] = await findConfigPda({ mint });
    const configData = (mode: RestrictionMode) =>
      new Uint8Array(getTransferHookConfigEncoder().encode({ mint, shareClass: key(62), blocklist: key(63), restrictionMode: mode, kycRegistry: null, version: 2, bump: 255 }));
    w.chain.set(config, { owner: HOOK, lamports: rent(120), data: configData(RestrictionMode.Open) });
    const op = { CHAIN_EMERGENCY_OP: "hook-mode", CHAIN_EMERGENCY_SIGNER: w.keys.blocklistAuthority, CHAIN_MINT: mint, CHAIN_HOOK_MODE: "kyc-gated", CHAIN_KYC_REGISTRY: registry };
    expect((await dry(w, op)).error).toMatch(/is not a live KycRegistry/);
    w.chain.set(registry, {
      owner: REGISTRY,
      lamports: rent(300),
      data: new Uint8Array(
        getKycRegistryEncoder().encode({ authority: w.keys.kycAuthority, approvedJurisdictions: new Uint8Array(32), blockedJurisdictions: new Uint8Array(32), entriesCount: 0, version: 2, bump: 255 }),
      ),
    });
    const gated = await send(w, op, { CHAIN_KEYPAIR: w.pairs.blocklistAuthority.path });
    expect(gated.error ?? null).toBeNull();
    const after = getTransferHookConfigDecoder().decode(w.chain.get(config)!.data);
    expect(after.restrictionMode).toBe(RestrictionMode.KycGated);
    expect(after.kycRegistry).toEqual({ __option: "Some", value: registry });
    const state = await probeEmergencyState(rpcFor(w), readEmergencyRequest(op));
    expect(state.hookConfig).toEqual({ mode: RestrictionMode.KycGated, registry });
    const open = await send(w, { ...op, CHAIN_HOOK_MODE: "open", CHAIN_KYC_REGISTRY: "" }, { CHAIN_KEYPAIR: w.pairs.blocklistAuthority.path });
    expect(open.error ?? null).toBeNull();
    expect(getTransferHookConfigDecoder().decode(w.chain.get(config)!.data).restrictionMode).toBe(RestrictionMode.Open);
    expect((await dry(w, { ...op, CHAIN_MINT: key(64) })).error).toMatch(/has no TransferHookConfig/);
  });
});

describe("chain:emergency building blocks", () => {
  it("compares one instruction of the live IDL with front/idl", () => {
    const local = localIdl("asset_registry");
    const probe = (onChain: Uint8Array | null, status = "in-sync") =>
      ({ program: "asset_registry", status, onChain, source: { label: "head", bytes: local } }) as unknown as Parameters<typeof compareIdlInstruction>[0];
    expect(compareIdlInstruction(probe(local), "set_pause_flags")).toBe("match");
    const idl = JSON.parse(Buffer.from(local).toString("utf8"));
    const changed = idl.instructions.map((ix: { name: string; args: unknown[] }) => (ix.name === "set_pause_flags" ? { ...ix, args: [...ix.args].reverse() } : ix));
    const other = new TextEncoder().encode(JSON.stringify({ ...idl, instructions: changed }));
    expect(compareIdlInstruction(probe(other, "update"), "set_pause_flags")).toBe("differs");
    // Another instruction changing does not matter.
    expect(compareIdlInstruction(probe(other, "update"), "add_admin")).toBe("match");
    expect(compareIdlInstruction(probe(null, "init"), "set_pause_flags")).toBe("no-canonical-idl");
    expect(compareIdlInstruction(probe(local), "no_such_instruction")).toBe("unreadable");
  });

  it("names the missing optional Ledger packages instead of failing obscurely", async () => {
    const installed = fs.existsSync(path.resolve(__dirname, "../node_modules/@ledgerhq/hw-transport-node-hid"));
    if (installed) return; // an operator machine: opening would talk to USB
    await expect(openNodeHidLedger()).rejects.toThrow(/npm install --no-save @ledgerhq\/hw-transport-node-hid @ledgerhq\/hw-app-solana/);
  });
});

describe("chain:emergency on mainnet", () => {
  async function mainnetWorld() {
    const w = await seeded();
    w.chain.genesis = CLUSTER_GENESIS_HASHES.mainnet;
    return w;
  }
  const mainnetEnv = (w: World, extra: ChainEnv) => {
    const { CHAIN_STATE_DIR: _state, CHAIN_ROLE_MAP: _map, ...rest } = env(w, { CHAIN_NETWORK: "mainnet", CHAIN_ALLOW_MAINNET: "1", ...extra });
    void _state;
    void _map;
    return rest;
  };

  it("needs the live canonical IDL to define the instruction as front/idl does (or a recorded override)", async () => {
    const w = await mainnetWorld();
    const op = { CHAIN_EMERGENCY_OP: "pause", CHAIN_EMERGENCY_SIGNER: w.keys.superAdmin as Address, CHAIN_PAUSE_BITS: "all" };
    const opts = { ...deps(w), home: w.dir };
    const refused = await runTool("emergency", mainnetEnv(w, op), emergencyTool, opts);
    expect(refused.error).toMatch(/cannot confirm set_pause_flags .*CHAIN_EMERGENCY_IDL_UNCHECKED=1/);
    const unchecked = await runTool("emergency", mainnetEnv(w, { ...op, CHAIN_EMERGENCY_IDL_UNCHECKED: "1" }), emergencyTool, opts);
    expect(unchecked.error ?? null).toBeNull();
    expect(unchecked.idlUnchecked).toBe(true);
    await seedIdl(w, REGISTRY, localIdl("asset_registry"));
    const checked = await runTool("emergency", mainnetEnv(w, op), emergencyTool, opts);
    expect(checked.error ?? null).toBeNull();
    expect((checked.idl as { check: string }).check).toBe("match");
    expect(checked.idlUnchecked).toBeUndefined();
    // Sending on mainnet needs a priority fee, like every chain tool.
    await expect(
      runTool(
        "emergency",
        mainnetEnv(w, { ...op, CHAIN_SEND: "1", CHAIN_CONFIRM_PLAN: checked.planDigest as string, CHAIN_KEYPAIR: w.pairs.superAdmin.path }),
        emergencyTool,
        opts,
      ),
    ).rejects.toThrow(/CHAIN_CU_PRICE is required/);
  });
});
