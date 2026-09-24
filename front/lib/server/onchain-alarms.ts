// SERVER-ONLY — on-chain alarms (Talas 4.4b), instruction-first.
//
// Every alarm is detected from the INSTRUCTION (top-level or inner, ALT keys
// resolved), never from logs: a truncated log or a Squads CPI must not hide
// a pause, a treasury change or an upgrade. An event of the same invocation
// (asset_registry frames only) refines it: old/new values, blocked_by, the
// reclaim kind. A missing event never lowers the severity; where the event
// would decide it, the conservative value is used.
//
// alarmsForTransaction() is pure. processEventJob / reconcileEventJobs run
// the onchain_event_jobs queue: a finalized getTransaction, the alarms and
// ledger jobs written FIRST, the job completed after; an exhausted deadline
// stays pending and is never written as a verdict; job rows hold fixed codes.

import "server-only";
import {
  getAddressEncoder,
  getProgramDerivedAddress,
  type Address,
} from "@solana/kit";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ACCEPT_CUSTODY_AUTHORITY_DISCRIMINATOR,
  ACCEPT_ISSUER_AUTHORITY_DISCRIMINATOR,
  ACCEPT_KYC_REGISTRY_AUTHORITY_DISCRIMINATOR,
  ACCEPT_PLATFORM_ADMIN_DISCRIMINATOR,
  ADD_ADMIN_DISCRIMINATOR,
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  CANCEL_ISSUER_AUTHORITY_TRANSFER_DISCRIMINATOR,
  CANCEL_ISSUER_RECOVERY_DISCRIMINATOR,
  CANCEL_KYC_REGISTRY_AUTHORITY_TRANSFER_DISCRIMINATOR,
  CLAWBACK_BLOCKLISTED_HOLDER_DISCRIMINATOR,
  CLAWBACK_FROM_HOLDER_DISCRIMINATOR,
  CREATE_KYC_REGISTRY_DISCRIMINATOR,
  EXECUTE_ISSUER_RECOVERY_DISCRIMINATOR,
  MINT_TO_TREASURY_DISCRIMINATOR,
  PROPOSE_CUSTODY_AUTHORITY_DISCRIMINATOR,
  PROPOSE_ISSUER_AUTHORITY_DISCRIMINATOR,
  PROPOSE_ISSUER_RECOVERY_DISCRIMINATOR,
  PROPOSE_KYC_REGISTRY_AUTHORITY_DISCRIMINATOR,
  PROPOSE_PLATFORM_ADMIN_DISCRIMINATOR,
  RECLAIM_RENT_DISCRIMINATOR,
  RECOVER_ISSUER_REGISTRATION_DISCRIMINATOR,
  REMOVE_ADMIN_DISCRIMINATOR,
  SET_ISSUER_PERMISSIONS_DISCRIMINATOR,
  SET_PAUSE_DISCRIMINATOR,
  SET_PAUSE_FLAGS_DISCRIMINATOR,
  SET_PROTOCOL_TREASURY_DISCRIMINATOR,
  UPDATE_KYC_REGISTRY_JURISDICTIONS_DISCRIMINATOR,
  VERIFY_ISSUER_KYB_DISCRIMINATOR,
  getAddAdminInstructionDataDecoder,
  getClawbackBlocklistedHolderInstructionDataDecoder,
  getClawbackFromHolderInstructionDataDecoder,
  getCreateKycRegistryInstructionDataDecoder,
  getProposeCustodyAuthorityInstructionDataDecoder,
  getProposeIssuerAuthorityInstructionDataDecoder,
  getProposeIssuerRecoveryInstructionDataDecoder,
  getProposeKycRegistryAuthorityInstructionDataDecoder,
  getProposePlatformAdminInstructionDataDecoder,
  getRemoveAdminInstructionDataDecoder,
  getSetIssuerPermissionsInstructionDataDecoder,
  getSetPauseFlagsInstructionDataDecoder,
  getSetPauseInstructionDataDecoder,
  getSetProtocolTreasuryInstructionDataDecoder,
  getUpdateKycRegistryJurisdictionsInstructionDataDecoder,
  getVerifyIssuerKybInstructionDataDecoder,
} from "@/lib/generated/asset_registry";
import {
  ACCEPT_BLOCKLIST_AUTHORITY_DISCRIMINATOR,
  INITIALIZE_BLOCKLIST_AUTHORITY_DISCRIMINATOR,
  PROPOSE_BLOCKLIST_AUTHORITY_DISCRIMINATOR,
  TRANSFER_HOOK_PROGRAM_ADDRESS,
  UPDATE_TRANSFER_HOOK_CONFIG_DISCRIMINATOR,
  getInitializeBlocklistAuthorityInstructionDataDecoder,
  getProposeBlocklistAuthorityInstructionDataDecoder,
} from "@/lib/generated/transfer_hook";
import { detectNetwork, type Network } from "@/lib/network";
import { PAUSE_FLAGS_ALL, describePausedAreas, formatPauseFlags } from "@/lib/pause-flags";
import { decodeRegistryEvent, type EventValue } from "@/lib/server/onchain-events";
import { finalizedTransaction } from "@/lib/server/sale-capacity-chain";
import { raiseSystemAlert, type Severity } from "@/lib/server/system-alerts";
import { transactionInvocations, type AttributedInvocation, type InvocationTx } from "@/lib/server/tx-invocations";
import { getSupabaseAdmin } from "@/lib/supabase-server";

