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
// The same job screens the signers of the entries the platform does not
// mediate (a buy, an OTC offer or take) against the sanctions lists
// (lib/server/onchain-screening.ts, 8.5): a hit is a compliance alert with
// the transaction; a list that cannot answer on mainnet keeps the job
// pending (SANCTIONS_UNAVAILABLE) until it can. A trade or transfer is also
// matched against the authority wallets of frozen issuers
// (lib/server/frozen-issuer-activity.ts, D1 / O-9): a hit is a high alert.
// Last, every buy is checked for its platform link (D2, 2026-10-03,
// lib/server/onchain-link-check.ts): a buyer without the Terms in force
// accepted by 2 minutes after the buy raises a compliance alert with the
// wallet as subject; while those 2 minutes run the job waits (LINK_GRACE).

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
  APPROVE_SALE_DISCRIMINATOR,
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  CANCEL_ADMIN_PROPOSAL_DISCRIMINATOR,
  CANCEL_CUSTODY_AUTHORITY_TRANSFER_DISCRIMINATOR,
  CANCEL_ISSUER_AUTHORITY_TRANSFER_DISCRIMINATOR,
  CANCEL_PLATFORM_ADMIN_TRANSFER_DISCRIMINATOR,
  CANCEL_PLATFORM_RECOVERY_DISCRIMINATOR,
  CANCEL_ISSUER_RECOVERY_DISCRIMINATOR,
  CANCEL_KYC_REGISTRY_AUTHORITY_TRANSFER_DISCRIMINATOR,
  CLAWBACK_BLOCKLISTED_HOLDER_DISCRIMINATOR,
  CLAWBACK_FROM_HOLDER_DISCRIMINATOR,
  CREATE_KYC_REGISTRY_DISCRIMINATOR,
  CREATE_PROPOSAL_DISCRIMINATOR,
  EXECUTE_ISSUER_RECOVERY_DISCRIMINATOR,
  EXECUTE_PLATFORM_RECOVERY_DISCRIMINATOR,
  FREEZE_ISSUER_PROCEEDS_DISCRIMINATOR,
  LOCK_SUPPLY_DISCRIMINATOR,
  MINT_TO_TREASURY_DISCRIMINATOR,
  OPEN_CUSTODY_VAULT_DISCRIMINATOR,
  OPEN_VAULT_VOTE_DISCRIMINATOR,
  PUBLISH_MILESTONE_DISCRIMINATOR,
  RaiseType,
  REALIZE_CUSTODY_VAULT_DISCRIMINATOR,
  RealizeAction,
  REVERT_CUSTODY_VAULT_DISCRIMINATOR,
  ROUTE_YIELD_DISCRIMINATOR,
  TRIGGER_CUSTODY_VAULT_DISCRIMINATOR,
  VaultType,
  PROPOSE_ADMIN_DISCRIMINATOR,
  PROPOSE_CUSTODY_AUTHORITY_DISCRIMINATOR,
  PROPOSE_ISSUER_AUTHORITY_DISCRIMINATOR,
  PROPOSE_ISSUER_RECOVERY_DISCRIMINATOR,
  PROPOSE_KYC_REGISTRY_AUTHORITY_DISCRIMINATOR,
  PROPOSE_PLATFORM_ADMIN_DISCRIMINATOR,
  PROPOSE_PLATFORM_RECOVERY_DISCRIMINATOR,
  RECLAIM_RENT_DISCRIMINATOR,
  RECOVER_ISSUER_REGISTRATION_DISCRIMINATOR,
  REMOVE_ADMIN_DISCRIMINATOR,
  SET_ISSUER_PERMISSIONS_DISCRIMINATOR,
  SET_PAUSE_DISCRIMINATOR,
  SET_PAUSE_FLAGS_DISCRIMINATOR,
  SET_PROTOCOL_TREASURY_DISCRIMINATOR,
  UNFREEZE_ISSUER_PROCEEDS_DISCRIMINATOR,
  UPDATE_KYC_REGISTRY_JURISDICTIONS_DISCRIMINATOR,
  VERIFY_ISSUER_KYB_DISCRIMINATOR,
  getAddAdminInstructionDataDecoder,
  getApproveSaleInstructionDataDecoder,
  getClawbackBlocklistedHolderInstructionDataDecoder,
  getClawbackFromHolderInstructionDataDecoder,
  getCreateKycRegistryInstructionDataDecoder,
  getCreateProposalInstructionDataDecoder,
  getFreezeIssuerProceedsInstructionDataDecoder,
  getOpenCustodyVaultInstructionDataDecoder,
  getOpenVaultVoteInstructionDataDecoder,
  getPublishMilestoneInstructionDataDecoder,
  getRouteYieldInstructionDataDecoder,
  getProposeAdminInstructionDataDecoder,
  getProposeCustodyAuthorityInstructionDataDecoder,
  getProposeIssuerAuthorityInstructionDataDecoder,
  getProposeIssuerRecoveryInstructionDataDecoder,
  getProposeKycRegistryAuthorityInstructionDataDecoder,
  getProposePlatformAdminInstructionDataDecoder,
  getProposePlatformRecoveryInstructionDataDecoder,
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
  CANCEL_BLOCKLIST_AUTHORITY_TRANSFER_DISCRIMINATOR,
  CANCEL_BLOCKLIST_RECOVERY_DISCRIMINATOR,
  EXECUTE_BLOCKLIST_RECOVERY_DISCRIMINATOR,
  INITIALIZE_BLOCKLIST_AUTHORITY_DISCRIMINATOR,
  PROPOSE_BLOCKLIST_AUTHORITY_DISCRIMINATOR,
  PROPOSE_BLOCKLIST_RECOVERY_DISCRIMINATOR,
  TRANSFER_HOOK_PROGRAM_ADDRESS,
  UPDATE_TRANSFER_HOOK_CONFIG_DISCRIMINATOR,
  getInitializeBlocklistAuthorityInstructionDataDecoder,
  getProposeBlocklistAuthorityInstructionDataDecoder,
  getProposeBlocklistRecoveryInstructionDataDecoder,
} from "@/lib/generated/transfer_hook";
import { detectNetwork, type Network } from "@/lib/network";
import {
  EMERGENCY_PAUSE_BITS,
  PAUSE_PAYOUT_MODULES,
  PLATFORM_BOOTSTRAP_OPEN,
  describePausedAreas,
  formatPauseFlags,
} from "@/lib/pause-flags";
import { USDC } from "@/lib/payment-mints";
import { decodeRegistryEvent, type EventValue } from "@/lib/server/onchain-events";
import { checkUnlinkedBuys } from "@/lib/server/onchain-link-check";
import { screenTransactionParties } from "@/lib/server/onchain-screening";
import {
  frozenIssuerActivity,
  frozenIssuerAlerts,
  isTradeOrTransfer,
  loadFrozenIssuerWallets,
} from "@/lib/server/frozen-issuer-activity";
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
/** A vote or proposal window shorter than this is critical / high (prog-vlast-9): too short for holders to react. */
export const SHORT_VOTING_WINDOW_SECONDS = 72 * 3_600;
/**
 * approve_sale at or above this max gross raise in the network's USDC (6
 * decimals: 500,000 USDC) is high; below it medium. Any other payment mint is
 * high (its decimals are not known here).
 */
