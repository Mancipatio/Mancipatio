/**
 * Tool 1: bootstrap (`chain:bootstrap`), design-3.3 §4.
 *
 * probeBootstrapState reads everything at finalized; planBootstrap turns the
 * state and the role map into the reviewed steps of the current cycle. Every
 * instruction is built offline (PDA-deterministic builders); the only read is
 * `requireProgramUpgradeAuthority`, which checks the existing ProgramData.
 *
 * Steps: S1 initialize_platform, S1b set_protocol_treasury, S2
 * initialize_blocklist_authority(deployer), S2b propose BA, S3 propose_admin
 * (not the SA) and A3 add_admin (the NEW admin key signs), S3k/A3k the temp
 * KYC admin, S4 create_kyc_registry, S4c jurisdictions, S4b propose KYC,
 * X3/X2/X1 Ledger accepts (external, or rehearsal signers off mainnet), S3r
 * remove the temp grant, S5 propose SA, S5c close the bootstrap window, S6
 * unpause, S7 ProgramData SetAuthority → vault.
 *
 * The steps a role key signs itself (A3, X3, X2, X1, S5c, S6) are external
 * here: the operator front runs them, or `chain:accept` with that key's
 * Ledger (planRoleStep below plans one of them from these same definitions).
 *
 * v1.0.0-rc (design 8.3 §5.4, §6): a fresh Platform is 0xFF — every pause
 * bit plus the one-way bootstrap marker (bit 7). While bit 7 is set the 48 h
 * timelocks of `add_admin` and `accept_platform_admin` are waived, and ANY
 * clear of a pause bit closes it for good. So every Admin grant executes and
 * the super admin rotation lands (X1) before the first unpause; right after
 * X1 the final super admin closes the window explicitly (S5c), and S6 then
 * clears only `map.unpauseMask` (never the payout modules, 0x40). The first
 * unpause (S6, or S6d where the deployer is the super admin) waits for every
 * role step (design 8.3 §5.4, K1.3).
 *
 * Every proposal has a window of chain time (lib/proposal-window.ts): the
 * probe reads the Clock sysvar, so a grant or a super admin rotation proposed
 * while the window is closed shows as waiting with its eta (48 hours), and an
 * expired proposal is proposed again instead of being accepted into a 6151.
 */
