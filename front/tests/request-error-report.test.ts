import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildSentryEnvelope, describeRequestError, parseSentryDsn, reportRequestError, scrubText, SentryRateLimiter,
} from "@/lib/request-error-report";

const WALLET = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const SIGNATURE = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW";
// A production SolanaError: the context (addresses, signatures) is base64 in the decode hint.
const SOLANA_CONTEXT = Buffer.from(`address=${WALLET}&addresses=${WALLET}%2C${WALLET}`, "utf8").toString("base64");
const SOLANA_ERROR = `Solana error #3230000; Decode this error by running \`npx @solana/errors decode -- 3230000 '${SOLANA_CONTEXT}'\``;
// Base64 ed25519 signatures (SIWS), one with little character variety.
const BASE64_SIGNATURE = Buffer.from(Array.from({ length: 64 }, (_, i) => (i * 37 + 11) % 256)).toString("base64");
const PLAIN_BASE64 = Buffer.alloc(64, 7).toString("base64");
const LOGIN_TOKEN = Buffer.alloc(32, 0xa7).toString("base64url");
const context = { routerKind: "App Router", routePath: "/api/assets/[id]", routeType: "route", renderSource: undefined, revalidateReason: undefined };
const request = {
  path: `/api/assets/${WALLET}?token=MAGIC_LINK_TOKEN`,
  method: "POST",
  headers: { cookie: "manci_session=SESSION_COOKIE", authorization: "Bearer HEADER_TOKEN" },
};

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("scrubText", () => {
  it.each([
    ["an RPC URL with its API key", "fetch failed https://mainnet.helius-rpc.com/?api-key=SECRET_KEY", "fetch failed https://mainnet.helius-rpc.com", /SECRET_KEY/],
    ["a connection string with credentials", "connect postgres://admin:hunter2@db.internal:5432/prod", "connect postgres://db.internal", /hunter2|admin/],
    ["an email", "Key (email)=(Jane.Doe+x@Example.org) already exists", "Key (email)=([email]) already exists", /Jane/],
    ["a bearer token", "sent Bearer abc.def-123 upstream", "sent Bearer [redacted] upstream", /abc\.def/],
    ["a JWT", "bad token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl", "bad token [jwt]", /eyJ/],
    ["an IPv4 address", "ECONNREFUSED 10.0.12.7:443", "ECONNREFUSED [ip]:443", /10\.0/],
    ["an IPv6 address", "from 2001:db8:85a3:0:0:8a2e:370:7334", "from [ip]", /2001/],
    ["a wallet", `wallet ${WALLET} not allowed`, "wallet [base58] not allowed", /9xQe/],
    ["a signature", `tx ${SIGNATURE} failed`, "tx [base58] failed", /5VER/],
    ["a token hash", `hash ${"ab12".repeat(16)} unknown`, "hash [hex] unknown", /ab12ab12/],
    ["an IBAN", "iban DE89370400440532013000 rejected", "iban [iban] rejected", /DE89/],
    ["a card-like number", "card 4111 1111 1111 1111 declined", "card [number] declined", /4111/],
    ["a production SolanaError context", SOLANA_ERROR,
      "Solana error #3230000; Decode this error by running `npx @solana/errors decode -- 3230000 '[context]'`", /YWRk|9xQe/],
    ["a base64 signature", `bad signature ${BASE64_SIGNATURE} for message`, "bad signature [blob] for message", /[A-Za-z0-9+/]{12}/],
    ["a padded base64 value", `sig ${PLAIN_BASE64} bad`, "sig [blob] bad", /BwcH/],
    ["a wallet after an underscore", `user_${WALLET} missing`, "[blob] missing", /9xQe|VFin/],
    ["a wallet next to a non-base58 letter", `l${WALLET}0`, "[blob]", /9xQe|VFin/],
    ["a relative sign-in link", `/login/email?token=${LOGIN_TOKEN} expired`, "/login/email?token=[redacted] expired", /p6en|[A-Za-z0-9_-]{20}/],
    ["an onboarding link", "GET /onboarding/3f2b8c1e-9a4d-4c2b-8e1f-0a1b2c3d4e5f?t=tok123456 failed", "GET /onboarding/[uuid]?t=[redacted] failed", /3f2b|tok123/],
    ["an OAuth callback query", "callback ?code=4/0AbcDEF&state=xyz789 rejected", "callback ?code=[redacted]&state=[redacted] rejected", /0AbcDEF|xyz789/],
    ["a URL-encoded email in a query", "/invite?to=foo%40example.com", "/invite?to=[redacted]", /example/],
    ["a URL-encoded email in prose", "invite foo%40example.com failed", "invite [email] failed", /example/],
    ["a Google access token", "google said ya29.a0AfH6SMBx-abc_def invalid", "google said [google-token] invalid", /ya29|a0Af/],
    ["a Google refresh token", "refresh 1//0gAbCdEf-ghij revoked", "refresh [google-token] revoked", /0gAb/],
    ["a Supabase secret key", "key sb_secret_abcDEF123-xyz rejected", "key [supabase-key] rejected", /abcDEF/],
  ])("removes %s", (_label, input, expected, leak) => {
    const output = scrubText(input);
    expect(output).toBe(expected);
    expect(output).not.toMatch(leak);
  });

  it("keeps operational detail such as slots, codes and route names", () => {
    expect(scrubText("Snapshot at slot 412345678 older than 412345700 (code 57014) in /api/health"))
      .toBe("Snapshot at slot 412345678 older than 412345700 (code 57014) in /api/health");
  });

  it.each([
    'duplicate key value violates unique constraint "indexer_events_network_signature_uidx"',
    "SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR in getMultipleAccountsInfo at /api/payout-snapshots/prepare",
    "Base64EncodedWireTransaction TransactionExpiredBlockheightExceededError createAssociatedTokenAccountIdempotent",
    "Solana error #8100002; Decode this error by running `npx @solana/errors decode -- 8100002`",
  ])("keeps identifiers and constraint names: %s", (input) => {
    expect(scrubText(input)).toBe(input);
  });

  it("collapses whitespace and truncates", () => {
    const output = scrubText(`a\n\n  b ${"word ".repeat(200)}`);
    expect(output.startsWith("a b word word")).toBe(true);
    expect(output).toHaveLength(300);
    expect(output.endsWith("…")).toBe(true);
  });
});

