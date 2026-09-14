import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll,beforeAll,beforeEach,describe,expect,it } from "vitest";
import { LocalPostgres } from "./helpers/local-postgres";
const db=new LocalPostgres();
const sql=(query:string)=>db.query(query);
const oldGuardRejections: string[] = [];
const id1="10000000-0000-4000-8000-000000000001",id2="10000000-0000-4000-8000-000000000002";
const verified=`insert into commitments(sale_pubkey,investor_wallet,amount,status,settled_tx,evidence_verified,payment_mint,payment_decimals,amount_atomic,units,instruction_index,finalized_slot)
  values('sale','buyer',0.75,'settled','signature',true,'payment',6,750000,3,0,123)`;
describe.skipIf(process.env.RUN_LOCAL_POSTGRES_TESTS!=="1")("0045 evidence on isolated PostgreSQL",()=>{
  beforeAll(()=>{
    try {
      db.initialize();
      sql(`create role anon; create role authenticated; create role service_role bypassrls;
        create table commitments(id uuid primary key default gen_random_uuid(),created_at timestamptz default now(),
          sale_pubkey text not null,investor_wallet text not null,amount numeric not null,status text not null default 'pending',settled_tx text);
        ${["delivery_requests","conversion_requests"].map(t=>`create table ${t}(
          id uuid primary key,network text not null default 'devnet',holder_wallet text not null,mint text not null,
          share_class_pda text not null,amount numeric not null,status text not null default 'requested',vault_pda text,vault_id bigint,deposit_tx text,outcome_tx text,admin_note text);`).join("\n")}`);
      // Install the actual old guards before 0045, reproducing the historical
      // lost-deposit-acknowledgement dead end rather than a trigger-free schema.
      sql(readFileSync(join(process.cwd(),"supabase/migrations/0030_delivery_status_guard.sql"),"utf8"));
      const conversionSource = readFileSync(join(process.cwd(),"supabase/migrations/0034_conversion_requests.sql"),"utf8");
      const conversionStart = conversionSource.indexOf("create or replace function public.conversion_requests_guard_status()");
      const conversionEndMarker = "for each row execute function public.conversion_requests_guard_status();";
      sql(conversionSource.slice(conversionStart, conversionSource.indexOf(conversionEndMarker, conversionStart) + conversionEndMarker.length));
      for (const table of ["delivery_requests", "conversion_requests"]) {
        sql(`insert into ${table}(id,holder_wallet,mint,share_class_pda,amount,status) values('${id1}','holder','mint','class',5,'vault_opened')`);
        try { sql(`update ${table} set status='returned'`); } catch (error) { if (String(error).includes("illegal")) oldGuardRejections.push(table); else throw error; }
        sql(`truncate ${table}`);
      }
      sql(readFileSync(join(process.cwd(),"supabase/migrations/0045_chain_evidence.sql"),"utf8"));
    } catch(error) { db.close();throw error; }
  },30_000);
  afterAll(()=>db.close());
  beforeEach(()=>sql("truncate purchase_evidence_jobs,commitments,custody_request_bindings,delivery_requests,conversion_requests cascade;"));
  it("requires every proof field and exact normalized amount",()=>{
    expect(()=>sql(verified.replace("750000,3,0,123","750000,null,0,123"))).toThrow(/verified_evidence/);
    expect(()=>sql(verified.replace("0.75,'settled'","8.75,'settled'"))).toThrow(/verified_evidence/);
    sql(verified);
    expect(sql("select amount::text from commitments")).toBe("0.75");
    expect(()=>sql("update commitments set amount=1,amount_atomic=1000000")).toThrow(/immutable/);
  });
  it("admits one concurrent record per network/signature/instruction",async()=>{
    const results=await Promise.allSettled([db.queryAsync(verified),db.queryAsync(verified)]);
    expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);
    expect(sql("select count(*) from commitments")).toBe("1");
    sql(verified.replace("750000,3,0,123","750000,3,1,123"));
    expect(sql("select count(*) from commitments")).toBe("2");
  });
  it("separates pledged/confirmed/verified settlement across the whole table and network",()=>{
    sql(verified);
    sql(`insert into commitments(sale_pubkey,investor_wallet,amount,status) select 'sale','pledger-'||n,2,'pending' from generate_series(1,1500)n;
      insert into commitments(sale_pubkey,investor_wallet,amount,status) values('sale','legacy',999,'settled'),('sale','confirmed',10,'confirmed');
      insert into commitments(sale_pubkey,investor_wallet,amount,status,network) values('sale','mainnet-buyer',99,'pending','mainnet');`);
    const totals=JSON.parse(sql("select commitment_totals('devnet','sale')"));
    expect(totals).toMatchObject({pledged:"3000",confirmed:"10",settled:"0.75",backers:1,pledgers:1501,unverified:1,paymentMint:"payment"});
  });
  it("does not allow anonymous private queue reads or aggregation RPC",()=>{
    expect(()=>sql("set role anon; select * from purchase_evidence_jobs")).toThrow(/permission denied/);
    expect(()=>sql("set role authenticated; select * from custody_request_bindings")).toThrow(/permission denied/);
    expect(()=>sql("set role anon; select commitment_totals('devnet','sale')")).toThrow(/permission denied/);
    expect(()=>sql("set role anon; select record_soft_commitment('devnet','sale','wallet',10)")).toThrow(/permission denied/);
    expect(JSON.parse(sql("set role service_role; select commitment_totals('devnet','sale')")).settled).toBe("0");
  });
  it("deduplicates simultaneous pledge retries and rejects changed active terms",async()=>{
    const results = await Promise.all([db.queryAsync("select record_soft_commitment('devnet','sale','wallet',10)"),db.queryAsync("select record_soft_commitment('devnet','sale','wallet',10)")]);
    expect(results[0]).toBe(results[1]);
    expect(sql("select count(*) from commitments")).toBe("1");
    expect(()=>sql("select record_soft_commitment('devnet','sale','wallet',20)")).toThrow(/different terms/);
    sql("select record_soft_commitment('mainnet','sale','wallet',20)");
    expect(sql("select count(*) from commitments")).toBe("2");
  });
  function request(table:string,id:string){sql(`insert into ${table}(id,holder_wallet,mint,share_class_pda,amount) values('${id}','holder','mint','class',5);`);}
  it("upgrades the real historical guards that rejected an unacknowledged deposit's return", () => {
    expect(oldGuardRejections).toEqual(["delivery_requests", "conversion_requests"]);
  });
  it("requires matching deposit evidence and locks bound custody terms",()=>{
    request("delivery_requests",id1);
    sql(`update delivery_requests set status='vault_opened',vault_pda='vault' where id='${id1}'`);
    expect(()=>sql(`update delivery_requests set status='deposited' where id='${id1}'`)).toThrow(/verified deposit evidence/);
    expect(()=>sql(`update delivery_requests set amount=8 where id='${id1}'`)).toThrow(/immutable/);
    sql(`update delivery_requests set status='deposited',deposit_tx='sig',deposit_evidence='{"signature":"sig","vault":"vault","amountAtomic":"5"}' where id='${id1}'`);
    expect(sql("select status from delivery_requests")).toBe("deposited");
  });
  it("prevents a vault satisfying two business requests across products",()=>{
    request("delivery_requests",id1);request("conversion_requests",id2);
    sql(`update delivery_requests set vault_pda='vault' where id='${id1}'`);
    expect(()=>sql(`update conversion_requests set vault_pda='vault' where id='${id2}'`)).toThrow(/another request/);
    expect(sql("select count(*) from custody_request_bindings")).toBe("1");
  });
  const proof = (extra = {}) => JSON.stringify({ signature: "outcome-sig", vault: "vault", amountAtomic: "5", slot: "123", instructionIndex: 0, ...extra }).replaceAll("'", "''");
  function opened(table: string) {
    request(table, id1); sql(`update ${table} set status='vault_opened',vault_pda='vault',vault_id=7 where id='${id1}'`);
  }
  it.each([["delivery_requests", "returned"], ["delivery_requests", "delivered"], ["conversion_requests", "returned"], ["conversion_requests", "converted"]])("recovers stale vault_opened → %s/%s only with exact terminal evidence", (table, terminal) => {
    opened(table);
    expect(() => sql(`update ${table} set status='${terminal}' where id='${id1}'`)).toThrow(/evidence/);
    for (const changed of [{ signature: "other" }, { vault: "different-vault" }, { amountAtomic: "4" }, { slot: null }, { instructionIndex: -1 }]) {
      expect(() => sql(`update ${table} set status='${terminal}',outcome_tx='outcome-sig',outcome_evidence='${proof(changed)}' where id='${id1}'`)).toThrow();
    }
    sql(`update ${table} set status='${terminal}',outcome_tx='outcome-sig',outcome_evidence='${proof()}' where id='${id1}'`);
    expect(sql(`select status from ${table}`)).toBe(terminal);
    expect(sql(`select deposit_evidence is null from ${table}`)).toBe("t");
    sql(`update ${table} set status='${terminal}',outcome_tx='outcome-sig',outcome_evidence='${proof()}' where id='${id1}'`);
    expect(() => sql(`update ${table} set status='deposited' where id='${id1}'`)).toThrow();
  });
  it("makes verified deposit/outcome evidence and the linked vault id immutable", () => {
    opened("delivery_requests");
    sql(`update delivery_requests set status='deposited',deposit_tx='deposit-sig',deposit_evidence='{"signature":"deposit-sig","vault":"vault","amountAtomic":"5"}' where id='${id1}'`);
    expect(() => sql("update delivery_requests set deposit_tx='other'")).toThrow(/immutable/);
    expect(() => sql("update delivery_requests set deposit_evidence=null")).toThrow(/immutable/);
    expect(() => sql("update delivery_requests set vault_id=8")).toThrow(/immutable/);
    sql(`update delivery_requests set status='returned',outcome_tx='outcome-sig',outcome_evidence='${proof()}' where id='${id1}'`);
    expect(() => sql("update delivery_requests set outcome_evidence=null")).toThrow(/immutable/);
    expect(() => sql("update delivery_requests set outcome_tx='other'")).toThrow(/immutable/);
    sql("update delivery_requests set admin_note='Confirmed original return'");
    expect(sql("select admin_note from delivery_requests")).toBe("Confirmed original return");
  });
  it("repairs a legacy terminal record with missing proof but cannot fabricate an unlinked outcome", () => {
    opened("conversion_requests");
    // Existing pre-migration terminal rows can lack evidence. Disable only the
    // new evidence guard to recreate that historical row, then re-enable it.
    sql("alter table conversion_requests disable trigger conversion_evidence_guard");
    sql("update conversion_requests set status='returned',outcome_tx='outcome-sig'");
    sql("alter table conversion_requests enable trigger conversion_evidence_guard");
    sql(`update conversion_requests set outcome_evidence='${proof()}'`);
    expect(sql("select outcome_evidence->>'signature' from conversion_requests")).toBe("outcome-sig");
    request("delivery_requests", id2);
    expect(() => sql(`update delivery_requests set status='returned',outcome_tx='outcome-sig',outcome_evidence='${proof()}' where id='${id2}'`)).toThrow();
  });
  it("allows only one concurrent terminal CAS and preserves the winning original proof", async () => {
    opened("delivery_requests");
    const update = (status: string) => `update delivery_requests set status='${status}',outcome_tx='outcome-sig',outcome_evidence='${proof()}' where id='${id1}' and status='vault_opened' returning status;`;
    const results = await Promise.all([db.queryAsync(update("returned")), db.queryAsync(update("delivered"))]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(sql("select outcome_tx from delivery_requests")).toBe("outcome-sig");
  });
});
