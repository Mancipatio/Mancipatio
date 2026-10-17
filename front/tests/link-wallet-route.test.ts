// /api/clients/link-wallet — who may bind a wallet to a dossier, run for real
// against an in-memory Supabase stand-in (helpers/memory-supabase) with real
// ed25519 signatures. An invitation binds its signer, as before. A dossier
// owned by an account (an email/Google verification) binds only one of the
// account's wallets, or the signer that the account's own session adds to
// the account first: holding the upload link proves nothing about the
// identity behind it.
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getBase58Decoder } from "@solana/kit";
import { siwsMessage, type SiwsPayload } from "@/lib/siws-client";
import { memorySupabase, type MemorySupabase } from "./helpers/memory-supabase";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({
  db: null as null | ReturnType<typeof import("./helpers/memory-supabase").memorySupabase>,
  /** The account session cookie the route reads (null = not signed in). */
  session: null as null | { a: string },
}));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseAdmin: () => state.db!.client }));
vi.mock("@/lib/server/account-auth", () => ({ readAccountSession: () => state.session }));

import { POST } from "@/app/api/clients/link-wallet/route";

const keys = generateKeyPairSync("ed25519");
const signer = getBase58Decoder().decode(keys.publicKey.export({ type: "spki", format: "der" }).subarray(-32));
const origin = "https://manci.test";
const token = "fixture-invitation-secret";
const CLIENT_ID = "10000000-0000-4000-8000-000000000001";
const ACCOUNT_ID = "a0000000-0000-4000-8000-0000000000aa";
const OTHER_ACCOUNT_ID = "a0000000-0000-4000-8000-0000000000bb";
const OTHER_WALLET = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ACCOUNT_REFUSAL = /belongs to a Manci account/;

function body(overrides: Partial<SiwsPayload> = {}) {
  const payload: SiwsPayload = {
    v: 2, origin, network: "devnet", action: "clients.linkWallet", wallet: signer,
    nonce: crypto.randomUUID(), ts: new Date().toISOString(),
    params: { client_id: CLIENT_ID, invitation_hash: createHash("sha256").update(token).digest("hex") },
    ...overrides,
  };
  return {
    payload, publicKey: signer, invitation_token: token,
    signature: sign(null, Buffer.from(siwsMessage(payload)), keys.privateKey).toString("base64"),
  };
}
async function post(input: unknown = body()) {
  const res = await POST(new Request(`${origin}/api/clients/link-wallet`, {
    method: "POST", headers: { "Content-Type": "application/json", origin, "x-real-ip": crypto.randomUUID() },
    body: JSON.stringify(input),
  }));
  return { status: res.status, body: (await res.json()) as { ok: boolean; data?: Record<string, unknown>; error?: string } };
}

/** A dossier as the database holds it: an invitation by default. */
function dossier(overrides: Record<string, unknown> = {}) {
  return {
    id: CLIENT_ID, network: "devnet", display_name: "Carol Example", kyc_status: "more_info", onboarding_status: "invited",
    wallet: null, account_id: null, onboarding_token: token,
    onboarding_token_expires_at: new Date(Date.now() + 86_400_000).toISOString(), created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}
const accountOwned = () => dossier({ account_id: ACCOUNT_ID, onboarding_status: "connected" });
const clients = () => state.db!.rows("clients");
const links = () => state.db!.rows("account_wallets");
const notes = () => state.db!.rows("client_notes");

/** The 0044 binding and the account attach, in miniature, plus call spies. */
function installRpcs(db: MemorySupabase) {
  const link = vi.fn((args: Record<string, unknown>) => {
    const row = db.rows("clients").find((r) =>
      r.id === args.p_client_id && r.network === args.p_network && r.onboarding_token === args.p_token);
    if (!row) return { status: "invalid_invitation" };
    if (row.wallet && row.wallet !== args.p_wallet) return { status: "wallet_conflict" };
    if (row.wallet === args.p_wallet) return { status: "linked", already_linked: true };
    Object.assign(row, { wallet: args.p_wallet, onboarding_status: "connected" });
    db.rows("client_notes").push({ client_id: args.p_client_id, author: args.p_wallet, kind: "system" });
    return { status: "linked", already_linked: false };
  });
  const attach = vi.fn((args: Record<string, unknown>) => {
    const rows = db.rows("account_wallets");
    const existing = rows.find((r) => r.network === args.p_network && r.wallet === args.p_wallet);
    if (existing && existing.account_id !== args.p_account_id) return "account_conflict";
    if (existing) return "same_wallet";
    rows.push({ account_id: args.p_account_id, network: args.p_network, wallet: args.p_wallet });
    return "linked";
  });
  db.rpcs.link_client_wallet = link;
  db.rpcs.attach_account_wallet = attach;
  db.rpcs.consume_siws_nonce = () => true;
  return { link, attach };
}

let rpcs: ReturnType<typeof installRpcs>;
beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", origin);
  vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
  state.db = memorySupabase();
  state.session = null;
  rpcs = installRpcs(state.db);
});
afterEach(() => vi.unstubAllEnvs());

