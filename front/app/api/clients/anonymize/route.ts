// POST /api/clients/anonymize — Super Admin erases the personal data of ONE
// dossier (GDPR erasure) while keeping the records the platform must keep.
// Signed with a fresh wallet signature + requireSuperAdmin. Action:
// "clients.anonymize". Params: { client_id, confirm, reason } where `confirm`
// must be exactly anonymizeConfirmationPhrase(client_id) ("ANONYMIZE 1a2b3c4d").
// Client half: lib/clients.ts adminAnonymizeClient().
//
// Order (each step only runs when the previous one succeeded):
//   1. preflight, nothing changed:
//      a. anonymize_client(..., p_dry_run => true) runs every check of the
//         real erasure — dossier exists on this network (404), no conversion /
//         delivery request of it is still in flight (409), migration 0065
//         applied (503);
//      b. the dossier's wallet holds no live on-chain passport (409; 503 when
//         the chain cannot be read — lib/server/passport-state.ts). The
//         passport is revoked first, so the chain never vouches for an
//         identity the platform no longer holds;
//   2. audit row "client_anonymize" status=pending — nothing is destroyed
//      without it (503 when it cannot be written);
//   3. the stored identity files are deleted:
//      a. private client-documents bucket: every path a client_documents row
//         points to plus everything under clients/<id>/ (files whose row was
//         never written);
//      b. legacy public `documents` bucket (pre-P1 uploads, same path):
//         every row path that was not in the private bucket plus everything
//         under clients/<id>/ there — never a path in a document-repository
//         folder (reported for review instead);
//      A path another dossier's row also points at is never deleted. A failed
//      listing or delete stops here with the database untouched;
//   4. public.anonymize_client() (migration 0065) erases the database side in
//      one transaction — see that migration for exactly what is erased and
//      what is kept. The clients row is updated, never deleted, so nothing
//      cascades;
//   5. sweep for uploads that raced the erasure: paths the function returned
//      that step 3 had not seen, and anything under clients/<id>/ that no
//      document row points at now, are deleted. (The upload route itself
//      rolls back an upload that overlapped an erasure — see
//      /api/clients/upload.) What cannot be deleted is reported as files_left;
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
import { assertNoLivePassport } from "@/lib/server/passport-state";
import { detectNetwork } from "@/lib/network";
import {
  anonymizeConfirmationPhrase,
  isAnonymizeConfirmation,
  type AnonymizeCounts,
  type AnonymizeResult,
} from "@/lib/client-privacy";
import { assertUuid, fetchClientOr404, reqString } from "../_helpers";
import {
  LEGACY_KYC_BUCKET,
  isRepositoryPath,
  listClientObjects,
  pathsSharedWithOtherDossiers,
  removeObjects,
} from "../_privacy";

// anonymize_client() missing: migration 0065 not applied yet.
const MISSING_FUNCTION = new Set(["PGRST202", "42883"]);

type Rpc = { data: unknown; error: { code?: string; message?: string } | null };
type Sb = ReturnType<typeof getSupabaseAdmin>;

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
  sb: Sb,
  wallet: string,
  source: AuditActorSource,
  clientId: string,
  step: string,
  extra: Record<string, unknown> = {},
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
      metadata: { client_id: clientId, actor_wallet: wallet, step, ...extra },
    });
  } catch {
    // The pending row already records the attempt.
  }
}

/** storage_path of every document row of the dossier. THROWS (500). */
async function documentPaths(sb: Sb, clientId: string): Promise<string[]> {
  const { data, error } = await sb
    .from("client_documents")
    .select("storage_path")
    .eq("client_id", clientId);
  if (error) throw new SiwsError(500, "Could not read the dossier's documents");
  return (data ?? [])
    .map((d) => (d as { storage_path?: unknown }).storage_path)
    .filter((p): p is string => typeof p === "string" && p.length > 0);
}

type FileSweep = {
  /** Every path handled (deleted, missing or skipped) — for step 5. */
  seen: Set<string>;
  deleted: Set<string>;
  legacyDeleted: number;
  /** Row paths found in neither bucket (already gone; nothing to delete). */
  missing: string[];
  /** Paths another dossier's row still points at (kept on purpose). */
  shared: string[];
  /** Row paths in a document-repository folder of the public bucket: not
   *  deleted automatically — ops must check them (exact paths reported). */
  forReview: string[];
};

