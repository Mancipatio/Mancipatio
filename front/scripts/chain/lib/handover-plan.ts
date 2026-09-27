/**
 * Tool 7: `chain:handover` (Talas 8.2). A read-only plan for moving live
 * operational roles to new keys, e.g. from the owner's personal wallet to the
 * company wallet on devnet, or later from the company wallet to separate
 * Ledgers on mainnet. Never builds or sends a transaction.
 *
 * It reads who holds each role now (the inventory collector at finalized)
 * and the target (CHAIN_ROLE_MAP: a `mancipatio-handover-target-v1` file, or
 * a role map v2), and prints an ORDERED list of steps: which instruction,
 * who signs (the current holder or the new key), where (the operator-front
 * page and control, or a CLI export), what must be done first and what
 * proves the step landed. The order never leaves a role without a holder:
 * grant the new Admin first, move the KYC, blocklist, custody and treasury
 * roles while the current super admin still holds everything, rotate the
 * super admin last, then clean up with the new super admin.
 *
 * Roles live only on the chain (lib/server/admin-gate.ts reads the Platform
 * and the Admin records; there is no role table in the database), so the
 * off-chain steps are onboarding, funding and documents.
 */
import fs from "node:fs";
import { isAddress, type Address } from "@solana/kit";
import type { Network } from "@/lib/network";
import type { ToolContext, ToolStatus } from "./context";
import { resolveIdlSources } from "./idl-plan";
import { collectInventory, type Inventory } from "./inventory";
import {
  DEFAULT_ADDRESS,
  ROLE_MAP_SCHEMA,
  checkRoleOverlaps,
  roleOverlapsOf,
  validateRoleMap,
  type RoleMapContext,
  type RoleOverlapAck,
} from "./role-map";
import { ChainGateError, ChainPlanError, assertOutputPath, sha256Hex } from "./safety";

export const HANDOVER_TARGET_SCHEMA = "mancipatio-handover-target-v1";