describe("an invitation (no account) binds its signer, as before", () => {
  it("links the signer, writes the note, and never touches the account's wallets", async () => {
    clients().push(dossier());
    expect(await post()).toEqual({ status: 200, body: { ok: true, data: { linked: true, alreadyLinked: false } } });
    expect(rpcs.link).toHaveBeenCalledWith({ p_client_id: CLIENT_ID, p_token: token, p_wallet: signer, p_network: "devnet" });
    expect(clients()[0]).toMatchObject({ wallet: signer, onboarding_status: "connected" });
    expect(notes()).toHaveLength(1);
    expect(rpcs.attach).not.toHaveBeenCalled();
    expect(links()).toEqual([]);
  });

  it("a same-wallet retry stays idempotent", async () => {
    clients().push(dossier({ wallet: signer, onboarding_status: "connected" }));
    expect((await post()).body).toEqual({ ok: true, data: { linked: true, alreadyLinked: true } });
    expect(notes()).toEqual([]);
  });

  it("refuses a wrong, substituted or expired invitation before any binding", async () => {
    clients().push(dossier());
    expect((await post({ ...body(), invitation_token: "another-invitation" })).status).toBe(401);
    const signed = body();
    const altered = { ...signed, payload: { ...signed.payload, params: { ...signed.payload.params, client_id: "10000000-0000-4000-8000-000000000002" } } };
    expect((await post(altered)).status).toBe(401);
    expect((await post(body({ network: "mainnet" }))).status).toBe(401);
    clients()[0].onboarding_token_expires_at = new Date(Date.now() - 1000).toISOString();
    expect((await post()).status).toBe(401);
    clients()[0].onboarding_token = "rotated";
    expect((await post()).status).toBe(401);
    expect(rpcs.link).not.toHaveBeenCalled();
    expect(clients()[0].wallet).toBeNull();
  });

  it("a dossier that already carries a wallet, also one of an account, keeps the wallet rule", async () => {
    clients().push(dossier({ wallet: OTHER_WALLET, account_id: ACCOUNT_ID, onboarding_status: "connected" }));
    const { status, body: answer } = await post();
    expect(status).toBe(409);
    expect(answer.error).toMatch(/different wallet is already linked/);
    expect(clients()[0].wallet).toBe(OTHER_WALLET);
    expect(rpcs.attach).not.toHaveBeenCalled();
  });
});

