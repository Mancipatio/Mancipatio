import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LocalPostgres } from "./helpers/local-postgres";

const db = new LocalPostgres();
const sql = (query: string) => db.query(query);
const wallet = "1".repeat(32), other = "2".repeat(32);
const token = "a".repeat(64), nextToken = "b".repeat(64), recipient = "c".repeat(64);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const request = (who = wallet, challenge = token, mail = "user@example.com", recipientHash = recipient) =>
  `select request_account_email_verification('${who}','devnet','${mail}','${challenge}','${recipientHash}')`;
const verify = (who = wallet, network = "devnet", challenge = token) =>
  `select verify_account_email('${who}','${network}','${challenge}')`;

describe.skipIf(process.env.RUN_LOCAL_POSTGRES_TESTS !== "1")("0052 account ownership and atomic verification", () => {
  beforeAll(() => {
    try {
      db.initialize();
      sql(`create role anon; create role authenticated; create role service_role bypassrls;
        create function public.touch_updated_at() returns trigger language plpgsql as $$
        begin new.updated_at=clock_timestamp(); return new; end; $$;`);
      sql(readFileSync(join(process.cwd(), "supabase/migrations/0052_account_profiles.sql"), "utf8"));
    } catch (error) { db.close(); throw error; }
  }, 30_000);
  afterAll(() => db.close());
  beforeEach(() => sql("truncate account_profiles,account_email_requests,account_google_states,account_rate_limits cascade"));

  it("creates only a private contact account with no verified identity", () => {
    expect(sql(request())).toBe("requested");
    expect(sql("select email is null and email_verified_at is null and google_sub is null from account_profiles")).toBe("t");
    expect(sql("select to_regclass('public.clients') is null")).toBe("t");
    expect(sql("select pending_email_expires_at-created_at <= interval '30 minutes' from account_profiles")).toBe("t");
  });

  it("blocks table reads/writes and RPC calls for anon and authenticated", () => {
    sql(request());
    for (const role of ["anon", "authenticated"]) {
      for (const table of ["account_profiles", "account_email_requests", "account_rate_limits", "account_google_states"]) {
        expect(() => sql(`set role ${role}; select * from ${table}`)).toThrow(/permission denied/);
        expect(() => sql(`set role ${role}; delete from ${table}`)).toThrow(/permission denied/);
      }
      expect(() => sql(`set role ${role}; ${verify()}`)).toThrow(/permission denied/);
      expect(() => sql(`set role ${role}; ${request(other, nextToken)}`)).toThrow(/permission denied/);
    }
    expect(sql(`set role service_role; ${verify()}`)).toBe("t");
  });

  it("binds proof to exact wallet and network, and consumes only once", async () => {
    sql(request());
    expect(sql(verify(other))).toBe("f");
    expect(sql(verify(wallet, "mainnet"))).toBe("f");
    const results = await Promise.all([db.queryAsync(verify()), db.queryAsync(verify())]);
    expect(results.sort()).toEqual(["f", "t"]);
    expect(sql(verify())).toBe("f");
    expect(sql("select email from account_profiles")).toBe("user@example.com");
    expect(sql("select pending_email is null and email_verified_at is not null from account_profiles")).toBe("t");
  });

  it("does not consume an expired link or change previously verified email", () => {
    sql(request()); sql(verify());
    sql("update account_email_requests set created_at=clock_timestamp()-interval '2 minutes'");
    sql(request(wallet, nextToken, "next@example.com"));
    sql("update account_profiles set pending_email_expires_at=clock_timestamp()-interval '1 second'");
    expect(sql(verify(wallet, "devnet", nextToken))).toBe("f");
    expect(sql("select email from account_profiles")).toBe("user@example.com");
  });

  it("invalidates superseded challenges and clears only the exact failed send", () => {
    sql(request());
    sql("update account_email_requests set created_at=clock_timestamp()-interval '2 minutes'");
    sql(request(wallet, nextToken, "next@example.com"));
    expect(sql(verify())).toBe("f");
    expect(sql(`select cancel_account_email_verification('${wallet}','devnet','${token}')`)).toBe("f");
    expect(sql("select pending_email from account_profiles")).toBe("next@example.com");
    expect(sql(verify(wallet, "devnet", nextToken))).toBe("t");
  });

  it("cancels pending verification without removing verified contact or resetting quotas", () => {
    sql(request()); sql(verify());
    sql("update account_email_requests set created_at=clock_timestamp()-interval '2 minutes'");
    sql(request(wallet, nextToken, "next@example.com"));
    expect(sql(`select cancel_account_email_verification('${wallet}','devnet',null)`)).toBe("t");
    expect(sql(verify(wallet, "devnet", nextToken))).toBe("f");
    expect(sql("select email from account_profiles")).toBe("user@example.com");
    expect(sql(request(wallet, "d".repeat(64)))).toBe("rate_limited");
  });

  it("enforces wallet cooldown atomically across simultaneous sends to different recipients", async () => {
    const replies = await Promise.all([
      db.queryAsync(request()),
      db.queryAsync(request(wallet, nextToken, "other@example.com", hash("other@example.com"))),
    ]);
    expect(replies.sort()).toEqual(["rate_limited", "requested"]);
    expect(sql("select count(*) from account_email_requests")).toBe("1");
  });

  it("enforces durable wallet and recipient hourly limits", () => {
    for (let i = 0; i < 5; i++) {
      expect(sql(request(wallet, hash(`wallet-${i}`)))).toBe("requested");
      sql("update account_email_requests set created_at=clock_timestamp()-interval '2 minutes'");
    }
    expect(sql(request(wallet, hash("wallet-six")))).toBe("rate_limited");
    for (let i = 2; i < 7; i++) expect(sql(request(String(i).repeat(32), hash(`recipient-${i}`)))).toBe("requested");
    expect(sql(request("7".repeat(32), hash("recipient-eleven")))).toBe("rate_limited");
    db.stop(); db.start();
    expect(sql(request("8".repeat(32), hash("after-restart")))).toBe("rate_limited");
  });

  it("serializes recipient limits across concurrent wallets", async () => {
    for (let i = 1; i <= 9; i++) sql(request(String(i).repeat(32), hash(`recipient-${i}`)));
    const results = await Promise.all([
      db.queryAsync(request("A".repeat(32), hash("a"))),
      db.queryAsync(request("B".repeat(32), hash("b"))),
    ]);
    expect(results.sort()).toEqual(["rate_limited", "requested"]);
  });

  it("gives the same wallet an independent account per network", () => {
    sql(request());
    sql(`insert into account_profiles(network,wallet,display_name) values('mainnet','${wallet}','Mainnet owner')`);
    expect(sql(verify(wallet, "mainnet"))).toBe("f");
    expect(sql(verify())).toBe("t");
    expect(sql("select email is null from account_profiles where network='mainnet'")).toBe("t");
  });

  it("uses a shared one-at-a-time rate limiter, surviving cancellation and restart", async () => {
    const command = `select consume_account_rate_limit('${token}',1,600)`;
    const results = await Promise.all([db.queryAsync(command), db.queryAsync(command)]);
    expect(results.sort()).toEqual(["f", "t"]);
    db.stop(); db.start();
    expect(sql(command)).toBe("f");
    sql("update account_rate_limits set hits=array[clock_timestamp()-interval '11 minutes']");
    expect(sql(command)).toBe("t");
  });

  function googleState(stateHash = token) {
    sql(`insert into account_profiles(network,wallet) values('devnet','${wallet}') on conflict do nothing;
      insert into account_google_states(state_hash,network,wallet,browser_hash,code_verifier,redirect_uri,expires_at)
      values('${stateHash}','devnet','${wallet}','${recipient}','${"v".repeat(43)}','https://manci.test/api/account/google/callback',clock_timestamp()+interval '10 minutes')`);
  }
  const complete = (stateHash = token, browserHash = recipient, network = "devnet") =>
    `select complete_account_google_link('${stateHash}','${browserHash}','${network}','google-subject','google@example.com')`;

  it("links only the correct browser/network and prevents concurrent OAuth replay", async () => {
    googleState();
    expect(sql(complete(token, nextToken))).toBe("f");
    expect(sql(complete(token, recipient, "mainnet"))).toBe("f");
    const results = await Promise.all([db.queryAsync(complete()), db.queryAsync(complete())]);
    expect(results.sort()).toEqual(["f", "t"]);
    expect(sql("select google_email from account_profiles")).toBe("google@example.com");
    expect(sql("select email is null from account_profiles")).toBe("t");
  });

  it("OAuth unlink invalidates pending states and preserves verified contact email", () => {
    sql(request()); sql(verify()); googleState(); googleState(nextToken);
    expect(sql(complete())).toBe("t");
    expect(sql(`select unlink_account_google('${wallet}','devnet')`)).toBe("t");
    expect(sql(complete(nextToken))).toBe("f");
    expect(sql("select google_sub is null and google_email is null and google_linked_at is null from account_profiles")).toBe("t");
    expect(sql("select email from account_profiles")).toBe("user@example.com");
  });

  it("OAuth completion and unlink serialize so an old callback cannot relink", async () => {
    googleState();
    await Promise.all([db.queryAsync(complete()), db.queryAsync(`select unlink_account_google('${wallet}','devnet')`)]);
    expect(sql("select google_sub is null from account_profiles")).toBe("t");
    expect(sql("select count(*) from account_google_states")).toBe("0");
  });
});
