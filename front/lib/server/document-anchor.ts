// SERVER-ONLY — the document anchors' chain read and audit rows
// (lib/document-anchor.ts; app/api/admin/document-anchor).
//
// The transaction is read from the SERVER RPC (lib/server/rpc.ts: the
// deployment's network, genesis hash checked), finalized first and else
// confirmed; the commitment it was found at is recorded with the row. The
// rows are audit_events with category "operator" and ix_name
// "document_anchor" (no table of their own, no migration); "operator" is a
// server-only category, so /api/audit cannot write one.
import "server-only";

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

/** The transaction at the strongest commitment the server RPC has it at; 503 while it has none. */
export async function fetchAnchorTransaction(
  signature: string,
): Promise<{ tx: ChainTransaction; commitment: AnchorCommitment }> {
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
  throw new SiwsError(503, `${DOCUMENT_ANCHOR_NOT_YET} — try again in a few seconds`);
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
