"use client";

import type { WalletSession } from "@solana/client";
import { getSupabase } from "@/lib/supabase";
import { signedFetch } from "@/lib/siws-client";
import { detectNetwork } from "@/lib/network";

export type RaiseType = "startup" | "mature";
export type ApplicationStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "needs_changes";
export type CommitmentStatus =
  | "pending"
  | "confirmed"
  | "settled"
  | "cancelled";

export type ApplicationEventActor = "admin" | "applicant";
export type ApplicationEventAction =
  | "submitted"
  | "resubmitted"
  | "approved"
  | "rejected"
  | "needs_changes"
  | "terms_adjusted";

export type ApplicationEvent = {
  id: number;
  created_at: string;
  application_id: string;
  actor: ApplicationEventActor;
  action: ApplicationEventAction;
  reason: string | null;
  actor_wallet: string | null;
};

export type LaunchApplication = {
  id: string;
  created_at: string;
  applicant_wallet: string;
  /** company = approved KYB; individual = verified KYC, Manci opens the company. */
  applicant_kind?: "company" | "individual" | null;
  company_formation_requested?: boolean;
  raise_type: RaiseType;
  company_name: string;
  one_liner: string;
  website: string | null;
  category: string;
  stage: string | null;
  incorporation: string | null;
  valuation: string | null;
  annual_revenue: string | null;
  existing_investors: string | null;
  problem_or_why: string | null;
  raise_amount: number;
  equity_offered: number;
  min_ticket: string | null;
  raise_structure: string | null;
  cliff_months: number;
  vesting_months: number;
  founder_name: string | null;
  founder_email: string | null;
  founder_twitter: string | null;
  founder_linkedin: string | null;
  founder_why: string | null;
  pitch_deck: string | null;
  status: ApplicationStatus;
  review_reason: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  linked_issuer: string | null;
  linked_sale_pubkey: string | null;
  submitted_at: string;
  revision_count: number;
};

export type LaunchListing = {
  sale_pubkey: string;
  application_id: string | null;
  created_at: string;
  logo_letter: string | null;
  logo_gradient: string | null;
  problem: string | null;
  why_now: string | null;
  traction: Record<string, string>;
  existing_investors: string | null;
  is_published: boolean;
};

export type LaunchUpdate = {
  id: string;
  sale_pubkey: string;
  posted_at: string;
  title: string;
  body: string;
  onchain_update_index: number | null;
};

export type Commitment = {
  id: string;
  created_at: string;
  sale_pubkey: string;
  investor_wallet: string;
  amount: number;
  status: CommitmentStatus;
  settled_tx: string | null;
};

export type NewApplication = Omit<
  LaunchApplication,
  | "id"
  | "created_at"
  | "status"
  | "review_reason"
  | "reviewed_by"
  | "reviewed_at"
  | "linked_issuer"
  | "linked_sale_pubkey"
  | "submitted_at"
  | "revision_count"
>;

// ── applications ──────────────────────────────────────────────────────────

/** Apply-gate check result from /api/applications/eligibility (no PII). */
export type ApplyEligibility = {
  hasClient: boolean;
  kycStatus: string | null;
  eligible: boolean;
  /** Company verification (KYB) state. */
  kybStatus?: "none" | "pending" | "more_info" | "verified" | "rejected" | "suspended";
  /** Individual KYC state of the same dossier. */
  individualKycStatus?: string | null;
  /** How the wallet may apply: approved company, or verified individual (Manci opens the company). */
  applicantKind?: "company" | "individual" | null;
};

/** The signer's raise capacity this calendar year (admin-configurable limits). */
export type RaiseCapacity = {
  year: number; cap: number; used: number; remaining: number;
  max_equity_percent: number; cap_source: "platform" | "client";
};

export async function getMyRaiseCapacity(
  session: WalletSession | null | undefined,
  excludeApplicationId?: string | null,
): Promise<RaiseCapacity> {
  return await signedFetch<RaiseCapacity>(session, "/api/applications/capacity", "applications.capacity",
    excludeApplicationId ? { exclude: excludeApplicationId } : {});
}

/**
 * Server-side apply-gate check: does this wallet have an onboarded client
 * row with kyc_status === 'verified'? Unsigned read-only route (UX gate);
 * the signed submit/resubmit routes enforce the same rule authoritatively.
 * Returns null when the check itself fails (network/server) — callers should
 * fail OPEN client-side and let the submit route reject.
 */
