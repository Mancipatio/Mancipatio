// 0090 investor relations on an isolated PostgreSQL with the whole migration
// chain (devnet identity): the lifecycle guard of issuer_updates (drafts are
// edited, published rows are frozen except one anchor and a withdrawal with a
// reason, withdrawn rows are final, only drafts are deleted), the document
// guard (a verified version of this issuer in the private bucket, drafts only,
// immutable, at most ten, serialized with publication), RLS default deny and
// the network guard.
import { readFileSync } from "node:fs";
import { getAddressDecoder } from "@solana/kit";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LocalPostgres } from "./helpers/local-postgres";
import { applyMigrations, SUPABASE_PLATFORM_SQL } from "./helpers/migrations";

const db = new LocalPostgres();
const sql = (query: string) => db.query(query);
const service = (query: string) => db.query(`set role service_role; ${query}`);

// Deterministic test keys (32 equal bytes each), no real account.
const key = (seed: number) => getAddressDecoder().decode(new Uint8Array(32).fill(seed)).toString();
const ISSUER = key(21);
const OTHER_ISSUER = key(22);
const ASSET = key(23);
const WALLET = key(24);
const ADMIN = key(25);
const SIGNATURE = "5".repeat(88);
const UPDATE = "20000000-0000-4000-8000-000000000001";
const SHA = "a".repeat(64);
const versionId = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const pathFor = (n: number, issuer = ISSUER, network = "devnet") => `issuer-updates/${issuer}/${network}/${SHA.slice(0, 63)}${n % 10}/report-${n}.pdf`;
const shaFor = (n: number) => `${SHA.slice(0, 63)}${n % 10}`;

/** A verified version in document_versions (0048), as the finalize route records it. */
function version(n: number, options: { bucket?: string; issuer?: string; network?: string } = {}) {
  const path = pathFor(n, options.issuer, options.network);
  sql(`insert into public.document_versions(id,network,bucket,path,sha256,size_bytes,mime_type,verified_by)
    values ('${versionId(n)}','${options.network ?? "devnet"}','${options.bucket ?? "documents-confidential"}','${path}','${shaFor(n)}',1000,'application/pdf','${WALLET}')`);
  return { id: versionId(n), path, sha: shaFor(n) };
}
function draft(id = UPDATE) {
  service(`insert into public.issuer_updates(id,issuer_pda,asset_pda,kind,title,body,visibility,created_by,updated_by)
    values ('${id}','${ISSUER}','${ASSET}','update','Q3 progress','We opened the second plant.','public','${WALLET}','${WALLET}')`);
}
function attach(n: number, update = UPDATE, over: Partial<{ path: string; sha: string; size: number; type: string; network: string }> = {}) {
  const v = { path: pathFor(n), sha: shaFor(n) };
  return service(`insert into public.issuer_update_documents(network,update_id,version_id,file_name,storage_path,sha256,size_bytes,content_type,created_by)
    values ('${over.network ?? "devnet"}','${update}','${versionId(n)}','Report ${n}.pdf','${over.path ?? v.path}','${over.sha ?? v.sha}',${over.size ?? 1000},'${over.type ?? "application/pdf"}','${WALLET}') returning id`);
}
const publish = (id = UPDATE) => service(`update public.issuer_updates set status='published',published_by='${WALLET}' where id='${id}' returning published_at`);
const statusOf = (id = UPDATE) => sql(`select status from public.issuer_updates where id='${id}'`);