export const BPF_LOADER_UPGRADEABLE = "BPFLoaderUpgradeab1e11111111111111111111111";
/** Loader v4: after a Migrate our programs would be owned by it (account 0 = the program). */
export const LOADER_V4 = "LoaderV411111111111111111111111111111111111";
/** Issuer capability bit that allows minting (lib/issuer-permissions.ts). */
const CAP_MINT = 1;
/** RentReclaimed.kind for a KYC entry (program constants RECLAIM_KYC). */
const RECLAIM_KYC = 3;

export type AlarmFormat = "platform" | "minimal";
export type OnchainAlarm = {
  dedupKey: string;
  source: string;
  severity: Severity;
  summary: string;
  evidence: Record<string, unknown>;
  format: AlarmFormat;
};
export type LedgerJobInput = { kind: "treasury_mint"; ref: string; sharePda: string };
export type ProgramDataAddresses = { assetRegistry: string; transferHook: string };

type Events = Record<string, Record<string, EventValue>>;
type Ctx = {
  args: Record<string, unknown> | null;
  account: (i: number) => string | undefined;
  events: Events;
};
type Classified = { source: string; severity: Severity; summary: string; evidence?: Record<string, unknown> } | null;

type Entry = {
  name: string;
  program: string;
  discriminator: Uint8Array;
  /** Instruction-data decoder (null: no arguments). */
  decode: ((data: Uint8Array) => Record<string, unknown>) | null;
  /** IDL account indices included in the evidence (pinned by a test). */
  accounts: Record<string, number>;
  format: AlarmFormat;
  /** Used when the arguments cannot be decoded: the most severe outcome. */
  fallback: Severity;
  /** Only `classify` evidence reaches the alert for the minimal (holder or
   * issuer related) format; the platform format also carries the decoded
   * arguments (design §4.1, §8.5). */
  classify: (ctx: Ctx) => Classified;
};

const dec = <T extends object>(decoder: { decode: (b: Uint8Array) => T }) => (data: Uint8Array) =>
  decoder.decode(data) as unknown as Record<string, unknown>;

const pauseLabel = (flags: number) => describePausedAreas(flags) || "nothing paused";

function pauseClassify(setMask: number, clearMask: number, ev: Record<string, EventValue> | undefined): Classified {
  const old = typeof ev?.old === "number" ? ev.old : null;
  const now = typeof ev?.new === "number" ? ev.new : null;
  const noop = old !== null && now !== null && old === now;
  const change = old !== null && now !== null ? ` (${formatPauseFlags(old)} → ${formatPauseFlags(now)}: ${pauseLabel(now)})` : "";
  if (clearMask !== 0) {
    return { source: "onchain:pause", severity: noop ? "low" : "critical", summary: `Pause flags cleared (unpause)${change}` };
  }
  if (setMask !== 0) {
    const full = setMask === PAUSE_FLAGS_ALL || now === PAUSE_FLAGS_ALL;
    return { source: "onchain:pause", severity: noop ? "low" : full ? "critical" : "high", summary: `Pause flags set${change}` };
  }
  return { source: "onchain:pause", severity: "low", summary: `Pause flags unchanged${change}` };
}

const disc = (d: Uint8Array | readonly number[]) => new Uint8Array(d);

