"use client";
import { useRef, useState } from "react";
import type { WalletSession } from "@solana/client";
import { notifyAdminBadges } from "@/lib/admin-badges-events";
import { detectNetwork, explorerTxUrl } from "@/lib/network";
import { signedFetch } from "@/lib/siws-client";
import { recordAudit } from "@/lib/supabase";
import {
  assertChainRecordStorageAvailable,
  discardableChainRecordState,
  listPendingChainRecords,
  RECEIPT_EXPIRY_HORIZON_MS,
  type ChainRecordState,
  type PendingChainRecord,
  type RecordingStage,
} from "@/lib/chain-record-recovery";
import { useChainRecordRecovery } from "@/lib/use-chain-record-recovery";
import { ChainRecordRecoveryPanel } from "@/components/chain-record-recovery-panel";
import { useToast } from "@/lib/toast";

type Product = "delivery" | "conversion";
type Outcome = "returned" | "delivered" | "converted";
export function custodyOutcomeId(
  product: Product,
  id: string,
  status: Outcome,
) {
  if (
    !/^[a-zA-Z0-9-]{1,64}$/.test(id) ||
    (product === "delivery" && status === "converted") ||
    (product === "conversion" && status === "delivered")
  )
    throw new Error("Invalid custody outcome identity");
  return `${product}:${id}:${status}`;
}
export function parseCustodyOutcome(value: string) {
  const [product, id, status, extra] = value.split(":");
  if (
    extra !== undefined ||
    !["delivery", "conversion"].includes(product) ||
    !["returned", "delivered", "converted"].includes(status)
  )
    throw new Error("Invalid custody outcome receipt");
  custodyOutcomeId(product as Product, id, status as Outcome);
  return { product: product as Product, id, status: status as Outcome };
}

export const OUTCOME_FAILED_MESSAGE =
  "The transaction failed on the network, so nothing moved. Its receipt was discarded; the same action can be tried again.";
export const OUTCOME_NOT_FINALIZED_MESSAGE =
  "The transaction is not finalized on the network yet. Nothing more was sent; use Retry recording in a minute.";
const HORIZON_HOURS = Math.round(RECEIPT_EXPIRY_HORIZON_MS / 3_600_000);
/** Why a receipt cannot be recorded (and may be discarded), per dead state. */
export const DEAD_RECEIPT_MESSAGE: Record<"failed" | "did_not_land", string> = {
  failed:
    "The network ran this transaction and it failed; nothing moved. Discard the receipt to try again.",
  did_not_land: `The network does not know this transaction ${HORIZON_HOURS} hours after it was sent; it can no longer land and nothing moved. Discard the receipt to try again.`,
};
const KEPT_MESSAGE: Record<Exclude<ChainRecordState, "failed" | "did_not_land">, string> = {
  landed:
    "This transaction landed on the network. Use Retry recording instead.",
  pending:
    "The network may still finalize this transaction. Check again later.",
  unknown: "The network could not be checked. Try again in a moment.",
};
const STAGE_TEXT: Record<RecordingStage, string> = {
  awaiting_finalization:
    "Waiting for Solana to finalize the transaction (usually 15–30 s)…",
  recording: "Recording — approve the signature request in your wallet.",
  retry_wait: "Not finalized yet — checking again shortly…",
};

/** Only public request identity and signature persist; a retry calls the
 * authenticated evidence API and never constructs an on-chain transaction. */
