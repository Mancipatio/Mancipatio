import {createHash} from "node:crypto";
import {beforeEach,describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
const mocks=vi.hoisted(()=>({client:vi.fn()}));
vi.mock("@/lib/supabase-server",()=>({getSupabaseAdmin:mocks.client}));
vi.mock("@/lib/network",()=>({detectNetwork:()=>"devnet"}));
vi.mock("@/lib/server/siws",()=>({SiwsError:class extends Error {constructor(public status:number,message:string){super(message);}}}));
import {finalizeDocumentUpload} from "@/lib/server/document-versions";
import {DOCUMENT_STAGING_BUCKET} from "@/lib/document-integrity";
type Row=Record<string,unknown>;
const id="10000000-0000-4000-8000-000000000001",versionId="10000000-0000-4000-8000-000000000002";
const bytes=Buffer.from("%PDF-1.7\nApproved issuer terms"),sha=createHash("sha256").update(bytes).digest("hex");
const path=`whitepapers/asset/devnet/${sha}/terms.pdf`;
let tables:Record<string,Row[]>,objects:Map<string,Blob>,failVersionWrite:boolean,publicWrites:number;
function fakeClient() {
  return {from(table:string){
    const filters:((row:Row)=>boolean)[]= [];let action="select",values:Row={};
    const execute=()=>{
      if(action==="upsert") {
        if(failVersionWrite){failVersionWrite=false;return {data:null,error:{message:"DB down"}};}
        const exists=tables[table].some(row=>row.network===values.network && row.bucket===values.bucket && row.path===values.path);
        if(!exists) tables[table].push({id:versionId,verified_at:new Date().toISOString(),...values});
        return {data:null,error:null};
      }
      const rows=tables[table].filter(row=>filters.every(f=>f(row)));
      if(action==="update") rows.forEach(row=>Object.assign(row,values));
      return {data:rows[0] ?? null,error:null};
    };
    const query={select(){return query;},eq(key:string,value:unknown){filters.push(row=>row[key]===value);return query;},
      upsert(value:Row){action="upsert";values=value;return query;},update(value:Row){action="update";values=value;return query;},
      maybeSingle:async()=>execute(),then(resolve:(result:ReturnType<typeof execute>)=>unknown){return Promise.resolve(execute()).then(resolve);}};
    return query;
  },storage:{from(bucket:string){return {
    async download(name:string){return objects.has(bucket+"/"+name)?{data:objects.get(bucket+"/"+name),error:null}:{data:null,error:{message:"not found"}};},
    async upload(name:string,data:Uint8Array,options:{upsert:boolean}){
      expect(options.upsert).toBe(false);
      if(objects.has(bucket+"/"+name)) return {error:{message:"already exists"}};
      objects.set(bucket+"/"+name,new Blob([new Uint8Array(data)]));publicWrites++;return {error:null};
    },
    async remove(names:string[]){expect(bucket).toBe(DOCUMENT_STAGING_BUCKET);names.forEach(name=>objects.delete(bucket+"/"+name));return {error:null};},
  };}}};
}
beforeEach(()=>{
  tables={document_uploads:[{id,network:"devnet",wallet:"issuer",bucket:"documents",path,staging_path:"private-upload",sha256:sha,size_bytes:bytes.length,mime_type:"application/pdf"}],document_versions:[]};
  objects=new Map([[DOCUMENT_STAGING_BUCKET+"/private-upload",new Blob([bytes])]]);failVersionWrite=false;publicWrites=0;
  mocks.client.mockReturnValue(fakeClient());
});
describe("server verification of stored document bytes",()=>{
  it("publishes only the bytes the server actually hashed and records an immutable version",async()=>{
    const result=await finalizeDocumentUpload(id,"issuer");
    expect(result).toMatchObject({id:versionId,sha256:sha,path,size_bytes:bytes.length});
    expect(await objects.get("documents/"+path)!.text()).toBe(bytes.toString());
    expect(objects.has(DOCUMENT_STAGING_BUCKET+"/private-upload")).toBe(false);
  });
  it("rejects a forged declaration without creating public content",async()=>{
    tables.document_uploads[0].sha256="b".repeat(64);
    await expect(finalizeDocumentUpload(id,"issuer")).rejects.toMatchObject({status:400});
    expect(publicWrites).toBe(0);expect(tables.document_versions).toHaveLength(0);
  });
  it("keeps upload authorization scoped to the signing wallet",async()=>{
    await expect(finalizeDocumentUpload(id,"other")).rejects.toMatchObject({status:404});expect(publicWrites).toBe(0);
  });
  it("resumes a successful file copy after DB failure without overwriting it",async()=>{
    failVersionWrite=true;
    await expect(finalizeDocumentUpload(id,"issuer")).rejects.toMatchObject({status:503});
    await expect(finalizeDocumentUpload(id,"issuer")).resolves.toMatchObject({id:versionId});
    await expect(finalizeDocumentUpload(id,"issuer")).resolves.toMatchObject({id:versionId});
    expect(publicWrites).toBe(1);expect(tables.document_versions).toHaveLength(1);
  });
  it("cannot overwrite a different existing public object",async()=>{
    objects.set("documents/"+path,new Blob(["different content"]));
    await expect(finalizeDocumentUpload(id,"issuer")).rejects.toMatchObject({status:409});
    expect(await objects.get("documents/"+path)!.text()).toBe("different content");expect(tables.document_versions).toHaveLength(0);
  });
});
