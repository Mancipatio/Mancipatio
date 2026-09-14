"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  clearPendingChainRecord,
  listPendingChainRecords,
  savePendingChainRecord,
  type ChainRecordKind,
  type PendingChainRecord,
} from "@/lib/chain-record-recovery";
import type { Network } from "@/lib/network";

/** Receipts remain visible in this tab even if storage fails after a send. */
export function useChainRecordRecovery(
  kind: ChainRecordKind,
  network: Network,
  wallet?: string,
) {
  const [receipts, setReceipts] = useState<PendingChainRecord[]>([]);
  const [loadedScope, setLoadedScope] = useState<string | null>(null);
  const unsaved = useRef(new Map<string, PendingChainRecord>());
  const scope = `${kind}:${network}:${wallet ?? ""}`;

  useEffect(() => {
    const reload = () => {
      const stored = wallet
        ? listPendingChainRecords({ kind, network, wallet })
        : [];
      const volatile = [...unsaved.current.values()].filter(
        (r) => r.kind === kind && r.network === network && r.wallet === wallet,
      );
      setReceipts([
        ...stored.filter(
          (r) => !volatile.some((v) => v.entityId === r.entityId),
        ),
        ...volatile,
      ]);
      setLoadedScope(scope);
    };
    reload();
    window.addEventListener("storage", reload);
    return () => window.removeEventListener("storage", reload);
  }, [kind, network, wallet, scope]);

  const remember = useCallback(
    (entityId: string, signature: string) => {
      if (!wallet)
        throw new Error("Connect the wallet that sent the transaction.");
      const receipt: PendingChainRecord = {
        kind,
        network,
        wallet,
        entityId,
        signature,
        version: 1,
        createdAt: new Date().toISOString(),
      };
      setReceipts((current) => [
        ...current.filter((r) => r.entityId !== entityId),
        receipt,
      ]);
      const key = `${kind}:${network}:${wallet}:${entityId}`;
      unsaved.current.set(key, receipt);
      savePendingChainRecord(receipt);
      unsaved.current.delete(key);
      return receipt;
    },
    [kind, network, wallet],
  );

  const forget = useCallback((receipt: PendingChainRecord) => {
    clearPendingChainRecord(receipt);
    unsaved.current.delete(
      `${receipt.kind}:${receipt.network}:${receipt.wallet}:${receipt.entityId}`,
    );
    setReceipts((current) =>
      current.filter(
        (r) =>
          r.entityId !== receipt.entityId || r.signature !== receipt.signature,
      ),
    );
  }, []);

  return {
    receipts:
      loadedScope === scope
        ? receipts.filter(
            (r) =>
              r.kind === kind && r.network === network && r.wallet === wallet,
          )
        : [],
    ready: loadedScope === scope,
    remember,
    forget,
  };
}
