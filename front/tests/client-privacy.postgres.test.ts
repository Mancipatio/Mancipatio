// Migration 0065 (client privacy) against an isolated PostgreSQL built from
// the real migration chain: the Terms ledger dedupe + unique index, the
// ON DELETE SET NULL foreign key, and public.anonymize_client() — what it
// erases, what it keeps, and that it never deletes or cascades a dossier.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalPostgres } from "./helpers/local-postgres";

const db = new LocalPostgres();
const dir = join(process.cwd(), "supabase/migrations");
const files = readdirSync(dir).filter((f) => /^\d+.*\.sql$/.test(f)).sort();
const target = files.find((f) => /^0065_/.test(f));
const before = files.filter((f) => Number.parseInt(f, 10) < 65);
const after = files.filter((f) => Number.parseInt(f, 10) > 65);

const WA = "WaWaWaWaWaWaWaWaWaWaWaWaWaWaWaWaWaWa";
const WB = "WbWbWbWbWbWbWbWbWbWbWbWbWbWbWbWbWbWb";
const WC = "WcWcWcWcWcWcWcWcWcWcWcWcWcWcWcWcWcWc";
const WD = "WdWdWdWdWdWdWdWdWdWdWdWdWdWdWdWdWdWd";
const WE = "WeWeWeWeWeWeWeWeWeWeWeWeWeWeWeWeWeWe";
const ADMIN = "AdminAdminAdminAdminAdminAdminAdmin1";
const A = "a0000000-0000-4000-8000-000000000001";
const B = "b0000000-0000-4000-8000-000000000002";
const C = "c0000000-0000-4000-8000-000000000003";
const D = "d0000000-0000-4000-8000-000000000004";
const E = "e0000000-0000-4000-8000-000000000005";

const q = (sql: string) => db.query(sql);
const json = (sql: string) => JSON.parse(q(sql));
const anonymize = (id: string, extra = "") =>
  json(`select public.anonymize_client('${id}', 'devnet', '${ADMIN}'${extra})`);