export const SALE_APPROVAL_HIGH_USDC_UNITS = BigInt(500_000) * BigInt(1_000_000);

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
  network: Network;
  /** The transaction's block time (unix seconds), null when unknown. */
  blockTime: number | null;
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
  // v1.0.0-rc: closing the one-way bootstrap window on its own unpauses nothing.
  if (clearMask === PLATFORM_BOOTSTRAP_OPEN) {
    return { source: "onchain:pause", severity: noop ? "low" : "high", summary: `Bootstrap window closed${change}` };
  }
  // D2: the payout / Merkle modules (0x40) stay off on mainnet. Switching them
  // on (a clear of its own, 6154) or off is an owner decision: critical. The
  // event only lowers it: a set that leaves 0x40 as it was is judged by its
  // other bits below; without the event the bit counts as changed.
  const payoutChanged = old !== null && now !== null ? ((old ^ now) & PAUSE_PAYOUT_MODULES) !== 0 : true;
  if (clearMask & PAUSE_PAYOUT_MODULES) {
    return { source: "onchain:pause", severity: noop ? "low" : "critical",
      summary: `Payout modules switched ON (0x40 cleared: Startup raises, yield routing, Rights-Token issuances, milestones)${change}` };
  }
  if (setMask & PAUSE_PAYOUT_MODULES && payoutChanged) {
    return { source: "onchain:pause", severity: "critical", summary: `Payout modules switched off (0x40 set)${change}` };
  }
  if (clearMask !== 0) {
    return { source: "onchain:pause", severity: noop ? "low" : "critical", summary: `Pause flags cleared (unpause)${change}` };
  }
  if (setMask !== 0) {
    // "Full": every emergency area paused (the payout modules bit 0x40 stays
    // set on mainnet anyway, and bit 7 is not a pause).
    const all = (flags: number | null) => flags !== null && (flags & EMERGENCY_PAUSE_BITS) === EMERGENCY_PAUSE_BITS;
    const full = all(setMask) || all(now);
    return { source: "onchain:pause", severity: noop ? "low" : full ? "critical" : "high", summary: `Pause flags set${change}` };
  }
  return { source: "onchain:pause", severity: "low", summary: `Pause flags unchanged${change}` };
}

const disc = (d: Uint8Array | readonly number[]) => new Uint8Array(d);

