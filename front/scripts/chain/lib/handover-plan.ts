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
 * super admin last (the accept always closes the outgoing key's Admin record,
 * so a target that keeps that key as an Admin re-grants it at once), then
 * clean up with the new super admin.
 *
 * v1.0.0-rc (D3): an Admin grant is two steps — the super admin proposes
 * (`propose_admin`), the NEW key executes `add_admin` itself after 48 hours
 * and within 14 days — and a super admin rotation is acceptable only 48 hours
 * after its proposal. Any Admin or the upgrade authority can cancel either.
 * So every proposal goes out at T and every execution follows at T+48h (the
 * plan prints each step's `when`, with the chain window of proposals already
 * on chain); the order still never leaves a role without a holder.
 *
 * Roles live only on the chain (lib/server/admin-gate.ts reads the Platform
 * and the Admin records; there is no role table in the database), so the
 * off-chain steps are onboarding, funding and documents.
 */
import fs from "node:fs";
import { isAddress, type Address } from "@solana/kit";
import type { Network } from "@/lib/network";
import { isBootstrapOpen } from "@/lib/pause-flags";
import {
  ADMIN_TIMELOCK_SECONDS,
  PROPOSAL_WINDOW_SECONDS,
  describeProposalWindow,
  proposalWindowState,
  type ProposalWindow,
} from "@/lib/proposal-window";
import { fetchChainTime } from "./accounts";
import type { ToolContext, ToolStatus } from "./context";
import { resolveIdlSources } from "./idl-plan";
import { collectInventory, type Inventory } from "./inventory";
import {
  DEFAULT_ADDRESS,
  ROLE_MAP_SCHEMA,
  checkRoleOverlaps,
  overlapAckRequired,
  roleOverlapsOf,
  secondAdminWarning,
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
  const { acks, acknowledged } = checkRoleOverlaps({
    overlaps,
    acknowledgements: input.acknowledgedRoleOverlaps,
    required: overlapAckRequired(ctx.network),
    errors,
    warnings,
  });
  const noSecondAdmin = secondAdminWarning(overlaps, superAdmin, admins);
  if (noSecondAdmin) warnings.push(noSecondAdmin);
  // The role map rules for the vault and the treasury (D5), so a target file
  // cannot plan what the role map would refuse.
  if (squadsVault && blocklistAuthority === squadsVault) errors.push("blocklistAuthority must not be the Squads vault");
  if (squadsVault && kycAuthority === squadsVault) errors.push("kycAuthority must not be the Squads vault");
  // The vault is the upgrade authority (review finding 6, O-10).
  if (squadsVault && superAdmin === squadsVault) errors.push("superAdmin must not be the Squads vault (it is the upgrade authority: SA == UA)");
  if (squadsVault && admins.includes(squadsVault)) errors.push("admins must not list the Squads vault (it is the upgrade authority: Admin == UA)");
  const treasuryIsRoleKey = overlaps.some((o) => acknowledged.has(o.key) && o.roles.includes("protocolTreasury"));
  if (protocolTreasury !== squadsVault && !treasuryIsRoleKey) {
    const text = `protocolTreasury ${protocolTreasury} is neither the squadsVault nor a role key acknowledged in acknowledgedRoleOverlaps (a mistyped or foreign address would receive every protocol fee)`;
    if (ctx.network === "mainnet") errors.push(text);
    else warnings.push(text);
  }
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
  /**
   * When it can run (v1.0.0-rc D3): "now", "T+48h …" for a step behind a
   * timelock of a proposal this plan makes, or the chain window of a
   * proposal already on chain.
   */
  when: string;
  /** Hours after the plan starts (T) before the step can run, at the earliest. */
  offsetHours: number;
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
/** The Admin-grant and super-admin-rotation timelock (48 h), in hours. */
const TIMELOCK_HOURS = ADMIN_TIMELOCK_SECONDS / 3600;
const WINDOW_DAYS = PROPOSAL_WINDOW_SECONDS / 86_400;
const utc = (unix: bigint) => `${new Date(Number(unix) * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;

/** How a step waits: for a proposal this plan makes (`after`), or a window already on chain. */
type Timelock = { after: string } | { window: ProposalWindow };

/**
 * The ordered plan from the live inventory to `target` (pure). Refuses a
 * chain that was never bootstrapped (chain:bootstrap creates the roles).
 *
 * v1.0.0-rc (D3): every proposal goes out at T (now) and every execution
 * that waits for a timelock follows 48 hours later, so the whole handover
 * takes 48 hours rather than one wait per role: at T the current super admin
 * proposes the Admin grants and the super admin rotation, and the instant
 * roles (KYC, blocklist, treasury, custody to an existing Admin, issuers)
 * move; at T+48h the new keys execute their grants (add_admin), the custody
 * vaults move to the new Admins, and the new super admin accepts last. A
 * grant must execute before that accept, which makes the outgoing super
 * admin's proposals stale (6152). `now` (the chain clock) turns a proposal
 * already on chain into its absolute window.
 */
export function planHandover(inv: Inventory, target: HandoverTarget, options: { site?: string; now?: bigint | null } = {}): HandoverPlan {
  if (!inv.platform) throw new ChainPlanError("The Platform does not exist: bootstrap it first (chain:bootstrap)");
  if (!inv.blocklist) throw new ChainPlanError("The BlocklistAuthority does not exist: bootstrap it first (chain:bootstrap)");
  const registry = inv.kycRegistries.find((r) => r.address === target.kycRegistry);
  if (!registry) throw new ChainPlanError(`The KYC registry ${target.kycRegistry} does not exist on this network`);
  const holdings = inv.holdings ?? { custodyVaults: [], rightsIssuances: [], issuers: [] };
  const site = options.site ?? "the operator front";
  const now = options.now ?? null;
  const pauseFlags = inv.platform.pauseFlags;
  const bootstrapOpen = isBootstrapOpen(pauseFlags);
  const lock = bootstrapOpen ? 0 : TIMELOCK_HOURS;

  const steps: HandoverStep[] = [];
  const done: string[] = [];
  const decisions: string[] = [];
  const warnings: string[] = [];
  let counter = 0;
  const byId = new Map<string, HandoverStep>();
  const add = (step: Omit<HandoverStep, "id" | "notes" | "when" | "offsetHours"> & { notes?: string[]; timelock?: Timelock }): string => {
    const id = `H${++counter}`;
    const { timelock, ...rest } = step;
    const after = Math.max(0, ...rest.requires.map((r) => byId.get(r)?.offsetHours ?? 0));
    let offsetHours = after;
    let when = after === 0 ? "now (T)" : `T+${after}h (after ${rest.requires.filter((r) => (byId.get(r)?.offsetHours ?? 0) === after).join(", ")})`;
    if (timelock && "after" in timelock) {
      offsetHours = Math.max(after, (byId.get(timelock.after)?.offsetHours ?? 0) + lock);
      when = bootstrapOpen
        ? `at once after ${timelock.after} (the bootstrap window is open: the 48 hours are waived)`
        : `T+${offsetHours}h: ${TIMELOCK_HOURS} hours after ${timelock.after} lands, within ${WINDOW_DAYS} days of that`;
    } else if (timelock && "window" in timelock) {
      const state = now === null ? null : proposalWindowState(timelock.window, now, { pauseFlags, bootstrapWaived: true });
      if (state?.kind === "waiting") offsetHours = Math.max(after, Math.ceil(state.remaining / 3600));
      when = state ? `on chain: ${describeProposalWindow(state)}` : `on chain: from ${utc(BigInt(timelock.window.eta))} until ${utc(BigInt(timelock.window.expiresAt))}`;
    }
    const full: HandoverStep = { ...rest, id, notes: rest.notes ?? [], when, offsetHours };
    steps.push(full);
    byId.set(id, full);
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
  /** The outgoing SA stays an Admin in the target (its record is re-granted after the accept). */
  const keepsOldSa = saRotates && target.admins.includes(SA);
  /** A proposal on chain is judged by the chain clock; unknown time: treated as live. */
  const expired = (window: ProposalWindow) => now !== null && proposalWindowState(window, now, { pauseFlags, bootstrapWaived: true }).kind === "expired";

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
        notes: ["Accepting pays only fees; accept_platform_admin and add_admin also pay the new Admin record rent when the key has none, and every accept refunds the proposal account's rent to the proposer."],
      }),
    );
  }

  // ── T: every proposal ──────────────────────────────────────────────────────
  // Admin grants the target needs, proposed by the current super admin; the
  // new key executes its own grant 48 hours later (before the SA accept).
  const liveGrants = new Map<string, NonNullable<Inventory["pendingAdmins"]>[number]>(
    (inv.pendingAdmins ?? []).filter((p) => !p.stale).map((p) => [p.newAdmin, p]),
  );
  const grantKeys = [
    ...(saRotates && !adminKeys.has(target.superAdmin) ? [target.superAdmin] : []),
    ...target.admins.filter((a) => !adminKeys.has(a) && a !== target.superAdmin),
  ];
  const grants: { key: Address; proposeId: string | null; window: ProposalWindow | null }[] = [];
  for (const key of grantKeys) {
    const live = liveGrants.get(key);
    const window = live ? { proposedAt: BigInt(live.eta) - BigInt(ADMIN_TIMELOCK_SECONDS), eta: BigInt(live.eta), expiresAt: BigInt(live.expiresAt) } : null;
    if (live && window && !expired(window)) {
      grants.push({ key, proposeId: null, window });
      continue;
    }
    const why =
      key === target.superAdmin
        ? "The new key can act as an Admin (pause, KYC review, custody) while the current key is still super admin; accept_platform_admin later keeps this record (init_if_needed). Nothing is revoked until the new key has accepted everything."
        : "An Admin record the target keeps.";
    grants.push({
      key,
      window: null,
      proposeId: add({
        phase: "grant",
        title: `propose_admin(${key})`,
        instruction: "propose_admin",
        signer: { role: "superAdmin (current)", key: SA, side: "current" },
        where: "/admin/admins → Propose admin role (Super Admin only)",
        requires: prepare,
        check: `PendingAdmin ["pending_admin", ${key}] exists (chain:inventory pendingAdmins; listed under Pending admin grants)`,
        notes: [
          why,
          ...(live ? [`The grant staged earlier expired (${utc(BigInt(live.expiresAt))}): this proposes it again and restarts its 48 hours.`] : []),
          "Any Admin, the super admin or the upgrade authority can cancel it inside its window.",
        ],
      }),
    });
  }

  // The super admin rotation starts its 48 hours now too; it is accepted last.
  const platformProposal = inv.authorityTransfers.find((t) => t.kind === "platform" && !t.stale);
  const platformWindow: ProposalWindow | null =
    platformProposal?.eta && platformProposal.expiresAt
      ? { proposedAt: BigInt(platformProposal.eta) - BigInt(ADMIN_TIMELOCK_SECONDS), eta: BigInt(platformProposal.eta), expiresAt: BigInt(platformProposal.expiresAt) }
      : null;
  let saProposeId: string | null = null;
  const saProposalLive = inv.platform.proposed === target.superAdmin && !(platformWindow && expired(platformWindow));
  if (saRotates && !saProposalLive) {
    saProposeId = add({
      phase: "super-admin",
      title: `propose_platform_admin(${target.superAdmin})`,
      instruction: "propose_platform_admin",
      signer: { role: "superAdmin (current)", key: SA, side: "current" },
      where: "/account/roles → Your operational authorities → Change Super Admin → Propose replacement (also on /admin/platform)",
      requires: prepare,
      check: `platform admin proposal names ${target.superAdmin} (chain:inventory authorityTransfers, kind platform, with its eta)`,
      notes: [
        `Proposed at T so its ${TIMELOCK_HOURS} hours run while the grants wait and the other roles move; accept_platform_admin comes last (T+${lock}h at the earliest, within ${WINDOW_DAYS} days).`,
        ...(inv.platform.proposed
          ? [`This overwrites the pending proposal to ${inv.platform.proposed}${inv.platform.proposed === target.superAdmin ? " (expired)" : ""} and restarts its 48-hour wait (any Admin or the upgrade authority can also cancel it).`]
          : []),
      ],
    });
  }
  if (!saRotates) done.push(`superAdmin: ${SA}`);

  // Moves that need no timelock (T): KYC, blocklist, treasury, issuers, and
  // custody vaults whose successor already holds an Admin record.
  const move: string[] = [];
  const custodySuccessor = target.custodySuccessor;
  const successorGrant = grants.find((g) => g.key === custodySuccessor);
  const custodyMoves = holdings.custodyVaults.filter((vault) => LIVE_VAULT_STATES.has(vault.state) && !targetAdmins.has(vault.authority));
  const planCustody = (requires: string[]) => {
    for (const vault of custodyMoves) {
      const pending = inv.authorityTransfers.find((t) => t.kind === "custody" && t.target === vault.address && !t.stale);
      let proposeId: string | null = null;
      if (pending?.newAuthority !== custodySuccessor) {
        proposeId = add({
          phase: "move",
          title: `propose_custody_authority(${vault.address} → ${custodySuccessor})`,
          instruction: "propose_custody_authority",
          signer: { role: "superAdmin (current)", key: SA, side: "current" },
          where: "/admin/custody → the vault's Custody operator panel → Propose operator",
          requires,
          check: `custody transfer of ${vault.address} names ${custodySuccessor}`,
          notes: [`The vault (${vault.state}) is operated by ${vault.authority}, which leaves; the successor needs an Admin record (propose and accept both check it).`],
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
          requires: proposeId ? [proposeId] : requires,
          check: `CustodyVault ${vault.address}.authority == ${custodySuccessor}`,
          notes: [],
        }),
      );
    }
  };
  // The successor's Admin record comes from this plan's grant: custody moves at T+48h, after it.
  if (!successorGrant) planCustody(prepare);

  // KYC registry authority: the registry address, bitmaps and passports stay.
  if (current.kycAuthority === target.kycAuthority) done.push(`kyc.authority: ${current.kycAuthority}`);
  else {
    let proposeId: string | null = null;
    const requires = [...prepare];
    if (registry.proposed && registry.proposed !== target.kycAuthority) {
      requires.push(
        add({
          phase: "move",
          title: `cancel_kyc_registry_authority_transfer (pending to ${registry.proposed})`,
          instruction: "cancel_kyc_registry_authority_transfer",
          signer: { role: "kyc.authority (current)", key: current.kycAuthority, side: "current" },
          where: "/admin/kyc → Registry authority and jurisdictions → Cancel the pending authority transfer",
          requires: prepare,
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
        notes: ["No timelock: acceptable at once, for 14 days."],
      });
    }
    move.push(
      ...requires.filter((id) => !prepare.includes(id)),
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
        requires: prepare,
        check: `BlocklistAuthorityProposal names ${target.blocklistAuthority}`,
        notes: [
          "No timelock: acceptable at once, for 14 days.",
          ...(inv.blocklist.proposed ? [`This overwrites the pending proposal to ${inv.blocklist.proposed} (the blocklist authority can also cancel it).`] : []),
        ],
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
        requires: proposeId ? [proposeId] : prepare,
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
        requires: prepare,
        check: `Platform.protocolTreasury == ${target.protocolTreasury}`,
        notes: ["Read live: the next routed yield pays the new treasury. The treasury never signs. No timelock (an accepted risk, design 8.3 §0)."],
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
      requires: prepare,
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

  // ── T+48h: the grants execute, then the super admin accepts ─────────────────
  const executions: string[] = [];
  for (const grant of grants) {
    executions.push(
      add({
        phase: "grant",
        title: `add_admin(${grant.key})`,
        instruction: "add_admin",
        signer: { role: "new Admin", key: grant.key, side: "new" },
        where: "/account/roles → Waiting for your acceptance → Admin",
        requires: grant.proposeId ? [grant.proposeId] : prepare,
        check: `Admin record ["admin", ${grant.key}] exists (chain:inventory admins)`,
        notes: [
          "The new key signs and pays its Admin record. It must execute while the proposing super admin still holds the platform: accept_platform_admin makes the proposal stale (6152).",
        ],
        timelock: grant.proposeId ? { after: grant.proposeId } : { window: grant.window! },
      }),
    );
  }
  // Custody vaults whose successor gets its Admin record from this plan.
  if (successorGrant) planCustody(executions.filter((id) => byId.get(id)!.title === `add_admin(${custodySuccessor})`));

  // Pending issuer recoveries staged by the current SA go stale when it rotates (K10).
  for (const recovery of inv.issuerRecoveries.filter((r) => saRotates && r.proposedBy === SA)) {
    decisions.push(
      `Issuer recovery ${recovery.address} (issuer ${recovery.issuer}) was proposed by the current super admin and goes stale when it rotates: execute or cancel it first, or the new super admin proposes it again (another 7-day wait).`,
    );
  }
  for (const transfer of inv.authorityTransfers.filter((t) => saRotates && t.kind === "custody" && !t.stale && t.proposedBy === SA && t.newAuthority !== custodySuccessor)) {
    decisions.push(`Custody proposal ${transfer.address} (to ${transfer.newAuthority}) goes stale when the super admin rotates: accept it first or re-propose it afterwards.`);
  }
  // Rights issuances cannot move (K19): publish_milestone needs its creator's Admin record.
  for (const issuance of holdings.rightsIssuances.filter((r) => outgoingSet.has(r.authority))) {
    decisions.push(
      `Rights issuance ${issuance.address} was opened by the outgoing key ${issuance.authority} and has no rotation (K19): publish its outstanding milestones before that key loses its Admin record, or keep that key in the target's admins until the issuance is finished (for the outgoing super admin the plan then re-grants its record right after accept_platform_admin).`,
    );
  }
  // A recovery by the upgrade authority refuses the accepts until it ends.
  if (inv.recoveries?.platform && !inv.recoveries.platform.stale && saRotates) {
    decisions.push(
      `A super admin recovery to ${inv.recoveries.platform.newAuthority} by the upgrade authority is pending (${inv.recoveries.platform.address}): accept_platform_admin is refused (6155) until the super admin or the upgrade authority cancels it, or it is executed.`,
    );
  }
  if (inv.recoveries?.blocklist && !inv.recoveries.blocklist.stale && current.blocklistAuthority !== target.blocklistAuthority) {
    decisions.push(
      `A blocklist authority recovery to ${inv.recoveries.blocklist.newAuthority} by the upgrade authority is pending (${inv.recoveries.blocklist.address}): accept_blocklist_authority is refused (hook 6020) until the blocklist authority or the upgrade authority cancels it, or it is executed.`,
    );
  }

  if (keepsOldSa) {
    const gap = [
      ...holdings.custodyVaults.filter((v) => v.authority === SA && LIVE_VAULT_STATES.has(v.state)).map((v) => `custody vault ${v.address}`),
      ...holdings.rightsIssuances.filter((r) => r.authority === SA).map((r) => `rights issuance ${r.address}`),
    ];
    if (gap.length) {
      decisions.push(
        `${SA} stays an Admin in the target, but accept_platform_admin closes its Admin record until the new super admin re-grants it (propose_admin right after the accept, add_admin ${TIMELOCK_HOURS} hours later): ${gap.join(", ")} cannot be operated in between. Move the custody vaults first (propose/accept custody authority to another Admin) to avoid the gap.`,
      );
    }
  }

  // Super admin last: the current SA keeps every repair tool until here.
  const superAdmin: string[] = [];
  if (saRotates) {
    const acceptId = add({
      phase: "super-admin",
      title: `accept_platform_admin (${target.superAdmin})`,
      instruction: "accept_platform_admin",
      signer: { role: "superAdmin (new)", key: target.superAdmin, side: "new" },
      where: "/account/roles → Waiting for your acceptance → Super Admin (read the checklist in the dialog), or /issuer/authority",
      requires: [...(saProposeId ? [saProposeId] : prepare), ...executions, ...move],
      check: `Platform.admin == ${target.superAdmin}; the Admin record of ${SA} is closed`,
      notes: [
        `Closes the Admin record of ${SA} and keeps (or creates) the new key's. From here only ${target.superAdmin} clears pause bits, grants and removes Admins, decides KYB and sets the treasury.`,
        `Last: every add_admin above lands first (the accept makes the grants of ${SA} stale, 6152), and every move. Refused while a recovery by the upgrade authority is pending (6155).`,
      ],
      timelock: saProposeId ? { after: saProposeId } : platformWindow ? { window: platformWindow } : undefined,
    });
    superAdmin.push(...(saProposeId ? [saProposeId] : []), acceptId);
    // The accept always closes the outgoing SA's Admin record; a target that
    // keeps that key as an Admin gets the record back from the new SA.
    if (keepsOldSa) {
      const vaults = holdings.custodyVaults.filter((v) => v.authority === SA && LIVE_VAULT_STATES.has(v.state)).map((v) => v.address);
      const issuances = holdings.rightsIssuances.filter((r) => r.authority === SA).map((r) => r.address);
      const issuers = holdings.issuers.filter((i) => i.authority === SA).map((i) => i.address);
      const reproposeId = add({
        phase: "super-admin",
        title: `propose_admin(${SA})`,
        instruction: "propose_admin",
        signer: { role: "superAdmin (new)", key: target.superAdmin, side: "new" },
        where: "/admin/admins → Propose admin role (Super Admin only)",
        requires: [acceptId],
        check: `PendingAdmin ["pending_admin", ${SA}] exists`,
        notes: [
          `accept_platform_admin closed the Admin record of ${SA}, which the target keeps as an Admin: propose it again right after the accept. Until its add_admin lands (${TIMELOCK_HOURS} hours later) ${SA} cannot pause or act as an Admin.`,
          ...(vaults.length ? [`Until then the custody vaults it operates cannot be triggered, realized or returned (K10): ${vaults.join(", ")}.`] : []),
          ...(issuances.length ? [`Until then publish_milestone is refused for the rights issuances it opened (K19): ${issuances.join(", ")}.`] : []),
          ...(issuers.length ? [`Until then its issuer actions that rest on its Admin record fail for: ${issuers.join(", ")}.`] : []),
        ],
      });
      superAdmin.push(
        reproposeId,
        add({
          phase: "super-admin",
          title: `add_admin(${SA})`,
          instruction: "add_admin",
          signer: { role: "outgoing superAdmin (kept as Admin)", key: SA, side: "current" },
          where: "/account/roles → Waiting for your acceptance → Admin",
          requires: [reproposeId],
          check: `Admin record ["admin", ${SA}] exists again (chain:inventory admins)`,
          notes: ["The kept key signs its own grant."],
          timelock: { after: reproposeId },
        }),
      );
    }
  }

  // Cleanup: the new super admin removes Admin records the target does not
  // keep, and withdraws every grant that must not execute.
  const after = [...prepare, ...grants.flatMap((g) => (g.proposeId ? [g.proposeId] : [])), ...executions, ...move, ...superAdmin];
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
  // Grants no step of this plan executes: stale ones (an earlier super
  // admin's, K1.10) and live ones for keys outside the target. Any pending
  // grant blocks the pre-handover inventory.
  const planned = new Set<string>(grants.map((g) => g.key));
  for (const pending of inv.pendingAdmins ?? []) {
    if (planned.has(pending.newAdmin) && !pending.stale) continue;
    cleanup.push(
      add({
        phase: "cleanup",
        title: `cancel_admin_proposal(${pending.newAdmin})`,
        instruction: "cancel_admin_proposal",
        signer: { role: "superAdmin (target), any Admin or the upgrade authority", key: newSa, side: saRotates ? "new" : "current" },
        where: "/admin/admins → Pending admin grants → Cancel (the upgrade authority: chain:squads-export registry-ix cancel_admin_proposal)",
        requires: after,
        check: `no PendingAdmin for ${pending.newAdmin}`,
        notes: [
          pending.stale
            ? `Proposed by ${pending.proposedBy}, an earlier super admin: it can no longer execute, but a return of that key to the super admin role would revive it (K1.10).`
            : `A live grant (proposed by ${pending.proposedBy}) for a key the target does not keep.`,
          "The rent returns to the proposer.",
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
    check: "the plan is empty; the inventory shows the target keys and no pending grant, proposal or recovery",
    notes: [
      outgoing.length
        ? `Outgoing keys keep no platform role: ${outgoing.join(", ")}. Keep them offline until nothing refers to them (issuers, rights issuances, open approvals), then retire them.`
        : "No key leaves the platform roles.",
    ],
  });

  if (!saRotates && !steps.some((s) => s.instruction)) warnings.push("Nothing on-chain to do: every role already has its target key.");
  const total = Math.max(0, ...steps.map((s) => s.offsetHours));
  if (steps.some((s) => s.instruction)) {
    warnings.push(
      bootstrapOpen
        ? "The bootstrap window (bit 7) is still open: the 48-hour timelocks are waived, so the plan runs at once; the super admin closes it right after the rotation (set_pause_flags(0, 0x80))"
        : total === 0
          ? "Timeline: no step waits for a timelock; every step can run now"
          : `Timeline: the proposals go out at T; the timelocked executions (Admin grants, the super admin accept) follow ${TIMELOCK_HOURS} hours after their proposal, each within ${WINDOW_DAYS} days; the whole handover takes about ${total} hours (v1.0.0-rc D3)`,
    );
  }
  const overlaps = roleOverlapsOf({
    superAdmin: target.superAdmin,
    admins: target.admins,
    blocklistAuthority: target.blocklistAuthority,
    kyc: { authority: target.kycAuthority },
    protocolTreasury: target.protocolTreasury,
    squads: { vault: target.squadsVault ?? (DEFAULT_ADDRESS as Address), members: [] },
  });
  for (const overlap of overlaps) warnings.push(`the target gives ${overlap.key} ${overlap.roles.join(" + ")} (see the role-overlap consequences)`);
  // Review finding 6 / O-10: the upgrade authority holds no operational role.
  for (const p of inv.programs) {
    const ua = p.upgradeAuthority;
    if (!ua) continue;
    const roles = [
      ...(target.superAdmin === ua ? ["super admin"] : []),
      ...(target.blocklistAuthority === ua ? ["blocklist authority"] : []),
      ...(target.admins.includes(ua) ? ["Admin"] : []),
    ];
    if (roles.length) warnings.push(`the target makes ${ua}, the ${p.name} upgrade authority, the ${roles.join(" and ")}: chain:inventory blocks it (the upgrade authority's veto and recovery must stay separate)`);
  }
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
    lines.push(`  - when: ${step.when}`);
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
    pendingAdmins: inv.pendingAdmins ?? [],
    recoveries: inv.recoveries ?? null,
  };

  ctx.phase = "plan";
  const now = await fetchChainTime(ctx.rpc);
  evidence.chainTime = now === null ? null : now.toString();
  const plan = planHandover(inv, target, { site: ctx.env.CHAIN_SITE_ORIGIN?.trim() || undefined, now });
  evidence.plan = plan;
  for (const d of plan.done) ctx.log(`done      ${d}`);
  for (const d of plan.decisions) ctx.log(`DECIDE    ${d}`);
  for (const w of plan.warnings) ctx.log(`warning   ${w}`);
  for (const step of plan.steps) {
    const who = step.signer.side === "off-chain" ? "off-chain" : `${step.signer.side.padEnd(7)} ${step.signer.key}`;
    ctx.log(`${step.id.padEnd(4)} ${step.phase.padEnd(11)} ${who}  ${step.title}`);
    ctx.log(`     when:  ${step.when}`);
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
