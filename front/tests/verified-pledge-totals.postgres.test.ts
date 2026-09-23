// Migration 0062 — public launchpad pledge totals count only pledges whose
// wallet resolves to a LIVE verified dossier (own, or the linked account's),
// mirroring lib/server/kyc-gate.ts fetchClientRow + evaluateKycLookup. Since
// policy 2026-09-23 a pledge needs no KYC, so anonymous pledges are reported
// separately instead of as social proof.
//
// Minimal stand-in tables carry only the columns the function reads; the
// full-schema application of 0062 is covered by
// tests/migration-chain.postgres.test.ts.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LocalPostgres } from "./helpers/local-postgres";

const db = new LocalPostgres();
const sql = (query: string) => db.query(query);
const totals = (network = "devnet", sale = "sale") =>
  JSON.parse(sql(`select commitment_totals('${network}','${sale}')`)) as Record<string, unknown>;
const pledge = (wallet: string, amount: number, status = "pending", network = "devnet") =>
  sql(`insert into commitments(network,sale_pubkey,investor_wallet,amount,status) values('${network}','sale','${wallet}',${amount},'${status}')`);
const client = (wallet: string | null, status: string, expires: string | null, opts: { account?: string; network?: string; created?: string } = {}) =>
  sql(`insert into clients(network,wallet,account_id,kyc_status,kyc_expires_at,created_at) values(
    '${opts.network ?? "devnet"}',${wallet === null ? "null" : `'${wallet}'`},${opts.account ? `'${opts.account}'` : "null"},
    '${status}',${expires === null ? "null" : `'${expires}'`},${opts.created ? `'${opts.created}'` : "now()"})`);
const FUTURE = "2099-01-01T00:00:00Z", PAST = "2000-01-01T00:00:00Z";
const ACCOUNT = "20000000-0000-4000-8000-000000000001";

describe.skipIf(process.env.RUN_LOCAL_POSTGRES_TESTS !== "1")("0062 verified-only public pledge totals", () => {
  beforeAll(() => {
    try {
      db.initialize();
      sql(`create role anon; create role authenticated; create role service_role bypassrls;
        create table commitments(id uuid primary key default gen_random_uuid(),network text not null default 'devnet',
          sale_pubkey text not null,investor_wallet text not null,amount numeric not null,status text not null default 'pending',
          evidence_verified boolean not null default false,payment_mint text);
        create table clients(id uuid primary key default gen_random_uuid(),created_at timestamptz not null default now(),
          network text not null default 'devnet',wallet text,account_id uuid,kyc_status text not null default 'pending',kyc_expires_at timestamptz);
        create table account_wallets(network text not null,wallet text not null,account_id uuid not null,primary key(network,wallet));
        -- Supabase grants service_role full table access by default.
        grant all on commitments,clients,account_wallets to service_role;`);
      sql(readFileSync(join(process.cwd(), "supabase/migrations/0062_verified_pledge_totals.sql"), "utf8"));
    } catch (error) { db.close(); throw error; }
  }, 30_000);
  afterAll(() => db.close());
  beforeEach(() => sql("truncate commitments,clients,account_wallets"));

  it("does not count throwaway-wallet pledges as public progress", () => {
    // 1 verified investor, then 300 wallets with no dossier at all.
    client("verified-1", "verified", FUTURE);
    pledge("verified-1", 1000);
    sql(`insert into commitments(sale_pubkey,investor_wallet,amount) select 'sale','sybil-'||n,1000 from generate_series(1,300)n`);
    expect(totals()).toMatchObject({
      pledged: "1000", confirmed: "0", pledgers: 1,
      unverifiedPledged: "300000", unverifiedPledgers: 300,
    });
  });

  it("counts only a LIVE verification: pending, expired, missing expiry, rejected and suspended do not count", () => {
    const cases: Array<[string, string, string | null]> = [
      ["pending", "pending", null], ["expired", "verified", PAST], ["no-expiry", "verified", null],
      ["rejected", "rejected", null], ["suspended", "suspended", null], ["more-info", "more_info", null],
    ];
    for (const [wallet, status, expires] of cases) { client(wallet, status, expires); pledge(wallet, 10); }
    client("live", "verified", FUTURE); pledge("live", 7, "confirmed");
    expect(totals()).toMatchObject({ pledged: "0", confirmed: "7", pledgers: 1, unverifiedPledged: "60", unverifiedPledgers: 6 });
  });

  it("a suspended or rejected duplicate row disqualifies an older verified one (fail closed)", () => {
    client("dup-s", "verified", FUTURE, { created: "2026-01-01T00:00:00Z" });
    client("dup-s", "suspended", null, { created: "2026-02-01T00:00:00Z" });
    client("dup-r", "verified", FUTURE, { created: "2026-01-01T00:00:00Z" });
    client("dup-r", "rejected", null, { created: "2026-02-01T00:00:00Z" });
    pledge("dup-s", 5); pledge("dup-r", 5);
    expect(totals()).toMatchObject({ pledged: "0", pledgers: 0, unverifiedPledgers: 2 });
  });

  it("otherwise the OLDEST row decides, as in the server gate", () => {
    client("old-verified", "verified", FUTURE, { created: "2026-01-01T00:00:00Z" });
    client("old-verified", "pending", null, { created: "2026-02-01T00:00:00Z" });
    client("old-pending", "pending", null, { created: "2026-01-01T00:00:00Z" });
    client("old-pending", "verified", FUTURE, { created: "2026-02-01T00:00:00Z" });
    pledge("old-verified", 3); pledge("old-pending", 4);
    expect(totals()).toMatchObject({ pledged: "3", pledgers: 1, unverifiedPledged: "4", unverifiedPledgers: 1 });
  });

  it("a linked wallet without its own dossier answers with the account's dossier", () => {
    client(null, "verified", FUTURE, { account: ACCOUNT });
    sql(`insert into account_wallets(network,wallet,account_id) values('devnet','linked','${ACCOUNT}')`);
    pledge("linked", 20);
    expect(totals()).toMatchObject({ pledged: "20", pledgers: 1, unverifiedPledgers: 0 });
    // A dossier of its own takes precedence over the account's.
    client("linked", "pending", null);
    expect(totals()).toMatchObject({ pledged: "0", pledgers: 0, unverifiedPledged: "20", unverifiedPledgers: 1 });
  });

  it("is bound to the network: a verified dossier on another network does not count", () => {
    client("wallet", "verified", FUTURE, { network: "mainnet" });
    pledge("wallet", 9);
    expect(totals()).toMatchObject({ pledged: "0", unverifiedPledged: "9", unverifiedPledgers: 1 });
  });

  it("keeps the settled figures and the existing keys unchanged", () => {
    sql(`insert into commitments(sale_pubkey,investor_wallet,amount,status,evidence_verified,payment_mint) values
      ('sale','anon-buyer',0.75,'settled',true,'payment'),('sale','legacy',999,'settled',false,null),('sale','gone',5,'cancelled',false,null)`);
    expect(totals()).toEqual({
      pledged: "0", confirmed: "0", settled: "0.75", backers: 1, pledgers: 0,
      unverifiedPledged: "0", unverifiedPledgers: 0, paymentMint: "payment", unverified: 1,
    });
  });

  it("stays service-role only", () => {
    expect(() => sql("set role anon; select commitment_totals('devnet','sale')")).toThrow(/permission denied/);
    expect(() => sql("set role authenticated; select commitment_totals('devnet','sale')")).toThrow(/permission denied/);
    expect(JSON.parse(sql("set role service_role; select commitment_totals('devnet','sale')")).pledged).toBe("0");
  });
});