import {
  createNoopSigner,
  type Address,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";
import {
  ADMIN_DISCRIMINATOR,
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  AUTHORITY_PROPOSAL_DISCRIMINATOR,
  KYC_REGISTRY_DISCRIMINATOR,
  PENDING_ADMIN_DISCRIMINATOR,
  findAcceptPlatformAdminTransferPda,
  findAdminRecordPda,
  findPendingAdminPda,
  getAcceptPlatformAdminInstructionAsync,
  getAddAdminInstructionAsync,
  getAdminDecoder,
  getAdminSize,
  getAuthorityProposalDecoder,
  getAuthorityProposalSize,
  getCancelAdminProposalInstructionAsync,
  getKycRegistryDecoder,
  getKycRegistrySize,
  getPendingAdminDecoder,
  getPendingAdminSize,
  getPlatformSize,
  getProposeAdminInstructionAsync,
  getProposePlatformAdminInstructionAsync,
  getRemoveAdminInstructionAsync,
  getSetPauseFlagsInstructionAsync,
  getSetProtocolTreasuryInstructionAsync,
  fetchMaybePlatform,
  findPlatformPda,
} from "@/lib/generated/asset_registry";
import {
  BLOCKLIST_AUTHORITY_PROPOSAL_DISCRIMINATOR,
  TRANSFER_HOOK_PROGRAM_ADDRESS,
  findTransferPda,
  getAcceptBlocklistAuthorityInstructionAsync,
  getBlocklistAuthorityProposalDecoder,
  getBlocklistAuthorityProposalSize,
  getBlocklistAuthoritySize,
  getProposeBlocklistAuthorityInstructionAsync,
} from "@/lib/generated/transfer_hook";
import { loadOperationalAuthority } from "@/lib/operational-authority";
import {
  buildAcceptKycAuthority,
  buildCancelKycAuthorityTransfer,
  buildCreateRegistry,
  buildProposeKycAuthority,
  buildUpdateRegistryJurisdictions,
  findKycRegistryTransferPda,
  jurisdictionBitmap,
} from "@/lib/passport";
import {
  CLOSE_BOOTSTRAP_MASKS,
  PAUSE_FLAGS_ALL,
  PLATFORM_BOOTSTRAP_OPEN,
  formatPauseFlags,
  isBootstrapOpen,
} from "@/lib/pause-flags";
import {
  buildInitializeBlocklistAuthorityInstruction,
  buildInitializePlatformInstruction,
} from "@/lib/program-bootstrap";
import {
  ADMIN_TIMELOCK_SECONDS,
  PROPOSAL_WINDOW_SECONDS,
  describeProposalWindow,
  proposalWindowState,
  type ProposalWindow,
} from "@/lib/proposal-window";
import { fetchChainTime, fetchRawAccount, fetchRawAccounts, hasDiscriminator } from "./accounts";
import type { ToolContext, ToolStatus } from "./context";
import { PROGRAM_IDS, idlProbeEvidence, probeIdl, resolveIdlSources } from "./idl-plan";
import { collectInventory, inventoryFindings, lockIsPresent } from "./inventory";
import {
  comparePayload,
  decodeProgramAccount,
  decodeProgramData,
  programDataAddress,
  setUpgradeAuthorityInstruction,
} from "./loader-v3";
import { loadRelease, releaseEvidence, type Release } from "./release";
import { loadRoleMap, type RoleMap } from "./role-map";
import type { ChainRpc } from "./rpc";
import {
  ChainGateError,
  ChainPlanError,
  IDL_PROGRAMS,
  assertReleaseSource,
  loadHotSigner,
  readLocalIdl,
  type ProgramName,
  type RehearsalRole,
} from "./safety";
import {
  buildMessage,
  executePlan,
  planDigest,
  simulateUnsigned,
  summarizeSimulation,
  type PlanStep,
  type Precondition,
  type StepRecord,
} from "./tx";

// ── State ────────────────────────────────────────────────────────────────────

export type BootstrapState = {
  deployed: Record<ProgramName, boolean>;
  ua: Record<ProgramName, Address | null>;
  platform: { admin: Address; protocolTreasury: Address; protocolFeeBps: number; pauseFlags: number } | null;
  platformProposed: Address | null;
  blocklist: { authority: Address; proposed: Address | null } | null;
  /** Admin record presence by wallet (the deployer, SA, admins[], kyc.authority). */
  adminRecords: Record<string, boolean>;
  /**
   * A staged Admin grant (`PendingAdmin`) naming the wallet, proposed by the
   * live platform admin (only those can execute), by wallet as above.
   */
  pendingAdmins: Record<string, boolean>;
  registry: { authority: Address; approved: Uint8Array; blocked: Uint8Array } | null;
  /** A pending, acceptable KYC registry proposal. */
  registryProposed: Address | null;
  balance: bigint;
  /** Chain time (Clock sysvar, finalized) the windows are judged by; null when unreadable. */
  now: bigint | null;
  /** The window of each staged grant in `pendingAdmins` (raw eta: the bootstrap waiver is applied when judged). */
  pendingAdminWindows: Record<string, ProposalWindow | null>;
  /** The windows of the staged super admin rotation, BA and KYC proposals (null: none, or unknown). */
  platformWindow: ProposalWindow | null;
  blocklistWindow: ProposalWindow | null;
  registryWindow: ProposalWindow | null;
  /** A recovery by the program upgrade authority is pending: X1 / X3 are refused (6155 / hook 6020). */
  recoveryPending: { platform: boolean; blocklist: boolean };
};

export function cloneState(state: BootstrapState): BootstrapState {
  return {
    deployed: { ...state.deployed },
    ua: { ...state.ua },
    platform: state.platform ? { ...state.platform } : null,
    platformProposed: state.platformProposed,
    blocklist: state.blocklist ? { ...state.blocklist } : null,
    adminRecords: { ...state.adminRecords },
    pendingAdmins: { ...state.pendingAdmins },
    registry: state.registry ? { ...state.registry } : null,
    registryProposed: state.registryProposed,
    balance: state.balance,
    now: state.now,
    pendingAdminWindows: { ...state.pendingAdminWindows },
    platformWindow: state.platformWindow,
    blocklistWindow: state.blocklistWindow,
    registryWindow: state.registryWindow,
    recoveryPending: { ...state.recoveryPending },
  };
}

/** The window a proposal staged now gets (the program's own arithmetic), or null without chain time. */
function stagedWindow(p: BootstrapState, timelockSeconds: number): ProposalWindow | null {
  if (p.now === null) return null;
  return {
    proposedAt: p.now,
    eta: p.now + BigInt(timelockSeconds),
    expiresAt: p.now + BigInt(timelockSeconds + PROPOSAL_WINDOW_SECONDS),
  };
}

/**
 * "waiting" | "open" | "expired" for a proposal window at the plan's chain
 * time, or "unknown" (no window or no clock). `bootstrapWaived`: the 48 h the
 * program waives while bit 7 is open (admin grants and the SA rotation).
 */
export function windowKind(p: BootstrapState, window: ProposalWindow | null, bootstrapWaived: boolean) {
  if (!window || p.now === null) return "unknown" as const;
  return proposalWindowState(window, p.now, { pauseFlags: p.platform?.pauseFlags ?? 0, bootstrapWaived }).kind;
}

/** Why an execute / accept cannot run yet (its timelock, or an expired proposal), or null. */
function windowBlocker(p: BootstrapState, window: ProposalWindow | null, bootstrapWaived: boolean, proposeId: string): string | null {
  if (!window || p.now === null) return null;
  const state = proposalWindowState(window, p.now, { pauseFlags: p.platform?.pauseFlags ?? 0, bootstrapWaived });
  if (state.kind === "waiting") return `timelock (48 hours after ${proposeId}; the bootstrap window is closed): ${describeProposalWindow(state)}`;
  if (state.kind === "expired") return `the proposal ${describeProposalWindow(state).toLowerCase()} ${proposeId} proposes it again`;
  return null;
}

function publicWrap<T>(fn: () => Promise<T>): Promise<T> {
  return fn().catch((error: unknown) => {
    const message = (error as Error)?.message ?? "";
    // A stale proposal (retired by an executed recovery) is reported, not
    // thrown (lib/operational-authority.ts): the plan treats it as none, and
    // the next propose overwrites it. Only a foreign one is fatal.
    if (/authority proposal is invalid|Unexpected (platform|blocklist authority) owner/.test(message)) {
      throw new ChainPlanError(message);
    }
    throw error;
  });
}

/** Finalized probe of every account the plan depends on (design §4.2). */
export async function probeBootstrapState(rpc: ChainRpc, map: RoleMap): Promise<BootstrapState> {
  const deployed = {} as Record<ProgramName, boolean>;
  const ua = {} as Record<ProgramName, Address | null>;
  const programDatas = await Promise.all(IDL_PROGRAMS.map((name) => programDataAddress(PROGRAM_IDS[name])));
  const light = await fetchRawAccounts(
    rpc,
    [...IDL_PROGRAMS.map((name) => PROGRAM_IDS[name]), ...programDatas],
    { offset: 0, length: 45 },
  );
  IDL_PROGRAMS.forEach((name, i) => {
    const program = light.get(PROGRAM_IDS[name]);
    const data = light.get(programDatas[i]);
    const link = program ? decodeProgramAccount(program.data) : null;
    const decoded = data ? decodeProgramData(data.data) : null;
    deployed[name] = Boolean(program?.executable && link?.programData === programDatas[i] && decoded);
    ua[name] = decoded?.upgradeAuthority ?? null;
  });

  const platformAuthority = await publicWrap(() => loadOperationalAuthority(rpc, "platform"));
  const blocklistAuthority = await publicWrap(() => loadOperationalAuthority(rpc, "blocklist"));
  let platform: BootstrapState["platform"] = null;
  if (platformAuthority) {
    const [platformAddress] = await findPlatformPda();
    const account = await fetchMaybePlatform(rpc, platformAddress, { commitment: "finalized" });
    if (account.exists) {
      platform = {
        admin: account.data.admin,
        protocolTreasury: account.data.protocolTreasury,
        protocolFeeBps: account.data.protocolFeeBps,
        pauseFlags: account.data.pauseFlags,
      };
    }
  }

  const wallets = [...new Set([map.deployer, map.superAdmin, ...map.admins, map.kyc.authority])];
  const records = await Promise.all(wallets.map(async (wallet) => (await findAdminRecordPda({ authority: wallet }))[0]));
  const pendings = await Promise.all(wallets.map(async (wallet) => (await findPendingAdminPda({ newAdmin: wallet }))[0]));
  const registry = map.kyc.registry!;
  const transferPda = await findKycRegistryTransferPda(registry);
  const [platformPda] = await findPlatformPda();
  const [platformTransferPda] = await findAcceptPlatformAdminTransferPda({ platform: platformPda });
  const [blocklistTransferPda] = await findTransferPda();
  const accounts = await fetchRawAccounts(rpc, [...records, ...pendings, registry, transferPda, platformTransferPda, blocklistTransferPda]);
  const adminRecords: Record<string, boolean> = {};
  const pendingAdmins: Record<string, boolean> = {};
  const pendingAdminWindows: Record<string, ProposalWindow | null> = {};
  wallets.forEach((wallet, i) => {
    const account = accounts.get(records[i]);
    adminRecords[wallet] = Boolean(
      account &&
        account.owner === ASSET_REGISTRY_PROGRAM_ADDRESS &&
        hasDiscriminator(account.data, ADMIN_DISCRIMINATOR) &&
        getAdminDecoder().decode(account.data).admin === wallet,
    );
    const pending = accounts.get(pendings[i]);
    const value =
      pending && platform && pending.owner === ASSET_REGISTRY_PROGRAM_ADDRESS && hasDiscriminator(pending.data, PENDING_ADMIN_DISCRIMINATOR)
        ? getPendingAdminDecoder().decode(pending.data)
        : null;
    pendingAdmins[wallet] = Boolean(value && platform && value.newAdmin === wallet && value.proposedBy === platform.admin);
    pendingAdminWindows[wallet] = value && pendingAdmins[wallet] ? { proposedAt: value.proposedAt, eta: value.eta, expiresAt: value.expiresAt } : null;
  });
  let registryState: BootstrapState["registry"] = null;
  const registryAccount = accounts.get(registry);
  if (registryAccount) {
    if (registryAccount.owner !== ASSET_REGISTRY_PROGRAM_ADDRESS || !hasDiscriminator(registryAccount.data, KYC_REGISTRY_DISCRIMINATOR)) {
      throw new ChainPlanError(`The KYC registry address ${registry} holds a foreign account`);
    }
    const decoded = getKycRegistryDecoder().decode(registryAccount.data);
    registryState = {
      authority: decoded.authority,
      approved: new Uint8Array(decoded.approvedJurisdictions),
      blocked: new Uint8Array(decoded.blockedJurisdictions),
    };
  }
  let registryProposed: Address | null = null;
  let registryWindow: ProposalWindow | null = null;
  const transfer = accounts.get(transferPda);
  if (registryState && transfer && transfer.owner === ASSET_REGISTRY_PROGRAM_ADDRESS && hasDiscriminator(transfer.data, AUTHORITY_PROPOSAL_DISCRIMINATOR)) {
    const value = getAuthorityProposalDecoder().decode(transfer.data);
    if (value.target === registry && value.currentAuthority === registryState.authority && value.proposedBy === registryState.authority) {
      registryProposed = value.newAuthority;
      registryWindow = { proposedAt: value.proposedAt, eta: value.eta, expiresAt: value.expiresAt };
    }
  }
  // The raw windows of the live SA and BA proposals (loadOperationalAuthority
  // already refused a foreign one; a stale one — retired by a recovery — is
  // no proposal for the plan: S5 / S4b propose over it).
  const platformProposed = platformAuthority && !platformAuthority.stale ? platformAuthority.proposed : null;
  const blocklistProposed = blocklistAuthority && !blocklistAuthority.stale ? blocklistAuthority.proposed : null;
  let platformWindow: ProposalWindow | null = null;
  const platformTransfer = accounts.get(platformTransferPda);
  if (platformProposed && platformTransfer && hasDiscriminator(platformTransfer.data, AUTHORITY_PROPOSAL_DISCRIMINATOR)) {
    const value = getAuthorityProposalDecoder().decode(platformTransfer.data);
    platformWindow = { proposedAt: value.proposedAt, eta: value.eta, expiresAt: value.expiresAt };
  }
  let blocklistWindow: ProposalWindow | null = null;
  const blocklistTransfer = accounts.get(blocklistTransferPda);
  if (
    blocklistProposed &&
    blocklistTransfer &&
    blocklistTransfer.owner === TRANSFER_HOOK_PROGRAM_ADDRESS &&
    hasDiscriminator(blocklistTransfer.data, BLOCKLIST_AUTHORITY_PROPOSAL_DISCRIMINATOR)
  ) {
    const value = getBlocklistAuthorityProposalDecoder().decode(blocklistTransfer.data);
    blocklistWindow = { proposedAt: value.proposedAt, eta: value.proposedAt, expiresAt: value.expiresAt };
  }
  const now = await fetchChainTime(rpc);
  const balance = await rpc.getBalance(map.deployer, { commitment: "finalized" }).send();
  return {
    deployed,
    ua,
    platform,
    platformProposed,
    blocklist: blocklistAuthority ? { authority: blocklistAuthority.current, proposed: blocklistProposed } : null,
    adminRecords,
    pendingAdmins,
    registry: registryState,
    registryProposed,
    balance: balance.value,
    now,
    pendingAdminWindows,
    platformWindow,
    blocklistWindow,
    registryWindow,
    recoveryPending: {
      platform: Boolean(platformAuthority?.recoveryPending),
      blocklist: Boolean(blocklistAuthority?.recoveryPending),
    },
  };
}

// ── Plan ─────────────────────────────────────────────────────────────────────

export type BootstrapSigners = {
  deployer: TransactionSigner;
  /** Off mainnet: the role keys, to run their accepts here (`admin`: the first role-map admin). */
  rehearsal: Partial<Record<RehearsalRole, TransactionSigner>>;
};

export type ExternalAction = { id: string; role: string; key: Address; page: string; action: string };

export type BootstrapPlan = {
  steps: PlanStep<BootstrapState>[];
  skipped: { id: string; reason: string }[];
  awaiting: ExternalAction[];
  blocked: { id: string; reason: string }[];
  stops: string[];
  notes: string[];
  handover: { planned: boolean; reason: string | null };
  /** Lamports the deployer needs for the planned steps (rent + fees). */
  deployerNeed: bigint;
};

export type HandoverOptions = {
  requested: boolean;
  confirmVault: string | null;
  whilePaused: boolean;
  /** Blockers of a live `pre-handover` inventory; null when it was not run. */
  inventoryBlockers: number | null;
};

export type PlanOptions = {
  rpc: ChainRpc;
  handover: HandoverOptions;
  rent?: (size: number) => Promise<bigint>;
  cuPrice?: bigint | null;
};

type Outcome = "included" | "skipped" | "awaiting" | "blocked" | "stopped";

type StepDef = {
  id: string;
  title: string;
  applies: boolean;
  signerRole: string;
  /** null: nobody can sign it here (external). */
  signer: TransactionSigner | null;
  skip: (p: BootstrapState) => string | null;
  stop?: (p: BootstrapState) => string | null;
  /** Steps that must have landed (or be planned before it) first. */
  waitsFor?: string[];
  /** Its proposal's window (timelock, expiry) or a pending recovery refuses it for now. */
  timelock?: (p: BootstrapState) => string | null;
  preconditions: (p: BootstrapState) => Precondition<BootstrapState>[];
  external?: ExternalAction;
  build: (p: BootstrapState, signer: TransactionSigner) => Promise<Instruction[]>;
  apply: (p: BootstrapState) => void;
  postCheck: (s: BootstrapState) => boolean;
  /** Accounts the step creates (for the balance estimate). */
  rentSizes?: number[];
};

const pre = (label: string, holds: (s: BootstrapState) => boolean): Precondition<BootstrapState> => ({ label, holds });

/** "waits for A3:…, X1" while a step it waits for neither landed nor is planned before it, else null. */
function waitingOn(ids: string[] | undefined, done: Map<string, Outcome>): string | null {
  const open = (ids ?? []).filter((id) => done.has(id) && done.get(id) !== "included" && done.get(id) !== "skipped");
  return open.length ? `waits for ${open.join(", ")}` : null;
}
const bitmapsEqual = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));
export const SIGNATURE_FEE = BigInt(5000);
export const FEE_MARGIN = BigInt(10_000_000);

