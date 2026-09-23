// POST /api/clients/anonymize — Super Admin erases the personal data of ONE
// dossier (GDPR erasure) while keeping the records the platform must keep.
// Signed with a fresh wallet signature + requireSuperAdmin. Action:
// "clients.anonymize". Params: { client_id, confirm, reason } where `confirm`
// must be exactly anonymizeConfirmationPhrase(client_id) ("ANONYMIZE 1a2b3c4d").
// Client half: lib/clients.ts adminAnonymizeClient().
//
// Order (each step only runs when the previous one succeeded):
//   1. preflight: anonymize_client(..., p_dry_run => true) runs every check of
//      the real erasure and changes nothing — dossier exists on this network
//      (404), no conversion / delivery request of it is still in flight (409),
//      migration 0065 applied (503). Nothing is touched before it says ready;
//   2. audit row "client_anonymize" status=pending — nothing is destroyed
//      without it (503 when it cannot be written);
//   3. the stored identity files are deleted from the private
//      client-documents bucket: every path a client_documents row points to
//      plus everything under clients/<id>/ (files whose row was never
//      written). A failed delete stops here with the database untouched;
//   4. public.anonymize_client() (migration 0065) erases the database side in
//      one transaction — see that migration for exactly what is erased and
//      what is kept. The clients row is updated, never deleted, so nothing
//      cascades;
//   5. files uploaded between steps 3 and 4 (returned by the function) are
//      deleted too;
//   6. audit row status=success with the counts (best effort — the pending
//      row and clients.anonymized_at already record that it happened).
//
// Not reversible. Run it only once the retention period of the records
// involved has ended or no retention duty applies (see the admin page copy).

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireSuperAdmin } from "@/lib/server/admin-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { actorSourceOf, writeServerAudit, type AuditActorSource } from "@/lib/server/audit";
import { detectNetwork } from "@/lib/network";
import {
  anonymizeConfirmationPhrase,
  isAnonymizeConfirmation,
  type AnonymizeCounts,
  type AnonymizeResult,
} from "@/lib/client-privacy";
import { assertUuid, fetchClientOr404, reqString } from "../_helpers";
import { listClientObjects, removeObjects } from "../_privacy";

// anonymize_client() missing: migration 0065 not applied yet.
const MISSING_FUNCTION = new Set(["PGRST202", "42883"]);

type Rpc = { data: unknown; error: { code?: string; message?: string } | null };

/** Maps a refusal of anonymize_client() onto the route's answer. */
function refusal(status: string | undefined): SiwsError | null {
  if (status === "not_found") return new SiwsError(404, "Client not found");
  if (status === "active_requests") {
    return new SiwsError(
      409,
      "This client has an open conversion or delivery request — finish or cancel it before erasing the dossier.",
    );
  }
  return null;
}

type RpcResult = {
  status?: string;
  anonymized_at?: string;
  storage_paths?: unknown;
  previous?: Record<string, unknown>;
  counts?: AnonymizeCounts;
};

async function auditFailure(
  sb: ReturnType<typeof getSupabaseAdmin>,
  wallet: string,
  source: AuditActorSource,
  clientId: string,
  step: string,
): Promise<void> {
  try {
    await writeServerAudit(sb, {
      ix_name: "client_anonymize",
      category: "kyc",
      actor_wallet: wallet,
      actor_source: source,
      reason: `Anonymization stopped at: ${step}`,
      target_label: clientId,
      status: "failed",
      metadata: { client_id: clientId, actor_wallet: wallet, step },
    });
  } catch {
    // The pending row already records the attempt.
  }
}

