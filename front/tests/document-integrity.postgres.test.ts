import {readFileSync} from "node:fs";
import {join} from "node:path";
import {afterAll,beforeAll,beforeEach,describe,expect,it} from "vitest";
import {LocalPostgres} from "./helpers/local-postgres";
const db=new LocalPostgres(),sql=(query:string)=>db.query(query);
const v1="10000000-0000-4000-8000-000000000001",v2="10000000-0000-4000-8000-000000000002";
const sha="a".repeat(64),asset="asset";
describe.skipIf(process.env.RUN_LOCAL_POSTGRES_TESTS!=="1")("0048 verified documents on isolated PostgreSQL",()=>{
  beforeAll(()=>{
    try {
      db.initialize();
      sql(`create role anon;create role authenticated;create role service_role bypassrls;
        create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
        create table commitments(id uuid primary key default gen_random_uuid(),network text,sale_pubkey text,investor_wallet text,amount numeric,status text);
        create table asset_profiles(asset_pda text,network text default 'devnet',whitepaper_path text,whitepaper_sha256 text,ssc_decision_doc_path text,ssc_decision_doc_sha256 text);
        create table documents(id uuid primary key default gen_random_uuid(),category text,slug text,version integer,storage_path text,sha256 text,size_bytes integer,mime_type text,published boolean default false,published_at timestamptz);
        grant all on documents to service_role;`);
      sql(readFileSync(join(process.cwd(),"supabase/migrations/0048_documents_integrity.sql"),"utf8"));
    } catch(error) {db.close();throw error;}
  },30_000);
  afterAll(()=>db.close());
  beforeEach(()=>sql("truncate document_uploads,asset_profiles,documents,document_versions cascade;"));
  function version(id=v1,path=`whitepapers/${asset}/devnet/${sha}/terms.pdf`) {
    sql(`insert into document_versions(id,network,bucket,path,sha256,size_bytes,mime_type,verified_by) values('${id}','devnet','documents','${path}','${sha}',12,'application/pdf','wallet')`);
    return path;
  }
  it("does not expose upload receipts and does not allow mutations of verified versions",()=>{
    version();
    expect(()=>sql("set role anon;select * from document_uploads")).toThrow(/permission denied/);
    expect(()=>sql("set role authenticated;select * from document_versions")).toThrow(/permission denied/);
    expect(()=>sql("update document_versions set sha256=repeat('b',64)")).toThrow(/immutable/);
    expect(()=>sql("delete from document_versions")).toThrow(/immutable/);
    expect(sql("select public from storage.buckets where id='document-uploads'")).toBe("f");
  });
  it("rejects a profile version from another network or different bytes",()=>{
    const path=version();
    const insert=`insert into asset_profiles(asset_pda,network,whitepaper_path,whitepaper_sha256,whitepaper_version_id) values('asset','devnet','${path}','${sha}','${v1}')`;
    sql(insert);
    expect(()=>sql(insert.replace("'asset','devnet'","'asset','mainnet'"))).toThrow(/verified immutable version/);
    expect(()=>sql("update asset_profiles set whitepaper_sha256=repeat('b',64)")).toThrow(/verified immutable version/);
  });
  function document(id:string,versionNumber:number,path:string) {
    sql(`insert into documents(id,category,slug,version,storage_path,sha256,size_bytes,mime_type,verified_version_id)
      values('${id}','legal','terms',${versionNumber},'${path}','${sha}',12,'application/pdf','${id}')`);
  }
  it("publishes exactly one family version under concurrent requests and preserves old timestamps",async()=>{
    document(v1,1,version(v1,"legal/terms/v1-file.pdf"));document(v2,2,version(v2,"legal/terms/v2-file.pdf"));
    await Promise.all([db.queryAsync(`select publish_document_version('${v1}','devnet')`),db.queryAsync(`select publish_document_version('${v2}','devnet')`)]);
    expect(sql("select count(*) from documents where published")).toBe("1");
    expect(sql("select count(*) from documents where published_at is not null")).toBe("2");
    expect(()=>sql(`select publish_document_version('${v1}','mainnet')`)).toThrow(/verify an immutable/);
  });
  it("cannot publish an unverified external link or mutate verified document metadata",()=>{
    sql(`insert into documents(id,category,slug,version) values('${v1}','legal','terms',1)`);
    expect(()=>sql(`select publish_document_version('${v1}','devnet')`)).toThrow(/verify an immutable/);
    sql("delete from documents");document(v1,1,version());
    expect(()=>sql("update documents set size_bytes=20")).toThrow(/metadata is immutable/);
  });
  it("locks the accepted version into an idempotent signed pledge",async()=>{
    version(v1);version(v2,"whitepapers/asset/devnet/other/terms.pdf");
    const query=`select record_soft_commitment('devnet','sale','wallet',10,'${v1}','{"signature":"verified-by-route"}')`;
    const results=await Promise.all([db.queryAsync(query),db.queryAsync(query)]);
    expect(results[0]).toBe(results[1]);
    expect(sql("select document_version_id from commitments")).toBe(v1);
    expect(()=>sql(query.replace(v1,v2))).toThrow(/different terms/);
    expect(()=>sql(query.replace("'devnet'","'mainnet'"))).toThrow(/verified document acceptance/);
  });
});