/** A signed i64/u64 argument as a number (null when absent or not an integer). */
function int(value: unknown): number | null {
  if (typeof value === "bigint") return Number(value);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
const enumName = (names: Record<number, string>, value: unknown) =>
  typeof value === "number" && names[value] !== undefined ? names[value] : null;
/** An event's i64 (decimal string) as "YYYY-MM-DD HH:MM UTC", or null. */
function utc(value: EventValue | undefined): string | null {
  const n = typeof value === "string" && /^-?\d+$/.test(value) ? Number(value) : null;
  if (n === null || !Number.isSafeInteger(n) || n <= 0 || n > 8_640_000_000_000) return null;
  return `${new Date(n * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
/** " (executable from …, until …)" when the event gave the window. */
function windowText(ev: Record<string, EventValue> | undefined, verb = "executable"): string {
  const from = utc(ev?.eta);
  const until = utc(ev?.expires_at);
  return from && until ? ` (${verb} from ${from} until ${until})` : "";
}

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
  // v1.0.0-rc (8.3, D3): the Super Admin rotation runs through an
  // AuthorityProposal with a 48 h eta; the SA, any Admin or the upgrade
  // authority may cancel it. Every step is critical: the timelock only helps
  // if someone looks during it.
  { name: "propose_platform_admin", program: ASSET_REGISTRY_PROGRAM_ADDRESS, discriminator: disc(PROPOSE_PLATFORM_ADMIN_DISCRIMINATOR),
    decode: dec(getProposePlatformAdminInstructionDataDecoder()), accounts: { authority: 0, platform: 1, transfer: 2 }, format: "platform", fallback: "critical",
    classify: ({ args, events }) => {
      const ev = events.AuthorityProposalCreated;
      return { source: "onchain:platform-admin", severity: "critical",
        summary: `Super admin rotation proposed to ${String(args?.newAdmin)}${windowText(ev, "acceptable")}; the Super Admin, any Admin or the upgrade authority can cancel it`,
        evidence: { new_admin: args?.newAdmin, eta: ev?.eta ?? null, expires_at: ev?.expires_at ?? null } };
    } },
  { name: "accept_platform_admin", program: ASSET_REGISTRY_PROGRAM_ADDRESS, discriminator: disc(ACCEPT_PLATFORM_ADMIN_DISCRIMINATOR),
    decode: null, accounts: { new_admin: 0, platform: 1, transfer: 2 }, format: "platform", fallback: "critical",
    classify: ({ account, events }) => ({ source: "onchain:platform-admin", severity: "critical",
      summary: `Super admin transfer accepted by ${account(0)}`,
      evidence: { old_admin: events.PlatformAdminChanged?.old_admin ?? null } }) },
  { name: "cancel_platform_admin_transfer", program: ASSET_REGISTRY_PROGRAM_ADDRESS, discriminator: disc(CANCEL_PLATFORM_ADMIN_TRANSFER_DISCRIMINATOR),
    decode: null, accounts: { canceller: 0, platform: 2, transfer: 3, proposer: 4 }, format: "platform", fallback: "critical",
    classify: ({ account, events }) => {
      const ev = events.AuthorityProposalCancelled;
      return { source: "onchain:platform-admin", severity: "critical",
        summary: `Super admin rotation${ev ? ` to ${String(ev.cancelled_new_authority)}` : ""} cancelled by ${account(0)}`,
        evidence: { cancelled_new_authority: ev?.cancelled_new_authority ?? null } };
    } },
  // D3: an Admin grant is propose_admin (Super Admin) then, 48 h later and
  // within 14 days, add_admin signed by the NEW admin; the SA, any Admin or
  // the upgrade authority can cancel it. All three steps are critical.
  { name: "propose_admin", program: ASSET_REGISTRY_PROGRAM_ADDRESS, discriminator: disc(PROPOSE_ADMIN_DISCRIMINATOR),
    decode: dec(getProposeAdminInstructionDataDecoder()), accounts: { super_admin: 0, platform: 1, pending_admin: 3 }, format: "platform", fallback: "critical",
    classify: ({ args, events }) => {
      const ev = events.AdminProposed;
      const bootstrap = ev?.bootstrap_open === true;
      return { source: "onchain:admin-grant", severity: "critical",
        summary: `Admin grant proposed for ${String(args?.newAdmin)}${bootstrap
          ? " (bootstrap window open: the new key can execute it at once)" : windowText(ev)}; the Super Admin, any Admin or the upgrade authority can cancel it`,
        evidence: { new_admin: args?.newAdmin, eta: ev?.eta ?? null, expires_at: ev?.expires_at ?? null,
          bootstrap_open: typeof ev?.bootstrap_open === "boolean" ? ev.bootstrap_open : null } };
    } },
  { name: "add_admin", program: ASSET_REGISTRY_PROGRAM_ADDRESS, discriminator: disc(ADD_ADMIN_DISCRIMINATOR),
    // v1.0.0-rc: the executor, signed by the NEW admin (the grant was proposed 48 h earlier).
    decode: dec(getAddAdminInstructionDataDecoder()), accounts: { new_admin: 0, pending_admin: 2, proposer: 3, admin_record: 4 }, format: "platform",
    fallback: "critical",
    classify: ({ args, events }) => ({ source: "onchain:admin-record", severity: "critical",
      summary: `Admin added: ${String(args?.newAdmin)} (staged grant executed by the new key)`,
      evidence: { admin: args?.newAdmin, added_by: events.AdminAdded?.added_by ?? null, proposed_at: events.AdminAdded?.proposed_at ?? null } }) },
  { name: "cancel_admin_proposal", program: ASSET_REGISTRY_PROGRAM_ADDRESS, discriminator: disc(CANCEL_ADMIN_PROPOSAL_DISCRIMINATOR),
    decode: null, accounts: { canceller: 0, pending_admin: 3, proposer: 4 }, format: "platform", fallback: "critical",
    classify: ({ account, events }) => {
      const ev = events.AdminProposalCancelled;
      return { source: "onchain:admin-grant", severity: "critical",
        summary: `Admin grant${ev ? ` for ${String(ev.new_admin)}` : ""} cancelled by ${account(0)}`,
        evidence: { new_admin: ev?.new_admin ?? null, proposed_by: ev?.proposed_by ?? null } };
    } },
  // D4: the upgrade authority replaces a lost Super Admin (7 days, cancellable
  // by the current Super Admin or the upgrade authority).
  { name: "propose_platform_recovery", program: ASSET_REGISTRY_PROGRAM_ADDRESS, discriminator: disc(PROPOSE_PLATFORM_RECOVERY_DISCRIMINATOR),
    decode: dec(getProposePlatformRecoveryInstructionDataDecoder()), accounts: { upgrade_authority: 0, platform: 1, recovery: 2 }, format: "platform",
    fallback: "critical",
    classify: ({ args, events }) => {
      const ev = events.PlatformRecoveryProposed;
      return { source: "onchain:platform-recovery", severity: "critical",
        summary: `Super admin recovery proposed by the upgrade authority: ${String(args?.newAdmin)} replaces ${String(ev?.current_admin ?? "the Super Admin")}${windowText(ev)} unless the Super Admin cancels it`,
        evidence: { new_admin: args?.newAdmin, current_admin: ev?.current_admin ?? null, eta: ev?.eta ?? null, expires_at: ev?.expires_at ?? null } };
    } },
  { name: "cancel_platform_recovery", program: ASSET_REGISTRY_PROGRAM_ADDRESS, discriminator: disc(CANCEL_PLATFORM_RECOVERY_DISCRIMINATOR),
    decode: null, accounts: { canceller: 0, recovery: 2, proposer: 3 }, format: "platform", fallback: "critical",
    classify: ({ account, events }) => ({ source: "onchain:platform-recovery", severity: "critical",
      summary: `Super admin recovery${events.PlatformRecoveryCancelled ? ` to ${String(events.PlatformRecoveryCancelled.new_admin)}` : ""} cancelled by ${account(0)}`,
      evidence: { new_admin: events.PlatformRecoveryCancelled?.new_admin ?? null } }) },
  { name: "execute_platform_recovery", program: ASSET_REGISTRY_PROGRAM_ADDRESS, discriminator: disc(EXECUTE_PLATFORM_RECOVERY_DISCRIMINATOR),
    decode: null, accounts: { new_admin: 0, platform: 1, recovery: 2 }, format: "platform", fallback: "critical",
    classify: ({ account, events }) => ({ source: "onchain:platform-recovery", severity: "critical",
      summary: `Super admin recovery executed: ${account(0)} is the Super Admin${events.PlatformAdminChanged ? ` (was ${String(events.PlatformAdminChanged.old_admin)})` : ""}`,
      evidence: { old_admin: events.PlatformAdminChanged?.old_admin ?? null, kind: events.PlatformAdminChanged?.kind ?? null } }) },
  // D1: freeze and unfreeze of an issuer's proceeds (issuer-scoped: minimal;
  // the reason stays off chain, only its SHA-256 is evidence).
  { name: "freeze_issuer_proceeds", program: ASSET_REGISTRY_PROGRAM_ADDRESS, discriminator: disc(FREEZE_ISSUER_PROCEEDS_DISCRIMINATOR),
    decode: dec(getFreezeIssuerProceedsInstructionDataDecoder()), accounts: { authority: 0, issuer: 3, issuer_freeze: 4 }, format: "minimal",
    fallback: "critical",
    classify: ({ args, account, events }) => {
      const ev = events.IssuerProceedsFrozen;
      const hash = ev?.reason_hash ?? (args?.reasonHash instanceof Uint8Array
        ? Array.from(args.reasonHash, (b) => b.toString(16).padStart(2, "0")).join("") : null);
      return { source: "onchain:issuer-freeze", severity: "critical",
        summary: "Issuer proceeds frozen: sales, buys and proceeds exits of this issuer stay closed until the Super Admin unfreezes",
        evidence: { frozen_by: ev?.frozen_by ?? account(0) ?? null, frozen_at: ev?.frozen_at ?? null, reason_hash: hash } };
    } },
  { name: "unfreeze_issuer_proceeds", program: ASSET_REGISTRY_PROGRAM_ADDRESS, discriminator: disc(UNFREEZE_ISSUER_PROCEEDS_DISCRIMINATOR),
    decode: null, accounts: { super_admin: 0, issuer_freeze: 2, frozen_by: 3 }, format: "minimal", fallback: "critical",
    classify: ({ events }) => {
      const ev = events.IssuerProceedsUnfrozen;
      return { source: "onchain:issuer-freeze", severity: "critical", summary: "Issuer proceeds unfrozen by the Super Admin",
        evidence: { issuer: ev?.issuer ?? null, frozen_at: ev?.frozen_at ?? null } };
    } },
  // K1.1c: instant, so a compromised Super Admin can strip every Admin (and
  // with it their veto of its 48 h changes) at once: critical, like add_admin.
  { name: "remove_admin", program: ASSET_REGISTRY_PROGRAM_ADDRESS, discriminator: disc(REMOVE_ADMIN_DISCRIMINATOR),
    decode: dec(getRemoveAdminInstructionDataDecoder()), accounts: { super_admin: 0, admin_record: 2 }, format: "platform", fallback: "critical",
    classify: ({ args }) => ({ source: "onchain:admin-record", severity: "critical", summary: `Admin removed: ${String(args?.admin)}`,
      evidence: { admin: args?.admin } }) },
  { name: "propose_custody_authority", program: ASSET_REGISTRY_PROGRAM_ADDRESS, discriminator: disc(PROPOSE_CUSTODY_AUTHORITY_DISCRIMINATOR),
    decode: dec(getProposeCustodyAuthorityInstructionDataDecoder()), accounts: { super_admin: 0, custody_vault: 2 }, format: "platform", fallback: "medium",
    classify: ({ args }) => ({ source: "onchain:custody-authority", severity: "medium",
      summary: `Custody authority transfer proposed to ${String(args?.newAuthority)}`, evidence: { new_authority: args?.newAuthority } }) },
  { name: "accept_custody_authority", program: ASSET_REGISTRY_PROGRAM_ADDRESS, discriminator: disc(ACCEPT_CUSTODY_AUTHORITY_DISCRIMINATOR),
    decode: null, accounts: { new_authority: 0, custody_vault: 2 }, format: "platform", fallback: "high",
    classify: ({ account }) => ({ source: "onchain:custody-authority", severity: "high",
      summary: `Custody authority transfer accepted by ${account(0)}` }) },
  { name: "cancel_custody_authority_transfer", program: ASSET_REGISTRY_PROGRAM_ADDRESS, discriminator: disc(CANCEL_CUSTODY_AUTHORITY_TRANSFER_DISCRIMINATOR),
    decode: null, accounts: { canceller: 0, custody_vault: 3, transfer: 4, proposer: 5 }, format: "platform", fallback: "high",
    classify: ({ account, events }) => ({ source: "onchain:custody-authority", severity: "high",
      summary: `Custody authority transfer cancelled by ${account(0)}`,
      evidence: { cancelled_new_authority: events.AuthorityProposalCancelled?.cancelled_new_authority ?? null } }) },
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
  // Admin actions that move money or tokens (prog-vlast-9). Admins are single
  // keys: a compromised one is seen only here. Issuer- or holder-scoped, so
  // minimal: the email never shows the summary; the evidence keeps the
  // issuer-level parameters (never a holder's wallet or balance). Blocklist
  // add/remove and approve/revoke_holder stay out (owner decision D6).
  { name: "open_vault_vote", program: ASSET_REGISTRY_PROGRAM_ADDRESS, discriminator: disc(OPEN_VAULT_VOTE_DISCRIMINATOR),
    decode: dec(getOpenVaultVoteInstructionDataDecoder()), accounts: { authority: 0, vault: 2, vote: 3 }, format: "minimal", fallback: "critical",
    classify: ({ args }) => {
      const period = int(args?.votingPeriod);
      const short = period === null || period < SHORT_VOTING_WINDOW_SECONDS;
      return { source: "onchain:vault-vote", severity: short ? "critical" : "high",
        summary: short ? `Payout vault vote opened with a short voting period (${period ?? "?"} s)` : "Payout vault vote opened",
        evidence: { voting_period_seconds: period, total_weight: args?.totalWeight ?? null, snapshot_root: args?.snapshotRoot ?? null } };
    } },
  { name: "route_yield", program: ASSET_REGISTRY_PROGRAM_ADDRESS, discriminator: disc(ROUTE_YIELD_DISCRIMINATOR),
    decode: dec(getRouteYieldInstructionDataDecoder()), accounts: { authority: 0, vault: 2, source: 3, platform_treasury: 5, payment_mint: 6 },
    format: "minimal", fallback: "high",
    classify: ({ args }) => ({ source: "onchain:yield-route", severity: "high", summary: "Yield routed into a payout vault (investor root set)",
      evidence: { amount: args?.amount ?? null, total_weight: args?.totalWeight ?? null, investor_root: args?.investorRoot ?? null } }) },
  { name: "publish_milestone", program: ASSET_REGISTRY_PROGRAM_ADDRESS, discriminator: disc(PUBLISH_MILESTONE_DISCRIMINATOR),
    decode: dec(getPublishMilestoneInstructionDataDecoder()), accounts: { authority: 0, rights_issuance: 2, milestone: 3 },
    format: "minimal", fallback: "high",
    classify: ({ args }) => ({ source: "onchain:milestone", severity: "high", summary: "Rights milestone published (claim root set)",
      evidence: { index: args?.index ?? null, amount_pool: args?.amountPool ?? null, unlock_ts: args?.unlockTs ?? null,
        merkle_root: args?.merkleRoot ?? null } }) },
  { name: "create_proposal", program: ASSET_REGISTRY_PROGRAM_ADDRESS, discriminator: disc(CREATE_PROPOSAL_DISCRIMINATOR),
    decode: dec(getCreateProposalInstructionDataDecoder()), accounts: { authority: 0, share_class: 2, proposal: 3 },
    format: "minimal", fallback: "high",
    classify: ({ args, blockTime }) => {
      const start = int(args?.startTs);
      const end = int(args?.endTs);
      // Votes are cast while start_ts <= now < end_ts (cast_vote.rs), and
      // create_proposal only requires end_ts >= start_ts: a start in the past
      // (the admin UI sends 0: "open now") opens voting at creation. So the
      // window holders really get runs from the later of start_ts and the
      // block time; unknown, zero or negative is short.
      const window = start !== null && end !== null && blockTime !== null ? end - Math.max(start, blockTime) : null;
      const short = window === null || window < SHORT_VOTING_WINDOW_SECONDS;
      return { source: "onchain:proposal", severity: short ? "high" : "medium",
        summary: short ? `Governance proposal created with a short voting window (${window ?? "?"} s from creation)` : "Governance proposal created",
        evidence: { proposal_id: args?.proposalId ?? null, snapshot_slot: args?.snapshotSlot ?? null, start_ts: start, end_ts: end,
          block_time: blockTime, voting_window_seconds: window, snapshot_root: args?.snapshotRoot ?? null } };
    } },
  { name: "lock_supply", program: ASSET_REGISTRY_PROGRAM_ADDRESS, discriminator: disc(LOCK_SUPPLY_DISCRIMINATOR),
    decode: null, accounts: { authority: 0, share_class: 2 }, format: "minimal", fallback: "high",
    classify: () => ({ source: "onchain:supply-lock", severity: "high", summary: "Share class supply locked (irreversible)" }) },
  { name: "open_custody_vault", program: ASSET_REGISTRY_PROGRAM_ADDRESS, discriminator: disc(OPEN_CUSTODY_VAULT_DISCRIMINATOR),
    decode: dec(getOpenCustodyVaultInstructionDataDecoder()), accounts: { authority: 0, share_class: 2, custody_vault: 4 },
    format: "minimal", fallback: "medium",
    // Never the beneficiary (a holder for a delivery escrow) nor its amount.
    classify: ({ args }) => ({ source: "onchain:custody-vault", severity: "medium", summary: "Custody vault opened",
      evidence: { vault_id: args?.vaultId ?? null, vault_type: enumName(VaultType, args?.vaultType),
        realize_action: enumName(RealizeAction, args?.realizeAction), deadline: args?.deadline ?? null } }) },
  { name: "trigger_custody_vault", program: ASSET_REGISTRY_PROGRAM_ADDRESS, discriminator: disc(TRIGGER_CUSTODY_VAULT_DISCRIMINATOR),
    decode: null, accounts: { authority: 0, custody_vault: 1 }, format: "minimal", fallback: "medium",
    classify: () => ({ source: "onchain:custody-vault", severity: "medium", summary: "Custody vault triggered" }) },
  { name: "realize_custody_vault", program: ASSET_REGISTRY_PROGRAM_ADDRESS, discriminator: disc(REALIZE_CUSTODY_VAULT_DISCRIMINATOR),
    decode: null, accounts: { authority: 0, share_class: 1, custody_vault: 2 }, format: "minimal", fallback: "medium",
    // Routine for conversions and deliveries (the escrow is burned, KYC-gated where the type requires it).
    classify: () => ({ source: "onchain:custody-vault", severity: "medium", summary: "Custody vault realized (escrow burned or released)" }) },
  { name: "revert_custody_vault", program: ASSET_REGISTRY_PROGRAM_ADDRESS, discriminator: disc(REVERT_CUSTODY_VAULT_DISCRIMINATOR),
    decode: null, accounts: { payer: 0, share_class: 1, custody_vault: 2 }, format: "minimal", fallback: "high",
    classify: ({ events }) => {
      // The escape hatch burns the escrow; an unknown burn (no event) counts as a burn.
      const burned = events.CustodyReverted?.burned;
      const none = burned === "0";
      return { source: "onchain:custody-vault", severity: none ? "low" : "high",
        summary: none ? "Empty custody vault reverted" : "Custody vault reverted: its escrow was burned",
        evidence: { burned: burned === undefined ? null : !none } };
    } },
  { name: "approve_sale", program: ASSET_REGISTRY_PROGRAM_ADDRESS, discriminator: disc(APPROVE_SALE_DISCRIMINATOR),
    decode: dec(getApproveSaleInstructionDataDecoder()),
    accounts: { authority: 0, issuer: 2, share_class: 4, payment_mint: 5, sale_approval: 7 }, format: "minimal", fallback: "high",
    classify: ({ args, account, network }) => {
      const raise = typeof args?.maxGrossRaise === "bigint" ? args.maxGrossRaise : null;
      const usdc = USDC[network]?.mint;
      const large = raise === null || !usdc || account(5) !== usdc || raise >= SALE_APPROVAL_HIGH_USDC_UNITS;
      return { source: "onchain:sale-approval", severity: large ? "high" : "medium",
        summary: large ? "Sale approved (large raise, or a payment mint other than USDC)" : "Sale approved",
        evidence: { sale_id: args?.saleId ?? null, max_gross_raise: raise, min_price_per_unit: args?.minPricePerUnit ?? null,
          max_price_per_unit: args?.maxPricePerUnit ?? null, raise_type: enumName(RaiseType, args?.raiseType),
          expires_at: args?.expiresAt ?? null, cliff_months: args?.cliffMonths ?? null, vesting_months: args?.vestingMonths ?? null } };
    } },
  // transfer_hook
  { name: "initialize_blocklist_authority", program: TRANSFER_HOOK_PROGRAM_ADDRESS, discriminator: disc(INITIALIZE_BLOCKLIST_AUTHORITY_DISCRIMINATOR),
    decode: dec(getInitializeBlocklistAuthorityInstructionDataDecoder()), accounts: { payer: 0, blocklist_authority: 1 }, format: "platform", fallback: "high",
    classify: ({ args }) => ({ source: "onchain:blocklist-authority", severity: "high",
      summary: `Blocklist authority initialized: ${String(args?.authority)}`, evidence: { authority: args?.authority } }) },
  // v1.0.0-rc (8.3): every blocklist-authority rotation step is critical (the
  // hook emits no events; its accounts and arguments are the evidence), and
  // so is every step of the upgrade authority's recovery of it (D4).
  { name: "propose_blocklist_authority", program: TRANSFER_HOOK_PROGRAM_ADDRESS, discriminator: disc(PROPOSE_BLOCKLIST_AUTHORITY_DISCRIMINATOR),
    decode: dec(getProposeBlocklistAuthorityInstructionDataDecoder()), accounts: { authority: 0, blocklist_authority: 1, transfer: 2 }, format: "platform",
    fallback: "critical",
    classify: ({ args }) => ({ source: "onchain:blocklist-authority", severity: "critical",
      summary: `Blocklist authority transfer proposed to ${String(args?.newAuthority)} (acceptable at once, for 14 days)`,
      evidence: { new_authority: args?.newAuthority } }) },
  { name: "accept_blocklist_authority", program: TRANSFER_HOOK_PROGRAM_ADDRESS, discriminator: disc(ACCEPT_BLOCKLIST_AUTHORITY_DISCRIMINATOR),
    decode: null, accounts: { new_authority: 0, blocklist_authority: 1, transfer: 2 }, format: "platform", fallback: "critical",
    classify: ({ account }) => ({ source: "onchain:blocklist-authority", severity: "critical",
      summary: `Blocklist authority transfer accepted by ${account(0)}` }) },
  { name: "cancel_blocklist_authority_transfer", program: TRANSFER_HOOK_PROGRAM_ADDRESS, discriminator: disc(CANCEL_BLOCKLIST_AUTHORITY_TRANSFER_DISCRIMINATOR),
    decode: null, accounts: { authority: 0, blocklist_authority: 1, transfer: 2 }, format: "platform", fallback: "critical",
    classify: ({ account }) => ({ source: "onchain:blocklist-authority", severity: "critical",
      summary: `Blocklist authority transfer cancelled by ${account(0)}` }) },
  { name: "propose_blocklist_recovery", program: TRANSFER_HOOK_PROGRAM_ADDRESS, discriminator: disc(PROPOSE_BLOCKLIST_RECOVERY_DISCRIMINATOR),
    decode: dec(getProposeBlocklistRecoveryInstructionDataDecoder()), accounts: { upgrade_authority: 0, blocklist_authority: 1, recovery: 2 }, format: "platform",
    fallback: "critical",
    classify: ({ args }) => ({ source: "onchain:blocklist-recovery", severity: "critical",
      summary: `Blocklist authority recovery proposed by the upgrade authority: ${String(args?.newAuthority)} can take over in 7 days unless the blocklist authority cancels it`,
      evidence: { new_authority: args?.newAuthority } }) },
  { name: "cancel_blocklist_recovery", program: TRANSFER_HOOK_PROGRAM_ADDRESS, discriminator: disc(CANCEL_BLOCKLIST_RECOVERY_DISCRIMINATOR),
    decode: null, accounts: { canceller: 0, recovery: 2, proposer: 3 }, format: "platform", fallback: "critical",
    classify: ({ account }) => ({ source: "onchain:blocklist-recovery", severity: "critical",
      summary: `Blocklist authority recovery cancelled by ${account(0)}` }) },
  { name: "execute_blocklist_recovery", program: TRANSFER_HOOK_PROGRAM_ADDRESS, discriminator: disc(EXECUTE_BLOCKLIST_RECOVERY_DISCRIMINATOR),
    decode: null, accounts: { new_authority: 0, blocklist_authority: 1, recovery: 2 }, format: "platform", fallback: "critical",
    classify: ({ account }) => ({ source: "onchain:blocklist-recovery", severity: "critical",
      summary: `Blocklist authority recovery executed: ${account(0)} is the blocklist authority` }) },
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
    const ctx: Ctx = { network, blockTime: int(tx.blockTime), args, account: (i) => inv.accounts[i], events };
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
  // A trade or transfer by a FROZEN issuer's authority wallet (D1, O-9: the
  // program does not stop its own secondary sales): high, so the Blocklist
  // Authority can act before the units are gone. Only trades and transfers
  // read the freeze mirror; a mirror that cannot be read retries the job.
  let frozenAlerts = 0;
  if (isTradeOrTransfer(tx)) {
    try {
      const frozen = await loadFrozenIssuerWallets(sb, job.network as Network, databaseSignal(signal));
      for (const alert of frozenIssuerAlerts(job.signature, frozenIssuerActivity(tx, frozen))) {
        if (signal.aborted || Date.now() >= deadlineMs) return "pending";
        await raiseSystemAlert(sb, {
          network: job.network as Network, dedupKey: alert.dedupKey, category: "onchain", source: alert.source,
          severity: alert.severity, summary: alert.summary, evidence: alert.evidence, txSignature: job.signature, notify: true,
        }, signal);
        frozenAlerts++;
      }
    } catch {
      return retry("DB_UNAVAILABLE", backoff(job.attempts));
    }
  }
  if (signal.aborted || Date.now() >= deadlineMs) return "pending";
  // The signers of unmediated entries, screened after the fact (idempotent:
  // one open alert per wallet). A list that cannot answer on mainnet keeps
  // the job pending; a failed alert write retries like any effect above.
  let screened: { hits: number } | "retry";
  try {
    screened = await screenTransactionParties(sb, job.signature, tx);
  } catch {
    return retry("DB_UNAVAILABLE", backoff(job.attempts));
  }
  if (screened === "retry") return retry("SANCTIONS_UNAVAILABLE", backoff(job.attempts));
  if (signal.aborted || Date.now() >= deadlineMs) return "pending";
  // D2: a buy by a wallet not linked to the platform (no acceptance of the
  // Terms in force by 2 minutes after the buy). Within those 2 minutes the
  // job waits and decides once on its next run; everything above repeats
  // idempotently then. A read or write that fails retries, never decides.
  let linkCheck: Awaited<ReturnType<typeof checkUnlinkedBuys>>;
  try {
    linkCheck = await checkUnlinkedBuys(sb, {
      network: job.network as Network, signature: job.signature, tx, jobCreatedAt: job.created_at, now: Date.now(), signal,
    });
  } catch {
    return retry("DB_UNAVAILABLE", backoff(job.attempts));
  }
  if ("retryAt" in linkCheck) return retry("LINK_GRACE", Math.max(5_000, linkCheck.retryAt - Date.now()));
  if (signal.aborted || Date.now() >= deadlineMs) return "pending";
  await writeJob(sb, job, {
    status: "complete", alerts: result.alarms.length + frozenAlerts + screened.hits + linkCheck.alerts, attempts: job.attempts + 1,
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
