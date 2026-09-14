"use client";

import { useEffect, useRef, useState } from "react";
import { useSolanaClient } from "@solana/react-hooks";
import { address } from "@solana/kit";
import { fetchMaybeCustodyVault } from "@/lib/generated/asset_registry";
import type { WalletSession } from "@solana/client";
import {
  detectNetwork,
  explorerAddressUrl,
  explorerTxUrl,
} from "@/lib/network";
import { signedFetch } from "@/lib/siws-client";
import { useToast } from "@/lib/toast";
import {
  openCustodyOnce,
  readCustodyOpenIntent,
  recordCustodyOpening,
  requireCanonicalCustodyIntent,
  type CustodyOpenIntent,
  type CustodyOpenScope,
} from "@/lib/custody-open-recovery";

export function useCustodyOpenRecovery(
  product: CustodyOpenScope["product"],
  request: { id: string; network: string; share_class_pda: string },
  session: WalletSession | null | undefined,
  onSuccess: () => void,
) {
  const client = useSolanaClient();
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
  const lock = useRef(false),
    latest = useRef<CustodyOpenIntent | null>(null);
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
  function remember(intent: CustodyOpenIntent) {
    latest.current = intent;
    setPending(intent);
  }
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
  }
  async function open<T>(
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
          const existing = await fetchMaybeCustodyVault(
            client.runtime.rpc,
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
        send,
        link,
        onIntent: remember,
      });
      latest.current = null;
      setPending(null);
      return intent;
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
  return {
    open,
    busy,
    ready,
    pending: visible,
    hasPending: () => latest.current !== null,
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
          </section>
        )}
      </>
    ),
  };
}