/** The instruction catalogue (design §4.1). */
export const ALARM_INSTRUCTIONS: readonly Entry[] = [
  { name: "set_pause", program: ASSET_REGISTRY_PROGRAM_ADDRESS, discriminator: disc(SET_PAUSE_DISCRIMINATOR),
    decode: dec(getSetPauseInstructionDataDecoder()), accounts: { admin: 0, platform: 1 }, format: "platform", fallback: "critical",
    classify: ({ args, events }) => args?.paused
      ? pauseClassify(0x01, 0, events.PauseFlagsChanged)
      : pauseClassify(0, 0x01, events.PauseFlagsChanged) },
  { name: "set_pause_flags", program: ASSET_REGISTRY_PROGRAM_ADDRESS, discriminator: disc(SET_PAUSE_FLAGS_DISCRIMINATOR),
    decode: dec(getSetPauseFlagsInstructionDataDecoder()), accounts: { authority: 0, platform: 2 }, format: "platform", fallback: "critical",
    classify: ({ args, events }) => {
      const r = pauseClassify(Number(args?.setMask ?? 0), Number(args?.clearMask ?? 0), events.PauseFlagsChanged);
      return r && { ...r, evidence: { set_mask: Number(args?.setMask ?? 0), clear_mask: Number(args?.clearMask ?? 0) } };
    } },
  { name: "set_protocol_treasury", program: ASSET_REGISTRY_PROGRAM_ADDRESS, discriminator: disc(SET_PROTOCOL_TREASURY_DISCRIMINATOR),
    decode: dec(getSetProtocolTreasuryInstructionDataDecoder()), accounts: { super_admin: 0, platform: 1 }, format: "platform", fallback: "critical",
    classify: ({ args, events }) => ({ source: "onchain:treasury", severity: "critical",
      summary: `Protocol treasury set to ${String(args?.newTreasury)}`,
      evidence: { new_treasury: args?.newTreasury, old_treasury: events.ProtocolTreasuryChanged?.old ?? null } }) },
  { name: "propose_platform_admin", program: ASSET_REGISTRY_PROGRAM_ADDRESS, discriminator: disc(PROPOSE_PLATFORM_ADMIN_DISCRIMINATOR),
    decode: dec(getProposePlatformAdminInstructionDataDecoder()), accounts: { authority: 0 }, format: "platform", fallback: "high",
    classify: ({ args }) => ({ source: "onchain:platform-admin", severity: "high",
      summary: `Super admin transfer proposed to ${String(args?.newAdmin)}`, evidence: { new_admin: args?.newAdmin } }) },
  { name: "accept_platform_admin", program: ASSET_REGISTRY_PROGRAM_ADDRESS, discriminator: disc(ACCEPT_PLATFORM_ADMIN_DISCRIMINATOR),
    decode: null, accounts: { new_admin: 0 }, format: "platform", fallback: "critical",
    classify: ({ account }) => ({ source: "onchain:platform-admin", severity: "critical",
      summary: `Super admin transfer accepted by ${account(0)}` }) },
  { name: "add_admin", program: ASSET_REGISTRY_PROGRAM_ADDRESS, discriminator: disc(ADD_ADMIN_DISCRIMINATOR),
    decode: dec(getAddAdminInstructionDataDecoder()), accounts: { super_admin: 0, admin_record: 2 }, format: "platform", fallback: "high",
    classify: ({ args }) => ({ source: "onchain:admin-record", severity: "high", summary: `Admin added: ${String(args?.newAdmin)}`,
      evidence: { admin: args?.newAdmin } }) },
  { name: "remove_admin", program: ASSET_REGISTRY_PROGRAM_ADDRESS, discriminator: disc(REMOVE_ADMIN_DISCRIMINATOR),
    decode: dec(getRemoveAdminInstructionDataDecoder()), accounts: { super_admin: 0, admin_record: 2 }, format: "platform", fallback: "high",
    classify: ({ args }) => ({ source: "onchain:admin-record", severity: "high", summary: `Admin removed: ${String(args?.admin)}`,
      evidence: { admin: args?.admin } }) },
  { name: "propose_custody_authority", program: ASSET_REGISTRY_PROGRAM_ADDRESS, discriminator: disc(PROPOSE_CUSTODY_AUTHORITY_DISCRIMINATOR),
    decode: dec(getProposeCustodyAuthorityInstructionDataDecoder()), accounts: { super_admin: 0, custody_vault: 2 }, format: "platform", fallback: "medium",
    classify: ({ args }) => ({ source: "onchain:custody-authority", severity: "medium",
      summary: `Custody authority transfer proposed to ${String(args?.newAuthority)}`, evidence: { new_authority: args?.newAuthority } }) },
  { name: "accept_custody_authority", program: ASSET_REGISTRY_PROGRAM_ADDRESS, discriminator: disc(ACCEPT_CUSTODY_AUTHORITY_DISCRIMINATOR),
    decode: null, accounts: { new_authority: 0, custody_vault: 2 }, format: "platform", fallback: "high",
    classify: ({ account }) => ({ source: "onchain:custody-authority", severity: "high",
      summary: `Custody authority transfer accepted by ${account(0)}` }) },
  { name: "set_issuer_permissions", program: ASSET_REGISTRY_PROGRAM_ADDRESS, discriminator: disc(SET_ISSUER_PERMISSIONS_DISCRIMINATOR),
    decode: dec(getSetIssuerPermissionsInstructionDataDecoder()), accounts: { super_admin: 0, issuer: 2, permissions: 3 }, format: "minimal", fallback: "critical",
    classify: ({ args }) => {
      const caps = Number(args?.capabilities ?? 0xff);
      return { source: "onchain:issuer-permissions", severity: caps & CAP_MINT ? "critical" : caps !== 0 ? "high" : "medium",
        summary: caps === 0 ? "Issuer permissions revoked" : `Issuer permissions set (capabilities ${caps})`, evidence: { capabilities: caps } };
    } },
  { name: "verify_issuer_kyb", program: ASSET_REGISTRY_PROGRAM_ADDRESS, discriminator: disc(VERIFY_ISSUER_KYB_DISCRIMINATOR),
    decode: dec(getVerifyIssuerKybInstructionDataDecoder()), accounts: { admin: 0, issuer: 2 }, format: "minimal", fallback: "high",
    classify: ({ args }) => ({ source: "onchain:issuer-kyb", severity: args?.approved === true ? "low" : "high",
      summary: args?.approved === true ? "Issuer KYB verified" : "Issuer KYB rejected or withdrawn", evidence: { approved: args?.approved === true } }) },
  { name: "recover_issuer_registration", program: ASSET_REGISTRY_PROGRAM_ADDRESS, discriminator: disc(RECOVER_ISSUER_REGISTRATION_DISCRIMINATOR),
    decode: null, accounts: { super_admin: 0, issuer: 2, new_authority: 3 }, format: "minimal", fallback: "high",
    classify: () => ({ source: "onchain:issuer-recovery", severity: "high", summary: "Issuer registration recovered" }) },
  { name: "propose_issuer_authority", program: ASSET_REGISTRY_PROGRAM_ADDRESS, discriminator: disc(PROPOSE_ISSUER_AUTHORITY_DISCRIMINATOR),
    decode: dec(getProposeIssuerAuthorityInstructionDataDecoder()), accounts: { authority: 0, issuer: 1 }, format: "minimal", fallback: "medium",
    classify: ({ args }) => ({ source: "onchain:issuer-authority", severity: "medium", summary: "Issuer authority transfer proposed",
      evidence: { new_authority: args?.newAuthority } }) },
  { name: "accept_issuer_authority", program: ASSET_REGISTRY_PROGRAM_ADDRESS, discriminator: disc(ACCEPT_ISSUER_AUTHORITY_DISCRIMINATOR),
    decode: null, accounts: { new_authority: 0, issuer: 1 }, format: "minimal", fallback: "medium",
    classify: ({ events }) => ({ source: "onchain:issuer-authority", severity: "medium", summary: "Issuer authority transfer accepted",
      evidence: events.IssuerAuthorityChanged ? { old_authority: events.IssuerAuthorityChanged.old_authority,
        kind: events.IssuerAuthorityChanged.kind, capabilities_carried: events.IssuerAuthorityChanged.capabilities_carried } : {} }) },
  { name: "cancel_issuer_authority_transfer", program: ASSET_REGISTRY_PROGRAM_ADDRESS, discriminator: disc(CANCEL_ISSUER_AUTHORITY_TRANSFER_DISCRIMINATOR),
    decode: null, accounts: { authority: 0, issuer: 1 }, format: "minimal", fallback: "low",
    classify: () => ({ source: "onchain:issuer-authority", severity: "low", summary: "Issuer authority transfer cancelled" }) },
  { name: "propose_issuer_recovery", program: ASSET_REGISTRY_PROGRAM_ADDRESS, discriminator: disc(PROPOSE_ISSUER_RECOVERY_DISCRIMINATOR),
    decode: dec(getProposeIssuerRecoveryInstructionDataDecoder()), accounts: { super_admin: 0, issuer: 2, recovery: 3 }, format: "minimal", fallback: "high",
    classify: ({ args, events }) => ({ source: "onchain:issuer-recovery", severity: "high", summary: "Issuer key recovery proposed",
      evidence: { new_authority: args?.newAuthority, eta: events.IssuerRecoveryProposed?.eta ?? null } }) },
  { name: "cancel_issuer_recovery", program: ASSET_REGISTRY_PROGRAM_ADDRESS, discriminator: disc(CANCEL_ISSUER_RECOVERY_DISCRIMINATOR),
    decode: null, accounts: { canceller: 0, issuer: 2, recovery: 3 }, format: "minimal", fallback: "medium",
    classify: () => ({ source: "onchain:issuer-recovery", severity: "medium", summary: "Issuer key recovery cancelled" }) },
  { name: "execute_issuer_recovery", program: ASSET_REGISTRY_PROGRAM_ADDRESS, discriminator: disc(EXECUTE_ISSUER_RECOVERY_DISCRIMINATOR),
    decode: null, accounts: { new_authority: 0, issuer: 2, recovery: 3 }, format: "minimal", fallback: "high",
    classify: () => ({ source: "onchain:issuer-recovery", severity: "high", summary: "Issuer key recovery executed" }) },
  { name: "create_kyc_registry", program: ASSET_REGISTRY_PROGRAM_ADDRESS, discriminator: disc(CREATE_KYC_REGISTRY_DISCRIMINATOR),
    decode: dec(getCreateKycRegistryInstructionDataDecoder()), accounts: { authority: 0, kyc_registry: 3 }, format: "platform", fallback: "medium",
    classify: ({ account }) => ({ source: "onchain:kyc-registry", severity: "medium", summary: `KYC registry created: ${account(3)}` }) },
  { name: "propose_kyc_registry_authority", program: ASSET_REGISTRY_PROGRAM_ADDRESS, discriminator: disc(PROPOSE_KYC_REGISTRY_AUTHORITY_DISCRIMINATOR),
    decode: dec(getProposeKycRegistryAuthorityInstructionDataDecoder()), accounts: { authority: 0, kyc_registry: 1 }, format: "platform", fallback: "medium",
    classify: ({ args, account }) => ({ source: "onchain:kyc-registry", severity: "medium",
      summary: `KYC registry ${account(1)} authority transfer proposed`, evidence: { new_authority: args?.newAuthority } }) },
  { name: "accept_kyc_registry_authority", program: ASSET_REGISTRY_PROGRAM_ADDRESS, discriminator: disc(ACCEPT_KYC_REGISTRY_AUTHORITY_DISCRIMINATOR),
    decode: null, accounts: { new_authority: 0, kyc_registry: 1 }, format: "platform", fallback: "high",
    classify: ({ account }) => ({ source: "onchain:kyc-registry", severity: "high", summary: `KYC registry ${account(1)} authority transfer accepted` }) },
  { name: "cancel_kyc_registry_authority_transfer", program: ASSET_REGISTRY_PROGRAM_ADDRESS, discriminator: disc(CANCEL_KYC_REGISTRY_AUTHORITY_TRANSFER_DISCRIMINATOR),
    decode: null, accounts: { authority: 0, kyc_registry: 1 }, format: "platform", fallback: "low",
    classify: ({ account }) => ({ source: "onchain:kyc-registry", severity: "low", summary: `KYC registry ${account(1)} authority transfer cancelled` }) },
  { name: "update_kyc_registry_jurisdictions", program: ASSET_REGISTRY_PROGRAM_ADDRESS, discriminator: disc(UPDATE_KYC_REGISTRY_JURISDICTIONS_DISCRIMINATOR),
    decode: dec(getUpdateKycRegistryJurisdictionsInstructionDataDecoder()), accounts: { authority: 0, kyc_registry: 1 }, format: "platform", fallback: "high",
    classify: ({ args, account, events }) => {
      const hex = (v: unknown) => v instanceof Uint8Array || Array.isArray(v)
        ? Array.from(v as ArrayLike<number>, (b) => b.toString(16).padStart(2, "0")).join("") : null;
      const ev = events.KycRegistryJurisdictionsUpdated;
      return { source: "onchain:kyc-registry", severity: "high", summary: `KYC registry ${account(1)} jurisdictions updated`,
        evidence: { approved_jurisdictions: ev?.approved_jurisdictions ?? hex(args?.approvedJurisdictions),
          blocked_jurisdictions: ev?.blocked_jurisdictions ?? hex(args?.blockedJurisdictions) } };
    } },
  { name: "clawback_from_holder", program: ASSET_REGISTRY_PROGRAM_ADDRESS, discriminator: disc(CLAWBACK_FROM_HOLDER_DISCRIMINATOR),
    decode: dec(getClawbackFromHolderInstructionDataDecoder()), accounts: { authority: 0, share_class: 2, custody_vault: 7 }, format: "minimal", fallback: "medium",
    classify: ({ events }) => ({ source: "onchain:clawback", severity: "medium", summary: "KYC clawback from a holder",
      evidence: { reason: events.HolderClawback?.reason ?? null } }) },
  { name: "clawback_blocklisted_holder", program: ASSET_REGISTRY_PROGRAM_ADDRESS, discriminator: disc(CLAWBACK_BLOCKLISTED_HOLDER_DISCRIMINATOR),
    decode: dec(getClawbackBlocklistedHolderInstructionDataDecoder()), accounts: { authority: 0, share_class: 2, block_entry: 6, custody_vault: 8 }, format: "minimal", fallback: "high",
    classify: ({ events }) => {
      const ev = events.BlocklistClawback;
      // One key both blocked and seized: high. Two keys: medium. Unknown: high.
      const sameKey = ev ? ev.admin === ev.blocked_by : true;
      return { source: "onchain:clawback", severity: sameKey ? "high" : "medium",
        summary: sameKey ? "Blocklist clawback (blocked and seized by the same key, or unknown)" : "Blocklist clawback",
        evidence: { blocked_by: ev?.blocked_by ?? null, admin: ev?.admin ?? null } };
    } },
  { name: "reclaim_rent", program: ASSET_REGISTRY_PROGRAM_ADDRESS, discriminator: disc(RECLAIM_RENT_DISCRIMINATOR),
    decode: null, accounts: { caller: 0, owner: 1, target: 2 }, format: "minimal", fallback: "low",
    classify: ({ events }) => {
      const ev = events.RentReclaimed;
      if (ev && ev.kind !== RECLAIM_KYC) return null;
      return { source: "onchain:kyc-reclaim", severity: "low", summary: ev ? "KYC entry rent reclaimed" : "Rent reclaimed (kind unknown)",
        evidence: { kind: ev?.kind ?? null } };
    } },
  // transfer_hook
  { name: "initialize_blocklist_authority", program: TRANSFER_HOOK_PROGRAM_ADDRESS, discriminator: disc(INITIALIZE_BLOCKLIST_AUTHORITY_DISCRIMINATOR),
    decode: dec(getInitializeBlocklistAuthorityInstructionDataDecoder()), accounts: { payer: 0, blocklist_authority: 1 }, format: "platform", fallback: "high",
    classify: ({ args }) => ({ source: "onchain:blocklist-authority", severity: "high",
      summary: `Blocklist authority initialized: ${String(args?.authority)}`, evidence: { authority: args?.authority } }) },
  { name: "propose_blocklist_authority", program: TRANSFER_HOOK_PROGRAM_ADDRESS, discriminator: disc(PROPOSE_BLOCKLIST_AUTHORITY_DISCRIMINATOR),
    decode: dec(getProposeBlocklistAuthorityInstructionDataDecoder()), accounts: { authority: 0, blocklist_authority: 1 }, format: "platform", fallback: "high",
    classify: ({ args }) => ({ source: "onchain:blocklist-authority", severity: "high",
      summary: `Blocklist authority transfer proposed to ${String(args?.newAuthority)}`, evidence: { new_authority: args?.newAuthority } }) },
  { name: "accept_blocklist_authority", program: TRANSFER_HOOK_PROGRAM_ADDRESS, discriminator: disc(ACCEPT_BLOCKLIST_AUTHORITY_DISCRIMINATOR),
    decode: null, accounts: { new_authority: 0, blocklist_authority: 1 }, format: "platform", fallback: "critical",
    classify: ({ account }) => ({ source: "onchain:blocklist-authority", severity: "critical",
      summary: `Blocklist authority transfer accepted by ${account(0)}` }) },
  { name: "update_transfer_hook_config", program: TRANSFER_HOOK_PROGRAM_ADDRESS, discriminator: disc(UPDATE_TRANSFER_HOOK_CONFIG_DISCRIMINATOR),
    decode: null, accounts: { authority: 0, mint: 2, config: 3 }, format: "platform", fallback: "high",
    classify: ({ account }) => ({ source: "onchain:hook-config", severity: "high", summary: `Transfer hook configuration of mint ${account(2)} changed` }) },
];

