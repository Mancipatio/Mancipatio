import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse } from "@/lib/server/siws";
import {
  ownedVestingRequest,
  readVestingCreationState,
} from "@/lib/server/vesting-creation";
import { getSupabaseAdmin } from "@/lib/supabase-server";

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(
      request,
      "vesting-series.creation-state",
    );
    const row = await ownedVestingRequest(params.id, wallet);
    const series = await readVestingCreationState(row);
    const { data, error } = await getSupabaseAdmin()
      .from("vesting_creation_steps")
      .select("step_key,signature,state,slot")
      .eq("request_id", row.id)
      .eq("network", row.network)
      .order("created_at", { ascending: true });
    if (error) throw new Error("Could not load creation receipts");
    return NextResponse.json({
      ok: true,
      data: {
        exists: series !== null,
        positionsCount: series?.positionsCount ?? 0,
        status: series?.status ?? null,
        deposited: series?.deposited.toString() ?? "0",
        totalAllocated: series?.totalAllocated.toString() ?? "0",
        receipts: data ?? [],
      },
    });
  } catch (error) {
    return siwsErrorResponse(error);
  }
}
