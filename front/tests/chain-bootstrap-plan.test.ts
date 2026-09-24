import fs from "node:fs";
import path from "node:path";
import { createNoopSigner, isSignerRole, type Address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  findAcceptPlatformAdminTransferPda,
  findAdminRecordPda,
  findPlatformPda,
  getAcceptPlatformAdminInstructionAsync,
  getAdminEncoder,
  getAuthorityTransferEncoder,
  getKycRegistryEncoder,
  getPlatformEncoder,
  getSetPauseFlagsInstructionAsync,
} from "@/lib/generated/asset_registry";
import {
  findBlocklistAuthorityPda,
  findTransferPda,
  getAcceptBlocklistAuthorityInstructionAsync,
  getBlocklistAuthorityEncoder,
  getBlocklistAuthorityTransferEncoder,
} from "@/lib/generated/transfer_hook";
import { CLUSTER_GENESIS_HASHES } from "@/lib/network-identity";
import {
  DEFAULT_APPROVED_JURISDICTIONS,
  buildAcceptKycAuthority,
  findKycRegistryTransferPda,
  jurisdictionBitmap,
} from "@/lib/passport";
import { bootstrapTool, planBootstrap, probeBootstrapState, type BootstrapPlan } from "@/scripts/chain/lib/bootstrap-plan";
import { runTool } from "@/scripts/chain/lib/context";
import { idlTool } from "@/scripts/chain/lib/idl-plan";
import { inventoryTool } from "@/scripts/chain/lib/inventory";
import { validateRoleMap } from "@/scripts/chain/lib/role-map";
import type { ChainEnv } from "@/scripts/chain/lib/safety";
import { planDigest } from "@/scripts/chain/lib/tx";
import { HOOK, REGISTRY, key, rent } from "./helpers/chain-fake";
import { CAPACITY, deps, env, ledger, rpcFor, sendEnv, signerOf, world, type World } from "./helpers/chain-world";

async function dryRun(w: World, extra: ChainEnv = {}, lines: string[] = []) {
  return runTool("bootstrap", env(w, extra), bootstrapTool, deps(w, lines));
}

async function sendRun(w: World, extra: ChainEnv = {}, lines: string[] = []) {
  const dry = await dryRun(w, extra);
  expect(dry.error ?? null).toBeNull();
  return runTool("bootstrap", sendEnv(w, dry.planDigest as string, extra), bootstrapTool, deps(w, lines));
}

async function plan(w: World, signers?: Parameters<typeof planBootstrap>[2]): Promise<BootstrapPlan> {
  const rpc = rpcFor(w);
  const state = await probeBootstrapState(rpc, w.map);
  return planBootstrap(state, w.map, signers ?? { deployer: createNoopSigner(w.keys.deployer), rehearsal: {} }, {
    rpc,
    handover: { requested: false, confirmVault: null, whilePaused: false, inventoryBlockers: null },
  });
}

const ids = (p: BootstrapPlan) => p.steps.map((s) => s.id);

