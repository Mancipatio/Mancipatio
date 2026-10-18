import { NextResponse } from "next/server";
import { detectNetwork } from "@/lib/network";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { requireAdmin } from "@/lib/server/admin-gate";
import { accountDirectoryOptions, readAccountDirectory } from "@/lib/server/admin-accounts";
import { boundedRequest } from "@/lib/server/bounded-request";
import { SiwsError, siwsErrorResponse, verifySigned } from "@/lib/server/siws";
import { withTimeout } from "@/lib/server/with-timeout";

export async function POST(request: Request) {
  let response: NextResponse;
  try {
    const { wallet, params } = await verifySigned(await boundedRequest(request, 4096), "admin.accountsList");
    await requireAdmin(wallet);
    const options = accountDirectoryOptions(params);
    const data = await withTimeout(12_000, (signal) => readAccountDirectory(getSupabaseAdmin(), detectNetwork(), options, signal))
      .catch(() => { throw new SiwsError(503, "The account directory is temporarily unavailable. Please try again."); });
    response = NextResponse.json({ ok: true, data });
  } catch (error) {
    response = siwsErrorResponse(error);
  }
  response.headers.set("Cache-Control", "no-store");
  return response;
}
