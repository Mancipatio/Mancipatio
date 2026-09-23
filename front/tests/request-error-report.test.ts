import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildSentryEnvelope, describeRequestError, parseSentryDsn, reportRequestError, scrubText,
} from "@/lib/request-error-report";

const WALLET = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const SIGNATURE = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW";
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
  ])("removes %s", (_label, input, expected, leak) => {
    const output = scrubText(input);
    expect(output).toBe(expected);
    expect(output).not.toMatch(leak);
  });

  it("keeps operational detail such as slots, codes and route names", () => {
    expect(scrubText("Snapshot at slot 412345678 older than 412345700 (code 57014) in /api/health"))
      .toBe("Snapshot at slot 412345678 older than 412345700 (code 57014) in /api/health");
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

  it.each([undefined, "", "not a url", "https://o42.ingest.sentry.io/4507", "https://abc@o42.ingest.sentry.io/", "ftp://abc@host/1", "https://abc@host/project"])(
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
    await reportRequestError(error, request, context, { env, log: () => {}, fetchImpl });
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
    await expect(reportRequestError(error, request, context, { env, log: () => {}, fetchImpl: vi.fn().mockRejectedValue(new Error("down")) })).resolves.toBeUndefined();
    const hanging = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    }));
    const started = Date.now();
    await expect(reportRequestError(error, request, context, { env, log: () => {}, fetchImpl: hanging as unknown as typeof fetch, timeoutMs: 30 })).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1_000);
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