/** Builds the ordered step definitions for one map and signer set. */
function stepDefinitions(map: RoleMap, signers: BootstrapSigners, rpc: ChainRpc): StepDef[] {
  const D = map.deployer;
  const SA = map.superAdmin;
  const BA = map.blocklistAuthority;
  const K = map.kyc.authority;
  const T = map.protocolTreasury;
  const registry = map.kyc.registry!;
  const d = signers.deployer;
  const saSigner = SA === D ? d : signers.rehearsal.superAdmin ?? null;
  const approved = jurisdictionBitmap(map.kyc.approvedJurisdictions);
  const blocked = jurisdictionBitmap(map.kyc.blockedJurisdictions);
  const deployerIsSa = D === SA;
  const unpauseByDeployer = map.unpauseBy === "deployer" || deployerIsSa;
  const unpauseMask = map.unpauseMask;
  /** The rehearsal signer holding `key` (a role key; `admin` is the first role-map admin), or null. */
  const signerFor = (key: Address): TransactionSigner | null =>
    Object.values(signers.rehearsal).find((signer) => signer?.address === key) ?? null;
  const grants = map.admins.flatMap((a) => [`S3:${a}`, `A3:${a}`]);
  const tempGrant = map.kyc.tempAdminGrant ? ["S3k", "A3k"] : [];
  const cycleOne = ["S1", "S1b", "S2", "S2b", ...grants, ...tempGrant, "S4", "S4c", "S4b.cancel", "S4b"];
  /** Every Admin grant executes while the bootstrap window is open (before any unpause and X1). */
  const executions = [...map.admins.map((a) => `A3:${a}`), ...(map.kyc.tempAdminGrant ? ["A3k"] : [])];
  /** Every role step but the super admin rotation: none may follow the first unpause (§5.4). */
  const roleSteps = [...grants, ...tempGrant, "X3", "X2", ...(map.kyc.tempAdminGrant ? ["S3r", "S3r.cancel"] : [])];
  /** propose_admin (the platform admin) then add_admin (the new key itself signs). */
  const grantSteps = (id: string, admin: Address, label: string, executor: TransactionSigner | null): StepDef[] => [
    {
      id: `S3${id}`,
      title: `propose_admin(${admin})${label}`,
      applies: true,
      signerRole: "deployer",
      signer: d,
      // An expired grant is proposed again (propose_admin overwrites it and restarts the clock).
      skip: (p) =>
        p.adminRecords[admin]
          ? "Admin record exists"
          : p.pendingAdmins[admin] && windowKind(p, p.pendingAdminWindows[admin], true) !== "expired"
            ? "Admin grant already proposed"
            : null,
      preconditions: () => [
        pre(`platform.admin=${D}`, (s) => s.platform?.admin === D),
        pre(`admin(${admin}):absent`, (s) => !s.adminRecords[admin]),
        pre(`pendingAdmin(${admin}):absent-or-expired`, (s) => !s.pendingAdmins[admin] || windowKind(s, s.pendingAdminWindows[admin], true) === "expired"),
      ],
      external: { id: `S3${id}`, role: "superAdmin", key: SA, page: "/admin/admins", action: `propose the Admin role for ${admin} (Propose admin role)` },
      build: async (_p, signer) => [await getProposeAdminInstructionAsync({ superAdmin: signer, newAdmin: admin })],
      apply: (p) => {
        p.pendingAdmins[admin] = true;
        p.pendingAdminWindows[admin] = stagedWindow(p, ADMIN_TIMELOCK_SECONDS);
      },
      postCheck: (s) => Boolean(s.pendingAdmins[admin] || s.adminRecords[admin]),
      rentSizes: [getPendingAdminSize()],
    },
    {
      id: `A3${id}`,
      title: `add_admin(${admin}) — signed by the new Admin key${label}`,
      applies: true,
      signerRole: "admin",
      signer: executor,
      skip: (p) => (p.adminRecords[admin] ? "Admin record exists" : null),
      // Inside the bootstrap window at once; once it is closed, 48 hours after S3 (D3).
      timelock: (p) => windowBlocker(p, p.pendingAdminWindows[admin], true, `S3${id}`),
      preconditions: () => [pre(`pendingAdmin(${admin})`, (s) => Boolean(s.pendingAdmins[admin]))],
      external: {
        id: `A3${id}`,
        role: "admin",
        key: admin,
        page: "/account/roles",
        action: "take the Admin role under Waiting for your acceptance (at once while the bootstrap window is open, else 48 hours after the proposal), then click Refresh",
      },
      build: async (p, signer) => [
        await getAddAdminInstructionAsync({ newAdmin: signer, proposer: p.platform!.admin, newAdminArg: admin }),
      ],
      apply: (p) => {
        p.adminRecords[admin] = true;
        p.pendingAdmins[admin] = false;
        p.pendingAdminWindows[admin] = null;
      },
      postCheck: (s) => Boolean(s.adminRecords[admin]),
    },
  ];

  const defs: StepDef[] = [
    {
      id: "S1",
      title: `initialize_platform(treasury ${T}, fee ${map.protocolFeeBps} bps)`,
      applies: true,
      signerRole: "deployer",
      signer: d,
      skip: (p) => (p.platform ? "Platform exists" : null),
      stop: (p) => {
        if (!p.platform) return null;
        if (p.platform.protocolFeeBps !== map.protocolFeeBps) return `Platform fee ${p.platform.protocolFeeBps} bps ≠ map ${map.protocolFeeBps} (the fee has no setter)`;
        if (p.platform.admin !== D && p.platform.admin !== SA) return `Platform admin ${p.platform.admin} is neither the deployer nor the superAdmin`;
        return null;
      },
      preconditions: () => [pre("platform:absent", (s) => !s.platform), pre(`ua.asset_registry=${D}`, (s) => s.ua.asset_registry === D)],
      build: async (_p, signer) => [
        await buildInitializePlatformInstruction(rpc, {
          admin: signer,
          upgradeAuthority: signer,
          protocolTreasury: T,
          protocolFeeBps: map.protocolFeeBps,
        }),
      ],
      apply: (p) => {
        // initialize_platform writes 0xFF: every pause bit plus the bootstrap marker.
        p.platform = { admin: D, protocolTreasury: T, protocolFeeBps: map.protocolFeeBps, pauseFlags: PAUSE_FLAGS_ALL | PLATFORM_BOOTSTRAP_OPEN };
        p.adminRecords[D] = true;
      },
      postCheck: (s) => s.platform?.admin === D && s.platform.protocolTreasury === T && s.platform.protocolFeeBps === map.protocolFeeBps,
      rentSizes: [getPlatformSize(), getAdminSize()],
    },
    {
      id: "S1b",
      title: `set_protocol_treasury(${T})`,
      applies: true,
      signerRole: "deployer",
      signer: d,
      skip: (p) => (!p.platform ? "S1 sets the map treasury" : p.platform.protocolTreasury === T ? "treasury is the map treasury" : null),
      preconditions: (p) => {
        const treasury = p.platform?.protocolTreasury;
        return [
          pre(`platform.admin=${D}`, (s) => s.platform?.admin === D),
          pre(`platform.treasury=${treasury}`, (s) => s.platform?.protocolTreasury === treasury),
        ];
      },
      external: { id: "S1b", role: "superAdmin", key: SA, page: "/admin/platform", action: `set the protocol treasury to ${T} (Protocol treasury → Rotate treasury)` },
      build: async (_p, signer) => [await getSetProtocolTreasuryInstructionAsync({ superAdmin: signer, newTreasury: T })],
      apply: (p) => {
        p.platform!.protocolTreasury = T;
      },
      postCheck: (s) => s.platform?.protocolTreasury === T,
    },
    {
      id: "S2",
      title: "initialize_blocklist_authority(authority = deployer)",
      applies: true,
      signerRole: "deployer",
      signer: d,
      skip: (p) => (p.blocklist ? "BlocklistAuthority exists" : null),
      stop: (p) =>
        p.blocklist && p.blocklist.authority !== D && p.blocklist.authority !== BA
          ? `BlocklistAuthority is ${p.blocklist.authority}; only that key can propose a new authority`
          : null,
      preconditions: () => [pre("blocklist:absent", (s) => !s.blocklist), pre(`ua.transfer_hook=${D}`, (s) => s.ua.transfer_hook === D)],
      build: async (_p, signer) => [
        await buildInitializeBlocklistAuthorityInstruction(rpc, { payer: signer, upgradeAuthority: signer, authority: D }),
      ],
      apply: (p) => {
        p.blocklist = { authority: D, proposed: null };
      },
      postCheck: (s) => s.blocklist?.authority === D,
      rentSizes: [getBlocklistAuthoritySize()],
    },
    {
      id: "S2b",
      title: `propose_blocklist_authority → ${BA}`,
      applies: true,
      signerRole: "deployer",
      signer: d,
      // An expired proposal is proposed again (it overwrites and restarts the 14 days).
      skip: (p) =>
        p.blocklist?.authority === BA
          ? "BA is the map key"
          : p.blocklist?.proposed === BA && windowKind(p, p.blocklistWindow, false) !== "expired"
            ? "already proposed to the map key"
            : null,
      preconditions: (p) => {
        const proposed = p.blocklist?.proposed ?? null;
        return [
          pre(`blocklist.authority=${D}`, (s) => s.blocklist?.authority === D),
          pre(`blocklist.proposed=${proposed ?? "none"}`, (s) => (s.blocklist?.proposed ?? null) === proposed),
        ];
      },
      build: async (_p, signer) => [await getProposeBlocklistAuthorityInstructionAsync({ authority: signer, newAuthority: BA })],
      apply: (p) => {
        p.blocklist!.proposed = BA;
        p.blocklistWindow = stagedWindow(p, 0);
      },
      postCheck: (s) => s.blocklist?.proposed === BA,
      rentSizes: [getBlocklistAuthorityProposalSize()],
    },
    ...map.admins.flatMap((admin) => grantSteps(`:${admin}`, admin, "", signerFor(admin))),
    ...grantSteps("k", K, " — temporary KYC grant (D17 fallback)", signers.rehearsal.kycAuthority ?? null).map(
      (def): StepDef => ({
        ...def,
        applies: map.kyc.tempAdminGrant,
        // Not needed once the KYC key accepted the registry; never an operator page.
        skip: (p) => def.skip(p) ?? (p.registry?.authority === K ? "KYC already accepted" : null),
        external: def.id === "A3k" ? def.external : undefined,
      }),
    ),
    {
      id: "S4",
      title: `create_kyc_registry(authority = admin = deployer) → ${registry}`,
      applies: true,
      signerRole: "deployer",
      signer: d,
      skip: (p) => (p.registry ? "registry exists" : null),
      stop: (p) => {
        if (p.registry && p.registry.authority !== D && p.registry.authority !== K) return `registry authority ${p.registry.authority} is foreign`;
        if (!p.registry && p.platform && !p.adminRecords[D]) return "the deployer has no Admin record; create_kyc_registry needs an Admin co-signer";
        return null;
      },
      preconditions: () => [pre(`kycRegistry(${registry}):absent`, (s) => !s.registry), pre(`admin(${D}):present`, (s) => Boolean(s.adminRecords[D]))],
      build: async (_p, signer) => [
        await buildCreateRegistry({ authoritySigner: signer, adminSigner: signer, approvedJurisdictions: approved, blockedJurisdictions: blocked }),
      ],
      apply: (p) => {
        p.registry = { authority: D, approved, blocked };
      },
      postCheck: (s) => s.registry?.authority === D,
      rentSizes: [getKycRegistrySize()],
    },
    {
      id: "S4c",
      title: "update_kyc_registry_jurisdictions (bitmaps differ from the map)",
      applies: true,
      signerRole: "deployer",
      signer: d,
      skip: (p) =>
        !p.registry
          ? "registry absent"
          : bitmapsEqual(p.registry.approved, approved) && bitmapsEqual(p.registry.blocked, blocked)
            ? "bitmaps match"
            : p.registry.authority !== D
              ? "authority is not the deployer (the KYC Ledger owns the bitmaps)"
              : null,
      preconditions: () => [pre(`kycRegistry.authority=${D}`, (s) => s.registry?.authority === D)],
      build: async (_p, signer) => [
        await buildUpdateRegistryJurisdictions({ authoritySigner: signer, registry, approvedJurisdictions: approved, blockedJurisdictions: blocked }),
      ],
      apply: (p) => {
        p.registry = { ...p.registry!, approved, blocked };
      },
      postCheck: (s) => Boolean(s.registry && bitmapsEqual(s.registry.approved, approved) && bitmapsEqual(s.registry.blocked, blocked)),
    },
    {
      id: "S4b.cancel",
      title: "cancel_kyc_registry_authority_transfer (pending to another key)",
      applies: true,
      signerRole: "deployer",
      signer: d,
      // A foreign proposal, or the map key's once it expired, is withdrawn first.
      skip: (p) =>
        !p.registryProposed || (p.registryProposed === K && windowKind(p, p.registryWindow, false) !== "expired")
          ? "no foreign or expired proposal"
          : null,
      preconditions: (p) => {
        const proposed = p.registryProposed;
        return [
          pre(`kycRegistry.authority=${D}`, (s) => s.registry?.authority === D),
          pre(`kycRegistry.proposed=${proposed}`, (s) => s.registryProposed === proposed),
        ];
      },
      build: async (_p, signer) => [await buildCancelKycAuthorityTransfer({ authoritySigner: signer, registry })],
      apply: (p) => {
        p.registryProposed = null;
        p.registryWindow = null;
      },
      postCheck: (s) => s.registryProposed === null,
    },
    {
      id: "S4b",
      title: `propose_kyc_registry_authority → ${K}`,
      applies: true,
      signerRole: "deployer",
      signer: d,
      skip: (p) =>
        p.registry?.authority === K
          ? "KYC authority is the map key"
          : p.registryProposed === K && windowKind(p, p.registryWindow, false) !== "expired"
            ? "already proposed to the map key"
            : null,
      preconditions: () => [
        pre(`kycRegistry.authority=${D}`, (s) => s.registry?.authority === D),
        pre("kycRegistry.proposed=none", (s) => s.registryProposed === null),
      ],
      build: async (_p, signer) => [await buildProposeKycAuthority({ authoritySigner: signer, registry, newAuthority: K })],
      apply: (p) => {
        p.registryProposed = K;
        p.registryWindow = stagedWindow(p, 0);
      },
      postCheck: (s) => s.registryProposed === K,
      rentSizes: [getAuthorityProposalSize()],
    },
    {
      id: "X3",
      title: `accept_blocklist_authority (${BA})`,
      applies: true,
      signerRole: "blocklistAuthority",
      signer: signers.rehearsal.blocklistAuthority ?? null,
      skip: (p) => (p.blocklist?.authority === BA ? "BA accepted" : null),
      timelock: (p) =>
        p.recoveryPending.blocklist
          ? "a blocklist authority recovery by the upgrade authority is pending: the accept is refused (hook 6020) until it is cancelled or executed"
          : windowBlocker(p, p.blocklistWindow, false, "S2b"),
      preconditions: () => [pre(`blocklist.proposed=${BA}`, (s) => s.blocklist?.proposed === BA)],
      external: { id: "X3", role: "blocklistAuthority", key: BA, page: "/issuer/authority", action: "accept the blocklist authority (or under Waiting for your acceptance on /account/roles), then click Refresh" },
      build: async (_p, signer) => [await getAcceptBlocklistAuthorityInstructionAsync({ newAuthority: signer })],
      apply: (p) => {
        p.blocklist = { authority: BA, proposed: null };
      },
      postCheck: (s) => s.blocklist?.authority === BA,
    },
    {
      id: "X2",
      title: `accept_kyc_registry_authority (${K})`,
      applies: true,
      signerRole: "kycAuthority",
      signer: signers.rehearsal.kycAuthority ?? null,
      skip: (p) => (p.registry?.authority === K ? "KYC accepted" : null),
      timelock: (p) => windowBlocker(p, p.registryWindow, false, "S4b"),
      preconditions: () => [pre(`kycRegistry.proposed=${K}`, (s) => s.registryProposed === K)],
      external: {
        id: "X2",
        role: "kyc.authority",
        key: K,
        // Outside the admin gate: the proposed key is not the kycProvider (or an
        // Admin) until it accepts, so /admin/kyc would refuse it (3.1 K5/K6).
        page: "/account/roles",
        action: map.kyc.tempAdminGrant
          ? "accept the KYC provider (registry authority) under Waiting for your acceptance (temporary Admin grant path)"
          : "accept the KYC provider (registry authority) under Waiting for your acceptance",
      },
      build: async (_p, signer) => [await buildAcceptKycAuthority({ newAuthoritySigner: signer, registry })],
      apply: (p) => {
        p.registry = { ...p.registry!, authority: K };
        p.registryProposed = null;
      },
      postCheck: (s) => s.registry?.authority === K,
    },
    {
      id: "S3r",
      title: `remove_admin(${K}) — end the temporary KYC grant`,
      applies: map.kyc.tempAdminGrant,
      signerRole: "deployer",
      signer: d,
      skip: (p) => (!p.adminRecords[K] ? "no Admin record" : null),
      preconditions: () => [
        pre(`kycRegistry.authority=${K}`, (s) => s.registry?.authority === K),
        pre(`platform.admin=${D}`, (s) => s.platform?.admin === D),
        pre(`admin(${K}):present`, (s) => Boolean(s.adminRecords[K])),
      ],
      build: async (_p, signer) => [await getRemoveAdminInstructionAsync({ superAdmin: signer, admin: K })],
      apply: (p) => {
        p.adminRecords[K] = false;
      },
      postCheck: (s) => !s.adminRecords[K],
    },
    {
      // v1: the temporary grant was proposed but never executed before the
      // KYC key accepted the registry: withdraw it (a pending grant blocks the
      // handover inventory).
      id: "S3r.cancel",
      title: `cancel_admin_proposal(${K}) — the unused temporary KYC grant`,
      applies: map.kyc.tempAdminGrant,
      signerRole: "deployer",
      signer: d,
      skip: (p) => (!p.pendingAdmins[K] ? "no pending grant" : null),
      preconditions: () => [
        pre(`kycRegistry.authority=${K}`, (s) => s.registry?.authority === K),
        pre(`platform.admin=${D}`, (s) => s.platform?.admin === D),
        pre(`pendingAdmin(${K}):present`, (s) => Boolean(s.pendingAdmins[K])),
      ],
      build: async (_p, signer) => [
        await getCancelAdminProposalInstructionAsync({
          canceller: signer,
          pendingAdmin: (await findPendingAdminPda({ newAdmin: K }))[0],
          proposer: D,
          programData: await programDataAddress(PROGRAM_IDS.asset_registry),
        }),
      ],
      apply: (p) => {
        p.pendingAdmins[K] = false;
      },
      postCheck: (s) => !s.pendingAdmins[K],
    },
    {
      id: "S6d",
      title: `set_pause_flags(clear ${formatPauseFlags(unpauseMask)}) by the deployer`,
      applies: unpauseByDeployer,
      signerRole: "deployer",
      signer: d,
      skip: (p) => (((p.platform?.pauseFlags ?? 0) & unpauseMask) === 0 ? "not paused" : null),
      // Any clear closes the bootstrap window: every role step lands first (§5.4).
      waitsFor: roleSteps,
      preconditions: (p) => {
        const flags = p.platform?.pauseFlags ?? 0;
        return [
          pre(`platform.admin=${D}`, (s) => s.platform?.admin === D),
          pre(`platform.pauseFlags=${formatPauseFlags(flags)}`, (s) => s.platform?.pauseFlags === flags),
        ];
      },
      build: async (_p, signer) => [
        await getSetPauseFlagsInstructionAsync({ authority: signer, setMask: 0, clearMask: unpauseMask }),
      ],
      apply: (p) => {
        p.platform!.pauseFlags &= ~(unpauseMask | PLATFORM_BOOTSTRAP_OPEN);
      },
      postCheck: (s) => ((s.platform?.pauseFlags ?? 0) & unpauseMask) === 0,
    },
    {
      id: "S5",
      title: `propose_platform_admin → ${SA}`,
      applies: !deployerIsSa,
      signerRole: "deployer",
      signer: d,
      skip: (p) =>
        p.platform?.admin === SA
          ? "SA is the platform admin"
          : p.platformProposed === SA && windowKind(p, p.platformWindow, true) !== "expired"
            ? "already proposed to the SA"
            : null,
      // Every Admin grant executes before X1: the accept makes their proposer
      // stale, and a closed bootstrap window would add the 48 h.
      waitsFor: [...cycleOne, ...(map.kyc.tempAdminGrant ? ["S3r", "S3r.cancel"] : [])],
      preconditions: (p) => {
        const proposed = p.platformProposed;
        return [
          pre(`platform.admin=${D}`, (s) => s.platform?.admin === D),
          pre(`platform.proposed=${proposed ?? "none"}`, (s) => s.platformProposed === proposed),
        ];
      },
      build: async (_p, signer) => [await getProposePlatformAdminInstructionAsync({ authority: signer, newAdmin: SA })],
      apply: (p) => {
        p.platformProposed = SA;
        p.platformWindow = stagedWindow(p, ADMIN_TIMELOCK_SECONDS);
      },
      postCheck: (s) => s.platformProposed === SA,
      rentSizes: [getAuthorityProposalSize()],
    },
    {
      id: "X1",
      title: `accept_platform_admin (${SA})`,
      applies: !deployerIsSa,
      signerRole: "superAdmin",
      signer: deployerIsSa ? null : signers.rehearsal.superAdmin ?? null,
      skip: (p) => (p.platform?.admin === SA ? "SA accepted" : null),
      // The accept makes every grant the deployer staged stale (6152): they execute first.
      waitsFor: [...executions, ...(map.kyc.tempAdminGrant ? ["S3r", "S3r.cancel"] : [])],
      timelock: (p) =>
        p.recoveryPending.platform
          ? "a super admin recovery by the upgrade authority is pending: accept_platform_admin is refused (6155) until it is cancelled or executed"
          : windowBlocker(p, p.platformWindow, true, "S5"),
      preconditions: () => [pre(`platform.proposed=${SA}`, (s) => s.platformProposed === SA)],
      external: { id: "X1", role: "superAdmin", key: SA, page: "/issuer/authority", action: "accept the platform admin (or under Waiting for your acceptance on /account/roles), then click Refresh" },
      build: async (p, signer) => [
        await getAcceptPlatformAdminInstructionAsync({
          newAdmin: signer,
          oldAdminRecord: (await findAdminRecordPda({ authority: p.platform!.admin }))[0],
        }),
      ],
      apply: (p) => {
        p.adminRecords[p.platform!.admin] = false;
        p.platform!.admin = SA;
        p.adminRecords[SA] = true;
        p.platformProposed = null;
        p.platformWindow = null;
        // The grants the deployer staged are stale from here (6152).
        for (const wallet of Object.keys(p.pendingAdmins)) p.pendingAdmins[wallet] = false;
      },
      postCheck: (s) => s.platform?.admin === SA,
    },
    {
      id: "S5c",
      title: "set_pause_flags(0, 0x80) — close the bootstrap window",
      applies: true,
      signerRole: deployerIsSa ? "deployer" : "superAdmin",
      signer: saSigner,
      skip: (p) => (!p.platform || !isBootstrapOpen(p.platform.pauseFlags) ? "the bootstrap window is closed" : null),
      waitsFor: [...executions, "X1"],
      preconditions: () => [
        pre(`platform.admin=${SA}`, (s) => s.platform?.admin === SA),
        pre("platform.bootstrapOpen", (s) => Boolean(s.platform && isBootstrapOpen(s.platform.pauseFlags))),
      ],
      external: {
        id: "S5c",
        role: "superAdmin",
        key: SA,
        page: "/admin/platform",
        action: 'close the bootstrap window in the PauseFlagsPanel ("Close bootstrap window")',
      },
      build: async (_p, signer) => [await getSetPauseFlagsInstructionAsync({ authority: signer, ...CLOSE_BOOTSTRAP_MASKS })],
      apply: (p) => {
        p.platform!.pauseFlags &= ~PLATFORM_BOOTSTRAP_OPEN;
      },
      postCheck: (s) => Boolean(s.platform && !isBootstrapOpen(s.platform.pauseFlags)),
    },
    {
      id: "S6",
      title: `set_pause_flags(clear ${formatPauseFlags(unpauseMask)}) by the superAdmin`,
      applies: !unpauseByDeployer,
      signerRole: "superAdmin",
      signer: saSigner,
      skip: (p) => (((p.platform?.pauseFlags ?? 0) & unpauseMask) === 0 ? "not paused" : null),
      // The first unpause follows every role step, X1 and the explicit close (§5.4, K1.3).
      waitsFor: [...roleSteps, "X1", "S5c"],
      preconditions: (p) => {
        const flags = p.platform?.pauseFlags ?? 0;
        return [
          pre(`platform.admin=${SA}`, (s) => s.platform?.admin === SA),
          pre(`platform.pauseFlags=${formatPauseFlags(flags)}`, (s) => s.platform?.pauseFlags === flags),
        ];
      },
      // The PauseFlagsPanel lives on /admin/platform (3.1); accept_platform_admin
      // gave the SA its Admin record, so the admin gate lets it in. "Resume
      // everything" clears every emergency area, never the payout modules.
      external: { id: "S6", role: "superAdmin", key: SA, page: "/admin/platform", action: `clear the pause bits ${formatPauseFlags(unpauseMask)} in the PauseFlagsPanel ("Resume everything" when that is every emergency area)` },
      build: async (_p, signer) => [
        await getSetPauseFlagsInstructionAsync({ authority: signer, setMask: 0, clearMask: unpauseMask }),
      ],
      apply: (p) => {
        p.platform!.pauseFlags &= ~(unpauseMask | PLATFORM_BOOTSTRAP_OPEN);
      },
      postCheck: (s) => ((s.platform?.pauseFlags ?? 0) & unpauseMask) === 0,
    },
  ];
  return defs;
}