export function useCustodyOutcomeRecovery(
  product: Product,
  session: WalletSession | null | undefined,
  refresh: () => Promise<void>,
) {
  const network = detectNetwork(),
    wallet = session?.account.address.toString();
  const recovery = useChainRecordRecovery("custody_outcome", network, wallet);
  const lock = useRef(false),
    [busy, setBusy] = useState(false),
    toast = useToast();
  const receipts = recovery.receipts.filter((r) =>
    r.entityId.startsWith(`${product}:`),
  );
  /** The one signed record of a finalized outcome. */
  async function finish(receipt: PendingChainRecord) {
    if (
      !session ||
      receipt.wallet !== wallet ||
      receipt.network !== network ||
      receipt.kind !== "custody_outcome"
    )
      throw new Error(
        "Connect the wallet and network that sent this transaction",
      );
    const parsed = parseCustodyOutcome(receipt.entityId);
    if (parsed.product !== product)
      throw new Error("Receipt belongs to another custody workflow");
    await signedFetch(
      session,
      `/api/${product}/admin-update`,
      `${product}.adminUpdate`,
      { id: parsed.id, status: parsed.status, outcome_tx: receipt.signature },
    );
    recovery.forget(receipt);
    notifyAdminBadges();
    await refresh();
  }
  /**
   * The evidence route verifies at finalized: wait for that (plain RPC
   * reads), then record once; a server whose node lags is retried after a
   * backoff before the panel's "Retry recording" takes over.
   */
  async function settle(receipt: PendingChainRecord) {
    const outcome = await recovery.recordFinalized(receipt, () =>
      finish(receipt),
    );
    if (outcome === "failed") throw new Error(OUTCOME_FAILED_MESSAGE);
    if (outcome === "not_finalized")
      throw new Error(OUTCOME_NOT_FINALIZED_MESSAGE);
  }
  function prepare(id: string, status: Outcome) {
    custodyOutcomeId(product, id, status);
    if (lock.current || !recovery.ready || !wallet)
      throw new Error("Wait for transaction recovery to finish loading");
    const pending = [
      ...receipts,
      ...listPendingChainRecords({ kind: "custody_outcome", network, wallet }),
    ];
    if (pending.some((r) => r.entityId.startsWith(`${product}:${id}:`)))
      throw new Error(
        "This request already has a submitted transaction. Use Retry recording instead of signing again",
      );
    assertChainRecordStorageAvailable();
    // A new attempt: nothing of it has been sent (sent / signature start over).
    recovery.resetAttempt();
    lock.current = true;
    setBusy(true);
  }
  function release() {
    lock.current = false;
    setBusy(false);
  }
  async function record(id: string, status: Outcome, signature: string) {
    const receipt = recovery.remember(
      custodyOutcomeId(product, id, status),
      signature,
    );
    await settle(receipt);
  }
  async function retry(receipt: PendingChainRecord) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    recovery.resetAttempt();
    try {
      const state = await recovery.check(receipt);
      if (state === "failed" || state === "did_not_land") {
        toast.showError(
          "Receipt cannot be recorded",
          DEAD_RECEIPT_MESSAGE[state],
        );
        return;
      }
      // Unreadable here: one signed attempt, the server decides. Otherwise
      // through the wait — "landed" covers confirmed, and a record before
      // finalized would spend a wallet prompt on a 409; already finalized,
      // the wait returns at once.
      if (state === "unknown") await finish(receipt);
      else await settle(receipt);
      // The inline path wrote its own row; a retry gives the "pending" row its final.
      const parsed = parseCustodyOutcome(receipt.entityId);
      if (wallet) {
        void recordAudit({
          ix_name: parsed.status === "returned" ? "return_custody_vault" : "realize_custody",
          category: "custody",
          actor_wallet: wallet,
          reason: "Retry recording a sent custody outcome",
          target_label: `${product} ${parsed.id.slice(0, 8)}`,
          tx_signature: receipt.signature,
          metadata: {
            [`${product}_request_id`]: parsed.id,
            request_id: parsed.id,
            signature: receipt.signature,
            recorded_via: "retry_recording",
          },
        });
      }
      toast.show({ kind: "success", title: "Custody outcome recorded" });
    } catch (error) {
      toast.showError(
        "Transaction sent — recording pending",
        error instanceof Error
          ? error.message
          : "Retry recording this existing receipt",
      );
    } finally {
      release();
    }
  }
  async function discard(receipt: PendingChainRecord) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      const { state, discarded } = await recovery.discard(receipt);
      if (discarded)
        toast.show({ kind: "success", title: "Receipt discarded — nothing moved" });
      else
        toast.showError(
          "Receipt kept",
          discardableChainRecordState(state)
            ? "The saved receipt changed in another tab. Reload and check it again."
            : KEPT_MESSAGE[state],
        );
    } catch (error) {
      toast.showError(
        "Receipt kept",
        error instanceof Error ? error.message : "Try again in a moment.",
      );
    } finally {
      release();
    }
  }
  const dead = receipts.flatMap((receipt) => {
    const state = recovery.states.get(receipt.signature);
    return state === "failed" || state === "did_not_land"
      ? [{ receipt, state }]
      : [];
  });
  // A dead receipt is listed once, with its discard — not among those awaiting recording.
  const awaiting = receipts.filter(
    (receipt) => !dead.some((d) => d.receipt === receipt),
  );
  return {
    prepare,
    release,
    record,
    retry,
    discard,
    busy,
    ready: recovery.ready,
    /** Where the record attempt in flight is (null outside one). */
    stage: recovery.stage,
    /**
     * The signature of the attempt in flight, or of the last one that was
     * not recorded (null before any, and after prepare() starts a new
     * attempt). Rendered state: an async catch block reads latestAttempt().
     */
    signature: recovery.signature,
    /** The current attempt's transaction was sent: its signature is known. */
    sent: recovery.signature !== null,
    /** The attempt as it is NOW — for a catch block — with its signature when something was sent. */
    latestAttempt: recovery.latestAttempt,
    states: recovery.states,
    panel: (
      <>
        {recovery.stage && (
          <p role="status" className="mt-2 text-xs text-slate-600">
            {STAGE_TEXT[recovery.stage]}
          </p>
        )}
        <ChainRecordRecoveryPanel
          receipts={awaiting}
          busy={busy}
          onRetry={retry}
        />
        {dead.length > 0 && (
          <section className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            <h3 className="font-semibold">Receipts that cannot be recorded</h3>
            <div className="mt-2 space-y-3">
              {dead.map(({ receipt, state }) => (
                <div key={`${receipt.entityId}:${receipt.signature}`}>
                  <p className="text-xs leading-relaxed">
                    Request {receipt.entityId.split(":")[1]?.slice(0, 8)}:{" "}
                    {DEAD_RECEIPT_MESSAGE[state]}
                  </p>
                  <a
                    href={explorerTxUrl(receipt.signature, receipt.network)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-1 block break-all font-mono text-xs underline underline-offset-2"
                  >
                    {receipt.signature}
                  </a>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void discard(receipt)}
                    className="mt-2 rounded-lg border border-amber-700 bg-white px-3 py-2 text-xs font-semibold text-amber-900 hover:bg-amber-100 disabled:opacity-50"
                  >
                    Discard receipt
                  </button>

                </div>
              ))}
            </div>
          </section>
        )}
      </>
    ),
  };
}
