/**
 * Tool 1: bootstrap (`chain:bootstrap`), design-3.3 §4.
 *
 * probeBootstrapState reads everything at finalized; planBootstrap turns the
 * state and the role map into the reviewed steps of the current cycle. Every
 * instruction is built offline (PDA-deterministic builders); the only read is
 * `requireProgramUpgradeAuthority`, which checks the existing ProgramData.
 *
 * Steps: S1 initialize_platform, S1b set_protocol_treasury, S2
 * initialize_blocklist_authority(deployer), S2b propose BA, S3 add_admin (not
 * the SA), S3k temp KYC admin, S4 create_kyc_registry, S4c jurisdictions,
 * S4b propose KYC, X3/X2/X1 Ledger accepts (external, or rehearsal signers
 * off mainnet), S3r remove the temp grant, S5 propose SA, S6 unpause, S7
 * ProgramData SetAuthority → vault.
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
  AUTHORITY_TRANSFER_DISCRIMINATOR,
  KYC_REGISTRY_DISCRIMINATOR,
  findAdminRecordPda,
  getAcceptPlatformAdminInstructionAsync,
  getAddAdminInstructionAsync,
  getAdminDecoder,
  getAdminSize,
  getAuthorityTransferDecoder,
  getAuthorityTransferSize,
  getKycRegistryDecoder,
  getKycRegistrySize,
  getPlatformSize,
  getProposePlatformAdminInstructionAsync,
  getRemoveAdminInstructionAsync,
  getSetPauseFlagsInstructionAsync,
  getSetProtocolTreasuryInstructionAsync,
  fetchMaybePlatform,
  findPlatformPda,
} from "@/lib/generated/asset_registry";
import {
  getAcceptBlocklistAuthorityInstructionAsync,
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
import { PAUSE_FLAGS_ALL, formatPauseFlags, unknownPauseBits } from "@/lib/pause-flags";
import {
  buildInitializeBlocklistAuthorityInstruction,
  buildInitializePlatformInstruction,
} from "@/lib/program-bootstrap";
import { fetchRawAccount, fetchRawAccounts, hasDiscriminator } from "./accounts";
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
  registry: { authority: Address; approved: Uint8Array; blocked: Uint8Array } | null;
  /** A pending, acceptable KYC registry proposal. */
  registryProposed: Address | null;
  balance: bigint;
};

export function cloneState(state: BootstrapState): BootstrapState {
  return {
    deployed: { ...state.deployed },
    ua: { ...state.ua },
    platform: state.platform ? { ...state.platform } : null,
    platformProposed: state.platformProposed,
    blocklist: state.blocklist ? { ...state.blocklist } : null,
    adminRecords: { ...state.adminRecords },
    registry: state.registry ? { ...state.registry } : null,
    registryProposed: state.registryProposed,
    balance: state.balance,
  };
}

