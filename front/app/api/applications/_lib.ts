// Shared server-side helpers for the /api/applications/* signed routes.
// Not a route file — Next.js only routes `route.ts`, so this module is never
// served. Imported by submit/, resubmit/, review/ and eligibility/.

import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { SiwsError } from "@/lib/server/siws";

// ── KYC / onboarding gate (item 3a, server-enforced half) ──────────────────
// Extracted to lib/server/kyc-gate.ts so non-application signed routes
// (launchpad commit, OTC create, resell create) share the exact same gate;
// re-exported here so the /api/applications/* routes keep importing from
// this module unchanged. The default `context` ("applying") preserves the
// original error copy for submit/resubmit.
export {
  lookupClientKyc,
  lookupCompanyKyb,
  requireVerifiedClient,
  requireVerifiedCompany,
  type ClientKycLookup,
} from "@/lib/server/kyc-gate";

// ── application payload narrowing (manual validation, no zod) ──────────────

/** Content columns of launch_applications an applicant may set. */
export type ApplicationContent = {
  raise_type: "startup" | "mature";
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
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function reqStr(v: unknown, field: string, max: number): string {
  if (typeof v !== "string" || v.trim().length === 0) {
    throw new SiwsError(400, `${field} is required`);
  }
  const t = v.trim();
  if (t.length > max) throw new SiwsError(400, `${field} exceeds ${max} characters`);
  return t;
}

function optStr(v: unknown, field: string, max: number): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") throw new SiwsError(400, `${field} must be a string`);
  const t = v.trim();
  if (t.length === 0) return null;
  if (t.length > max) throw new SiwsError(400, `${field} exceeds ${max} characters`);
  return t;
}

function optUrl(v: unknown, field: string): string | null {
  const s = optStr(v, field, 500);
  if (s === null) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error();
  } catch {
    throw new SiwsError(400, `${field} must be a valid http(s) URL`);
  }
  return s;
}

function num(v: unknown, field: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) {
    throw new SiwsError(400, `${field} must be a number between ${min} and ${max}`);
  }
  return v;
}

function int(v: unknown, field: string, min: number, max: number): number {
  const n = num(v, field, min, max);
  if (!Number.isInteger(n)) throw new SiwsError(400, `${field} must be an integer`);
  return n;
}

/**
 * Narrow an untrusted `application` param into the insertable content columns.
 * Mirrors (slightly loosened) the /apply wizard's client-side validation.
 * `applicant_wallet` is deliberately NOT read from the payload — the routes
 * stamp the SIWS-verified wallet instead.
 */
export function narrowApplication(value: unknown): ApplicationContent {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SiwsError(400, "application must be an object");
  }
  const p = value as Record<string, unknown>;

  if (p.raise_type !== "startup" && p.raise_type !== "mature") {
    throw new SiwsError(400, "raise_type must be 'startup' or 'mature'");
  }

  const founderEmail = reqStr(p.founder_email, "founder_email", 300);
  if (!EMAIL_RE.test(founderEmail)) {
    throw new SiwsError(400, "founder_email must be a valid email address");
  }

  return {
    raise_type: p.raise_type,
    company_name: reqStr(p.company_name, "company_name", 200),
    one_liner: reqStr(p.one_liner, "one_liner", 300),
    website: optUrl(p.website, "website"),
    category: reqStr(p.category, "category", 100),
    stage: optStr(p.stage, "stage", 100),
    incorporation: optStr(p.incorporation, "incorporation", 100),
    valuation: reqStr(p.valuation, "valuation", 100),
    annual_revenue: optStr(p.annual_revenue, "annual_revenue", 100),
    existing_investors: optStr(p.existing_investors, "existing_investors", 300),
    problem_or_why: reqStr(p.problem_or_why, "problem_or_why", 5000),
    raise_amount: num(p.raise_amount, "raise_amount", 1, 3_000_000),
    equity_offered: num(p.equity_offered, "equity_offered", 0.1, 100),
    min_ticket: optStr(p.min_ticket, "min_ticket", 50),
    raise_structure: reqStr(p.raise_structure, "raise_structure", 100),
    cliff_months: int(p.cliff_months, "cliff_months", 0, 36),
    vesting_months: int(p.vesting_months, "vesting_months", 0, 60),
    founder_name: reqStr(p.founder_name, "founder_name", 200),
    founder_email: founderEmail,
    founder_twitter: optStr(p.founder_twitter, "founder_twitter", 300),
    founder_linkedin: optUrl(p.founder_linkedin, "founder_linkedin"),
    founder_why: reqStr(p.founder_why, "founder_why", 5000),
    pitch_deck: optUrl(p.pitch_deck, "pitch_deck"),
  };
}

// ── application events (server-side writes only, best-effort) ──────────────

/**
 * Insert an application_events row. Best-effort: the decision/submission
 * already succeeded — an event-log failure is logged, never surfaced.
 */
export async function insertApplicationEvent(
  sb: SupabaseClient,
  input: {
    application_id: string;
    actor: "admin" | "applicant";
    action: "submitted" | "resubmitted" | "approved" | "rejected" | "needs_changes";
    reason?: string | null;
    actor_wallet?: string | null;
  },
): Promise<void> {
  const { error } = await sb.from("application_events").insert({
    application_id: input.application_id,
    actor: input.actor,
    action: input.action,
    reason: input.reason ?? null,
    actor_wallet: input.actor_wallet ?? null,
  });
  if (error) {
    console.error("[applications] event insert failed:", error.message);
  }
}
