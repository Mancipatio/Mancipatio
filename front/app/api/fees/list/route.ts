// POST /api/fees/list — admin read of fee_config + fee_waivers (one call,
// one wallet signature). Signed + requireAdmin: the schedule itself is
// borderline public, but waivers carry client ids, discount reasons and the
// granting admin's wallet — business-confidential, so the whole read sits
// behind the on-chain admin gate and the anon SELECT policy can be dropped.

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";

export async function POST(request: Request) {
  try {
    const { wallet } = await verifySigned(request, "fees.list");
    await requireAdmin(wallet);

    const sb = getSupabaseAdmin();
    const network = detectNetwork();
    const [config, waivers] = await Promise.all([
      sb
        .from("fee_config")
        .select("*")
        .eq("network", network)
        .order("fee_type", { ascending: true }),
      sb
        .from("fee_waivers")
        .select("*")
        .eq("network", network)
        .order("created_at", { ascending: false }),
    ]);
    if (config.error) {
      console.error("[api/fees/list] fee_config query failed:", config.error.message);
      throw new SiwsError(500, "Could not load the fee schedule");
    }
    if (waivers.error) {
      console.error("[api/fees/list] fee_waivers query failed:", waivers.error.message);
      throw new SiwsError(500, "Could not load fee waivers");
    }

    return NextResponse.json({
      ok: true,
      data: { config: config.data ?? [], waivers: waivers.data ?? [] },
    });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