describe("bootstrap plan on an empty chain (C1)", () => {
  it("builds cycle 1 through the real builders: S1/S2 now, the rest at-send, S5 included", async () => {
    const w = await world();
    const p = await plan(w);
    const admin = w.keys.admins[0];
    expect(ids(p)).toEqual(["S1", "S2", "S2b", `S3:${admin}`, "S4", "S4b", "S5"]);
    expect(p.steps.map((s) => s.simulate)).toEqual(["now", "now", "at-send", "at-send", "at-send", "at-send", "at-send"]);
    expect(p.stops).toEqual([]);
    expect(p.awaiting.map((a) => a.id)).toEqual(["X3", "X2", "X1"]);
    expect(p.awaiting.find((a) => a.id === "X1")).toMatchObject({ page: "/issuer/authority", key: w.keys.superAdmin });
    expect(p.awaiting.find((a) => a.id === "X2")).toMatchObject({ page: "/admin/kyc", key: w.keys.kycAuthority });
    expect(p.blocked.map((b) => b.id)).toEqual(["S6"]);
    expect(p.handover).toEqual({ planned: false, reason: "earlier steps are pending" });
    expect(p.skipped.map((s) => s.id)).toEqual(expect.arrayContaining(["S1b", "S4c", "S4b.cancel"]));
  });

  it("every transaction has exactly one signer: the deployer", async () => {
    const w = await world();
    const p = await plan(w);
    for (const step of p.steps) {
      expect(step.signer.address).toBe(w.keys.deployer);
      const signers = new Set(step.ixs.flatMap((ix) => (ix.accounts ?? []).filter((a) => isSignerRole(a.role)).map((a) => a.address)));
      expect([...signers]).toEqual([w.keys.deployer]);
    }
  });

  it("the digest is stable, and changes with the reviewed instructions", async () => {
    const w = await world();
    const input = (p: BootstrapPlan, roleMapSha256 = "a".repeat(64)) => ({
      network: "devnet",
      genesis: CLUSTER_GENESIS_HASHES.devnet,
      roleMapSha256,
      releaseSha256Sums: null,
      steps: p.steps,
    });
    const first = await plan(w);
    const second = await plan(w);
    expect(planDigest(input(first))).toBe(planDigest(input(second)));
    expect(planDigest(input(first, "b".repeat(64)))).not.toBe(planDigest(input(first)));
    const fewer = { ...first, steps: first.steps.slice(1) };
    expect(planDigest(input(fewer))).not.toBe(planDigest(input(first)));
  });

  it("the dry run simulates the now steps, prints the deferred ones and the pin, and sends nothing", async () => {
    const w = await world();
    const lines: string[] = [];
    const evidence = await dryRun(w, {}, lines);
    expect(evidence.status).toBe("awaiting");
    expect(evidence.planDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(evidence.simulations).toEqual({ S1: expect.stringMatching(/simulated ok/), S2: expect.stringMatching(/simulated ok/) });
    expect(lines.join("\n")).toMatch(/deferred: depends on/);
    expect(lines.join("\n")).toMatch(new RegExp(`NEXT_PUBLIC_KYC_REGISTRY=${w.map.kyc.registry}`));
    expect(lines.join("\n")).toMatch(/ACTION REQUIRED X3/);
    expect(w.chain.calls).not.toContain("sendTransaction");
  });
});

describe("bootstrap send (C1, C7)", () => {
  it("sends cycle 1 in order, simulating each signed transaction first, then awaits the Ledgers", async () => {
    const w = await world();
    const order: string[] = [];
    const originalHandle = w.chain.handle.bind(w.chain);
    w.chain.handle = (method, params) => {
      if (method === "simulateTransaction" && (params[1] as { sigVerify?: boolean })?.sigVerify) order.push("simulate");
      if (method === "sendTransaction") order.push("send");
      return originalHandle(method, params);
    };
    const evidence = await sendRun(w);
    expect(evidence.error ?? null).toBeNull();
    expect(evidence.status).toBe("awaiting");
    const steps = evidence.steps as { id: string; outcome: string }[];
    expect(steps.map((s) => s.id)).toEqual(["S1", "S2", "S2b", `S3:${w.keys.admins[0]}`, "S4", "S4b", "S5"]);
    expect(steps.every((s) => s.outcome === "finalized")).toBe(true);
    expect(order).toEqual(steps.flatMap(() => ["simulate", "send"]));
    const state = await probeBootstrapState(rpcFor(w), w.map);
    expect(state.platform?.admin).toBe(w.keys.deployer);
    expect(state.platformProposed).toBe(w.keys.superAdmin);
    expect(state.blocklist).toEqual({ authority: w.keys.deployer, proposed: w.keys.blocklistAuthority });
    expect(state.registryProposed).toBe(w.keys.kycAuthority);
    // The lock is released once every signature resolved.
    expect(fs.readdirSync(path.join(w.dir, "state"))).toEqual([]);
  });

  it("aborts when the recomputed digest differs from CHAIN_CONFIRM_PLAN", async () => {
    const w = await world();
    const evidence = await runTool("bootstrap", sendEnv(w, "0".repeat(64)), bootstrapTool, deps(w));
    expect(evidence.status).toBe("failed");
    expect(evidence.error).toMatch(/CHAIN_CONFIRM_PLAN does not match/);
    expect(w.chain.calls).not.toContain("sendTransaction");
  });

  it("re-checks preconditions before every step: a diverged state aborts", async () => {
    const w = await world();
    const dry = await dryRun(w);
    let injected = false;
    w.chain.afterLand = async () => {
      if (injected) return;
      injected = true;
      // Between S1 and S2 someone else initializes the blocklist authority.
      const [ba] = await findBlocklistAuthorityPda();
      w.chain.set(ba, {
        owner: HOOK,
        lamports: rent(41),
        data: new Uint8Array(getBlocklistAuthorityEncoder().encode({ authority: key(99), bump: 255 })),
      });
    };
    const evidence = await runTool("bootstrap", sendEnv(w, dry.planDigest as string), bootstrapTool, deps(w));
    expect(evidence.status).toBe("failed");
    expect(evidence.error).toMatch(/state diverged from reviewed plan at S2b/);
    expect((evidence.steps as { id: string; status: string }[]).map((s) => [s.id, s.status])).toEqual([
      ["S1", "sent"],
      ["S2", "skipped-landed"],
    ]);
  });

  it("the full rehearsal: IDL init, cycle 1 with rehearsal signers, then S7 behind the pre-handover inventory", async () => {
    const w = await world();
    // Canonical IDL first (runbook step 3), from HEAD on devnet.
    const idlDry = await runTool("idl", env(w, { CHAIN_IDL_MODE: "send" }), idlTool, deps(w));
    expect(idlDry.error ?? null).toBeNull();
    const idlSend = await runTool(
      "idl",
      sendEnv(w, idlDry.planDigest as string, { CHAIN_IDL_MODE: "send" }),
      idlTool,
      deps(w),
    );
    expect(idlSend.error ?? null).toBeNull();
    expect(idlSend.status).toBe("completed");

    const rehearsal = {
      CHAIN_REHEARSAL_SIGNERS: [
        `superAdmin=${w.pairs.superAdmin.path}`,
        `blocklistAuthority=${w.pairs.blocklistAuthority.path}`,
        `kycAuthority=${w.pairs.kycAuthority.path}`,
      ].join(","),
    };
    const cycle = await sendRun(w, rehearsal);
    expect(cycle.error ?? null).toBeNull();
    expect((cycle.steps as { id: string }[]).map((s) => s.id)).toEqual([
      "S1",
      "S2",
      "S2b",
      `S3:${w.keys.admins[0]}`,
      "S4",
      "S4b",
      "X3",
      "X2",
      "S5",
      "X1",
      "S6",
    ]);
    const lines: string[] = [];
    const pending = await dryRun(w, {}, lines);
    expect(pending.status).toBe("awaiting");
    expect(lines.join("\n")).toMatch(/S7 pending: set CHAIN_HANDOVER=1/);

    const handover = { CHAIN_HANDOVER: "1", CHAIN_CONFIRM_HANDOVER: w.keys.vault };
    const s7 = await sendRun(w, handover);
    expect(s7.error ?? null).toBeNull();
    expect((s7.steps as { id: string }[]).map((s) => s.id)).toEqual(["S7"]);
    expect(s7.status).toBe("completed");
    expect((s7.handoverInventory as { blockers: string[] }).blockers).toEqual([]);

    const inventory = await runTool("inventory", env(w, { CHAIN_PHASE: "handed-over" }), inventoryTool, deps(w));
    expect(inventory.error ?? null).toBeNull();
    expect((inventory.findings as { severity: string; message: string }[]).filter((f) => f.severity === "blocker")).toEqual([]);
  });

  it("S7 waits for the unpause unless CHAIN_HANDOVER_WHILE_PAUSED=1", async () => {
    const w = await world();
    await sendRun(w, {
      CHAIN_REHEARSAL_SIGNERS: `superAdmin=${w.pairs.superAdmin.path},blocklistAuthority=${w.pairs.blocklistAuthority.path},kycAuthority=${w.pairs.kycAuthority.path}`,
    });
    // An Admin pauses again after S6.
    const sa = await signerOf(w, "superAdmin");
    await ledger(w, sa, [await getSetPauseFlagsInstructionAsync({ authority: sa, setMask: 0x3f, clearMask: 0 })]);
    const rpc = rpcFor(w);
    const state = await probeBootstrapState(rpc, w.map);
    const handover = (whilePaused: boolean) =>
      planBootstrap(state, w.map, { deployer: createNoopSigner(w.keys.deployer), rehearsal: {} }, {
        rpc,
        handover: { requested: true, confirmVault: w.keys.vault, whilePaused, inventoryBlockers: 0 },
      });
    const waiting = await handover(false);
    expect(waiting.awaiting.map((a) => a.id)).toEqual(["S6"]);
    expect(waiting.handover).toEqual({ planned: false, reason: "earlier steps are pending" });
    const paused = await handover(true);
    expect(paused.handover.planned).toBe(true);
    expect(ids(paused)).toEqual(["S7"]);
  });

  it("S7 refuses a wrong CHAIN_CONFIRM_HANDOVER and a pre-handover inventory with blockers", async () => {
    const w = await world();
    await sendRun(w, {
      CHAIN_REHEARSAL_SIGNERS: `superAdmin=${w.pairs.superAdmin.path},blocklistAuthority=${w.pairs.blocklistAuthority.path},kycAuthority=${w.pairs.kycAuthority.path}`,
    });
    const wrong = await dryRun(w, { CHAIN_HANDOVER: "1", CHAIN_CONFIRM_HANDOVER: key(3) });
    expect(wrong.error).toMatch(/CHAIN_CONFIRM_HANDOVER must equal the vault/);
    // No canonical IDL on this chain: the inventory has blockers.
    const blocked = await dryRun(w, { CHAIN_HANDOVER: "1", CHAIN_CONFIRM_HANDOVER: w.keys.vault });
    expect(blocked.error).toMatch(/pre-handover inventory has \d+ blockers/);
  });
});

describe("temporary KYC grant (D17 fallback, C5)", () => {
  it("runs as cycles 1/2/3: the grant is removed by the deployer before S5", async () => {
    const w = await world();
    const json = JSON.parse(fs.readFileSync(w.mapFile, "utf8"));
    json.kyc.tempAdminGrant = true;
    fs.writeFileSync(w.mapFile, JSON.stringify(json));
    w.map = (await validateRoleMap(json, { network: "devnet", genesis: CLUSTER_GENESIS_HASHES.devnet })).map;

    const one = await plan(w);
    const admin = w.keys.admins[0];
    expect(ids(one)).toEqual(["S1", "S2", "S2b", `S3:${admin}`, "S3k", "S4", "S4b"]);
    expect(one.blocked.map((b) => b.id)).toEqual(expect.arrayContaining(["S3r", "S5"]));
    await sendRun(w);

    // X2 and X3 on the operator front.
    const kyc = await signerOf(w, "kycAuthority");
    await ledger(w, kyc, [await buildAcceptKycAuthority({ newAuthoritySigner: kyc, registry: w.map.kyc.registry! })]);
    const ba = await signerOf(w, "blocklistAuthority");
    await ledger(w, ba, [await getAcceptBlocklistAuthorityInstructionAsync({ newAuthority: ba })]);

    const two = await plan(w);
    expect(ids(two)).toEqual(["S3r", "S5"]);
    await sendRun(w);
    const afterTwo = await probeBootstrapState(rpcFor(w), w.map);
    expect(afterTwo.adminRecords[w.keys.kycAuthority]).toBe(false);

    // X1 and S6 on the operator front.
    const sa = await signerOf(w, "superAdmin");
    const [oldAdminRecord] = await findAdminRecordPda({ authority: w.keys.deployer });
    await ledger(w, sa, [await getAcceptPlatformAdminInstructionAsync({ newAdmin: sa, oldAdminRecord })]);
    await ledger(w, sa, [await getSetPauseFlagsInstructionAsync({ authority: sa, setMask: 0, clearMask: 0x3f })]);

    const three = await plan(w);
    expect(ids(three)).toEqual([]);
    expect(three.awaiting).toEqual([]);
    expect(three.handover.reason).toMatch(/CHAIN_HANDOVER=1/);
  });
});

describe("partial progress and stops", () => {
  async function seedPlatform(w: World, value: { admin: Address; protocolTreasury?: Address; protocolFeeBps?: number; pauseFlags?: number }) {
    const [platform] = await findPlatformPda();
    w.chain.set(platform, {
      owner: REGISTRY,
      lamports: rent(94),
      data: new Uint8Array(
        getPlatformEncoder().encode({
          admin: value.admin,
          protocolTreasury: value.protocolTreasury ?? w.keys.vault,
          protocolFeeBps: value.protocolFeeBps ?? 0,
          pauseFlags: value.pauseFlags ?? 0x3f,
          issuersCount: 0,
          version: 2,
          bump: 255,
        }),
      ),
    });
    const [record] = await findAdminRecordPda({ authority: value.admin });
    w.chain.set(record, { owner: REGISTRY, lamports: rent(81), data: new Uint8Array(getAdminEncoder().encode({ admin: value.admin, addedBy: value.admin, bump: 255 })) });
  }
  async function seedBlocklist(w: World, authority: Address, proposed?: Address) {
    const [ba] = await findBlocklistAuthorityPda();
    w.chain.set(ba, { owner: HOOK, lamports: rent(41), data: new Uint8Array(getBlocklistAuthorityEncoder().encode({ authority, bump: 255 })) });
    if (proposed) {
      const [transfer] = await findTransferPda();
      w.chain.set(transfer, {
        owner: HOOK,
        lamports: rent(73),
        data: new Uint8Array(getBlocklistAuthorityTransferEncoder().encode({ currentAuthority: authority, newAuthority: proposed, bump: 255 })),
      });
    }
  }
  async function seedRegistry(w: World, authority: Address, proposed?: Address) {
    const registry = w.map.kyc.registry!;
    w.chain.set(registry, {
      owner: REGISTRY,
      lamports: rent(300),
      data: new Uint8Array(
        getKycRegistryEncoder().encode({
          authority,
          approvedJurisdictions: jurisdictionBitmap([...DEFAULT_APPROVED_JURISDICTIONS]),
          blockedJurisdictions: jurisdictionBitmap([]),
          entriesCount: 0,
          version: 2,
          bump: 255,
        }),
      ),
    });
    if (proposed) {
      w.chain.set(await findKycRegistryTransferPda(registry), {
        owner: REGISTRY,
        lamports: rent(137),
        data: new Uint8Array(
          getAuthorityTransferEncoder().encode({ target: registry, currentAuthority: authority, newAuthority: proposed, proposedBy: authority, bump: 255 }),
        ),
      });
    }
  }

  it("skips what already landed and re-classifies simulate classes", async () => {
    const w = await world();
    await seedPlatform(w, { admin: w.keys.deployer });
    await seedBlocklist(w, w.keys.deployer);
    const p = await plan(w);
    expect(ids(p)).toEqual(["S2b", `S3:${w.keys.admins[0]}`, "S4", "S4b", "S5"]);
    expect(Object.fromEntries(p.steps.map((s) => [s.id, s.simulate]))).toEqual({
      S2b: "now",
      [`S3:${w.keys.admins[0]}`]: "now",
      S4: "now",
      S4b: "at-send",
      S5: "now",
    });
    expect(p.skipped.map((s) => s.id)).toEqual(expect.arrayContaining(["S1", "S2"]));
  });

  it("stops on a fee the map does not have (no setter)", async () => {
    const w = await world();
    await seedPlatform(w, { admin: w.keys.deployer, protocolFeeBps: 50 });
    const p = await plan(w);
    expect(p.stops.join()).toMatch(/S1: Platform fee 50 bps ≠ map 0/);
  });

  it("a treasury mismatch is S1b for the deployer, an external SA action after X1", async () => {
    const w = await world();
    await seedPlatform(w, { admin: w.keys.deployer, protocolTreasury: key(88) });
    expect(ids(await plan(w))).toContain("S1b");
    const v = await world();
    await seedPlatform(v, { admin: v.keys.superAdmin, protocolTreasury: key(88) });
    const p = await plan(v);
    expect(p.awaiting.map((a) => a.id)).toContain("S1b");
    expect(ids(p)).not.toContain("S1b");
  });

  it("stops on a foreign blocklist authority and a foreign registry authority", async () => {
    const w = await world();
    await seedBlocklist(w, key(99));
    expect((await plan(w)).stops.join()).toMatch(/S2: BlocklistAuthority is .* only that key can propose/);
    const v = await world();
    await seedPlatform(v, { admin: v.keys.deployer });
    await seedRegistry(v, key(99));
    expect((await plan(v)).stops.join()).toMatch(/S4: registry authority .* is foreign/);
  });

  it("K4: refuses when the Platform or BA is missing and the UA is not the deployer", async () => {
    const w = await world();
    await w.chain.deployProgram(REGISTRY, { authority: w.keys.vault, payload: new Uint8Array([1]), capacity: CAPACITY.assetRegistry });
    const p = await plan(w);
    expect(p.stops.join()).toMatch(/P0 \(K4\)/);
    expect(p.steps).toEqual([]);
  });

  it("wrong pending proposals: BA and platform are overwritten, KYC is cancelled and re-proposed", async () => {
    const w = await world();
    await seedPlatform(w, { admin: w.keys.deployer });
    await seedBlocklist(w, w.keys.deployer, key(97));
    await seedRegistry(w, w.keys.deployer, key(96));
    const [platform] = await findPlatformPda();
    const [transfer] = await findAcceptPlatformAdminTransferPda({ platform });
    w.chain.set(transfer, {
      owner: REGISTRY,
      lamports: rent(137),
      data: new Uint8Array(
        getAuthorityTransferEncoder().encode({ target: platform, currentAuthority: w.keys.deployer, newAuthority: key(95), proposedBy: w.keys.deployer, bump: 255 }),
      ),
    });
    const p = await plan(w);
    expect(ids(p)).toEqual(["S2b", `S3:${w.keys.admins[0]}`, "S4b.cancel", "S4b", "S5"]);
    expect(p.notes.join()).toMatch(/overwrites a pending blocklist proposal/);
    // Send it and check the final proposals point at the map keys.
    const evidence = await sendRun(w);
    expect(evidence.error ?? null).toBeNull();
    const state = await probeBootstrapState(rpcFor(w), w.map);
    expect(state.blocklist?.proposed).toBe(w.keys.blocklistAuthority);
    expect(state.registryProposed).toBe(w.keys.kycAuthority);
    expect(state.platformProposed).toBe(w.keys.superAdmin);
  });

  it("stops when the deployer balance cannot pay for the cycle", async () => {
    const w = await world();
    w.chain.get(w.keys.deployer)!.lamports = BigInt(10_000);
    const evidence = await dryRun(w);
    expect(evidence.status).toBe("failed");
    expect(evidence.error).toMatch(/deployer balance 10000 lamports is below/);
  });
});
