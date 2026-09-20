import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LocalPostgres } from "./helpers/local-postgres";

const db = new LocalPostgres(), sql = (query: string) => db.query(query);
const a = "1".repeat(32), b = "2".repeat(32), c = "3".repeat(32), d = "4".repeat(32);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
let serial = 0;
type Profile = { id: string; wallet: string; primary_wallet: string; display_name: string; email: string | null; wallets: { wallet: string }[]; [key: string]: unknown };
type Proof = { account_id: string; requested_by: string; target_wallet: string; token_hash: string; status: string; expires_at: string };
const ensure = (wallet = a, network = "devnet"): Profile => JSON.parse(sql(`select ensure_account_profile('${wallet}','${network}')`));
function start(source = a, target = b): Proof {
  const tokenHash = hash(`proof-${serial++}`);
  return { ...JSON.parse(sql(`select start_account_wallet_link('${source}','devnet','${target}','${tokenHash}')`)), token_hash: tokenHash };
}
function completion(proof: Proof, actor = proof.target_wallet, network = "devnet") {
  return `select complete_account_wallet_link('${actor}','${network}','${proof.token_hash}','${proof.account_id}','${proof.requested_by}','${proof.target_wallet}')`;
}
function link(source = a, target = b) { const proof = start(source, target); expect(sql(completion(proof))).toBe("linked"); return proof; }
const name = (actor: string, value: string) => `select update_account_display_name('${actor}','devnet','${value}')`;
const primary = (actor: string, value: string) => `select set_account_primary_wallet('${actor}','devnet','${value}')`;
const remove = (actor: string, target: string) => `select remove_account_wallet('${actor}','devnet','${target}')`;
const email = (actor = a, token = hash("email")) => `select request_account_email_verification('${actor}','devnet','owner@example.com','${token}','${hash("owner@example.com")}')`;
const verify = (actor = a, token = hash("email")) => `select verify_account_email('${actor}','devnet','${token}')`;
const mutate = (actor: string, id: string, action: string, params: Record<string, unknown>) =>
  `select mutate_account_profile('${actor}','devnet','${id}','${action}','${JSON.stringify(params).replaceAll("'", "''")}'::jsonb)`;

