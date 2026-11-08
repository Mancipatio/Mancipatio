"use client";

// Browser side of investor relations (lib/issuer-updates.ts): the calls of
// the asset page, the portfolio, /issuer/updates and /admin/updates, the
// document upload + attach step, and the anchor of a published update (sent
// by the issuer's wallet, recorded by /api/issuer-updates/anchor, which
// verifies it on chain). An anchor sent but not recorded yet is kept in this
// browser per network and update, so a reload can still record it.

import type { WalletSession } from "@solana/client";
import type { TransactionSigner } from "@solana/kit";
import { signedFetch, type SignedFetchInteractive } from "@/lib/siws-client";
import { signedUpload, sha256HexOfFile } from "@/lib/storage-client";
import { DOCUMENT_ANCHOR_NOT_YET } from "@/lib/document-anchor";
import { anchorSendMayHaveLanded, createAnchorSendTracker, RECORD_RETRY_DELAYS_MS } from "@/lib/document-anchor-client";
import type { Network } from "@/lib/network";
import type { SignatureOutcome } from "@/lib/simulation-gate";
import {
  issuerUpdateUploadPath,
  type AdminIssuerUpdate,
  type HolderIssuerUpdate,
  type IssuerUpdateDraft,
  type IssuerUpdateRecord,
  type PublicIssuerUpdate,
} from "@/lib/issuer-updates";

type Session = WalletSession | null | undefined;

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { cache: "no-store" });
  const json = (await res.json().catch(() => null)) as { ok?: boolean; data?: T; error?: string } | null;
  if (!res.ok || !json || json.ok !== true) throw new Error(json?.error ?? `Request failed (${res.status})`);
  return json.data as T;
}

// ── Readers ─────────────────────────────────────────────────────────────────

export type PublicUpdatesAnswer = { updates: PublicIssuerUpdate[]; holders_only: number };

/** The published public updates of an asset (and its issuer's issuer-wide ones); no wallet needed. */
export function loadPublicIssuerUpdates(issuer: string, asset: string): Promise<PublicUpdatesAnswer> {
  const query = new URLSearchParams({ issuer, asset });
  return getJson<PublicUpdatesAnswer>(`/api/issuer-updates/public?${query}`);
}

/** The link of a public update's document (the route redirects to a short-lived URL). */
export function publicDocumentHref(documentId: string): string {
  return `/api/issuer-updates/document?id=${encodeURIComponent(documentId)}`;
}

export type HolderUpdatesAnswer = { holder_assets: string[]; updates: HolderIssuerUpdate[] };

/** Published updates (holders-only included) of the named assets the wallet holds; the server checks the balances on chain. */
export function loadHolderIssuerUpdates(session: Session, assets: string[], interactive: SignedFetchInteractive): Promise<HolderUpdatesAnswer> {
  return signedFetch<HolderUpdatesAnswer>(session, "/api/issuer-updates/holder", "issuerUpdates.holderRead", { assets }, { interactive });
}

/**
 * Opens one attachment in a new tab through a URL signed for this wallet:
 * `asset` is the held asset that qualifies a holder (via_asset), left out for
 * the issuer's and the admin's own reads.
 */
export async function openIssuerUpdateDocument(session: Session, documentId: string, asset?: string | null): Promise<void> {
  const data = await signedFetch<{ url: string }>(session, "/api/issuer-updates/document-url", "issuerUpdates.documentUrl", {
    id: documentId,
    ...(asset ? { asset } : {}),
  });
  window.open(data.url, "_blank", "noopener,noreferrer");
}

// ── The issuer ──────────────────────────────────────────────────────────────

export function loadMyIssuerUpdates(session: Session, issuer: string, interactive: SignedFetchInteractive): Promise<IssuerUpdateRecord[]> {
  return signedFetch<{ updates: IssuerUpdateRecord[] }>(session, "/api/issuer-updates/mine", "issuerUpdates.mine", { issuer }, { interactive })
    .then((data) => data.updates);
}

