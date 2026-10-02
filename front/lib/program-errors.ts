// Which program refused a transaction, with which error, in plain words.
//
// Pure and node-safe (no "use client", no browser or React import): the
// verified client's simulation gate (lib/simulation-gate), the post-wallet
// explanation (lib/tx-error), the chain CLI and the sim all read failures
// through this module.
//
// The two Manci programs share custom numbers (6003 is SenderBlocked in the
// transfer hook and AssetNotDraft in the registry; 6000 is the hook's
// KycRegistryRequired and the registry's PlatformPaused), so a failure is the
// failing PROGRAM and its code, never the bare number. The failing program is
// the innermost `Program <id> failed` line: when the hook refuses a Token-2022
// transfer, the hook fails first and its custom code is what the transaction
// error carries.
import * as registryErrors from "@/lib/generated/asset_registry/errors/assetRegistry";
import * as hookErrors from "@/lib/generated/transfer_hook/errors/transferHook";
import {
  ASSET_REGISTRY_ERROR__ACCOUNT_NOT_CLOSABLE,
  ASSET_REGISTRY_ERROR__BENEFICIARY_NOT_ALLOWED,
  ASSET_REGISTRY_ERROR__CLAWBACK_DESTINATION_INVALID,
  ASSET_REGISTRY_ERROR__CLAWBACK_HOLDER_NOT_BLOCKED,
  ASSET_REGISTRY_ERROR__CLAWBACK_HOLDER_STILL_ELIGIBLE,
  ASSET_REGISTRY_ERROR__CLAWBACK_NOT_KYC_GATED,
  ASSET_REGISTRY_ERROR__CLAWBACK_TARGET_IS_ESCROW,
  ASSET_REGISTRY_ERROR__CUSTODY_KYC_REGISTRY_MISMATCH,
  ASSET_REGISTRY_ERROR__CUSTODY_KYC_REGISTRY_NOT_ALLOWED,
  ASSET_REGISTRY_ERROR__CUSTODY_KYC_REGISTRY_REQUIRED,
  ASSET_REGISTRY_ERROR__DEAL_EXPIRY_OUT_OF_RANGE,
  ASSET_REGISTRY_ERROR__DELIVERY_DEADLINE_OUT_OF_RANGE,
  ASSET_REGISTRY_ERROR__DEPOSITOR_NOT_BENEFICIARY,
  ASSET_REGISTRY_ERROR__ESCROW_NOT_EMPTY,
  ASSET_REGISTRY_ERROR__HOOK_CONFIG_INVALID,
  ASSET_REGISTRY_ERROR__INVALID_ADMIN_PROPOSAL,
  ASSET_REGISTRY_ERROR__INVALID_AUTHORITY_TRANSFER,
  ASSET_REGISTRY_ERROR__INVALID_DEPOSIT_AMOUNT,
  ASSET_REGISTRY_ERROR__INVALID_ISSUER_RECOVERY,
  ASSET_REGISTRY_ERROR__INVALID_PAUSE_FLAGS,
  ASSET_REGISTRY_ERROR__INVALID_PLATFORM_RECOVERY,
  ASSET_REGISTRY_ERROR__INVALID_PROPOSED_AUTHORITY,
  ASSET_REGISTRY_ERROR__INVALID_PROTOCOL_TREASURY,
  ASSET_REGISTRY_ERROR__INVALID_SALE_APPROVAL,
  ASSET_REGISTRY_ERROR__INVALID_SALE_PRICE,
  ASSET_REGISTRY_ERROR__ISSUER_PROCEEDS_FROZEN,
  ASSET_REGISTRY_ERROR__ISSUER_RECOVERY_EXPIRED,
  ASSET_REGISTRY_ERROR__ISSUER_RECOVERY_TIMELOCK_ACTIVE,
  ASSET_REGISTRY_ERROR__KYC_EXPIRY_TOO_FAR,
  ASSET_REGISTRY_ERROR__KYC_PROOF_REQUIRED,
  ASSET_REGISTRY_ERROR__MINT_DESTINATION_NOT_BOUND,
  ASSET_REGISTRY_ERROR__NOT_FOUNDER,
  ASSET_REGISTRY_ERROR__PARTY_BLOCKLISTED,
  ASSET_REGISTRY_ERROR__PAUSE_CLEAR_NOT_ALLOWED,
  ASSET_REGISTRY_ERROR__PAYOUT_MODULES_CLEAR_NOT_EXPLICIT,
  ASSET_REGISTRY_ERROR__PLATFORM_RECOVERY_PENDING,
  ASSET_REGISTRY_ERROR__PROPOSAL_EXPIRED,
  ASSET_REGISTRY_ERROR__RECEIVER_JURISDICTION_BLOCKED,
  ASSET_REGISTRY_ERROR__RECEIVER_KYC_EXPIRED,
  ASSET_REGISTRY_ERROR__RECEIVER_NOT_APPROVED,
  ASSET_REGISTRY_ERROR__SALE_APPROVAL_EXPIRED,
  ASSET_REGISTRY_ERROR__SALE_APPROVAL_MISMATCH,
  ASSET_REGISTRY_ERROR__SALE_DURATION_INVALID,
  ASSET_REGISTRY_ERROR__SALE_EXCEEDS_APPROVED_RAISE,
  ASSET_REGISTRY_ERROR__SALE_ID_ALREADY_USED,
  ASSET_REGISTRY_ERROR__SALE_PRICE_OUTSIDE_APPROVAL,
  ASSET_REGISTRY_ERROR__SALE_STARTS_AFTER_APPROVAL_EXPIRY,
  ASSET_REGISTRY_ERROR__SALE_VESTING_OUTSIDE_APPROVAL,
  ASSET_REGISTRY_ERROR__TIMELOCK_ACTIVE,
  ASSET_REGISTRY_ERROR__TREASURY_MINT_REQUIRES_ADMIN,
  ASSET_REGISTRY_ERROR__VAULT_NOT_ACCEPTING_DEPOSITS,
  ASSET_REGISTRY_ERROR__VAULT_TYPE_RETIRED,
  ASSET_REGISTRY_ERROR__VOTING_PERIOD_TOO_SHORT,
} from "@/lib/generated/asset_registry/errors/assetRegistry";
import {
  TRANSFER_HOOK_ERROR__HOLDER_KYC_EXPIRED,
  TRANSFER_HOOK_ERROR__IMMUTABLE_OWNER_REQUIRED,
  TRANSFER_HOOK_ERROR__INVALID_BLOCK_ENTRY,
  TRANSFER_HOOK_ERROR__INVALID_KYC_ENTRY,
  TRANSFER_HOOK_ERROR__INVALID_KYC_REGISTRY,
  TRANSFER_HOOK_ERROR__INVALID_RECOVERY,
  TRANSFER_HOOK_ERROR__INVALID_TOKEN_ACCOUNT,
  TRANSFER_HOOK_ERROR__JURISDICTION_BLOCKED,
  TRANSFER_HOOK_ERROR__KYC_REGISTRY_NOT_ALLOWED,
  TRANSFER_HOOK_ERROR__KYC_REGISTRY_REQUIRED,
  TRANSFER_HOOK_ERROR__META_LIST_NOT_INITIALIZED,
  TRANSFER_HOOK_ERROR__MISSING_EXTRA_ACCOUNT,
  TRANSFER_HOOK_ERROR__PROPOSAL_EXPIRED,
  TRANSFER_HOOK_ERROR__RECEIVER_NOT_APPROVED,
  TRANSFER_HOOK_ERROR__RECOVERY_PENDING,
  TRANSFER_HOOK_ERROR__SENDER_BLOCKED,
  TRANSFER_HOOK_ERROR__TIMELOCK_ACTIVE,
  TRANSFER_HOOK_ERROR__UNAUTHORIZED,
} from "@/lib/generated/transfer_hook/errors/transferHook";
import { ASSET_REGISTRY_PROGRAM_ADDRESS } from "@/lib/generated/asset_registry/programs";
import { TRANSFER_HOOK_PROGRAM_ADDRESS } from "@/lib/generated/transfer_hook/programs";