describe.skipIf(process.env.RUN_LOCAL_POSTGRES_TESTS !== "1")("0053 linked-wallet account authorization", () => {
  let backfill: Profile[], backfillHistory: string;
  beforeAll(() => {
    try {
      db.initialize();
      sql(`create role anon; create role authenticated; create role service_role bypassrls;
        create function public.touch_updated_at() returns trigger language plpgsql as $$ begin new.updated_at=clock_timestamp(); return new; end; $$;`);
      sql(readFileSync(join(process.cwd(), "supabase/migrations/0052_account_profiles.sql"), "utf8"));
      sql(`insert into account_profiles(network,wallet,display_name,email,email_verified_at) values
        ('devnet','${a}','Original','existing@example.com',clock_timestamp()),('mainnet','${a}','Mainnet',null,null);
        ${email()};
        insert into account_google_states(state_hash,network,wallet,browser_hash,code_verifier,redirect_uri,expires_at)
        values('${hash("before")}','devnet','${a}','${hash("browser")}','${"v".repeat(43)}','https://manci.test/callback',clock_timestamp()+interval '5 minutes')`);
      sql(readFileSync(join(process.cwd(), "supabase/migrations/0053_account_wallets.sql"), "utf8"));
      backfill = [ensure(a), ensure(a, "mainnet")];
      backfillHistory = sql("select count(*) from account_email_requests r join account_google_states s using(account_id,network)");
    } catch (error) { db.close(); throw error; }
  }, 30_000);
  afterAll(() => db.close());
  beforeEach(() => { serial = 0; sql("truncate account_profiles,account_wallets,account_email_requests,account_google_states,account_wallet_links,account_rate_limits cascade"); });

  it("backfills stable identities, members, primary wallet and proof/history ownership without losing data", () => {
    expect(backfill[0]).toMatchObject({ display_name: "Original", email: "existing@example.com", primary_wallet: a, pending_email: "owner@example.com" });
    expect(backfill[1]).toMatchObject({ display_name: "Mainnet", email: null, primary_wallet: a });
    expect(backfill[0].id).not.toBe(backfill[1].id);
    expect(backfill[0].wallets).toEqual([expect.objectContaining({ wallet: a })]);
    expect(backfillHistory).toBe("1");
  });

  it("every linked signer reads and edits the same private profile; returns acting wallet", () => {
    const initial = ensure(); link();
    expect(sql(name(b, "Shared name"))).toBe("t");
    expect(sql(email(b))).toBe("requested"); expect(sql(verify(a))).toBe("t");
    for (const actor of [a, b]) {
      const profile = ensure(actor);
      expect(profile).toMatchObject({ id: initial.id, wallet: actor, display_name: "Shared name", email: "owner@example.com", primary_wallet: a });
      expect(profile.wallets).toHaveLength(2);
      expect(profile).not.toHaveProperty("pending_email_token_hash"); expect(profile).not.toHaveProperty("google_sub");
    }
  });

  it("requires a live source proof and exact target signer/account/requester/network", () => {
    ensure(); const proof = start();
    expect(sql(completion(proof, c))).toBe("invalid");
    expect(sql(completion(proof, b, "mainnet"))).toBe("invalid");
    expect(sql(completion({ ...proof, requested_by: c }))).toBe("invalid");
    expect(sql(completion({ ...proof, account_id: "00000000-0000-4000-8000-000000000001" }))).toBe("invalid");
    expect(sql(completion({ ...proof, token_hash: hash("wrong") }))).toBe("invalid");
    expect(sql(completion(proof))).toBe("linked");
    expect(sql(completion(proof))).toBe("invalid");
  });

  it("consumes only once under concurrent replay", async () => {
    ensure(); const proof = start();
    expect((await Promise.all([db.queryAsync(completion(proof)), db.queryAsync(completion(proof))])).sort()).toEqual(["invalid", "linked"]);
    expect(ensure().wallets).toHaveLength(2);
  });

  it("either proof wallet may cancel, outsiders cannot, and cancellation revokes completion", () => {
    ensure(); const proof = start();
    const cancel = (actor: string, value = proof) => `select cancel_account_wallet_link('${actor}','devnet','${value.token_hash}','${value.account_id}','${value.requested_by}','${value.target_wallet}')`;
    expect(sql(cancel(c))).toBe("f");
    expect(sql(cancel(c, { ...proof, target_wallet: c }))).toBe("f");
    expect(sql(cancel(b))).toBe("t"); expect(sql(cancel(b))).toBe("t");
    expect(sql(completion(proof))).toBe("invalid");
    const next = start(a, c); expect(sql(cancel(a, next))).toBe("t"); expect(sql(completion(next))).toBe("invalid");
    const completed = start(a, b); expect(sql(completion(completed))).toBe("linked");
    expect(sql(cancel(a, completed))).toBe("f");
  });

  it("rejects expired and superseded links", () => {
    ensure(); const first = start(); const second = start(a, c);
    expect(sql(completion(first))).toBe("invalid");
    sql("update account_wallet_links set created_at=clock_timestamp()-interval '12 minutes',expires_at=clock_timestamp()-interval '3 minutes'");
    expect(sql(completion(second))).toBe("invalid");
    expect(ensure().wallets).toHaveLength(1);
  });

  it("may attach an untouched auto-created singleton without merging data", () => {
    const source = ensure(); const fresh = ensure(b); const proof = start();
    expect(sql(completion(proof))).toBe("linked");
    expect(ensure(b).id).toBe(source.id); expect(ensure(b).id).not.toBe(fresh.id);
    expect(sql("select count(*) from account_profiles")).toBe("1");
  });

  it.each(["name", "email", "pending", "google", "history", "proof"])("preserves existing target account with %s", (kind) => {
    ensure(); const target = ensure(b);
    if (kind === "name") sql(name(b, "Keep me"));
    if (kind === "email" || kind === "pending" || kind === "history") {
      sql(email(b));
      if (kind === "email") sql(verify(b));
      if (kind === "history") sql(`select cancel_account_email_verification('${b}','devnet')`);
    }
    if (kind === "google") sql(`update account_profiles set google_sub='subject',google_email='google@example.com',google_linked_at=clock_timestamp() where id='${target.id}'`);
    if (kind === "proof") start(b, c);
    const proof = start(); expect(sql(completion(proof))).toBe("account_conflict");
    expect(ensure(b).id).toBe(target.id); expect(ensure().wallets).toHaveLength(1);
  });

  it("racing accounts cannot claim the same target", async () => {
    ensure(a); ensure(d);
    const one = start(a, c), two = start(d, c);
    const results = await Promise.all([db.queryAsync(completion(one)), db.queryAsync(completion(two))]);
    expect(results.sort()).toEqual(["account_conflict", "linked"]);
    expect(sql(`select count(*) from account_wallets where wallet='${c}'`)).toBe("1");
  });

  it("does not deadlock reverse populated-account attempts", async () => {
    ensure(a); ensure(b); const one = start(a, b), two = start(b, a);
    expect(await Promise.all([db.queryAsync(completion(one)), db.queryAsync(completion(two))])).toEqual(["account_conflict", "account_conflict"]);
  });

  it("enforces linked primary and keeps the last/current/primary member", () => {
    ensure(); expect(sql(remove(a, a))).toBe("last"); link();
    expect(sql(primary(a, c))).toBe("not_member"); expect(sql(remove(a, a))).toBe("self");
    expect(sql(remove(b, a))).toBe("primary");
    expect(sql(primary(b, b))).toBe("updated");
    expect(sql(remove(b, a))).toBe("removed");
    expect(ensure(b).primary_wallet).toBe(b);
    expect(() => sql(`update account_profiles set primary_wallet='${c}' where primary_wallet='${b}'`)).toThrow(/foreign key/);
  });

  it("removing the original wallet revokes all old access and allows its separate fresh profile", () => {
    const original = ensure(); link(); sql(name(a, "Protected account")); sql(email(a)); sql(verify(a));
    sql(primary(b, b)); expect(sql(remove(b, a))).toBe("removed");
    expect(sql(name(a, "Compromised"))).toBe("f");
    expect(sql(`select unlink_account_google('${a}','devnet')`)).toBe("f");
    expect(sql(email(a))).toBe("not_member");
    const detached = ensure(a);
    expect(detached.id).not.toBe(original.id); expect(detached.email).toBeNull();
    expect(detached.display_name).toBe(""); expect(ensure(b).display_name).toBe("Protected account");
    expect(ensure(b).email).toBe("owner@example.com");
  });

  function googleState(actor: string, id: string) {
    sql(`insert into account_google_states(state_hash,network,wallet,account_id,browser_hash,code_verifier,redirect_uri,expires_at)
      values('${hash("google")}','devnet','${actor}','${id}','${hash("browser")}','${"v".repeat(43)}','https://manci.test/callback',clock_timestamp()+interval '5 minutes')`);
  }
  const googleComplete = () => `select complete_account_google_link('${hash("google")}','${hash("browser")}','devnet','subject','google@example.com')`;

  it("removal invalidates email, Google and wallet-link proofs issued by that member", () => {
    const source = ensure(); link(); const pending = start(b, c); sql(email(b)); googleState(b, source.id);
    expect(sql(remove(a, b))).toBe("removed");
    expect(sql(completion(pending))).toBe("invalid"); expect(sql(verify(a))).toBe("f");
    expect(sql(googleComplete())).toBe("f"); expect(sql("select count(*) from account_google_states")).toBe("0");
    expect(ensure().pending_email).toBeNull();
    expect(sql("select count(*) from account_email_requests")).toBe("1");
    expect(() => googleState(b, source.id)).toThrow(/foreign key/);
  });

  it("removal revokes older invitations targeting that member so it cannot rejoin using a stale proof", () => {
    const source = ensure(); sql(name(a, "Shared private name")); link(a, c);
    const first = start(a, b), second = start(c, b);
    expect(sql(completion(first))).toBe("linked");
    expect(sql(remove(a, b))).toBe("removed");
    expect(sql(completion(second))).toBe("invalid");
    expect(ensure(a).wallets.some((member) => member.wallet === b)).toBe(false);
    const detached = ensure(b); expect(detached.id).not.toBe(source.id); expect(detached.display_name).toBe("");
  });

  it("another member's edits preserve valid pending proofs and Google completion is shared", () => {
    const source = ensure(); link(); const pending = start(a, c); sql(email(a)); googleState(a, source.id);
    sql(name(b, "Changed name")); sql(primary(b, b));
    expect(sql(verify(b))).toBe("t"); expect(sql(googleComplete())).toBe("t");
    expect(sql(completion(pending))).toBe("linked"); expect(ensure(c).google_email).toBe("google@example.com");
    expect(sql(`select unlink_account_google('${c}','devnet')`)).toBe("t"); expect(ensure(a).google_email).toBeNull();
  });

  it("a concurrent removal either precedes the link or revokes its requester afterwards", async () => {
    ensure(); link(); const proof = start(b, c);
    await Promise.all([db.queryAsync(completion(proof)), db.queryAsync(remove(a, b))]);
    expect(ensure(a).wallets.some((row) => row.wallet === b)).toBe(false);
    expect(sql(completion(proof))).toBe("invalid");
    expect(sql(name(b, "No access"))).toBe("f");
  });

  it("enforces ten-member cap under concurrent completion", async () => {
    const source = ensure();
    for (const digit of "23456789") sql(`insert into account_wallets(network,wallet,account_id) values('devnet','${digit.repeat(32)}','${source.id}')`);
    const one = start(a, "A".repeat(32)), two = start(b, "B".repeat(32));
    expect((await Promise.all([db.queryAsync(completion(one)), db.queryAsync(completion(two))])).sort()).toEqual(["linked", "wallet_limit"]);
    expect(ensure().wallets).toHaveLength(10);
    expect(start(a, c).status).toBe("same_wallet");
    expect(start(a, "C".repeat(32)).status).toBe("wallet_limit");
  });

  it("keeps network identities isolated", () => {
    const source = ensure(); const mainnet = ensure(a, "mainnet"); link();
    expect(ensure(b).id).toBe(source.id); expect(ensure(b, "mainnet").id).not.toBe(source.id);
    expect(ensure(a, "mainnet").id).toBe(mainnet.id); expect(ensure(a, "mainnet").wallets).toHaveLength(1);
  });

  it("binds delayed signed mutations to their intended account after a wallet is relocated", () => {
    const old = ensure(a); link(a, b); sql(remove(a, b));
    const current = ensure(d); link(d, b); link(d, c);
    sql(name(d, "New account owner")); sql(email(d));
    sql(`update account_profiles set google_sub='keep-subject',google_email='keep@example.com',google_linked_at=clock_timestamp() where id='${current.id}'`);
    const before = ensure(d);
    const operations: [string, Record<string, unknown>][] = [
      ["update", { display_name: "Wrong account edit" }],
      ["email.request", { email: "other@example.com", token_hash: hash("delayed-email"), recipient_hash: hash("other@example.com") }],
      ["email.cancel", { token_hash: null }], ["google.unlink", {}],
      ["wallets.start", { target_wallet: "5".repeat(32), token_hash: hash("delayed-link") }],
      ["wallets.primary", { wallet: b }], ["wallets.remove", { wallet: c }],
    ];
    for (const [action, params] of operations) expect(JSON.parse(sql(mutate(b, old.id, action, params)))).toEqual({ ok: false });
    expect(ensure(d)).toEqual(before);
    expect(sql("select count(*) from account_wallet_links")).toBe("0");
    expect(sql("select count(*) from account_email_requests")).toBe("1");
    expect(JSON.parse(sql(mutate(b, current.id, "update", { display_name: "Correct account edit" })))).toEqual({ ok: true, result: true });
    expect(ensure(d).display_name).toBe("Correct account edit");
  });

  it("validates bound mutation actions/fields and permits only matching account membership", () => {
    const account = ensure();
    expect(JSON.parse(sql(mutate(b, account.id, "update", { display_name: "No access" })))).toEqual({ ok: false });
    expect(() => sql(mutate(a, account.id, "update", { display_name: "Name", kyc_status: "verified" }))).toThrow(/Invalid account mutation fields/);
    expect(() => sql(mutate(a, account.id, "unknown", {}))).toThrow(/Invalid account mutation/);
    expect(() => sql(mutate(a, account.id, "update", {}))).toThrow(/Invalid account mutation fields/);
    expect(() => sql(mutate(a, account.id, "update", { display_name: 2 }))).toThrow(/Invalid account mutation values/);
    expect(() => sql(mutate(a, account.id, "email.request", { email: "owner@example.com", token_hash: hash("email"), recipient_hash: hash("forged") }))).toThrow(/Invalid recipient hash/);
    expect(JSON.parse(sql(mutate(a, account.id, "email.request", { email: "owner@example.com", token_hash: hash("email"), recipient_hash: hash("owner@example.com") })))).toEqual({ ok: true, result: "requested" });
    expect(sql(verify())).toBe("t");
  });

  it("denies anonymous/authenticated table and RPC access", () => {
    ensure();
    for (const role of ["anon", "authenticated"]) {
      for (const table of ["account_profiles", "account_wallets", "account_wallet_links"]) expect(() => sql(`set role ${role}; select * from ${table}`)).toThrow(/permission denied/);
      for (const call of [`select ensure_account_profile('${a}','devnet')`, name(a, "attack"), remove(a, b), mutate(a, ensure().id, "google.unlink", {})]) expect(() => sql(`set role ${role}; ${call}`)).toThrow(/permission denied/);
    }
  });

  it("does not delete a blank target if the proof expires while waiting for account locks", async () => {
    const source = ensure(); const target = ensure(b); const proof = start();
    sql(`update account_wallet_links set expires_at=clock_timestamp()+interval '250 milliseconds' where token_hash='${proof.token_hash}'`);
    const blocker = db.queryAsync(`begin;select id from account_profiles where id='${source.id}' for update;select pg_sleep(0.7);commit`);
    // The lock wait is deterministic: poll PostgreSQL's live lock state, not a guessed delay.
    for (let i = 0; i < 100; i++) {
      if (sql("select count(*) from pg_stat_activity where query like 'begin;select id from account_profiles%' and wait_event='PgSleep'") !== "0") break;
    }
    expect(await db.queryAsync(completion(proof))).toBe("invalid"); await blocker;
    expect(ensure(b).id).toBe(target.id); expect(ensure().wallets).toHaveLength(1);
  });
});
