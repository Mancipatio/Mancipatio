"use client";

import {
  address,
  fetchEncodedAccount,
  isAddress,
  isSignature,
  type GetAccountInfoApi,
  type GetSignatureStatusesApi,
  type Rpc,
  type Signature,
} from "@solana/kit";
import {
  assertChainRecordStorageAvailable,
  FINALIZATION_POLL_MS,
  FINALIZATION_WAIT_MS,
  waitForFinalizedSignature,
  type FinalizedSignatureOutcome,
  type FinalizedWaitOptions,
} from "@/lib/chain-record-recovery";
import { findCustodyVaultPda } from "@/lib/pdas";
import type { Network } from "@/lib/network";
import { STATUS_READ_TIMEOUT_MS } from "@/lib/simulation-gate";

export type CustodyOpenScope = {
  product: "delivery" | "conversion";
  requestId: string;
  network: Network;
  wallet: string;
};
export type CustodyOpenIntent = CustodyOpenScope & {
  version: 1;
  vaultId: string;
  vaultPda: string;
  signature: string | null;
  createdAt: string;
  recordedAt: string | null;
};
const PREFIX = "mancipatio:custody-open:v1:";

export function parseCustodyVaultId(value: string): bigint {
  if (!/^\d+$/.test(value.trim()))
    throw new Error("Vault ID must be a non-negative integer.");
  const id = BigInt(value.trim());
  if (id > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error(
      "Vault ID must be at most 9007199254740991 so the request can be recorded exactly.",
    );
  return id;
}
export function requireCustodyRequestAmount(
  amount: string,
  requested: number,
): bigint {
  if (
    !Number.isSafeInteger(requested) ||
    requested <= 0 ||
    !/^\d+$/.test(amount.trim()) ||
    BigInt(amount.trim()) !== BigInt(requested)
  )
    throw new Error(
      "Vault amount must exactly match the request's positive, safely represented amount.",
    );
  return BigInt(requested);
}
function key(scope: CustodyOpenScope): string {
  if (
    !["delivery", "conversion"].includes(scope.product) ||
    !["mainnet", "devnet", "testnet", "localnet"].includes(scope.network) ||
    !isAddress(scope.wallet) ||
    !/^[a-zA-Z0-9-]{1,64}$/.test(scope.requestId)
  )
    throw new Error("Invalid custody approval recovery scope.");
  return `${PREFIX}${scope.product}:${scope.network}:${scope.wallet}:${scope.requestId}`;
}
function storage(): Storage {
  if (typeof window === "undefined")
    throw new Error("Browser storage is unavailable.");
  return window.localStorage;
}
function parse(raw: string, scope: CustodyOpenScope): CustodyOpenIntent {
  const v = JSON.parse(raw) as CustodyOpenIntent;
  if (
    v.version !== 1 ||
    key(v) !== key(scope) ||
    !isAddress(v.vaultPda) ||
    typeof v.vaultId !== "string" ||
    String(parseCustodyVaultId(v.vaultId)) !== v.vaultId ||
    (v.signature !== null && !isSignature(v.signature)) ||
    (v.recordedAt !== null &&
      (typeof v.recordedAt !== "string" ||
        !Number.isFinite(Date.parse(v.recordedAt)))) ||
    typeof v.createdAt !== "string" ||
    !Number.isFinite(Date.parse(v.createdAt))
  )
    throw new Error("Invalid custody approval recovery record.");
  return v;
}
export function readCustodyOpenIntent(
  scope: CustodyOpenScope,
): CustodyOpenIntent | null {
  const raw = storage().getItem(key(scope));
  if (raw === null) return null;
  // Corrupt/unreadable intent must never be mistaken for permission to send again.
  try {
    return parse(raw, scope);
  } catch {
    throw new Error(
      "Saved custody approval needs review. Do not open another vault for this request.",
    );
  }
}
function save(intent: CustodyOpenIntent): void {
  // Explicit projection excludes request PII, attestation files and extra caller fields.
  const value: CustodyOpenIntent = {
    version: 1,
    product: intent.product,
    requestId: intent.requestId,
    network: intent.network,
    wallet: intent.wallet,
    vaultId: intent.vaultId,
    vaultPda: intent.vaultPda,
    signature: intent.signature,
    createdAt: intent.createdAt,
    recordedAt: intent.recordedAt,
  };
  const encoded = JSON.stringify(value);
  storage().setItem(key(value), encoded);
  if (storage().getItem(key(value)) !== encoded)
    throw new Error(
      "Custody approval could not be saved. Keep the vault address and signature; do not open another vault.",
    );
}
/**
 * Removes the saved approval `intent` — and only it: the stored record must
 * still carry the same vault, creation time and signature (a record a newer
 * attempt or another tab wrote, or one that cannot be read, is left alone).
 * The callers decide WHEN that is safe: openCustodyOnce for a send that
 * provably never reached the network, the hook's discard once
 * checkCustodyOpenIntent says the vault was never opened.
 */
export function forgetCustodyOpenIntent(intent: CustodyOpenIntent): boolean {
  const k = key(intent);
  const store = storage();
  const raw = store.getItem(k);
  if (raw === null) return false;
  let current: CustodyOpenIntent;
  try {
    current = parse(raw, intent);
  } catch {
    return false;
  }
  if (
    current.createdAt !== intent.createdAt ||
    current.vaultPda !== intent.vaultPda ||
    current.signature !== intent.signature
  )
    return false;
  store.removeItem(k);
  return true;
}
/** Runs `run` under the approval's cross-tab lock (Web Locks, where available): one open, record or discard of a request at a time. */
export function withCustodyOpenLock<T>(
  scope: CustodyOpenScope,
  run: () => Promise<T>,
): Promise<T> {
  if (typeof navigator !== "undefined" && navigator.locks) {
    const locks = navigator.locks;
    // The lock is held until `run` settles (the callback's promise is what
    // the manager awaits); the lib types that result unawaited, hence the
    // explicit relay.
    return new Promise<T>((resolve, reject) => {
      locks
        .request(key(scope), () => run().then(resolve, reject))
        .catch(reject);
    });
  }
  return run();
}
export async function requireCanonicalCustodyIntent(
  intent: CustodyOpenIntent,
  shareClass: string,
): Promise<void> {
  const expected = await findCustodyVaultPda(
    address(shareClass),
    parseCustodyVaultId(intent.vaultId),
  );
  if (String(expected) !== intent.vaultPda)
    throw new Error(
      "Saved vault ID and address do not match this request's share class.",
    );
}
export async function recordCustodyOpening(
  intent: CustodyOpenIntent,
  scope: CustodyOpenScope,
  link: (intent: CustodyOpenIntent) => Promise<void>,
): Promise<void> {
  if (key(intent) !== key(scope))
    throw new Error("Connect the wallet and network that opened this vault.");
  await link(intent); // Authenticated API verifies the finalized vault against the request.
  const current = readCustodyOpenIntent(scope);
  if (
    current?.vaultPda === intent.vaultPda &&
    current.createdAt === intent.createdAt
  )
    save({
      ...current,
      recordedAt: current.recordedAt ?? new Date().toISOString(),
    });
}

// ── Did the send reach the network? ─────────────────────────────────────────

/**
 * The refusal of the pre-send wallet-policy check
 * (lib/transaction-wallet-policy.ts requestTransactionWalletPolicy): a
 * message signature the user declined, or an answer the server did not
 * give. It runs before the transaction is offered to the wallet
 * (lib/verified-solana-client.ts prepareAndSend), so a send that failed
 * with it never reached the network. Matched by its opening words, since
 * that module re-throws a plain Error (tests/custody-open-recovery.test.ts
 * pins the wording there).
 */
export const WALLET_POLICY_REFUSAL_PREFIX =
  "We could not verify your primary transaction wallet";

/**
 * The typed refusals raised before the wallet opened, by name (each class
 * sets it; lib/tx-error.ts matches the gates the same way): the emergency
 * pause, the pilot scope and KYC-only mode (lib/pause-gate.ts), the
 * simulation gate (lib/simulation-gate.ts), a set freeze / blocklist gate
 * account (lib/proceeds-gate.ts), maintenance (lib/maintenance.ts) and the
 * wallet policy (lib/transaction-wallet-policy.ts).
 */
export const NEVER_BROADCAST_ERROR_NAMES: ReadonlySet<string> = new Set([
  "PausedFlowError",
  "ModuleDisabledFlowError",
  "KycOnlyFlowError",
  "SimulationRefusedError",
  "SimulationUnavailableError",
  "GateAccountSetError",
  "MaintenanceModeError",
  "MaintenanceUnknownError",
  "PrimaryWalletRequiredError",
]);

/** The words wallets use when the user said no to a transaction (with the standard code 4001). */
const WALLET_REJECTION_RE =
  /user rejected|user declined|rejected the request|request rejected|signature request denied|cancell?ed by user/i;

/** A wallet's "the user said no": nothing was signed, so nothing was sent. */
export function isWalletRejection(error: unknown): boolean {
  if (typeof error === "string") return WALLET_REJECTION_RE.test(error);
  if (!error || typeof error !== "object") return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (code === 4001 || code === "WALLET_REJECTED" || code === "ACTION_REJECTED")
    return true;
  return typeof message === "string" && WALLET_REJECTION_RE.test(message);
}

/**
 * Whether a send that threw `error` provably never reached the network: a
 * typed refusal raised before the wallet opened (NEVER_BROADCAST_ERROR_NAMES,
 * the wallet policy's refusal) or the wallet's own rejection, found anywhere
 * in the cause chain. Anything else — a transport failure after the wallet
 * signed, a changed wallet, an unknown error — may have been broadcast, and
 * the saved intent must stay (fail closed).
 */
export function custodySendNeverBroadcast(error: unknown): boolean {
  let cursor: unknown = error;
  for (
    let depth = 0;
    depth < 6 && cursor !== null && cursor !== undefined;
    depth++
  ) {
    if (cursor instanceof Error) {
      if (NEVER_BROADCAST_ERROR_NAMES.has(cursor.name)) return true;
      if (cursor.message.startsWith(WALLET_POLICY_REFUSAL_PREFIX)) return true;
    }
    if (isWalletRejection(cursor)) return true;
    cursor =
      typeof cursor === "object"
        ? (cursor as { cause?: unknown }).cause
        : undefined;
  }
  return false;
}

// ── What became of a saved approval ─────────────────────────────────────────

/**
 * How long after an approval's last attempt a vault still absent at
 * finalized — with no successful transaction for it — counts as never
 * opened: a transaction lives ~60-90 s after its blockhash was fetched
 * (just before the wallet prompt), so by then it can no longer land. Five
 * minutes leaves room for a lagging node.
 */
export const CUSTODY_OPEN_ABANDON_AFTER_MS = 5 * 60_000;

export type CustodyOpenChainState =
  /** The vault (or its tombstone) is on the network: record it, never discard it. */
  | "vault_present"
  /** No vault yet, and the transaction may still land (or ran well and is not finalized). */
  | "pending"
  /** No vault, and the transaction failed or can no longer land: nothing was opened. */
  | "never_opened"
  /** The network could not be asked (fail closed: nothing is discarded). */
  | "unknown";

export type CustodyOpenCheckRpc = Rpc<GetAccountInfoApi & GetSignatureStatusesApi>;

/**
 * Asks the network what became of a saved approval: the vault at finalized
 * first (a tombstone counts: the PDA is taken for good), then, with a
 * signature, its status with the history searched. A transaction that ran
 * and failed, or none at all CUSTODY_OPEN_ABANDON_AFTER_MS after the later
 * of the intent's creation and `lastAttemptAt` (the moment this tab's send
 * gave up: the wallet had returned by then, so the blockhash was older),
 * means the vault was never opened. A read that fails answers "unknown".
 */
export async function checkCustodyOpenIntent(
  rpc: CustodyOpenCheckRpc,
  intent: Pick<CustodyOpenIntent, "vaultPda" | "signature" | "createdAt">,
  options: {
    now?: number;
    lastAttemptAt?: number | null;
    minAgeMs?: number;
  } = {},
): Promise<CustodyOpenChainState> {
  const now = options.now ?? Date.now();
  const since = Math.max(
    Date.parse(intent.createdAt),
    options.lastAttemptAt ?? 0,
  );
  const aged =
    Number.isFinite(since) &&
    now - since >= (options.minAgeMs ?? CUSTODY_OPEN_ABANDON_AFTER_MS);
  try {
    const account = await fetchEncodedAccount(rpc, address(intent.vaultPda), {
      commitment: "finalized",
      abortSignal: AbortSignal.timeout(STATUS_READ_TIMEOUT_MS),
    });
    if (account.exists) return "vault_present";
    if (intent.signature) {
      const { value } = await rpc
        .getSignatureStatuses([intent.signature as Signature], {
          searchTransactionHistory: true,
        })
        .send({ abortSignal: AbortSignal.timeout(STATUS_READ_TIMEOUT_MS) });
      const status = value[0];
      if (status) {
        const settled =
          status.confirmationStatus === "confirmed" ||
          status.confirmationStatus === "finalized";
        // Ran and failed: no vault came of it. Ran well: the vault is on its way to finalized.
        return status.err && settled ? "never_opened" : "pending";
      }
    }
    return aged ? "never_opened" : "pending";
  } catch {
    return "unknown";
  }
}

/**
 * Waits for the approval's transaction to finalize (the link route verifies
 * the vault at finalized): by its signature when the send returned one (a
 * transaction that failed is reported), else by the vault account appearing
 * at finalized (a sender that failed without a signature). "unknown" when
 * no read succeeded.
 */
export async function awaitCustodyOpenFinalized(
  rpc: CustodyOpenCheckRpc,
  intent: Pick<CustodyOpenIntent, "vaultPda" | "signature">,
  options: Pick<FinalizedWaitOptions, "timeoutMs" | "pollMs"> = {},
): Promise<FinalizedSignatureOutcome> {
  if (intent.signature)
    return waitForFinalizedSignature(rpc, intent.signature, options);
  const timeoutMs = options.timeoutMs ?? FINALIZATION_WAIT_MS;
  const pollMs = options.pollMs ?? FINALIZATION_POLL_MS;
  const deadline = Date.now() + timeoutMs;
  let read = false;
  for (;;) {
    try {
      const account = await fetchEncodedAccount(
        rpc,
        address(intent.vaultPda),
        {
          commitment: "finalized",
          abortSignal: AbortSignal.timeout(STATUS_READ_TIMEOUT_MS),
        },
      );
      read = true;
      if (account.exists) return "finalized";
    } catch {
      // A failed read counts as "not yet".
    }
    if (Date.now() + pollMs > deadline) return read ? "timeout" : "unknown";
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

// ── The open itself ─────────────────────────────────────────────────────────

/**
 * An existing intent always takes the API-only branch, even when the
 * sender failed before returning a signature: a send that MAY have reached
 * the network keeps its intent (no automatic clear or re-open). Only a send
 * that provably never reached it (`notSent`: a typed pre-wallet refusal,
 * the wallet's rejection) forgets the intent it had just saved, and a
 * `preflight` refusal saves none at all.
 */
export async function openCustodyOnce<T>(input: {
  scope: CustodyOpenScope;
  shareClass: string;
  vaultId: string;
  assertUnoccupied: (vaultPda: string) => Promise<void>;
  build: () => Promise<T>;
  /**
   * Runs on the built transaction before anything is saved: the gates a
   * send would refuse before the wallet (scope, pause, maintenance, the
   * simulation). A refusal here leaves no intent behind and sends nothing.
   */
  preflight?: (prepared: T) => Promise<void>;
  send: (prepared: T) => Promise<string>;
  link: (intent: CustodyOpenIntent) => Promise<void>;
  /**
   * Whether a send that threw `error` provably never reached the network
   * (custodySendNeverBroadcast). The unsent intent is then forgotten — if
   * storage still holds exactly it — and `onIntent(null)` says so.
   */
  notSent?: (error: unknown) => boolean;
  onIntent: (intent: CustodyOpenIntent | null) => void;
}): Promise<CustodyOpenIntent> {
  const run = async () => {
    const existing = readCustodyOpenIntent(input.scope);
    if (existing) {
      input.onIntent(existing);
      await requireCanonicalCustodyIntent(existing, input.shareClass);
      await recordCustodyOpening(existing, input.scope, input.link);
      return existing;
    }
    assertChainRecordStorageAvailable();
    const id = parseCustodyVaultId(input.vaultId);
    const vaultPda = await findCustodyVaultPda(address(input.shareClass), id);
    await input.assertUnoccupied(String(vaultPda));
    const prepared = await input.build(); // No transaction is sent by the builder.
    await input.preflight?.(prepared); // Refused here: nothing saved, nothing sent.
    if (readCustodyOpenIntent(input.scope))
      throw new Error(
        "Another approval is pending. Retry recording the saved vault.",
      );
    let intent: CustodyOpenIntent = {
      ...input.scope,
      version: 1,
      vaultId: String(id),
      vaultPda: String(vaultPda),
      signature: null,
      createdAt: new Date().toISOString(),
      recordedAt: null,
    };
    save(intent); // Durable public intent BEFORE the wallet can broadcast anything.
    input.onIntent(intent);
    let signature: string;
    try {
      signature = await input.send(prepared);
    } catch (error) {
      // Never broadcast: the intent would only block this request. Anything
      // uncertain keeps it (the record above matches only this attempt).
      if (input.notSent?.(error) && forgetCustodyOpenIntent(intent))
        input.onIntent(null);
      throw error;
    }
    if (!isSignature(signature))
      throw new Error(
        "Sender returned an invalid signature. Check the saved vault before continuing.",
      );
    intent = { ...intent, signature };
    input.onIntent(intent); // Keep visible even if persistence fails after send.
    save(intent);
    await recordCustodyOpening(intent, input.scope, input.link);
    return intent;
  };
  // Serialize approvals for the same request across tabs where Web Locks is available.
  return withCustodyOpenLock(input.scope, run);
}