/** Step 3. THROWS on any listing / lookup / delete failure. */
async function deleteStoredFiles(sb: Sb, clientId: string, rowPaths: string[]): Promise<FileSweep> {
  const [privateStored, legacyStored] = await Promise.all([
    listClientObjects(sb, clientId),
    listClientObjects(sb, clientId, LEGACY_KYC_BUCKET),
  ]);
  const all = [...new Set([...rowPaths, ...privateStored, ...legacyStored])];
  const shared = await pathsSharedWithOtherDossiers(sb, clientId, all);
  const own = (paths: string[]) => paths.filter((p) => !shared.has(p));

  // a. Private bucket.
  const deleted = await removeObjects(sb, own([...new Set([...rowPaths, ...privateStored])]));

  // b. Legacy public bucket: row paths not found privately, plus orphans
  //    under the dossier's prefix. Never a document-repository folder.
  const legacyCandidates = own([...new Set([...rowPaths.filter((p) => !deleted.has(p)), ...legacyStored])]);
  const forReview = legacyCandidates.filter(isRepositoryPath);
  const legacyTargets = legacyCandidates.filter((p) => !isRepositoryPath(p));
  const legacyDeleted = legacyTargets.length > 0 ? await removeObjects(sb, legacyTargets, LEGACY_KYC_BUCKET) : new Set<string>();
  for (const p of legacyDeleted) deleted.add(p);

  const missing = own(rowPaths).filter((p) => !deleted.has(p) && !isRepositoryPath(p));
  return {
    seen: new Set(all),
    deleted,
    legacyDeleted: legacyDeleted.size,
    missing,
    shared: [...shared],
    forReview,
  };
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

    // 1a. Preflight: the same checks as the erasure, nothing changed.
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

    // 1b. The chain must not still vouch for this identity.
    await assertNoLivePassport(typeof client.wallet === "string" ? client.wallet : null);

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
    let rowPaths: string[];
    let files: FileSweep;
    try {
      rowPaths = await documentPaths(sb, clientId);
      files = await deleteStoredFiles(sb, clientId, rowPaths);
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
      await auditFailure(sb, wallet, source, clientId, `database refused: ${result.status}`, {
        files_deleted: files.deleted.size,
      });
      throw new SiwsError(
        lateRefusal.status,
        `${lateRefusal.message} The stored files were already deleted; run it again once the request is finished.`,
      );
    }
    if (result.status !== "anonymized" || !result.counts || typeof result.anonymized_at !== "string") {
      await auditFailure(sb, wallet, source, clientId, "unexpected database answer");
      throw new SiwsError(500, "Unexpected answer from the database — check the dossier");
    }

    // 5. Uploads that raced the erasure.
    const returnedPaths = Array.isArray(result.storage_paths)
      ? result.storage_paths.filter((p): p is string => typeof p === "string")
      : [];
    const late = new Set(returnedPaths.filter((p) => !files.seen.has(p)));
    let sweepComplete = true;
    try {
      // Rows present now were written after the erasure (a fresh upload); only
      // files no row points at are leftovers.
      const [stored, current] = await Promise.all([
        listClientObjects(sb, clientId),
        documentPaths(sb, clientId),
      ]);
      const referenced = new Set(current);
      for (const p of stored) if (!referenced.has(p)) late.add(p);
      for (const p of await pathsSharedWithOtherDossiers(sb, clientId, [...late])) late.delete(p);
    } catch {
      sweepComplete = false;
      // Still delete what the function returned, minus what step 3 kept.
      for (const p of files.shared) late.delete(p);
    }
    let filesLeft = 0;
    if (late.size > 0) {
      try {
        for (const p of await removeObjects(sb, [...late])) files.deleted.add(p);
      } catch {
        filesLeft = late.size;
      }
    }
    if (filesLeft > 0 || !sweepComplete) {
      console.error(`[api/clients/anonymize] late files of ${clientId} could not all be checked or deleted — run it again`);
    }

    // 6. Completion record. Paths are recorded only where ops must act
    //    (document-repository folders); everything else is a count.
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
          files_deleted: files.deleted.size,
          legacy_files_deleted: files.legacyDeleted,
          files_missing: files.missing.length,
          files_shared: files.shared.length,
          files_left: filesLeft,
          late_sweep_complete: sweepComplete,
          files_for_review: files.forReview,
        },
      });
    } catch {
      auditComplete = false;
    }

    const body: AnonymizeResult = {
      anonymized_at: result.anonymized_at,
      counts: result.counts,
      files_deleted: files.deleted.size,
      legacy_files_deleted: files.legacyDeleted,
      files_missing: files.missing.length,
      files_shared: files.shared.length,
      files_left: filesLeft,
      late_sweep_complete: sweepComplete,
      files_for_review: files.forReview,
      audit_complete: auditComplete,
    };
    return NextResponse.json({ ok: true, data: body }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
