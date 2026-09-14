import {readFileSync} from "node:fs";
import {join} from "node:path";
import {afterAll,beforeAll,beforeEach,describe,expect,it} from "vitest";
import {LocalPostgres} from "./helpers/local-postgres";
const db=new LocalPostgres(),sql=(query:string)=>db.query(query);
const app="10000000-0000-4000-8000-000000000001";
describe.skipIf(process.env.RUN_LOCAL_POSTGRES_TESTS!=="1")("0049 atomic listing/application publication",()=>{
  beforeAll(()=>{
    try {
      db.initialize();sql("create role anon;create role authenticated;create role service_role bypassrls;");
      sql(readFileSync(join(process.cwd(),"supabase/migrations/0012_equity_launch.sql"),"utf8"));
      sql(readFileSync(join(process.cwd(),"supabase/migrations/0049_launchpad_network_links.sql"),"utf8"));
    }catch(error){db.close();throw error;}
  },30_000);
  afterAll(()=>db.close());beforeEach(()=>sql("truncate launch_listings,launch_updates,launch_applications cascade;"));
  const save=(sale:string,issuer="issuer",network="devnet",admin=false)=>`select save_launch_listing('${network}','${sale}','${issuer}',${admin},'{"application_id":"${app}","is_published":true}')`;
  function application(status="approved") {
    sql(`insert into launch_applications(id,applicant_wallet,raise_type,company_name,one_liner,category,raise_amount,equity_offered,status)
      values('${app}','issuer','mature','Company','Product','equity',100,10,'${status}')`);
  }
  it("links exactly one of two concurrent sales, with no orphan listing for the rejected request",async()=>{
    application();const results=await Promise.allSettled([db.queryAsync(save("sale1")),db.queryAsync(save("sale2"))]);
    expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);
    expect(sql("select count(*) from launch_listings")).toBe("1");
    expect(sql("select sale_pubkey from launch_listings")).toBe(sql("select linked_sale_pubkey from launch_applications"));
  });
  it("cannot publish another applicant's profile or an unapproved/wrong-network application",()=>{
    application();expect(()=>sql(save("sale","other"))).toThrow(/does not belong/);
    expect(()=>sql(save("sale","issuer","mainnet"))).toThrow(/approved on this network/);
    sql("update launch_applications set status='pending'");expect(()=>sql(save("sale"))).toThrow(/approved on this network/);
    expect(sql("select count(*) from launch_listings")).toBe("0");
  });
  it("keeps updates and unpublished listings private and excludes writes for anon",()=>{
    sql("insert into launch_listings(network,sale_pubkey,is_published) values('devnet','sale',true),('mainnet','sale',false)");
    sql("insert into launch_updates(network,sale_pubkey,title,body) values('devnet','sale','Public','Public'),('mainnet','sale','Draft','Draft')");
    expect(sql("set role anon;select count(*) from launch_listings")).toBe("1");
    expect(sql("set role anon;select title from launch_updates")).toBe("Public");
    expect(()=>sql(save("sale").replace("select ","set role anon;select "))).toThrow(/permission denied/);
  });
  it("preserves linked identity and other metadata when publishing the same sale again",()=>{
    application();sql(save("sale"));sql(save("sale"));
    expect(sql("select count(*) from launch_listings")).toBe("1");
    expect(()=>sql("select save_launch_listing('devnet','sale','issuer',false,'{\"application_id\":null}')")).toThrow(/cannot be replaced/);
    expect(sql("select application_id from launch_listings")).toBe(app);
  });
});
