import fs from "node:fs";
import path from "node:path";
import type { Address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  KybStatus,
  RealizeAction,
  VaultState,
  VaultType,
  findAdminRecordPda,
  findPlatformPda,
  getAdminEncoder,
  getCustodyVaultEncoder,
  getIssuerEncoder,
  getIssuerRecoveryEncoder,
  getKycRegistryEncoder,
  getPlatformEncoder,
  getRightsIssuanceEncoder,
} from "@/lib/generated/asset_registry";
import { findBlocklistAuthorityPda, getBlocklistAuthorityEncoder } from "@/lib/generated/transfer_hook";
import { CLUSTER_GENESIS_HASHES } from "@/lib/network-identity";
import { DEFAULT_APPROVED_JURISDICTIONS, getRegistryPda, jurisdictionBitmap } from "@/lib/passport";
import { runTool } from "@/scripts/chain/lib/context";
import {
  HANDOVER_TARGET_SCHEMA,
  handoverTool,
  planHandover,
  validateHandoverTarget,
  type HandoverPlan,
} from "@/scripts/chain/lib/handover-plan";
import { resolveIdlSources } from "@/scripts/chain/lib/idl-plan";
import type { RoleMapContext } from "@/scripts/chain/lib/role-map";
import { collectInventory } from "@/scripts/chain/lib/inventory";
import { REGISTRY, HOOK, key, rent } from "./helpers/chain-fake";
import { deps, env, root, rpcFor, world, type World } from "./helpers/chain-world";

const devnet = { network: "devnet" as const, genesis: CLUSTER_GENESIS_HASHES.devnet };
const mainnet = { network: "mainnet" as const, genesis: CLUSTER_GENESIS_HASHES.mainnet };

/** The devnet shape of 28.9.: one personal key (P) holds SA, BA, KYC and the treasury. */
async function devnetLike(w: World) {
  const P = w.keys.superAdmin;
  const [A1, A2, E] = [key(201), key(202), key(203)];
  const [platform] = await findPlatformPda();
  w.chain.set(platform, {
    owner: REGISTRY,
    lamports: rent(94),
    data: new Uint8Array(getPlatformEncoder().encode({ admin: P, protocolTreasury: P, protocolFeeBps: 250, pauseFlags: 0, issuersCount: 1, version: 2, bump: 255 })),
  });
  for (const admin of [P, A1, A2, E]) {
    const [record] = await findAdminRecordPda({ authority: admin });
    w.chain.set(record, { owner: REGISTRY, lamports: rent(81), data: new Uint8Array(getAdminEncoder().encode({ admin, addedBy: P, bump: 255 })) });
  }
  const [ba] = await findBlocklistAuthorityPda();
  w.chain.set(ba, { owner: HOOK, lamports: rent(41), data: new Uint8Array(getBlocklistAuthorityEncoder().encode({ authority: P, bump: 255 })) });
  const registry = await getRegistryPda(P);
  w.chain.set(registry, {
    owner: REGISTRY,
    lamports: rent(300),
    data: new Uint8Array(
      getKycRegistryEncoder().encode({
        authority: P,
        approvedJurisdictions: jurisdictionBitmap([...DEFAULT_APPROVED_JURISDICTIONS]),
        blockedJurisdictions: jurisdictionBitmap([]),
        entriesCount: 3,
        version: 2,
        bump: 255,
      }),
    ),
  });
  // A live custody vault, an issuer, a rights issuance and a pending issuer
  // recovery, all tied to P.
  const vault = key(210);
  w.chain.set(vault, {
    owner: REGISTRY,
    lamports: rent(300),
    data: new Uint8Array(
      getCustodyVaultEncoder().encode({
        shareClass: key(211),
        mint: key(212),
        escrow: key(213),
        vaultId: 1,
        authority: P,
        vaultType: VaultType.DeliveryEscrow,
        realizeAction: RealizeAction.BurnAndAttest,
        amount: 1,
        state: VaultState.Active,
        deadline: 0,
        metadataHash: new Uint8Array(32),
        beneficiary: key(214),
        version: 2,
        bump: 255,
        deposited: 1,
        kycRegistry: key(215),
      }),
    ),
  });
  const issuer = key(220);
  w.chain.set(issuer, {
    owner: REGISTRY,
    lamports: rent(117),
    data: new Uint8Array(
      getIssuerEncoder().encode({
        authority: P,
        legalEntityId: new Uint8Array(32),
        jurisdiction: 688,
        kybStatus: KybStatus.Verified,
        kybDocHash: new Uint8Array(32),
        assetsCount: 0,
        version: 2,
        bump: 255,
      }),
    ),
  });
  w.chain.set(key(221), {
    owner: REGISTRY,
    lamports: rent(200),
    data: new Uint8Array(
      getRightsIssuanceEncoder().encode({
        shareClass: key(222),
        underlyingMint: key(223),
        escrow: key(224),
        authority: P,
        issuanceId: 1,
        totalClaimed: 0,
        milestonesCount: 0,
        version: 2,
        bump: 255,
      }),
    ),
  });
  w.chain.set(key(225), {
    owner: REGISTRY,
    lamports: rent(200),
    data: new Uint8Array(
      getIssuerRecoveryEncoder().encode({
        issuer: key(226),
        currentAuthority: key(227),
        newAuthority: key(228),
        proposedBy: P,
        proposedAt: 1,
        eta: 2,
        expiresAt: 3,
        version: 2,
        bump: 255,
      }),
    ),
  });
  return { P, A1, A2, E, registry, vault, issuer };
}

