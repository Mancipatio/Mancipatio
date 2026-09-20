import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { getBase58Decoder } from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { siwsMessage, type SiwsPayload } from "@/lib/siws-client";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({
  rpc: vi.fn(), sendEmail: vi.fn(), from: vi.fn(), upsert: vi.fn(), update: vi.fn(),
  queries: [] as { table: string; fields?: string; filters: [string, unknown][] }[],
  row: {} as Record<string, unknown>,
}));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseAdmin: () => ({ rpc: mocks.rpc, from: mocks.from }) }));
vi.mock("@/lib/server/email", () => ({ sendEmail: mocks.sendEmail, escapeHtml: (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;") }));

import {
  accountResponse, accountErrorResponse, consumeAccountRateLimit,
  getAccountProfile, projectAccountProfile, requestAccountEmail, verifyAccountEmail,
} from "@/lib/server/account-profile";
import { accountDisplayName, accountEmail, accountEmailToken } from "@/lib/server/account-validation";
import { POST as readAccount } from "@/app/api/account/me/route";
import { POST as updateAccount } from "@/app/api/account/update/route";
import { POST as requestEmail } from "@/app/api/account/email/request/route";
import { POST as verifyEmail } from "@/app/api/account/email/verify/route";
import { POST as cancelEmail } from "@/app/api/account/email/cancel/route";
import { POST as startWallet } from "@/app/api/account/wallets/start/route";
import { POST as completeWallet } from "@/app/api/account/wallets/complete/route";
import { POST as cancelWallet } from "@/app/api/account/wallets/cancel/route";
import { POST as primaryWallet } from "@/app/api/account/wallets/primary/route";
import { POST as removeWallet } from "@/app/api/account/wallets/remove/route";
import { POST as transactionWallet } from "@/app/api/account/wallets/transaction/route";

const keys = generateKeyPairSync("ed25519");
const wallet = getBase58Decoder().decode(keys.publicKey.export({ type: "spki", format: "der" }).subarray(-32));
const origin = "https://manci.test";
const seenNonces = new Set<string>();
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function envelope(action: string, params: Record<string, unknown> = {}, overrides: Partial<SiwsPayload> = {}) {
  if (["account.update", "account.email.request", "account.email.cancel", "account.wallets.start", "account.wallets.primary", "account.wallets.remove"].includes(action)) {
    params = { account_id: mocks.row.id, ...params };
  }
  const payload: SiwsPayload = {
    v: 2, origin, network: "devnet", action, wallet, nonce: crypto.randomUUID(),
    ts: new Date().toISOString(), params, ...overrides,
  };
  return { payload, publicKey: wallet, signature: sign(null, Buffer.from(siwsMessage(payload)), keys.privateKey).toString("base64") };
}
function request(body = envelope("account.me")) {
  return new Request(`${origin}/api/account/me`, { method: "POST", headers: { "Content-Type": "application/json", origin }, body: JSON.stringify(body) });
}

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", origin);
  vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
  vi.stubEnv("GOOGLE_CLIENT_ID", "client-id");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "secret");
  vi.stubEnv("RESEND_API_KEY", "configured");
  vi.stubEnv("EMAIL_FROM", "Manci <noreply@manci.test>");
  seenNonces.clear(); mocks.queries.length = 0;
  mocks.row = {
    id: "10000000-0000-4000-8000-000000000001", primary_wallet: wallet,
    wallets: [{ wallet, linked_at: "2026-09-20T10:00:00Z", private_note: "hidden" }],
    wallet, network: "devnet", display_name: "User", email: "verified@example.com", email_verified_at: "2026-09-20T10:00:00Z",
    pending_email: null, pending_email_expires_at: null, google_email: null, google_linked_at: null,
    created_at: "2026-09-20T10:00:00Z", updated_at: "2026-09-20T10:00:00Z",
    google_sub: "private-provider-subject", pending_email_token_hash: "private-token-hash",
    kyc_status: "verified", notes: "private CRM note",
  };
  mocks.upsert.mockReset().mockResolvedValue({ error: null });
  mocks.update.mockReset(); mocks.from.mockReset();
  mocks.from.mockImplementation((table: string) => {
    const entry = { table, filters: [] as [string, unknown][], fields: undefined as string | undefined };
    mocks.queries.push(entry);
    const query = {
      select(fields: string) { entry.fields = fields; return query; },
      eq(field: string, value: unknown) { entry.filters.push([field, value]); return query; },
      single: async () => ({ data: mocks.row, error: null }),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve({ error: null }).then(resolve),
      upsert: mocks.upsert,
      update(patch: Record<string, unknown>) { mocks.update(patch); return query; },
    };
    return query;
  });
  mocks.rpc.mockReset().mockImplementation(async (name: string, args: Record<string, unknown>) => {
    if (name === "consume_siws_nonce") {
      const fresh = !seenNonces.has(String(args.p_nonce)); seenNonces.add(String(args.p_nonce));
      return { data: fresh, error: null };
    }
    if (name === "ensure_account_profile") return { data: mocks.row, error: null };
    if (name === "mutate_account_profile") {
      if (args.p_account_id !== mocks.row.id) return { data: { ok: false }, error: null };
      const params = args.p_params as Record<string, unknown>;
      let result: unknown = true;
      if (args.p_action === "email.request") result = "requested";
      if (args.p_action === "wallets.primary") result = "updated";
      if (args.p_action === "wallets.remove") result = "removed";
      if (args.p_action === "wallets.start") result = {
        status: "started", account_id: mocks.row.id, requested_by: args.p_wallet,
        target_wallet: params.target_wallet, expires_at: new Date(Date.now() + 600_000).toISOString(),
      };
      return { data: { ok: true, result }, error: null };
    }
    if (name === "start_account_wallet_link") return { data: {
      status: "started", account_id: mocks.row.id, requested_by: args.p_wallet,
      target_wallet: args.p_target_wallet, expires_at: new Date(Date.now() + 600_000).toISOString(),
    }, error: null };
    if (name === "complete_account_wallet_link") return { data: "linked", error: null };
    if (name === "set_account_primary_wallet") return { data: "updated", error: null };
    if (name === "remove_account_wallet") return { data: "removed", error: null };
    return { data: name === "request_account_email_verification" ? "requested" : true, error: null };
  });
  mocks.sendEmail.mockReset().mockResolvedValue({ sent: true, id: "provider-id" });
});
afterEach(() => vi.unstubAllEnvs());

describe("private account API", () => {
  it("lazily creates only a contact profile and projects only private self-service fields", async () => {
    const result = await readAccount(request());
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("no-store");
    const json = await result.json();
    expect(json.data.profile).toEqual(projectAccountProfile(mocks.row));
    expect(json.data.features).toEqual({ google: true, email: true });
    expect(JSON.stringify(json)).not.toMatch(/private-provider-subject|private-token-hash|kyc_status|CRM/);
    expect(mocks.rpc).toHaveBeenCalledWith("ensure_account_profile", { p_wallet: wallet, p_network: "devnet" });
    expect(mocks.from).not.toHaveBeenCalled();
    expect(json.data.profile.wallets[0]).not.toHaveProperty("private_note");
  });

  it("rejects replay, invalid signatures, other actions, networks and origins", async () => {
    const body = envelope("account.me");
    expect((await readAccount(request(body))).status).toBe(200);
    expect((await readAccount(request(body))).status).toBe(401);
    const cases = [
      envelope("account.update"), envelope("account.me", {}, { network: "mainnet" }),
      envelope("account.me", {}, { origin: "https://other.test" }),
      { ...envelope("account.me"), publicKey: "1".repeat(32) },
      { ...envelope("account.me"), signature: Buffer.alloc(64).toString("base64") },
    ];
    for (const bad of cases) {
      mocks.from.mockClear();
      const response = await readAccount(request(bad));
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(mocks.from).not.toHaveBeenCalled();
    }
  });

  it("writes only the validated name; never mass assigns privileges or verification", async () => {
    const response = await updateAccount(request(envelope("account.update", { display_name: "  New name  " })));
    expect(response.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith("mutate_account_profile", { p_wallet: wallet, p_network: "devnet", p_account_id: mocks.row.id, p_action: "update", p_params: { display_name: "New name" } });
    for (const extra of ["email", "email_verified_at", "kyc_status", "wallet", "network", "google_sub"]) {
      mocks.rpc.mockClear();
      expect((await updateAccount(request(envelope("account.update", { display_name: "New", [extra]: "forged" })))).status).toBe(400);
      expect(mocks.rpc.mock.calls.some(([name]) => name === "mutate_account_profile")).toBe(false);
    }
  });

  it("rejects oversized streamed bodies before signature/database work", async () => {
    const response = await updateAccount(request(envelope("account.update", { display_name: "x".repeat(5000) })));
    expect(response.status).toBe(413);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("requires empty params on read and cancel; verifies only the signed token", async () => {
    expect((await readAccount(request(envelope("account.me", { wallet: "other" })))).status).toBe(400);
    expect((await cancelEmail(request(envelope("account.email.cancel", { token: "x" })))).status).toBe(400);
    expect((await verifyEmail(request(envelope("account.email.verify", { token: "t".repeat(43), email: "spoofed@example.com" })))).status).toBe(400);
    expect((await verifyEmail(request(envelope("account.email.verify", { token: "t".repeat(43) })))).status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith("verify_account_email", { p_wallet: wallet, p_network: "devnet", p_token_hash: hash("t".repeat(43)) });
  });

  it("reports disabled providers honestly and does not leak internal failures", async () => {
    vi.stubEnv("GOOGLE_CLIENT_SECRET", ""); vi.stubEnv("EMAIL_FROM", "");
    expect((await (await accountResponse(wallet, "devnet")).json()).data.features).toEqual({ google: false, email: false });
    const response = await requestEmail(request(envelope("account.email.request", { email: "user@example.com" })));
    expect(response.status).toBe(503);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    const failure = accountErrorResponse(new Error("token=secret user@example.com"));
    expect(await failure.text()).not.toMatch(/secret|user@example/);
    expect(failure.headers.get("cache-control")).toBe("no-store");
  });

  it("requires the intended account ID on every bound mutation and rejects a different current account", async () => {
    const routes = [
      [updateAccount, "account.update", { display_name: "New name" }],
      [requestEmail, "account.email.request", { email: "owner@example.com" }],
      [cancelEmail, "account.email.cancel", {}],
      [startWallet, "account.wallets.start", { target_wallet: "1".repeat(32) }],
      [primaryWallet, "account.wallets.primary", { wallet: "1".repeat(32) }],
      [removeWallet, "account.wallets.remove", { wallet: "1".repeat(32) }],
    ] as const;
    for (const [handler, action, params] of routes) {
      expect((await handler(request(envelope(action, { ...params, account_id: undefined })))).status).toBe(400);
      expect((await handler(request(envelope(action, { ...params, account_id: "20000000-0000-4000-8000-000000000002" })))).status).toBe(403);
    }
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.rpc.mock.calls.some(([name]) => name === "ensure_account_profile")).toBe(false);
  });

  it("a delayed signed email/name request cannot mutate or send from the wallet's new account", async () => {
    const emailIntent = envelope("account.email.request", { email: "other@example.com" });
    const nameIntent = envelope("account.update", { display_name: "Stale intent" });
    mocks.row.id = "20000000-0000-4000-8000-000000000002";
    expect((await requestEmail(request(emailIntent))).status).toBe(403);
    expect((await updateAccount(request(nameIntent))).status).toBe(403);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.row.display_name).toBe("User");
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.rpc.mock.calls.some(([name]) => name === "ensure_account_profile")).toBe(false);
  });
});

describe("email ownership delivery", () => {
  it("stores only a hash of a random 32-byte token and sends the canonical-origin link", async () => {
    await requestAccountEmail(request(), wallet, "devnet", "user@example.com", String(mocks.row.id));
    const sent = mocks.sendEmail.mock.calls[0][0];
    const raw = sent.html.match(/token=([A-Za-z0-9_-]{43})/)?.[1];
    expect(raw).toBeTruthy();
    expect(Buffer.from(raw, "base64url")).toHaveLength(32);
    expect(sent.html).toContain(`${origin}/account/verify?token=`);
    expect(sent).toMatchObject({ to: "user@example.com", redactErrors: true });
    expect(mocks.rpc).toHaveBeenCalledWith("mutate_account_profile", {
      p_wallet: wallet, p_network: "devnet", p_account_id: mocks.row.id, p_action: "email.request",
      p_params: { email: "user@example.com", token_hash: hash(raw), recipient_hash: hash("user@example.com") },
    });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("normalizes arbitrary valid mailbox addresses before storing and sending", async () => {
    expect((await requestEmail(request(envelope("account.email.request", { email: " Personal+Tag@Example.ORG " })))).status).toBe(200);
    expect(mocks.sendEmail.mock.calls[0][0].to).toBe("personal+tag@example.org");
  });

  it.each([false, "throw"])("cleans up the exact failed delivery and never claims verification (%s)", async (failure) => {
    if (failure === "throw") mocks.sendEmail.mockRejectedValueOnce(new Error("private provider error"));
    else mocks.sendEmail.mockResolvedValueOnce({ sent: false, error: "private provider error" });
    await expect(requestAccountEmail(request(), wallet, "devnet", "user@example.com", String(mocks.row.id))).rejects.toMatchObject({ status: 503, message: "We could not send the verification email. Please try again later." });
    const issued = mocks.rpc.mock.calls.find(([name, args]) => name === "mutate_account_profile" && args.p_action === "email.request")?.[1];
    expect(mocks.rpc).toHaveBeenCalledWith("mutate_account_profile", {
      p_wallet: wallet, p_network: "devnet", p_account_id: mocks.row.id, p_action: "email.cancel", p_params: { token_hash: issued.p_params.token_hash },
    });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("does not send when the shared limit rejects or the database fails closed", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: { ok: true, result: "rate_limited" }, error: null });
    await expect(requestAccountEmail(request(), wallet, "devnet", "user@example.com", String(mocks.row.id))).rejects.toMatchObject({ status: 429 });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: "database internal details" } });
    await expect(requestAccountEmail(request(), wallet, "devnet", "user@example.com", String(mocks.row.id))).rejects.toMatchObject({ status: 503 });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it("does not treat an unmatched or replayed token as verified", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: false, error: null });
    await expect(verifyAccountEmail(wallet, "devnet", "t".repeat(43))).rejects.toMatchObject({ status: 400 });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("hashes durable limiter keys and fails closed when verification storage is missing", async () => {
    const key = `google:${wallet}:devnet`;
    await consumeAccountRateLimit(key, 5, 600);
    expect(mocks.rpc).toHaveBeenCalledWith("consume_account_rate_limit", { p_key_hash: hash(key), p_limit: 5, p_window_seconds: 600 });
    mocks.rpc.mockResolvedValueOnce({ error: { message: "missing schema" } });
    await expect(getAccountProfile(wallet, "devnet")).rejects.toMatchObject({ status: 503 });
  });
});

describe("account input boundaries", () => {
  it("allows clearing a name and preserves ordinary Unicode names", () => {
    expect(accountDisplayName("  ")).toBe("");
    expect(accountDisplayName("  Mlađen Rakić  ")).toBe("Mlađen Rakić");
    expect(() => accountDisplayName("x".repeat(101))).toThrow();
    expect(() => accountDisplayName("Name\nInjection")).toThrow();
  });
  it.each(["a@example.com\nBcc:bad@example.com", ".a@example.com", "a..b@example.com", "a@-example.com", "a@example", "a@", "a".repeat(65) + "@example.com"])("rejects malformed email %s", (value) => {
    expect(() => accountEmail(value)).toThrow();
  });
  it("rejects malformed tokens", () => {
    for (const value of [null, "", "a".repeat(42), "a".repeat(44), "/".repeat(43)]) expect(() => accountEmailToken(value)).toThrow();
  });
});

describe("two-wallet link API", () => {
  const other = "1".repeat(32);
  const attempt = () => ({ token: "t".repeat(43), account_id: String(mocks.row.id), requested_by: other, target_wallet: wallet });

  it("returns a frozen target-bound attempt and stores only a random-token hash", async () => {
    const response = await startWallet(request(envelope("account.wallets.start", { target_wallet: other })));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body.data).toMatchObject({ account_id: mocks.row.id, requested_by: wallet, target_wallet: other });
    expect(Buffer.from(body.data.token, "base64url")).toHaveLength(32);
    expect(mocks.rpc).toHaveBeenCalledWith("mutate_account_profile", {
      p_wallet: wallet, p_network: "devnet", p_account_id: mocks.row.id, p_action: "wallets.start",
      p_params: { target_wallet: other, token_hash: hash(body.data.token) },
    });
    expect(JSON.stringify(mocks.rpc.mock.calls)).not.toContain(body.data.token);
    expect(body.data).not.toHaveProperty("profile");
  });

  it("requires the exact target signer and forwards all frozen fields in the signed completion", async () => {
    const wrong = { ...attempt(), target_wallet: other };
    expect((await completeWallet(request(envelope("account.wallets.complete", wrong)))).status).toBe(403);
    expect(mocks.rpc.mock.calls.some(([name]) => name === "complete_account_wallet_link")).toBe(false);
    const proof = attempt();
    expect((await completeWallet(request(envelope("account.wallets.complete", proof)))).status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith("complete_account_wallet_link", {
      p_wallet: wallet, p_network: "devnet", p_token_hash: hash(proof.token), p_account_id: proof.account_id,
      p_requested_by: proof.requested_by, p_target_wallet: proof.target_wallet,
    });
  });

  it("signed cancellation binds both frozen participants and returns no profile", async () => {
    const proof = attempt();
    const response = await cancelWallet(request(envelope("account.wallets.cancel", proof)));
    expect(await response.json()).toEqual({ ok: true, data: { cancelled: true } });
    expect(mocks.rpc).toHaveBeenCalledWith("cancel_account_wallet_link", {
      p_wallet: wallet, p_network: "devnet", p_token_hash: hash(proof.token), p_account_id: proof.account_id,
      p_requested_by: proof.requested_by, p_target_wallet: proof.target_wallet,
    });
  });

  it("primary and removal actions authorize only signed actor membership via atomic RPCs", async () => {
    expect((await primaryWallet(request(envelope("account.wallets.primary", { wallet: other })))).status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith("mutate_account_profile", { p_wallet: wallet, p_network: "devnet", p_account_id: mocks.row.id, p_action: "wallets.primary", p_params: { wallet: other } });
    expect((await removeWallet(request(envelope("account.wallets.remove", { wallet: other })))).status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith("mutate_account_profile", { p_wallet: wallet, p_network: "devnet", p_account_id: mocks.row.id, p_action: "wallets.remove", p_params: { wallet: other } });
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("transaction intent returns only the acting/primary wallet and account identity", async () => {
    const response = await transactionWallet(request(envelope("account.wallets.transaction")));
    expect(await response.json()).toEqual({ ok: true, data: { wallet, network: "devnet", account_id: mocks.row.id, primary_wallet: wallet } });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("strictly rejects unexpected fields, invalid addresses and mismatched action/network", async () => {
    expect((await startWallet(request(envelope("account.wallets.start", { target_wallet: "invalid" })))).status).toBe(400);
    expect((await primaryWallet(request(envelope("account.wallets.primary", { wallet: other, extra: mocks.row.id })))).status).toBe(400);
    expect((await transactionWallet(request(envelope("account.wallets.transaction", { wallet: other })))).status).toBe(400);
    expect((await completeWallet(request(envelope("account.wallets.complete", { ...attempt(), token: "short" })))).status).toBe(400);
    expect((await completeWallet(request(envelope("account.wallets.complete", attempt(), { network: "mainnet" })))).status).toBe(401);
    expect((await removeWallet(request(envelope("account.wallets.primary", { wallet: other })))).status).toBe(401);
    expect(mocks.rpc.mock.calls.every(([name]) => name === "consume_siws_nonce")).toBe(true);
  });

  it("rejects a profile response that lacks the acting wallet membership", async () => {
    mocks.row.wallets = [{ wallet: other, linked_at: "2026-09-20T10:00:00Z" }];
    expect((await readAccount(request())).status).toBe(503);
  });
});