export async function checkApplyEligibility(
  wallet: string,
): Promise<ApplyEligibility | null> {
  try {
    const res = await fetch("/api/applications/eligibility", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet }),
    });
    const json = (await res.json()) as {
      ok?: boolean;
      data?: ApplyEligibility;
      error?: string;
    };
    if (!res.ok || json.ok !== true || !json.data) {
      console.warn(
        "[launchpad] checkApplyEligibility:",
        json.error ?? res.status,
      );
      return null;
    }
    return json.data;
  } catch (e) {
    console.warn("[launchpad] checkApplyEligibility threw:", e);
    return null;
  }
}

/**
 * Submit a new launch application via the signed route. The server stamps
 * `applicant_wallet` from the SIWS-verified wallet and enforces the KYC apply
 * gate; the `submitted` application_events row is written server-side.
 *
 * @throws Error with the server's message (KYC gate, validation, …).
 */
export async function submitApplication(
  session: WalletSession | null | undefined,
  payload: NewApplication,
): Promise<string> {
  const { id } = await signedFetch<{ id: string }>(
    session,
    "/api/applications/submit",
    "applications.submit",
    { application: payload },
  );
  return id;
}

/**
 * Public, non-PII projection of a launch application — the fundraising profile
 * shown on the marketplace deal pages. Excludes founder_email, annual_revenue,
 * valuation, incorporation and internal review fields.
 */
export type PublicApplication = Pick<
  LaunchApplication,
  | "id"
  | "created_at"
  | "applicant_wallet"
  | "raise_type"
  | "company_name"
  | "one_liner"
  | "website"
  | "category"
  | "stage"
  | "incorporation"
  | "problem_or_why"
  | "existing_investors"
  | "raise_amount"
  | "equity_offered"
  | "min_ticket"
  | "raise_structure"
  | "cliff_months"
  | "vesting_months"
  | "founder_name"
  | "founder_twitter"
  | "founder_linkedin"
  | "founder_why"
  | "pitch_deck"
  | "status"
  | "linked_sale_pubkey"
  | "submitted_at"
>;

/** Applicant reads their OWN applications (signed; bound to the signer). */
export async function listMyApplications(
  session: WalletSession | null | undefined,
): Promise<LaunchApplication[]> {
  const data = await signedFetch<{ applications: LaunchApplication[] }>(
    session,
    "/api/applications/mine",
    "applications.mine",
  );
  return data.applications ?? [];
}

/** Applicant reads their OWN application + its events by id (signed). */
export async function getMyApplicationWithEvents(
  session: WalletSession | null | undefined,
  id: string,
): Promise<{
  application: LaunchApplication | null;
  events: ApplicationEvent[];
}> {
  const data = await signedFetch<{
    applications: LaunchApplication[];
    events: ApplicationEvent[];
  }>(session, "/api/applications/mine", "applications.mine", { id });
  const application =
    (data.applications ?? []).find((a) => a.id === id) ?? null;
  return { application, events: data.events ?? [] };
}

/**
 * Applicant resubmission after a `needs_changes` review, via the signed
 * route: replaces the content fields on the SAME row, flips status back to
 * `pending`, stamps a fresh `submitted_at`, and bumps `revision_count`.
 * The server verifies the signing wallet owns the application, enforces the
 * KYC apply gate, and writes the `resubmitted` event.
 *
 * @throws Error with the server's message.
 */
export async function updateApplicationContent(
  session: WalletSession | null | undefined,
  id: string,
  payload: NewApplication,
): Promise<void> {
  await signedFetch(
    session,
    "/api/applications/resubmit",
    "applications.resubmit",
    {
      id,
      application: payload,
    },
  );
}

// ── application events ────────────────────────────────────────────────────
// application_events INSERTs now happen exclusively server-side inside the
// /api/applications/* routes; only the read helper remains client-side.

/** Admin reads one application's event timeline (signed + admin gate). */
export async function adminListApplicationEvents(
  session: WalletSession | null | undefined,
  applicationId: string,
): Promise<ApplicationEvent[]> {
  const data = await signedFetch<{ events: ApplicationEvent[] }>(
    session,
    "/api/applications/admin-events",
    "applications.adminEvents",
    { application_id: applicationId },
  );
  return data.events ?? [];
}

