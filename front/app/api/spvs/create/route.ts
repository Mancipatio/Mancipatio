// POST /api/spvs/create — create an SPV row (admin registry).
//
// Signed route, platform-admin only (on-chain Admin PDA / super admin).
// Client wrapper: createSpv() in lib/spvs.ts (action "spvs.create").
// The `network` column is stamped server-side.

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const STATUSES = new Set(["planned", "incorporating", "active", "retired"]);

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "spvs.create");
    await requireAdmin(wallet);

    const name = typeof params.name === "string" ? params.name.trim() : "";
    if (!name || name.length > 200) {
      throw new SiwsError(400, "name required (≤200 chars)");
    }

    const registrationNumber =
      typeof params.registration_number === "string"
        ? params.registration_number.trim()
        : "";
    if (registrationNumber.length > 100) {
      throw new SiwsError(400, "registration_number too long");
    }

    const country =
      typeof params.country === "string" ? params.country.trim() : "688";
    if (!/^\d{1,3}$/.test(country)) {
      throw new SiwsError(400, "country must be an ISO numeric code");
    }

    const status =
      typeof params.status === "string" ? params.status : "planned";
    if (!STATUSES.has(status)) {
      throw new SiwsError(400, "Unknown SPV status");
    }

    const clientId =
      typeof params.client_id === "string" ? params.client_id.trim() : "";
    if (clientId && !UUID_RE.test(clientId)) {
      throw new SiwsError(400, "client_id must be a UUID");
    }

    const issuerPda =
      typeof params.issuer_pda === "string" ? params.issuer_pda.trim() : "";
    if (issuerPda && !BASE58_RE.test(issuerPda)) {
      throw new SiwsError(400, "issuer_pda must be a base58 address");
    }

    const incorporatedAt =
      typeof params.incorporated_at === "string"
        ? params.incorporated_at.trim()
        : "";
    if (incorporatedAt && !DATE_RE.test(incorporatedAt)) {
      throw new SiwsError(400, "incorporated_at must be YYYY-MM-DD");
    }

    const notes = typeof params.notes === "string" ? params.notes : "";
    if (notes.length > 5000) {
      throw new SiwsError(400, "notes too long (≤5000 chars)");
    }

    const sb = getSupabaseAdmin();
    const { data, error } = await sb
      .from("spvs")
      .insert({
        network: detectNetwork(),
        name,
        registration_number: registrationNumber || null,
        country,
        status,
        client_id: clientId || null,
        issuer_pda: issuerPda || null,
        incorporated_at: incorporatedAt || null,
        notes,
      })
      .select("id")
      .single();
    if (error || !data) {
      console.error("[api/spvs/create] insert failed:", error?.message);
      throw new SiwsError(500, "SPV insert failed");
    }

    return NextResponse.json({ ok: true, data: { id: data.id as string } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
