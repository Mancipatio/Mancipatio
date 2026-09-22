// POST /api/auth/logout — end the email/Google account session.
import { NextResponse } from "next/server";
import { siwsErrorResponse } from "@/lib/server/siws";
import { assertSameSite, clearAccountSession } from "@/lib/server/auth-login";

export async function POST(request: Request) {
  try {
    const origin = assertSameSite(request);
    return clearAccountSession(NextResponse.json({ ok: true, data: { signed_out: true } }), origin);
  } catch (error) {
    return siwsErrorResponse(error);
  }
}