/**
 * Public read of approved applications by id (marketplace deal pages). Returns
 * only approved rows with public-safe columns; unknown/unapproved ids are
 * simply absent. Never throws for a normal empty result.
 */
export async function getPublicApplications(
  ids: string[],
): Promise<PublicApplication[]> {
  if (ids.length === 0) return [];
  const res = await fetch("/api/applications/public", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids }),
    signal: AbortSignal.timeout(12_000),
  });
  const json = (await res.json().catch(() => null)) as {
    ok?: boolean;
    data?: { applications?: PublicApplication[] };
  } | null;
  if (!res.ok || !json?.ok || !Array.isArray(json.data?.applications))
    throw new Error(
      "Published application details are temporarily unavailable. Retry loading the marketplace.",
    );
  return json.data.applications;
}

/** Public read of a single approved application by id (marketplace). */
export async function getPublicApplication(
  id: string,
): Promise<PublicApplication | null> {
  const rows = await getPublicApplications([id]);
  return rows[0] ?? null;
}

/** Admin lists the application queue (signed + on-chain admin gate). */
export async function listApplications(
  session: WalletSession | null | undefined,
  status?: ApplicationStatus,
): Promise<LaunchApplication[]> {
  const data = await signedFetch<{ applications: LaunchApplication[] }>(
    session,
    "/api/applications/admin-list",
    "applications.adminList",
    status ? { status } : {},
  );
  return data.applications ?? [];
}

/**
 * Admin decision on an application via the signed + admin-gated route.
 * The server stamps `reviewed_by` from the SIWS-verified wallet, writes the
 * decision event, and sends the decision email to founder_email (best-effort;
 * `emailSent` reports whether it went out).
 *
 * @throws Error with the server's message (403 for non-admins, …).
 */
export async function reviewApplication(
  session: WalletSession | null | undefined,
  id: string,
  decision: Exclude<ApplicationStatus, "pending">,
  reason: string,
): Promise<{ emailSent: boolean }> {
  return await signedFetch<{
    id: string;
    decision: string;
    emailSent: boolean;
  }>(session, "/api/applications/review", "applications.review", {
    id,
    decision,
    reason,
  });
}

// ── listings ──────────────────────────────────────────────────────────────

/**
 * Create/update a listing row via the signed route. Authorization is
 * server-enforced: platform admin OR the issuer authority behind the sale
 * (resolved on-chain). Best-effort boolean, matching the old contract.
 */
export async function upsertListing(
  session: WalletSession | null | undefined,
  row: Partial<LaunchListing> & { sale_pubkey: string },
): Promise<boolean> {
  await signedFetch(
    session,
    "/api/launchpad/listing-upsert",
    "launchpad.listingUpsert",
    { listing: row },
  );
  return true;
}

export async function listPublishedListings(): Promise<LaunchListing[]> {
  const sb = getSupabase();
  if (!sb) throw new Error("Marketplace database is not configured");
  const { data, error } = await sb
    .from("launch_listings")
    .select("*")
    .eq("network", detectNetwork())
    .eq("is_published", true)
    .abortSignal(AbortSignal.timeout(12_000));
  if (error) throw new Error("Published listings are temporarily unavailable");
  return (data ?? []) as LaunchListing[];
}

export async function getListing(
  salePubkey: string,
): Promise<LaunchListing | null> {
  const sb = getSupabase();
  if (!sb) throw new Error("Marketplace database is not configured");
  const { data, error } = await sb
    .from("launch_listings")
    .select("*")
    .eq("network", detectNetwork())
    .eq("sale_pubkey", salePubkey)
    .abortSignal(AbortSignal.timeout(12_000))
    .maybeSingle();
  if (error) throw new Error("Sale listing is temporarily unavailable");
  return (data as LaunchListing) ?? null;
}

export async function listUpdates(salePubkey: string): Promise<LaunchUpdate[]> {
  const sb = getSupabase();
  if (!sb) throw new Error("Marketplace database is not configured");
  const { data, error } = await sb
    .from("launch_updates")
    .select("*")
    .eq("network", detectNetwork())
    .eq("sale_pubkey", salePubkey)
    .order("posted_at", { ascending: false })
    .abortSignal(AbortSignal.timeout(12_000));
  if (error) throw new Error("Sale updates are temporarily unavailable");
  return (data ?? []) as LaunchUpdate[];
}

// ── commitments ─────────────────────────────────────────────────────────────

