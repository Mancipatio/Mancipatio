import fs from "node:fs";
import path from "node:path";
import { getAddressEncoder, type Address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { getAuthorityTransferEncoder } from "@/lib/generated/asset_registry";
import { bootstrapTool } from "@/scripts/chain/lib/bootstrap-plan";
import { runTool } from "@/scripts/chain/lib/context";
import { resolveIdlSources, type IdlProbe } from "@/scripts/chain/lib/idl-plan";
import {
  collectInventory,
  inventoryFindings,
  inventoryTool,
  type Finding,
  type Inventory,
  type InventoryPhase,
} from "@/scripts/chain/lib/inventory";
import { LOADER_V3 } from "@/scripts/chain/lib/loader-v3";
import { PM_HEADER_LENGTH, PM_PROGRAM } from "@/scripts/chain/lib/program-metadata";
import type { RoleMap } from "@/scripts/chain/lib/role-map";
import {
  SQUADS_V4_PROGRAM,
  decodeMultisig,
  decodeProposal,
  encodeMultisig,
  encodeProposal,
  squadsProposalPda,
} from "@/scripts/chain/lib/squads";
import { HOOK, REGISTRY, key, rent } from "./helpers/chain-fake";
import { CAPACITY, deps, env, root, rpcFor, sendEnv, world } from "./helpers/chain-world";

function probe(program: "asset_registry" | "transfer_hook", patch: Partial<IdlProbe> = {}): IdlProbe {
  return {
    program,
    programAddress: program === "asset_registry" ? REGISTRY : HOOK,
    metadata: key(program === "asset_registry" ? 110 : 111),
    status: "in-sync",
    account: null,
    decoded: null,
    onChain: null,
    source: { label: "head", bytes: new Uint8Array() },
    extraAuthority: null,
    mutable: true,
    trimmed: true,
    ...patch,
  };
}

/** A clean, handed-over inventory for `map`. */
function clean(map: RoleMap): Inventory {
  return {
    programs: [
      { name: "asset_registry", address: REGISTRY, deployed: true, programData: key(120), upgradeAuthority: map.squads.vault, deploySlot: "1", capacity: CAPACITY.assetRegistry, payloadExecutableHash: null, release: null },
      { name: "transfer_hook", address: HOOK, deployed: true, programData: key(121), upgradeAuthority: map.squads.vault, deploySlot: "1", capacity: CAPACITY.transferHook, payloadExecutableHash: null, release: null },
    ],
    idl: [probe("asset_registry"), probe("transfer_hook")],
    idlComparedAgainst: "head",
    platform: {
      address: key(130),
      admin: map.superAdmin,
      protocolTreasury: map.squads.vault,
      protocolFeeBps: 0,
      pauseFlags: 0,
      pauseFlagsHex: "0x00",
      unknownPauseBits: 0,
      proposed: null,
    },
    admins: [
      { record: key(131), admin: map.superAdmin, addedBy: map.deployer },
      ...map.admins.map((admin, i) => ({ record: key(132 + i), admin, addedBy: map.deployer })),
    ],
    blocklist: { authority: map.blocklistAuthority, proposed: null },
    kycRegistries: [{ address: map.kyc.registry!, authority: map.kyc.authority, entriesCount: "0", proposed: null }],
    kycPin: { address: map.kyc.registry!, live: true },
    authorityTransfers: [],
    issuerRecoveries: [],
    drift: { custodyWithoutAdmin: [], rightsWithoutAdmin: [], saleAuthorityDrift: [], payoutFounderDrift: [] },
    buffers: { loader: [], pm: [], scanErrors: [] },
    squads: { ok: true, owner: SQUADS_V4_PROGRAM, vaultDerivationOk: true, decoded: null, errors: [] },
    squadsProposals: { fromIndex: "1", toIndex: "0", open: [], errors: [] },
    lockPresent: false,
    decodeErrors: [],
  };
}

const bySeverity = (findings: Finding[], code: string) => findings.filter((f) => f.code === code).map((f) => f.severity);
const phases: InventoryPhase[] = ["in-progress", "pre-handover", "handed-over"];

describe("inventory findings (§6)", () => {
  it("a clean handed-over state has no findings", async () => {
    const { map } = await world();
    expect(inventoryFindings(clean(map), map, "handed-over")).toEqual([]);
  });

  it("deployer roles: info while in progress, blockers at handover; its UA only after handover", async () => {
    const { map } = await world();
    const inv = clean(map);
    inv.admins.push({ record: key(140), admin: map.deployer, addedBy: map.deployer });
    expect(phases.map((phase) => bySeverity(inventoryFindings(inv, map, phase), "deployer-role"))).toEqual([["info"], ["blocker"], ["blocker"]]);
    const ua = clean(map);
    ua.programs[0].upgradeAuthority = map.deployer;
    expect(bySeverity(inventoryFindings(ua, map, "pre-handover"), "deployer-ua")).toEqual(["info"]);
    expect(bySeverity(inventoryFindings(ua, map, "pre-handover"), "ua-unexpected")).toEqual([]);
    expect(bySeverity(inventoryFindings(ua, map, "handed-over"), "deployer-ua")).toEqual(["blocker"]);
    expect(bySeverity(inventoryFindings(ua, map, "handed-over"), "ua-not-vault")).toEqual(["blocker"]);
  });

  it("the bufferWriter may hold nothing, in any phase (C14)", async () => {
    const { map } = await world();
    const inv = clean(map);
    inv.admins.push({ record: key(141), admin: map.bufferWriter, addedBy: map.superAdmin });
    for (const phase of phases) expect(bySeverity(inventoryFindings(inv, map, phase), "bufferwriter-role")).toEqual(["blocker"]);
  });

  it("kyc.authority with an Admin record: warning in progress, blocker after, unless allowKycAdmin (C5)", async () => {
    const { map } = await world();
    const inv = clean(map);
    inv.admins.push({ record: key(142), admin: map.kyc.authority, addedBy: map.deployer });
    expect(phases.map((phase) => bySeverity(inventoryFindings(inv, map, phase), "kyc-admin"))).toEqual([["warning"], ["blocker"], ["blocker"]]);
    expect(bySeverity(inventoryFindings(inv, { ...map, allowKycAdmin: true }, "handed-over"), "kyc-admin")).toEqual(["warning"]);
  });

  it("an Admin record outside the role map: warning in progress, blocker at and after handover", async () => {
    const { map } = await world();
    const inv = clean(map);
    inv.admins.push({ record: key(143), admin: key(144), addedBy: map.superAdmin });
    expect(phases.map((phase) => bySeverity(inventoryFindings(inv, map, phase), "admin-unknown"))).toEqual([["warning"], ["blocker"], ["blocker"]]);
    // Keys with their own findings are not reported twice.
    const own = clean(map);
    own.admins.push({ record: key(145), admin: map.deployer, addedBy: map.deployer });
    own.admins.push({ record: key(146), admin: map.kyc.authority, addedBy: map.deployer });
    expect(bySeverity(inventoryFindings(own, map, "handed-over"), "admin-unknown")).toEqual([]);
  });

  it("an Admin record for the SA before it accepted is a warning (C4)", async () => {
    const { map } = await world();
    const inv = clean(map);
    inv.platform!.admin = map.deployer;
    expect(bySeverity(inventoryFindings(inv, map, "in-progress"), "sa-early-admin")).toEqual(["warning"]);
  });

  it("Squads mismatch or decode failure: warning in progress, blocker at and after handover (C11)", async () => {
    const { map } = await world();
    const inv = clean(map);
    inv.squads = { ok: false, owner: SQUADS_V4_PROGRAM, vaultDerivationOk: true, decoded: null, errors: ["multisig decode failed: truncated"] };
    expect(phases.map((phase) => bySeverity(inventoryFindings(inv, map, phase), "squads"))).toEqual([["warning"], ["blocker"], ["blocker"]]);
  });

  it("capacity: headroom warnings per program and programDataMaxLen at handover (C6)", async () => {
    const { map } = await world();
    const inv = clean(map);
    inv.programs[0].release = { equal: true, length: CAPACITY.assetRegistry - 100, headroom: 100, verifyHash: null };
    inv.programs[1].capacity = 8192;
    inv.programs[1].release = { equal: true, length: 10, headroom: 8182, verifyHash: null };
    expect(inventoryFindings(inv, map, "handed-over").map((f) => f.code)).toEqual(["headroom"]);
    inv.programs[1].capacity = CAPACITY.transferHook - 1;
    expect(bySeverity(inventoryFindings(inv, map, "pre-handover"), "capacity")).toEqual(["blocker"]);
    expect(bySeverity(inventoryFindings(inv, map, "in-progress"), "capacity")).toEqual(["warning"]);
    inv.programs[0].release = { equal: false, length: 1, headroom: 1, verifyHash: null };
    expect(bySeverity(inventoryFindings(inv, map, "pre-handover"), "release-bytes")).toEqual(["blocker"]);
  });

  it("proposals: a pending one blocks handover, a foreign one always blocks; stale transfers warn", async () => {
    const { map } = await world();
    const inv = clean(map);
    inv.platform!.proposed = key(150);
    expect(bySeverity(inventoryFindings(inv, map, "in-progress"), "foreign-proposal")).toEqual(["blocker"]);
    const pending = clean(map);
    pending.blocklist!.proposed = map.superAdmin;
    expect(bySeverity(inventoryFindings(pending, map, "pre-handover"), "pending-ba")).toEqual(["blocker"]);
    expect(bySeverity(inventoryFindings(pending, map, "in-progress"), "pending-ba")).toEqual([]);
    const stale = clean(map);
    stale.authorityTransfers.push({ address: key(151), target: key(152), kind: "custody", currentAuthority: key(153), newAuthority: key(154), proposedBy: key(155), stale: true });
    expect(bySeverity(inventoryFindings(stale, map, "handed-over"), "stale-transfer")).toEqual(["warning"]);
  });

  it("pause, IDL, metadata authority, BA == SA and a leftover lock", async () => {
    const { map } = await world();
    const paused = clean(map);
    paused.platform!.pauseFlags = 0x3f;
    paused.platform!.pauseFlagsHex = "0x3f";
    expect(bySeverity(inventoryFindings(paused, map, "pre-handover"), "paused")).toEqual(["blocker"]);
    expect(bySeverity(inventoryFindings(paused, map, "pre-handover", { handoverWhilePaused: true }), "paused")).toEqual(["info"]);
    const idl = clean(map);
    idl.idl[0] = probe("asset_registry", { status: "update" });
    idl.idl[1] = probe("transfer_hook", { trimmed: false, extraAuthority: key(160) });
    const findings = inventoryFindings(idl, map, "pre-handover");
    expect(bySeverity(findings, "idl")).toEqual(["blocker", "blocker"]);
    expect(bySeverity(findings, "metadata-authority")).toEqual(["blocker"]);
    expect(bySeverity(inventoryFindings(idl, map, "in-progress"), "idl")).toEqual(["warning", "warning"]);
    const lock = clean(map);
    lock.lockPresent = true;
    expect(bySeverity(inventoryFindings(lock, map, "handed-over"), "lock")).toEqual(["warning"]);
    expect(bySeverity(inventoryFindings(clean(map), { ...map, blocklistAuthority: map.superAdmin }, "in-progress"), "ba-is-sa")).toEqual(["warning"]);
  });

  it("role drift (K10/K14/K19) is reported as warnings", async () => {
    const { map } = await world();
    const inv = clean(map);
    inv.drift.custodyWithoutAdmin.push({ vault: key(170), authority: key(171) });
    inv.drift.rightsWithoutAdmin.push({ issuance: key(172), authority: key(173) });
    inv.drift.saleAuthorityDrift.push({ sale: key(174), authority: key(175), issuerAuthority: key(176) });
    inv.drift.payoutFounderDrift.push({ payoutVault: key(177), founder: key(178), issuerAuthority: null });
    const codes = inventoryFindings(inv, map, "handed-over").map((f) => [f.code, f.severity]);
    expect(codes).toEqual([
      ["k10-custody", "warning"],
      ["k19-rights", "warning"],
      ["k14-sale", "warning"],
      ["k14-payout", "warning"],
    ]);
  });
});

describe("Squads proposals (6.1 rehearsal: failed executions stay Approved)", () => {
  it("an Approved proposal is a gate (cancel it); an Active one a warning; a stale Active one only evidence", async () => {
    const { map } = await world();
    const withOpen = (open: NonNullable<Inventory["squadsProposals"]>["open"]) => {
      const inv = clean(map);
      inv.squadsProposals = { fromIndex: "1", toIndex: "9", open, errors: [] };
      return inv;
    };
    const approved = withOpen([{ transactionIndex: "1", proposal: key(150), status: "Approved", approvals: 2, stale: true }]);
    expect(phases.map((phase) => bySeverity(inventoryFindings(approved, map, phase), "squads-proposal"))).toEqual([["warning"], ["blocker"], ["blocker"]]);
    expect(inventoryFindings(approved, map, "handed-over")[0].message).toBe(
      `Squads proposal #1 ${key(150)} is Approved (2 approvals) and can still be executed: cancel it`,
    );
    const active = withOpen([{ transactionIndex: "2", proposal: key(151), status: "Active", approvals: 1, stale: false }]);
    expect(phases.map((phase) => bySeverity(inventoryFindings(active, map, phase), "squads-proposal"))).toEqual([["warning"], ["warning"], ["warning"]]);
    const staleActive = withOpen([{ transactionIndex: "2", proposal: key(151), status: "Active", approvals: 1, stale: true }]);
    expect(inventoryFindings(staleActive, map, "handed-over")).toEqual([]);
    const broken = clean(map);
    broken.squadsProposals = { fromIndex: "1", toIndex: "1", open: [], errors: ["proposal #1 x: owner is not the Squads v4 program"] };
    expect(bySeverity(inventoryFindings(broken, map, "handed-over"), "squads-proposal")).toEqual(["warning"]);
  });

  it("decodes v4 Proposal accounts (every status) and rejects foreign data", () => {
    for (const status of ["Draft", "Active", "Rejected", "Approved", "Executing", "Executed", "Cancelled"] as const) {
      const value = { multisig: key(160), transactionIndex: BigInt(7), status, approved: [key(161), key(162)], rejected: [], cancelled: [key(163)] };
      expect(decodeProposal(encodeProposal({ ...value, timestamp: BigInt(1_700_000_000) }))).toEqual(value);
    }
    const data = encodeProposal({ multisig: key(160), transactionIndex: BigInt(1), status: "Approved", approved: [], rejected: [], cancelled: [] });
    expect(() => decodeProposal(Uint8Array.of(0, ...data.subarray(1)))).toThrow(/Not a Squads v4 Proposal/);
    expect(() => decodeProposal(data.subarray(0, data.length - 2))).toThrow(/truncated/);
    const badStatus = Uint8Array.from(data);
    badStatus[48] = 9;
    expect(() => decodeProposal(badStatus)).toThrow(/Unknown proposal status/);
  });
});

describe("inventory collection on a live-shaped chain", () => {
  it("collects admins, proposals, transfers (stale flagged), buffers and the Squads decode", async () => {
    const w = await world();
    const dry = await runTool("bootstrap", env(w), bootstrapTool, deps(w));
    const sent = await runTool("bootstrap", sendEnv(w, dry.planDigest as string), bootstrapTool, deps(w));
    expect(sent.error ?? null).toBeNull();
    // A stale transfer, a loader buffer of the deployer and a PM buffer of the bufferWriter.
    const registry = w.map.kyc.registry!;
    w.chain.set(key(180), {
      owner: REGISTRY,
      lamports: rent(137),
      data: new Uint8Array(
        getAuthorityTransferEncoder().encode({ target: registry, currentAuthority: key(181), newAuthority: key(182), proposedBy: key(181), bump: 255 }),
      ),
    });
    const loaderBuffer = new Uint8Array(37 + 4);
    new DataView(loaderBuffer.buffer).setUint32(0, 1, true);
    loaderBuffer[4] = 1;
    loaderBuffer.set(getAddressEncoder().encode(w.keys.deployer), 5);
    w.chain.set(key(183), { owner: LOADER_V3, lamports: rent(41), data: loaderBuffer });
    const pmBuffer = new Uint8Array(PM_HEADER_LENGTH + 4);
    pmBuffer[0] = 1;
    pmBuffer.set(getAddressEncoder().encode(w.keys.bufferWriter), 33);
    w.chain.set(key(184), { owner: PM_PROGRAM, lamports: rent(100), data: pmBuffer });

    const idlSources = resolveIdlSources({ env: {}, config: { network: "devnet" } as never, frontDir: path.join(root, "front") }, null);
    const inv = await collectInventory(rpcFor(w), { map: w.map, release: null, idlSources, lockPresent: false, kycPin: registry, scanBuffers: true });
    expect(inv.admins.map((a) => a.admin).sort()).toEqual([w.keys.deployer, ...w.keys.admins].sort());
    expect(inv.platform).toMatchObject({ admin: w.keys.deployer, proposed: w.keys.superAdmin, pauseFlagsHex: "0x3f" });
    expect(inv.blocklist).toEqual({ authority: w.keys.deployer, proposed: w.keys.blocklistAuthority });
    expect(inv.kycRegistries).toEqual([{ address: registry, authority: w.keys.deployer, entriesCount: "0", proposed: w.keys.kycAuthority }]);
    const kinds = inv.authorityTransfers.map((t) => [t.kind, t.stale]).sort();
    expect(kinds).toEqual([["kyc-registry", false], ["kyc-registry", true], ["platform", false]].sort());
    expect(inv.buffers.loader).toEqual([{ address: key(183), authority: w.keys.deployer, holder: "deployer" }]);
    expect(inv.buffers.pm).toEqual([{ address: key(184), authority: w.keys.bufferWriter, holder: "bufferWriter" }]);
    expect(inv.squads?.ok).toBe(true);
    expect(inv.idl.map((p) => p.status)).toEqual(["init", "init"]);

    const findings = inventoryFindings(inv, w.map, "in-progress");
    expect(findings.find((f) => f.code === "deployer-role")?.severity).toBe("info");
    expect(findings.filter((f) => f.code === "buffer").map((f) => f.severity)).toEqual(["warning", "warning"]);
    expect(findings.find((f) => f.code === "stale-transfer")?.severity).toBe("warning");
  });

  it("lists the multisig's open proposals: Approved (also stale) and Active, not the final ones", async () => {
    const w = await world();
    const current = w.chain.accounts.get(w.keys.multisig)!;
    const decoded = decodeMultisig(current.data);
    const data = encodeMultisig({ ...decoded, transactionIndex: BigInt(5), staleTransactionIndex: BigInt(1) });
    w.chain.set(w.keys.multisig, { ...current, data });
    const statuses = { 1: "Approved", 2: "Executed", 3: "Cancelled", 4: "Active" } as const;
    for (const [index, status] of Object.entries(statuses)) {
      const pda = await squadsProposalPda(w.keys.multisig, BigInt(index));
      const proposal = encodeProposal({ multisig: w.keys.multisig, transactionIndex: BigInt(index), status, approved: [w.keys.members[0]], rejected: [], cancelled: [] });
      w.chain.set(pda, { owner: SQUADS_V4_PROGRAM, lamports: rent(proposal.length), data: proposal });
    }
    // #5 has no Proposal account (never proposed or closed): skipped.
    const idlSources = resolveIdlSources({ env: {}, config: { network: "devnet" } as never, frontDir: path.join(root, "front") }, null);
    const inv = await collectInventory(rpcFor(w), { map: w.map, release: null, idlSources, lockPresent: false, kycPin: null, scanBuffers: false });
    expect(inv.squads?.ok).toBe(true);
    expect(inv.squadsProposals).toEqual({
      fromIndex: "1",
      toIndex: "5",
      errors: [],
      open: [
        { transactionIndex: "1", proposal: await squadsProposalPda(w.keys.multisig, BigInt(1)), status: "Approved", approvals: 1, stale: true },
        { transactionIndex: "4", proposal: await squadsProposalPda(w.keys.multisig, BigInt(4)), status: "Active", approvals: 1, stale: false },
      ],
    });
    const findings = inventoryFindings(inv, w.map, "handed-over").filter((f) => f.code === "squads-proposal");
    expect(findings.map((f) => f.severity)).toEqual(["blocker", "warning"]);
  });

  it("decodes the Squads v4 fixture account and reports its mismatch with the map", async () => {
    const w = await world();
    const fixture = JSON.parse(fs.readFileSync(path.resolve(__dirname, "fixtures/squads-multisig-v4.json"), "utf8"));
    w.chain.set(w.keys.multisig, { owner: SQUADS_V4_PROGRAM, lamports: rent(231), data: new Uint8Array(Buffer.from(fixture.dataBase64, "base64")) });
    const idlSources = resolveIdlSources({ env: {}, config: { network: "devnet" } as never, frontDir: path.join(root, "front") }, null);
    // The real dump's members, all with every permission in the map.
    const members = (fixture.expected.members as { key: Address }[]).map((m) => ({ key: m.key, permissions: ["initiate", "vote", "execute"] }));
    const map = { ...w.map, squads: { ...w.map.squads, members } };
    const inv = await collectInventory(rpcFor(w), { map, release: null, idlSources, lockPresent: false, kycPin: null, scanBuffers: false });
    // Squads stores the members sorted by key: the vote-only member is second.
    expect(inv.squads?.decoded?.members.map((m) => m.permissions.join("+"))).toEqual(["initiate+vote+execute", "vote", "initiate+vote+execute"]);
    expect(inv.squads?.decoded?.threshold).toBe(fixture.expected.threshold);
    // The map gives the vote-only member every permission: a mismatch.
    const findings = inventoryFindings(inv, map, "pre-handover").filter((f) => f.code === "squads");
    expect(findings.map((f) => f.severity)).toEqual(["blocker"]);
    expect(findings[0].message).toMatch(/permissions vote ≠ map initiate\+vote\+execute/);
  });

  it("runs without a role map and warns about a leftover lock; evidence keeps no URL", async () => {
    const w = await world();
    fs.mkdirSync(path.join(w.dir, "state"), { recursive: true });
    fs.writeFileSync(path.join(w.dir, "state", `devnet-${"EtWTRABZ"}.lock`), "{}");
    const { CHAIN_ROLE_MAP: _map, ...noMap } = env(w);
    void _map;
    const output = noMap.CHAIN_OUTPUT!;
    const evidence = await runTool("inventory", noMap, inventoryTool, deps(w));
    expect(evidence.status).toBe("completed");
    const findings = evidence.findings as Finding[];
    expect(findings.find((f) => f.code === "lock")?.severity).toBe("warning");
    expect(findings.filter((f) => f.code === "platform-missing").map((f) => f.severity)).toEqual(["warning"]);
    const written = fs.readFileSync(output, "utf8");
    expect(written).not.toContain("https://");
    expect(written).not.toContain(w.dir);
    expect((evidence as { rpcHost: string }).rpcHost).toBe("rpc.example.test");
    // headCommit alone does not say whether uncommitted code ran (6.1 review): the evidence lists it.
    expect(Array.isArray((evidence as { sourceTreeDirty: unknown }).sourceTreeDirty)).toBe(true);
  });
});