/** Upgradeable-loader instruction tags that act on a ProgramData account (bincode u32 LE). */
export const LOADER_TAGS: Readonly<Record<number, { name: string; severity: Severity }>> = {
  3: { name: "Upgrade", severity: "critical" },
  4: { name: "SetAuthority", severity: "critical" },
  5: { name: "Close", severity: "critical" },
  6: { name: "ExtendProgram", severity: "medium" },
  7: { name: "SetAuthorityChecked", severity: "critical" },
  // Moves the program to loader v4 (account 0 = ProgramData, upgrade authority signs).
  8: { name: "Migrate", severity: "critical" },
  9: { name: "ExtendProgramChecked", severity: "medium" },
};

/**
 * Loader-v4 instruction tags (bincode u32 LE); account 0 is the program. Any
 * of them on one of our programs changes its code, authority or
 * executability: all critical. An unknown tag is critical too.
 */
export const LOADER_V4_TAGS: Readonly<Record<number, string>> = {
  0: "Write", 1: "Copy", 2: "SetProgramLength", 3: "Deploy", 4: "Retract", 5: "TransferAuthority", 6: "Finalize",
};

const startsWith = (data: Uint8Array, d: Uint8Array) => data.length >= d.length && d.every((b, i) => data[i] === b);

let programDataCache: Promise<ProgramDataAddresses> | null = null;
/** The two ProgramData PDAs ([programId] under the upgradeable loader), once per process. */
export function programDataAddresses(): Promise<ProgramDataAddresses> {
  programDataCache ??= (async () => {
    const pda = async (program: string) => (await getProgramDerivedAddress({
      programAddress: BPF_LOADER_UPGRADEABLE as Address,
      seeds: [getAddressEncoder().encode(program as Address)],
    }))[0];
    return { assetRegistry: await pda(ASSET_REGISTRY_PROGRAM_ADDRESS), transferHook: await pda(TRANSFER_HOOK_PROGRAM_ADDRESS) };
  })();
  return programDataCache;
}

