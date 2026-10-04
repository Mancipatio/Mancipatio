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
import "server-only";

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { signature as toSignature } from "@solana/kit";
import type { ChainTransaction } from "@/lib/chain-evidence";
import {
  DOCUMENT_ANCHOR_AUDIT,
  DOCUMENT_ANCHOR_LIST_LIMIT,
  DOCUMENT_ANCHOR_NOT_YET,
  documentAnchorRecordFromRow,
  type DocumentAnchorRecord,
} from "@/lib/document-anchor";
import { getServerRpc } from "@/lib/server/rpc";
import { SiwsError } from "@/lib/server/siws-error";

export type AnchorCommitment = "finalized" | "confirmed";

const ROW_COLUMNS = "id,created_at,actor_wallet,tx_signature,metadata";
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
      ? `${DOCUMENT_ANCHOR_NOT_YET} (it is confirmed; finalization takes about 15 seconds) — try again in a few seconds`
      : `${DOCUMENT_ANCHOR_NOT_YET} — try again in a few seconds`,
  );
}

/**
 * The audit row id of the anchor `signature` on `network`: a uuid made from
 * SHA-256("mancipatio:document_anchor:<network>:<signature>") (version 8,
 * RFC 9562 variant). The same anchor always gets the same id, so the primary
 * key refuses a second row for it.
 */
export function documentAnchorAuditId(network: string, signature: string): string {
  const bytes = createHash("sha256").update(`mancipatio:document_anchor:${network}:${signature}`, "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

type Row = { id?: unknown; created_at?: unknown; actor_wallet?: unknown; tx_signature?: unknown; metadata?: unknown };

function anchorRows(sb: SupabaseClient, network: string) {
  return sb
    .from("audit_events")
    .select(ROW_COLUMNS)
    .eq("network", network)
    .eq("category", DOCUMENT_ANCHOR_AUDIT.category)
    .eq("ix_name", DOCUMENT_ANCHOR_AUDIT.ixName);
}

/** The recorded anchor of `signature` on `network`, or null. 503 when the log cannot be read. */
export async function findAnchorRecord(sb: SupabaseClient, network: string, signature: string): Promise<DocumentAnchorRecord | null> {
  const { data, error } = await anchorRows(sb, network).eq("tx_signature", signature).limit(1);
  if (error) throw new SiwsError(503, "Audit log unavailable — try again");
  const row = ((data ?? []) as Row[])[0];
  return row ? documentAnchorRecordFromRow(row) : null;
}

/** The newest recorded anchors on `network` (rows that are not complete anchors are left out). */
export async function listAnchorRecords(sb: SupabaseClient, network: string): Promise<DocumentAnchorRecord[]> {
  const { data, error } = await anchorRows(sb, network)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(DOCUMENT_ANCHOR_LIST_LIMIT);
  if (error) throw new SiwsError(503, "Audit log unavailable — try again");
  return ((data ?? []) as Row[]).flatMap((row) => {
    const record = documentAnchorRecordFromRow(row);
    return record ? [record] : [];
  });
}
