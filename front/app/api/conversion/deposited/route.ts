import { NextResponse } from "next/server";
import { verifySigned,siwsErrorResponse,SiwsError } from "@/lib/server/siws";
import { recordCustodyDeposit } from "@/lib/server/custody-evidence";
import { notifyConversionStatus } from "@/lib/server/conversion-notifications";
export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const { wallet,params } = await verifySigned(request,"conversion.deposited");
    const id=typeof params.id==="string"?params.id:"";
    if(!id || id.length>64) throw new SiwsError(400,"id is required");
    const data=await recordCustodyDeposit("conversion_requests",id,wallet,params.deposit_tx);
    // The holder's and the operator's emails, after the response and at most
    // once per request (a re-recorded receipt finds them sent).
    if(data.status==="deposited") notifyConversionStatus(id,"deposited");
    return NextResponse.json({ ok:true,data });
  } catch(error) { return siwsErrorResponse(error); }
}
