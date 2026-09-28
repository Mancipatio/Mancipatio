import fs from "node:fs";
import path from "node:path";
import type { Address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  KybStatus,
  RealizeAction,
  VaultState,
  VaultType,
  findAcceptPlatformAdminRecoveryPda,
  findAcceptPlatformAdminTransferPda,
  findAdminRecordPda,
  findPendingAdminPda,
  findPlatformPda,
  getAdminEncoder,
  getAuthorityProposalEncoder,
  getPendingAdminEncoder,
  getPlatformRecoveryEncoder,
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
    // The devnet handover is the rehearsal of that acknowledgement: refused too.
    expect(await reject({ ...json, acknowledgedRoleOverlaps: [] })).toMatch(/role overlap not acknowledged/);
  });

  it("applies the role map rules for the vault and the treasury: an unknown treasury is refused on mainnet", async () => {
    const w = await world();
    const { C, json } = await companyTarget(w, key(230));
    const onMainnet = { ...json, network: "mainnet", genesisHash: CLUSTER_GENESIS_HASHES.mainnet };
    const reject = async (value: unknown, ctx: RoleMapContext): Promise<string> => {
      try {
        await validateHandoverTarget(value, ctx);
      } catch (error) {
        return (error as Error).message;
      }
      throw new Error("expected the target to be rejected");
    };
    // A treasury that holds no other role and is not the vault: a typo or a foreign key.
    const unknownTreasury = {
      ...onMainnet,
      protocolTreasury: key(260),
      acknowledgedRoleOverlaps: [{ key: C, roles: ["superAdmin", "kyc.authority", "blocklistAuthority"], reason: "company wallet (test)" }],
    };
    expect(await reject(unknownTreasury, mainnet)).toMatch(/protocolTreasury \S+ is neither the squadsVault nor a role key/);
    const { warnings } = await validateHandoverTarget({ ...unknownTreasury, network: "devnet", genesisHash: CLUSTER_GENESIS_HASHES.devnet }, devnet);
    expect(warnings.join(" ")).toMatch(/is neither the squadsVault nor a role key/);
    // The vault as the treasury is fine; as the BA or the KYC authority it is not.
    const vault = key(261);
    await expect(validateHandoverTarget({ ...unknownTreasury, protocolTreasury: vault, squadsVault: vault }, mainnet)).resolves.toBeTruthy();
    const vaultBa = {
      ...onMainnet,
      squadsVault: vault,
      protocolTreasury: vault,
      blocklistAuthority: vault,
      acknowledgedRoleOverlaps: [{ key: C, roles: ["superAdmin", "kyc.authority"], reason: "company wallet (test)" }],
    };
    expect(await reject(vaultBa, mainnet)).toMatch(/blocklistAuthority must not be the Squads vault/);
  });

  it("warns when the company wallet model keeps no second Admin record (nobody could pause after a loss)", async () => {
    const w = await world();
    const { json } = await companyTarget(w, key(230), { admins: [] });
    const { warnings } = await validateHandoverTarget(json, devnet);
    expect(warnings.join(" ")).toMatch(/NO SECOND ADMIN: .* no pause-only role/);
    const kept = await validateHandoverTarget((await companyTarget(w, key(230))).json, devnet);
    expect(kept.warnings.join(" ")).not.toMatch(/NO SECOND ADMIN/);
  });

  it("accepts a role map v2 as the target", async () => {
    const w = await world();
    const json = JSON.parse(fs.readFileSync(w.mapFile, "utf8"));
    const { target } = await validateHandoverTarget(json, devnet);
    expect(target).toMatchObject({ source: "role-map", superAdmin: w.keys.superAdmin, squadsVault: w.keys.vault, kycRegistry: w.map.kyc.registry });
  });
});

