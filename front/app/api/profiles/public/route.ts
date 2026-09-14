import { NextResponse } from "next/server";
import { SiwsError, siwsErrorResponse } from "@/lib/server/siws";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";
import { readPdas } from "@/lib/server/profile-read";
import { CATEGORY_SLUGS } from "@/lib/asset-types";
import { PUBLIC_ASSET_PROFILE_FIELDS, projectPublicAssetProfile } from "@/lib/profile-public";

export async function POST(request: Request) {
  try {
    const params = await request.json().catch(() => { throw new SiwsError(400, "Invalid JSON body"); });
    if (!params || typeof params !== "object" || Array.isArray(params)) throw new SiwsError(400, "Invalid request");
    const offset = params.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) throw new SiwsError(400, "Invalid page");
    if (params.category !== undefined && !CATEGORY_SLUGS.includes(params.category)) throw new SiwsError(400, "Invalid category");
    const pdas = params.pdas === undefined ? null : readPdas(params.pdas);
    let query = getSupabaseAdmin().from("asset_profiles")
      .select([...PUBLIC_ASSET_PROFILE_FIELDS, "spv_id"].join(","))
      .eq("network", detectNetwork()).eq("is_published", true).eq("status", "published")
      .order("asset_pda", { ascending: true }).range(offset, offset + 99);
    if (pdas) query = query.in("asset_pda", pdas);
    if (params.category !== undefined) query = query.eq("category", params.category);
    const { data, error } = await query;
    if (error) throw new SiwsError(503, "Published profiles unavailable — try again");
    const rows = (data ?? []).map((row) => projectPublicAssetProfile(row as unknown as Record<string, unknown>)).filter((row) => row !== null);
    // Preserve the public legal-entity label without exposing SPV bookkeeping,
    // client linkage, internal IDs or notes through a browser-wide table read.
    const visible = new Set(rows.map((row) => row.asset_pda));
    const links = new Map((data ?? []).map((value) => {
      const row = value as unknown as { asset_pda: string; spv_id?: string };
      return [row.asset_pda, visible.has(row.asset_pda) ? row.spv_id : undefined] as const;
    }));
    const spvIds = [...new Set([...links.values()].filter((id): id is string => typeof id === "string"))];
    if (spvIds.length) {
      const { data: spvs, error: spvError } = await getSupabaseAdmin().from("spvs")
        .select("id,name").eq("network", detectNetwork()).in("id", spvIds);
      if (spvError) throw new SiwsError(503, "Published legal entities unavailable — try again");
      const names = new Map((spvs ?? []).map((spv) => [spv.id, spv.name]));
      for (const row of rows) row.spv_name = names.get(links.get(row.asset_pda) ?? "") ?? null;
    }
    return NextResponse.json({ ok: true, data: rows }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) { return siwsErrorResponse(err); }
}
