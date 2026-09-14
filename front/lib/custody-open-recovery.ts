"use client";

import { address, isAddress, isSignature } from "@solana/kit";
import { assertChainRecordStorageAvailable } from "@/lib/chain-record-recovery";
import { findCustodyVaultPda } from "@/lib/pdas";
import type { Network } from "@/lib/network";

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

/** Existing intent always takes the API-only branch, even when the sender
 * failed before returning a signature. There is no automatic clear/re-open. */
export async function openCustodyOnce<T>(input: {
  scope: CustodyOpenScope;
  shareClass: string;
  vaultId: string;
  assertUnoccupied: (vaultPda: string) => Promise<void>;
  build: () => Promise<T>;
  send: (prepared: T) => Promise<string>;
  link: (intent: CustodyOpenIntent) => Promise<void>;
  onIntent: (intent: CustodyOpenIntent) => void;
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
    const signature = await input.send(prepared);
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
  if (typeof navigator !== "undefined" && navigator.locks)
    return navigator.locks.request(key(input.scope), run);
  return run();
}
