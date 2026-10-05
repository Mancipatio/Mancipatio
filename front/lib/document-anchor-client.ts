"use client";

// Browser side of the document anchors (lib/document-anchor.ts): the two
// session calls of the panel on /admin/platform, the one anchor this browser
// sent but has not recorded yet (kept so a reload or a closed tab can still
// record it; the transaction is on chain either way), and the panel's send →
// confirm → record flow and result card as plain functions
// (tests/document-anchor-ui.test.ts drives them without a DOM).

import type { WalletSession } from "@solana/client";
import { signedFetch, type SignedFetchInteractive } from "@/lib/siws-client";
import {
  DOCUMENT_ANCHOR_LIST_ACTION,
  DOCUMENT_ANCHOR_NOT_YET,
  DOCUMENT_ANCHOR_RECORD_ACTION,
  DOCUMENT_ANCHOR_REFERENCE_PATTERN,
  DOCUMENT_ANCHOR_SHA256_PATTERN,
  documentAnchorMemoText,
  type DocumentAnchor,
  type DocumentAnchorRecord,
} from "@/lib/document-anchor";
import type { Network } from "@/lib/network";
import type { SignatureOutcome } from "@/lib/simulation-gate";
import { TransactionWalletChangedError } from "@/lib/transaction-wallet-policy";

export type RecordedAnchor = DocumentAnchorRecord & { duplicate: boolean };
export type PendingAnchor = DocumentAnchor & { signature: string; network: Network; signer: string };

/**
 * Waits before each retry while the server RPC does not show the transaction
 * as finalized yet: 40 s in all, since finalization follows the browser's
 * "confirmed" by about 13 seconds and the server's node can trail it.
 */
export const RECORD_RETRY_DELAYS_MS = [2_000, 4_000, 6_000, 8_000, 10_000, 10_000];

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
 * not show the transaction as finalized yet (it can trail the browser's by a
 * few seconds). Any other refusal is thrown at once.
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

// ── The panel's flow and result card ───────────────────────────────────────

/** The result card's state: the anchor sent from this browser and what became of it. */
export type AnchorResult = {
  anchor: PendingAnchor;
  memo: string;
  /** null while the network is asked; "restored" = sent earlier from this browser, status not read here. */
  outcome: SignatureOutcome | "restored" | null;
  record: RecordedAnchor | null;
  recordError: string | null;
};

/** The card of the anchor this browser sent on `network` for `signer` and has not recorded yet, or null. */
export function restoredAnchorResult(network: Network, signer: string): AnchorResult | null {
  const pending = readPendingAnchor(network, signer);
  if (!pending) return null;
  try {
    return { anchor: pending, memo: documentAnchorMemoText(pending), outcome: "restored", record: null, recordError: null };
  } catch {
    return null;
  }
}

/**
 * Whether a new anchor may not be sent: the card holds an anchor that may be
 * on chain but is not recorded yet. Sending another would replace it as the
 * one pending anchor this browser keeps, and the first could no longer be
 * recorded from the page. Record it (or, after a failed attempt, forget it)
 * first. A failed anchor (nothing on chain) or a recorded one does not block.
 */
export function anchorBlocksNewSend(result: AnchorResult | null): boolean {
  return result !== null && result.record === null && result.outcome !== "failed";
}

/**
 * The card after the server recorded it. The server records only a
 * transaction it read as finalized and successful, so the anchor is confirmed
 * whatever the browser saw before (a timeout, an unknown status, a restore).
 */
export function withRecordedAnchor(result: AnchorResult, record: RecordedAnchor): AnchorResult {
  return { ...result, outcome: "confirmed", record, recordError: null };
}

export type AnchorResultView = {
  heading: string;
  tone: "failed" | "confirmed" | "pending";
  /** "Record in the audit log" is offered. */
  canRecord: boolean;
  /** The closing button: "Done" (nothing left to do) or "Forget it" (after a failed record), or none. */
  dismissLabel: "Done" | "Forget it" | null;
  /** Shown next to "Forget it": what forgetting loses (the page keeps no other copy of the signature). */
  dismissWarning: string | null;
};

/** Next to "Forget it" when the network confirmed the anchor: it IS on chain. */
export const FORGET_CONFIRMED_WARNING =
  "This anchor is on chain (the network confirmed it). Forgetting it leaves it out of the audit log for good: this page " +
  "keeps no other copy of the signature and cannot record it later. Try recording it again first, and copy the " +
  "signature before you forget it.";
