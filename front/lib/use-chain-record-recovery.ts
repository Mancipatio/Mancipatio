"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSolanaClient } from "@solana/react-hooks";
import {
  checkPendingChainRecord,
  clearPendingChainRecord,
  discardableChainRecordState,
  discardPendingChainRecord,
  listPendingChainRecords,
  recordOnceFinalized,
  savePendingChainRecord,
  waitForFinalizedSignature,
  type ChainRecordKind,
  type ChainRecordState,
  type FinalizedSignatureOutcome,
  type PendingChainRecord,
  type RecordingOutcome,
  type RecordingStage,
} from "@/lib/chain-record-recovery";
import type { Network } from "@/lib/network";

/** The record attempt in flight (or the last one): its signature and stage (null once it ended). */
export type ChainRecordAttempt = {
  signature: string;
  stage: RecordingStage | null;
  attempt: number;
};

/** Receipts remain visible in this tab even if storage fails after a send. */
export function useChainRecordRecovery(
  kind: ChainRecordKind,
  network: Network,
  wallet?: string,
) {
  const client = useSolanaClient();
  const rpc = client.runtime.rpc;
  const [receipts, setReceipts] = useState<PendingChainRecord[]>([]);
  const [loadedScope, setLoadedScope] = useState<string | null>(null);
  const unsaved = useRef(new Map<string, PendingChainRecord>());
  const scope = `${kind}:${network}:${wallet ?? ""}`;
  // What became of each receipt's transaction on the network, by signature
  // (checkPendingChainRecord): read once per receipt, again on check,
  // discard and every wait.
  const [states, setStates] = useState<ReadonlyMap<string, ChainRecordState>>(
    () => new Map(),
  );
  const checked = useRef(new Set<string>());
  const [attempt, setAttempt] = useState<ChainRecordAttempt | null>(null);

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

  const noteState = useCallback((signature: string, state: ChainRecordState) => {
    setStates((current) => {
      const next = new Map(current);
      next.set(signature, state);
      return next;
    });
  }, []);

  // Each receipt is checked once when it appears, so the panel can tell a
  // receipt that can no longer land from one still waiting to be recorded.
  useEffect(() => {
    for (const receipt of receipts) {
      if (checked.current.has(receipt.signature)) continue;
      checked.current.add(receipt.signature);
      void checkPendingChainRecord(rpc, receipt).then((state) =>
        noteState(receipt.signature, state),
      );
    }
  }, [receipts, rpc, noteState]);

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

  /** Drops the receipt from this tab's state (storage is the caller's business). */
  const drop = useCallback((receipt: PendingChainRecord) => {
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

  /** Recording succeeded: the receipt has done its job. */
  const forget = useCallback(
    (receipt: PendingChainRecord) => {
      clearPendingChainRecord(receipt);
      drop(receipt);
    },
    [drop],
  );

  /** One fresh read of what became of the receipt's transaction. */
  const check = useCallback(
    async (receipt: Pick<PendingChainRecord, "signature" | "createdAt">) => {
      const state = await checkPendingChainRecord(rpc, receipt);
      noteState(receipt.signature, state);
      return state;
    },
    [rpc, noteState],
  );

  /**
   * Removes a receipt whose transaction the network ran and failed, or can
   * no longer run (did_not_land) — never one that is pending, landed or
   * could not be checked. Re-reads the network first; the stored record is
   * removed only while it still holds this signature.
   */
  const discard = useCallback(
    async (
      receipt: PendingChainRecord,
    ): Promise<{ state: ChainRecordState; discarded: boolean }> => {
      const state = await checkPendingChainRecord(rpc, receipt);
      noteState(receipt.signature, state);
      const discarded = discardableChainRecordState(state);
      if (discarded) {
        discardPendingChainRecord(receipt, state);
        drop(receipt);
      }
      return { state, discarded };
    },
    [rpc, noteState, drop],
  );

  /** Waits (plain RPC reads) for the receipt's transaction to finalize; notes a landed or failed one. */
  const awaitFinalized = useCallback(
    async (
      receipt: Pick<PendingChainRecord, "signature">,
      timeoutMs?: number,
    ): Promise<FinalizedSignatureOutcome> => {
      const outcome = await waitForFinalizedSignature(rpc, receipt.signature, {
        timeoutMs,
      });
      if (outcome === "finalized") noteState(receipt.signature, "landed");
      else if (outcome === "failed") noteState(receipt.signature, "failed");
      return outcome;
    },
    [rpc, noteState],
  );

  /**
   * The finalization-aware record (lib/chain-record-recovery
   * recordOnceFinalized): waits for the transaction to finalize, then runs
   * `record` (the one signed request) once, retrying a server that has not
   * seen the finalized transaction yet after a backoff. "failed" discards
   * the receipt: the network ran the transaction and nothing moved.
   * `attempt` / `stage` show where it is.
   */
  const recordFinalized = useCallback(
    async (
      receipt: PendingChainRecord,
      record: () => Promise<void>,
    ): Promise<RecordingOutcome> => {
      setAttempt({
        signature: receipt.signature,
        stage: "awaiting_finalization",
        attempt: 0,
      });
      try {
        const outcome = await recordOnceFinalized({
          waitForFinalized: (timeoutMs) => awaitFinalized(receipt, timeoutMs),
          record,
          onStage: (stage, n) =>
            setAttempt({ signature: receipt.signature, stage, attempt: n }),
        });
        if (outcome === "failed") {
          discardPendingChainRecord(receipt, "failed");
          drop(receipt);
        }
        return outcome;
      } finally {
        setAttempt((current) =>
          current && current.signature === receipt.signature
            ? { ...current, stage: null }
            : current,
        );
      }
    },
    [awaitFinalized, drop],
  );

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
    states,
    check,
    discard,
    awaitFinalized,
    recordFinalized,
    attempt,
    stage: attempt?.stage ?? null,
    signature: attempt?.signature ?? null,
  };
}