describe("describeRequestError", () => {
  it("uses the route pattern and method, never the requested path or headers", () => {
    const error = Object.assign(new TypeError(`Cannot read wallet ${WALLET} for jane@example.org`), { digest: "1234567890@E42" });
    const line = describeRequestError(error, request, context);
    expect(line).toEqual({
      level: "error", event: "request_error", route: "/api/assets/[id]", routeType: "route", method: "POST",
      digest: "1234567890@E42", name: "TypeError", message: "Cannot read wallet [base58] for [email]",
    });
    expect(JSON.stringify(line)).not.toMatch(/MAGIC_LINK_TOKEN|SESSION_COOKIE|HEADER_TOKEN|9xQe|jane/);
  });

  it("keeps only the kind of a control-flow digest, which would carry a path", () => {
    const error = Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/account?token=abc;307;" });
    expect(describeRequestError(error, request, context).digest).toBe("NEXT_REDIRECT");
    const odd = Object.assign(new Error("x"), { digest: "<script>" });
    expect(describeRequestError(odd, request, context).digest).toBeNull();
  });

  it("never serializes thrown non-errors", () => {
    const line = describeRequestError({ email: "jane@example.org", wallet: WALLET }, { method: "get" }, {});
    expect(line).toMatchObject({ name: "NonError", message: "Non-error value thrown", method: "OTHER", route: "unknown", routeType: null, digest: null });
    expect(describeRequestError(`boom for jane@example.org`, request, context)).toMatchObject({ name: "Error", message: "boom for [email]" });
  });
});

describe("parseSentryDsn", () => {
  it.each([
    ["https://abc123@o42.ingest.sentry.io/4507", "https://o42.ingest.sentry.io/api/4507/envelope/", "abc123"],
    ["https://abc123@sentry.example.com:9000/sub/path/7", "https://sentry.example.com:9000/sub/path/api/7/envelope/", "abc123"],
  ])("targets the envelope endpoint of %s", (dsn, envelopeUrl, publicKey) => {
    expect(parseSentryDsn(dsn)).toEqual({ envelopeUrl, publicKey });
  });

  it.each([undefined, "", "not a url", "https://o42.ingest.sentry.io/4507", "https://abc@o42.ingest.sentry.io/", "ftp://abc@host/1", "https://abc@host/project",
    "http://abc123@o42.ingest.sentry.io/4507"])(
    "ignores an unusable DSN %s", (dsn) => {
      expect(parseSentryDsn(dsn)).toBeNull();
    },
  );
});

