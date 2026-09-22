// SERVER-ONLY — shared client-KYC gate for signed write routes.
//
// One source of truth for "is this wallet an onboarded, KYC-verified
// client?". Extracted from app/api/applications/_lib.ts (which re-exports
// these names so the /api/applications/* routes are untouched) so every
// write route that needs a verified client enforces the same server-side
// gate instead of trusting client-side eligibility checks.
//
// WHERE KYC IS REQUIRED (product policy, 2026-09-23): buying and trading
// tokens does NOT require identity verification. KYC is required when a
// token is turned into something off-chain — converted into company equity
// (/api/conversion/create) or redeemed for a physical good
// (/api/delivery/create) — plus the issuer-side tools (/apply via the
// applicant/KYB gates below, /api/vesting-series/create). The sales and
// trading routes (/api/launchpad/commit, /api/otc/create,
// /api/resell/create) only run refuseTerminalClient: a dossier compliance
// has explicitly suspended or rejected is still refused there. A class the
// issuer/platform switched to KycGated keeps its passport requirement
// ON-CHAIN (transfer hook + asset_registry receiver checks), independent of
// these off-chain gates.
//
// The gate is bound to the ACTIVE NETWORK and to the verdict's EXPIRY
// (2026-09-08 e2e §3 / F01): a dossier is eligible only when
//   * it belongs to the network this deployment serves (clients.network ===
//     detectNetwork() — the same resolver verifySigned binds signatures to),
//   * kyc_status === 'verified', and
//   * kyc_expires_at is a valid timestamp strictly in the future.
// Everything else fails closed — including a verified row with a NULL or
// unparsable expiry, and a verified row of another network.
//
// The verdict/message mapping is split into pure helpers (evaluateKycLookup,
// kycGateMessage) so tests/kyc-gate.test.ts can pin the status mapping
// without a Supabase client.

import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { SiwsError } from "@/lib/server/siws";
import { detectNetwork } from "@/lib/network";

export type ClientKycLookup = {
  hasClient: boolean;
  kycStatus: string | null;
  /** clients.kyc_expires_at as stored (ISO), null when never stamped. */
  kycExpiresAt: string | null;
  /**
   * True when the status says 'verified' but the verdict is not live: the
   * expiry is missing, unparsable, or not in the future. Lets the UI copy
   * say "expired" instead of "status verified but not eligible".
   */
  expired: boolean;
  eligible: boolean;
};

/** The columns the gate reads off a `clients` row. */
export type ClientKycRow = {
  kyc_status: string | null;
  kyc_expires_at: string | null;
};

/**
 * Pure half of the lookup: maps a `clients` row (or its absence) onto the
 * gate verdict. Only kyc_status === 'verified' WITH an expiry strictly after
 * `now` is eligible — every other status (pending / more_info / rejected /
 * suspended / expired / null) fails the gate, and so does a verified row
 * whose kyc_expires_at is null, unparsable or already past (fail closed).
 */
export function evaluateKycLookup(
  row: ClientKycRow | null,
  now: Date = new Date(),
): ClientKycLookup {
  if (!row) {
    return {
      hasClient: false,
      kycStatus: null,
      kycExpiresAt: null,
      expired: false,
      eligible: false,
    };
  }
  const kycStatus = row.kyc_status ?? null;
  const kycExpiresAt = row.kyc_expires_at ?? null;
  const verified = kycStatus === "verified";
  const expiryMs = kycExpiresAt === null ? NaN : Date.parse(kycExpiresAt);
  const live = Number.isFinite(expiryMs) && expiryMs > now.getTime();
  return {
    hasClient: true,
    kycStatus,
    kycExpiresAt,
    expired: verified && !live,
    eligible: verified && live,
  };
}

/**
 * Pure half of the gate: the 403 message for a failed lookup, or null when
 * the wallet passes. `context` is the gerund phrase naming the blocked
 * action ("applying", "committing to this raise", …) so each route's error
 * reads naturally while keeping the recognizable "KYC verification
 * required" lead.
 */
