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
  /**
   * When the send of this approval settled (it returned a signature, or
   * failed in a way that may have reached the network): the wallet had
   * returned by then, so the transaction's blockhash is older than this
   * moment — the bound checkCustodyOpenIntent ages the discard from, in
   * every tab and after a reload. Null while no send has settled (a record
   * written before the field existed, or a tab closed mid-send).
   */
  attemptedAt: string | null;
  recordedAt: string | null;
};
/** The record as stored: `attemptedAt` was added later and may be missing. */
type StoredCustodyOpenIntent = Omit<CustodyOpenIntent, "attemptedAt"> & {
  attemptedAt?: string | null;
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
function isNullableDate(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === "string" && Number.isFinite(Date.parse(value)))
  );
}
function parse(raw: string, scope: CustodyOpenScope): CustodyOpenIntent {
  const v = JSON.parse(raw) as StoredCustodyOpenIntent;
  if (
    v.version !== 1 ||
    key(v) !== key(scope) ||
    !isAddress(v.vaultPda) ||
    typeof v.vaultId !== "string" ||
    String(parseCustodyVaultId(v.vaultId)) !== v.vaultId ||
    (v.signature !== null && !isSignature(v.signature)) ||
    !isNullableDate(v.recordedAt) ||
    (v.attemptedAt !== undefined && !isNullableDate(v.attemptedAt)) ||
    typeof v.createdAt !== "string" ||
    !Number.isFinite(Date.parse(v.createdAt))
  )
    throw new Error("Invalid custody approval recovery record.");
  return { ...v, attemptedAt: v.attemptedAt ?? null };
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
    attemptedAt: intent.attemptedAt,
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
/**
 * Stamps the saved approval `intent` with the moment its send settled
 * (`attemptedAt`, see CustodyOpenIntent) — only while storage still holds
 * exactly this attempt, as forgetCustodyOpenIntent — and returns what was
 * saved, or null when nothing was: a record a newer attempt or another tab
 * wrote, or storage that cannot be written (the send's own error is what
 * the caller reports; this never throws).
 */
export function markCustodyOpenAttempted(
  intent: CustodyOpenIntent,
  at: Date = new Date(),
): CustodyOpenIntent | null {
  try {
    const current = readCustodyOpenIntent(intent);
    if (
      !current ||
      current.createdAt !== intent.createdAt ||
      current.vaultPda !== intent.vaultPda ||
      current.signature !== intent.signature
    )
      return null;
    const marked: CustodyOpenIntent = {
      ...current,
      attemptedAt: at.toISOString(),
    };
    save(marked);
    return marked;
  } catch {
    return null;
  }
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
 * with it never reached the network. The module throws a typed
 * TransactionWalletPolicyError (matched by name below); the opening words
 * stay matched for an older plain Error (tests/custody-open-recovery.test.ts
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
 * wallet policy (lib/transaction-wallet-policy.ts) — whose message-signing
 * prompt, before the transaction is offered, is also where a hardware
 * wallet's signing failure (lib/siws-signing.ts) and the off-chain message
 * limit (lib/siws-offchain.ts) are raised.
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
  "TransactionWalletPolicyError",
  "HardwareWalletSigningError",
  "OffchainMessageLimitError",
]);

/**
 * The words wallets use when the user said no — with the user as the
 * subject, so a node's or a transport's "rejected" never matches — and the
 * Ledger's refusal code (0x6985: denied on the device, before signing). The
 * standard codes (4001, and the wallets' named ones) are read first.
 */
const WALLET_REJECTION_RE =
  /\buser (rejected|declined|denied|cancell?ed)\b|\b(rejected|declined|denied|cancell?ed) by (the )?user\b|signature request denied|0x6985/i;

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
 * How long after an approval's send settled a vault still absent — at
 * finalized and at confirmed — with no successful transaction for it counts
 * as never opened: a transaction lives ~60-90 s after its blockhash was
 * fetched, and the blockhash is fetched inside the send, just before the
 * wallet prompt, so by then it can no longer land. Five minutes leaves room
 * for a lagging node.
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
 * first (a tombstone counts: the PDA is taken for good), then at confirmed
 * (on its way: pending), then, with a signature, its status with the
 * history searched. A transaction that ran and failed at finalized, or none
 * at all CUSTODY_OPEN_ABANDON_AFTER_MS after the LATEST of the intent's
 * creation, its `attemptedAt` (when its send settled — the wallet had
 * returned, so the blockhash was older; saved by openCustodyOnce, so every
 * tab and a reloaded one age from it) and `options.since` (the hook's own
 * bound: when this tab's send gave up, or when it first saw this exact
 * record — so a record without attemptedAt is watched for a full window
 * here), means the vault was never opened. A read that fails answers
 * "unknown".
 */
export async function checkCustodyOpenIntent(
  rpc: CustodyOpenCheckRpc,
  intent: Pick<CustodyOpenIntent, "vaultPda" | "signature" | "createdAt"> & {
    attemptedAt?: string | null;
  },
  options: {
    now?: number;
    since?: number | null;
    minAgeMs?: number;
  } = {},
): Promise<CustodyOpenChainState> {
  const now = options.now ?? Date.now();
  const since = Math.max(
    Date.parse(intent.createdAt),
    intent.attemptedAt ? Date.parse(intent.attemptedAt) : 0,
    options.since ?? 0,
  );
  const aged =
    Number.isFinite(since) &&
    now - since >= (options.minAgeMs ?? CUSTODY_OPEN_ABANDON_AFTER_MS);
  try {
    const read = (commitment: "finalized" | "confirmed") =>
      fetchEncodedAccount(rpc, address(intent.vaultPda), {
        commitment,
        abortSignal: AbortSignal.timeout(STATUS_READ_TIMEOUT_MS),
      });
    if ((await read("finalized")).exists) return "vault_present";
    // Seen at confirmed: finalized follows in seconds. Never discardable.
    if ((await read("confirmed")).exists) return "pending";
    if (intent.signature) {
      const { value } = await rpc
        .getSignatureStatuses([intent.signature as Signature], {
          searchTransactionHistory: true,
        })
        .send({ abortSignal: AbortSignal.timeout(STATUS_READ_TIMEOUT_MS) });
      const status = value[0];
      if (status) {
        // Ran and failed, for good: no vault came of it. Anything else the
        // network knows is on its way (an error at confirmed waits for finalized).
        return status.err && status.confirmationStatus === "finalized"
          ? "never_opened"
          : "pending";
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
 * the network keeps its intent (no automatic clear or re-open), stamped
 * with the moment it settled (`attemptedAt`: the bound the discard ages
 * from). Only a send that provably never reached it (`notSent`: a typed
 * pre-wallet refusal, the wallet's rejection) forgets the intent it had
 * just saved, and a `preflight` refusal saves none at all.
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
      attemptedAt: null,
      recordedAt: null,
    };
    save(intent); // Durable public intent BEFORE the wallet can broadcast anything.
    input.onIntent(intent);
    let signature: string;
    try {
      signature = await input.send(prepared);
    } catch (error) {
      if (input.notSent?.(error)) {
        // Never broadcast: the intent would only block this request (the
        // record above matches only this attempt).
        if (forgetCustodyOpenIntent(intent)) input.onIntent(null);
      } else {
        // Uncertain: kept, stamped with this moment — the wallet had returned
        // (or never answered) by now, so a blockhash of this attempt is older
        // than it: the bound every tab ages the discard from.
        const marked = markCustodyOpenAttempted(intent);
        if (marked) input.onIntent(marked);
      }
      throw error;
    }
    if (!isSignature(signature)) {
      const marked = markCustodyOpenAttempted(intent);
      if (marked) input.onIntent(marked);
      throw new Error(
        "Sender returned an invalid signature. Check the saved vault before continuing.",
      );
    }
    intent = { ...intent, signature, attemptedAt: new Date().toISOString() };
    input.onIntent(intent); // Keep visible even if persistence fails after send.
    save(intent);

    await recordCustodyOpening(intent, input.scope, input.link);
    return intent;
  };
  // Serialize approvals for the same request across tabs where Web Locks is available.
  return withCustodyOpenLock(input.scope, run);
}
