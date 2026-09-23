import {
  ASSET_REGISTRY_ERROR__DEPOSITOR_NOT_BENEFICIARY,
  ASSET_REGISTRY_ERROR__INVALID_AUTHORITY_TRANSFER,
  ASSET_REGISTRY_ERROR__INVALID_DEPOSIT_AMOUNT,
  ASSET_REGISTRY_ERROR__INVALID_ISSUER_RECOVERY,
  ASSET_REGISTRY_ERROR__ISSUER_RECOVERY_EXPIRED,
  ASSET_REGISTRY_ERROR__ISSUER_RECOVERY_TIMELOCK_ACTIVE,
  ASSET_REGISTRY_ERROR__NOT_FOUNDER,
  ASSET_REGISTRY_ERROR__INVALID_PROPOSED_AUTHORITY,
  ASSET_REGISTRY_ERROR__INVALID_PAUSE_FLAGS,
  ASSET_REGISTRY_ERROR__INVALID_PROTOCOL_TREASURY,
  ASSET_REGISTRY_ERROR__INVALID_SALE_APPROVAL,
  ASSET_REGISTRY_ERROR__INVALID_SALE_PRICE,
  ASSET_REGISTRY_ERROR__KYC_PROOF_REQUIRED,
  ASSET_REGISTRY_ERROR__MINT_DESTINATION_NOT_BOUND,
  ASSET_REGISTRY_ERROR__PAUSE_CLEAR_NOT_ALLOWED,
  ASSET_REGISTRY_ERROR__RECEIVER_JURISDICTION_BLOCKED,
  ASSET_REGISTRY_ERROR__RECEIVER_KYC_EXPIRED,
  ASSET_REGISTRY_ERROR__RECEIVER_NOT_APPROVED,
  ASSET_REGISTRY_ERROR__SALE_APPROVAL_EXPIRED,
  ASSET_REGISTRY_ERROR__SALE_APPROVAL_MISMATCH,
  ASSET_REGISTRY_ERROR__SALE_EXCEEDS_APPROVED_RAISE,
  ASSET_REGISTRY_ERROR__SALE_ID_ALREADY_USED,
  ASSET_REGISTRY_ERROR__SALE_PRICE_OUTSIDE_APPROVAL,
  ASSET_REGISTRY_ERROR__SALE_STARTS_AFTER_APPROVAL_EXPIRY,
  ASSET_REGISTRY_ERROR__SALE_VESTING_OUTSIDE_APPROVAL,
  ASSET_REGISTRY_ERROR__TREASURY_MINT_REQUIRES_ADMIN,
  ASSET_REGISTRY_ERROR__VAULT_NOT_ACCEPTING_DEPOSITS,
} from "@/lib/generated/asset_registry";
import { detectNetwork } from "@/lib/network";
import { MaintenanceModeError } from "@/lib/maintenance";

// Pull a human-readable cause out of a @solana/react-hooks send() error.
// Those errors wrap the real RPC simulation logs inside `transactionPlanResult`
// and the legacy `cause` chain — both lost when toString() is called.

type AnyRecord = Record<string, unknown>;

function pickString(obj: AnyRecord, key: string): string | undefined {
  const v = obj[key];
  return typeof v === "string" ? v : undefined;
}

