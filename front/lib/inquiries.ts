"use client";

// Custom tokenization inquiries (Flows doc section 8 "Other"): an interested
// party contacts us -> we evaluate -> propose a solution -> separate process.
// Backed by `custom_inquiries` (migration 0023).
//
// SERVER-SIDE since W2-SD4: this table holds PII, so nothing here touches the
// anon Supabase client anymore (W3-RLS drops all anon policies on it).
//   - createInquiry  -> plain POST /api/inquiries/create (public contact form;
//     honeypot + rate limit server-side)
//   - listInquiries / updateInquiry -> signed admin routes (SIWS + on-chain
//     admin gate); both now take the connected WalletSession as FIRST param.

import type { WalletSession } from "@solana/client";
import { signedFetch } from "@/lib/siws-client";
import { notifyAdminBadges } from "@/lib/admin-badges-events";

export type InquiryStatus =
  | "new"
  | "in_review"
  | "proposed"
  | "agreed"
  | "rejected"
  | "archived";

export const INQUIRY_STATUSES: InquiryStatus[] = [
  "new",
  "in_review",
  "proposed",
  "agreed",
  "rejected",
  "archived",
];

export type CustomInquiry = {
  id: string;
  created_at: string;
  updated_at: string;
  network: string;
  name: string;
  email: string;
  company: string | null;
  asset_kind: string | null;
  idea: string;
  status: InquiryStatus;
  admin_note: string | null;
  handled_by: string | null;
  handled_at: string | null;
};

export type CustomInquiryInput = {
  name: string;
  email: string;
  company?: string;
  asset_kind?: string;
  idea: string;
  /** Honeypot — rendered invisibly on the contact form; humans leave it empty.
   *  A non-empty value makes the server silently drop the submission. */
  website?: string;
  /** Single-use Cloudflare Turnstile token (only when the build renders the
   *  widget; the server requires it when TURNSTILE_SECRET_KEY is set). */
  turnstile_token?: string;
};

/** Public contact-form submit. Returns the new inquiry id, or null on failure
 *  (graceful degradation — the form shows a retry message). */
export async function createInquiry(
  input: CustomInquiryInput,
): Promise<string | null> {
  try {
    const res = await fetch("/api/inquiries/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    type Envelope = { ok?: boolean; data?: { id?: string }; error?: string };
    let json: Envelope | null = null;
    try {
      json = (await res.json()) as Envelope;
    } catch {
      // Non-JSON response — treated as failure below.
    }
    if (!res.ok || !json || json.ok !== true || !json.data?.id) {
      console.warn(
        "[inquiries] create failed:",
        json?.error ?? `HTTP ${res.status}`,
      );
      return null;
    }
    return json.data.id;
  } catch (err) {
    console.warn("[inquiries] create threw:", err);
    return null;
  }
}

/**
 * Admin-only list (signed). THROWS on failure (rejected signature, transport
 * error, 401/403/500) rather than returning [] — a swallowed error would render
 * an empty inbox indistinguishable from "no inquiries", hiding that the load
 * never happened. Callers should surface the error and offer a retry.
 */
export async function listInquiries(
  session: WalletSession | null | undefined,
  status?: InquiryStatus,
): Promise<CustomInquiry[]> {
  const data = await signedFetch<{ inquiries: CustomInquiry[] }>(
    session,
    "/api/inquiries/list",
    "inquiries.list",
    status ? { status } : {},
  );
  return data.inquiries ?? [];
}

/**
 * Admin-only triage update (signed). Only `status` and `admin_note` are sent —
 * handled_by / handled_at are stamped server-side from the verified wallet on
 * status changes (any values passed here are ignored, kept in the patch type
 * only for call-site compatibility).
 */
export async function updateInquiry(
  session: WalletSession | null | undefined,
  id: string,
  patch: Partial<
    Pick<CustomInquiry, "status" | "admin_note" | "handled_by" | "handled_at">
  >,
): Promise<boolean> {
  try {
    const params: Record<string, unknown> = { id };
    if (patch.status !== undefined) params.status = patch.status;
    if (patch.admin_note !== undefined) params.admin_note = patch.admin_note;
    await signedFetch(session, "/api/inquiries/update", "inquiries.update", params);
    notifyAdminBadges();
    return true;
  } catch (err) {
    console.warn("[inquiries] update failed:", err);
    return false;
  }
}
