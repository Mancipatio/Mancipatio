// SERVER-ONLY — find or provision the off-chain KYC/KYB dossier for a wallet
// and request its document checklist. Shared by /api/passport/submit and
// /api/verification/submit (moved verbatim from the passport route).

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SiwsError } from "@/lib/server/siws";
import {
  applyClientStatus,
  assertWalletNotTerminal,
  detectNetworkServer,
  isMissingTtlColumnError,
  isOnboardingTokenLive,
  isTerminalKycStatus,
  onboardingTokenExpiry,
  randomOnboardingToken,
  withoutTtlColumn,
} from "@/app/api/clients/_helpers";

// Standard investor KYC checklist requested when a dossier is provisioned (or
// re-opened) from a passport application. Mirrors KYC_DOC_KINDS labels in
// lib/clients.ts.
export const STANDARD_INVESTOR_REQUIREMENTS = [
  { doc_kind: "passport", label: "Passport" },
  { doc_kind: "proof_of_address", label: "Proof of address" },
  { doc_kind: "selfie", label: "Selfie / liveness" },
] as const;

// Company (KYB) checklist for /verify. Mirrors KYC_DOC_KINDS in lib/clients.ts.
export const STANDARD_COMPANY_REQUIREMENTS = [
  { doc_kind: "incorporation", label: "Certificate of incorporation / registry extract" },
  { doc_kind: "board_resolution", label: "Ownership structure & ultimate beneficial owners" },
  { doc_kind: "passport", label: "Representative passport or ID" },
  { doc_kind: "proof_of_address", label: "Company proof of address" },
] as const;

export type ClientLite = {
  id: string;
  created_at: string;
  email: string | null;
  jurisdiction: string | null;
  kyc_status: string;
  onboarding_token: string | null;
  onboarding_token_expires_at?: string | null;
  types: string[] | null;
  type: string;
};

/** Projection every dossier read in this route shares. */
export const SELECT_COLS =
  "id, created_at, email, jurisdiction, kyc_status, onboarding_token, onboarding_token_expires_at, types, type";

function assertNotTerminal(client: Pick<ClientLite, "kyc_status">): void {
  if (isTerminalKycStatus(client.kyc_status)) {
    throw new SiwsError(
      403,
      `Your KYC dossier is ${client.kyc_status} — contact the compliance team; reapplying is disabled.`,
    );
  }
}

/**
 * Find the oldest clients row linked to `wallet` (mirrors lookupClientKyc) or
 * create a fresh investor dossier. Returns the row plus a usable onboarding
 * token (re-issued when missing and documents may still be needed).
 *
 * The terminal-status gate runs over ALL rows of the wallet BEFORE the
 * "oldest wins" pick (assertWalletNotTerminal): with duplicate rows, checking
 * only the oldest let a suspension recorded on the newer dossier be bypassed
 * by re-applying — see the helper's docblock.
 */