describe("handover plan: personal wallet → company wallet on devnet", () => {
  it("proposes every timelocked change at T, moves the instant roles, executes grants and the SA accept at T+48h, then cleans up", async () => {
    const w = await world();
    const { P, A1, A2, E, registry, vault, issuer } = await devnetLike(w);
    const { C, json } = await companyTarget(w, registry);
    const { target } = await validateHandoverTarget(json, devnet);
    const plan = planHandover(await inventoryOf(w, registry), target, { site: "https://www.manci.io" });

    // v1.0.0-rc (D3): both timelocked proposals (the grant and the SA
    // rotation) go out at T so their 48 hours run in parallel; the instant
    // roles move meanwhile; at T+48h the new key executes its grant, takes the
    // custody vault (which needs its Admin record) and accepts the SA last.
    expect(titles(plan)).toEqual([
      "Onboard",
      "Fund",
      "propose_admin",
      "propose_platform_admin",
      "propose_kyc_registry_authority",
      "accept_kyc_registry_authority",
      "propose_blocklist_authority",
      "accept_blocklist_authority",
      "set_protocol_treasury",
      "add_admin",
      "propose_custody_authority",
      "accept_custody_authority",
      "accept_platform_admin",
      "remove_admin",
      "remove_admin",
      "Verify",
    ]);
    const by = (instruction: string) => plan.steps.filter((s) => s.instruction === instruction);
    // Who signs: the current holder proposes, the company wallet accepts
    // (its own Admin grant included, on /account/roles).
    expect(by("propose_admin")[0]).toMatchObject({ title: `propose_admin(${C})`, signer: { key: P, side: "current" }, where: expect.stringMatching(/^\/admin\/admins/) });
    expect(by("add_admin")[0]).toMatchObject({ title: `add_admin(${C})`, signer: { key: C, side: "new" }, requires: [by("propose_admin")[0].id], where: expect.stringMatching(/^\/account\/roles/) });
    expect(by("propose_custody_authority")[0].title).toContain(vault);
    expect(by("propose_kyc_registry_authority")[0]).toMatchObject({ signer: { key: P, side: "current" }, where: expect.stringMatching(/^\/admin\/kyc/) });
    for (const accept of ["accept_custody_authority", "accept_kyc_registry_authority", "accept_blocklist_authority", "accept_platform_admin"]) {
      expect(by(accept)[0]).toMatchObject({ signer: { key: C, side: "new" }, where: expect.stringMatching(/^\/account\/roles/) });
    }
    expect(by("set_protocol_treasury")[0]).toMatchObject({ signer: { key: P }, where: expect.stringMatching(/^\/admin\/platform/) });
    // The super admin accepts only after every move and every grant, and cleanup after it.
    const index = (id: string) => plan.steps.findIndex((s) => s.id === id);
    const accept = by("accept_platform_admin")[0];
    const propose = by("propose_platform_admin")[0];
    expect(propose.requires).toEqual(plan.steps.filter((s) => s.phase === "prepare").map((s) => s.id));
    expect(accept.requires).toEqual(
      expect.arrayContaining([propose.id, by("add_admin")[0].id, ...plan.steps.filter((s) => s.phase === "move").map((s) => s.id)]),
    );
    // The timeline: proposals and instant moves at T, grant, custody and accept at T+48h.
    const offsets = Object.fromEntries(plan.steps.filter((s) => s.instruction).map((s) => [s.title.replace(/\(.*$/, "").replace(/ .*$/, ""), s.offsetHours]));
    expect(offsets).toMatchObject({
      propose_admin: 0,
      propose_platform_admin: 0,
      accept_kyc_registry_authority: 0,
      accept_blocklist_authority: 0,
      set_protocol_treasury: 0,
      add_admin: 48,
      propose_custody_authority: 48,
      accept_custody_authority: 48,
      accept_platform_admin: 48,
      remove_admin: 48,
    });
    expect(by("add_admin")[0].when).toBe(`T+48h: 48 hours after ${by("propose_admin")[0].id} lands, within 14 days of that`);
    expect(accept.when).toBe(`T+48h: 48 hours after ${propose.id} lands, within 14 days of that`);
    expect(by("propose_custody_authority")[0].requires).toEqual([by("add_admin")[0].id]);
    expect(plan.warnings.join(" ")).toMatch(/Timeline: the proposals go out at T; .* about 48 hours/);
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

  it("an outgoing super admin the target keeps as an Admin gets its record back right after the accept", async () => {
    const w = await world();
    const { P, A1, A2, E, registry, vault } = await devnetLike(w);
    const { C, json } = await companyTarget(w, registry, { admins: [P, E] });
    const { target } = await validateHandoverTarget(json, devnet);
    const plan = planHandover(await inventoryOf(w, registry), target);
    expect(titles(plan)).toEqual([
      "Onboard",
      "Fund",
      "propose_admin",
      "propose_platform_admin",
      "propose_kyc_registry_authority",
      "accept_kyc_registry_authority",
      "propose_blocklist_authority",
      "accept_blocklist_authority",
      "set_protocol_treasury",
      "add_admin",
      "accept_platform_admin",
      "propose_admin",
      "add_admin",
      "remove_admin",
      "remove_admin",
      "Verify",
    ]);
    const accept = plan.steps.find((s) => s.instruction === "accept_platform_admin")!;
    // v1: the new SA re-proposes P right after the accept; P executes its own grant.
    const repropose = plan.steps.find((s) => s.title === `propose_admin(${P})`)!;
    const regrant = plan.steps.find((s) => s.title === `add_admin(${P})`)!;
    expect(repropose).toMatchObject({ phase: "super-admin", signer: { key: C, side: "new" }, requires: [accept.id], where: expect.stringMatching(/^\/admin\/admins/) });
    expect(regrant).toMatchObject({ phase: "super-admin", signer: { key: P }, requires: [repropose.id], where: expect.stringMatching(/^\/account\/roles/) });
    expect(plan.steps.indexOf(repropose)).toBe(plan.steps.indexOf(accept) + 1);
    expect(plan.steps.indexOf(regrant)).toBe(plan.steps.indexOf(accept) + 2);
    // Its own grant waits another 48 hours after the re-proposal: T+96h.
    expect([accept.offsetHours, repropose.offsetHours, regrant.offsetHours]).toEqual([48, 48, 96]);
    // Its custody vault and rights issuance are without an Admin in between: noted and decided.
    expect(repropose.notes.join(" ")).toMatch(new RegExp(`custody vaults it operates .*${vault}`));
    expect(repropose.notes.join(" ")).toMatch(/publish_milestone is refused/);
    expect(plan.decisions.join(" ")).toMatch(new RegExp(`${P} stays an Admin in the target.*custody vault ${vault}`));
    // P is not outgoing; the removals and the verify step come after the re-grant.
    expect(plan.outgoing).not.toContain(P);
    expect(plan.outgoing).toEqual(expect.arrayContaining([A1, A2]));
    for (const step of plan.steps.filter((s) => s.phase === "cleanup")) expect(step.requires).toContain(regrant.id);
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
    const acceptSa = plan.steps.find((s) => s.instruction === "accept_platform_admin")!;
    expect(acceptSa.requires).toContain(acceptIssuer.id);
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

  it("proposals already on chain: chain windows, an expired grant proposed again, stale grants cancelled, a pending recovery decided first", async () => {
    const w = await world();
    const { P, E, registry } = await devnetLike(w);
    const [kept, earlierSa, stranger] = [key(204), key(206), key(205)];
    const { C, json } = await companyTarget(w, registry, { admins: [E, kept] });
    const { target } = await validateHandoverTarget(json, devnet);
    const now = BigInt(w.chain.now);
    const HOUR = BigInt(3_600);
    const TIMELOCK = BigInt(172_800);
    const WINDOW = BigInt(1_209_600);
    const [platform] = await findPlatformPda();
    // The SA rotation to C went out an hour ago: acceptable in 47 hours.
    const [transfer] = await findAcceptPlatformAdminTransferPda({ platform });
    const at = now - HOUR;
    w.chain.set(transfer, {
      owner: REGISTRY,
      lamports: rent(163),
      data: new Uint8Array(
        getAuthorityProposalEncoder().encode({ target: platform, currentAuthority: P, newAuthority: C, proposedBy: P, proposedAt: at, eta: at + TIMELOCK, expiresAt: at + TIMELOCK + WINDOW, kind: 0, version: 1, bump: 255 }),
      ),
    });
    const grant = async (newAdmin: Address, proposedBy: Address, proposedAt: bigint) =>
      w.chain.set((await findPendingAdminPda({ newAdmin }))[0], {
        owner: REGISTRY,
        lamports: rent(98),
        data: new Uint8Array(
          getPendingAdminEncoder().encode({ newAdmin, proposedBy, proposedAt, eta: proposedAt + TIMELOCK, expiresAt: proposedAt + TIMELOCK + WINDOW, version: 1, bump: 255 }),
        ),
      });
    await grant(C, P, now - BigInt(20 * 86_400)); // expired
    await grant(kept, P, now - HOUR); // live, 47 h to go
    await grant(stranger, earlierSa, now - HOUR); // an earlier super admin's (K1.10)
    // A super admin recovery by the upgrade authority is pending.
    const [recovery] = await findAcceptPlatformAdminRecoveryPda({ platform });
    w.chain.set(recovery, {
      owner: REGISTRY,
      lamports: rent(162),
      data: new Uint8Array(
        getPlatformRecoveryEncoder().encode({ platform, currentAdmin: P, newAdmin: key(207), proposedBy: w.keys.deployer, proposedAt: now, eta: now + BigInt(604_800), expiresAt: now + BigInt(604_800) + WINDOW, version: 1, bump: 255 }),
      ),
    });
    const plan = planHandover(await inventoryOf(w, registry), target, { now });
    const find = (title: string) => plan.steps.find((s) => s.title === title);
    // The rotation on chain is not proposed again; its accept waits for the chain window.
    expect(plan.steps.some((s) => s.instruction === "propose_platform_admin")).toBe(false);
    const accept = plan.steps.find((s) => s.instruction === "accept_platform_admin")!;
    expect(accept.when).toMatch(/^on chain: Executable from .* \(in 1d 23h 00m\), until /);
    // C's expired grant is proposed again (48 h from now); the kept key's live grant runs in its chain window.
    expect(plan.steps.filter((s) => s.instruction === "propose_admin").map((s) => s.title)).toEqual([`propose_admin(${C})`]);
    expect(find(`propose_admin(${C})`)!.notes.join(" ")).toMatch(/expired .*proposes it again/);
    expect(find(`add_admin(${C})`)!.offsetHours).toBe(48);
    expect(find(`add_admin(${kept})`)).toMatchObject({ offsetHours: 47, when: expect.stringMatching(/^on chain: Executable from .* \(in 1d 23h 00m\)/) });
    expect(accept.offsetHours).toBe(48);
    // The earlier super admin's grant is withdrawn in the cleanup.
    expect(find(`cancel_admin_proposal(${stranger})`)).toMatchObject({ phase: "cleanup", signer: { key: C } });
    expect(find(`cancel_admin_proposal(${stranger})`)!.notes.join(" ")).toMatch(/earlier super admin.*K1\.10/);
    // The recovery refuses the accept until it ends.
    expect(plan.decisions.join(" ")).toMatch(/super admin recovery to \S+ by the upgrade authority is pending .*refused \(6155\)/);
  });

  it("a target that gives the vault (the upgrade authority) an operational role is refused (review finding 6)", async () => {
    const w = await world();
    const { json } = await companyTarget(w, key(230));
    const vault = key(262);
    const reject = async (value: unknown): Promise<string> => {
      try {
        await validateHandoverTarget(value, devnet);
      } catch (error) {
        return (error as Error).message;
      }
      throw new Error("expected the target to be rejected");
    };
    expect(await reject({ ...json, squadsVault: vault, superAdmin: vault, acknowledgedRoleOverlaps: [] })).toMatch(/superAdmin must not be the Squads vault \(it is the upgrade authority: SA == UA\)/);
    expect(await reject({ ...json, squadsVault: vault, admins: [vault] })).toMatch(/admins must not list the Squads vault/);
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
    expect(lines.join("\n")).toMatch(/H3 +grant +current +\S+ +propose_admin\(/);
    expect(lines.join("\n")).toMatch(/H4 +super-admin +current +\S+ +propose_platform_admin\(/);
    expect(lines.join("\n")).toMatch(/H\d+ +grant +new +\S+ +add_admin\(\S+\)\n +when: +T\+48h: 48 hours after H3 lands/);
    const markdown = fs.readFileSync(path.join(w.dir, String(evidence.planFile)), "utf8");
    expect(markdown).toMatch(/^# Role handover plan \(devnet\)/);
    expect(markdown).toMatch(/- \[ \] \*\*H\d+ \(super-admin\)\*\* accept_platform_admin/);
    expect(markdown).toMatch(/  - when: T\+48h: 48 hours after H4 lands/);
    expect(evidence.chainTime).toBe(String(w.chain.now));
    expect(w.chain.calls).not.toContain("sendTransaction");
    expect(w.chain.calls).not.toContain("simulateTransaction");
    await expect(
      runTool("handover", env(w, { CHAIN_ROLE_MAP: file, CHAIN_SEND: "1", CHAIN_KEYPAIR: "k", CHAIN_CONFIRM_PLAN: "d" }), handoverTool, deps(w)),
    ).rejects.toThrow(/handover never sends/);
  });
});
