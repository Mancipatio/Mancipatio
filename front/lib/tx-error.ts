import { isSolanaError } from "@solana/kit";
import { features } from "@/lib/features";
import { detectNetwork } from "@/lib/network";
import { MaintenanceModeError } from "@/lib/maintenance";
import { ModuleDisabledFlowError, PausedFlowError } from "@/lib/pause-gate";
import { takeWalletChange } from "@/lib/wallet-changes";
import {
  BLOCKLIST_RECOVERY_INVALID_HINT,
  BLOCKLIST_RECOVERY_PENDING_HINT,
  KYC_REGISTRY_NOT_ALLOWED_HINT,
  PROPOSAL_EXPIRED_HINT,
  REGISTRY_ERROR_HINTS,
  TIMELOCK_ACTIVE_HINT,
  TRANSACTION_ERROR_NAMES,
  customErrorName,
  knownProgram,
  programErrorHint,
  transactionErrorText,
} from "@/lib/program-errors";

// The hint wording lives in lib/program-errors (shared with the simulation
// gate); re-exported for the existing importers.
export {
  BLOCKLIST_RECOVERY_INVALID_HINT,
  BLOCKLIST_RECOVERY_PENDING_HINT,
  ISSUER_PROCEEDS_FROZEN_HINT,
  KYC_REGISTRY_NOT_ALLOWED_HINT,
  PARTY_BLOCKLISTED_HINT,
  PLATFORM_RECOVERY_PENDING_HINT,
  PROPOSAL_EXPIRED_HINT,
  TIMELOCK_ACTIVE_HINT,
} from "@/lib/program-errors";

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

// asset_registry custom errors by hex (lib/program-errors REGISTRY_ERROR_HINTS):
// the lookup for a log whose failing program is not named. Every code there is
// above the hook's last (6020), so the hex cannot collide across our programs.
const CUSTOM_ERROR_HINTS: Record<string, string> = Object.fromEntries(
  [...REGISTRY_ERROR_HINTS].map(([code, hint]) => [`0x${code.toString(16)}`, hint]),
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
/**
 * Unauthorized on `sale`: close_sale / open_payout_vault by a key that is not
 * the sale's authority snapshot, but also buy / close / open-vault with an
 * account that does not belong to the sale (has_one mint / proceeds /
 * share_class), so the wording stays neutral.
 */
export const SALE_AUTHORITY_HINT =
  "The sale refused this transaction: this wallet is not the sale's recorded authority, or an account passed does not belong to this sale (Unauthorized).";
/** Added to SALE_AUTHORITY_HINT only while issuer rotation (and its sync UI) is on. */
export const SALE_SYNC_SUFFIX = " If the issuer key was rotated, sync the sale first.";
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
  if (/caused by account: sale\. Error Code: Unauthorized\b/.test(text))
    return SALE_AUTHORITY_HINT + (features().issuerRotation ? SALE_SYNC_SUFFIX : "");
  if (/Error Code: KycRegistryNotAllowed\b/.test(text)) return KYC_REGISTRY_NOT_ALLOWED_HINT;
  // transfer_hook 6017–6020 share their numbers with registry codes
  // (VaultNotExpired..SaleWindowClosed), so they match by Anchor's name.
  // ProposalExpired / TimelockActive exist in both programs with the same
  // meaning; the registry's recovery-pending error has its own name.
  if (/Error Code: ProposalExpired\b/.test(text)) return PROPOSAL_EXPIRED_HINT;
  if (/Error Code: TimelockActive\b/.test(text)) return TIMELOCK_ACTIVE_HINT;
  if (/Error Code: InvalidRecovery\b/.test(text)) return BLOCKLIST_RECOVERY_INVALID_HINT;
  if (/Error Code: RecoveryPending\b/.test(text)) return BLOCKLIST_RECOVERY_PENDING_HINT;
  if (/Error Code: InvalidKycRegistry\b/.test(text)) return INVALID_KYC_REGISTRY_HINT;
  // open_sale without a usable approval: Anchor names the account; the bare
  // codes (3012 / 2006) are shared by every account of every instruction.
  if (/caused by account: sale_approval\. Error Code: AccountNotInitialized\b/.test(text)) return NO_SALE_APPROVAL_HINT;
  if (/caused by account: sale_approval\. Error Code: ConstraintSeeds\b/.test(text)) return SALE_APPROVAL_OTHER_ID_HINT;
  if (/caused by account: approver_admin_record\. Error Code: AccountNotInitialized\b/.test(text)) return APPROVER_NOT_ADMIN_HINT;
  // The innermost failing program's own table (a hook refusal inside a
  // Token-2022 transfer is the hook's), when that program is one we know.
  const failed = /Program (\S+) failed: custom program error:\s*(0x[0-9a-f]+)/i.exec(text);
  const failedProgram = failed ? knownProgram(failed[1]) : null;
  if (failed && failedProgram && failedProgram !== "asset_registry") {
    const code = parseInt(failed[2], 16);
    const hint = programErrorHint({ program: failedProgram, code });
    if (!hint) return null;
    const name = customErrorName(failedProgram, code);
    if (name && !hint.includes(`(${name})`)) return `${hint.replace(/\.$/, "")} (${name}).`;
    return /[.!?]$/.test(hint) ? hint : `${hint}.`;
  }
  const match = /custom program error:\s*(0x[0-9a-f]+)/i.exec(text);
  if (!match) return null;
  return CUSTOM_ERROR_HINTS[match[1].toLowerCase()] ?? null;
}