export type HandoverTarget = {
  source: "handover-target" | "role-map";
  network: Network;
  /** The KYC registry to rotate (the pinned NEXT_PUBLIC_KYC_REGISTRY). */
  kycRegistry: Address;
  superAdmin: Address;
  /** Admin records the target keeps besides the super admin's. */
  admins: Address[];
  blocklistAuthority: Address;
  kycAuthority: Address;
  protocolTreasury: Address;
  /** The Squads vault, when there is one: a treasury equal to it is no role key. */
  squadsVault: Address | null;
  /** Who takes over custody vaults of outgoing keys (needs an Admin record). */
  custodySuccessor: Address;
  /** Who takes over issuers of outgoing keys; null: the owner decides per issuer. */
  issuerSuccessor: Address | null;
  acknowledgedRoleOverlaps: RoleOverlapAck[];
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Validates a handover target file (or converts a role map v2). */
export async function validateHandoverTarget(input: unknown, ctx: RoleMapContext): Promise<{ target: HandoverTarget; warnings: string[] }> {
  if (!isObj(input)) throw new ChainGateError("Handover target: not a JSON object");
  if (input.schema === ROLE_MAP_SCHEMA) {
    const { map, warnings } = await validateRoleMap(input, ctx);
    return {
      target: {
        source: "role-map",
        network: map.network,
        kycRegistry: map.kyc.registry!,
        superAdmin: map.superAdmin,
        admins: map.admins,
        blocklistAuthority: map.blocklistAuthority,
        kycAuthority: map.kyc.authority,
        protocolTreasury: map.protocolTreasury,
        squadsVault: map.squads.vault,
        custodySuccessor: map.superAdmin,
        issuerSuccessor: null,
        acknowledgedRoleOverlaps: map.acknowledgedRoleOverlaps,
      },
      warnings,
    };
  }
  const errors: string[] = [];
  const warnings: string[] = [];
  const addr = (value: unknown, label: string): Address => {
    if (typeof value !== "string" || !isAddress(value) || value === DEFAULT_ADDRESS) {
      errors.push(`${label} is not a valid address`);
      return DEFAULT_ADDRESS as Address;
    }
    return value;
  };
  if (input.schema !== HANDOVER_TARGET_SCHEMA) errors.push(`schema must be ${HANDOVER_TARGET_SCHEMA} or ${ROLE_MAP_SCHEMA}`);
  if (input.network !== ctx.network) errors.push(`network must be ${ctx.network}`);
  if (input.genesisHash !== ctx.genesis) errors.push("genesisHash does not match the pinned genesis");
  const superAdmin = addr(input.superAdmin, "superAdmin");
  const admins: Address[] = [];
  if (!Array.isArray(input.admins)) errors.push("admins must be an array (the Admin records to keep besides the super admin)");
  else input.admins.forEach((value, i) => admins.push(addr(value, `admins[${i}]`)));
  if (new Set(admins).size !== admins.length) errors.push("admins has duplicates");
  if (admins.includes(superAdmin)) errors.push("admins must not list the superAdmin (accept_platform_admin creates its Admin record)");
  const blocklistAuthority = addr(input.blocklistAuthority, "blocklistAuthority");
  const kycAuthority = addr(input.kycAuthority, "kycAuthority");
  const kycRegistry = addr(input.kycRegistry, "kycRegistry");
  const protocolTreasury = addr(input.protocolTreasury, "protocolTreasury");
  const squadsVault = input.squadsVault === undefined || input.squadsVault === null ? null : addr(input.squadsVault, "squadsVault");
  const custodySuccessor = input.custodySuccessor === undefined ? superAdmin : addr(input.custodySuccessor, "custodySuccessor");
  if (custodySuccessor !== superAdmin && !admins.includes(custodySuccessor)) {
    errors.push("custodySuccessor must be the superAdmin or one of admins (a custody operator needs an Admin record)");
  }
  const issuerSuccessor = input.issuerSuccessor === undefined || input.issuerSuccessor === null ? null : addr(input.issuerSuccessor, "issuerSuccessor");
  const overlaps = roleOverlapsOf({
    superAdmin,
    admins,
    blocklistAuthority,
    kyc: { authority: kycAuthority },
    protocolTreasury,
    squads: { vault: squadsVault ?? (DEFAULT_ADDRESS as Address), members: [] },
  });
  const { acks } = checkRoleOverlaps({ overlaps, acknowledgements: input.acknowledgedRoleOverlaps, mainnet: ctx.network === "mainnet", errors, warnings });
  if (errors.length) throw new ChainGateError(`Handover target rejected: ${errors.join("; ")}`);
  return {
    target: {
      source: "handover-target",
      network: ctx.network,
      kycRegistry,
      superAdmin,
      admins,
      blocklistAuthority,
      kycAuthority,
      protocolTreasury,
      squadsVault,
      custodySuccessor,
      issuerSuccessor,
      acknowledgedRoleOverlaps: acks,
    },
    warnings,
  };
}

// ── Plan ─────────────────────────────────────────────────────────────────────

export type HandoverPhase = "prepare" | "grant" | "move" | "super-admin" | "cleanup";

export type HandoverStep = {
  id: string;
  phase: HandoverPhase;
  title: string;
  /** The on-chain instruction; null for an off-chain step. */
  instruction: string | null;
  /** Who signs: the role's current holder, the new key, or nobody (off-chain). */
  signer: { role: string; key: Address | null; side: "current" | "new" | "off-chain" };
  /** The operator-front page and control, or a CLI command. */
  where: string;
  /** Step ids (and states) that must be done first. */
  requires: string[];
  /** What proves the step landed. */
  check: string;
  notes: string[];
};

export type HandoverPlan = {
  steps: HandoverStep[];
  /** Roles already held by their target key. */
  done: string[];
  /** Questions the owner answers before the step they guard. */
  decisions: string[];
  warnings: string[];
  /** Keys that hold a platform role now and none in the target. */
  outgoing: Address[];
};

const LIVE_VAULT_STATES = new Set(["Active", "Triggered"]);

/**
 * The ordered plan from the live inventory to `target` (pure). Refuses a
 * chain that was never bootstrapped (chain:bootstrap creates the roles).
 */
export function planHandover(inv: Inventory, target: HandoverTarget, options: { site?: string } = {}): HandoverPlan {
  if (!inv.platform) throw new ChainPlanError("The Platform does not exist: bootstrap it first (chain:bootstrap)");
  if (!inv.blocklist) throw new ChainPlanError("The BlocklistAuthority does not exist: bootstrap it first (chain:bootstrap)");
  const registry = inv.kycRegistries.find((r) => r.address === target.kycRegistry);
  if (!registry) throw new ChainPlanError(`The KYC registry ${target.kycRegistry} does not exist on this network`);
  const holdings = inv.holdings ?? { custodyVaults: [], rightsIssuances: [], issuers: [] };
  const site = options.site ?? "the operator front";

  const steps: HandoverStep[] = [];
  const done: string[] = [];
  const decisions: string[] = [];
  const warnings: string[] = [];
  let counter = 0;
  const add = (step: Omit<HandoverStep, "id" | "notes"> & { notes?: string[] }): string => {
    const id = `H${++counter}`;
    steps.push({ ...step, id, notes: step.notes ?? [] });
    return id;
  };

  const current = {
    superAdmin: inv.platform.admin,
    blocklistAuthority: inv.blocklist.authority,
    kycAuthority: registry.authority,
    treasury: inv.platform.protocolTreasury,
  };
  const adminKeys = new Set<string>(inv.admins.map((a) => a.admin));
  const targetAdmins = new Set<string>([target.superAdmin, ...target.admins]);
  const targetKeys = new Set<string>([...targetAdmins, target.blocklistAuthority, target.kycAuthority, target.protocolTreasury]);
  const holders = new Set<string>([current.superAdmin, current.blocklistAuthority, current.kycAuthority, ...adminKeys]);
  const outgoing = [...holders].filter((key) => !targetKeys.has(key)) as Address[];
  const saRotates = current.superAdmin !== target.superAdmin;
  const SA = current.superAdmin;

  // Prepare: every key that will accept or sign must be able to use the front.
  const newKeys = [
    ...new Set<Address>([
      ...(saRotates ? [target.superAdmin] : []),
      ...(current.blocklistAuthority !== target.blocklistAuthority ? [target.blocklistAuthority] : []),
      ...(current.kycAuthority !== target.kycAuthority ? [target.kycAuthority] : []),
      ...target.admins.filter((a) => !adminKeys.has(a)),
    ]),
  ];
  const prepare: string[] = [];
  if (newKeys.length) {
    prepare.push(
      add({
        phase: "prepare",
        title: `Onboard ${newKeys.join(", ")} on ${site}`,
        instruction: null,
        signer: { role: "new key", key: null, side: "off-chain" },
        where: `${site}: connect the wallet, sign in (SIWS) and accept the Terms, so it is the PRIMARY wallet of its own account (signer matrix G1); it must not be a secondary wallet of another account`,
        requires: [],
        check: "/account/roles opens for the wallet and shows its (empty) roles",
        notes: ["Maintenance must be off: it refuses every browser transaction, including the accepts below."],
      }),
    );
    prepare.push(
      add({
        phase: "prepare",
        title: `Fund ${newKeys.join(", ")} with about 0.05 SOL each`,
        instruction: null,
        signer: { role: "funder", key: null, side: "off-chain" },
        where: "any wallet (a plain SOL transfer)",
        requires: [],
        check: "the balance shows on the explorer",
        notes: ["Accepting pays only fees; accept_platform_admin also pays the new Admin record rent when the key has none, and every accept refunds the proposal account's rent to the acceptor."],
      }),
    );
  }

  // Grant: Admin records the target needs, while the current SA still signs.
  const grant: string[] = [];
  const grantAdmin = (key: Address, why: string) =>
    grant.push(
      add({
        phase: "grant",
        title: `add_admin(${key})`,
        instruction: "add_admin",
        signer: { role: "superAdmin (current)", key: SA, side: "current" },
        where: "/admin/admins → Grant (Super Admin only)",
        requires: prepare,
        check: `Admin record ["admin", ${key}] exists (chain:inventory admins)`,
        notes: [why],
      }),
    );
  if (saRotates && !adminKeys.has(target.superAdmin)) {
    grantAdmin(
      target.superAdmin,
      "The new key can act as an Admin (pause, KYC review, custody) while the current key is still super admin; accept_platform_admin later keeps this record (init_if_needed). Nothing is revoked until the new key has accepted everything.",
    );
  }
  for (const admin of target.admins) if (!adminKeys.has(admin) && admin !== target.superAdmin) grantAdmin(admin, "An Admin record the target keeps.");
  if (!saRotates) done.push(`superAdmin: ${SA}`);

  // Move: roles the current holders hand over one by one.
  const move: string[] = [];
  const beforeMove = [...prepare, ...grant];

  // Custody vaults whose operator leaves (K10): the SA proposes, the successor accepts.
  const custodySuccessor = target.custodySuccessor;
  for (const vault of holdings.custodyVaults) {
    if (!LIVE_VAULT_STATES.has(vault.state) || targetAdmins.has(vault.authority)) continue;
    const pending = inv.authorityTransfers.find((t) => t.kind === "custody" && t.target === vault.address && !t.stale);
    let proposeId: string | null = null;
    if (pending?.newAuthority !== custodySuccessor) {
      proposeId = add({
        phase: "move",
        title: `propose_custody_authority(${vault.address} → ${custodySuccessor})`,
        instruction: "propose_custody_authority",
        signer: { role: "superAdmin (current)", key: SA, side: "current" },
        where: "/admin/custody → the vault's Custody operator panel → Propose operator",
        requires: beforeMove,
        check: `custody transfer of ${vault.address} names ${custodySuccessor}`,
        notes: [`The vault (${vault.state}) is operated by ${vault.authority}, which leaves; the successor needs an Admin record.`],
      });
    }
    move.push(
      ...(proposeId ? [proposeId] : []),
      add({
        phase: "move",
        title: `accept_custody_authority(${vault.address})`,
        instruction: "accept_custody_authority",
        signer: { role: "custody successor (new)", key: custodySuccessor, side: "new" },
        where: "/account/roles → Waiting for your acceptance → Custody operator (or /admin/custody)",
        requires: proposeId ? [proposeId] : beforeMove,
        check: `CustodyVault ${vault.address}.authority == ${custodySuccessor}`,
        notes: [],
      }),
    );
  }

  // KYC registry authority: the registry address, bitmaps and passports stay.
  if (current.kycAuthority === target.kycAuthority) done.push(`kyc.authority: ${current.kycAuthority}`);
  else {
    let proposeId: string | null = null;
    const requires = [...beforeMove];
    if (registry.proposed && registry.proposed !== target.kycAuthority) {
      requires.push(
        add({
          phase: "move",
          title: `cancel_kyc_registry_authority_transfer (pending to ${registry.proposed})`,
          instruction: "cancel_kyc_registry_authority_transfer",
          signer: { role: "kyc.authority (current)", key: current.kycAuthority, side: "current" },
          where: "/admin/kyc → Registry authority and jurisdictions → Cancel the pending authority transfer",
          requires: beforeMove,
          check: `no pending KYC registry proposal for ${registry.address}`,
          notes: [],
        }),
      );
    }
    if (registry.proposed !== target.kycAuthority) {
      proposeId = add({
        phase: "move",
        title: `propose_kyc_registry_authority(${target.kycAuthority})`,
        instruction: "propose_kyc_registry_authority",
        signer: { role: "kyc.authority (current)", key: current.kycAuthority, side: "current" },
        where: "/admin/kyc → Registry authority and jurisdictions → Propose a new KYC registry authority",
        requires,
        check: `KYC registry ${registry.address} proposal names ${target.kycAuthority}`,
        notes: [],
      });
    }
    move.push(
      ...requires.filter((id) => !beforeMove.includes(id)),
      ...(proposeId ? [proposeId] : []),
      add({
        phase: "move",
        title: `accept_kyc_registry_authority (${target.kycAuthority})`,
        instruction: "accept_kyc_registry_authority",
        signer: { role: "kyc.authority (new)", key: target.kycAuthority, side: "new" },
        where: "/account/roles → Waiting for your acceptance → KYC provider (registry authority); not /admin/kyc, which the key cannot open before it accepts",
        requires: proposeId ? [proposeId] : requires,
        check: `KycRegistry ${registry.address}.authority == ${target.kycAuthority}`,
        notes: [
          "The registry address, its jurisdiction bitmaps and every passport stay: NEXT_PUBLIC_KYC_REGISTRY does not change.",
          "The KYC authority pays the rent of every new passport (about 0.00126 SOL each at 5080 lamports per byte): keep the new key funded.",
        ],
      }),
    );
  }

  // Blocklist authority: only the current BA can propose a successor.
  if (current.blocklistAuthority === target.blocklistAuthority) done.push(`blocklistAuthority: ${current.blocklistAuthority}`);
  else {
    let proposeId: string | null = null;
    if (inv.blocklist.proposed !== target.blocklistAuthority) {
      proposeId = add({
        phase: "move",
        title: `propose_blocklist_authority(${target.blocklistAuthority})`,
        instruction: "propose_blocklist_authority",
        signer: { role: "blocklistAuthority (current)", key: current.blocklistAuthority, side: "current" },
        where: "/account/roles → Your operational authorities → Change blocklist authority → Propose replacement (also on /admin/platform)",
        requires: beforeMove,
        check: `BlocklistAuthorityTransfer names ${target.blocklistAuthority}`,
        notes: inv.blocklist.proposed ? [`This overwrites the pending proposal to ${inv.blocklist.proposed} (blocklist proposals cannot be cancelled).`] : [],
      });
    }
    move.push(
      ...(proposeId ? [proposeId] : []),
      add({
        phase: "move",
        title: `accept_blocklist_authority (${target.blocklistAuthority})`,
        instruction: "accept_blocklist_authority",
        signer: { role: "blocklistAuthority (new)", key: target.blocklistAuthority, side: "new" },
        where: "/account/roles → Waiting for your acceptance → Blocklist authority",
        requires: proposeId ? [proposeId] : beforeMove,
        check: `BlocklistAuthority.authority == ${target.blocklistAuthority}`,
        notes: ["From here the out-of-band blocklist and hook-mode path is chain:emergency with this key."],
      }),
    );
  }

  // Treasury: the current SA sets it before it hands over the platform.
  if (current.treasury === target.protocolTreasury) done.push(`protocolTreasury: ${current.treasury}`);
  else {
    move.push(
      add({
        phase: "move",
        title: `set_protocol_treasury(${target.protocolTreasury})`,
        instruction: "set_protocol_treasury",
        signer: { role: "superAdmin (current)", key: SA, side: "current" },
        where: "/admin/platform → Protocol treasury → Rotate treasury",
        requires: beforeMove,
        check: `Platform.protocolTreasury == ${target.protocolTreasury}`,
        notes: ["Read live: the next routed yield pays the new treasury. The treasury never signs."],
      }),
    );
  }

  // Issuers of outgoing keys (issuer keys are the issuer's own; K18).
  const outgoingSet = new Set<string>(outgoing);
  for (const issuer of holdings.issuers.filter((i) => outgoingSet.has(i.authority))) {
    if (!target.issuerSuccessor) {
      decisions.push(
        `Issuer ${issuer.address} (KYB ${issuer.kybStatus}) is held by the outgoing key ${issuer.authority}: rotate it on /issuer/rotation (current key proposes, the successor accepts on /account/roles), or keep that key as its issuer key. Set issuerSuccessor in the target to plan it.`,
      );
      continue;
    }
    const successorIsAdmin = targetAdmins.has(target.issuerSuccessor);
    const proposeId = add({
      phase: "move",
      title: `propose_issuer_authority(${issuer.address} → ${target.issuerSuccessor})`,
      instruction: "propose_issuer_authority",
      signer: { role: "issuer (current)", key: issuer.authority, side: "current" },
      where: "/issuer/rotation → Authority key → Propose",
      requires: beforeMove,
      check: `issuer transfer of ${issuer.address} names ${target.issuerSuccessor}`,
      notes: [],
    });
    move.push(
      proposeId,
      add({
        phase: "move",
        title: `accept_issuer_authority(${issuer.address})`,
        instruction: "accept_issuer_authority",
        signer: { role: "issuer (new)", key: target.issuerSuccessor, side: "new" },
        where: "/account/roles → Waiting for your acceptance → Issuer key",
        requires: [proposeId],
        check: `Issuer ${issuer.address}.authority == ${target.issuerSuccessor}; sales and payout vaults sync on their next flow (sync_sale_authority / sync_payout_founder)`,
        notes: successorIsAdmin
          ? [`The successor is an Admin key: the program accepts that only while the outgoing key ${issuer.authority} still has its Admin record, so this must land BEFORE the super admin rotation (and before any remove_admin of that key). A dedicated issuer key is the recommended successor (OD13).`]
          : [],
      }),
    );
  }

  // Rights issuances cannot move (K19): publish_milestone needs its creator's Admin record.
  for (const issuance of holdings.rightsIssuances.filter((r) => outgoingSet.has(r.authority))) {
    decisions.push(
      `Rights issuance ${issuance.address} was opened by the outgoing key ${issuance.authority} and has no rotation (K19): publish its outstanding milestones before that key loses its Admin record, or keep an Admin record for it (the new super admin re-grants it with add_admin) until the issuance is finished.`,
    );
  }
  // Pending issuer recoveries staged by the current SA go stale when it rotates (K10).
  for (const recovery of inv.issuerRecoveries.filter((r) => saRotates && r.proposedBy === SA)) {
    decisions.push(
      `Issuer recovery ${recovery.address} (issuer ${recovery.issuer}) was proposed by the current super admin and goes stale when it rotates: execute or cancel it first, or the new super admin proposes it again (another 7-day wait).`,
    );
  }
  for (const transfer of inv.authorityTransfers.filter((t) => saRotates && t.kind === "custody" && !t.stale && t.proposedBy === SA && t.newAuthority !== custodySuccessor)) {
    decisions.push(`Custody proposal ${transfer.address} (to ${transfer.newAuthority}) goes stale when the super admin rotates: accept it first or re-propose it afterwards.`);
  }

  // Super admin last: the current SA keeps every repair tool until here.
  const superAdmin: string[] = [];
  if (saRotates) {
    let proposeId: string | null = null;
    if (inv.platform.proposed !== target.superAdmin) {
      proposeId = add({
        phase: "super-admin",
        title: `propose_platform_admin(${target.superAdmin})`,
        instruction: "propose_platform_admin",
        signer: { role: "superAdmin (current)", key: SA, side: "current" },
        where: "/account/roles → Your operational authorities → Change Super Admin → Propose replacement (also on /admin/platform)",
        requires: [...beforeMove, ...move],
        check: `platform admin proposal names ${target.superAdmin}`,
        notes: inv.platform.proposed ? [`This overwrites the pending proposal to ${inv.platform.proposed} (platform proposals cannot be cancelled).`] : [],
      });
      superAdmin.push(proposeId);
    }
    superAdmin.push(
      add({
        phase: "super-admin",
        title: `accept_platform_admin (${target.superAdmin})`,
        instruction: "accept_platform_admin",
        signer: { role: "superAdmin (new)", key: target.superAdmin, side: "new" },
        where: "/account/roles → Waiting for your acceptance → Super Admin (read the checklist in the dialog), or /issuer/authority",
        requires: proposeId ? [proposeId] : [...beforeMove, ...move],
        check: `Platform.admin == ${target.superAdmin}; the Admin record of ${SA} is closed`,
        notes: [
          `Closes the Admin record of ${SA} and keeps (or creates) the new key's. From here only ${target.superAdmin} clears pause bits, grants and removes Admins, decides KYB and sets the treasury.`,
          "If the deployed program has the Talas 8.3 timelock for super-admin rotation, the accept waits for it: re-run this plan.",
        ],
      }),
    );
  }

  // Cleanup: the new super admin removes Admin records the target does not keep.
  const after = [...beforeMove, ...move, ...superAdmin];
  const newSa = target.superAdmin;
  const cleanup: string[] = [];
  for (const record of inv.admins) {
    if (targetAdmins.has(record.admin) || (saRotates && record.admin === SA)) continue;
    const holdsRights = holdings.rightsIssuances.some((r) => r.authority === record.admin);
    const operatesCustody = holdings.custodyVaults.some((v) => v.authority === record.admin && LIVE_VAULT_STATES.has(v.state));
    cleanup.push(
      add({
        phase: "cleanup",
        title: `remove_admin(${record.admin})`,
        instruction: "remove_admin",
        signer: { role: "superAdmin (target)", key: newSa, side: saRotates ? "new" : "current" },
        where: "/admin/admins → Revoke (Super Admin only)",
        requires: after,
        check: `no Admin record for ${record.admin}`,
        notes: [
          "Not in the target's admins. Skip this step to keep the record.",
          "Sale approvals it granted stay valid after the removal: review them on /admin/applications and revoke those you do not stand behind (revoke_sale_approval).",
          ...(holdsRights ? ["It opened a rights issuance: removing its Admin record blocks publish_milestone for good (K19)."] : []),
          ...(operatesCustody ? ["It still operates a live custody vault: move the vault first (propose/accept custody authority)."] : []),
        ],
      }),
    );
  }
  add({
    phase: "cleanup",
    title: "Verify and record",
    instruction: null,
    signer: { role: "operator", key: null, side: "off-chain" },
    where: "npm run chain:handover (expect no steps) and npm run chain:inventory; update the signer matrix and the on-call list",
    requires: [...after, ...cleanup],
    check: "the plan is empty; the inventory shows the target keys",
    notes: [
      outgoing.length
        ? `Outgoing keys keep no platform role: ${outgoing.join(", ")}. Keep them offline until nothing refers to them (issuers, rights issuances, open approvals), then retire them.`
        : "No key leaves the platform roles.",
    ],
  });

  if (!saRotates && !steps.some((s) => s.instruction)) warnings.push("Nothing on-chain to do: every role already has its target key.");
  const overlaps = roleOverlapsOf({
    superAdmin: target.superAdmin,
    admins: target.admins,
    blocklistAuthority: target.blocklistAuthority,
    kyc: { authority: target.kycAuthority },
    protocolTreasury: target.protocolTreasury,
    squads: { vault: target.squadsVault ?? (DEFAULT_ADDRESS as Address), members: [] },
  });
  for (const overlap of overlaps) warnings.push(`the target gives ${overlap.key} ${overlap.roles.join(" + ")} (see the role-overlap consequences)`);
  return { steps, done, decisions, warnings, outgoing };
}

/** The plan as a Markdown checklist (written next to the evidence). */
export function handoverMarkdown(plan: HandoverPlan, meta: { network: string; generatedUtc: string; targetSha256: string }): string {
  const lines = [
    `# Role handover plan (${meta.network})`,
    "",
    `Generated ${meta.generatedUtc} by \`npm run chain:handover\` (target sha256 ${meta.targetSha256}). Read-only: nothing was sent.`,
    "",
  ];
  if (plan.done.length) lines.push("Already at the target:", "", ...plan.done.map((d) => `- ${d}`), "");
  if (plan.decisions.length) lines.push("## Decide first", "", ...plan.decisions.map((d) => `- [ ] ${d}`), "");
  if (plan.warnings.length) lines.push("## Warnings", "", ...plan.warnings.map((w) => `- ${w}`), "");
  lines.push("## Steps (in order)", "");
  for (const step of plan.steps) {
    lines.push(`- [ ] **${step.id} (${step.phase})** ${step.title}`);
    lines.push(`  - signs: ${step.signer.side === "off-chain" ? "off-chain" : `${step.signer.role} ${step.signer.key}`}`);
    lines.push(`  - where: ${step.where}`);
    if (step.requires.length) lines.push(`  - after: ${step.requires.join(", ")}`);
    lines.push(`  - check: ${step.check}`);
    for (const note of step.notes) lines.push(`  - note: ${note}`);
  }
  return `${lines.join("\n")}\n`;
}

// ── Tool ─────────────────────────────────────────────────────────────────────

export async function handoverTool(ctx: ToolContext): Promise<ToolStatus> {
  const { config, evidence } = ctx;
  ctx.phase = "inputs";
  let raw: Buffer;
  try {
    raw = fs.readFileSync(config.roleMapPath!);
  } catch {
    throw new ChainGateError("CHAIN_ROLE_MAP is unreadable (path withheld)");
  }
  let json: unknown;
  try {
    json = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new ChainGateError("CHAIN_ROLE_MAP is not valid JSON");
  }
  const { target, warnings } = await validateHandoverTarget(json, { network: config.network, genesis: config.expectedGenesis });
  const targetSha256 = sha256Hex(raw);
  evidence.targetSha256 = targetSha256;
  evidence.target = target;
  for (const warning of warnings) ctx.log(`warning: ${warning}`);
  const markdownPath = `${config.output}.md`;
  assertOutputPath(markdownPath, ctx.root, "the plan file");

  ctx.phase = "collect";
  const idlSources = resolveIdlSources(ctx, null, { prefer: "head", inventory: true });
  const inv = await collectInventory(ctx.rpc, { map: null, release: null, idlSources, lockPresent: false, kycPin: target.kycRegistry, scanBuffers: false });
  evidence.current = {
    platform: inv.platform,
    blocklist: inv.blocklist,
    kycRegistry: inv.kycRegistries.find((r) => r.address === target.kycRegistry) ?? null,
    admins: inv.admins,
    upgradeAuthorities: inv.programs.map((p) => ({ program: p.name, upgradeAuthority: p.upgradeAuthority })),
    holdings: inv.holdings,
    authorityTransfers: inv.authorityTransfers,
    issuerRecoveries: inv.issuerRecoveries,
  };

  ctx.phase = "plan";
  const plan = planHandover(inv, target, { site: ctx.env.CHAIN_SITE_ORIGIN?.trim() || undefined });
  evidence.plan = plan;
  for (const d of plan.done) ctx.log(`done      ${d}`);
  for (const d of plan.decisions) ctx.log(`DECIDE    ${d}`);
  for (const w of plan.warnings) ctx.log(`warning   ${w}`);
  for (const step of plan.steps) {
    const who = step.signer.side === "off-chain" ? "off-chain" : `${step.signer.side.padEnd(7)} ${step.signer.key}`;
    ctx.log(`${step.id.padEnd(4)} ${step.phase.padEnd(11)} ${who}  ${step.title}`);
    ctx.log(`     where: ${step.where}`);
    if (step.requires.length) ctx.log(`     after: ${step.requires.join(", ")}`);
    ctx.log(`     check: ${step.check}`);
  }
  for (const p of inv.programs) ctx.log(`info: ${p.name} upgrade authority ${p.upgradeAuthority ?? "none"} (not part of a role handover)`);
  fs.writeFileSync(markdownPath, handoverMarkdown(plan, { network: config.network, generatedUtc: new Date().toISOString(), targetSha256 }), { flag: "wx", mode: 0o600 });
  evidence.planFile = markdownPath.split("/").pop();
  ctx.log(`plan: ${evidence.planFile} (${plan.steps.length} steps, read-only)`);
  return plan.steps.some((s) => s.instruction) ? "awaiting" : "completed";
}