/**
 * Every operator-front action a bootstrap of `map` can ask for (its page and
 * wording), whatever the chain state: the runbook and the page test read it.
 */
export function bootstrapExternalActions(map: RoleMap): ExternalAction[] {
  const signers: BootstrapSigners = { deployer: createNoopSigner(map.deployer), rehearsal: {} };
  // The rpc is only used by the builders, which this never calls.
  return stepDefinitions(map, signers, undefined as unknown as ChainRpc)
    .filter((def) => def.applies && def.external)
    .map((def) => def.external!);
}

/** Plans the current cycle (design §4.3). Pure apart from the S1/S2 UA read. */
export async function planBootstrap(
  state: BootstrapState,
  map: RoleMap,
  signers: BootstrapSigners,
  options: PlanOptions,
): Promise<BootstrapPlan> {
  const D = map.deployer;
  const V = map.squads.vault;
  const plan: BootstrapPlan = {
    steps: [],
    skipped: [],
    awaiting: [],
    blocked: [],
    stops: [],
    notes: [],
    handover: { planned: false, reason: null },
    deployerNeed: BigInt(0),
  };

  // P0 preflight.
  for (const name of IDL_PROGRAMS) {
    if (!state.deployed[name]) plan.stops.push(`P0: ${name} is not deployed as a loader-v3 program`);
  }
  if (!state.platform && state.ua.asset_registry !== D) {
    plan.stops.push(
      "P0 (K4): the Platform is missing and the asset_registry upgrade authority is not the deployer; only the UA can initialize it (k4Fallback: chain:squads-export op=registry-ix initialize_platform through the vault)",
    );
  }
  if (!state.blocklist && state.ua.transfer_hook !== D) {
    plan.stops.push(
      "P0 (K4): the BlocklistAuthority is missing and the transfer_hook upgrade authority is not the deployer; only the UA can initialize it",
    );
  }
  if (plan.stops.length) return plan;

  const p = cloneState(state);
  const done = new Map<string, Outcome>();
  const rentSizes: number[] = [];
  for (const def of stepDefinitions(map, signers, options.rpc)) {
    if (!def.applies) continue;
    const stop = def.stop?.(p);
    if (stop) {
      plan.stops.push(`${def.id}: ${stop}`);
      done.set(def.id, "stopped");
      continue;
    }
    const skip = def.skip(p);
    if (skip) {
      plan.skipped.push({ id: def.id, reason: skip });
      done.set(def.id, "skipped");
      continue;
    }
    const gate = waitingOn(def.waitsFor, done) ?? def.timelock?.(p);
    if (gate) {
      plan.blocked.push({ id: def.id, reason: gate });
      done.set(def.id, "blocked");
      continue;
    }
    // Admin-signed steps after the SA rotation become external SA actions.
    const needsDeployerAdmin = def.signerRole === "deployer" && def.external && p.platform && p.platform.admin !== D;
    const preconditions = def.preconditions(p);
    const failing = preconditions.filter((c) => !c.holds(p));
    if (needsDeployerAdmin) {
      plan.awaiting.push(def.external!);
      done.set(def.id, "awaiting");
      continue;
    }
    if (failing.length) {
      plan.blocked.push({ id: def.id, reason: `waits for ${failing.map((c) => c.label).join(", ")}` });
      done.set(def.id, "blocked");
      continue;
    }
    if (!def.signer) {
      if (def.external) plan.awaiting.push(def.external);
      done.set(def.id, "awaiting");
      continue;
    }
    const ixs = await def.build(p, def.signer);
    plan.steps.push({
      id: def.id,
      title: def.title,
      signer: def.signer,
      signerRole: def.signerRole,
      ixs,
      preconditions,
      simulate: preconditions.every((c) => c.holds(state)) ? "now" : "at-send",
      idempotency: "replay-safe",
      required: "finalized",
      skip: (s) => def.skip(s) !== null,
      postCheck: def.postCheck,
      dependsOn: preconditions.filter((c) => !c.holds(state)).map((c) => c.label).join(", ") || undefined,
    });
    if (def.signerRole === "deployer") rentSizes.push(...(def.rentSizes ?? []));
    def.apply(p);
    done.set(def.id, "included");
  }
  const included = new Set(plan.steps.map((step) => step.id));
  if (included.has("S2b") && state.blocklist?.proposed && state.blocklist.proposed !== map.blocklistAuthority) {
    plan.notes.push(`S2b overwrites a pending blocklist proposal to ${state.blocklist.proposed} (a re-proposal restarts its 14-day window)`);
  }
  if (included.has("S5") && state.platformProposed && state.platformProposed !== map.superAdmin) {
    plan.notes.push(`S5 overwrites a pending platform admin proposal to ${state.platformProposed} (a re-proposal restarts its 48-hour wait and 14-day window)`);
  }
  if (state.platform && !isBootstrapOpen(state.platform.pauseFlags) && [...plan.awaiting, ...plan.blocked].some((a) => a.id.startsWith("A3"))) {
    plan.notes.push("the bootstrap window is closed: each add_admin waits 48 hours after its propose_admin (and X1 48 hours after S5)");
  }
  if (included.has("S4b.cancel")) {
    plan.notes.push(`S4b.cancel withdraws a pending KYC proposal to ${state.registryProposed} before proposing kyc.authority`);
  }

  // S7 handover (design §4.4).
  const uaDone = IDL_PROGRAMS.every((name) => state.ua[name] === V);
  if (uaDone) plan.skipped.push({ id: "S7", reason: "both upgrade authorities are the vault" });
  else {
    const h = options.handover;
    // With CHAIN_HANDOVER_WHILE_PAUSED=1 an outstanding unpause (S6) does not
    // hold S7 back; everything else must be done.
    const unpause = (id: string) => h.whilePaused && (id === "S6" || id === "S6d");
    const pending =
      plan.steps.some((s) => !unpause(s.id)) ||
      plan.awaiting.some((a) => !unpause(a.id)) ||
      plan.blocked.some((b) => !unpause(b.id)) ||
      plan.stops.length > 0;
    let reason: string | null = null;
    if (pending) reason = "earlier steps are pending";
    else if (!h.requested) reason = "set CHAIN_HANDOVER=1 and CHAIN_CONFIRM_HANDOVER=<vault> to plan S7";
    else if (h.confirmVault !== V) plan.stops.push(`S7: CHAIN_CONFIRM_HANDOVER must equal the vault ${V}`);
    else if (state.platform && (state.platform.pauseFlags & map.unpauseMask) !== 0 && !h.whilePaused) reason = "S6 (unpause) is not done; or set CHAIN_HANDOVER_WHILE_PAUSED=1";
    else if (h.inventoryBlockers === null) reason = "the pre-handover inventory did not run";
    else if (h.inventoryBlockers > 0) plan.stops.push(`S7: the pre-handover inventory has ${h.inventoryBlockers} blockers`);
    else if (IDL_PROGRAMS.some((name) => state.ua[name] !== D && state.ua[name] !== V)) {
      plan.stops.push("S7: an upgrade authority is neither the deployer nor the vault");
    }
    if (reason) plan.handover = { planned: false, reason };
    else if (!plan.stops.length) {
      const ixs: Instruction[] = [];
      const labels: Precondition<BootstrapState>[] = [];
      for (const name of ["transfer_hook", "asset_registry"] as ProgramName[]) {
        if (state.ua[name] !== D) continue;
        ixs.push(await setUpgradeAuthorityInstruction({ program: PROGRAM_IDS[name], current: signers.deployer, next: V }));
        labels.push(pre(`ua.${name}=${D}`, (s) => s.ua[name] === D));
      }
      labels.push(
        pre(`platform.admin=${map.superAdmin}`, (s) => s.platform?.admin === map.superAdmin),
        pre(`blocklist.authority=${map.blocklistAuthority}`, (s) => s.blocklist?.authority === map.blocklistAuthority),
        pre(`kycRegistry.authority=${map.kyc.authority}`, (s) => s.registry?.authority === map.kyc.authority),
      );
      labels.push(pre("platform.bootstrapClosed", (s) => Boolean(s.platform && !isBootstrapOpen(s.platform.pauseFlags))));
      if (!h.whilePaused) {
        labels.push(pre(`platform.pauseFlags&${formatPauseFlags(map.unpauseMask)}=0x00`, (s) => ((s.platform?.pauseFlags ?? 0) & map.unpauseMask) === 0));
      }
      plan.steps.push({
        id: "S7",
        title: `SetAuthority → vault ${V} for both ProgramData accounts (one transaction)`,
        signer: signers.deployer,
        signerRole: "deployer",
        ixs,
        preconditions: labels,
        simulate: "now",
        idempotency: "replay-safe",
        required: "finalized",
        skip: (s) => IDL_PROGRAMS.every((name) => s.ua[name] === V),
        postCheck: (s) => IDL_PROGRAMS.every((name) => s.ua[name] === V),
      });
      plan.handover = { planned: true, reason: null };
    }
  }

  // Balance (P0): rent of the accounts the deployer creates plus fees.
  if (options.rent) {
    let need = FEE_MARGIN;
    for (const size of rentSizes) need += await options.rent(size);
    const deployerSteps = plan.steps.filter((s) => s.signer.address === D).length;
    const priority = options.cuPrice ? (options.cuPrice * BigInt(200_000)) / BigInt(1_000_000) : BigInt(0);
    need += BigInt(deployerSteps) * (SIGNATURE_FEE + priority);
    plan.deployerNeed = need;
    if (deployerSteps && state.balance < need) {
      plan.stops.push(`P0: deployer balance ${state.balance} lamports is below the estimated ${need} for this cycle`);
    }
  }
  return plan;
}

