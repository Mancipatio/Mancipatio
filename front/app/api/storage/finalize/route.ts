import { NextResponse } from "next/server";
import { verifySigned,siwsErrorResponse,SiwsError } from "@/lib/server/siws";
import { finalizeDocumentUpload } from "@/lib/server/document-versions";
export const maxDuration=60;
export async function POST(request:Request) {
  try {
    const {wallet,params}=await verifySigned(request,"storage.finalize");
    if(typeof params.uploadId !== "string" || !/^[0-9a-f-]{36}$/i.test(params.uploadId)) throw new SiwsError(400,"Upload ID is required");
    const version=await finalizeDocumentUpload(params.uploadId,wallet);
    return NextResponse.json({ok:true,data:{bucket:version.bucket,path:version.path,sha256:version.sha256,size:version.size_bytes,versionId:version.id}});
  } catch(error) {return siwsErrorResponse(error);}
}
