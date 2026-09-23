// POST /api/audit — server-side audit-event ledger insert.
//
// Deliberately UNSIGNED: recordAudit() is a fire-and-forget breadcrumb called
// from ~73 client call sites (often right after a wallet tx, where prompting
// for a second signature would be hostile UX). The win over the old direct
// anon-key insert is that the write now goes through the service role with
// strict shape validation, so the anon INSERT policy on audit_events can be
// dropped (W3-RLS). The endpoint only appends rows of a fixed shape — it can
// be spammed, but not used to read, mutate, or write arbitrary columns.
//
// The server receipt time is stamped into metadata.server_received_at (the
// audit_events table has no such column and this agent owns no migration
// number — a real column can be added later without breaking anything).
//
// IMPORTANT — actor_wallet is SELF-ASSERTED. This route is unsigned by design
// (recordAudit is a zero-ripple fire-and-forget breadcrumb), so it does NOT
// prove that actor_wallet signed anything. Every row is therefore stamped
// metadata.actor_verified=false / actor_source="client-unsigned" so a forged
// row can never masquerade as a cryptographically attributed event. The only
// trustworthy attribution anchor is tx_signature, which is independently
// checkable on-chain. Full remediation (a signed/authenticated actor binding,
// or a separate verified ledger) is a larger change the P1 design deferred to
// keep recordAudit callable from ~73 sites without a wallet signature.

import { NextResponse } from "next/server";
import { SiwsError, siwsErrorResponse } from "@/lib/server/siws";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";
import { SERVER_ONLY_AUDIT_CATEGORIES } from "@/lib/server/audit";

const CATEGORIES = new Set([
  "platform",
  "admins",
  "issuers",
  "assets",
  "share-class",
  "launchpad",
  "custody",
  "otc",
  "governance",
  "rights",
  "other",
]);

const STATUSES = new Set(["success", "failed", "pending"]);

/** Max serialized metadata size — larger blobs are replaced, not rejected
 *  (an oversized metadata field must never cost us the audit row itself). */
const METADATA_MAX_CHARS = 20_000;

function str(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (s.length === 0 || s.length > max) return null;
  return s;
}

function optStr(v: unknown, max: number): string | null {
  if (v === undefined || v === null) return null;
  return str(v, max);
}

export async function POST(request: Request) {
  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new SiwsError(400, "Invalid JSON body");
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new SiwsError(400, "Invalid request body");
    }
    const b = body as Record<string, unknown>;

    const ixName = str(b.ix_name, 120);
    if (!ixName) throw new SiwsError(400, "ix_name required (≤120 chars)");

    const category = typeof b.category === "string" ? b.category : "";
    // "kyc" rows (KYC document views, data exports, erasures) are written only
    // by the routes that perform them, with a verified actor. Refusing the
    // category here keeps every "kyc" row in the ledger server-attributed.
    if (SERVER_ONLY_AUDIT_CATEGORIES.has(category)) {
      throw new SiwsError(400, "This audit category is recorded by the server only");
    }
    if (!CATEGORIES.has(category)) {
      throw new SiwsError(400, "Unknown audit category");
    }

    const actorWallet = str(b.actor_wallet, 64);
    if (!actorWallet) {
      throw new SiwsError(400, "actor_wallet required (≤64 chars)");
    }

    // reason may legitimately be empty ("" is used by some call sites).
    const reason =
      typeof b.reason === "string" ? b.reason.slice(0, 2000) : null;
    if (reason === null) throw new SiwsError(400, "reason must be a string");

    const status =
      b.status === undefined || b.status === null
        ? "success"
        : typeof b.status === "string" && STATUSES.has(b.status)
          ? b.status
          : null;
    if (status === null) throw new SiwsError(400, "Invalid status");

    const targetLabel = optStr(b.target_label, 300);
    const txSignature = optStr(b.tx_signature, 120);

    let metadata: Record<string, unknown> =
      typeof b.metadata === "object" &&
      b.metadata !== null &&
      !Array.isArray(b.metadata)
        ? (b.metadata as Record<string, unknown>)
        : {};
    try {
      if (JSON.stringify(metadata).length > METADATA_MAX_CHARS) {
        metadata = { note: "metadata dropped — exceeded size limit" };
      }
    } catch {
      metadata = { note: "metadata dropped — not serializable" };
    }
    // Server receipt timestamp — see module doc. actor_verified=false records
    // that actor_wallet is SELF-ASSERTED (this route is unsigned), so a forged
    // row can never masquerade in the ledger as a cryptographically attributed
    // event. The trustworthy attribution anchor is tx_signature (on-chain).
    metadata = {
      ...metadata,
      server_received_at: new Date().toISOString(),
      actor_verified: false,
      actor_source: "client-unsigned",
    };

    const sb = getSupabaseAdmin();
    const { data, error } = await sb
      .from("audit_events")
      .insert({
        network: detectNetwork(),
        ix_name: ixName,
        category,
        actor_wallet: actorWallet,
        target_label: targetLabel,
        tx_signature: txSignature,
        reason,
        status,
        metadata,
      })
      .select("id")
      .single();
    if (error) {
      console.error("[api/audit] insert failed:", error.message);
      throw new SiwsError(500, "Audit write failed");
    }

    return NextResponse.json({ ok: true, data: { id: data?.id ?? null } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