function gatherLogs(value: unknown, out: string[], depth = 0): void {
  if (depth > 6 || value == null) return;
  if (Array.isArray(value)) {
    for (const item of value) gatherLogs(item, out, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  const obj = value as AnyRecord;
  if (Array.isArray(obj.logs)) {
    for (const l of obj.logs) {
      if (typeof l === "string") out.push(l);
    }
  }
  for (const k of Object.keys(obj)) {
    gatherLogs(obj[k], out, depth + 1);
  }
}

// asset_registry custom errors whose raw log ("custom program error: 0x17bd")
// is meaningless to a user but whose cause is actionable. Codes come from the
// GENERATED error constants, so a program renumbering can never leave a stale
// hex here.
const CUSTOM_ERROR_HINTS: Record<string, string> = Object.fromEntries(
  (
    [
      // 6112 / 6113: every propose / accept of an authority transfer (platform
      // admin, custody vault, KYC registry). They are above every transfer-hook
      // code (≤ 6016), so the hex cannot collide across programs.
      [
        ASSET_REGISTRY_ERROR__INVALID_AUTHORITY_TRANSFER,
        "The pending transfer does not match: cancelled, replaced, or proposed to another wallet (InvalidAuthorityTransfer).",
      ],
      [
        ASSET_REGISTRY_ERROR__INVALID_PROPOSED_AUTHORITY,
        "The new authority must be a different, non-default wallet (InvalidProposedAuthority).",
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
        "The receiving wallet has no approved investor passport on this mint's KYC registry (ReceiverNotApproved).",
      ],
      [
        ASSET_REGISTRY_ERROR__RECEIVER_KYC_EXPIRED,
        "The receiving wallet's investor passport has expired — re-verify before buying (ReceiverKycExpired).",
      ],
      [
        ASSET_REGISTRY_ERROR__RECEIVER_JURISDICTION_BLOCKED,
        "The receiving wallet's passport jurisdiction is not approved for this mint (ReceiverJurisdictionBlocked).",
      ],
      [
        ASSET_REGISTRY_ERROR__DEPOSITOR_NOT_BENEFICIARY,
        "Only the escrow's own beneficiary can fund it — connect the wallet the request was opened for (DepositorNotBeneficiary).",
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
        "Those pause flags are not valid: only the six defined areas can be paused, and one area cannot be paused and resumed in the same step (InvalidPauseFlags).",
      ],
      [
        ASSET_REGISTRY_ERROR__PAUSE_CLEAR_NOT_ALLOWED,
        "Only the Super Admin can resume a paused area. Admins can pause, not resume (PauseClearNotAllowed).",
      ],
      [
        ASSET_REGISTRY_ERROR__INVALID_PROTOCOL_TREASURY,
        "The protocol treasury must be a real wallet address, not the default 1111…1111 address (InvalidProtocolTreasury).",
      ],
      [
        ASSET_REGISTRY_ERROR__INVALID_SALE_PRICE,
        "The sale price per unit must be greater than zero (InvalidSalePrice).",
      ],
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
        "This issuer recovery no longer matches: the issuer key or the Super Admin changed since it was proposed, or this wallet is not the proposed key. Cancel it and propose again (InvalidIssuerRecovery).",
      ],
      [
        ASSET_REGISTRY_ERROR__NOT_FOUNDER,
        "This wallet is not the payout vault's founder. If the issuer key was rotated, sync the payout vault first (NotFounder).",
      ],
    ] as const
  ).map(([code, hint]) => [`0x${code.toString(16)}`, hint]),
);

/** User-facing text for the registry's emergency pause (PlatformPaused, 6000). */
export const PLATFORM_PAUSED_HINT =
  "Manci has temporarily paused this action (emergency pause). Cancels, refunds and claims still work.";

/** open_sale's `sale_approval` account does not exist (AccountNotInitialized, 3012). */
export const NO_SALE_APPROVAL_HINT =
  "No live sale approval for this share class and sale id: it was never approved, was revoked, or was already used.";
/** open_sale was given another sale id's approval (ConstraintSeeds, 2006). */
export const SALE_APPROVAL_OTHER_ID_HINT = "This approval belongs to a different sale id.";
/** open_sale's approver no longer holds an Admin record (AccountNotInitialized, 3012). */
export const APPROVER_NOT_ADMIN_HINT =
  "The admin who approved this sale is no longer a Manci admin, so the approval cannot be used. Ask Manci to revoke it and approve the sale again.";

/** approve/revoke/rotation/jurisdictions signed by a non-authority (Unauthorized on kyc_registry). */
export const KYC_REGISTRY_NOT_AUTHORITY_HINT =
  "This wallet is not the KYC registry's current authority (it may have been rotated).";
/** accept/cancel with no staged transfer (AccountNotInitialized on `transfer`). */
export const NO_PENDING_AUTHORITY_TRANSFER_HINT = "No pending authority transfer.";
/** close_sale / open_payout_vault by a key that is not the sale's authority snapshot (Unauthorized on `sale`). */
export const SALE_AUTHORITY_HINT =
  "This wallet is not the sale's recorded authority. If the issuer key was rotated, sync the sale first; otherwise connect the issuer's current wallet.";
/** transfer_hook: Open mode named a registry (KycRegistryNotAllowed, 6016). */
export const KYC_REGISTRY_NOT_ALLOWED_HINT =
  "An Open mint must not name a KYC registry — choose KYC-gated, or clear the registry (KycRegistryNotAllowed).";
/**
 * InvalidKycRegistry exists in BOTH programs under the same name: the hook's
 * 6009 (update_transfer_hook_config: the named account is not a genuine,
 * matching registry) and asset_registry's 6072 (buy / claim / clawback: the
 * registry passed is malformed or is not the one the mint's hook config
 * names). The wording is neutral so it is true for either.
 */
export const INVALID_KYC_REGISTRY_HINT =
  "The KYC registry account is not a Manci KycRegistry, or is not the registry expected here (the one this mint's transfer-hook config names, or the one being set). Reload and retry; if it persists, check NEXT_PUBLIC_KYC_REGISTRY (InvalidKycRegistry).";

function customErrorHint(text: string): string | null {
  // PlatformPaused is 6000 (0x1770) — the same number as the transfer hook's
  // first error — so match Anchor's error name, never the bare code.
  if (/Error Code: PlatformPaused\b/.test(text)) return PLATFORM_PAUSED_HINT;
  // KYC registry (2C-1). Unauthorized (6001) and the hook's 6009 / 6016 share
  // numbers with the other program, so these match Anchor's names too.
  if (/caused by account: kyc_registry\. Error Code: Unauthorized\b/.test(text)) return KYC_REGISTRY_NOT_AUTHORITY_HINT;
  if (/caused by account: transfer\. Error Code: AccountNotInitialized\b/.test(text)) return NO_PENDING_AUTHORITY_TRANSFER_HINT;
  if (/caused by account: sale\. Error Code: Unauthorized\b/.test(text)) return SALE_AUTHORITY_HINT;
  if (/Error Code: KycRegistryNotAllowed\b/.test(text)) return KYC_REGISTRY_NOT_ALLOWED_HINT;
  if (/Error Code: InvalidKycRegistry\b/.test(text)) return INVALID_KYC_REGISTRY_HINT;
  // open_sale without a usable approval: Anchor names the account; the bare
  // codes (3012 / 2006) are shared by every account of every instruction.
  if (/caused by account: sale_approval\. Error Code: AccountNotInitialized\b/.test(text)) return NO_SALE_APPROVAL_HINT;
  if (/caused by account: sale_approval\. Error Code: ConstraintSeeds\b/.test(text)) return SALE_APPROVAL_OTHER_ID_HINT;
  if (/caused by account: approver_admin_record\. Error Code: AccountNotInitialized\b/.test(text)) return APPROVER_NOT_ADMIN_HINT;
  const match = /custom program error:\s*(0x[0-9a-f]+)/i.exec(text);
  if (!match) return null;
  return CUSTOM_ERROR_HINTS[match[1].toLowerCase()] ?? null;
}

export function explainSendError(err: unknown): string {
  if (err == null) return "Unknown error";

  // Maintenance refusals are already worded for users; SDK hooks may wrap them.
  for (let cursor: unknown = err, depth = 0; cursor instanceof Error && depth < 6; cursor = cursor.cause, depth++) {
    if (cursor instanceof MaintenanceModeError) return cursor.message;
  }

  // Common case: a wallet-side rejection.
  if (typeof err === "object" && err !== null) {
    const obj = err as AnyRecord;
    const code = obj.code;
    if (code === 4001 || code === "WALLET_REJECTED") {
      return "Wallet rejected the transaction.";
    }
  }

  const message = err instanceof Error ? err.message : String(err);

  // Walk the error chain and collect any program logs.
  const logs: string[] = [];
  const nestedMessages: string[] = [];
  // Breadth-first over the cause chain AND the instruction-plan tree: a failed
  // plan (kit error 7618003) wraps the real transaction error several levels
  // down (context.transactionPlanResult → plans[] → error → cause/context).
  const queue: unknown[] = [err];
  const seen = new Set<unknown>();
  while (queue.length > 0 && seen.size < 200) {
    const cursor = queue.shift();
    if (cursor == null || typeof cursor !== "object" || seen.has(cursor)) continue;
    seen.add(cursor);
    const obj = cursor as AnyRecord;
    gatherLogs(obj.transactionPlanResult, logs);
    gatherLogs(obj.context, logs);
    gatherLogs(obj.simulationResponse, logs);
    if (Array.isArray(obj.logs)) {
      for (const l of obj.logs) if (typeof l === "string") logs.push(l);
    }
    if (cursor !== err && cursor instanceof Error && cursor.message) nestedMessages.push(cursor.message);
    for (const key of ["cause", "error", "context", "transactionPlanResult", "plans", "simulationResponse"]) {
      const next = obj[key];
      if (Array.isArray(next)) queue.push(...next);
      else if (next && typeof next === "object") queue.push(next);
    }
  }
  // "already in use" = an `init` account exists (e.g. granting an admin twice).
  if (logs.some((l) => /already in use/i.test(l))) {
    return "This account already exists on-chain (the action was already done — e.g. this wallet is already an admin).";
  }

  // A known custom program error beats any raw log line.
  const hint = customErrorHint([message, ...logs].join("\n"));
  if (hint) return hint;

  // Surface the most useful log line, if any.
  const programLog = logs.find((l) =>
    /Program log: |Error:|failed:|insufficient|already in use|InvalidAccountOwner/i.test(
      l,
    ),
  );
  if (programLog) {
    return `${message} — ${programLog.replace(/^Program log:\s*/, "")}`;
  }
  if (logs.length > 0) {
    return `${message} — ${logs[logs.length - 1]}`;
  }
  const inner = nestedMessages.find((m) => m !== message && !/transaction plan/i.test(m));
  if (inner) return `${message} — ${inner}`;

  // Hint specifically for blockhash mismatch (Phantom on wrong network).
  if (/blockhash|expired|0x1771|signature verification/i.test(message)) {
    return `${message}\n\nHint: this often means Phantom is on a different network than the app (the app is on ${detectNetwork()}).`;
  }

  // Last-resort hint for the opaque "transactionPlanResult" message.
  if (/transactionPlanResult/i.test(message)) {
    const causeMsg =
      err instanceof Error && err.cause instanceof Error
        ? err.cause.message
        : pickString(err as AnyRecord, "message");
    if (causeMsg) return `${message} — ${causeMsg}`;
    return `${message}\n\nOpen the browser console for the full transactionPlanResult — usually wrong network in the wallet or insufficient SOL.`;
  }

  return message;
}