function eventsOf(inv: AttributedInvocation): { events: Events; layoutErrors: string[] } {
  const events: Events = {};
  const layoutErrors: string[] = [];
  for (const bytes of inv.events) {
    const decoded = decodeRegistryEvent(bytes);
    if ("error" in decoded) layoutErrors.push(decoded.name);
    else if ("data" in decoded && !events[decoded.name]) events[decoded.name] = decoded.data;
  }
  return { events, layoutErrors };
}

function sanitize(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return Array.from(value, (b) => b.toString(16).padStart(2, "0")).join("");
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === "object") {
    if ("__option" in (value as object)) {
      const option = value as { __option: string; value?: unknown };
      return option.__option === "Some" ? sanitize(option.value) : null;
    }
    return Object.fromEntries(Object.entries(value as object).map(([k, v]) => [k, sanitize(v)]));
  }
  return value ?? null;
}

/**
 * Pure: the alarms and ledger jobs of one finalized, successful transaction.
 * `issues` lists what could not be decoded (codes only).
 */
export function alarmsForTransaction(
  network: Network, sig: string, tx: InvocationTx, programData: ProgramDataAddresses,
): { alarms: OnchainAlarm[]; ledgerJobs: LedgerJobInput[]; issues: string[] } {
  void network;
  const alarms: OnchainAlarm[] = [];
  const ledgerJobs: LedgerJobInput[] = [];
  const issues: string[] = [];
  const invocations = transactionInvocations(tx, ASSET_REGISTRY_PROGRAM_ADDRESS);
  const ours = new Set([programData.assetRegistry, programData.transferHook]);
  const programs = new Set<string>([ASSET_REGISTRY_PROGRAM_ADDRESS, TRANSFER_HOOK_PROGRAM_ADDRESS]);
  for (const inv of invocations) {
    const base = { program: inv.programId, ordinal: inv.ordinal, inner: inv.inner };
    if (inv.programId === LOADER_V4) {
      if (!programs.has(inv.accounts[0])) continue;
      const tag = inv.data.length >= 4 ? new DataView(inv.data.buffer, inv.data.byteOffset, inv.data.byteLength).getUint32(0, true) : null;
      const name = (tag !== null && LOADER_V4_TAGS[tag]) || `instruction ${tag ?? "?"}`;
      const which = inv.accounts[0] === ASSET_REGISTRY_PROGRAM_ADDRESS ? "asset_registry" : "transfer_hook";
      alarms.push({
        dedupKey: `onchain:${sig}:${inv.ordinal}`, source: "onchain:program-upgrade", severity: "critical", format: "platform",
        summary: `Loader v4 ${name} on the ${which} program`,
        evidence: { ...base, instruction: `loader-v4:${name}`, target_program: which, accounts: inv.accounts.slice(0, 4), event_state: "complete" },
      });
      continue;
    }
    if (inv.programId === BPF_LOADER_UPGRADEABLE) {
      if (inv.data.length < 4 || !ours.has(inv.accounts[0])) continue;
      const tag = new DataView(inv.data.buffer, inv.data.byteOffset, inv.data.byteLength).getUint32(0, true);
      const op = LOADER_TAGS[tag];
      if (!op) continue;
      const which = inv.accounts[0] === programData.assetRegistry ? "asset_registry" : "transfer_hook";
      alarms.push({
        dedupKey: `onchain:${sig}:${inv.ordinal}`, source: "onchain:program-upgrade", severity: op.severity, format: "platform",
        summary: `Loader ${op.name} on the ${which} program`,
        evidence: { ...base, instruction: `loader:${op.name}`, program_data: inv.accounts[0], target_program: which,
          accounts: inv.accounts.slice(0, 4), event_state: "complete" },
      });
      continue;
    }
    if (inv.programId === ASSET_REGISTRY_PROGRAM_ADDRESS && startsWith(inv.data, MINT_TO_TREASURY_DISCRIMINATOR as Uint8Array)) {
      if (inv.accounts[4]) {
        if (!ledgerJobs.some((j) => j.ref === sig)) ledgerJobs.push({ kind: "treasury_mint", ref: sig, sharePda: inv.accounts[4] });
      } else issues.push("MINT_ACCOUNTS");
      continue;
    }
    const entry = ALARM_INSTRUCTIONS.find((e) => e.program === inv.programId && startsWith(inv.data, e.discriminator));
    if (!entry) continue;
    let args: Record<string, unknown> | null = null;
    if (entry.decode) {
      try {
        args = entry.decode(inv.data);
      } catch {
        issues.push("INSTRUCTION_DATA");
      }
    }
    const { events, layoutErrors } = inv.programId === ASSET_REGISTRY_PROGRAM_ADDRESS
      ? eventsOf(inv) : { events: {}, layoutErrors: [] };
    const ctx: Ctx = { args, account: (i) => inv.accounts[i], events };
    let classified: Classified;
    if (entry.decode && !args) {
      classified = { source: entry.classify({ ...ctx, args: {} })?.source ?? "onchain:decode", severity: entry.fallback,
        summary: `${entry.name}: arguments could not be decoded` };
    } else {
      classified = entry.classify(ctx);
    }
    const accounts = Object.fromEntries(Object.entries(entry.accounts).map(([name, i]) => [name, inv.accounts[i] ?? null]));
    if (classified) {
      alarms.push({
        dedupKey: `onchain:${sig}:${inv.ordinal}`, source: classified.source, severity: classified.severity, format: entry.format,
        summary: classified.summary.slice(0, 500),
        // Minimal format: never the raw arguments (a holder's wallet or amount), only the entry's own evidence.
        evidence: sanitize({ ...base, instruction: entry.name, accounts, ...(args && entry.format === "platform" ? { args: Object.fromEntries(
          Object.entries(args).filter(([k]) => k !== "discriminator")) } : {}), ...classified.evidence,
          event_state: inv.eventState }) as Record<string, unknown>,
      });
    }
    if (layoutErrors.length) {
      alarms.push({
        dedupKey: `onchain:${sig}:${inv.ordinal}:decode`, source: "onchain:decode", severity: "medium", format: "minimal",
        summary: `Event layout mismatch in ${entry.name} (${[...new Set(layoutErrors)].join(", ")}): check the IDL`,
        evidence: { ...base, instruction: entry.name, events: [...new Set(layoutErrors)], event_state: inv.eventState },
      });
    }
  }
  return { alarms, ledgerJobs, issues };
}

