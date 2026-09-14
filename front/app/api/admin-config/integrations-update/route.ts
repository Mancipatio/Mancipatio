// POST /api/admin-config/integrations-update — operator-asserted status /
// notes / non-secret config for one integrations row (slugs are seeded by
// migration — no insert path exists, matching the previous UI).
//
// Signed (SIWS) + on-chain admin gate. last_checked_at is stamped
// server-side.

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";

const STATUSES = new Set([
  "not_configured",
  "configured",
  "degraded",
  "failing",
  "disabled",
]);

const SLUG_RE = /^[a-z0-9-]{1,60}$/;
const MAX_CONFIG_JSON = 8_000;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(
      request,
      "adminConfig.integrationsUpdate",
    );
    await requireAdmin(wallet);

    const slug = typeof params.slug === "string" ? params.slug : "";
    if (!SLUG_RE.test(slug)) throw new SiwsError(400, "Invalid slug");

    const status = typeof params.status === "string" ? params.status : "";
    if (!STATUSES.has(status)) throw new SiwsError(400, "Unknown status");

    const notes = typeof params.notes === "string" ? params.notes : "";
    if (notes.length > 2000) {
      throw new SiwsError(400, "notes must be at most 2000 characters");
    }

    if (!isPlainObject(params.config)) {
      throw new SiwsError(400, "config must be a JSON object");
    }
    if (JSON.stringify(params.config).length > MAX_CONFIG_JSON) {
      throw new SiwsError(400, "config is too large");
    }

    const sb = getSupabaseAdmin();
    const { data, error } = await sb
      .from("integrations")
      .update({
        status,
        notes,
        config: params.config,
        last_checked_at: new Date().toISOString(),
      })
      .eq("slug", slug)
      .select("slug")
      .maybeSingle();
    if (error) {
      console.error("[api/admin-config/integrations-update] update failed:", error.message);
      throw new SiwsError(500, "Could not save the integration");
    }
    if (!data) throw new SiwsError(404, "Integration not found");

    return NextResponse.json({ ok: true, data: { slug, status } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