describe.skipIf(process.env.RUN_LOCAL_POSTGRES_TESTS !== "1")("0090 issuer updates on isolated PostgreSQL", () => {
  beforeAll(() => {
    try {
      db.initialize();
      db.query(SUPABASE_PLATFORM_SQL);
      applyMigrations(db, { network: "devnet" });
    } catch (error) { db.close(); throw error; }
  }, 90_000);
  afterAll(() => db.close());
  beforeEach(() => {
    // The guards refuse deleting published rows; a superuser truncate resets the fixture.
    sql("truncate public.issuer_update_documents, public.issuer_updates; delete from public.document_uploads; alter table public.document_versions disable trigger document_versions_immutable; delete from public.document_versions; alter table public.document_versions enable trigger document_versions_immutable;");
  });

  it("keeps both tables private to browser roles (RLS on, no grants) and writable by the service role", () => {
    for (const table of ["issuer_updates", "issuer_update_documents"]) {
      expect(sql(`select relrowsecurity from pg_class where oid='public.${table}'::regclass`)).toBe("t");
      expect(sql(`select count(*) from pg_policies where schemaname='public' and tablename='${table}'`)).toBe("0");
      for (const role of ["anon", "authenticated"]) {
        expect(() => sql(`set role ${role}; select * from public.${table}`), `${role} ${table}`).toThrow(/permission denied/);
      }
    }
    expect(() => sql(`set role anon; insert into public.issuer_updates(issuer_pda,kind,title,body,created_by,updated_by) values ('${ISSUER}','update','T','B','x','x')`)).toThrow(/permission denied/);
    draft();
    expect(service(`select network||'|'||status||'|'||visibility from public.issuer_updates`)).toBe("devnet|draft|public");
  });

  it("starts every update as a draft with the database's timestamps; a report names its period", () => {
    expect(() => service(`insert into public.issuer_updates(issuer_pda,kind,title,body,status,published_at,published_by,created_by,updated_by)
      values ('${ISSUER}','update','T','B','published',now(),'${WALLET}','${WALLET}','${WALLET}')`)).toThrow(/starts as a draft/);
    service(`insert into public.issuer_updates(id,issuer_pda,kind,title,body,created_by,updated_by,created_at,updated_at)
      values ('${UPDATE}','${ISSUER}','update','T','B','${WALLET}','${WALLET}','2000-01-01','2000-01-01')`);
    expect(sql(`select created_at > now() - interval '1 minute' and updated_at = created_at from public.issuer_updates`)).toBe("t");
    for (const kind of ["quarterly_report", "annual_report", "financial_statement"]) {
      expect(() => service(`insert into public.issuer_updates(issuer_pda,kind,title,body,created_by,updated_by) values ('${ISSUER}','${kind}','T','B','x','x')`), kind)
        .toThrow(/check constraint/);
    }
    service(`insert into public.issuer_updates(issuer_pda,kind,title,body,period_label,created_by,updated_by) values ('${ISSUER}','quarterly_report','T','B','Q3 2026','x','x')`);
    // Unknown kind or visibility, an empty or control-character title, an over-long body.
    for (const values of [
      `'${ISSUER}','memo','T','B','public'`, `'${ISSUER}','update','T','B','private'`, `'${ISSUER}','update','  ','B','public'`,
      `'${ISSUER}','update',E'Line\\nbreak','B','public'`, `'${ISSUER}','update','T',repeat('x',20001),'public'`, `'not-an-address','update','T','B','public'`,
    ]) {
      expect(() => service(`insert into public.issuer_updates(issuer_pda,kind,title,body,visibility,created_by,updated_by) values (${values},'x','x')`), values).toThrow(/check constraint/);
    }
  });

  it("edits drafts, publishes the saved draft exactly as it is and stamps the publication itself", () => {
    draft();
    const before = sql(`select updated_at::text from public.issuer_updates`);
    service(`update public.issuer_updates set title='Q3 progress (revised)',visibility='holders',updated_at='2000-01-01' where id='${UPDATE}'`);
    const after = sql(`select updated_at::text from public.issuer_updates`);
    expect(Date.parse(after)).toBeGreaterThan(Date.parse(before));
    // The compare-and-swap of the routes: a stale revision matches nothing.
    expect(service(`update public.issuer_updates set title='stale' where id='${UPDATE}' and updated_at='${before}' returning id`)).toBe("");
    expect(() => service(`update public.issuer_updates set status='published' where id='${UPDATE}'`)).toThrow(/check constraint/);
    expect(() => service(`update public.issuer_updates set status='published',published_by='${WALLET}',title='Changed while publishing' where id='${UPDATE}'`))
      .toThrow(/saved draft as it is/);
    service(`update public.issuer_updates set status='published',published_by='${WALLET}',published_at='2000-01-01' where id='${UPDATE}'`);
    expect(sql(`select published_at > now() - interval '1 minute' from public.issuer_updates`)).toBe("t");
    expect(() => service(`update public.issuer_updates set network='testnet' where id='${UPDATE}'`)).toThrow(/identity|immutable/);
  });

  it("freezes a published update: no edit, no return to draft; one anchor; delete refused", () => {
    draft();
    publish();
    for (const change of [
      "title='Edited'", "body='Edited'", "visibility='holders'", "asset_pda=null", "kind='notice'", "published_at=now()",
      `published_by='${ADMIN}'`, `updated_by='${ADMIN}'`, `issuer_pda='${OTHER_ISSUER}'`,
    ]) {
      expect(() => service(`update public.issuer_updates set ${change} where id='${UPDATE}'`), change).toThrow(/cannot be edited|identity/);
    }
    expect(() => service(`update public.issuer_updates set status='draft' where id='${UPDATE}'`)).toThrow(/return to draft/);
    expect(() => service(`update public.issuer_updates set status='draft',published_at=null,published_by=null where id='${UPDATE}'`)).toThrow(/cannot be edited/);
    service(`update public.issuer_updates set anchor_tx='${SIGNATURE}' where id='${UPDATE}'`);
    expect(() => service(`update public.issuer_updates set anchor_tx='${"6".repeat(88)}' where id='${UPDATE}'`)).toThrow(/anchored once/);
    expect(() => service(`update public.issuer_updates set anchor_tx=null where id='${UPDATE}'`)).toThrow(/anchored once/);
    expect(() => service(`delete from public.issuer_updates where id='${UPDATE}'`)).toThrow(/Only a draft/);
    expect(statusOf()).toBe("published");
  });

  it("withdraws a published update with a reason, who and as what; a withdrawal is final", () => {
    draft();
    expect(() => service(`update public.issuer_updates set status='withdrawn',withdrawn_by='${WALLET}',withdrawn_by_role='issuer',withdrawn_reason='Posted by mistake' where id='${UPDATE}'`))
      .toThrow(/never withdrawn/);
    publish();
    expect(() => service(`update public.issuer_updates set status='withdrawn' where id='${UPDATE}'`)).toThrow(/check constraint/);
    expect(() => service(`update public.issuer_updates set status='withdrawn',withdrawn_by='${ADMIN}',withdrawn_by_role='admin',withdrawn_reason='too short' where id='${UPDATE}'`))
      .toThrow(/check constraint/);
    expect(() => service(`update public.issuer_updates set status='withdrawn',withdrawn_by='${ADMIN}',withdrawn_by_role='moderator',withdrawn_reason='Misleading statement about returns' where id='${UPDATE}'`))
      .toThrow(/check constraint/);
    expect(() => service(`update public.issuer_updates set status='withdrawn',withdrawn_by='${ADMIN}',withdrawn_by_role='admin',withdrawn_reason='Misleading statement about returns',anchor_tx='${SIGNATURE}' where id='${UPDATE}'`))
      .toThrow(/separate statements/);
    service(`update public.issuer_updates set status='withdrawn',withdrawn_by='${ADMIN}',withdrawn_by_role='admin',withdrawn_reason='Misleading statement about returns',withdrawn_at='2000-01-01' where id='${UPDATE}'`);
    expect(sql(`select withdrawn_at > now() - interval '1 minute' and withdrawn_by_role = 'admin' from public.issuer_updates`)).toBe("t");
    for (const change of ["status='published'", "withdrawn_reason='Another reason entirely'", `anchor_tx='${SIGNATURE}'`, "title='x'"]) {
      expect(() => service(`update public.issuer_updates set ${change} where id='${UPDATE}'`), change).toThrow(/final/);
    }
    expect(() => service(`delete from public.issuer_updates where id='${UPDATE}'`)).toThrow(/Only a draft/);
  });

  it("attaches only a verified version of this issuer, in the private bucket, on this network, byte for byte", () => {
    draft();
    version(1);
    expect(attach(1)).toMatch(/^[0-9a-f-]{36}$/);
    expect(() => attach(1)).toThrow(/duplicate key|unique/);
    version(2);
    for (const [over, label] of [
      [{ sha: "b".repeat(64) }, "hash"], [{ size: 999 }, "size"], [{ type: "image/png" }, "type"], [{ path: pathFor(2).replace("report-2", "other") }, "path"],
    ] as const) {
      expect(() => attach(2, UPDATE, over), label).toThrow(/verified immutable version/);
    }
    // The public bucket, another issuer's prefix, another network's version.
    version(3, { bucket: "documents" });
    expect(() => attach(3)).toThrow(/verified immutable version/);
    version(4, { issuer: OTHER_ISSUER });
    expect(() => attach(4, UPDATE, { path: pathFor(4, OTHER_ISSUER) })).toThrow(/verified immutable version/);
    version(5, { network: "testnet" });
    expect(() => attach(5, UPDATE, { path: pathFor(5, ISSUER, "testnet") })).toThrow(/verified immutable version/);
    // A document row of another network than its update.
    expect(() => attach(2, UPDATE, { network: "testnet" })).toThrow(/not found on this network/);
    expect(() => service("update public.issuer_update_documents set file_name='renamed.pdf'")).toThrow(/immutable/);
  });

  it("moves the draft's revision on every attach and detach, so a publish against the old revision matches nothing", () => {
    draft();
    version(1);
    const before = sql(`select updated_at::text from public.issuer_updates`);
    attach(1);
    const attached = sql(`select updated_at::text from public.issuer_updates`);
    expect(Date.parse(attached)).toBeGreaterThan(Date.parse(before));
    expect(service(`update public.issuer_updates set status='published',published_by='${WALLET}'
      where id='${UPDATE}' and updated_at='${before}' returning id`)).toBe("");
    service("delete from public.issuer_update_documents");
    expect(Date.parse(sql(`select updated_at::text from public.issuer_updates`))).toBeGreaterThan(Date.parse(attached));
    expect(statusOf()).toBe("draft");
  });

  it("keeps the documents of a published update; caps an update at ten; deleting a draft removes its documents", () => {
    draft();
    for (let n = 0; n < 10; n++) { version(n); attach(n); }
    sql(`insert into public.document_versions(id,network,bucket,path,sha256,size_bytes,mime_type,verified_by)
      values ('${versionId(10)}','devnet','documents-confidential','issuer-updates/${ISSUER}/devnet/${"c".repeat(64)}/eleventh.pdf','${"c".repeat(64)}',1000,'application/pdf','${WALLET}')`);
    expect(() => service(`insert into public.issuer_update_documents(update_id,version_id,file_name,storage_path,sha256,size_bytes,content_type,created_by)
      values ('${UPDATE}','${versionId(10)}','Eleventh.pdf','issuer-updates/${ISSUER}/devnet/${"c".repeat(64)}/eleventh.pdf','${"c".repeat(64)}',1000,'application/pdf','${WALLET}')`)).toThrow(/at most 10/);
    service(`delete from public.issuer_update_documents where version_id='${versionId(9)}'`);
    publish();
    expect(() => service("delete from public.issuer_update_documents")).toThrow(/cannot be removed/);
    expect(() => attach(9)).toThrow(/drafts only/);
    expect(sql("select count(*) from public.issuer_update_documents")).toBe("9");

    const second = "20000000-0000-4000-8000-000000000002";
    draft(second);
    attach(9, second);
    service(`delete from public.issuer_updates where id='${second}'`);
    expect(sql(`select count(*) from public.issuer_update_documents where update_id='${second}'`)).toBe("0");
  });

  it("serializes an attachment with a concurrent publication: the attachment waits and is refused", async () => {
    draft();
    version(1);
    const publishing = db.queryAsync(`begin; set role service_role;
      update public.issuer_updates set status='published',published_by='${WALLET}' where id='${UPDATE}';
      select pg_sleep(1); commit;`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    // Settled into a value at once: its refusal may arrive while the publication is still awaited.
    const attaching = db.queryAsync(`set role service_role; insert into public.issuer_update_documents(update_id,version_id,file_name,storage_path,sha256,size_bytes,content_type,created_by)
      values ('${UPDATE}','${versionId(1)}','Late.pdf','${pathFor(1)}','${shaFor(1)}',1000,'application/pdf','${WALLET}')`)
      .then(() => null, (error: Error) => error);
    await publishing;
    expect((await attaching)?.message).toMatch(/drafts only/);
    expect(sql("select count(*) from public.issuer_update_documents")).toBe("0");
  });

  it("installs the network guard on both tables and re-applies cleanly", () => {
    expect(() => service(`insert into public.issuer_updates(network,issuer_pda,kind,title,body,created_by,updated_by)
      values ('mainnet','${ISSUER}','update','T','B','x','x')`)).toThrow(/mainnet/);
    expect(sql(`select count(*) from pg_trigger where tgname='manci_network_guard'
      and tgrelid in ('public.issuer_updates'::regclass,'public.issuer_update_documents'::regclass)`)).toBe("2");
    draft();
    db.query(readFileSync(join(process.cwd(), "supabase/migrations/0090_issuer_updates.sql"), "utf8"));
    expect(statusOf()).toBe("draft");
  });
});
