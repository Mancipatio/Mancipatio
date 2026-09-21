// POST /api/verification/submit — self-service KYC (individual) or KYB
// (company) intake from /verify. Signed; the dossier is always the signer's.
//
// Stores the submitted details (client_verification_details, service role
// only), links or provisions the wallet's dossier, requests the matching
// document checklist and returns the /onboarding upload link. An individual
// KYC also files the passport request the /admin/kyc queue works from.
// Verification itself stays a compliance decision in the admin console.

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { boundedRequest } from "@/lib/server/bounded-request";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { isDefaultApprovedJurisdiction } from "@/lib/passport";
import { clientIpOf, DEGRADED_TTL_MESSAGE, insertNote, rateLimited } from "../../clients/_helpers";
import {
  ensureClientDossier, ensureStandardRequirements,
  STANDARD_COMPANY_REQUIREMENTS, STANDARD_INVESTOR_REQUIREMENTS,
} from "@/lib/server/kyc-dossier";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[0-9 ()-]{5,32}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DETAIL_KEYS = [
  "kind", "legal_name", "date_of_birth", "nationality", "residence_country", "address_line", "city",
  "postal_code", "phone", "email", "company_name", "company_reg_number", "company_country",
  "company_address", "company_website", "representative_role",
] as const;

function text(params: Record<string, unknown>, key: string, min: number, max: number, required: boolean): string | null {
  const raw = params[key];
  if (raw === undefined || raw === null || raw === "") {
    if (required) throw new SiwsError(400, `${key.replaceAll("_", " ")} is required`);
    return null;
  }
  if (typeof raw !== "string") throw new SiwsError(400, `${key} must be text`);
  const value = raw.trim().replace(/\s+/g, " ");
  if (value.length < min || value.length > max) {
    if (!required && value.length === 0) return null;
    throw new SiwsError(400, `${key.replaceAll("_", " ")} must be ${min}–${max} characters`);
  }
  return value;
}

