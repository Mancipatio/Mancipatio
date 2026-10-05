"use client";

// Browser side of the document anchors (lib/document-anchor.ts): the two
// session calls of the panel on /admin/platform, the one anchor this browser
// sent but has not recorded yet (kept so a reload or a closed tab can still
// record it; the transaction is on chain either way), the send that may have
// been sent (kept until the operator has checked the explorer), and the
// panel's send → confirm → record flow and result card as plain functions
// (tests/document-anchor-ui.test.ts drives them without a DOM, and
// tests/document-anchor-send.test.ts through the real @solana/client send).

import type { WalletSession } from "@solana/client";
import {
  getBase58Decoder,
  isTransactionModifyingSigner,
  isTransactionPartialSigner,
  isTransactionSendingSigner,
  type SignatureBytes,
  type TransactionModifyingSigner,
  type TransactionPartialSigner,
  type TransactionSendingSigner,
  type TransactionSigner,
} from "@solana/kit";
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

/**
 * A send that may have been sent: it failed after the wallet had the
 * transaction (anchorSendMayHaveLanded), so this page cannot tell whether it
 * reached the network. Kept in this browser next to the pending anchor, per
 * network and wallet, so that a reload, a closed tab or a wallet or account
 * switch does not lose it; while it is kept no other anchor can be sent from
 * the panel, until the operator has checked the explorer and dismisses it
 * (or records it, when its signature is known: adoptUncertainSend).
 */
export type UncertainAnchorSend = DocumentAnchor & {
  network: Network;
  signer: string;
  /**
   * The transaction's id (the fee payer's signature) when the wallet handed
   * back the signed transaction, the one the SDK broadcasts; null when the
   * wallet signs and sends itself and failed doing so.
   */
  signature: string | null;
  /** When the send ended (ISO 8601), to find it among the wallet's transactions. */
  at: string;
};

const UNCERTAIN_KEY = "manci:document-anchor:uncertain:v1";
const BASE58_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;

function uncertainKey(network: Network, signer: string): string {
  return `${UNCERTAIN_KEY}:${network}:${signer}`;
}

/** The send on `network` by `signer` that may have been sent and is not dismissed yet, or null. */
export function readUncertainSend(network: Network, signer: string): UncertainAnchorSend | null {
  try {
    const raw = window.localStorage.getItem(uncertainKey(network, signer));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<UncertainAnchorSend> | null;
    if (
      value && value.network === network && value.signer === signer &&
      typeof value.at === "string" && !Number.isNaN(Date.parse(value.at)) &&
      (value.signature === null || (typeof value.signature === "string" && BASE58_SIGNATURE.test(value.signature))) &&
      typeof value.reference === "string" && DOCUMENT_ANCHOR_REFERENCE_PATTERN.test(value.reference) &&
      typeof value.sha256 === "string" && DOCUMENT_ANCHOR_SHA256_PATTERN.test(value.sha256)
    ) {
      return value as UncertainAnchorSend;
    }
  } catch {
    // Storage blocked or a damaged entry: nothing to show.
  }
  return null;
}

export function saveUncertainSend(note: UncertainAnchorSend): void {
  try {
    window.localStorage.setItem(uncertainKey(note.network, note.signer), JSON.stringify(note));
  } catch {
    // Storage may be blocked; the panel still shows the warning until it is closed.
  }
}