// ── Role steps on the CLI (chain:accept) ─────────────────────────────────────

/**
 * The bootstrap steps a role key signs itself, by the `chain:accept` op that
 * runs each one with that key's Ledger (the operator front does the same on
 * its pages, behind SIWS).
 */
export const ROLE_STEP_OPS = {
  "add-admin": "A3",
  "accept-blocklist-authority": "X3",
  "accept-kyc-registry-authority": "X2",
  "accept-platform-admin": "X1",
  "close-bootstrap-window": "S5c",
  "first-unpause": "S6",
} as const;
export type RoleStepOp = keyof typeof ROLE_STEP_OPS;

/** The `chain:accept` op of a role step id (`A3:<key>`, `A3k`, X3, X2, X1, S5c, S6), or null. */
export function roleStepOp(id: string): RoleStepOp | null {
  const base = id === "A3k" || id.startsWith("A3:") ? "A3" : id;
  const entry = Object.entries(ROLE_STEP_OPS).find(([, step]) => step === base);
  return entry ? (entry[0] as RoleStepOp) : null;
}

export type RoleStepPlan = {
  id: string;
  title: string;
  signerRole: string;
  /** null: the step's effect is already on chain (`noop` says so). */
  step: PlanStep<BootstrapState> | null;
  noop: string | null;
};