// ── Programs ─────────────────────────────────────────────────────────────────

export const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
export const COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111";

/** Our two programs, by the label the e2e matrix and the sim use. */
export type ProgramLabel = "asset_registry" | "transfer_hook";

const PROGRAM_LABELS: Record<string, ProgramLabel> = {
  [ASSET_REGISTRY_PROGRAM_ADDRESS]: "asset_registry",
  [TRANSFER_HOOK_PROGRAM_ADDRESS]: "transfer_hook",
};

/** Every program a Manci transaction calls, by a label; anything else keeps its address. */
export type KnownProgram = ProgramLabel | "token_2022" | "associated_token" | "system" | "compute_budget";

const KNOWN_PROGRAMS: Record<string, KnownProgram> = {
  ...PROGRAM_LABELS,
  [TOKEN_2022_PROGRAM_ID]: "token_2022",
  [ASSOCIATED_TOKEN_PROGRAM_ID]: "associated_token",
  [SYSTEM_PROGRAM_ID]: "system",
  [COMPUTE_BUDGET_PROGRAM_ID]: "compute_budget",
};

const PROGRAM_DESCRIPTIONS: Record<KnownProgram, string> = {
  asset_registry: "the Manci registry program",
  transfer_hook: "the Manci transfer hook",
  token_2022: "the Token-2022 program",
  associated_token: "the Associated Token Account program",
  system: "the System program",
  compute_budget: "the Compute Budget program",
};

/** The label of a program (its address, or already a label), or null for any other program. */
export function knownProgram(program: string | null | undefined): KnownProgram | null {
  if (!program) return null;
  if (Object.prototype.hasOwnProperty.call(PROGRAM_DESCRIPTIONS, program)) return program as KnownProgram;
  return KNOWN_PROGRAMS[program] ?? null;
}

const short = (value: string) => (value.length > 12 ? `${value.slice(0, 4)}…${value.slice(-4)}` : value);

/** "the Manci transfer hook", "the Token-2022 program", or "program FJs1…mYxS". */
export function describeProgram(program: string | null | undefined): string {
  if (!program) return "the network";
  const label = knownProgram(program);
  return label ? PROGRAM_DESCRIPTIONS[label] : `program ${short(program)}`;
}

// ── Classification (moved from scripts/chain/lib/e2e/errors.ts) ──────────────

export type ChainFailure = {
  /** The innermost failing program, by label when it is one of ours. */
  program: ProgramLabel | string | null;
  code: number | null;
  /** The Anchor error name from the logs, or the transaction error's own name. */
  name: string | null;
};

