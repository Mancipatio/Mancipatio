// POST /api/clients/me — a wallet reads its OWN client row (KYC status).
// Signed (SIWS): clients has no anon SELECT, and the query is bound to the
// VERIFIED signer, so a caller can only ever see their own onboarding/KYC
// state — never enumerate the directory. Used by the portfolio pages to gate
// delivery / conversion requests (the server re-checks the gate on write too).
//
// Besides the row projection this route returns `onboarding_path` — the
// magic-link document-upload page for the signer's OWN dossier. The magic
// link used to be shown exactly once (in the submit modal); dossiers
// auto-provisioned without an email had no other way back to the upload page.
// The SIWS signature proves wallet ownership, which is a STRONGER credential
// than the token itself, so re-serving (and, when expired/consumed, freshly
// re-issuing) the wallet's own upload link leaks nothing. Only dossiers with
// an active document pipeline (kyc_status pending / more_info) get a path —
// verified dossiers keep no token, and terminal ones (suspended / rejected)
// must not regain an upload credential through self-service.
//
// Two fail-closed details:
//   * a wallet with SEVERAL clients rows (historic duplicates — 0041's unique
//     index is skipped when they exist) is answered by its TERMINAL row when
//     it has one, so a suspension on the newer dossier is never masked by an
//     older `pending` row;
//   * when a fresh token cannot be stamped with an expiry (pre-0041 database)
//     the response carries `onboarding_notice` and NO path: the fallback TTL
//     is created_at + 14d, so the link would 401 on the very next click for
//     any dossier older than two weeks.

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";
import {
  DEGRADED_TTL_MESSAGE,
  isMissingTtlColumnError,
  isOnboardingTokenLive,
  isTerminalKycStatus,
  onboardingTokenExpiry,
  randomOnboardingToken,
  withoutTtlColumn,
} from "../_helpers";

// Minimal own-row projection — no admin notes, no other clients, and NEVER
// the raw onboarding_token (the path below is derived server-side).
const SELF_KEYS = [
  "id",
  "created_at",
  "updated_at",
  "network",
  "type",
  "types",
  "tier",
  "source",
  "email",
  "display_name",
  "company_name",
  "jurisdiction",
  "kyc_status",
  "kyc_verified_at",
  "kyc_expires_at",
  "onboarding_status",
  "wallet",
  "issuer_pda",
  "tos_accepted_at",
  "tos_version",
] as const;

/** Statuses with an active document pipeline (upload link makes sense). */
const UPLOADABLE_STATUSES = new Set(["pending", "more_info"]);

export async function POST(request: Request) {
  try {
    const { wallet } = await verifySigned(request, "clients.me");

    const sb = getSupabaseAdmin();
    // 0041 adds a unique index on clients.wallet, but historic databases may
    // still hold duplicates (the index creation is skipped when they exist),
    // so read ALL rows for the wallet rather than just the oldest.
    // FAIL-CLOSED: any terminal row (suspended / rejected) speaks for the
    // wallet — otherwise suspending the newer dossier would leave an older
    // `pending` row answering here (upload link included) and the suspension
    // would be invisible to the whole pipeline. Otherwise the oldest row wins
    // (mirrors findClientByWallet / ensureClientDossier). select("*") so the
    // row also carries the token fields regardless of 0041.
    const { data, error } = await sb
      .from("clients")
      .select("*")
      .eq("wallet", wallet)
      .eq("network", detectNetwork())
      .order("created_at", { ascending: true });
    if (error) {
      console.error("[api/clients/me] query failed:", error.message);
      throw new SiwsError(500, "Could not load your client record");
    }

    const rows = (data ?? []) as Record<string, unknown>[];
    const row =
      rows.find((r) => isTerminalKycStatus(r.kyc_status)) ?? rows[0] ?? null;
    if (rows.length > 1) {
      console.warn(
        `[api/clients/me] ${rows.length} client rows share wallet ${wallet} — dedupe them (see migration 0041)`,
      );
    }

    // Resolve (or re-issue) the signer's own document-upload link.
    let onboardingPath: string | null = null;
    let onboardingNotice: string | null = null;
    let openDocuments = false;
    if (row && String(row.kyc_status) === "verified") {
      // A KYC-verified dossier can still owe company (KYB) documents.
      const { data: open } = await sb.from("kyc_requirements").select("id")
        .eq("client_id", String(row.id)).eq("status", "requested").limit(1);
      openDocuments = !!open && open.length > 0;
    }
    if (row && (UPLOADABLE_STATUSES.has(String(row.kyc_status)) || openDocuments)) {
      let token =
        typeof row.onboarding_token === "string" ? row.onboarding_token : null;
      const createdAt = String(row.created_at);
      let live = isOnboardingTokenLive(
        createdAt,
        typeof row.onboarding_token_expires_at === "string"
          ? row.onboarding_token_expires_at
          : null,
      );
      if (!token || !live) {
        // Mint a fresh token for the proven wallet owner so the upload flow
        // can always be resumed. Best-effort: on failure the path is null.
        const fresh = randomOnboardingToken();
        const patch: Record<string, unknown> = {
          onboarding_token: fresh,
          onboarding_token_expires_at: onboardingTokenExpiry(),
        };
        let degraded = false;
        let { error: patchErr } = await sb
          .from("clients")
          .update(patch)
          .eq("id", row.id as string);
        if (patchErr && isMissingTtlColumnError(patchErr)) {
          console.warn(
            "[api/clients/me] 0041 not applied — retrying token re-issue without TTL column",
          );
          degraded = true;
          ({ error: patchErr } = await sb
            .from("clients")
            .update(withoutTtlColumn(patch))
            .eq("id", row.id as string));
        }
        if (patchErr) {
          console.warn(
            "[api/clients/me] token re-issue failed:",
            patchErr.message,
          );
          token = null;
          live = false;
        } else {
          token = fresh;
          // Without the 0041 column the fresh token carries NO expiry stamp,
          // so requireClientToken falls back to created_at + 14d — already in
          // the past for any dossier older than two weeks. Handing that link
          // out produces an "Invalid link" screen on the very next click, so
          // return an explicit message instead.
          live = degraded ? isOnboardingTokenLive(createdAt, null) : true;
          if (!live) onboardingNotice = DEGRADED_TTL_MESSAGE;
        }
      }
      if (token && live) onboardingPath = `/onboarding/${row.id}?t=${token}`;
    }

    const client = row
      ? Object.fromEntries(SELF_KEYS.map((k) => [k, row[k] ?? null]))
      : null;

    return NextResponse.json({
      ok: true,
      data: {
        client,
        onboarding_path: onboardingPath,
        onboarding_notice: onboardingNotice,
      },
    });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