/** What the chain holds instead of the proposal a role step accepts (for its refusal). */
function missingProposal(id: string, state: BootstrapState, map: RoleMap): string | null {
  const names = (proposed: Address | null | undefined, live: string, proposer: string) =>
    proposed ? `the pending proposal names ${proposed}, not this key` : `no live ${live} proposal (${proposer} proposes it)`;
  if (id === "X3") return names(state.blocklist?.proposed, "blocklist authority", "S2b of chain:bootstrap");
  if (id === "X2") return names(state.registryProposed, "KYC registry authority", "S4b of chain:bootstrap");
  if (id === "X1") return names(state.platformProposed, "super admin", "S5 of chain:bootstrap cycle 2");
  if (id === "A3k" || id.startsWith("A3:")) {
    return "no live Admin grant for this key (S3 of chain:bootstrap proposes it; a grant staged by an earlier super admin is stale, 6152)";
  }
  if ((id === "S5c" || id === "S6") && state.platform && state.platform.admin !== map.superAdmin) {
    return `the super admin is still ${state.platform.admin}: X1 comes first`;
  }
  return null;
}

/**
 * Plans ONE bootstrap step that a role key signs itself (`chain:accept`),
 * from the same step definitions as `chain:bootstrap`: its skip, the steps it
 * waits for, its proposal window and its preconditions, judged against the
 * chain alone (nothing is planned before it here). Refuses (ChainPlanError)
 * whatever the bootstrap plan would hold back. The steps it waits for and its
 * window become preconditions of the step, so the send re-checks them at
 * finalized right before it signs.
 */