// ── Job processing ─────────────────────────────────────────────────────────

export type EventJob = {
  id: string;
  network: string;
  signature: string;
  source: "webhook" | "gap-scan";
  status: string;
  attempts: number;
  created_at: string;
};
export type JobCounts = { complete: number; pending: number; invalid: number };

const WEBHOOK_FINALITY_WAIT_MS = 30 * 60_000;
const GAP_SCAN_FINALITY_WAIT_MS = 24 * 3_600_000;
const CONCURRENCY = 3;

function databaseSignal(signal: AbortSignal) {
  return AbortSignal.any([signal, AbortSignal.timeout(8_000)]);
}
const backoff = (attempts: number) => Math.min(60_000 * 2 ** Math.min(attempts, 10), 3_600_000);

async function writeJob(sb: SupabaseClient, job: EventJob, fields: Record<string, unknown>, signal: AbortSignal) {
  const { error } = await sb.from("onchain_event_jobs").update(fields).eq("id", job.id).eq("network", job.network)
    .neq("status", "complete").abortSignal(databaseSignal(signal));
  if (error) throw new Error("Alarm queue unavailable");
}

/** One job. Returns its state after this attempt. */
export async function processEventJob(
  job: EventJob, signal: AbortSignal, deadlineMs: number, sb: SupabaseClient = getSupabaseAdmin(),
): Promise<"complete" | "pending" | "invalid"> {
  if (job.network !== detectNetwork()) throw new Error("Alarm job belongs to another network");
  if (signal.aborted || Date.now() >= deadlineMs) return "pending";
  const retry = async (code: string, delayMs: number) => {
    if (signal.aborted || Date.now() >= deadlineMs) return "pending" as const;
    await writeJob(sb, job, {
      attempts: job.attempts + 1, last_error: code, next_attempt_at: new Date(Date.now() + delayMs).toISOString(),
    }, signal);
    return "pending" as const;
  };
  const invalid = async (code: string) => {
    if (signal.aborted || Date.now() >= deadlineMs) return "pending" as const;
    await writeJob(sb, job, { status: "invalid", attempts: job.attempts + 1, last_error: code }, signal);
    return "invalid" as const;
  };
  let tx: InvocationTx | null;
  try {
    tx = (await finalizedTransaction(job.signature, signal)) as InvocationTx | null;
  } catch {
    return retry("RPC_UNAVAILABLE", backoff(job.attempts));
  }
  if (signal.aborted || Date.now() >= deadlineMs) return "pending";
  const age = Date.now() - Date.parse(job.created_at);
  if (!tx) {
    if (job.source === "gap-scan") {
      // Its signature was listed as finalized: the node is behind, keep trying.
      return age < GAP_SCAN_FINALITY_WAIT_MS ? retry("RPC_UNAVAILABLE", backoff(job.attempts)) : invalid("NOT_FINALIZED");
    }
    return age < WEBHOOK_FINALITY_WAIT_MS ? retry("NOT_FINALIZED", 30_000) : invalid("NOT_FINALIZED");
  }
  if (!tx.meta) return retry("RPC_UNAVAILABLE", backoff(job.attempts));
  if (tx.transaction?.signatures?.[0] !== job.signature) return invalid("SIGNATURE_MISMATCH");
  if (tx.meta.err !== null) {
    await writeJob(sb, job, { status: "complete", alerts: 0, last_error: null, attempts: job.attempts + 1 }, signal);
    return "complete";
  }
  let result;
  try {
    result = alarmsForTransaction(job.network as Network, job.signature, tx, await programDataAddresses());
  } catch {
    return invalid("MALFORMED_TRANSACTION");
  }
  // Effects first, then the job: a crash in between repeats idempotent writes.
  try {
    for (const alarm of result.alarms) {
      if (signal.aborted || Date.now() >= deadlineMs) return "pending";
      await raiseSystemAlert(sb, {
        network: job.network as Network, dedupKey: alarm.dedupKey, category: "onchain", source: alarm.source,
        severity: alarm.severity, summary: alarm.summary, evidence: alarm.evidence,
        txSignature: job.signature, notify: true,
      }, signal);
    }
    for (const ledger of result.ledgerJobs) {
      const { error } = await sb.from("spv_issuance_jobs").upsert({
        network: job.network, kind: ledger.kind, ref: ledger.ref, share_class_pda: ledger.sharePda,
        observed_signature: job.signature,
      }, { onConflict: "network,kind,ref", ignoreDuplicates: true }).abortSignal(databaseSignal(signal));
      if (error) throw new Error("Ledger queue unavailable");
    }
  } catch {
    return retry("DB_UNAVAILABLE", backoff(job.attempts));
  }
  if (signal.aborted || Date.now() >= deadlineMs) return "pending";
  await writeJob(sb, job, {
    status: "complete", alerts: result.alarms.length, attempts: job.attempts + 1,
    last_error: result.issues.length ? result.issues[0] : null,
  }, signal);
  return "complete";
}

