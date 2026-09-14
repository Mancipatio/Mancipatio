"use client";
import { useRef, useState } from "react";
import type { WalletSession } from "@solana/client";
import { detectNetwork } from "@/lib/network";
import { signedFetch } from "@/lib/siws-client";
import {
  assertChainRecordStorageAvailable,
  listPendingChainRecords,
  type PendingChainRecord,
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
    await refresh();
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
    await finish(receipt);
  }
  async function retry(receipt: PendingChainRecord) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      await finish(receipt);
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
  return {
    prepare,
    release,
    record,
    busy,
    ready: recovery.ready,
    panel: (
      <ChainRecordRecoveryPanel
        receipts={receipts}
        busy={busy}
        onRetry={retry}
      />
    ),
  };
}
