import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { deleteAssistantKnowledge } from "@/lib/server/assistant-knowledge";

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "assistantKnowledge.delete");
    await requireAdmin(wallet);
    const data = await deleteAssistantKnowledge(params);
    return NextResponse.json({ ok: true, data }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return siwsErrorResponse(error); }
}
