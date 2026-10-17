"use client";

import { useEffect, useRef, useState } from "react";
import { useSolanaClient } from "@solana/react-hooks";
import { address, fetchEncodedAccount, type Instruction } from "@solana/kit";
import type { WalletSession } from "@solana/client";
import { notifyAdminBadges } from "@/lib/admin-badges-events";
import {
  recordOnceFinalized,
  type RecordingStage,
} from "@/lib/chain-record-recovery";
import { assertSiteWritable } from "@/lib/maintenance";
import {
  detectNetwork,
  explorerAddressUrl,
  explorerTxUrl,
} from "@/lib/network";
import {
  assertInstructionsInScope,
  assertInstructionsNotPaused,
} from "@/lib/pause-gate";
import { signedFetch } from "@/lib/siws-client";
import {
  simulateInstructions,
  SimulationUnavailableError,
} from "@/lib/simulation-gate";
import { useToast } from "@/lib/toast";
import {
  awaitCustodyOpenFinalized,
  checkCustodyOpenIntent,
  custodySendNeverBroadcast,
  forgetCustodyOpenIntent,
  openCustodyOnce,
  readCustodyOpenIntent,
  recordCustodyOpening,
  requireCanonicalCustodyIntent,
  withCustodyOpenLock,
  type CustodyOpenChainState,
  type CustodyOpenIntent,
  type CustodyOpenScope,
} from "@/lib/custody-open-recovery";

/** While a saved approval waits for the network, the panel checks the vault again this often. */
const RECHECK_MS = 60_000;

export const OPEN_FAILED_MESSAGE =
  "The vault transaction failed on the network, so no vault was opened. Discard this approval below, then open the vault again.";
export const OPEN_NOT_FINALIZED_MESSAGE =
  "The vault is not finalized on the network yet. Nothing more was sent; use Retry recording existing vault in a minute.";
const STAGE_TEXT: Record<RecordingStage, string> = {
  awaiting_finalization:
    "Waiting for Solana to finalize the vault (usually 15–30 s)…",
  recording: "Recording the vault — approve the signature request in your wallet.",
  retry_wait: "Not finalized yet — checking again shortly…",
};
const KEPT_MESSAGE: Record<Exclude<CustodyOpenChainState, "never_opened">, string> =
  {
    vault_present:
      "The vault exists on the network. Use Retry recording existing vault instead.",
    pending:
      "The network may still be processing this approval. Check again in a few minutes.",
    unknown: "The network could not be checked. Try again in a moment.",
  };

/** What a page's builder hands to the wallet: one instruction, or several. */
type Prepared = Instruction | readonly Instruction[];

/**
 * The ids among `requestIds` for which this browser holds a saved approval
 * of `product` by `wallet` on this network (a vault open that was sent, and
 * may not be recorded yet), or a saved approval it cannot read (that one
 * needs review). A page whose module is switched off uses it to keep
 * "Finish recording" reachable: recording an existing open sends no
 * transaction, so it is not an entry. Read after mount, so the server
 * render and the first client render agree.
 */
export function useSavedCustodyOpens(
  product: CustodyOpenScope["product"],
  requestIds: readonly string[],
  wallet: string | undefined,
): ReadonlySet<string> {
  const network = detectNetwork();
  const ids = requestIds.join(",");
  const [saved, setSaved] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    const reload = () => {
      const next = new Set<string>();
      if (wallet)
        for (const requestId of ids ? ids.split(",") : []) {
          try {
            if (readCustodyOpenIntent({ product, requestId, network, wallet }))
              next.add(requestId);
          } catch {
            // Unreadable: the modal shows why and that no new vault may be opened.
            next.add(requestId);
          }
        }
      setSaved(next);
    };
    reload();
    window.addEventListener("storage", reload);
    return () => window.removeEventListener("storage", reload);
  }, [product, ids, network, wallet]);
  return saved;
}