export function kycGateMessage(
  kyc: ClientKycLookup,
  context: string,
): string | null {
  if (kyc.eligible) return null;
  if (!kyc.hasClient) {
    return `Onboarding required — no client profile is linked to this wallet. Please contact us to get onboarded before ${context}.`;
  }
  if (kyc.expired) {
    const expiryMs = kyc.kycExpiresAt === null ? NaN : Date.parse(kyc.kycExpiresAt);
    return Number.isFinite(expiryMs)
      ? `KYC verification expired on ${new Date(expiryMs).toISOString().slice(0, 10)} — please renew your verification before ${context}.`
      : `KYC verification required before ${context} — your verified status has no recorded expiry. Please contact us to complete re-verification.`;
  }
  return `KYC verification required before ${context} — your current status is "${kyc.kycStatus ?? "unknown"}".`;
}

/** Dossier states only compliance can lift (mirrors app/api/clients/_helpers). */
const TERMINAL_KYC_STATUSES: readonly string[] = ["suspended", "rejected"];

type FetchedClientRow = ClientKycRow & { id: string };

/**
 * Fetch the clients row that speaks for `wallet` ON THE ACTIVE NETWORK.
 *
 * Network binding: a `verified` dossier recorded for another cluster must not
 * satisfy this deployment's gate, so the read is filtered by
 * clients.network === detectNetwork() — the same resolver every signed
 * route already binds the SIWS payload to. Rows of other networks are not
 * read at all, so a historical terminal row elsewhere cannot deny (or
 * grant) anything here.
 *
 * FAIL-CLOSED on duplicates: migration 0041 adds a unique index on
 * clients.wallet, but it is SKIPPED on databases that already hold duplicate
 * rows, and historic data may carry an admin-invited row plus a self-service
 * one. Reading only the oldest row (the previous behaviour, mirroring
 * lib/clients.ts findClientByWallet) meant compliance could suspend the row
 * carrying the documents while an older `pending`/`verified` row kept
 * answering every gate. So: any TERMINAL row (suspended / rejected) wins;
 * otherwise the oldest row does, as before.
 *
 * Internal: the row id must NOT travel through lookupClientKyc, whose result
 * the unsigned /api/applications/eligibility route returns verbatim to any
 * caller.
 */
async function fetchClientRow(
  sb: SupabaseClient,
  wallet: string,
): Promise<FetchedClientRow | null> {
  const network = detectNetwork();
  const { data, error } = await sb
    .from("clients")
    .select("id, kyc_status, kyc_expires_at")
    .eq("wallet", wallet)
    .eq("network", network)
    .order("created_at", { ascending: true });
  if (error) {
    console.error("[kyc-gate] client lookup failed:", error.message);
    throw new SiwsError(500, "Client lookup failed");
  }
  let rows = (data ?? []) as FetchedClientRow[];
  if (rows.length === 0) {
    // Verification belongs to the account: a linked wallet without its own
    // dossier answers with the account's dossier.
    const { data: member } = await sb.from("account_wallets").select("account_id")
      .eq("network", network).eq("wallet", wallet).maybeSingle();
    if (member?.account_id) {
      const byAccount = await sb.from("clients").select("id, kyc_status, kyc_expires_at")
        .eq("account_id", member.account_id).eq("network", network).order("created_at", { ascending: true });
      if (byAccount.error) {
        console.error("[kyc-gate] account dossier lookup failed:", byAccount.error.message);
        throw new SiwsError(500, "Client lookup failed");
      }
      rows = (byAccount.data ?? []) as FetchedClientRow[];
    }
  }
  if (rows.length === 0) return null;
  if (rows.length > 1) {
    console.warn(
      `[kyc-gate] ${rows.length} client rows share wallet ${wallet} on ${network} — dedupe them (see migration 0041)`,
    );
  }
  return (
    rows.find(
      (r) => r.kyc_status !== null && TERMINAL_KYC_STATUSES.includes(r.kyc_status),
    ) ?? rows[0]
  );
}

