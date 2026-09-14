// Authorize a private staging upload. The finalize route hashes stored bytes
// before creating the immutable destination; clients never get a write token
// for a published object.
import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { verifySigned,siwsErrorResponse,SiwsError } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";
import { requireProfileOwner } from "@/lib/server/profile-read";
import { documentDestination,DOCUMENT_MAX_BYTES,DOCUMENT_STAGING_BUCKET } from "@/lib/document-integrity";
import { bucketForPrefix } from "../_lib";

const MIME_ALLOWLIST=new Set(["application/pdf","image/png","image/jpeg","application/vnd.openxmlformats-officedocument.wordprocessingml.document"]);
const ADMIN_PREFIXES=new Set(["legal","kyb-template","issuer-agreement","compliance","marketing","other"]);
async function requireUploader(wallet:string,path:string) {
  const parts=path.split("/");
  if(parts[0] !== "whitepapers") {
    if(!ADMIN_PREFIXES.has(parts[0])) throw new SiwsError(400,"Unknown document category");
    await requireAdmin(wallet);return;
  }
  try {await requireAdmin(wallet);return;} catch(error) {
    if(!(error instanceof SiwsError) || error.status !== 403) throw error;
  }
  await requireProfileOwner(wallet,parts[1],"asset");
}
export async function POST(request:Request) {
  try {
    const {wallet,params}=await verifySigned(request,"storage.upload");
    if(params.bucket !== "documents") throw new SiwsError(400,"Invalid logical bucket");
    if(typeof params.path !== "string" || typeof params.sha256 !== "string") throw new SiwsError(400,"Path and SHA-256 required");
    let path:string;
    try {path=documentDestination(params.path,params.sha256,detectNetwork());} catch(error) {throw new SiwsError(400,(error as Error).message);}
    if(typeof params.contentType !== "string" || !MIME_ALLOWLIST.has(params.contentType)) throw new SiwsError(400,"Unsupported document type");
    if(typeof params.size !== "number" || !Number.isInteger(params.size) || params.size <= 0 || params.size > DOCUMENT_MAX_BYTES) throw new SiwsError(400,"File must be between 1 byte and 25 MB");
    await requireUploader(wallet,path);
    const id=randomUUID(),bucket=bucketForPrefix(path.split("/")[0]),stagingPath=detectNetwork()+"/"+wallet+"/"+id;
    const sb=getSupabaseAdmin();
    const saved=await sb.from("document_uploads").insert({id,network:detectNetwork(),wallet,bucket,path,staging_path:stagingPath,sha256:params.sha256,size_bytes:params.size,mime_type:params.contentType});
    if(saved.error) throw new SiwsError(503,"Could not persist upload authorization");
    const signed=await sb.storage.from(DOCUMENT_STAGING_BUCKET).createSignedUploadUrl(stagingPath,{upsert:false});
    if(signed.error || !signed.data) throw new SiwsError(503,"Could not authorize private upload");
    return NextResponse.json({ok:true,data:{uploadId:id,bucket:DOCUMENT_STAGING_BUCKET,path:stagingPath,token:signed.data.token,sha256:params.sha256,size:params.size}});
  } catch(error) {return siwsErrorResponse(error);}
}
