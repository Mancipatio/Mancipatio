// SERVER-ONLY — the document anchors' chain read and audit rows
// (lib/document-anchor.ts; app/api/admin/document-anchor).
//
// The transaction is read from the SERVER RPC (lib/server/rpc.ts: the
// deployment's network, genesis hash checked), finalized first and else
// confirmed; the route records only a finalized one (a confirmed one is
// checked at once, so a wrong anchor is refused without waiting, and answered
// "not yet"). The rows are audit_events with category "operator" and ix_name
// "document_anchor" (no table of their own, no migration); "operator" is a
// server-only category, so /api/audit cannot write one. Each row's id is
// derived from the network and the signature (documentAnchorAuditId), so the
// table's primary key keeps one row per anchor even when two instances
// record the same signature at once.
//
// A row counts as a recorded anchor only by isRecordedAnchorRow: that id,
// with the category, ix_name, status "success" and commitment "finalized"
// the record route writes. The category alone would do today (no other
// writer of "operator" exists, anon has no INSERT on audit_events), but the
// id is what only the record route can produce: a later server writer of
// "operator", or a devnet row from the early open anon insert policy, never
// passes for an anchor. The anchor list, the record route's duplicate check
// and /api/audit/list (anchor_verified, the admin audit page's "Verified on
// chain" label) all use it.
import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { signature as toSignature } from "@solana/kit";
import type { ChainTransaction } from "@/lib/chain-evidence";
import { DOCUMENT_ANCHOR_AUDIT } from "@/lib/document-anchor-audit";
import {
  DOCUMENT_ANCHOR_LIST_LIMIT,
  DOCUMENT_ANCHOR_NOT_YET,
  documentAnchorRecordFromRow,
  type DocumentAnchorRecord,
} from "@/lib/document-anchor";
import { uuidV8FromSha256 } from "@/lib/server/derived-uuid";
import { getServerRpc } from "@/lib/server/rpc";
import { SiwsError } from "@/lib/server/siws-error";

export type AnchorCommitment = "finalized" | "confirmed";

const ROW_COLUMNS = "id,created_at,category,ix_name,actor_wallet,tx_signature,status,metadata";
const READ_TIMEOUT_MS = 12_000;

/**
 * The transaction at the strongest commitment the server RPC has it at
 * (finalized, else confirmed), or null while it has neither. 503 when the
 * RPC cannot be read. Each read waits at most READ_TIMEOUT_MS (the record
 * route allows itself maxDuration = 60 s for the two).
 */
export async function readAnchorTransaction(
  signature: string,
): Promise<{ tx: ChainTransaction; commitment: AnchorCommitment } | null> {
  const rpc = getServerRpc();
  for (const commitment of ["finalized", "confirmed"] as const) {
    let tx: unknown;
    try {
      tx = await rpc
        .getTransaction(toSignature(signature), { commitment, encoding: "json", maxSupportedTransactionVersion: 0 })
        .send({ abortSignal: AbortSignal.timeout(READ_TIMEOUT_MS) });
    } catch {
      throw new SiwsError(503, "Transaction verification unavailable — try again");
    }
    if (tx) return { tx: tx as ChainTransaction, commitment };
  }
  return null;
}

/** The 503 the page retries on (DOCUMENT_ANCHOR_NOT_YET): `confirmed` when the node already shows it as confirmed. */
export function anchorNotYetError(confirmed: boolean): SiwsError {
  return new SiwsError(
    503,
    confirmed
      ? `${DOCUMENT_ANCHOR_NOT_YET} (it is confirmed; finalization takes about 13 seconds) — try again in a few seconds`
      : `${DOCUMENT_ANCHOR_NOT_YET} — try again in a few seconds`,
  );
}

/**
 * The audit row id of the anchor `signature` on `network`: a uuid made from
 * SHA-256("mancipatio:document_anchor:<network>:<signature>") (version 8,
 * RFC 9562 variant; lib/server/derived-uuid). The same anchor always gets
 * the same id, so the primary key refuses a second row for it.
 */
export function documentAnchorAuditId(network: string, signature: string): string {
  return uuidV8FromSha256(`mancipatio:document_anchor:${network}:${signature}`);
}

/** An audit_events row as read (every field optional: a reader selects what it needs). */
export type AnchorRowLike = {
  id?: unknown;
  created_at?: unknown;
  category?: unknown;
  ix_name?: unknown;
  actor_wallet?: unknown;
  tx_signature?: unknown;
  status?: unknown;
  metadata?: unknown;
};

/**
 * Whether `row` is a document anchor the record route wrote on `network`:
 * category "operator", ix_name "document_anchor", status "success",
 * metadata.commitment "finalized", and its id documentAnchorAuditId(network,
 * its signature), which only that route writes (/api/audit never sends an
 * id, so the database draws one for every row it writes).
 */
export function isRecordedAnchorRow(network: string, row: AnchorRowLike): boolean {
  if (row.category !== DOCUMENT_ANCHOR_AUDIT.category || row.ix_name !== DOCUMENT_ANCHOR_AUDIT.ixName) return false;
  if (row.status !== "success") return false;
  if (typeof row.tx_signature !== "string" || row.tx_signature.length === 0) return false;
  const metadata = row.metadata;
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return false;
  if ((metadata as Record<string, unknown>).commitment !== "finalized") return false;
  return typeof row.id === "string" && row.id.toLowerCase() === documentAnchorAuditId(network, row.tx_signature);
}

function anchorRows(sb: SupabaseClient, network: string) {
  return sb
    .from("audit_events")
    .select(ROW_COLUMNS)
    .eq("network", network)
    .eq("category", DOCUMENT_ANCHOR_AUDIT.category)
    .eq("ix_name", DOCUMENT_ANCHOR_AUDIT.ixName);
}

/** The view of `row` when it is a complete anchor the record route wrote on `network`, else null. */
function recordOf(network: string, row: AnchorRowLike): DocumentAnchorRecord | null {
  return isRecordedAnchorRow(network, row) ? documentAnchorRecordFromRow(row) : null;
}

/**
 * The recorded anchor of `signature` on `network`, or null. It is looked up
 * by its derived id, so no other row with that signature can stand in for
 * it. 503 when the log cannot be read.
 */
export async function findAnchorRecord(sb: SupabaseClient, network: string, signature: string): Promise<DocumentAnchorRecord | null> {
  const { data, error } = await anchorRows(sb, network)
    .eq("id", documentAnchorAuditId(network, signature))
    .eq("tx_signature", signature)
    .limit(1);
  if (error) throw new SiwsError(503, "Audit log unavailable — try again");
  const row = ((data ?? []) as AnchorRowLike[])[0];
  return row ? recordOf(network, row) : null;
}

/** The newest recorded anchors on `network` (rows that are not complete anchors of the record route are left out). */
export async function listAnchorRecords(sb: SupabaseClient, network: string): Promise<DocumentAnchorRecord[]> {
  const { data, error } = await anchorRows(sb, network)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(DOCUMENT_ANCHOR_LIST_LIMIT);
  if (error) throw new SiwsError(503, "Audit log unavailable — try again");
  return ((data ?? []) as AnchorRowLike[]).flatMap((row) => {
    const record = recordOf(network, row);
    return record ? [record] : [];
  });
}
