// GET /api/archive/list — public: the archived asset and issuer PDAs of this
// network (lib/archive.ts). Only addresses, which are public on chain anyway;
// the reasons and who archived stay behind /api/archive/check.
import { NextResponse } from "next/server";
import { siwsErrorResponse } from "@/lib/server/siws";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { readArchivedSet } from "@/lib/server/archive";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const data = await readArchivedSet(getSupabaseAdmin());
    return NextResponse.json({ ok: true, data }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