/**
 * Records an off-chain soft commitment via the signed route. The server
 * requires the SIWS-verified wallet to equal `investorWallet` — you can only
 * commit as yourself. No KYC is required to commit (KYC applies at
 * conversion/delivery); the server only refuses a wallet whose client
 * profile compliance has suspended. Pledges from wallets without a live
 * verification are recorded but not counted in the public progress totals
 * (commitment_totals, migration 0061). Returns the row id.
 *
 * @throws Error with the server's message (the 403 compliance copy,
 *         document-terms 409, validation, transport) — callers must surface
 *         it to the user, not swallow it into a generic "unavailable" excuse.
 */
export async function createCommitment(
  session: WalletSession | null | undefined,
  salePubkey: string,
  investorWallet: string,
  amount: number,
  documentTerms?: { versionId: string; sha256: string },
): Promise<string> {
  const { id } = await signedFetch<{ id: string }>(
    session,
    "/api/launchpad/commit",
    "launchpad.commit",
    {
      sale_pubkey: salePubkey,
      investor_wallet: investorWallet,
      amount,
      document_terms: documentTerms ?? null,
    },
  );
  return id;
}

/**
 * Flips a commitment's lifecycle status (confirm / settle / cancel) via the
 * signed route. Server-enforced circle: platform admin OR the issuer
 * authority behind the commitment's sale. Best-effort boolean.
 */
export async function updateCommitmentStatus(
  session: WalletSession | null | undefined,
  id: string,
  status: CommitmentStatus,
  settledTx?: string,
): Promise<boolean> {
  try {
    await signedFetch(
      session,
      "/api/launchpad/commitment-status",
      "launchpad.commitmentStatus",
      {
        id,
        status,
        ...(settledTx ? { settled_tx: settledTx } : {}),
      },
    );
    return true;
  } catch (e) {
    console.warn("[launchpad] updateCommitmentStatus:", e);
    return false;
  }
}

/** Persist chain-derived purchase evidence; the successful transaction itself
 * remains successful if this separate signed recording request needs a retry. */
export async function recordSettledPurchase(
  session: WalletSession | null | undefined,
  salePubkey: string,
  investorWallet: string,
  settledTx: string,
): Promise<{
  id: string | null;
  jobId: string;
  status: "pending" | "complete";
}> {
  return signedFetch(
    session,
    "/api/launchpad/record-purchase",
    "launchpad.recordPurchase",
    {
      sale_pubkey: salePubkey,
      investor_wallet: investorWallet,
      settled_tx: settledTx,
    },
  );
}

export type { CommitAggregate } from "@/lib/commitment-totals";
import {
  parseCommitmentTotals,
  UNKNOWN_COMMITMENTS,
  type CommitAggregate,
} from "@/lib/commitment-totals";
export async function commitmentAggregate(
  salePubkey: string,
): Promise<CommitAggregate> {
  try {
    const response = await fetch("/api/launchpad/commitment-aggregate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sale_pubkey: salePubkey }),
    });
    const json = await response.json();
    if (!response.ok || json?.ok !== true) return UNKNOWN_COMMITMENTS;
    return parseCommitmentTotals(json.data);
  } catch {
    return UNKNOWN_COMMITMENTS;
  }
}


// ── Admin: raise limits & per-application terms ──────────────────────────────

export type PlatformRaiseLimits = {
  network: string;
  annual_raise_cap_eur: number;
  max_equity_percent: number;
  updated_at: string | null;
  updated_by: string | null;
};

export async function adminGetRaiseLimits(session: WalletSession | null | undefined): Promise<PlatformRaiseLimits> {
  return await signedFetch<PlatformRaiseLimits>(session, "/api/admin-config/raise-limits", "adminConfig.raiseLimitsRead", {});
}

export async function adminUpdateRaiseLimits(
  session: WalletSession | null | undefined,
  input: { annual_raise_cap_eur: number; max_equity_percent: number },
): Promise<PlatformRaiseLimits> {
  return await signedFetch<PlatformRaiseLimits>(session, "/api/admin-config/raise-limits", "adminConfig.raiseLimitsUpdate", input);
}

export async function adminAdjustApplicationTerms(
  session: WalletSession | null | undefined,
  id: string,
  input: { raise_amount: number; equity_offered: number; note?: string },
): Promise<void> {
  await signedFetch(session, "/api/applications/adjust-terms", "applications.adjustTerms", { id, ...input });
}