/**
 * Look up the client row linked to `wallet` on the active network and report
 * KYC eligibility. Returns only the non-PII verdict shape (no row id) — safe
 * to expose through the unsigned eligibility route.
 */
export async function lookupClientKyc(
  sb: SupabaseClient,
  wallet: string,
): Promise<ClientKycLookup> {
  return evaluateKycLookup(await fetchClientRow(sb, wallet));
}

/**
 * Apply gate: the SIWS-verified signing wallet must belong to an onboarded
 * client row of the active network with kyc_status === 'verified' and a
 * live kyc_expires_at. Throws SiwsError(403) otherwise — the calling pages
 * show the same gate client-side, this is the authoritative check. Resolves
 * with the verified clients row id so routes that stamp `client_id` (e.g.
 * /api/delivery/create) can reuse this single gate instead of keeping an
 * inline copy of the lookup.
 */
export async function requireVerifiedClient(
  sb: SupabaseClient,
  wallet: string,
  context = "applying",
): Promise<{ clientId: string }> {
  const row = await fetchClientRow(sb, wallet);
  const message = kycGateMessage(evaluateKycLookup(row), context);
  if (message) throw new SiwsError(403, message);
  // A null message means eligible, and eligible implies the row exists.
  return { clientId: (row as FetchedClientRow).id };
}

// ── Terminal-status screen (sales & trading, no KYC required) ───────────────
// Buying, OTC trading and resell listings do not require KYC (policy
// 2026-09-23), so a wallet with NO dossier, or a pending / more_info /
// expired one, passes. What still fails is a dossier compliance has closed
// on purpose: `suspended` (sanctions hit, fraud, court order, ongoing
// investigation) or `rejected` (compliance refused the person). Those are
// decisions about the PERSON, not missing paperwork — letting such a wallet
// keep transacting through the platform's own off-chain services simply by
// not being asked for KYC would turn "KYC is not required to buy" into
// "compliance decisions are ignored when buying". Only compliance can lift
// them (mirrors app/api/clients/_helpers TERMINAL_KYC_STATUSES), and the
// fail-closed row pick in fetchClientRow means a terminal row wins over any
// older live one. On-chain sanctions enforcement (the transfer-hook
// blocklist) is separate and applies in every mode.

/**
 * Pure half of the terminal screen: the 403 message for a terminal dossier
 * status, or null when the wallet may proceed (no dossier, or any
 * non-terminal status — KYC is not required here).
 */
export function terminalKycMessage(
  kycStatus: string | null,
  context: string,
): string | null {
  if (kycStatus === null || !TERMINAL_KYC_STATUSES.includes(kycStatus)) return null;
  return `Your client profile is ${kycStatus} by compliance — contact the compliance team before ${context}.`;
}

/**
 * Sales/trading gate: refuse ONLY a wallet whose dossier (on the active
 * network, own or account-level) is suspended or rejected. Does not require
 * a client row or KYC. Resolves with the linked clients row id when one
 * exists (null otherwise) so a route can optionally link the record to a
 * client without making the link a precondition.
 */
export async function refuseTerminalClient(
  sb: SupabaseClient,
  wallet: string,
  context: string,
): Promise<{ clientId: string | null }> {
  const row = await fetchClientRow(sb, wallet);
  const message = terminalKycMessage(row?.kyc_status ?? null, context);
  if (message) throw new SiwsError(403, message);
  return { clientId: row?.id ?? null };
}

// ── Company (KYB) gate ─────────────────────────────────────────────────────
// Raising capital on Manci is a company act: /apply requires an APPROVED KYB
// (client_verification_details kind 'kyb', status 'verified'), never the
// dossier's individual KYC status. A terminal dossier (suspended/rejected)
// still blocks everything.

export type CompanyKybStatus = "none" | "pending" | "more_info" | "verified" | "rejected" | "suspended";

export type CompanyKybLookup = {
  hasClient: boolean;
  /** Company verification state; "more_info" = documents still requested. */
  kybStatus: CompanyKybStatus;
  /** Kept for the /apply UI, which shows the status under this name. */
  kycStatus: string | null;
  eligible: boolean;
};