export async function ensureClientDossier(
  sb: SupabaseClient,
  wallet: string,
  jurisdiction: number,
  role: "investor" | "issuer" = "investor",
  source = "passport-request",
): Promise<{
  client: ClientLite;
  token: string | null;
  created: boolean;
  /**
   * True when `token` exists but the server would REJECT it (no 0041 stamp on
   * a dossier older than the created_at + 14d fallback) — the caller must show
   * a message instead of a link.
   */
  linkUnusable: boolean;
}> {
  await assertWalletNotTerminal(sb, wallet);
  const { data: existing, error: lookupErr } = await sb
    .from("clients")
    .select(SELECT_COLS)
    .eq("wallet", wallet)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (lookupErr) {
    console.error("[kyc-dossier] client lookup failed:", lookupErr.message);
    throw new SiwsError(500, "Client lookup failed");
  }

  const jurisdictionStr = String(jurisdiction).padStart(3, "0");

  if (!existing) {
    const token = randomOnboardingToken();
    const insertRow: Record<string, unknown> = {
      network: detectNetworkServer(),
      type: role,
      types: [role],
      display_name: `${role === "issuer" ? "Issuer" : "Investor"} ${wallet.slice(0, 6)}…${wallet.slice(-4)}`,
      jurisdiction: jurisdictionStr,
      source,
      wallet,
      // Wallet is already known, but the magic-link token is still needed —
      // it is the credential for the /onboarding/{id} document uploads.
      onboarding_token: token,
      onboarding_token_expires_at: onboardingTokenExpiry(),
      onboarding_status: "connected",
    };
    let { data: created, error: insertErr } = await sb
      .from("clients")
      .insert(insertRow)
      .select(SELECT_COLS)
      .single();
    if (insertErr && isMissingTtlColumnError(insertErr)) {
      // Pre-0041 database — degrade to "no TTL stamp" instead of failing the
      // application (server-side TTL then falls back to created_at + 14d).
      console.warn(
        "[kyc-dossier] 0041 not applied — retrying insert without TTL column",
      );
      ({ data: created, error: insertErr } = await sb
        .from("clients")
        .insert(withoutTtlColumn(insertRow))
        .select(SELECT_COLS)
        .single());
    }
    if (insertErr && insertErr.code === "23505") {
      // Unique-violation on clients_wallet_unique (0041): a concurrent submit
      // provisioned the dossier between our lookup and this insert — adopt the
      // winning row instead of failing (closes the TOCTOU dupe).
      const { data: winner, error: rereadErr } = await sb
        .from("clients")
        .select(SELECT_COLS)
        .eq("wallet", wallet)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (rereadErr || !winner) {
        console.error(
          "[kyc-dossier] dupe re-read failed:",
          rereadErr?.message,
        );
        throw new SiwsError(500, "Could not provision the KYC dossier");
      }
      const adopted = winner as ClientLite;
      assertNotTerminal(adopted);
      return {
        client: adopted,
        token: adopted.onboarding_token,
        created: false,
        // The winning row's stamp decides whether its token is live at all.
        linkUnusable: !isOnboardingTokenLive(
          adopted.created_at,
          adopted.onboarding_token_expires_at,
        ),
      };
    }
    if (insertErr || !created) {
      console.error("[kyc-dossier] client insert failed:", insertErr?.message);
      throw new SiwsError(500, "Could not provision the KYC dossier");
    }
    const createdRow = created as ClientLite;
    // A brand-new row is inside the created_at + 14d fallback window even
    // without the 0041 stamp, so the link works either way.
    return { client: createdRow, token, created: true, linkUnusable: false };
  }

  const row = existing as ClientLite;
  // FAIL-CLOSED for terminal statuses: a suspended (AML/sanctions hit) or
  // rejected client must not be able to reset their own KYC state or mint a
  // fresh upload credential by simply reapplying — only compliance can lift
  // these. No status change, no token issuance, no request row.
  assertNotTerminal(row);
  const patch: Record<string, unknown> = {};
  // Fill jurisdiction when the dossier has none (never overwrite admin data).
  if (!row.jurisdiction) patch.jurisdiction = jurisdictionStr;
  // Make sure the dossier carries the requested role.
  const types = Array.isArray(row.types) && row.types.length > 0 ? row.types : [row.type];
  if (!types.includes(role)) patch.types = [...types, role];

  // Re-issue the magic-link when it is gone and documents may still be needed
  // (a verified client keeps no token — nothing to upload).
  let token = row.onboarding_token;
  if (!token && row.kyc_status !== "verified") {
    token = randomOnboardingToken();
    patch.onboarding_token = token;
    patch.onboarding_token_expires_at = onboardingTokenExpiry();
  } else if (token) {
    // Refresh the TTL — the applicant is actively using the flow.
    patch.onboarding_token_expires_at = onboardingTokenExpiry();
  }

  // Tracks the pre-0041 retry: the token then carries NO expiry stamp, so the
  // server falls back to created_at + 14d — which is already in the past for
  // any dossier older than two weeks. Handing out such a link would produce a
  // 401 on the very next click, so the caller suppresses it instead.
  let ttlDegraded = false;
  if (Object.keys(patch).length > 0) {
    let { error: patchErr } = await sb.from("clients").update(patch).eq("id", row.id);
    if (patchErr && isMissingTtlColumnError(patchErr)) {
      console.warn(
        "[kyc-dossier] 0041 not applied — retrying patch without TTL column",
      );
      ttlDegraded = true;
      ({ error: patchErr } = await sb
        .from("clients")
        .update(withoutTtlColumn(patch))
        .eq("id", row.id));
    }
    if (patchErr) {
      console.warn("[kyc-dossier] client patch failed:", patchErr.message);
    }
  }
  // Whether stamped now or inherited from the row, the link is only worth
  // advertising while the server would still accept it.
  const tokenLive = ttlDegraded
    ? isOnboardingTokenLive(row.created_at, null)
    : isOnboardingTokenLive(
        row.created_at,
        (patch.onboarding_token_expires_at as string | undefined) ??
          row.onboarding_token_expires_at,
      );
  return { client: row, token, created: false, linkUnusable: !tokenLive };
}

/**
 * Request the standard investor document set when the dossier has no open
 * checklist and is not verified; parks the client in `more_info` (same
 * semantics as /api/clients/request-docs). Best-effort — never throws.
 */
export async function ensureStandardRequirements(
  sb: SupabaseClient,
  client: ClientLite,
  requirements: readonly { doc_kind: string; label: string }[],
  note: string,
  requestedBy: string,
): Promise<void> {
  if (client.kyc_status === "verified") return;
  // Defense in depth (the route 403s terminal statuses earlier): NEVER flip a
  // suspended/rejected dossier back to more_info — that would erase a
  // compliance verdict through a self-service endpoint.
  if (isTerminalKycStatus(client.kyc_status)) return;
  const { data: open, error } = await sb
    .from("kyc_requirements")
    .select("id")
    .eq("client_id", client.id)
    .in("status", ["requested", "submitted"])
    .limit(1);
  if (error) {
    console.warn("[kyc-dossier] requirements check failed:", error.message);
    return;
  }
  if ((open ?? []).length > 0) return;

  const { error: insertErr } = await sb.from("kyc_requirements").insert(
    requirements.map((r) => ({
      client_id: client.id,
      doc_kind: r.doc_kind,
      label: r.label,
      note,
      requested_by: requestedBy,
    })),
  );
  if (insertErr) {
    console.warn("[kyc-dossier] requirements insert failed:", insertErr.message);
    return;
  }
  try {
    await applyClientStatus(sb, client.id, "more_info");
  } catch (err) {
    console.warn("[kyc-dossier] more_info flip failed:", err);
  }
}