// Transaction errors (kit 7050xxx) are the network refusing a transaction
// before any instruction runs: no program logs, and in a production build the
// message is only "Solana error #7050008". The preflight failure (-32002)
// carries the one that applies as its `cause`.
const TRANSACTION_ERROR_FIRST = 7_050_000;
const TRANSACTION_ERROR_LAST = 7_050_999;
function networkRefusalText(code: number, network: string, errorName: unknown): string {
  const known = TRANSACTION_ERROR_NAMES[code - TRANSACTION_ERROR_FIRST];
  const text = known ? transactionErrorText(known, network) : null;
  if (text) return text;
  const name = (typeof errorName === "string" && errorName) || known;
  return `The network refused the transaction before running it (${name ?? `transaction error #${code}`}).`;
}

/**
 * The network's pre-execution refusal anywhere in the cause chain, worded for
 * the user, with what the wallet changed while signing it when that is known
 * (lib/wallet-changes; the note is consumed here). Null when the failure is
 * anything else.
 */
export function explainNetworkRefusal(err: unknown): string | null {
  const queue: unknown[] = [err];
  const seen = new Set<unknown>();
  while (queue.length > 0 && seen.size < 200) {
    const cursor = queue.shift();
    if (cursor == null || typeof cursor !== "object" || seen.has(cursor)) continue;
    seen.add(cursor);
    if (isSolanaError(cursor)) {
      const code = cursor.context.__code;
      if (code >= TRANSACTION_ERROR_FIRST && code <= TRANSACTION_ERROR_LAST) {
        const errorName = (cursor.context as { errorName?: unknown }).errorName;
        const text = networkRefusalText(code, detectNetwork(), errorName);
        const change = takeWalletChange();
        return change ? `${text} Note: ${change}.` : text;
      }
    }
    const obj = cursor as AnyRecord;
    for (const key of ["cause", "error", "context", "transactionPlanResult", "plans"]) {
      const next = obj[key];
      if (Array.isArray(next)) queue.push(...next);
      else if (next && typeof next === "object") queue.push(next);
    }
  }
  return null;
}

export function explainSendError(err: unknown): string {
  if (err == null) return "Unknown error";

  // Maintenance refusals are already worded for users; SDK hooks may wrap them.
  for (let cursor: unknown = err, depth = 0; cursor instanceof Error && depth < 6; cursor = cursor.cause, depth++) {
    if (cursor instanceof MaintenanceModeError) return cursor.message;
    // The emergency pause and the pilot scope, read before the wallet opened (lib/pause-gate.ts).
    if (cursor instanceof PausedFlowError || cursor instanceof ModuleDisabledFlowError) return cursor.message;
    // A set freeze / blocklist gate account, read before the wallet opened
    // (lib/proceeds-gate.ts; matched by name: that module imports this one).
    if (cursor.name === "GateAccountSetError") return cursor.message;
    // The simulation gate refused before the wallet opened, already explained
    // (lib/simulation-gate.ts; matched by name like the gate account error).
    if (cursor.name === "SimulationRefusedError" || cursor.name === "SimulationUnavailableError") return cursor.message;
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
  const refusal = explainNetworkRefusal(err);
  if (refusal) return refusal;
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