export function useCustodyOpenRecovery(
  product: CustodyOpenScope["product"],
  request: { id: string; network: string; share_class_pda: string },
  session: WalletSession | null | undefined,
  onSuccess: () => void,
) {
  const client = useSolanaClient();
  const rpc = client.runtime.rpc;
  const network = detectNetwork(),
    wallet = session?.account.address.toString();
  const scope = wallet
    ? { product, requestId: request.id, network, wallet }
    : null;
  const scopeId = `${product}:${request.id}:${network}:${wallet}`;
  const [loaded, setLoaded] = useState<string | null>(null);
  const [pending, setPending] = useState<CustodyOpenIntent | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<RecordingStage | null>(null);
  // What the network says about the visible approval (checkCustodyOpenIntent), keyed to it.
  const [chain, setChain] = useState<{
    key: string;
    state: CustodyOpenChainState;
  } | null>(null);
  const [checkTick, setCheckTick] = useState(0);
  const lock = useRef(false),
    latest = useRef<CustodyOpenIntent | null>(null),
    // When this tab's last send gave up: the wallet had returned by then.
    lastAttemptAt = useRef<number | null>(null);
  const toast = useToast();
  useEffect(() => {
    const reload = () => {
      try {
        const intent = wallet
          ? readCustodyOpenIntent({
              product,
              requestId: request.id,
              network,
              wallet,
            })
          : null;
        latest.current = intent;
        setPending(intent);
        setStorageError(null);
      } catch (error) {
        setStorageError(
          error instanceof Error
            ? error.message
            : "Approval recovery is unavailable.",
        );
      }
      setLoaded(scopeId);
    };
    reload();
    window.addEventListener("storage", reload);
    return () => window.removeEventListener("storage", reload);
  }, [product, request.id, network, wallet, scopeId]);
  const ready =
    loaded === scopeId && !storageError && request.network === network;
  const visible =
    loaded === scopeId &&
    pending &&
    pending.wallet === wallet &&
    pending.network === network
      ? pending
      : null;
  const visibleKey = visible
    ? `${visible.vaultPda}:${visible.createdAt}:${visible.signature ?? ""}`
    : null;
  // The network's view of the visible approval, read when it appears and
  // after each attempt; a pending one is read again every RECHECK_MS.
  useEffect(() => {
    if (!visible || !visibleKey || busy) return;
    const intent = visible;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const check = async () => {
      const state = await checkCustodyOpenIntent(rpc, intent, {
        lastAttemptAt: lastAttemptAt.current,
      });
      if (cancelled) return;
      setChain({ key: visibleKey, state });
      if (state === "pending" || state === "unknown")
        timer = setTimeout(() => void check(), RECHECK_MS);
    };
    void check();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [visible, visibleKey, busy, rpc, checkTick]);
  const chainState = chain && chain.key === visibleKey ? chain.state : null;
  function remember(intent: CustodyOpenIntent | null) {
    latest.current = intent;
    setPending(intent);
  }
  /**
   * The gates a send refuses before the wallet opens, run on the SAME
   * instruction objects the wallet path gets (a page's withGateFacts
   * declaration is honoured): the pilot scope and KYC-only mode, the
   * emergency pause, maintenance, then the simulation. A refusal here
   * leaves no saved approval behind.
   */
  async function preflight(prepared: Prepared) {
    if (!wallet) throw new Error("Connect the wallet that opens this vault.");
    const instructions: readonly Instruction[] = Array.isArray(prepared)
      ? (prepared as readonly Instruction[])
      : [prepared as Instruction];
    assertInstructionsInScope(instructions, network);
    await assertInstructionsNotPaused(rpc, instructions);
    await assertSiteWritable();
    let refusal;
    try {
      ({ refusal } = await simulateInstructions(rpc, {
        feePayer: address(wallet),
        instructions,
        network,
      }));
    } catch (error) {
      throw new SimulationUnavailableError(network, error);
    }
    if (refusal) throw refusal;
  }
  /**
   * Links the vault to the request: the route verifies it at finalized, so
   * the wait comes first (plain RPC reads), then the one signed request; a
   * server whose node lags is retried after a backoff.
   */
  async function link(intent: CustodyOpenIntent) {
    if (
      !session ||
      !scope ||
      intent.wallet !== wallet ||
      intent.network !== network ||
      request.network !== network
    )
      throw new Error(
        "Connect the wallet and network associated with this approval.",
      );
    await requireCanonicalCustodyIntent(intent, request.share_class_pda);
    let outcome;
    try {
      outcome = await recordOnceFinalized({
        waitForFinalized: (timeoutMs) =>
          awaitCustodyOpenFinalized(rpc, intent, { timeoutMs }),
        record: async () => {
          await signedFetch(
            session,
            `/api/${product}/admin-update`,
            `${product}.adminUpdate`,
            {
              id: request.id,
              status: "vault_opened",
              vault_pda: intent.vaultPda,
              vault_id: Number(intent.vaultId),
              decide: true,
            },
          );
        },
        onStage: (next) => setStage(next),
      });
    } finally {
      setStage(null);
    }
    if (outcome === "failed") throw new Error(OPEN_FAILED_MESSAGE);
    if (outcome === "not_finalized")
      throw new Error(OPEN_NOT_FINALIZED_MESSAGE);
    notifyAdminBadges();
  }
  async function open<T extends Prepared>(
    vaultId: string,
    build: () => Promise<T>,
    send: (prepared: T) => Promise<string>,
  ) {
    if (lock.current || !ready || !scope)
      throw new Error(
        "Wait for custody approval recovery to load on the request's network.",
      );
    lock.current = true;
    setBusy(true);
    try {
      const intent = await openCustodyOnce({
        scope,
        shareClass: request.share_class_pda,
        vaultId,
        assertUnoccupied: async (vaultPda) => {
          // Raw existence: a 2D tombstone (rent reclaimed) still occupies
          // the PDA forever, so its vault ID counts as in use.
          const existing = await fetchEncodedAccount(
            rpc,
            address(vaultPda),
            {
              commitment: "confirmed",
              abortSignal: AbortSignal.timeout(12_000),
            },
          );
          if (existing.exists)
            throw new Error(
              "This vault ID is already in use. Choose a new ID before opening this request.",
            );
        },
        build,
        preflight,
        send,
        link,
        notSent: custodySendNeverBroadcast,
        onIntent: remember,
      });
      latest.current = null;
      setPending(null);
      return intent;
    } catch (error) {
      lastAttemptAt.current = Date.now();
      // Re-read: a send that never reached the network left nothing behind
      // ("Open vault" is back); an uncertain one stays saved.
      try {
        const intent = readCustodyOpenIntent(scope);
        latest.current = intent;
        setPending(intent);
      } catch {
        // Unreadable: the reload effect reports it.
      }
      throw error;
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function retry() {
    if (lock.current || !ready || !scope || !visible) return;
    lock.current = true;
    setBusy(true);
    try {
      await recordCustodyOpening(visible, scope, link);
      latest.current = null;
      setPending(null);
      toast.show({ kind: "success", title: "Existing custody vault linked" });
      onSuccess();
    } catch (error) {
      lastAttemptAt.current = Date.now();
      toast.showError(
        "Approval recording pending",
        error instanceof Error
          ? error.message
          : "Retry recording the saved vault.",
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  /**
   * Forgets a saved approval the network shows was never opened — checked
   * again under the request's lock right before — so the vault can be
   * opened again. Anything else is kept.
   */
  async function discard() {
    if (lock.current || !ready || !scope || !visible) return;
    const intent = visible;
    lock.current = true;
    setBusy(true);
    try {
      await withCustodyOpenLock(scope, async () => {
        const state = await checkCustodyOpenIntent(rpc, intent, {
          lastAttemptAt: lastAttemptAt.current,
        });
        if (state !== "never_opened") throw new Error(KEPT_MESSAGE[state]);
        if (!forgetCustodyOpenIntent(intent))
          throw new Error(
            "The saved approval changed in another tab. Reload and check it again.",
          );
      });
      latest.current = null;
      setPending(null);
      toast.show({
        kind: "success",
        title: "Approval discarded — no vault was opened",
      });
    } catch (error) {
      toast.showError(
        "Approval kept",
        error instanceof Error
          ? error.message
          : "The saved approval could not be discarded.",
      );
    } finally {
      lock.current = false;
      setBusy(false);
      setCheckTick((tick) => tick + 1);
    }
  }
  return {
    open,
    retry,
    discard,
    busy,
    ready,
    pending: visible,
    hasPending: () => latest.current !== null,
    /** The saved approval as this tab last read it (also right after a failed open). */
    latestIntent: () => latest.current,
    /** Where the link attempt in flight is (null outside one). */
    stage,
    /** The visible approval's send result, when the sender returned one. */
    signature: visible?.signature ?? null,
    /** The visible approval's transaction was sent (its signature is known). */
    sent: visible?.signature != null,
    chainState,
    panel: (
      <>
        {(storageError || request.network !== network) && (
          <p
            role="alert"
            className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800"
          >
            {storageError ??
              "Switch to the request's network before approving it."}
          </p>
        )}
        {stage && (
          <p role="status" className="mt-2 text-xs text-slate-600">
            {STAGE_TEXT[stage]}
          </p>
        )}
        {visible && (
          <section className="rounded-xl border border-brand-200 bg-brand-50 p-4 text-sm text-slate-700">
            <h3 className="font-semibold text-slate-900">
              Finish recording this approval
            </h3>
            <p className="mt-1 text-xs leading-relaxed">
              Vault #{visible.vaultId} is saved for this request. Retry verifies
              and links that existing vault. It does not open another vault or
              send tokens.
            </p>
            {!visible.signature && (
              <p className="mt-2 text-xs">
                The send result was not saved. The vault address still
                identifies the pending approval; verify its finalized state
                before taking any further action.
              </p>
            )}
            <a
              href={explorerAddressUrl(visible.vaultPda, visible.network)}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 block break-all font-mono text-xs text-brand-700 underline"
            >
              {visible.vaultPda}
            </a>
            {visible.signature && (
              <a
                href={explorerTxUrl(visible.signature, visible.network)}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 block break-all font-mono text-xs text-brand-700 underline"
              >
                {visible.signature}
              </a>
            )}
            <button
              type="button"
              disabled={busy || !ready}
              onClick={() => void retry()}
              className="mt-3 rounded-lg bg-brand-700 px-3 py-2 text-xs font-semibold text-white hover:bg-brand-800 disabled:opacity-50"
            >
              {busy ? "Verifying…" : "Retry recording existing vault"}
            </button>
            {chainState === "never_opened" && (
              <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                <p className="leading-relaxed">
                  The network shows no vault at this address and no successful
                  transaction for this approval, and the transaction can no
                  longer land. Discarding the approval lets you open the vault
                  again. If your wallet still shows the transaction as pending,
                  wait for it instead.
                </p>
                <button
                  type="button"
                  disabled={busy || !ready}
                  onClick={() => void discard()}
                  className="mt-2 rounded-lg border border-amber-700 bg-white px-3 py-2 text-xs font-semibold text-amber-900 hover:bg-amber-100 disabled:opacity-50"
                >
                  Discard — vault never opened
                </button>
              </div>
            )}
            {chainState === "unknown" && (
              <p className="mt-2 text-xs text-slate-600">
                The network could not be checked for this vault; it will be
                checked again shortly.
              </p>
            )}
          </section>
        )}
      </>
    ),
  };
}
