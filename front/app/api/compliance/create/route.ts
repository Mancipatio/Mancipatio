// POST /api/compliance/create — raise (tag) an AML/sanctions alert from the
// /admin/compliance workbench.
//
// Signed route, platform-admin only. `network` is stamped server-side; the
// row starts in the default 'open' status (resolution fields untouched).
// Client wrapper: createAlert() in lib/compliance.ts
// (action "compliance.create").

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEVERITIES = new Set(["low", "medium", "high", "critical"]);
const MAX_EVIDENCE_JSON = 10_000;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "compliance.create");
    await requireAdmin(wallet);

    const clientId =
      typeof params.client_id === "string" ? params.client_id.trim() : "";
    if (clientId && !UUID_RE.test(clientId)) {
      throw new SiwsError(400, "client_id must be a UUID");
    }
    const subjectWallet =
      typeof params.wallet === "string" ? params.wallet.trim() : "";
    if (subjectWallet.length > 64) {
      throw new SiwsError(400, "wallet too long");
    }
    if (!clientId && !subjectWallet) {
      throw new SiwsError(400, "Provide a client_id or a wallet");
    }

    const source =
      typeof params.source === "string" ? params.source.trim() : "manual";
    if (!source || source.length > 64) {
      throw new SiwsError(400, "source required (≤64 chars)");
    }

    const severity =
      typeof params.severity === "string" ? params.severity : "";
    if (!SEVERITIES.has(severity)) {
      throw new SiwsError(400, "Unknown severity");
    }

    const confidence =
      typeof params.confidence === "number" ? params.confidence : NaN;
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 100) {
      throw new SiwsError(400, "confidence must be 0–100");
    }

    const hitList =
      typeof params.hit_list === "string" ? params.hit_list : "";
    if (hitList.length > 2000) {
      throw new SiwsError(400, "hit_list too long (≤2000 chars)");
    }

    const evidence = isPlainObject(params.evidence) ? params.evidence : {};
    if (JSON.stringify(evidence).length > MAX_EVIDENCE_JSON) {
      throw new SiwsError(400, "evidence payload too large");
    }

    const summary =
      typeof params.summary === "string" ? params.summary.trim() : "";
    if (summary.length > 5000) {
      throw new SiwsError(400, "summary too long (≤5000 chars)");
    }

    const txSignature =
      typeof params.tx_signature === "string" ? params.tx_signature.trim() : "";
    if (txSignature.length > 120) {
      throw new SiwsError(400, "tx_signature too long");
    }

    const sb = getSupabaseAdmin();
    const { data, error } = await sb
      .from("compliance_alerts")
      .insert({
        network: detectNetwork(),
        client_id: clientId || null,
        wallet: subjectWallet || null,
        source,
        severity,
        confidence,
        hit_list: hitList,
        evidence,
        summary,
        tx_signature: txSignature || null,
      })
      .select("id")
      .single();
    if (error || !data) {
      console.error("[api/compliance/create] insert failed:", error?.message);
      throw new SiwsError(500, "Alert insert failed");
    }

    return NextResponse.json({ ok: true, data: { id: data.id as string } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