export async function saveIssuerUpdate(
  session: Session,
  input: { issuer: string; update: IssuerUpdateDraft; id: string | null; expectedUpdatedAt: string | null },
): Promise<IssuerUpdateRecord> {
  const data = await signedFetch<{ update: IssuerUpdateRecord }>(session, "/api/issuer-updates/save", "issuerUpdates.save", {
    issuer: input.issuer,
    update: input.update,
    ...(input.id ? { id: input.id, expected_updated_at: input.expectedUpdatedAt } : {}),
  });
  return data.update;
}

export async function discardIssuerUpdate(session: Session, record: Pick<IssuerUpdateRecord, "id" | "updated_at">): Promise<void> {
  await signedFetch(session, "/api/issuer-updates/discard", "issuerUpdates.discard", { id: record.id, expected_updated_at: record.updated_at });
}

export async function publishIssuerUpdate(session: Session, record: Pick<IssuerUpdateRecord, "id" | "updated_at">): Promise<IssuerUpdateRecord> {
  const data = await signedFetch<{ update: IssuerUpdateRecord }>(session, "/api/issuer-updates/publish", "issuerUpdates.publish", {
    id: record.id,
    expected_updated_at: record.updated_at,
  });
  return data.update;
}

export async function withdrawIssuerUpdate(session: Session, id: string, reason: string): Promise<IssuerUpdateRecord> {
  const data = await signedFetch<{ update: IssuerUpdateRecord }>(session, "/api/issuer-updates/withdraw", "issuerUpdates.withdraw", { id, reason });
  return data.update;
}

/**
 * Uploads `file` for the issuer (signed authorization, direct upload, server
 * verification of the stored bytes: lib/storage-client signedUpload) and
 * attaches the verified version to the draft. Three wallet signatures.
 */
export async function attachIssuerUpdateDocument(
  session: Session,
  input: { issuer: string; updateId: string; file: File },
): Promise<IssuerUpdateRecord> {
  const sha256 = await sha256HexOfFile(input.file);
  const uploaded = await signedUpload(session, { path: issuerUpdateUploadPath(input.issuer, sha256, input.file.name), file: input.file, sha256 });
  const data = await signedFetch<{ update: IssuerUpdateRecord }>(session, "/api/issuer-updates/attach", "issuerUpdates.attach", {
    id: input.updateId,
    path: uploaded.path,
    sha256: uploaded.sha256,
    file_name: input.file.name,
  });
  return data.update;
}

export async function detachIssuerUpdateDocument(session: Session, documentId: string): Promise<IssuerUpdateRecord> {
  const data = await signedFetch<{ update: IssuerUpdateRecord }>(session, "/api/issuer-updates/detach", "issuerUpdates.detach", { id: documentId });
  return data.update;
}

// ── The anchor ──────────────────────────────────────────────────────────────

export type PendingUpdateAnchor = { signature: string; signer: string; at: string };

const PENDING_PREFIX = "manci:issuer-update-anchor:v1";
const BASE58_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const pendingKey = (network: Network, id: string) => `${PENDING_PREFIX}:${network}:${id}`;

/** The anchor this browser sent for the update and has not recorded yet, or null. */
export function readPendingUpdateAnchor(network: Network, id: string): PendingUpdateAnchor | null {
  try {
    const value = JSON.parse(window.localStorage.getItem(pendingKey(network, id)) ?? "null") as Partial<PendingUpdateAnchor> | null;
    if (value && typeof value.signature === "string" && BASE58_SIGNATURE.test(value.signature) &&
        typeof value.signer === "string" && typeof value.at === "string") return value as PendingUpdateAnchor;
  } catch {
    // Blocked storage or a damaged entry: nothing pending.
  }
  return null;
}