export async function planRoleStep(
  state: BootstrapState,
  map: RoleMap,
  id: string,
  signer: TransactionSigner,
  rpc: ChainRpc,
): Promise<RoleStepPlan> {
  for (const name of IDL_PROGRAMS) {
    if (!state.deployed[name]) throw new ChainPlanError(`${name} is not deployed as a loader-v3 program`);
  }
  const key = signer.address;
  const rehearsal: BootstrapSigners["rehearsal"] = {};
  if (map.superAdmin === key) rehearsal.superAdmin = signer;
  if (map.blocklistAuthority === key) rehearsal.blocklistAuthority = signer;
  if (map.kyc.authority === key) rehearsal.kycAuthority = signer;
  if (map.admins.includes(key)) rehearsal.admin = signer;
  const signers: BootstrapSigners = { deployer: map.deployer === key ? signer : createNoopSigner(map.deployer), rehearsal };
  const defs = stepDefinitions(map, signers, rpc).filter((def) => def.applies);
  const target = defs.find((def) => def.id === id);
  if (!target) throw new ChainPlanError(`${id} is not a step of this role map's bootstrap`);
  const stops = defs.flatMap((def) => {
    const stop = def.stop?.(state);
    return stop ? [`${def.id}: ${stop}`] : [];
  });
  if (stops.length) throw new ChainPlanError(`the bootstrap plan stops (${stops.join("; ")}); resolve that with chain:bootstrap first`);

  const done = new Map<string, Outcome>();
  for (const def of defs) {
    if (def === target) break;
    done.set(def.id, def.skip(state) ? "skipped" : "awaiting");
  }
  const base = { id, title: target.title, signerRole: target.signerRole };
  const already = target.skip(state);
  if (already) return { ...base, step: null, noop: already };
  const waits = waitingOn(target.waitsFor, done);
  if (waits) throw new ChainPlanError(`${id} ${waits}: each of them lands first (the order of runbook §5)`);
  const timelock = target.timelock?.(state);
  if (timelock) throw new ChainPlanError(`${id} cannot run now: ${timelock}`);
  const preconditions = target.preconditions(state);
  const failing = preconditions.filter((c) => !c.holds(state));
  if (failing.length) {
    const why = missingProposal(id, state, map);
    throw new ChainPlanError(`${id} cannot run: ${failing.map((c) => c.label).join(", ")} does not hold${why ? ` (${why})` : ""}`);
  }
  if (target.signer?.address !== key) {
    throw new ChainPlanError(`${id} is signed by the ${target.signerRole}, not by ${key}`);
  }
  const byId = new Map(defs.map((def) => [def.id, def]));
  const landed = (target.waitsFor ?? [])
    .filter((wait) => byId.has(wait))
    .map((wait) => pre(`${wait}:landed`, (s) => byId.get(wait)!.skip(s) !== null));
  const window = target.timelock ? [pre(`${id}:window-open`, (s) => target.timelock!(s) === null)] : [];
  return {
    ...base,
    noop: null,
    step: {
      id,
      title: target.title,
      signer,
      signerRole: target.signerRole,
      ixs: await target.build(state, signer),
      preconditions: [...preconditions, ...landed, ...window],
      simulate: "now",
      idempotency: "replay-safe",
      required: "finalized",
      skip: (s) => target.skip(s) !== null,
      postCheck: target.postCheck,
    },
  };
}

// ── Tool ────────────────────────────────────────────────────────────────────

/** One line on the bootstrap window (bit 7) and what it means for the timelocks. */
export function bootstrapWindowLine(state: BootstrapState): string | null {
  if (!state.platform) return "bootstrap window: opens at S1 (a fresh Platform is 0xff): every grant (A3) and X1 then execute at once, until S5c closes it right after X1";
  const time = state.now === null ? "chain time unknown" : `chain time ${new Date(Number(state.now) * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
  return isBootstrapOpen(state.platform.pauseFlags)
    ? `bootstrap window: OPEN (${formatPauseFlags(state.platform.pauseFlags)}, ${time}): A3 and X1 execute at once; S5c closes it for good right after X1, before the first unpause`
    : `bootstrap window: closed (${formatPauseFlags(state.platform.pauseFlags)}, ${time}): add_admin runs 48 hours after its propose_admin and X1 48 hours after S5, each within 14 days`;
}

function printPlan(ctx: ToolContext, plan: BootstrapPlan, simulations: Map<string, string>, state?: BootstrapState) {
  const window = state ? bootstrapWindowLine(state) : null;
  if (window) ctx.log(window);
  ctx.log("id          signer              simulate  action");
  for (const step of plan.steps) {
    const sim = simulations.get(step.id) ?? (step.simulate === "at-send" ? `deferred: depends on ${step.dependsOn ?? "an earlier step"}` : "");
    ctx.log(`${step.id.padEnd(11)} ${step.signerRole.padEnd(19)} ${step.simulate.padEnd(9)} ${step.title}${sim ? `  [${sim}]` : ""}`);
  }
  for (const skip of plan.skipped) ctx.log(`${skip.id.padEnd(11)} skipped: ${skip.reason}`);
  for (const blocked of plan.blocked) ctx.log(`${blocked.id.padEnd(11)} waiting: ${blocked.reason}`);
  for (const action of plan.awaiting) {
    ctx.log(`ACTION REQUIRED ${action.id}: ${action.role} ${action.key} — ${action.action} on ${action.page} (operator front)`);
    const op = roleStepOp(action.id);
    if (op) ctx.log(`  or with that key's Ledger on the CLI: CHAIN_ACCEPT_OP=${op} CHAIN_ACCEPT_SIGNER=${action.key} npm run chain:accept`);
  }
  if (plan.handover.reason) ctx.log(`S7 pending: ${plan.handover.reason}`);
  for (const note of plan.notes) ctx.log(`note: ${note}`);
  for (const stop of plan.stops) ctx.log(`STOP ${stop}`);
}