/** The operator checked the explorer: forget the warning for `network` and `signer`. */
export function clearUncertainSend(network: Network, signer: string): void {
  try {
    window.localStorage.removeItem(uncertainKey(network, signer));
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
 * on chain but is not recorded yet, or the last send may have been sent
 * (`uncertain`, until the operator dismisses it after checking the
 * explorer). Sending another would replace the card's anchor as the one
 * pending anchor this browser keeps, and the first could no longer be
 * recorded from the page; after an uncertain send it could anchor the same
 * document twice. Record the card's anchor (or, after a failed attempt,
 * forget it) first. A failed anchor (nothing on chain) or a recorded one
 * does not block.
 */
export function anchorBlocksNewSend(result: AnchorResult | null, uncertain: UncertainAnchorSend | null = null): boolean {
  return uncertain !== null || (result !== null && result.record === null && result.outcome !== "failed");
}

/**
 * "It is on the explorer: record it" for an uncertain send whose signature is
 * known: it becomes this browser's pending anchor (to be recorded from the
 * card; the server records only what it reads on chain) and the warning is
 * forgotten. Null, and nothing changed, without a signature: only dismissing
 * is offered then.
 */
export function adoptUncertainSend(note: UncertainAnchorSend): AnchorResult | null {
  if (!note.signature) return null;
  const pending: PendingAnchor = {
    reference: note.reference,
    sha256: note.sha256,
    signature: note.signature,
    network: note.network,
    signer: note.signer,
  };
  let memo: string;
  try {
    memo = documentAnchorMemoText(pending);
  } catch {
    return null;
  }
  savePendingAnchor(pending);
  clearUncertainSend(note.network, note.signer);
  return { anchor: pending, memo, outcome: "restored", record: null, recordError: null };
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

// ── How far a send got ─────────────────────────────────────────────────────

/**
 * How far one anchor send got, as the wallet's signer saw it
 * (createAnchorSendTracker). Where a send failed says whether it may have
 * been sent; the error's class does not (the same wallet-changed check runs
 * before the prompt, inside the wallet call and after the broadcast).
 *
 * The send (tx.send) is lib/verified-solana-client's prepareAndSend over
 * @solana/client's: the site's checks, the simulation gate and the
 * wallet-policy prompt, then the SDK's sendWithExecutor. For a wallet with
 * signTransaction (Phantom, Solflare, Backpack), createWalletTransactionSigner
 * makes a "partial" signer: the SDK asks the wallet only to sign, gets the
 * signed transaction back, and then broadcasts it itself
 * (rpc.sendTransaction). A wallet with only sendTransaction signs and
 * broadcasts in the one call.
 *
 * - "before-wallet": the wallet was not asked (the site's checks, the gate,
 *   the policy prompt, a change noticed before the prompt). Nothing was sent.
 * - "wallet-signing": the wallet was asked to sign and handed nothing back:
 *   refused, failed, or the guarded session (lib/guarded-wallet-connectors)
 *   found the wallet or account changed when it returned. Such a wallet
 *   never broadcasts, so nothing was sent.
 * - "wallet-sending": a wallet that sends itself was asked, and failed: it
 *   may have broadcast before it failed.
 * - "signed": the wallet handed back the signed transaction (sending itself:
 *   its signature). The SDK broadcasts it next (or the wallet did). Whatever
 *   fails from here, this page cannot tell a send that never left from one
 *   the network has: the transaction graph's own check after the wallet
 *   returns (lib/transaction-session-guard: the network, the RPC, the wallet
 *   policy), rpc.sendTransaction's answer or its transport (a timeout, a
 *   dropped connection), the verified client's last check after the
 *   broadcast.
 * - "returned": the send resolved, so it was broadcast (with no signature
 *   to show for it, the flow still treats it as may have been sent).
 */
export type AnchorSendStage = "before-wallet" | "wallet-signing" | "wallet-sending" | "signed" | "returned";

const STAGE_ORDER: readonly AnchorSendStage[] = ["before-wallet", "wallet-signing", "wallet-sending", "signed", "returned"];

/** Whether a send that failed at `stage` may have been sent (see AnchorSendStage). */
export function anchorSendMayHaveLanded(stage: AnchorSendStage): boolean {
  return stage === "wallet-sending" || stage === "signed" || stage === "returned";
}

export type AnchorSendTracker = {
  /**
   * The wallet's signer, wrapped to note how far the send gets. The
   * transaction must name the returned signer everywhere it names the wallet
   * (the memo's signer and the fee payer: kit matches signers by reference).
   */
  track: (signer: TransactionSigner) => TransactionSigner;
  readonly stage: AnchorSendStage;
  /** The transaction's id (the fee payer's signature, base58) once the wallet handed it back, else null. */
  readonly signature: string | null;
  /** The send resolved. */
  returned: () => void;
};

/** One send's tracker (see AnchorSendStage). The stage only moves forward. */
export function createAnchorSendTracker(): AnchorSendTracker {
  let stage: AnchorSendStage = "before-wallet";
  let signature: string | null = null;
  const decoder = getBase58Decoder();
  const advance = (next: AnchorSendStage) => {
    if (STAGE_ORDER.indexOf(next) > STAGE_ORDER.indexOf(stage)) stage = next;
  };
  const noteSignature = (bytes: SignatureBytes | null | undefined) => {
    if (signature === null && bytes && bytes.length === 64) signature = decoder.decode(bytes);
  };

  function track(signer: TransactionSigner): TransactionSigner {
    const { address } = signer;
    const modifying: TransactionModifyingSigner | null = isTransactionModifyingSigner(signer) ? signer : null;
    const partial: TransactionPartialSigner | null = isTransactionPartialSigner(signer) ? signer : null;
    const sending: TransactionSendingSigner | null = isTransactionSendingSigner(signer) ? signer : null;
    if (!modifying && !partial && !sending) throw new Error("This wallet cannot sign transactions.");
    const modifyAndSign =
      (inner: TransactionModifyingSigner): TransactionModifyingSigner["modifyAndSignTransactions"] =>
      async (transactions, config) => {
        advance("wallet-signing");
        const signed = await inner.modifyAndSignTransactions(transactions, config);
        noteSignature(signed[0]?.signatures[address]);
        advance("signed");
        return signed;
      };
    const sign =
      (inner: TransactionPartialSigner): TransactionPartialSigner["signTransactions"] =>
      async (transactions, config) => {
        advance("wallet-signing");
        const signatures = await inner.signTransactions(transactions, config);
        noteSignature(signatures[0]?.[address]);
        advance("signed");
        return signatures;
      };
    const signAndSend =
      (inner: TransactionSendingSigner): TransactionSendingSigner["signAndSendTransactions"] =>
      async (transactions, config) => {
        advance("wallet-sending");
        const signatures = await inner.signAndSendTransactions(transactions, config);
        noteSignature(signatures[0]);
        advance("signed");
        return signatures;
      };
    // The same kinds as the wallet's signer (kit picks how to sign by the methods present).
    return Object.freeze({
      address,
      ...(modifying ? { modifyAndSignTransactions: modifyAndSign(modifying) } : {}),
      ...(partial ? { signTransactions: sign(partial) } : {}),
      ...(sending ? { signAndSendTransactions: signAndSend(sending) } : {}),
    }) as TransactionSigner;
  }

  return {
    track,
    get stage() {
      return stage;
    },
    get signature() {
      return signature;
    },
    returned: () => advance("returned"),
  };
}

export type AnchorFlowHooks = {
  /**
   * Builds, checks and sends the transaction through the wallet; resolves to
   * its signature. The transaction must name `track(<the wallet's signer>)`
   * (createAnchorSendTracker), so that a failed send says how far it got.
   */
  send: (track: (signer: TransactionSigner) => TransactionSigner) => Promise<unknown>;
  /**
   * The send threw, or resolved without a signature. `uncertain` null:
   * nothing was sent (refused before the wallet or by it, or the wallet
   * handed nothing back), and the review stays open. Otherwise the anchor may
   * have been sent (anchorSendMayHaveLanded): the note is already kept in
   * this browser (saveUncertainSend); the review closes and the panel says to
   * check the explorer for the wallet before sending again.
   */
  onSendError: (err: unknown, uncertain: UncertainAnchorSend | null) => void;
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

/**
 * One anchor, from the wallet to the audit log. Resolves to "not-sent",
 * "uncertain" (the send failed where it may have been sent; the note is
 * kept) or the network's outcome.
 */
export async function runDocumentAnchorFlow(
  anchor: DocumentAnchor,
  context: { network: Network; signer: string },
  hooks: AnchorFlowHooks,
): Promise<"not-sent" | "uncertain" | SignatureOutcome> {
  const tracker = createAnchorSendTracker();
  let signature: string;
  try {
    const sent = await hooks.send(tracker.track);
    tracker.returned();
    if (typeof sent !== "string" || sent === "") throw new Error("The wallet returned no transaction signature.");
    signature = sent;
  } catch (err) {
    if (!anchorSendMayHaveLanded(tracker.stage)) {
      hooks.onSendError(err, null);
      return "not-sent";
    }
    const uncertain: UncertainAnchorSend = {
      reference: anchor.reference,
      sha256: anchor.sha256,
      network: context.network,
      signer: context.signer,
      signature: tracker.signature,
      at: new Date().toISOString(),
    };
    saveUncertainSend(uncertain);
    hooks.onSendError(err, uncertain);
    return "uncertain";
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