function savePendingUpdateAnchor(network: Network, id: string, pending: PendingUpdateAnchor): void {
  try {
    window.localStorage.setItem(pendingKey(network, id), JSON.stringify(pending));
  } catch {
    // Storage may be blocked; the page still shows the signature.
  }
}

export function clearPendingUpdateAnchor(network: Network, id: string): void {
  try {
    window.localStorage.removeItem(pendingKey(network, id));
  } catch {
    // Nothing to forget.
  }
}

/**
 * Records the anchor, waiting and posting again while the server's node does
 * not show the transaction as finalized yet; any other refusal is thrown at
 * once. A session action: no wallet prompt per attempt.
 */
export async function recordIssuerUpdateAnchor(
  session: Session,
  id: string,
  signature: string,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<IssuerUpdateRecord> {
  for (let attempt = 0; ; attempt++) {
    try {
      const data = await signedFetch<{ update: IssuerUpdateRecord }>(session, "/api/issuer-updates/anchor", "issuerUpdates.anchor", { id, signature });
      return data.update;
    } catch (err) {
      const notYet = err instanceof Error && err.message.startsWith(DOCUMENT_ANCHOR_NOT_YET);
      if (!notYet || attempt >= RECORD_RETRY_DELAYS_MS.length) throw err;
      await sleep(RECORD_RETRY_DELAYS_MS[attempt]);
    }
  }
}

export type UpdateAnchorSend = {
  /** Builds and sends the memo transaction with `track(<the wallet's signer>)` as memo signer and fee payer; resolves to its signature. */
  send: (track: (signer: TransactionSigner) => TransactionSigner) => Promise<unknown>;
  /** Waits for the network's answer (lib/simulation-gate waitForSignature). */
  wait: (signature: string) => Promise<SignatureOutcome>;
};

/**
 * One anchor from the wallet to the record. The signature is kept in this
 * browser as soon as the wallet hands it back (also when the send fails
 * after that point: createAnchorSendTracker says how far it got), so the
 * page can record it later; it is forgotten once recorded. Resolves to the
 * recorded update; throws when nothing was recorded (the pending signature,
 * if any, stays for "Record it").
 */
export async function anchorIssuerUpdate(
  session: Session,
  context: { network: Network; signer: string; id: string },
  hooks: UpdateAnchorSend,
): Promise<IssuerUpdateRecord> {
  const tracker = createAnchorSendTracker();
  let signature: string;
  try {
    const sent = await hooks.send(tracker.track);
    tracker.returned();
    if (typeof sent !== "string" || sent === "") throw new Error("The wallet returned no transaction signature.");
    signature = sent;
  } catch (err) {
    if (anchorSendMayHaveLanded(tracker.stage) && tracker.signature) {
      savePendingUpdateAnchor(context.network, context.id, { signature: tracker.signature, signer: context.signer, at: new Date().toISOString() });
    }
    throw err;
  }
  savePendingUpdateAnchor(context.network, context.id, { signature, signer: context.signer, at: new Date().toISOString() });
  const outcome = await hooks.wait(signature);
  if (outcome === "failed") {
    clearPendingUpdateAnchor(context.network, context.id);
    throw new Error("The network refused the anchor transaction. Nothing was anchored.");
  }
  if (outcome !== "confirmed") {
    throw new Error("The network has not confirmed the anchor yet. Check the explorer, then record it from this page. Do not send it again.");
  }
  const update = await recordIssuerUpdateAnchor(session, context.id, signature);
  clearPendingUpdateAnchor(context.network, context.id);
  return update;
}

// ── Admin ───────────────────────────────────────────────────────────────────

export function loadAdminIssuerUpdates(
  session: Session,
  status: "published" | "withdrawn" | "all",
  interactive: SignedFetchInteractive,
): Promise<AdminIssuerUpdate[]> {
  return signedFetch<{ updates: AdminIssuerUpdate[] }>(session, "/api/issuer-updates/admin-list", "issuerUpdates.adminList", { status }, { interactive })
    .then((data) => data.updates);
}
