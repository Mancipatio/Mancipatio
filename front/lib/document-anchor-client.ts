"use client";

// Browser side of the document anchors (lib/document-anchor.ts): the two
// session calls of the panel on /admin/platform, and the one anchor this
// browser sent but has not recorded yet (kept so a reload or a closed tab can
// still record it; the transaction is on chain either way).

import type { WalletSession } from "@solana/client";
import { signedFetch, type SignedFetchInteractive } from "@/lib/siws-client";
import {
  DOCUMENT_ANCHOR_LIST_ACTION,
  DOCUMENT_ANCHOR_NOT_YET,
  DOCUMENT_ANCHOR_RECORD_ACTION,
  DOCUMENT_ANCHOR_REFERENCE_PATTERN,
  DOCUMENT_ANCHOR_SHA256_PATTERN,
  type DocumentAnchor,
  type DocumentAnchorRecord,
} from "@/lib/document-anchor";
import type { Network } from "@/lib/network";

export type RecordedAnchor = DocumentAnchorRecord & { duplicate: boolean };
export type PendingAnchor = DocumentAnchor & { signature: string; network: Network; signer: string };

/** Waits before each retry while the server RPC does not show the transaction yet. */
export const RECORD_RETRY_DELAYS_MS = [2_000, 4_000, 6_000, 8_000];

/** Records one anchor (the server verifies it on chain first). One attempt. */
export function recordDocumentAnchor(
  session: WalletSession | null | undefined,
  input: DocumentAnchor & { signature: string },
): Promise<RecordedAnchor> {
  return signedFetch<RecordedAnchor>(session, "/api/admin/document-anchor", DOCUMENT_ANCHOR_RECORD_ACTION, {
    signature: input.signature,
    reference: input.reference,
    sha256: input.sha256,
  });
}

/**
 * Records one anchor, waiting and trying again while the server's node does
 * not show the transaction yet (it can trail the browser's by a few seconds).
 * Any other refusal is thrown at once.
 */
export async function recordDocumentAnchorWithRetry(
  session: WalletSession | null | undefined,
  input: DocumentAnchor & { signature: string },
  delays: readonly number[] = RECORD_RETRY_DELAYS_MS,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<RecordedAnchor> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await recordDocumentAnchor(session, input);
    } catch (err) {
      const notYet = err instanceof Error && err.message.startsWith(DOCUMENT_ANCHOR_NOT_YET);
      if (!notYet || attempt >= delays.length) throw err;
      await sleep(delays[attempt]);
    }
  }
}

/** The newest recorded anchors. `interactive`: see signedFetch (false = only an existing session, no prompt). */
export function listDocumentAnchors(
  session: WalletSession | null | undefined,
  interactive: SignedFetchInteractive = false,
): Promise<DocumentAnchorRecord[]> {
  return signedFetch<DocumentAnchorRecord[]>(session, "/api/admin/document-anchor/list", DOCUMENT_ANCHOR_LIST_ACTION, {}, { interactive });
}

const PENDING_KEY = "manci:document-anchor:pending:v1";

function pendingFrom(raw: string | null): PendingAnchor | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<PendingAnchor> | null;
    if (
      value && typeof value.signature === "string" && typeof value.network === "string" && typeof value.signer === "string" &&
      typeof value.reference === "string" && DOCUMENT_ANCHOR_REFERENCE_PATTERN.test(value.reference) &&
      typeof value.sha256 === "string" && DOCUMENT_ANCHOR_SHA256_PATTERN.test(value.sha256)
    ) {
      return value as PendingAnchor;
    }
  } catch {
    // A damaged entry is ignored.
  }
  return null;
}

/** The anchor this browser sent on `network` for `signer` and has not recorded yet, or null. */
export function readPendingAnchor(network: Network, signer: string): PendingAnchor | null {
  try {
    const pending = pendingFrom(window.localStorage.getItem(PENDING_KEY));
    return pending && pending.network === network && pending.signer === signer ? pending : null;
  } catch {
    return null;
  }
}

export function savePendingAnchor(pending: PendingAnchor): void {
  try {
    window.localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
  } catch {
    // Storage may be blocked; the page still shows the signature to record.
  }
}

/** Forgets the pending anchor (only the one with `signature`, when given). */
export function clearPendingAnchor(signature?: string): void {
  try {
    if (signature) {
      const pending = pendingFrom(window.localStorage.getItem(PENDING_KEY));
      if (pending && pending.signature !== signature) return;
    }
    window.localStorage.removeItem(PENDING_KEY);
  } catch {
    // Nothing to forget.
  }
}