describe("a dossier owned by an account binds only the account's wallets", () => {
  it("refuses a bare link holder: no session, and the signer is not one of the account's wallets", async () => {
    clients().push(accountOwned());
    links().push({ account_id: ACCOUNT_ID, network: "devnet", wallet: OTHER_WALLET });
    const { status, body: answer } = await post();
    expect(status).toBe(403);
    expect(answer.ok).toBe(false);
    expect(answer.error).toMatch(ACCOUNT_REFUSAL);
    expect(rpcs.link).not.toHaveBeenCalled();
    expect(rpcs.attach).not.toHaveBeenCalled();
    expect(clients()[0].wallet).toBeNull();
    expect(notes()).toEqual([]);
    expect(links()).toHaveLength(1);
  });

  it("refuses a session of another account", async () => {
    clients().push(accountOwned());
    state.session = { a: OTHER_ACCOUNT_ID };
    const { status, body: answer } = await post();
    expect(status).toBe(403);
    expect(answer.error).toMatch(ACCOUNT_REFUSAL);
    expect(rpcs.link).not.toHaveBeenCalled();
    expect(rpcs.attach).not.toHaveBeenCalled();
    expect(clients()[0].wallet).toBeNull();
  });

  it("links a wallet that is already one of the account's wallets, with or without a session", async () => {
    clients().push(accountOwned());
    links().push({ account_id: ACCOUNT_ID, network: "devnet", wallet: signer });
    expect((await post()).body).toEqual({ ok: true, data: { linked: true, alreadyLinked: false } });
    expect(clients()[0]).toMatchObject({ wallet: signer, onboarding_status: "connected" });
    expect(rpcs.attach).not.toHaveBeenCalled();
    expect(links()).toHaveLength(1);
  });

  it("the signed-in owner adds the signer to the account first, then it is linked", async () => {
    clients().push(accountOwned());
    state.session = { a: ACCOUNT_ID };
    expect((await post()).body).toEqual({ ok: true, data: { linked: true, alreadyLinked: false } });
    expect(rpcs.attach).toHaveBeenCalledWith({ p_account_id: ACCOUNT_ID, p_network: "devnet", p_wallet: signer });
    expect(links()).toEqual([{ account_id: ACCOUNT_ID, network: "devnet", wallet: signer }]);
    expect(clients()[0]).toMatchObject({ wallet: signer });
    // The attach ran before the binding.
    expect(rpcs.attach.mock.invocationCallOrder[0]).toBeLessThan(rpcs.link.mock.invocationCallOrder[0]);
  });

  it("a wallet of another account is refused by the attach, and nothing is bound", async () => {
    clients().push(accountOwned());
    links().push({ account_id: OTHER_ACCOUNT_ID, network: "devnet", wallet: signer });
    state.session = { a: ACCOUNT_ID };
    const { status, body: answer } = await post();
    expect(status).toBe(409);
    expect(answer.error).toMatch(/already belongs to another account/);
    expect(rpcs.link).not.toHaveBeenCalled();
    expect(clients()[0].wallet).toBeNull();
    expect(links()).toHaveLength(1);
  });

  it("the membership read is bound to this network", async () => {
    clients().push(accountOwned());
    links().push({ account_id: ACCOUNT_ID, network: "mainnet", wallet: signer });
    expect((await post()).status).toBe(403);
    expect(clients()[0].wallet).toBeNull();
  });

  it("fails closed when the membership read fails", async () => {
    clients().push(accountOwned());
    state.session = { a: ACCOUNT_ID };
    state.db!.failReads.add("account_wallets");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await post()).status).toBe(500);
    log.mockRestore();
    expect(rpcs.attach).not.toHaveBeenCalled();
    expect(rpcs.link).not.toHaveBeenCalled();
  });
});

describe("the binding's own answers still map to the same statuses", () => {
  it.each([
    ["invalid_invitation", 401], ["expired", 401], ["wallet_conflict", 409], ["wallet_in_use", 409], ["terminal_kyc", 403],
  ])("%s", async (status, expected) => {
    clients().push(dossier());
    state.db!.rpcs.link_client_wallet = () => ({ status });
    const answer = await post();
    expect(answer.status).toBe(expected);
    expect(answer.body.ok).toBe(false);
  });

  it("a missing binding function is a 503, never an unguarded update", async () => {
    clients().push(dossier());
    delete state.db!.rpcs.link_client_wallet;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await post()).status).toBe(503);
    log.mockRestore();
    expect(clients()[0].wallet).toBeNull();
  });
});