describe("reportRequestError", () => {
  const error = Object.assign(new Error(`RPC https://rpc.example.com/?api-key=SECRET_KEY failed for ${WALLET}`), { digest: "99" });

  it("logs one structured line and sends nothing without SENTRY_DSN", async () => {
    const log = vi.fn();
    const fetchImpl = vi.fn();
    await expect(reportRequestError(error, request, context, { env: {}, log, fetchImpl })).resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledOnce();
    const line = JSON.parse(log.mock.calls[0][0]);
    expect(line).toMatchObject({ event: "request_error", route: "/api/assets/[id]", digest: "99", message: "RPC https://rpc.example.com failed for [base58]" });
  });

  it("forwards a minimal event to the Sentry envelope endpoint when configured", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const env = { SENTRY_DSN: "https://pubkey@o1.ingest.sentry.io/123", VERCEL_ENV: "production", VERCEL_GIT_COMMIT_SHA: "abcdef1234567", NEXT_PUBLIC_NETWORK: "devnet" };
    await reportRequestError(error, request, context, { env, log: () => {}, fetchImpl, limiter: new SentryRateLimiter() });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://o1.ingest.sentry.io/api/123/envelope/");
    expect(init.method).toBe("POST");
    expect(init.headers["X-Sentry-Auth"]).toContain("sentry_key=pubkey");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const [header, item, payload, rest] = String(init.body).split("\n");
    expect(rest).toBe("");
    const event = JSON.parse(payload);
    expect(JSON.parse(header).event_id).toBe(event.event_id);
    expect(JSON.parse(item)).toEqual({ type: "event" });
    expect(event).toMatchObject({
      level: "error", environment: "production", release: "abcdef1234567", transaction: "/api/assets/[id]",
      tags: { method: "POST", route_type: "route", digest: "99", network: "devnet" },
      exception: { values: [{ type: "Error", value: "RPC https://rpc.example.com failed for [base58]" }] },
    });
    expect(event).not.toHaveProperty("user");
    expect(event).not.toHaveProperty("request");
    expect(String(init.body)).not.toMatch(/SECRET_KEY|9xQe|MAGIC_LINK_TOKEN|SESSION_COOKIE|HEADER_TOKEN/);
  });

  it("never rejects when Sentry fails, and gives up at the timeout", async () => {
    const env = { SENTRY_DSN: "https://pubkey@o1.ingest.sentry.io/123" };
    const down = vi.fn().mockRejectedValue(new Error("down"));
    await expect(reportRequestError(error, request, context, { env, log: () => {}, fetchImpl: down, limiter: new SentryRateLimiter() })).resolves.toBeUndefined();
    expect(down).toHaveBeenCalledOnce();
    const hanging = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    }));
    const started = Date.now();
    await expect(reportRequestError(error, request, context, {
      env, log: () => {}, fetchImpl: hanging as unknown as typeof fetch, timeoutMs: 30, limiter: new SentryRateLimiter(),
    })).resolves.toBeUndefined();
    expect(hanging).toHaveBeenCalledOnce();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("uses a short default timeout", async () => {
    const { SENTRY_TIMEOUT_MS } = await import("@/lib/request-error-report");
    expect(SENTRY_TIMEOUT_MS).toBeLessThanOrEqual(1_000);
  });

  it("sends each distinct error once per minute and caps sends per instance, logging every one", async () => {
    const env = { SENTRY_DSN: "https://pubkey@o1.ingest.sentry.io/123" };
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const log = vi.fn();
    const limiter = new SentryRateLimiter(3, 60_000);
    const boom = (n: number) => new Error(`boom ${n}`);
    for (let i = 0; i < 5; i++) await reportRequestError(boom(1), request, context, { env, log, fetchImpl, limiter });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    for (let n = 2; n <= 6; n++) await reportRequestError(boom(n), request, context, { env, log, fetchImpl, limiter });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(log).toHaveBeenCalledTimes(10);
  });

  it("opens a new send budget after the window", () => {
    const limiter = new SentryRateLimiter(1, 60_000);
    expect(limiter.allow("a", 0)).toBe(true);
    expect(limiter.allow("a", 59_999)).toBe(false);
    expect(limiter.allow("b", 59_999)).toBe(false);
    expect(limiter.allow("a", 60_000)).toBe(true);
  });

  it("never throws even if logging fails", async () => {
    await expect(reportRequestError(error, request, context, { env: {}, log: () => { throw new Error("stdout closed"); } })).resolves.toBeUndefined();
  });

  it("builds a stable envelope for a given id and time", () => {
    const line = describeRequestError(new Error("x"), { method: "GET" }, { routePath: "/page", routeType: "render" });
    const body = buildSentryEnvelope(line, {}, 1_700_000_000_000, "0".repeat(32));
    expect(body.split("\n")[0]).toBe(JSON.stringify({ event_id: "0".repeat(32), sent_at: "2023-11-14T22:13:20.000Z" }));
    expect(JSON.parse(body.split("\n")[2])).toMatchObject({ timestamp: 1_700_000_000, environment: "production", transaction: "/page" });
  });
});

describe("instrumentation onRequestError", () => {
  it("reports through the scrubbed logger and resolves", async () => {
    vi.stubEnv("SENTRY_DSN", "");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { onRequestError } = await import("@/instrumentation");
    await expect(onRequestError(error(), request, { ...context, renderSource: "server-rendering", revalidateReason: undefined } as never)).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledOnce();
    expect(JSON.parse(String(spy.mock.calls[0][0]))).toMatchObject({ event: "request_error", message: "boom [email]" });
    function error() { return new Error("boom jane@example.org"); }
  });
});