function country(params: Record<string, unknown>, key: string, required: boolean, approvedOnly: boolean): number | null {
  const raw = params[key];
  if (raw === undefined || raw === null || raw === "") {
    if (required) throw new SiwsError(400, `${key.replaceAll("_", " ")} is required`);
    return null;
  }
  const code = typeof raw === "string" ? Number.parseInt(raw, 10) : raw;
  if (typeof code !== "number" || !Number.isInteger(code) || code < 1 || code > 999) {
    throw new SiwsError(400, `${key} must be an ISO numeric country code`);
  }
  if (approvedOnly && !isDefaultApprovedJurisdiction(code)) {
    throw new SiwsError(400, "This country is not supported for verification yet");
  }
  return code;
}

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(await boundedRequest(request, 8192), "verification.submit");
    for (const key of Object.keys(params)) {
      if (!(DETAIL_KEYS as readonly string[]).includes(key)) throw new SiwsError(400, `Unknown field: ${key}`);
    }
    const kind = params.kind;
    if (kind !== "kyc" && kind !== "kyb") throw new SiwsError(400, "kind must be kyc or kyb");
    const ip = clientIpOf(request);
    if (rateLimited(`verification:ip:${ip}`, 10, 60_000) || rateLimited(`verification:wallet:${wallet}`, 6, 3_600_000)) {
      throw new SiwsError(429, "Too many submissions — try again later");
    }

    const isKyb = kind === "kyb";
    const dob = text(params, "date_of_birth", 10, 10, !isKyb);
    if (dob) {
      const parsed = Date.parse(`${dob}T00:00:00Z`);
      const age = (Date.now() - parsed) / (365.25 * 24 * 3600 * 1000);
      if (!DATE_RE.test(dob) || !Number.isFinite(parsed) || age < 18 || age > 120) {
        throw new SiwsError(400, "You must be at least 18 years old");
      }
    }
    const email = text(params, "email", 3, 254, true);
    if (email && !EMAIL_RE.test(email)) throw new SiwsError(400, "Enter a valid email address");
    const phone = text(params, "phone", 5, 32, false);
    if (phone && !PHONE_RE.test(phone)) throw new SiwsError(400, "Enter a valid phone number");
    const website = text(params, "company_website", 4, 300, false);
    if (website && !/^https?:\/\/[^\s]+\.[^\s]+$/i.test(website)) throw new SiwsError(400, "Website must start with http:// or https://");

    const residence = country(params, "residence_country", true, !isKyb)!;
    const companyCountry = country(params, "company_country", isKyb, isKyb);
    const details = {
      kind,
      legal_name: text(params, "legal_name", 2, 200, true)!,
      date_of_birth: dob,
      nationality: country(params, "nationality", !isKyb, false),
      residence_country: residence,
      address_line: text(params, "address_line", 3, 300, true)!,
      city: text(params, "city", 1, 120, true)!,
      postal_code: text(params, "postal_code", 1, 20, true)!,
      phone,
      email: email!.toLowerCase(),
      company_name: isKyb ? text(params, "company_name", 2, 200, true) : null,
      company_reg_number: isKyb ? text(params, "company_reg_number", 1, 64, true) : null,
      company_country: isKyb ? companyCountry : null,
      company_address: isKyb ? text(params, "company_address", 3, 300, true) : null,
      company_website: isKyb ? website : null,
      representative_role: isKyb ? text(params, "representative_role", 2, 120, true) : null,
    };

    const sb = getSupabaseAdmin();
    // The on-chain passport jurisdiction is the residence (KYC) or the
    // company's country (KYB); both must be in the approved set.
    const jurisdiction = isKyb ? details.company_country! : residence;
    const { client, token, created, linkUnusable } = await ensureClientDossier(
      sb, wallet, jurisdiction, isKyb ? "issuer" : "investor", isKyb ? "verification-kyb" : "verification-kyc",
    );

    const { error: detailsErr } = await sb.from("client_verification_details").upsert({
      client_id: client.id, ...details, submitted_by_wallet: wallet, submitted_at: new Date().toISOString(),
    }, { onConflict: "client_id,kind" });
    if (detailsErr) {
      console.error("[api/verification/submit] details upsert failed:", detailsErr.code);
      throw new SiwsError(500, "Could not save your details. Please try again.");
    }

    // Fill profile fields only where compliance has not set them already.
    const patch: Record<string, unknown> = {};
    if (!client.email) patch.email = details.email;
    if (isKyb) patch.company_name = details.company_name;
    const { data: current } = await sb.from("clients").select("display_name").eq("id", client.id).maybeSingle();
    const name = (current?.display_name as string | null) ?? "";
    // Replace only the auto-generated placeholder ("Investor 7xGL…hjjs").
    if (!name || /^(Investor|Issuer) \S+…\S+$/.test(name)) patch.display_name = isKyb ? details.company_name : details.legal_name;
    if (Object.keys(patch).length > 0) {
      const { error: patchErr } = await sb.from("clients").update(patch).eq("id", client.id);
      if (patchErr) console.warn("[api/verification/submit] dossier patch failed:", patchErr.code);
    }

    await ensureStandardRequirements(sb, client, isKyb ? STANDARD_COMPANY_REQUIREMENTS : STANDARD_INVESTOR_REQUIREMENTS,
      isKyb ? "Requested with your company (KYB) verification." : "Requested with your identity (KYC) verification.",
      isKyb ? "system:verification-kyb" : "system:verification-kyc");

    if (!isKyb) {
      // One undecided passport request per wallet feeds the /admin/kyc queue.
      const { data: open } = await sb.from("passport_requests").select("id")
        .eq("wallet", wallet).in("status", ["new", "in_review"]).limit(1);
      if (!open || open.length === 0) {
        const { error } = await sb.from("passport_requests").insert({ wallet, jurisdiction, note: "Submitted from /verify" });
        if (error) console.warn("[api/verification/submit] passport request insert failed:", error.code);
      }
    }

    await insertNote(sb, client.id, wallet,
      `${isKyb ? "Company (KYB)" : "Identity (KYC)"} details submitted from /verify${created ? " — dossier auto-provisioned" : ""}.`,
      "kyc-event");

    return NextResponse.json({ ok: true, data: {
      client_id: client.id,
      kyc_status: client.kyc_status,
      onboarding_path: token && !linkUnusable ? `/onboarding/${client.id}?t=${token}` : null,
      onboarding_notice: token && linkUnusable ? DEGRADED_TTL_MESSAGE : null,
    } }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return siwsErrorResponse(error);
  }
}
