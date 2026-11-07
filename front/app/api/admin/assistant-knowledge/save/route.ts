import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { saveAssistantKnowledge } from "@/lib/server/assistant-knowledge";

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "assistantKnowledge.save");
    await requireAdmin(wallet);
    const entry = await saveAssistantKnowledge(params, wallet);
    return NextResponse.json({ ok: true, data: { entry } }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return siwsErrorResponse(error); }
}