function codeNames(module: Record<string, unknown>, prefix: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const [key, value] of Object.entries(module)) {
    if (key.startsWith(prefix) && typeof value === "number") out.set(value, key.slice(prefix.length));
  }
  return out;
}
const REGISTRY_NAMES = codeNames(registryErrors, "ASSET_REGISTRY_ERROR__");
const HOOK_NAMES = codeNames(hookErrors, "TRANSFER_HOOK_ERROR__");

/** SCREAMING_SNAKE (generated constant suffix) → the program's PascalCase name. */
function pascal(snake: string): string {
  return snake
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

/** The program's own name for one of its custom codes (from the generated SDK). */
export function errorName(program: ProgramLabel, code: number): string | null {
  const names = program === "asset_registry" ? REGISTRY_NAMES : HOOK_NAMES;
  const snake = names.get(code);
  return snake ? pascal(snake) : null;
}

const FAILED_LINE = /^Program (\w{32,44}) failed/;
const ANCHOR_LINE = /Error Code: (\w+)\. Error Number: (\d+)\./;

/** The innermost failing program in a log (the first `Program <id> failed` line), or null. */
export function innermostFailedProgram(logs: readonly string[]): string | null {
  for (const line of logs) {
    const failed = FAILED_LINE.exec(line);
    if (failed) return failed[1];
  }
  return null;
}

/**
 * Which program failed (the innermost `Program <id> failed` line, by label
 * when it is ours) and with which code / name. `err` is a TransactionError as
 * the RPC returns it (`{InstructionError: [index, {Custom: code}]}`, a bare
 * name, or `{Name: details}`); bigint indexes and codes are accepted.
 */
export function classifyFailure(err: unknown, logs: readonly string[]): ChainFailure {
  const program = innermostFailedProgram(logs);
  const label = program ? (PROGRAM_LABELS[program] ?? program) : null;

  let code: number | null = null;
  let name: string | null = null;
  const instructionError =
    err && typeof err === "object" && "InstructionError" in err
      ? (err as { InstructionError: [unknown, unknown] }).InstructionError
      : null;
  if (instructionError) {
    const inner = instructionError[1];
    if (inner && typeof inner === "object" && "Custom" in inner) {
      code = Number((inner as { Custom: number | bigint }).Custom);
    } else if (typeof inner === "string") {
      name = inner;
    } else if (inner && typeof inner === "object") {
      name = Object.keys(inner)[0] ?? null;
    }
  } else if (typeof err === "string") {
    name = err;
  } else if (err && typeof err === "object") {
    name = Object.keys(err)[0] ?? null;
  }

  for (const line of logs) {
    const anchor = ANCHOR_LINE.exec(line);
    if (anchor && (code === null || Number(anchor[2]) === code)) {
      name = anchor[1];
      code ??= Number(anchor[2]);
      break;
    }
  }
  if (name === null && code !== null && (label === "asset_registry" || label === "transfer_hook")) {
    name = errorName(label, code);
  }
  return { program: label, code, name };
}

/** The failing instruction's index in the MESSAGE (compute-budget instructions included), or null. */
export function failedInstructionIndex(err: unknown): number | null {
  if (!err || typeof err !== "object" || !("InstructionError" in err)) return null;
  const pair = (err as { InstructionError: unknown }).InstructionError;
  if (!Array.isArray(pair)) return null;
  const index = Number(pair[0]);
  return Number.isInteger(index) && index >= 0 ? index : null;
}

// ── Plain-English hints ──────────────────────────────────────────────────────

// v1.0.0-rc (8.3) hints. lib/tx-error re-exports these (existing imports).
/** The issuer's proceeds are frozen by Manci (IssuerProceedsFrozen, 6143). */
export const ISSUER_PROCEEDS_FROZEN_HINT =
  "Manci has frozen this issuer's proceeds, so its sales cannot open, take money or pay out until the Super Admin lifts the freeze. Money already paid into its sales stays in the sale escrow meanwhile; offer and OTC exits, investor yield and claims keep working (IssuerProceedsFrozen).";
/** A party of the transaction is on the transfer-hook blocklist (PartyBlocklisted, 6144). */
export const PARTY_BLOCKLISTED_HINT =
  "A wallet in this transaction (payer, recipient, or the issuer key) is on the Manci blocklist, so the transaction was refused. If an OTC deal cannot expire because of it, ask a Manci Admin to cancel the deal (PartyBlocklisted).";
/** A timelocked action run before its eta (registry TimelockActive 6150, hook 6018). */
export const TIMELOCK_ACTIVE_HINT =
  "This change is still inside its waiting period (48 hours for an Admin grant or a Super Admin rotation, 7 days for a recovery). It can be executed once the countdown ends (TimelockActive).";
/** A proposal run after its window (registry ProposalExpired 6151, hook 6017). */
export const PROPOSAL_EXPIRED_HINT =
  "This proposal has expired (proposals can be executed for 14 days after they become executable). Cancel it and propose again (ProposalExpired).";
/** A rotation refused while a recovery is pending (registry 6155, hook RecoveryPending 6020). */
export const PLATFORM_RECOVERY_PENDING_HINT =
  "A recovery of this role by the program upgrade authority is pending, so the role cannot be rotated. Cancel the recovery first (or let it be executed), then rotate (PlatformRecoveryPending).";
/** transfer_hook: the blocklist-authority recovery does not match (InvalidRecovery, 6019). */
export const BLOCKLIST_RECOVERY_INVALID_HINT =
  "This blocklist-authority recovery no longer matches: the blocklist authority changed since it was proposed, this wallet is not the proposed key, or the signer is not the program upgrade authority (InvalidRecovery).";
/** transfer_hook: a BA rotation refused while a recovery is pending (RecoveryPending, 6020). */
export const BLOCKLIST_RECOVERY_PENDING_HINT =
  "A recovery of the blocklist authority by the program upgrade authority is pending, so the role cannot be rotated. Cancel the recovery first (or let it be executed), then rotate (RecoveryPending).";
/** transfer_hook: Open mode named a registry (KycRegistryNotAllowed, 6016). */
export const KYC_REGISTRY_NOT_ALLOWED_HINT =
  "An Open mint must not name a KYC registry — choose KYC-gated, or clear the registry (KycRegistryNotAllowed).";

/**
 * asset_registry custom errors whose raw log ("custom program error: 0x17bd")
 * is meaningless to a user but whose cause is actionable. Codes come from the
 * GENERATED error constants, so a program renumbering can never leave a stale
 * code here. Every code is above the hook's last (6020), so lib/tx-error can
 * still look them up by hex when the failing program is not named.
 */
export const REGISTRY_ERROR_HINTS: ReadonlyMap<number, string> = new Map<number, string>([
  // 6112 / 6113: every propose / accept of an authority proposal (platform
  // admin, custody vault, KYC registry, issuer). Registry codes 6017–6020
  // are left out: the hook uses the same numbers.
  [
    ASSET_REGISTRY_ERROR__INVALID_AUTHORITY_TRANSFER,
    "The pending transfer does not match: cancelled, replaced, or proposed to another wallet (InvalidAuthorityTransfer).",
  ],
  [
    ASSET_REGISTRY_ERROR__INVALID_PROPOSED_AUTHORITY,
    "The new authority must be a different, non-default wallet; an issuer key can only move onto a Manci admin wallet if it already is one (InvalidProposedAuthority).",
  ],
  [
    ASSET_REGISTRY_ERROR__KYC_PROOF_REQUIRED,
    "This sale's KYC proof accounts were missing from the transaction — reload the page and try again (KycProofRequired).",
  ],
  [
    ASSET_REGISTRY_ERROR__MINT_DESTINATION_NOT_BOUND,
    "Units may only be minted to the issuer treasury or to a custody / rights escrow of this mint (MintDestinationNotBound).",
  ],
  [
    ASSET_REGISTRY_ERROR__RECEIVER_NOT_APPROVED,
    "The wallet (receiver, or the custody beneficiary converting / taking delivery) has no approved investor passport on the KYC registry in play (ReceiverNotApproved).",
  ],
  [
    ASSET_REGISTRY_ERROR__RECEIVER_KYC_EXPIRED,
    "The wallet's (receiver or custody beneficiary) investor passport has expired — renew it first (ReceiverKycExpired).",
  ],
  [
    ASSET_REGISTRY_ERROR__RECEIVER_JURISDICTION_BLOCKED,
    "The wallet's (receiver or custody beneficiary) passport jurisdiction is not allowed by the KYC registry (ReceiverJurisdictionBlocked).",
  ],
  [
    ASSET_REGISTRY_ERROR__DEPOSITOR_NOT_BENEFICIARY,
    "Only a delivery / conversion escrow accepts deposits, and only from its own beneficiary — connect the wallet the request was opened for (DepositorNotBeneficiary).",
  ],
  [
    ASSET_REGISTRY_ERROR__INVALID_DEPOSIT_AMOUNT,
    "Deposit amount is zero, or would take the escrow past what this offer sells — reload to see how much is still outstanding (InvalidDepositAmount).",
  ],
  [
    ASSET_REGISTRY_ERROR__VAULT_NOT_ACCEPTING_DEPOSITS,
    "This escrow is no longer accepting deposits — it has already been triggered, returned or closed (VaultNotAcceptingDeposits).",
  ],
  [
    ASSET_REGISTRY_ERROR__INVALID_PAUSE_FLAGS,
    "Those pause flags are not valid: only the seven pause bits (0x7F) can be set — the bootstrap marker (0x80) never — and one bit cannot be set and cleared in the same step (InvalidPauseFlags).",
  ],
  [
    ASSET_REGISTRY_ERROR__PAUSE_CLEAR_NOT_ALLOWED,
    "Only the Super Admin can resume a paused area. Admins can pause, not resume (PauseClearNotAllowed).",
  ],
  [
    ASSET_REGISTRY_ERROR__INVALID_PROTOCOL_TREASURY,
    "The protocol treasury must be a real wallet address, not the default 1111…1111 address (InvalidProtocolTreasury).",
  ],
  [ASSET_REGISTRY_ERROR__INVALID_SALE_PRICE, "The sale price per unit must be greater than zero (InvalidSalePrice)."],
  [
    ASSET_REGISTRY_ERROR__SALE_APPROVAL_EXPIRED,
    "This sale approval has expired. Ask Manci to approve the sale again (SaleApprovalExpired).",
  ],
  [
    ASSET_REGISTRY_ERROR__SALE_APPROVAL_MISMATCH,
    "The sale does not match its approval: check the payment mint and raise type, and that the approving admin receives the approval's rent (SaleApprovalMismatch).",
  ],
  [
    ASSET_REGISTRY_ERROR__SALE_PRICE_OUTSIDE_APPROVAL,
    "The price per unit is outside the range Manci approved for this sale (SalePriceOutsideApproval).",
  ],
  [
    ASSET_REGISTRY_ERROR__SALE_EXCEEDS_APPROVED_RAISE,
    "Price x units for sale is above the approved maximum raise. Lower the number of units or the price (SaleExceedsApprovedRaise).",
  ],
  [
    ASSET_REGISTRY_ERROR__INVALID_SALE_APPROVAL,
    "Approval terms are invalid: the expiry must be in the future and at most 90 days away, the minimum price at least 1 and not above the maximum, and the maximum raise above zero (InvalidSaleApproval).",
  ],
  [
    ASSET_REGISTRY_ERROR__SALE_ID_ALREADY_USED,
    "A sale with this id already exists for the share class. Pick the next free sale id (SaleIdAlreadyUsed).",
  ],
  [
    ASSET_REGISTRY_ERROR__TREASURY_MINT_REQUIRES_ADMIN,
    "Only a Manci admin issuer key can mint into the issuer treasury. Issue units to investors through an approved sale instead (TreasuryMintRequiresAdmin).",
  ],
  [
    ASSET_REGISTRY_ERROR__SALE_VESTING_OUTSIDE_APPROVAL,
    "The cliff and vesting months must be exactly the ones Manci approved for this sale (SaleVestingOutsideApproval).",
  ],
  [
    ASSET_REGISTRY_ERROR__SALE_STARTS_AFTER_APPROVAL_EXPIRY,
    "The sale must start before its approval expires (SaleStartsAfterApprovalExpiry).",
  ],
  // 2C-2: issuer authority recovery and the payout-vault founder snapshot.
  [
    ASSET_REGISTRY_ERROR__ISSUER_RECOVERY_TIMELOCK_ACTIVE,
    "This issuer recovery is still inside its 7-day waiting period. It can be executed once the countdown ends (IssuerRecoveryTimelockActive).",
  ],
  [
    ASSET_REGISTRY_ERROR__ISSUER_RECOVERY_EXPIRED,
    "The 14-day window to execute this issuer recovery has passed. The Super Admin must cancel it and propose it again (IssuerRecoveryExpired).",
  ],
  [
    ASSET_REGISTRY_ERROR__INVALID_ISSUER_RECOVERY,
    "This issuer recovery no longer matches: the issuer key or the Super Admin changed since it was proposed, this wallet is not the proposed key, or the proposed key is a Manci admin wallet (a recovery never lands on one). Cancel it and propose again (InvalidIssuerRecovery).",
  ],
  // 2C-3: KYC at conversion / delivery (DeliveryEscrow realize).
  [
    ASSET_REGISTRY_ERROR__CUSTODY_KYC_REGISTRY_REQUIRED,
    "A delivery / conversion escrow must pin the platform KYC registry when it is opened, and confirming it must pass that registry with the holder's passport entry. Reload and try again (CustodyKycRegistryRequired).",
  ],
  [
    ASSET_REGISTRY_ERROR__CUSTODY_KYC_REGISTRY_NOT_ALLOWED,
    "Only a delivery / conversion escrow pins a KYC registry. Open other vault types without one (CustodyKycRegistryNotAllowed).",
  ],
  [
    ASSET_REGISTRY_ERROR__CUSTODY_KYC_REGISTRY_MISMATCH,
    "This escrow pinned a different KYC registry when it was opened. Confirm it against that registry, or return the deposit and re-open the vault (CustodyKycRegistryMismatch).",
  ],
  // Clawback (both permanent-delegate paths; 2C-4 appended 6137 / 6138).
  [
    ASSET_REGISTRY_ERROR__CLAWBACK_HOLDER_STILL_ELIGIBLE,
    "The passport path claws back only from a holder whose passport is revoked, or expired for at least 30 days (the grace lets a holder renew). If the wallet is sanctioned, have the Blocklist Authority block it and use the blocklist path (ClawbackHolderStillEligible).",
  ],
  [
    ASSET_REGISTRY_ERROR__CLAWBACK_NOT_KYC_GATED,
    "The passport path only works on KYC-gated mints. On an Open mint, a wallet on the blocklist can be clawed back through the blocklist path (ClawbackNotKycGated).",
  ],
  [
    ASSET_REGISTRY_ERROR__CLAWBACK_DESTINATION_INVALID,
    "Clawed-back units can only go into an active burn-only quarantine vault (Redemption queue + burn and attest) of this share class. Open one, or reload if it was just triggered (ClawbackDestinationInvalid).",
  ],
  [
    ASSET_REGISTRY_ERROR__CLAWBACK_TARGET_IS_ESCROW,
    "That address is one of the platform's own escrows, not a holder wallet, and can never be clawed back. Let the escrow pay the wallet out first (cancel, expire or return), then claw back from the wallet. If the escrow address itself is on the blocklist, its exits are refused too: remove it from the blocklist first so they can run, and block the recipient wallet instead (ClawbackTargetIsEscrow).",
  ],
  [
    ASSET_REGISTRY_ERROR__CLAWBACK_HOLDER_NOT_BLOCKED,
    "This wallet is not on the blocklist (or was removed from it). The Blocklist Authority must add it before the blocklist path can be used (ClawbackHolderNotBlocked).",
  ],
  [
    ASSET_REGISTRY_ERROR__HOOK_CONFIG_INVALID,
    "The mint's transfer-hook config is missing or does not belong to this share class. Reload and pick the share class again (HookConfigInvalid).",
  ],
  // Rent reclaim and custody opening (2D appended 6139–6142).
  [
    ASSET_REGISTRY_ERROR__ESCROW_NOT_EMPTY,
    "The escrow still holds tokens (for example a withheld surplus or dust sent after settlement), so its rent cannot be reclaimed. Nothing was changed (EscrowNotEmpty).",
  ],
  [
    ASSET_REGISTRY_ERROR__ACCOUNT_NOT_CLOSABLE,
    "This account is still live. Rent can be reclaimed only after it is settled, cancelled or expired; a passport only once it is revoked and past its expiry (AccountNotClosable).",
  ],
  [
    ASSET_REGISTRY_ERROR__BENEFICIARY_NOT_ALLOWED,
    "Only a delivery escrow may name a beneficiary. Leave the beneficiary empty for vesting and redemption vaults (BeneficiaryNotAllowed).",
  ],
  [
    ASSET_REGISTRY_ERROR__VAULT_TYPE_RETIRED,
    "Conversion-pending vaults are retired. Holder conversions use a delivery escrow (VaultTypeRetired).",
  ],
  [
    ASSET_REGISTRY_ERROR__NOT_FOUNDER,
    "This wallet is not the payout vault's founder. If the issuer key was rotated, sync the payout vault first (NotFounder).",
  ],
  // v1.0.0-rc (8.3) appended 6143–6155.
  [ASSET_REGISTRY_ERROR__ISSUER_PROCEEDS_FROZEN, ISSUER_PROCEEDS_FROZEN_HINT],
  [ASSET_REGISTRY_ERROR__PARTY_BLOCKLISTED, PARTY_BLOCKLISTED_HINT],
  [
    ASSET_REGISTRY_ERROR__SALE_DURATION_INVALID,
    "A sale needs an end date after its start and at most 365 days after it (or after now, if it starts in the past) (SaleDurationInvalid).",
  ],
  [
    ASSET_REGISTRY_ERROR__KYC_EXPIRY_TOO_FAR,
    "A passport may be valid for at most 2 years from today. Choose an earlier expiry (KycExpiryTooFar).",
  ],
  [
    ASSET_REGISTRY_ERROR__VOTING_PERIOD_TOO_SHORT,
    "A payout-vault vote must run for at least 7 days so every holder has notice (VotingPeriodTooShort).",
  ],
  [
    ASSET_REGISTRY_ERROR__DELIVERY_DEADLINE_OUT_OF_RANGE,
    "A delivery escrow's deadline must be at least 24 hours and at most 365 days away (DeliveryDeadlineOutOfRange).",
  ],
  [ASSET_REGISTRY_ERROR__DEAL_EXPIRY_OUT_OF_RANGE, "An OTC deal needs an expiry at most 90 days away (DealExpiryOutOfRange)."],
  [ASSET_REGISTRY_ERROR__TIMELOCK_ACTIVE, TIMELOCK_ACTIVE_HINT],
  [ASSET_REGISTRY_ERROR__PROPOSAL_EXPIRED, PROPOSAL_EXPIRED_HINT],
  [
    ASSET_REGISTRY_ERROR__INVALID_ADMIN_PROPOSAL,
    "This Admin grant no longer matches: connect the proposed wallet itself, and check that the Super Admin who proposed it still holds the role (a proposal from an earlier Super Admin must be proposed again) (InvalidAdminProposal).",
  ],
  [
    ASSET_REGISTRY_ERROR__INVALID_PLATFORM_RECOVERY,
    "This Super Admin recovery no longer matches: the Super Admin changed since it was proposed, this wallet is not the proposed key, or the signer is not the program upgrade authority (InvalidPlatformRecovery).",
  ],
  [
    ASSET_REGISTRY_ERROR__PAYOUT_MODULES_CLEAR_NOT_EXPLICIT,
    "The payout modules (0x40) can only be switched on in a call of their own. Resume the other areas separately; nothing was changed (PayoutModulesClearNotExplicit).",
  ],
  [ASSET_REGISTRY_ERROR__PLATFORM_RECOVERY_PENDING, PLATFORM_RECOVERY_PENDING_HINT],
]);

/** transfer_hook custom errors (6000–6020), worded for the person sending. */
export const HOOK_ERROR_HINTS: ReadonlyMap<number, string> = new Map<number, string>([
  [
    TRANSFER_HOOK_ERROR__KYC_REGISTRY_REQUIRED,
    "This share class is KYC-gated but its transfer-hook config names no KYC registry, so no transfer can be checked. The Blocklist Authority must set the registry again",
  ],
  [
    TRANSFER_HOOK_ERROR__MISSING_EXTRA_ACCOUNT,
    "The transfer was missing one of the accounts the transfer hook needs. Reload the page and try again",
  ],
  [
    TRANSFER_HOOK_ERROR__SENDER_BLOCKED,
    "The sending wallet is on the Manci blocklist, so the transfer hook refuses every transfer out of it (only Manci can claw the tokens back)",
  ],
  [TRANSFER_HOOK_ERROR__UNAUTHORIZED, "This wallet is not the Manci blocklist authority"],
  [
    TRANSFER_HOOK_ERROR__RECEIVER_NOT_APPROVED,
    "The recipient has no approved investor passport in this share class's KYC registry",
  ],
  [
    TRANSFER_HOOK_ERROR__HOLDER_KYC_EXPIRED,
    "The recipient's investor passport has expired. It must be renewed before the recipient can receive tokens",
  ],
  [
    TRANSFER_HOOK_ERROR__JURISDICTION_BLOCKED,
    "The recipient's passport country is not allowed by this share class's KYC registry",
  ],
  [TRANSFER_HOOK_ERROR__INVALID_KYC_ENTRY, "The recipient's investor passport record is malformed and cannot be read"],
  [
    TRANSFER_HOOK_ERROR__INVALID_KYC_REGISTRY,
    "The KYC registry in the transfer is not the one this share class's transfer hook names, or cannot be read. Reload the page and try again",
  ],
  [
    TRANSFER_HOOK_ERROR__META_LIST_NOT_INITIALIZED,
    "This mint has no transfer-hook account list yet, so it cannot be transferred",
  ],
  [
    TRANSFER_HOOK_ERROR__IMMUTABLE_OWNER_REQUIRED,
    "The receiving token account is not a standard one (it can change owner). Send to the recipient's wallet address, so their standard token account is used",
  ],
  [TRANSFER_HOOK_ERROR__INVALID_TOKEN_ACCOUNT, "One of the token accounts is not a Token-2022 account"],
  [
    TRANSFER_HOOK_ERROR__INVALID_BLOCK_ENTRY,
    "The transfer named the wrong blocklist entry for the sender. Reload the page and try again",
  ],
  [TRANSFER_HOOK_ERROR__KYC_REGISTRY_NOT_ALLOWED, KYC_REGISTRY_NOT_ALLOWED_HINT],
  [TRANSFER_HOOK_ERROR__PROPOSAL_EXPIRED, PROPOSAL_EXPIRED_HINT],
  [TRANSFER_HOOK_ERROR__TIMELOCK_ACTIVE, TIMELOCK_ACTIVE_HINT],
  [TRANSFER_HOOK_ERROR__INVALID_RECOVERY, BLOCKLIST_RECOVERY_INVALID_HINT],
  [TRANSFER_HOOK_ERROR__RECOVERY_PENDING, BLOCKLIST_RECOVERY_PENDING_HINT],
]);

/** Token-2022's TLV account-resolution IncorrectAccount (spl-tlv-account-resolution), 0xa261c2c0. */
export const TOKEN_2022_INCORRECT_ACCOUNT = 2_724_315_840;

/** Token-2022 custom codes a share-token transfer can meet (spl-token-2022 TokenError + IncorrectAccount). */
export const TOKEN_2022_ERROR_NAMES: ReadonlyMap<number, string> = new Map([
  [0, "NotRentExempt"],
  [1, "InsufficientFunds"],
  [2, "InvalidMint"],
  [3, "MintMismatch"],
  [4, "OwnerMismatch"],
  [6, "AlreadyInUse"],
  [9, "UninitializedState"],
  [17, "AccountFrozen"],
  [18, "MintDecimalsMismatch"],
  [31, "MintRequiredForTransfer"],
  [TOKEN_2022_INCORRECT_ACCOUNT, "IncorrectAccount"],
]);

const TOKEN_2022_HINTS: ReadonlyMap<number, string> = new Map([
  [1, "The sending token account does not hold enough tokens for this amount"],
  [3, "A token account in this transfer belongs to a different share class (another mint)"],
  [4, "The signing wallet does not own the sending token account"],
  [9, "A token account in this transfer does not exist yet"],
  [17, "A token account in this transfer is frozen"],
  [18, "The transfer used the wrong number of decimals for this mint (share tokens have 0 decimals)"],
  [
    TOKEN_2022_INCORRECT_ACCOUNT,
    "The transfer-hook accounts in the transaction do not match the mint's on-chain account list. Reload the page and try again",
  ],
]);

/** Associated Token Account program: InvalidOwner (0). */
const ATA_HINTS: ReadonlyMap<number, string> = new Map([
  [0, "The recipient's token account address does not belong to the recipient's wallet"],
]);
const ATA_ERROR_NAMES: ReadonlyMap<number, string> = new Map([[0, "InvalidOwner"]]);

/** System program custom errors (SystemError). */
const SYSTEM_HINTS: ReadonlyMap<number, string> = new Map([
  [0, "An account this transaction creates already exists"],
  [1, "The paying wallet does not have enough SOL for this transaction (insufficient lamports)"],
]);
const SYSTEM_ERROR_NAMES: ReadonlyMap<number, string> = new Map([
  [0, "AccountAlreadyInUse"],
  [1, "ResultWithNegativeLamports"],
]);

/** The name of a custom code of any program this app calls, or null. */
export function customErrorName(program: string | null, code: number): string | null {
  const label = knownProgram(program);
  switch (label) {
    case "asset_registry":
    case "transfer_hook":
      return errorName(label, code);
    case "token_2022":
      return TOKEN_2022_ERROR_NAMES.get(code) ?? null;
    case "associated_token":
      return ATA_ERROR_NAMES.get(code) ?? null;
    case "system":
      return SYSTEM_ERROR_NAMES.get(code) ?? null;
    default:
      return null;
  }
}

/**
 * Plain English for one program's custom error, or null when there is none.
 * `program` is a label (classifyFailure) or an address. The registry's
 * wording carries its error name; the others do not (the caller names it).
 */
export function programErrorHint(failure: { program: string | null; code: number | null; name?: string | null }): string | null {
  const { code } = failure;
  if (code === null) return null;
  switch (knownProgram(failure.program)) {
    case "asset_registry":
      return REGISTRY_ERROR_HINTS.get(code) ?? null;
    case "transfer_hook":
      return HOOK_ERROR_HINTS.get(code) ?? null;
    case "token_2022":
      return TOKEN_2022_HINTS.get(code) ?? null;
    case "associated_token":
      return ATA_HINTS.get(code) ?? null;
    case "system":
      return SYSTEM_HINTS.get(code) ?? null;
    default:
      return null;
  }
}

// ── Transaction errors (the network refusing before any instruction runs) ────

/** The Agave TransactionError name of each kit code 7050000 + i (kit 5.5.1). */
export const TRANSACTION_ERROR_NAMES: readonly string[] = [
  "Unknown", "AccountInUse", "AccountLoadedTwice", "AccountNotFound", "ProgramAccountNotFound",
  "InsufficientFundsForFee", "InvalidAccountForFee", "AlreadyProcessed", "BlockhashNotFound",
  "CallChainTooDeep", "MissingSignatureForFee", "InvalidAccountIndex", "SignatureFailure",
  "InvalidProgramForExecution", "SanitizeFailure", "ClusterMaintenance", "AccountBorrowOutstanding",
  "WouldExceedMaxBlockCostLimit", "UnsupportedVersion", "InvalidWritableAccount",
  "WouldExceedMaxAccountCostLimit", "WouldExceedAccountDataBlockLimit", "TooManyAccountLocks",
  "AddressLookupTableNotFound", "InvalidAddressLookupTableOwner", "InvalidAddressLookupTableData",
  "InvalidAddressLookupTableIndex", "InvalidRentPayingAccount", "WouldExceedMaxVoteCostLimit",
  "WouldExceedAccountDataTotalLimit", "DuplicateInstruction", "InsufficientFundsForRent",
  "MaxLoadedAccountsDataSizeExceeded", "InvalidLoadedAccountsDataSizeLimit", "ResanitizationNeeded",
  "ProgramExecutionTemporarilyRestricted", "UnbalancedTransaction",
];

/**
 * The user-facing wording of a TransactionError by its Agave name, or null
 * for a name without one (the caller words it generically).
 */
export function transactionErrorText(name: string, network: string): string | null {
  switch (name) {
    case "BlockhashNotFound":
      return `The network did not recognise the transaction's blockhash (BlockhashNotFound): it expired while the wallet was open, or it came from another network than ${network}. Check the wallet's network and try again.`;
    case "DuplicateInstruction":
      return "The transaction carries the same compute-budget instruction twice (DuplicateInstruction), usually because the wallet added its own priority fee to the app's.";
    case "AccountNotFound":
      return `The paying wallet has no SOL on ${network} (AccountNotFound).`;
    case "InsufficientFundsForFee":
      return `The paying wallet does not have enough SOL on ${network} for the network fee (InsufficientFundsForFee).`;
    case "InsufficientFundsForRent":
      return `An account in this transaction would be left below its rent-exempt minimum, usually because the paying wallet has too little SOL on ${network} (InsufficientFundsForRent).`;
    case "ProgramAccountNotFound":
      return `The transaction calls a program that does not exist on ${network} (ProgramAccountNotFound).`;
    case "SignatureFailure":
      return "The transaction's signature does not match its contents (SignatureFailure).";
    case "MaxLoadedAccountsDataSizeExceeded":
      return "The transaction's loaded-account data limit is too small for the accounts it uses (MaxLoadedAccountsDataSizeExceeded), usually a limit the wallet added.";
    case "InvalidLoadedAccountsDataSizeLimit":
      return "The transaction sets a loaded-account data limit of zero or an invalid one (InvalidLoadedAccountsDataSizeLimit), usually a limit the wallet added.";
    case "AlreadyProcessed":
      return "This exact transaction was already processed (AlreadyProcessed); reload to see its result.";
    default:
      return null;
  }
}

/** Runtime instruction errors (no custom code), by name, worded for the sender. */
export function instructionErrorText(name: string): string | null {
  switch (name) {
    case "ComputationalBudgetExceeded":
      return "It ran out of compute units (ComputationalBudgetExceeded)";
    case "InsufficientFunds":
      return "An account does not have enough funds (InsufficientFunds)";
    case "IllegalOwner":
      return "An account in it is owned by the wrong program, for example an address that is not a wallet (IllegalOwner)";
    case "InvalidAccountData":
      return "An account in it holds data of the wrong kind (InvalidAccountData)";
    case "InvalidAccountOwner":
      return "An account in it is owned by the wrong program (InvalidAccountOwner)";
    case "MissingRequiredSignature":
      return "A required signature is missing (MissingRequiredSignature)";
    case "AccountNotRentExempt":
      return "An account would be left below its rent-exempt minimum (AccountNotRentExempt)";
    default:
      return null;
  }
}