describe.skipIf(process.env.RUN_LOCAL_POSTGRES_TESTS !== "1")("client privacy (migration 0065)", () => {
  beforeAll(() => {
    db.initialize();
    try {
      // Same platform model as migration-chain.postgres.test.ts.
      q(`create role anon;create role authenticated;create role service_role bypassrls;
        create schema storage;
        create table storage.buckets(id text primary key,name text,public boolean default false,file_size_limit bigint,allowed_mime_types text[]);
        create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text);
        alter table storage.objects enable row level security;
        grant usage on schema public,storage to anon,authenticated,service_role;
        alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
        alter default privileges in schema public grant all on sequences to anon,authenticated,service_role;
        grant all on storage.objects,storage.buckets to service_role;
        grant all on storage.objects to anon,authenticated;`);
      for (const file of before) q(readFileSync(join(dir, file), "utf8"));
      // Ledger as it can look today: repeated onboarding acceptances and a
      // wallet-gate row for the same (wallet, version).
      q(`insert into public.clients(id, network, type, wallet, display_name) values
          ('${A}', 'devnet', 'investor', '${WA}', 'Alice'),
          ('${B}', 'devnet', 'investor', '${WB}', 'Bob');
        insert into public.tos_acceptances(id, created_at, client_id, wallet, version, source) values
          (1, now() - interval '5 days', null,   '${WA}', 'v1', 'wallet-gate'),
          (2, now() - interval '4 days', '${A}', '${WA}', 'v1', 'onboarding'),
          (3, now() - interval '3 days', '${A}', '${WA}', 'v1', 'onboarding'),
          (4, now() - interval '5 days', '${B}', '${WB}', 'v1', 'onboarding'),
          (5, now() - interval '2 days', '${A}', null,    'v1', 'onboarding'),
          (6, now() - interval '1 days', '${A}', null,    'v1', 'onboarding'),
          (7, now() - interval '1 days', '${A}', '${WA}', 'v2', 'onboarding');
        select setval(pg_get_serial_sequence('public.tos_acceptances', 'id'), 100);`);
      q(readFileSync(join(dir, target!), "utf8"));
      for (const file of after) q(readFileSync(join(dir, file), "utf8"));
    } catch (error) {
      db.close();
      throw error;
    }
  }, 60_000);
  afterAll(() => db.close());

  it("keeps the earliest acceptance per (wallet, version) and archives the rest verbatim", () => {
    expect(target).toBeDefined();
    expect(q("select string_agg(id::text || ':' || coalesce(client_id::text, '-'), ',' order by id) from public.tos_acceptances"))
      .toBe(`1:${A},4:${B},5:${A},6:${A},7:${A}`);
    expect(json(`select jsonb_agg(jsonb_build_object('id', id, 'client', client_id, 'wallet', wallet,
        'version', version, 'source', source, 'kept', kept_id) order by id) from public.tos_acceptance_duplicates`))
      .toEqual([
        { id: 2, client: A, wallet: WA, version: "v1", source: "onboarding", kept: 1 },
        { id: 3, client: A, wallet: WA, version: "v1", source: "onboarding", kept: 1 },
      ]);
  });

  it("makes (wallet, version) unique while wallet-less acceptances stay allowed", () => {
    expect(() => q(`insert into public.tos_acceptances(wallet, version) values ('${WA}', 'v1')`))
      .toThrow(/duplicate key value violates unique constraint "tos_acceptances_wallet_version_key"/);
    q(`insert into public.tos_acceptances(client_id, wallet, version) values ('${A}', null, 'v1'), ('${A}', null, 'v1')`);
    expect(q("select count(*) from pg_indexes where indexname = 'tos_acceptances_wallet_version_idx'")).toBe("0");
  });

  it("detaches, never deletes, acceptances when a dossier row goes away", () => {
    expect(q(`select confdeltype from pg_constraint where conrelid = 'public.tos_acceptances'::regclass and contype = 'f'`))
      .toBe("n");
    q(`delete from public.clients where id = '${B}'`);
    expect(q("select coalesce(client_id::text, 'null') from public.tos_acceptances where id = 4")).toBe("null");
  });

  it("bounds its lock waits to the migration's own transaction", () => {
    const sql = readFileSync(join(dir, target!), "utf8");
    expect(sql).toMatch(/begin;\s+(--[^\n]*\n\s*)*set local lock_timeout = '5s';/);
    expect(q("show lock_timeout")).toBe("0");
  });

  it("re-applies cleanly without changing the ledger", () => {
    const snapshot = () => q("select string_agg(id::text || ':' || coalesce(client_id::text, '-'), ',' order by id) from public.tos_acceptances")
      + "|" + q("select count(*) from public.tos_acceptance_duplicates");
    const beforeReapply = snapshot();
    q(readFileSync(join(dir, target!), "utf8"));
    expect(snapshot()).toBe(beforeReapply);
  });

  it("keeps the archive and the erasure function away from browser roles", () => {
    for (const role of ["anon", "authenticated"]) {
      expect(() => q(`set role ${role}; select * from public.tos_acceptance_duplicates`)).toThrow(/permission denied/);
      expect(() => q(`set role ${role}; select public.anonymize_client('${A}', 'devnet', '${ADMIN}')`))
        .toThrow(/permission denied/);
    }
    expect(q("select has_function_privilege('service_role', 'public.anonymize_client(uuid,text,text,boolean)', 'EXECUTE')"))
      .toBe("t");
  });

  describe("anonymize_client", () => {
    beforeAll(() => {
      q(`insert into public.clients(id, network, type, wallet, email, display_name, company_name, jurisdiction, tags, source,
            kyc_status, kyc_provider, kyc_provider_ref, kyc_verified_at, kyc_expires_at, onboarding_token, onboarding_token_expires_at) values
          ('${C}', 'devnet', 'issuer', '${WC}', 'carol@x.test', 'Carol Example', 'Carol GmbH', '276', '["vip"]', 'referral',
            'verified', 'manual', 'ref-carol', now() - interval '10 days', now() + interval '300 days', 'tok-carol', now() + interval '3 days'),
          ('${D}', 'devnet', 'investor', '${WD}', 'dave@x.test', 'Dave', null, '688', '[]', null,
            'verified', null, null, now() - interval '5 days', now() + interval '300 days', null, null),
          ('${E}', 'devnet', 'investor', '${WE}', 'erin@x.test', 'Erin', null, '688', '[]', null,
            'suspended', null, null, now() - interval '50 days', now() + interval '300 days', null, null);
        insert into public.client_documents(id, client_id, kind, storage_path, sha256, uploaded_by) values
          (901, '${C}', 'passport', 'clients/${C}/passport/aaaa-passport.pdf', 'aa', '${WC}'),
          (902, '${C}', 'proof_of_address', 'clients/${C}/proof_of_address/bbbb-bill.pdf', 'bb', '${WC}');
        insert into public.kyc_requirements(client_id, doc_kind, label, note, status, document_id) values
          ('${C}', 'passport', 'Passport', 'Carol, please use the new one', 'approved', 901),
          ('${C}', 'selfie', 'Selfie / liveness', null, 'requested', null);
        insert into public.client_verification_details(client_id, kind, legal_name, date_of_birth, nationality,
            residence_country, address_line, city, postal_code, submitted_by_wallet) values
          ('${C}', 'kyc', 'Carol Example', '1980-01-01', 276, 276, 'Hauptstrasse 1', 'Berlin', '10115', '${WC}');
        insert into public.client_notes(client_id, author, body, kind) values
          ('${C}', '${ADMIN}', 'Met Carol at the fair', 'note'),
          ('${C}', '${ADMIN}', 'KYC approved: German passport', 'kyc-event');
        insert into public.client_raise_limits(client_id, annual_raise_cap_eur, note) values ('${C}', 500000, 'Carol asked for more');
        insert into public.tos_acceptances(client_id, wallet, version, source) values ('${C}', '${WC}', 'v1', 'onboarding');
        insert into public.passport_requests(wallet, jurisdiction, note, status) values ('${WC}', 276, 'I live in Berlin', 'approved');
        insert into public.conversion_requests(network, holder_wallet, client_id, share_class_pda, mint, amount, contact, status) values
          ('devnet', '${WC}', '${C}', 'Sc1', 'Mint1', 5, 'carol@x.test', 'cancelled');
        insert into public.delivery_requests(network, holder_wallet, client_id, share_class_pda, mint, amount, delivery_details, contact, status) values
          ('devnet', '${WD}', null, 'Sc1', 'Mint1', 1, 'Dave street 1', 'dave@x.test', 'requested');`);
    });

    it("dry run checks and changes nothing", () => {
      const snapshot = () => q(`select row_to_json(c)::text from public.clients c where id = '${C}'`)
        + q(`select count(*) from public.client_documents where client_id = '${C}'`);
      const beforeDry = snapshot();
      expect(anonymize(C, ", true")).toEqual({ status: "ready", anonymized_at: null });
      expect(snapshot()).toBe(beforeDry);
    });

    it("refuses an unknown or other-network dossier and an invalid actor", () => {
      expect(anonymize("f0000000-0000-4000-8000-000000000009")).toEqual({ status: "not_found" });
      expect(json(`select public.anonymize_client('${C}', 'mainnet', '${ADMIN}')`)).toEqual({ status: "not_found" });
      expect(() => q(`select public.anonymize_client('${C}', 'devnet', 'not a wallet')`)).toThrow(/invalid arguments/);
    });

    it("refuses while a delivery of the dossier's wallet is in flight, and changes nothing", () => {
      expect(anonymize(D)).toEqual({ status: "active_requests" });
      expect(anonymize(D, ", true")).toEqual({ status: "active_requests" });
      expect(q(`select email || '|' || display_name || '|' || (anonymized_at is null) from public.clients where id = '${D}'`))
        .toBe("dave@x.test|Dave|true");
    });

    it("erases personal data, keeps the ledger and never deletes the dossier", () => {
      const result = anonymize(C);
      expect(result).toMatchObject({
        status: "anonymized",
        storage_paths: [
          `clients/${C}/passport/aaaa-passport.pdf`,
          `clients/${C}/proof_of_address/bbbb-bill.pdf`,
        ],
        previous: { kyc_status: "verified", anonymized_at: null },
        counts: {
          documents: 2, verification_details: 1, notes_erased: 2, requirements_cleared: 2,
          tos_detached: 1, passport_request_notes: 1,
        },
      });
      const client = json(`select row_to_json(c) from public.clients c where id = '${C}'`);
      expect(client).toMatchObject({
        id: C, network: "devnet", type: "issuer", wallet: WC, kyc_provider: "manual",
        email: null, display_name: "Anonymized client", company_name: null, jurisdiction: null,
        tags: [], source: null, kyc_provider_ref: null, onboarding_token: null, onboarding_token_expires_at: null,
        kyc_status: "expired", notes_count: 3,
      });
      expect(client.anonymized_at).not.toBeNull();
      expect(client.kyc_verified_at).not.toBeNull();
      expect(Date.parse(client.kyc_expires_at)).toBeLessThanOrEqual(Date.now() + 1000);

      expect(q(`select count(*) from public.client_documents where client_id = '${C}'`)).toBe("0");
      expect(q(`select count(*) from public.client_verification_details where client_id = '${C}'`)).toBe("0");
      // Checklist statuses stay; its free text (notes, custom labels — back
      // to the document kind) and document links go.
      expect(q(`select string_agg(status || ':' || coalesce(note, '-') || ':' || coalesce(document_id::text, '-') || ':' || label, ',' order by doc_kind)
          from public.kyc_requirements where client_id = '${C}'`)).toBe("approved:-:-:passport,requested:-:-:selfie");
      expect(q(`select string_agg(kind || ':' || body, ',' order by id) from public.client_notes where client_id = '${C}'`))
        .toBe("note:[erased],kyc-event:[erased],system:Personal data erased: identity documents and verification details deleted, notes cleared. Ledger records kept.");
      expect(q(`select coalesce(note, '-') || ':' || annual_raise_cap_eur from public.client_raise_limits where client_id = '${C}'`)).toBe("-:500000.00");
      // Consent record kept, detached.
      expect(q(`select coalesce(client_id::text, 'null') || ':' || source from public.tos_acceptances where wallet = '${WC}'`)).toBe("null:onboarding");
      expect(q(`select coalesce(note, '-') || ':' || status || ':' || jurisdiction from public.passport_requests where wallet = '${WC}'`)).toBe("-:approved:276");
      // Finished conversion stays as the record of the conversion.
      expect(q(`select contact || ':' || status from public.conversion_requests where client_id = '${C}'`)).toBe("carol@x.test:cancelled");
    });

    it("is safe to run again and keeps its own timeline entry", () => {
      q(`insert into public.client_notes(client_id, author, body, kind) values ('${C}', '${ADMIN}', 'Carol called again', 'communication')`);
      const again = anonymize(C);
      expect(again).toMatchObject({ status: "anonymized", storage_paths: [], counts: { documents: 0, notes_erased: 1 } });
      expect(again.previous.anonymized_at).not.toBeNull();
      expect(q(`select count(*) from public.client_notes where client_id = '${C}' and kind = 'system' and body like 'Personal data erased%'`)).toBe("2");
      expect(q(`select count(*) from public.clients where id = '${C}'`)).toBe("1");
    });

    it("keeps a suspension so the wallet stays blocked", () => {
      expect(anonymize(E)).toMatchObject({ status: "anonymized", previous: { kyc_status: "suspended" } });
      expect(q(`select kyc_status || ':' || display_name from public.clients where id = '${E}'`)).toBe("suspended:Anonymized client");
    });

    it("detaches archived duplicate acceptances too", () => {
      expect(anonymize(A)).toMatchObject({ status: "anonymized", counts: { tos_detached: 8 } });
      expect(q(`select count(*) from public.tos_acceptances where client_id = '${A}'`)).toBe("0");
      expect(q(`select count(*) from public.tos_acceptance_duplicates where client_id = '${A}'`)).toBe("0");
      expect(q(`select count(*) from public.tos_acceptance_duplicates`)).toBe("2");
    });
  });
});