function readHandover(env: ToolContext["env"]) {
  return {
    requested: env.CHAIN_HANDOVER?.trim() === "1",
    confirmVault: env.CHAIN_CONFIRM_HANDOVER?.trim() || null,
    whilePaused: env.CHAIN_HANDOVER_WHILE_PAUSED?.trim() === "1",
  };
}

async function loadSigners(ctx: ToolContext, map: RoleMap): Promise<BootstrapSigners> {
  const { config } = ctx;
  const roleKey: Record<RehearsalRole, Address | undefined> = {
    superAdmin: map.superAdmin,
    blocklistAuthority: map.blocklistAuthority,
    kycAuthority: map.kyc.authority,
    admin: map.admins[0],
  };
  const rehearsal: BootstrapSigners["rehearsal"] = {};
  for (const role of Object.keys(config.rehearsalSigners) as RehearsalRole[]) {
    const expected = roleKey[role];
    if (!expected) throw new ChainGateError(`CHAIN_REHEARSAL_SIGNERS names ${role}, but the role map has no such key`);
    rehearsal[role] = config.send
      ? await loadHotSigner(config.rehearsalSigners[role]!, expected, `rehearsal ${role}`)
      : createNoopSigner(expected);
  }
  const deployer = config.send ? await loadHotSigner(config.keypairPath!, map.deployer, "deployer") : createNoopSigner(map.deployer);
  return { deployer, rehearsal };
}

export async function bootstrapTool(ctx: ToolContext): Promise<ToolStatus> {
  const { config, evidence } = ctx;
  ctx.phase = "inputs";
  const loaded = await loadRoleMap(config.roleMapPath!, { network: config.network, genesis: config.expectedGenesis });
  const map = loaded.map;
  evidence.roleMapSha256 = loaded.sha256;
  evidence.roleMapWarnings = loaded.warnings;
  for (const warning of loaded.warnings) ctx.log(`warning: ${warning}`);
  const release: Release | null = config.releaseDir
    ? loadRelease(config.releaseDir, { requireSums: config.network === "mainnet" })
    : null;
  evidence.release = releaseEvidence(release);
  evidence.releaseCommit = release?.commit ?? null;
  assertReleaseSource({ network: config.network, root: ctx.root, localIdl: readLocalIdl(ctx.frontDir), releaseIdl: release?.idl ?? null });
  const handover = readHandover(ctx.env);
  if (lockIsPresent(config.stateDir, config.network, config.expectedGenesis)) ctx.log("warning: a chain lock exists for this network; a send run will refuse until CHAIN_RECOVER=1 resolves it");

  ctx.phase = "signers";
  const signers = await loadSigners(ctx, map);

  ctx.phase = "probe";
  const state = await probeBootstrapState(ctx.rpc, map);
  evidence.state = state;
  // Release bytes against the live ProgramData (mainnet gate, reported elsewhere).
  if (release) {
    const compare: Record<string, boolean> = {};
    for (const name of IDL_PROGRAMS) {
      const data = await fetchRawAccount(ctx.rpc, await programDataAddress(PROGRAM_IDS[name]));
      const decoded = data ? decodeProgramData(data.data) : null;
      compare[name] = Boolean(decoded && comparePayload(decoded.payload, release.so[name]).equal);
    }
    evidence.releaseBytesEqual = compare;
    if (config.network === "mainnet" && Object.values(compare).some((equal) => !equal)) {
      throw new ChainGateError("The Release .so differs from the live ProgramData; the bootstrap refuses on mainnet");
    }
  }
  const idlSources = resolveIdlSources(ctx, release, { prefer: release?.idl ? "release" : "head", inventory: true });
  evidence.idl = await Promise.all(IDL_PROGRAMS.map(async (name) => idlProbeEvidence(await probeIdl(ctx.rpc, name, idlSources[name]))));

  let inventoryBlockers: number | null = null;
  if (handover.requested) {
    ctx.phase = "inventory";
    const inv = await collectInventory(ctx.rpc, {
      map,
      release,
      idlSources,
      lockPresent: false,
      kycPin: map.kyc.registry,
      scanBuffers: false,
    });
    const findings = inventoryFindings(inv, map, "pre-handover", { handoverWhilePaused: handover.whilePaused });
    const blockers = findings.filter((f) => f.severity === "blocker");
    inventoryBlockers = blockers.length;
    evidence.handoverInventory = { blockers: blockers.map((f) => f.message), findings: findings.length };
  }

  ctx.phase = "plan";
  const rent = async (size: number) =>
    ctx.rpc.getMinimumBalanceForRentExemption(BigInt(size), { commitment: "finalized" }).send();
  const plan = await planBootstrap(state, map, signers, {
    rpc: ctx.rpc,
    handover: { ...handover, inventoryBlockers },
    rent,
    cuPrice: config.cuPrice,
  });
  const digest = planDigest({
    network: config.network,
    genesis: config.expectedGenesis,
    roleMapSha256: loaded.sha256,
    releaseSha256Sums: release?.sha256Sums.fileSha256 ?? null,
    steps: plan.steps,
  });
  evidence.planDigest = digest;
  evidence.plan = {
    steps: plan.steps.map((s) => ({ id: s.id, title: s.title, signerRole: s.signerRole, simulate: s.simulate, preconditions: s.preconditions.map((c) => c.label) })),
    skipped: plan.skipped,
    blocked: plan.blocked,
    awaiting: plan.awaiting,
    stops: plan.stops,
    notes: plan.notes,
    handover: plan.handover,
    deployerNeedLamports: plan.deployerNeed.toString(),
  };
  evidence.kycRegistry = map.kyc.registry;

  const simulations = new Map<string, string>();
  if (!config.send && !plan.stops.length) {
    ctx.phase = "simulate";
    const blockhash = (await ctx.rpc.getLatestBlockhash({ commitment: "confirmed" }).send()).value;
    for (const step of plan.steps.filter((s) => s.simulate === "now")) {
      const result = await simulateUnsigned(
        ctx.rpc,
        buildMessage({ feePayer: step.signer, ixs: step.ixs, blockhash, cuLimit: 1_400_000, cuPrice: config.cuPrice }),
      );
      simulations.set(step.id, result.ok ? `simulated ok, ${result.unitsConsumed ?? "?"} CU` : `SIMULATION FAILED ${summarizeSimulation(result)}`);
    }
    evidence.simulations = Object.fromEntries(simulations);
  }
  printPlan(ctx, plan, simulations, state);
  ctx.log(`NEXT_PUBLIC_KYC_REGISTRY=${map.kyc.registry} (pin it on the operator front before S4)`);
  ctx.log(`plan digest: ${digest}`);
  if (plan.stops.length) throw new ChainPlanError(`bootstrap stopped: ${plan.stops.join("; ")}`);
  if ([...simulations.values()].some((s) => s.startsWith("SIMULATION FAILED"))) {
    throw new ChainPlanError("a step that can run now failed simulation; see the plan output");
  }

  if (!config.send) {
    if (!plan.steps.length) return plan.awaiting.length || plan.blocked.length || plan.handover.reason ? "awaiting" : "completed";
    ctx.log("dry run: nothing sent. Review, then send with CHAIN_SEND=1 CHAIN_KEYPAIR=… CHAIN_CONFIRM_PLAN=<digest>.");
    return "awaiting";
  }
  if (config.confirmPlan !== digest) throw new ChainPlanError("CHAIN_CONFIRM_PLAN does not match the recomputed plan digest");
  if (!plan.steps.length) return plan.awaiting.length || plan.handover.reason ? "awaiting" : "completed";

  ctx.phase = "send";
  const journal = ctx.beginSend();
  journal.append({ event: "plan", digest, steps: plan.steps.map((s) => s.id) });
  const records: StepRecord[] = [];
  evidence.steps = records;
  await executePlan(plan.steps, {
    rpc: ctx.rpc,
    drainRpc: ctx.drainRpc,
    journal,
    cuPrice: config.cuPrice,
    signal: ctx.signal,
    timing: ctx.timing,
    log: ctx.log,
    records,
    probe: () => probeBootstrapState(ctx.rpc, map),
  });

  ctx.phase = "after";
  const after = await probeBootstrapState(ctx.rpc, map);
  evidence.stateAfter = after;
  const next = await planBootstrap(after, map, signers, { rpc: ctx.rpc, handover: { ...handover, inventoryBlockers: null } });
  evidence.next = { steps: next.steps.map((s) => s.id), awaiting: next.awaiting, blocked: next.blocked, handover: next.handover };
  for (const action of next.awaiting) {
    ctx.log(`ACTION REQUIRED ${action.id}: ${action.role} ${action.key} — ${action.action} on ${action.page}`);
  }
  const handedOver = IDL_PROGRAMS.every((name) => after.ua[name] === map.squads.vault);
  return handedOver && !next.awaiting.length ? "completed" : "awaiting";
}