/** The alarm worker's event stage: batches of due jobs, 3 at a time, until the deadline. */
export async function reconcileEventJobs(limit: number, deadlineMs: number, parentSignal?: AbortSignal): Promise<JobCounts> {
  const counts: JobCounts = { complete: 0, pending: 0, invalid: 0 };
  const budget = deadlineMs - Date.now();
  if (budget <= 0 || parentSignal?.aborted) return counts;
  const timeout = AbortSignal.timeout(budget);
  const signal = parentSignal ? AbortSignal.any([parentSignal, timeout]) : timeout;
  const sb = getSupabaseAdmin();
  const seen = new Set<string>();
  while (!signal.aborted && Date.now() < deadlineMs) {
    const { data, error } = await sb.from("onchain_event_jobs")
      .select("id,network,signature,source,status,attempts,created_at")
      .eq("network", detectNetwork()).eq("status", "pending").lte("next_attempt_at", new Date().toISOString())
      .order("next_attempt_at").limit(limit).abortSignal(databaseSignal(signal));
    if (signal.aborted) break;
    if (error) throw new Error("Alarm queue unavailable");
    const batch = ((data ?? []) as EventJob[]).filter((j) => !seen.has(j.id));
    if (!batch.length) break;
    for (let i = 0; i < batch.length; i += CONCURRENCY) {
      if (signal.aborted || Date.now() >= deadlineMs) break;
      const slice = batch.slice(i, i + CONCURRENCY);
      slice.forEach((j) => seen.add(j.id));
      const results = await Promise.allSettled(slice.map((j) => processEventJob(j, signal, deadlineMs, sb)));
      for (const r of results) {
        if (r.status === "fulfilled") counts[r.value]++;
        else counts.pending++;
      }
    }
    if (batch.length < limit) break;
  }
  return counts;
}