function publicWrap<T>(fn: () => Promise<T>): Promise<T> {
  return fn().catch((error: unknown) => {
    const message = (error as Error)?.message ?? "";
    if (/proposal is stale or invalid|Unexpected (platform|blocklist authority) owner/.test(message)) {
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
  const registry = map.kyc.registry!;
  const transferPda = await findKycRegistryTransferPda(registry);
  const accounts = await fetchRawAccounts(rpc, [...records, registry, transferPda]);
  const adminRecords: Record<string, boolean> = {};
  wallets.forEach((wallet, i) => {
    const account = accounts.get(records[i]);
    adminRecords[wallet] = Boolean(
      account &&
        account.owner === ASSET_REGISTRY_PROGRAM_ADDRESS &&
        hasDiscriminator(account.data, ADMIN_DISCRIMINATOR) &&
        getAdminDecoder().decode(account.data).admin === wallet,
    );
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
  const transfer = accounts.get(transferPda);
  if (registryState && transfer && transfer.owner === ASSET_REGISTRY_PROGRAM_ADDRESS && hasDiscriminator(transfer.data, AUTHORITY_TRANSFER_DISCRIMINATOR)) {
    const value = getAuthorityTransferDecoder().decode(transfer.data);
    if (value.target === registry && value.currentAuthority === registryState.authority && value.proposedBy === registryState.authority) {
      registryProposed = value.newAuthority;
    }
  }
  const balance = await rpc.getBalance(map.deployer, { commitment: "finalized" }).send();
  return {
    deployed,
    ua,
    platform,
    platformProposed: platformAuthority?.proposed ?? null,
    blocklist: blocklistAuthority ? { authority: blocklistAuthority.current, proposed: blocklistAuthority.proposed } : null,
    adminRecords,
    registry: registryState,
    registryProposed,
    balance: balance.value,
  };
}

// ── Plan ─────────────────────────────────────────────────────────────────────

export type BootstrapSigners = {
  deployer: TransactionSigner;
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
  gate?: (done: Map<string, Outcome>, p: BootstrapState) => string | null;
  preconditions: (p: BootstrapState) => Precondition<BootstrapState>[];
  external?: ExternalAction;
  build: (p: BootstrapState, signer: TransactionSigner) => Promise<Instruction[]>;
  apply: (p: BootstrapState) => void;
  postCheck: (s: BootstrapState) => boolean;
  /** Accounts the step creates (for the balance estimate). */
  rentSizes?: number[];
};

const pre = (label: string, holds: (s: BootstrapState) => boolean): Precondition<BootstrapState> => ({ label, holds });
const bitmapsEqual = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));
const BLOCKLIST_TRANSFER_SIZE = 8 + 32 + 32 + 1;
export const SIGNATURE_FEE = BigInt(5000);
export const FEE_MARGIN = BigInt(10_000_000);

/** Builds the ordered step definitions for one map and signer set. */
function stepDefinitions(map: RoleMap, signers: BootstrapSigners, rpc: ChainRpc): StepDef[] {
  const D = map.deployer;
  const SA = map.superAdmin;
  const BA = map.blocklistAuthority;
  const K = map.kyc.authority;
  const V = map.squads.vault;
  const registry = map.kyc.registry!;
  const d = signers.deployer;
  const saSigner = SA === D ? d : signers.rehearsal.superAdmin ?? null;
  const approved = jurisdictionBitmap(map.kyc.approvedJurisdictions);
  const blocked = jurisdictionBitmap(map.kyc.blockedJurisdictions);
  const deployerIsSa = D === SA;
  const unpauseByDeployer = map.unpauseBy === "deployer" || deployerIsSa;
  const cycleOne = ["S1", "S1b", "S2", "S2b", ...map.admins.map((a) => `S3:${a}`), "S3k", "S4", "S4c", "S4b.cancel", "S4b"];

  const defs: StepDef[] = [
    {
      id: "S1",
      title: `initialize_platform(treasury ${V}, fee ${map.protocolFeeBps} bps)`,
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
          protocolTreasury: V,
          protocolFeeBps: map.protocolFeeBps,
        }),
      ],
      apply: (p) => {
        p.platform = { admin: D, protocolTreasury: V, protocolFeeBps: map.protocolFeeBps, pauseFlags: PAUSE_FLAGS_ALL };
        p.adminRecords[D] = true;
      },
      postCheck: (s) => s.platform?.admin === D && s.platform.protocolTreasury === V && s.platform.protocolFeeBps === map.protocolFeeBps,
      rentSizes: [getPlatformSize(), getAdminSize()],
    },
    {
      id: "S1b",
      title: `set_protocol_treasury(${V})`,
      applies: true,
      signerRole: "deployer",
      signer: d,
      skip: (p) => (!p.platform ? "S1 sets the vault as treasury" : p.platform.protocolTreasury === V ? "treasury is the vault" : null),
      preconditions: (p) => {
        const treasury = p.platform?.protocolTreasury;
        return [
          pre(`platform.admin=${D}`, (s) => s.platform?.admin === D),
          pre(`platform.treasury=${treasury}`, (s) => s.platform?.protocolTreasury === treasury),
        ];
      },
      external: { id: "S1b", role: "superAdmin", key: SA, page: "/admin/platform", action: `set the protocol treasury to the vault ${V}` },
      build: async (_p, signer) => [await getSetProtocolTreasuryInstructionAsync({ superAdmin: signer, newTreasury: V })],
      apply: (p) => {
        p.platform!.protocolTreasury = V;
      },
      postCheck: (s) => s.platform?.protocolTreasury === V,
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
      skip: (p) =>
        p.blocklist?.authority === BA ? "BA is the map key" : p.blocklist?.proposed === BA ? "already proposed to the map key" : null,
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
      },
      postCheck: (s) => s.blocklist?.proposed === BA,
      rentSizes: [BLOCKLIST_TRANSFER_SIZE],
    },
    ...map.admins.map(
      (admin): StepDef => ({
        id: `S3:${admin}`,
        title: `add_admin(${admin})`,
        applies: true,
        signerRole: "deployer",
        signer: d,
        skip: (p) => (p.adminRecords[admin] ? "Admin record exists" : null),
        preconditions: () => [pre(`platform.admin=${D}`, (s) => s.platform?.admin === D), pre(`admin(${admin}):absent`, (s) => !s.adminRecords[admin])],
        external: { id: `S3:${admin}`, role: "superAdmin", key: SA, page: "/admin/platform", action: `add Admin ${admin}` },
        build: async (_p, signer) => [await getAddAdminInstructionAsync({ superAdmin: signer, newAdmin: admin })],
        apply: (p) => {
          p.adminRecords[admin] = true;
        },
        postCheck: (s) => Boolean(s.adminRecords[admin]),
        rentSizes: [getAdminSize()],
      }),
    ),
    {
      id: "S3k",
      title: `add_admin(${K}) — temporary KYC grant (D17 fallback)`,
      applies: map.kyc.tempAdminGrant,
      signerRole: "deployer",
      signer: d,
      skip: (p) => (p.adminRecords[K] ? "Admin record exists" : p.registry?.authority === K ? "KYC already accepted" : null),
      preconditions: () => [pre(`platform.admin=${D}`, (s) => s.platform?.admin === D), pre(`admin(${K}):absent`, (s) => !s.adminRecords[K])],
      build: async (_p, signer) => [await getAddAdminInstructionAsync({ superAdmin: signer, newAdmin: K })],
      apply: (p) => {
        p.adminRecords[K] = true;
      },
      postCheck: (s) => Boolean(s.adminRecords[K]),
      rentSizes: [getAdminSize()],
    },
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
      skip: (p) => (!p.registryProposed || p.registryProposed === K ? "no foreign proposal" : null),
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
      },
      postCheck: (s) => s.registryProposed === null,
    },
    {
      id: "S4b",
      title: `propose_kyc_registry_authority → ${K}`,
      applies: true,
      signerRole: "deployer",
      signer: d,
      skip: (p) => (p.registry?.authority === K ? "KYC authority is the map key" : p.registryProposed === K ? "already proposed to the map key" : null),
      preconditions: () => [
        pre(`kycRegistry.authority=${D}`, (s) => s.registry?.authority === D),
        pre("kycRegistry.proposed=none", (s) => s.registryProposed === null),
      ],
      build: async (_p, signer) => [await buildProposeKycAuthority({ authoritySigner: signer, registry, newAuthority: K })],
      apply: (p) => {
        p.registryProposed = K;
      },
      postCheck: (s) => s.registryProposed === K,
      rentSizes: [getAuthorityTransferSize()],
    },
    {
      id: "X3",
      title: `accept_blocklist_authority (${BA})`,
      applies: true,
      signerRole: "blocklistAuthority",
      signer: signers.rehearsal.blocklistAuthority ?? null,
      skip: (p) => (p.blocklist?.authority === BA ? "BA accepted" : null),
      preconditions: () => [pre(`blocklist.proposed=${BA}`, (s) => s.blocklist?.proposed === BA)],
      external: { id: "X3", role: "blocklistAuthority", key: BA, page: "/issuer/authority", action: "accept the blocklist authority, then click Refresh" },
      build: async (_p, signer) => [await getAcceptBlocklistAuthorityInstructionAsync({ newAuthority: signer })],
      apply: (p) => {
        p.blocklist = { authority: BA, proposed: null };
      },
      postCheck: (s) => s.blocklist?.authority === BA,
    },
    {
      id: "S6d",
      title: "set_pause_flags(clear every bit) by the deployer",
      applies: unpauseByDeployer,
      signerRole: "deployer",
      signer: d,
      skip: (p) => (p.platform?.pauseFlags === 0 ? "not paused" : null),
      preconditions: (p) => {
        const flags = p.platform?.pauseFlags ?? 0;
        return [
          pre(`platform.admin=${D}`, (s) => s.platform?.admin === D),
          pre(`platform.pauseFlags=${formatPauseFlags(flags)}`, (s) => s.platform?.pauseFlags === flags),
        ];
      },
      build: async (p, signer) => [
        await getSetPauseFlagsInstructionAsync({
          authority: signer,
          setMask: 0,
          clearMask: PAUSE_FLAGS_ALL | unknownPauseBits(p.platform!.pauseFlags),
        }),
      ],
      apply: (p) => {
        p.platform!.pauseFlags = 0;
      },
      postCheck: (s) => s.platform?.pauseFlags === 0,
    },
    {
      id: "X2",
      title: `accept_kyc_registry_authority (${K})`,
      applies: true,
      signerRole: "kycAuthority",
      signer: signers.rehearsal.kycAuthority ?? null,
      skip: (p) => (p.registry?.authority === K ? "KYC accepted" : null),
      preconditions: () => [pre(`kycRegistry.proposed=${K}`, (s) => s.registryProposed === K)],
      external: {
        id: "X2",
        role: "kyc.authority",
        key: K,
        page: "/admin/kyc",
        action: map.kyc.tempAdminGrant
          ? "accept the KYC registry authority (temporary Admin grant)"
          : "accept the KYC registry authority (needs the 3.1 kycProvider layout gate)",
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
      id: "S5",
      title: `propose_platform_admin → ${SA}`,
      applies: !deployerIsSa,
      signerRole: "deployer",
      signer: d,
      skip: (p) => (p.platform?.admin === SA ? "SA is the platform admin" : p.platformProposed === SA ? "already proposed to the SA" : null),
      gate: (done) => {
        const open = [...cycleOne, ...(map.kyc.tempAdminGrant ? ["S3r"] : [])].filter(
          (id) => done.has(id) && done.get(id) !== "included" && done.get(id) !== "skipped",
        );
        return open.length ? `waits for ${open.join(", ")}` : null;
      },
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
      },
      postCheck: (s) => s.platformProposed === SA,
      rentSizes: [getAuthorityTransferSize()],
    },
    {
      id: "X1",
      title: `accept_platform_admin (${SA})`,
      applies: !deployerIsSa,
      signerRole: "superAdmin",
      signer: deployerIsSa ? null : signers.rehearsal.superAdmin ?? null,
      skip: (p) => (p.platform?.admin === SA ? "SA accepted" : null),
      preconditions: () => [pre(`platform.proposed=${SA}`, (s) => s.platformProposed === SA)],
      external: { id: "X1", role: "superAdmin", key: SA, page: "/issuer/authority", action: "accept the platform admin, then click Refresh" },
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
      },
      postCheck: (s) => s.platform?.admin === SA,
    },
    {
      id: "S6",
      title: "set_pause_flags(clear every bit) by the superAdmin",
      applies: !unpauseByDeployer,
      signerRole: "superAdmin",
      signer: saSigner,
      skip: (p) => (p.platform?.pauseFlags === 0 ? "not paused" : null),
      preconditions: (p) => {
        const flags = p.platform?.pauseFlags ?? 0;
        return [
          pre(`platform.admin=${SA}`, (s) => s.platform?.admin === SA),
          pre(`platform.pauseFlags=${formatPauseFlags(flags)}`, (s) => s.platform?.pauseFlags === flags),
        ];
      },
      external: { id: "S6", role: "superAdmin", key: SA, page: "/issuer/authority", action: 'clear every pause bit in the PauseFlagsPanel ("Resume everything")' },
      build: async (p, signer) => [
        await getSetPauseFlagsInstructionAsync({
          authority: signer,
          setMask: 0,
          clearMask: PAUSE_FLAGS_ALL | unknownPauseBits(p.platform!.pauseFlags),
        }),
      ],
      apply: (p) => {
        p.platform!.pauseFlags = 0;
      },
      postCheck: (s) => s.platform?.pauseFlags === 0,
    },
  ];
  return defs;
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
    const gate = def.gate?.(done, p);
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
    plan.notes.push(`S2b overwrites a pending blocklist proposal to ${state.blocklist.proposed} (proposals cannot be cancelled)`);
  }
  if (included.has("S5") && state.platformProposed && state.platformProposed !== map.superAdmin) {
    plan.notes.push(`S5 overwrites a pending platform admin proposal to ${state.platformProposed} (proposals cannot be cancelled)`);
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
    else if (state.platform && state.platform.pauseFlags !== 0 && !h.whilePaused) reason = "S6 (unpause) is not done; or set CHAIN_HANDOVER_WHILE_PAUSED=1";
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
      if (!h.whilePaused) labels.push(pre("platform.pauseFlags=0x00", (s) => s.platform?.pauseFlags === 0));
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

// ── Tool ────────────────────────────────────────────────────────────────────

function printPlan(ctx: ToolContext, plan: BootstrapPlan, simulations: Map<string, string>) {
  ctx.log("id          signer              simulate  action");
  for (const step of plan.steps) {
    const sim = simulations.get(step.id) ?? (step.simulate === "at-send" ? `deferred: depends on ${step.dependsOn ?? "an earlier step"}` : "");
    ctx.log(`${step.id.padEnd(11)} ${step.signerRole.padEnd(19)} ${step.simulate.padEnd(9)} ${step.title}${sim ? `  [${sim}]` : ""}`);
  }
  for (const skip of plan.skipped) ctx.log(`${skip.id.padEnd(11)} skipped: ${skip.reason}`);
  for (const blocked of plan.blocked) ctx.log(`${blocked.id.padEnd(11)} waiting: ${blocked.reason}`);
  for (const action of plan.awaiting) {
    ctx.log(`ACTION REQUIRED ${action.id}: ${action.role} ${action.key} — ${action.action} on ${action.page} (operator front)`);
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
  const roleKey: Record<RehearsalRole, Address> = {
    superAdmin: map.superAdmin,
    blocklistAuthority: map.blocklistAuthority,
    kycAuthority: map.kyc.authority,
  };
  const rehearsal: BootstrapSigners["rehearsal"] = {};
  for (const role of Object.keys(config.rehearsalSigners) as RehearsalRole[]) {
    rehearsal[role] = config.send
      ? await loadHotSigner(config.rehearsalSigners[role]!, roleKey[role], `rehearsal ${role}`)
      : createNoopSigner(roleKey[role]);
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
  printPlan(ctx, plan, simulations);
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
