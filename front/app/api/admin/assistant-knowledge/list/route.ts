import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { listAssistantKnowledge } from "@/lib/server/assistant-knowledge";

export async function POST(request: Request) {
  try {
    const { wallet } = await verifySigned(request, "assistantKnowledge.list");
    await requireAdmin(wallet);
    const entries = await listAssistantKnowledge();
    return NextResponse.json({ ok: true, data: { entries } }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return siwsErrorResponse(error); }
}