async function evaluateCompanyKyb(sb: SupabaseClient, row: FetchedClientRow | null): Promise<CompanyKybLookup> {
  if (!row) return { hasClient: false, kybStatus: "none", kycStatus: null, eligible: false };
  if (row.kyc_status !== null && TERMINAL_KYC_STATUSES.includes(row.kyc_status)) {
    const status = row.kyc_status === "suspended" ? "suspended" : "rejected";
    return { hasClient: true, kybStatus: status, kycStatus: status, eligible: false };
  }
  const { data, error } = await sb.from("client_verification_details")
    .select("status").eq("client_id", row.id).eq("kind", "kyb").maybeSingle();
  if (error) {
    console.error("[kyc-gate] KYB lookup failed:", error.message);
    throw new SiwsError(500, "Company verification lookup failed");
  }
  let kybStatus: CompanyKybStatus = !data ? "none" : (data.status as CompanyKybStatus);
  if (kybStatus === "pending") {
    const { data: open } = await sb.from("kyc_requirements").select("id")
      .eq("client_id", row.id).eq("status", "requested").limit(1);
    if (open && open.length > 0) kybStatus = "more_info";
  }
  return { hasClient: true, kybStatus, kycStatus: kybStatus, eligible: kybStatus === "verified" };
}

/** Non-PII KYB verdict for the unsigned /api/applications/eligibility route. */
export async function lookupCompanyKyb(sb: SupabaseClient, wallet: string): Promise<CompanyKybLookup> {
  return evaluateCompanyKyb(sb, await fetchClientRow(sb, wallet));
}

/** Authoritative /apply gate: the signer's company verification is approved. */
export async function requireVerifiedCompany(sb: SupabaseClient, wallet: string): Promise<{ clientId: string }> {
  const row = await fetchClientRow(sb, wallet);
  const verdict = await evaluateCompanyKyb(sb, row);
  if (!verdict.eligible) {
    const reason = verdict.kybStatus === "none" ? "Verify your company (KYB) at /verify before applying."
      : verdict.kybStatus === "pending" || verdict.kybStatus === "more_info" ? "Your company verification (KYB) is still under review."
      : `Your company verification is ${verdict.kybStatus} — contact the compliance team.`;
    throw new SiwsError(403, `Company verification required to apply. ${reason}`);
  }
  return { clientId: (row as FetchedClientRow).id };
}

// ── Applicant gate (/apply) ────────────────────────────────────────────────
// A verified company (approved KYB) applies as a company. A verified
// individual (live KYC) may apply too: Manci then opens the company for them
// (company_formation_requested). Anything else is refused.

export type ApplicantLookup = CompanyKybLookup & {
  /** Individual KYC state of the same dossier (verified = live KYC). */
  individualKycStatus: string | null;
  applicantKind: "company" | "individual" | null;
};

export async function lookupApplicant(sb: SupabaseClient, wallet: string): Promise<ApplicantLookup> {
  const row = await fetchClientRow(sb, wallet);
  const kyb = await evaluateCompanyKyb(sb, row);
  const kyc = evaluateKycLookup(row);
  const applicantKind = kyb.eligible ? "company" : kyc.eligible ? "individual" : null;
  return { ...kyb, eligible: applicantKind !== null, individualKycStatus: kyc.expired ? "expired" : kyc.kycStatus, applicantKind };
}

export async function requireVerifiedApplicant(
  sb: SupabaseClient, wallet: string,
): Promise<{ clientId: string; kind: "company" | "individual" }> {
  const verdict = await lookupApplicant(sb, wallet);
  if (!verdict.applicantKind) {
    throw new SiwsError(403, "Verification required to apply: complete identity verification (KYC) as an individual or company verification (KYB) at /verify.");
  }
  const row = await fetchClientRow(sb, wallet);
  return { clientId: (row as FetchedClientRow).id, kind: verdict.applicantKind };
}
