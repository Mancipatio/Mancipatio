// POST /api/clients/update — admin edits identity fields (SIWS + requireAdmin).
// Action: "clients.update". Client half: lib/clients.ts updateClient().

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { CLIENT_TYPES, assertUuid, fetchClientOr404, optString } from "../_helpers";

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "clients.update");
    await requireAdmin(wallet);

    const id = assertUuid(params.id, "id");
    const patch: Record<string, unknown> = {};

    // Optional string fields — only present keys are written.
    for (const [key, max] of [
      ["display_name", 200],
      ["email", 320],
      ["company_name", 200],
      ["jurisdiction", 8],
      ["tier", 40],
      ["source", 100],
    ] as const) {
      if (key in params) patch[key] = optString(params, key, max);
    }

    if ("tags" in params) {
      const raw = params.tags;
      if (!Array.isArray(raw) || raw.length > 24) {
        throw new SiwsError(400, "tags must be an array of at most 24 strings");
      }
      patch.tags = raw.map((t) => {
        if (typeof t !== "string" || t.length === 0 || t.length > 50) {
          throw new SiwsError(400, "tags entries must be 1–50 character strings");
        }
        return t;
      });
    }

    if ("types" in params) {
      const raw = params.types;
      if (!Array.isArray(raw) || raw.length === 0 || raw.length > 4) {
        throw new SiwsError(400, "types must be a non-empty array");
      }
      const types = [...new Set(raw)].map((t) => {
        if (
          typeof t !== "string" ||
          !(CLIENT_TYPES as readonly string[]).includes(t)
        ) {
          throw new SiwsError(400, `types entries must be one of: ${CLIENT_TYPES.join(", ")}`);
        }
        return t;
      });
      patch.types = types;
      // Keep legacy `type` synced to types[0] (house behavior).
      patch.type = types[0];
    }

    if (Object.keys(patch).length === 0) {
      throw new SiwsError(400, "No editable fields in patch");
    }

    const sb = getSupabaseAdmin();
    await fetchClientOr404(sb, id);
    const { error } = await sb.from("clients").update(patch).eq("id", id);
    if (error) {
      console.warn("[api/clients/update] failed:", error.message);
      throw new SiwsError(500, error.message);
    }

    return NextResponse.json({ ok: true, data: { updated: true } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
