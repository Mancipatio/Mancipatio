"use client";

import { isAddress, isSignature } from "@solana/kit";
import type { Network } from "@/lib/network";

export type ChainRecordKind =
  | "purchase"
  | "delivery"
  | "conversion"
  | "delivery_return"
  | "conversion_return"
  | "custody_outcome";
export type ChainRecordScope = {
  kind: ChainRecordKind;
  network: Network;
  wallet: string;
  entityId: string;
};
export type PendingChainRecord = ChainRecordScope & {
  version: 1;
  signature: string;
  createdAt: string;
};

const PREFIX = "mancipatio:chain-record:v1:";
const KINDS: ChainRecordKind[] = [
  "purchase",
  "delivery",
  "conversion",
  "delivery_return",
  "conversion_return",
  "custody_outcome",
];
const NETWORKS: string[] = ["mainnet", "devnet", "testnet", "localnet"];

function scopeKey(scope: ChainRecordScope): string {
  if (
    !KINDS.includes(scope.kind) ||
    !NETWORKS.includes(scope.network) ||
    !isAddress(scope.wallet) ||
    !scope.entityId ||
    scope.entityId.length > 200
  ) {
    throw new Error("Invalid transaction recovery scope.");
  }
  return `${PREFIX}${scope.kind}:${scope.network}:${scope.wallet}:${encodeURIComponent(scope.entityId)}`;
}

function storage(): Storage {
  if (typeof window === "undefined")
    throw new Error("Browser storage is unavailable.");
  return window.localStorage;
}

/** Call before sending funds so blocked storage is discovered before signing. */
export function assertChainRecordStorageAvailable(): void {
  try {
    const store = storage();
    const probe = `${PREFIX}probe:${Date.now()}:${Math.random()}`;
    store.setItem(probe, "1");
    if (store.getItem(probe) !== "1") throw new Error("Storage write failed");
    store.removeItem(probe);
  } catch {
    throw new Error(
      "Enable browser storage before sending this transaction so its receipt can be recovered after a refresh.",
    );
  }
}

function parseRecord(
  raw: string | null,
  key: string,
): PendingChainRecord | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as PendingChainRecord;
    if (
      value.version !== 1 ||
      scopeKey(value) !== key ||
      !isSignature(value.signature) ||
      typeof value.createdAt !== "string" ||
      !Number.isFinite(Date.parse(value.createdAt))
    )
      return null;
    return value;
  } catch {
    return null;
  }
}

/** Store only public transaction identity, never request details or tokens. */
export function savePendingChainRecord(
  input: ChainRecordScope & { signature: string },
): PendingChainRecord {
  const key = scopeKey(input);
  if (!isSignature(input.signature))
    throw new Error("Invalid transaction signature.");
  const record: PendingChainRecord = {
    version: 1,
    kind: input.kind,
    network: input.network,
    wallet: input.wallet,
    entityId: input.entityId,
    signature: input.signature,
    createdAt: new Date().toISOString(),
  };
  try {
    const store = storage();
    store.setItem(key, JSON.stringify(record));
    if (parseRecord(store.getItem(key), key)?.signature !== record.signature)
      throw new Error("Storage write failed");
  } catch {
    throw new Error(
      "The transaction was sent, but its receipt could not be saved in this browser. Keep the transaction signature and retry recording it; do not send the funds again.",
    );
  }
  return record;
}

export function readPendingChainRecord(
  scope: ChainRecordScope,
): PendingChainRecord | null {
  const key = scopeKey(scope);
  try {
    return parseRecord(storage().getItem(key), key);
  } catch {
    return null;
  }
}

/** A delayed response must not delete the receipt for a newer transaction. */
export function clearPendingChainRecord(
  record: ChainRecordScope & { signature: string },
): void {
  const key = scopeKey(record);
  const store = storage();
  if (parseRecord(store.getItem(key), key)?.signature === record.signature)
    store.removeItem(key);
}

/** Entries have no automatic TTL: finalization/database recovery can take time. */
export function listPendingChainRecords(
  scope: Omit<ChainRecordScope, "entityId">,
): PendingChainRecord[] {
  const prefix = scopeKey({ ...scope, entityId: "probe" }).slice(
    0,
    -"probe".length,
  );
  try {
    const store = storage();
    const records: PendingChainRecord[] = [];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (!key?.startsWith(prefix)) continue;
      const record = parseRecord(store.getItem(key), key);
      if (record) records.push(record);
    }
    return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  } catch {
    return [];
  }
}
