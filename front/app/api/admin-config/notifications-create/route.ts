// POST /api/admin-config/notifications-create — compose one broadcast row
// (draft or scheduled). Delivery still does not exist — this route only
// records the draft/schedule lifecycle, exactly like the previous inline
// insert. author is stamped with the VERIFIED signer wallet server-side.
//
// Signed (SIWS) + on-chain admin gate.

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";

const KINDS = new Set(["email", "in-app", "both"]);
const AUDIENCES = new Set([
  "all",
  "issuers",
  "verified-issuers",
  "investors",
  "pending-kyc",
  "tag",
  "wallet",
]);
const TEMPLATE_RE = /^[a-z0-9-]{1,60}$/;

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(
      request,
      "adminConfig.notificationsCreate",
    );
    await requireAdmin(wallet);

    const kind = typeof params.kind === "string" ? params.kind : "";
    if (!KINDS.has(kind)) throw new SiwsError(400, "Unknown kind");

    const audience = typeof params.audience === "string" ? params.audience : "";
    if (!AUDIENCES.has(audience)) throw new SiwsError(400, "Unknown audience");

    let audienceParam: string | null = null;
    if (audience === "tag" || audience === "wallet") {
      if (params.audience_param !== undefined && params.audience_param !== null) {
        if (
          typeof params.audience_param !== "string" ||
          params.audience_param.trim().length > 120
        ) {
          throw new SiwsError(400, "audience_param must be at most 120 characters");
        }
        audienceParam = params.audience_param.trim() || null;
      }
    }

    const subject =
      typeof params.subject === "string" ? params.subject.trim() : "";
    if (subject.length === 0 || subject.length > 300) {
      throw new SiwsError(400, "subject must be 1–300 characters");
    }
    const body = typeof params.body === "string" ? params.body : "";
    if (body.trim().length === 0 || body.length > 20_000) {
      throw new SiwsError(400, "body must be 1–20000 characters");
    }

    let template: string | null = null;
    if (params.template !== undefined && params.template !== null) {
      if (typeof params.template !== "string" || !TEMPLATE_RE.test(params.template)) {
        throw new SiwsError(400, "Invalid template slug");
      }
      template = params.template;
    }

    const status = typeof params.status === "string" ? params.status : "";
    if (status !== "draft" && status !== "scheduled") {
      throw new SiwsError(400, "status must be 'draft' or 'scheduled'");
    }
    let scheduledFor: string | null = null;
    if (status === "scheduled") {
      if (
        typeof params.scheduled_for !== "string" ||
        Number.isNaN(Date.parse(params.scheduled_for))
      ) {
        throw new SiwsError(400, "scheduled_for must be an ISO timestamp");
      }
      scheduledFor = new Date(params.scheduled_for).toISOString();
    }

    const sb = getSupabaseAdmin();
    const { data, error } = await sb
      .from("notifications")
      .insert({
        kind,
        audience,
        audience_param: audienceParam,
        subject,
        body,
        template,
        status,
        scheduled_for: scheduledFor,
        author: wallet,
      })
      .select("id")
      .single();
    if (error) {
      console.error("[api/admin-config/notifications-create] insert failed:", error.message);
      throw new SiwsError(500, "Could not save the broadcast");
    }

    return NextResponse.json({ ok: true, data: { id: data.id, status } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