async function companyTarget(w: World, registry: Address, extra: Record<string, unknown> = {}) {
  const C = w.keys.blocklistAuthority;
  return {
    C,
    json: {
      schema: HANDOVER_TARGET_SCHEMA,
      network: "devnet",
      genesisHash: CLUSTER_GENESIS_HASHES.devnet,
      kycRegistry: registry,
      superAdmin: C,
      admins: [key(203)],
      blocklistAuthority: C,
      kycAuthority: C,
      protocolTreasury: C,
      acknowledgedRoleOverlaps: [
        { key: C, roles: ["superAdmin", "kyc.authority", "blocklistAuthority", "protocolTreasury"], reason: "company wallet (test)" },
      ],
      ...extra,
    },
  };
}

async function inventoryOf(w: World, registry: Address) {
  const idlSources = resolveIdlSources({ env: {}, config: { network: "devnet" } as never, frontDir: path.join(root, "front") }, null);
  return collectInventory(rpcFor(w), { map: null, release: null, idlSources, lockPresent: false, kycPin: registry, scanBuffers: false });
}

const titles = (plan: HandoverPlan) => plan.steps.map((s) => s.title.replace(/\(.*$/, "").replace(/ .*$/, ""));

describe("handover target (Talas 8.2)", () => {
  it("validates a handover target and refuses what cannot work", async () => {
    const w = await world();
    const { json } = await companyTarget(w, key(230));
    const { target, warnings } = await validateHandoverTarget(json, devnet);
    expect(target.custodySuccessor).toBe(target.superAdmin);
    expect(warnings.join(" ")).toMatch(/ROLE OVERLAP \(acknowledged\)/);
    const reject = async (value: unknown, ctx: RoleMapContext = devnet): Promise<string> => {
      try {
        await validateHandoverTarget(value, ctx);
      } catch (error) {
        return (error as Error).message;
      }
      throw new Error("expected the target to be rejected");
    };
    expect(await reject({ ...json, custodySuccessor: key(240) })).toMatch(/custodySuccessor must be the superAdmin or one of admins/);
    expect(await reject({ ...json, admins: [json.superAdmin] })).toMatch(/must not list the superAdmin/);
    expect(await reject({ ...json, schema: "x" })).toMatch(/schema must be/);
    expect(await reject({ ...json, network: "mainnet", genesisHash: CLUSTER_GENESIS_HASHES.mainnet, acknowledgedRoleOverlaps: [] }, mainnet)).toMatch(
      /role overlap not acknowledged/,
    );
  });

  it("accepts a role map v2 as the target", async () => {
    const w = await world();
    const json = JSON.parse(fs.readFileSync(w.mapFile, "utf8"));
    const { target } = await validateHandoverTarget(json, devnet);
    expect(target).toMatchObject({ source: "role-map", superAdmin: w.keys.superAdmin, squadsVault: w.keys.vault, kycRegistry: w.map.kyc.registry });
  });
});

describe("handover plan: personal wallet → company wallet on devnet", () => {
  it("grants first, moves KYC / BA / custody / treasury, rotates the super admin last, then cleans up", async () => {
    const w = await world();
    const { P, A1, A2, E, registry, vault, issuer } = await devnetLike(w);
    const { C, json } = await companyTarget(w, registry);
    const { target } = await validateHandoverTarget(json, devnet);
    const plan = planHandover(await inventoryOf(w, registry), target, { site: "https://www.manci.io" });

    expect(titles(plan)).toEqual([
      "Onboard",
      "Fund",
      "add_admin",
      "propose_custody_authority",
      "accept_custody_authority",
      "propose_kyc_registry_authority",
      "accept_kyc_registry_authority",
      "propose_blocklist_authority",
      "accept_blocklist_authority",
      "set_protocol_treasury",
      "propose_platform_admin",
      "accept_platform_admin",
      "remove_admin",
      "remove_admin",
      "Verify",
    ]);
    const by = (instruction: string) => plan.steps.filter((s) => s.instruction === instruction);
    // Who signs: the current holder proposes, the company wallet accepts.
    expect(by("add_admin")[0]).toMatchObject({ title: `add_admin(${C})`, signer: { key: P, side: "current" }, where: expect.stringMatching(/^\/admin\/admins/) });
    expect(by("propose_custody_authority")[0].title).toContain(vault);
    expect(by("propose_kyc_registry_authority")[0]).toMatchObject({ signer: { key: P, side: "current" }, where: expect.stringMatching(/^\/admin\/kyc/) });
    for (const accept of ["accept_custody_authority", "accept_kyc_registry_authority", "accept_blocklist_authority", "accept_platform_admin"]) {
      expect(by(accept)[0]).toMatchObject({ signer: { key: C, side: "new" }, where: expect.stringMatching(/^\/account\/roles/) });
    }
    expect(by("set_protocol_treasury")[0]).toMatchObject({ signer: { key: P }, where: expect.stringMatching(/^\/admin\/platform/) });
    // The super admin rotates only after every move, and cleanup after it.
    const index = (id: string) => plan.steps.findIndex((s) => s.id === id);
    const accept = by("accept_platform_admin")[0];
    const propose = by("propose_platform_admin")[0];
    expect(propose.requires).toEqual(expect.arrayContaining(plan.steps.filter((s) => s.phase === "move").map((s) => s.id)));
    expect(accept.requires).toEqual([propose.id]);
    for (const step of by("remove_admin")) {
      expect(step.signer).toMatchObject({ key: C, side: "new" });
      expect(step.requires).toContain(accept.id);
      expect(index(step.id)).toBeGreaterThan(index(accept.id));
    }
    expect(by("remove_admin").map((s) => s.title)).toEqual([`remove_admin(${A1})`, `remove_admin(${A2})`]);
    // E is kept, P's record closes at the accept: neither is removed by hand.
    expect(plan.steps.some((s) => s.title.includes(E) || s.title === `remove_admin(${P})`)).toBe(false);
    // The rest are decisions for the owner.
    const decisions = plan.decisions.join("\n");
    expect(decisions).toContain(issuer);
    expect(decisions).toMatch(/Rights issuance .* no rotation \(K19\)/);
    expect(decisions).toMatch(/Issuer recovery .* goes stale/);
    expect(plan.outgoing).toEqual(expect.arrayContaining([P, A1, A2]));
    expect(plan.warnings.join(" ")).toMatch(/superAdmin \+ kyc\.authority \+ blocklistAuthority \+ protocolTreasury/);
  });

  it("an issuer successor that is an Admin key must be accepted before the super admin rotation", async () => {
    const w = await world();
    const { registry, issuer } = await devnetLike(w);
    const { C, json } = await companyTarget(w, registry, { issuerSuccessor: undefined });
    const { target } = await validateHandoverTarget({ ...json, issuerSuccessor: C }, devnet);
    const plan = planHandover(await inventoryOf(w, registry), target);
    const acceptIssuer = plan.steps.find((s) => s.instruction === "accept_issuer_authority")!;
    expect(acceptIssuer.title).toContain(issuer);
    expect(acceptIssuer.notes.join(" ")).toMatch(/BEFORE the super admin rotation/);
    const proposeSa = plan.steps.find((s) => s.instruction === "propose_platform_admin")!;
    expect(proposeSa.requires).toContain(acceptIssuer.id);
    expect(plan.decisions.join(" ")).not.toContain(issuer);
  });

  it("pending proposals: an accept-only step when it already names the target; a foreign KYC proposal is cancelled first", async () => {
    const w = await world();
    const { P, registry } = await devnetLike(w);
    const { C, json } = await companyTarget(w, registry);
    const { target } = await validateHandoverTarget(json, devnet);
    const inv = await inventoryOf(w, registry);
    inv.platform!.proposed = C;
    inv.blocklist!.proposed = key(250);
    inv.kycRegistries[0].proposed = key(251);
    const plan = planHandover(inv, target);
    expect(plan.steps.some((s) => s.instruction === "propose_platform_admin")).toBe(false);
    expect(plan.steps.find((s) => s.instruction === "propose_blocklist_authority")?.notes.join(" ")).toMatch(/overwrites the pending proposal/);
    const cancel = plan.steps.find((s) => s.instruction === "cancel_kyc_registry_authority_transfer")!;
    expect(cancel.signer.key).toBe(P);
    expect(plan.steps.find((s) => s.instruction === "propose_kyc_registry_authority")!.requires).toContain(cancel.id);
  });

  it("nothing to do when every role already has its target key; a chain without a platform is refused", async () => {
    const w = await world();
    const { P, E, registry } = await devnetLike(w);
    const { json } = await companyTarget(w, registry);
    const same = { ...json, superAdmin: P, blocklistAuthority: P, kycAuthority: P, protocolTreasury: P, admins: [E, key(201), key(202)] };
    same.acknowledgedRoleOverlaps = [{ key: P, roles: ["superAdmin", "kyc.authority", "blocklistAuthority", "protocolTreasury"], reason: "today" }];
    const { target } = await validateHandoverTarget(same, devnet);
    const plan = planHandover(await inventoryOf(w, registry), target);
    expect(plan.steps.filter((s) => s.instruction)).toEqual([]);
    expect(plan.done).toHaveLength(4);
    const empty = await world();
    const bare = await inventoryOf(empty, registry);
    expect(() => planHandover(bare, target)).toThrow(/bootstrap it first/);
  });

  it("the runner prints and writes the plan, and never simulates or sends", async () => {
    const w = await world();
    const { registry } = await devnetLike(w);
    const { json } = await companyTarget(w, registry);
    const file = path.join(w.dir, "handover-target.json");
    fs.writeFileSync(file, JSON.stringify(json));
    const lines: string[] = [];
    const evidence = await runTool("handover", env(w, { CHAIN_ROLE_MAP: file }), handoverTool, deps(w, lines));
    expect(evidence.error ?? null).toBeNull();
    expect(evidence.status).toBe("awaiting");
    expect(lines.join("\n")).toMatch(/H3 +grant +current +\S+ +add_admin\(/);
    const markdown = fs.readFileSync(path.join(w.dir, String(evidence.planFile)), "utf8");
    expect(markdown).toMatch(/^# Role handover plan \(devnet\)/);
    expect(markdown).toMatch(/- \[ \] \*\*H\d+ \(super-admin\)\*\* accept_platform_admin/);
    expect(w.chain.calls).not.toContain("sendTransaction");
    expect(w.chain.calls).not.toContain("simulateTransaction");
    await expect(
      runTool("handover", env(w, { CHAIN_ROLE_MAP: file, CHAIN_SEND: "1", CHAIN_KEYPAIR: "k", CHAIN_CONFIRM_PLAN: "d" }), handoverTool, deps(w)),
    ).rejects.toThrow(/handover never sends/);
  });
});
