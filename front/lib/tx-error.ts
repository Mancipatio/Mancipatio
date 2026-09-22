import {
  ASSET_REGISTRY_ERROR__DEPOSITOR_NOT_BENEFICIARY,
  ASSET_REGISTRY_ERROR__INVALID_DEPOSIT_AMOUNT,
  ASSET_REGISTRY_ERROR__KYC_PROOF_REQUIRED,
  ASSET_REGISTRY_ERROR__MINT_DESTINATION_NOT_BOUND,
  ASSET_REGISTRY_ERROR__RECEIVER_JURISDICTION_BLOCKED,
  ASSET_REGISTRY_ERROR__RECEIVER_KYC_EXPIRED,
  ASSET_REGISTRY_ERROR__RECEIVER_NOT_APPROVED,
  ASSET_REGISTRY_ERROR__VAULT_NOT_ACCEPTING_DEPOSITS,
} from "@/lib/generated/asset_registry";
import { detectNetwork } from "@/lib/network";

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
    ] as const
  ).map(([code, hint]) => [`0x${code.toString(16)}`, hint]),
);

function customErrorHint(text: string): string | null {
  const match = /custom program error:\s*(0x[0-9a-f]+)/i.exec(text);
  if (!match) return null;
  return CUSTOM_ERROR_HINTS[match[1].toLowerCase()] ?? null;
}

export function explainSendError(err: unknown): string {
  if (err == null) return "Unknown error";

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
