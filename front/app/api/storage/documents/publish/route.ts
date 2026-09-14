import { NextResponse } from "next/server";
import { verifySigned,siwsErrorResponse,SiwsError } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";
export async function POST(request:Request) {
  try {
    const {wallet,params}=await verifySigned(request,"storage.documents.publish");
    await requireAdmin(wallet);
    if(typeof params.id !== "string" || !/^[0-9a-f-]{36}$/i.test(params.id)) throw new SiwsError(400,"Document ID required");
    const result=await getSupabaseAdmin().rpc("publish_document_version",{p_id:params.id,p_network:detectNetwork()});
    if(result.error) {
      if(result.error.code === "P0001") throw new SiwsError(409,result.error.message);
      throw new SiwsError(503,"Document publication unavailable");
    }
    return NextResponse.json({ok:true,data:{id:params.id,version:result.data}});
  } catch(error) {return siwsErrorResponse(error);}
}