/** Next to "Forget it" otherwise: the anchor may be on chain. */
export const FORGET_UNCONFIRMED_WARNING =
  "Forget it only when the explorer does not show this transaction: once forgotten, this page cannot record it.";

export function anchorResultView(result: AnchorResult): AnchorResultView {
  const { outcome, record, recordError } = result;
  const confirmed = outcome === "confirmed" || record !== null;
  const dismissLabel = record || outcome === "failed" ? "Done" : recordError ? "Forget it" : null;
  const heading =
    outcome === "failed"
      ? "The anchor failed on the network"
      : confirmed
        ? "Anchored on chain"
        : outcome === null
          ? "Sent — waiting for the network"
          : outcome === "restored"
            ? "Sent earlier from this browser, not recorded yet"
            : "Sent — not confirmed yet";
  return {
    heading,
    tone: outcome === "failed" ? "failed" : confirmed ? "confirmed" : "pending",
    canRecord: outcome !== "failed" && outcome !== null && !record,
    dismissLabel,
    dismissWarning:
      dismissLabel !== "Forget it" ? null : outcome === "confirmed" ? FORGET_CONFIRMED_WARNING : FORGET_UNCONFIRMED_WARNING,
  };
}

/**
 * Closes the card. "Done" after a record or a failed anchor; "Forget it"
 * (only offered after a record attempt failed, with dismissWarning) also
 * forgets the pending anchor kept in this browser.
 */
export function dismissAnchorResult(result: AnchorResult): void {
  if (!result.record) clearPendingAnchor(result.anchor.signature);
}

/**
 * Whether a send error may have come AFTER the wallet broadcast the anchor:
 * the verified client (lib/verified-solana-client prepareAndSend) checks
 * that the wallet, account and network are unchanged once more after the
 * wallet returns, so a switch during the wallet prompt throws
 * TransactionWalletChangedError although the memo may already be on chain,
 * and the error carries no signature. Any other send error comes before the
 * broadcast or from the wallet's refusal.
 */
export function anchorSendMayHaveLanded(err: unknown): boolean {
  for (let cursor: unknown = err, depth = 0; cursor instanceof Error && depth < 6; cursor = cursor.cause, depth++) {
    if (cursor instanceof TransactionWalletChangedError || cursor.name === "TransactionWalletChangedError") return true;
  }
  return false;
}

export type AnchorFlowHooks = {
  /** Builds, checks and sends the transaction through the wallet; resolves to its signature. */
  send: () => Promise<unknown>;
  /**
   * The send threw: nothing was sent (refused before or by the wallet), and
   * the review stays open; unless anchorSendMayHaveLanded, when the anchor
   * may be on chain: then the review closes and the panel says to check the
   * explorer before sending again.
   */
  onSendError: (err: unknown) => void;
  /** The wallet sent it: the pending anchor is saved; close the review and show the card. */
  onSent: (pending: PendingAnchor) => void;
  /** Waits for the network's answer. */
  wait: (signature: string) => Promise<SignatureOutcome>;
  /**
   * The network answered. "failed": the pending anchor is forgotten (nothing
   * is on chain). "timeout" / "unknown": it stays pending, to be recorded
   * from the card. "confirmed": clear the inputs; `record` follows.
   */
  onOutcome: (pending: PendingAnchor, outcome: SignatureOutcome) => void;
  /** Records a confirmed anchor in the audit log. */
  record: (pending: PendingAnchor) => Promise<void>;
};

/** One anchor, from the wallet to the audit log. Resolves to "not-sent" or the network's outcome. */
export async function runDocumentAnchorFlow(
  anchor: DocumentAnchor,
  context: { network: Network; signer: string },
  hooks: AnchorFlowHooks,
): Promise<"not-sent" | SignatureOutcome> {
  let signature: string;
  try {
    const sent = await hooks.send();
    signature = typeof sent === "string" ? sent : String(sent ?? "");
    if (!signature) throw new Error("The wallet returned no transaction signature.");
  } catch (err) {
    hooks.onSendError(err);
    return "not-sent";
  }
  const pending: PendingAnchor = { reference: anchor.reference, sha256: anchor.sha256, signature, network: context.network, signer: context.signer };
  savePendingAnchor(pending);
  hooks.onSent(pending);
  const outcome = await hooks.wait(signature);
  if (outcome === "failed") clearPendingAnchor(signature);
  hooks.onOutcome(pending, outcome);
  if (outcome === "confirmed") await hooks.record(pending);
  return outcome;
}
