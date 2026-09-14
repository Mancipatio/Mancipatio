import { NextResponse } from "next/server";
import { verifySigned,siwsErrorResponse } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { reconcilePurchases } from "@/lib/server/purchase-records";
export const maxDuration = 60;
export async function POST(request: Request) {
  try {
    const { wallet } = await verifySigned(request,"admin.reconcilePurchases");
    await requireAdmin(wallet);
    return NextResponse.json({ ok:true,data:await reconcilePurchases() });
  } catch(error) { return siwsErrorResponse(error); }
}