export async function POST(request: Request) {
  try {
    const { wallet, params, via } = await verifySigned(request, "clients.anonymize");
    await requireSuperAdmin(wallet);

    const clientId = assertUuid(params.client_id, "client_id");
    if (!isAnonymizeConfirmation(clientId, params.confirm)) {
      throw new SiwsError(400, `Type "${anonymizeConfirmationPhrase(clientId)}" to confirm`);
    }
    const reason = reqString(params, "reason", 1000);
    if (reason.length < 4) throw new SiwsError(400, "reason must be at least 4 characters");

    const sb = getSupabaseAdmin();
    const network = detectNetwork();
    const source = actorSourceOf(via);

    // 1. Preflight: the same checks as the erasure, nothing changed.
    const client = await fetchClientOr404(sb, clientId);
    const args = { p_client_id: clientId, p_network: network, p_actor: wallet };
    const dry = (await sb.rpc("anonymize_client", { ...args, p_dry_run: true })) as Rpc;
    if (dry.error) {
      if (dry.error.code && MISSING_FUNCTION.has(dry.error.code)) {
        throw new SiwsError(503, "Anonymization is not installed yet (migration 0065) — nothing was changed");
      }
      console.error("[api/clients/anonymize] preflight failed:", dry.error.code ?? dry.error.message);
      throw new SiwsError(500, "Could not check the dossier — nothing was changed; try again");
    }
    const dryStatus = (dry.data as { status?: string } | null)?.status;
    const refused = refusal(dryStatus);
    if (refused) throw refused;
    if (dryStatus !== "ready") throw new SiwsError(500, "Unexpected answer from the database — nothing was changed");

    // 2. Intent is on record before anything is destroyed.
    await writeServerAudit(sb, {
      ix_name: "client_anonymize",
      category: "kyc",
      actor_wallet: wallet,
      actor_source: source,
      reason,
      target_label: clientId,
      status: "pending",
      metadata: {
        client_id: clientId,
        actor_wallet: wallet,
        previously_anonymized_at: client.anonymized_at ?? null,
      },
    });

    // 3. Files first: the database rows are the only map to them.
    const { data: docs, error: docsError } = await sb
      .from("client_documents")
      .select("storage_path")
      .eq("client_id", clientId);
    if (docsError) {
      await auditFailure(sb, wallet, source, clientId, "document list");
      throw new SiwsError(500, "Could not read the dossier's documents — nothing was erased; try again");
    }
    const rowPaths = (docs ?? [])
      .map((d) => (d as { storage_path?: unknown }).storage_path)
      .filter((p): p is string => typeof p === "string" && p.length > 0);
    let removed: Set<string>;
    let attempted: Set<string>;
    try {
      const stored = await listClientObjects(sb, clientId);
      attempted = new Set([...rowPaths, ...stored]);
      removed = await removeObjects(sb, [...attempted]);
    } catch (err) {
      await auditFailure(sb, wallet, source, clientId, "file deletion");
      if (err instanceof SiwsError) {
        throw new SiwsError(err.status, `${err.message} — the database was not changed; try again`);
      }
      throw err;
    }

    // 4. Database erasure, one transaction.
    const { data, error } = (await sb.rpc("anonymize_client", { ...args, p_dry_run: false })) as Rpc;
    if (error) {
      await auditFailure(sb, wallet, source, clientId, "database erasure");
      console.error("[api/clients/anonymize] anonymize_client failed:", error.code ?? error.message);
      throw new SiwsError(500, "Erasing the database records failed — the files were deleted; run it again to finish");
    }
    const result = (data ?? {}) as RpcResult;
    const lateRefusal = refusal(result.status);
    if (lateRefusal) {
      // A request opened between the preflight and now; files are gone, the
      // rows are not. Finishing that request and re-running completes it.
      await auditFailure(sb, wallet, source, clientId, `database refused: ${result.status}`);
      throw lateRefusal;
    }
    if (result.status !== "anonymized" || !result.counts || typeof result.anonymized_at !== "string") {
      await auditFailure(sb, wallet, source, clientId, "unexpected database answer");
      throw new SiwsError(500, "Unexpected answer from the database — check the dossier");
    }

    // 5. Files uploaded while step 3 ran.
    const returnedPaths = Array.isArray(result.storage_paths)
      ? result.storage_paths.filter((p): p is string => typeof p === "string")
      : [];
    const late = returnedPaths.filter((p) => !attempted.has(p));
    let leftBehind: string[] = [];
    if (late.length > 0) {
      try {
        for (const p of await removeObjects(sb, late)) removed.add(p);
      } catch {
        leftBehind = late;
        console.error(`[api/clients/anonymize] ${late.length} late file(s) of ${clientId} could not be deleted`);
      }
    }
    const filesLeft = leftBehind.length;
    // Document rows whose file was not in the private bucket (legacy objects
    // in the old public bucket, or already gone) — ops must check those.
    const filesMissing = [...new Set([...rowPaths, ...returnedPaths])].filter(
      (p) => !removed.has(p) && !leftBehind.includes(p),
    ).length;

    // 6. Completion record.
    let auditComplete = true;
    try {
      await writeServerAudit(sb, {
        ix_name: "client_anonymize",
        category: "kyc",
        actor_wallet: wallet,
        actor_source: source,
        reason,
        target_label: clientId,
        metadata: {
          client_id: clientId,
          actor_wallet: wallet,
          anonymized_at: result.anonymized_at,
          previous: result.previous ?? null,
          counts: result.counts,
          files_deleted: removed.size,
          files_missing: filesMissing,
          files_left: filesLeft,
        },
      });
    } catch {
      auditComplete = false;
    }

    const body: AnonymizeResult = {
      anonymized_at: result.anonymized_at,
      counts: result.counts,
      files_deleted: removed.size,
      files_missing: filesMissing,
      files_left: filesLeft,
      audit_complete: auditComplete,
    };
    return NextResponse.json({ ok: true, data: body }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
