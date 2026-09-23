// SERVER-ONLY — server-attributed audit events.
//
// /api/audit (recordAudit) is unsigned by design, so every row it writes is
// stamped metadata.actor_verified=false / actor_source="client-unsigned". The
// rows written HERE come from route handlers that already verified the actor
// (SIWS signature, wallet session cookie, on-chain admin gate), so they carry
// metadata.actor_verified=true plus the concrete actor_source. The server
// stamps are applied last: caller metadata can never override them.
//
// Categories in SERVER_ONLY_AUDIT_CATEGORIES (currently "kyc", shown as "KYC &
// privacy") are refused by the unsigned /api/audit route, so a "kyc" row in
// audit_events is always a server-attributed one — "who viewed which KYC
// document" cannot be forged by anyone holding only the public site. Rows
// about a dossier target its client id (kyc_document_view, kyc_data_export,
// client_anonymize); confidential repository files target "document:<id>"
// (confidential_document_view).
//
// writeServerAudit THROWS SiwsError(503) when the insert fails. Callers that
// promise "access is logged" (doc-url, export) must let it propagate and hand
// out nothing; best-effort callers catch it.

import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { AuditCategory, AuditStatus } from "@/lib/supabase";
import { SiwsError } from "@/lib/server/siws-error";
import { detectNetwork } from "@/lib/network";

/** Categories only the server may write (refused by the unsigned /api/audit). */
export const SERVER_ONLY_AUDIT_CATEGORIES: ReadonlySet<string> = new Set<AuditCategory>(["kyc"]);

/** How the route proved who the actor is. */
export type AuditActorSource =
  /** A fresh SIWS wallet signature over this exact request. */
  | "siws-signature"
  /** The wallet session cookie (read actions only, lib/siws-session.ts). */
  | "siws-session"
  /** SIWS-verified; the route did not say which of the two. */
  | "siws";

export type ServerAuditInput = {
  ix_name: string;
  category: AuditCategory;
  actor_wallet: string;
  actor_source: AuditActorSource;
  reason: string;
  target_label?: string | null;
  tx_signature?: string | null;
  status?: AuditStatus;
  metadata?: Record<string, unknown>;
};

/** Maps verifySigned's `via` onto the audit actor source. */
export function actorSourceOf(via: "signature" | "session" | undefined): AuditActorSource {
  return via === "session" ? "siws-session" : via === "signature" ? "siws-signature" : "siws";
}

/**
 * Append one server-attributed row to audit_events and return its id.
 * THROWS SiwsError(503) when the row could not be written.
 */
export async function writeServerAudit(
  sb: SupabaseClient,
  input: ServerAuditInput,
): Promise<string> {
  const metadata = {
    ...(input.metadata ?? {}),
    server_received_at: new Date().toISOString(),
    actor_verified: true,
    actor_source: input.actor_source,
  };
  let row: { id?: unknown } | null = null;
  try {
    const { data, error } = await sb
      .from("audit_events")
      .insert({
        network: detectNetwork(),
        ix_name: input.ix_name,
        category: input.category,
        actor_wallet: input.actor_wallet,
        target_label: input.target_label ?? null,
        tx_signature: input.tx_signature ?? null,
        reason: input.reason,
        status: input.status ?? "success",
        metadata,
      })
      .select("id")
      .single();
    if (error) {
      console.error("[audit] server audit insert failed:", error.message);
    } else {
      row = data as { id?: unknown } | null;
    }
  } catch (err) {
    console.error(
      "[audit] server audit insert threw:",
      err instanceof Error ? err.message : String(err),
    );
  }
  if (!row || typeof row.id !== "string") {
    throw new SiwsError(503, "Audit log unavailable — nothing was released; try again");
  }
  return row.id;
}
