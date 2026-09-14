import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";
import { readPdas, isProfileAdmin, requireProfileOwner } from "@/lib/server/profile-read";

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "issuer-profiles.read");
    const pdas = readPdas(params.pdas);
    if (!(await isProfileAdmin(wallet))) {
      // Validate every requested address before reading any private row.
      for (const pda of pdas) await requireProfileOwner(wallet, pda, "issuer");
    }
    const { data, error } = await getSupabaseAdmin().from("issuer_profiles").select("*")
      .eq("network", detectNetwork()).in("issuer_pda", pdas);
    if (error) throw new SiwsError(503, "Profiles unavailable — try again");
    return NextResponse.json({ ok: true, data: data ?? [] }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) { return siwsErrorResponse(err); }
}
