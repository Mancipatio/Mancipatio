import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { TURNSTILE_SITEVERIFY_URL, TURNSTILE_TIMEOUT_MS, turnstileEnabled, verifyTurnstile } from "@/lib/server/turnstile";
import { TURNSTILE_ACTIONS, turnstileSiteKey } from "@/lib/turnstile";

const SECRET = "0x4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const TEST_PASS_SECRET = "1x0000000000000000000000000000000AA";
const action = TURNSTILE_ACTIONS.emailLogin;
const fetchMock = vi.fn();

function request(headers: Record<string, string> = { "x-real-ip": "203.0.113.7" }) {
  return new Request("https://www.manci.test/api/auth/email/start", { method: "POST", headers });
}

function answer(body: unknown, status = 200) {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
}

const ok = { success: true, hostname: "www.manci.test", action, "error-codes": [] };

async function status(promise: Promise<unknown>): Promise<number | "resolved"> {
  try {
    await promise;
    return "resolved";
  } catch (error) {
    return (error as { status?: number }).status ?? -1;
  }
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://www.manci.test");
  vi.stubEnv("TURNSTILE_SECRET_KEY", SECRET);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("verifyTurnstile", () => {
  it("is a no-op when TURNSTILE_SECRET_KEY is unset or blank", async () => {
    for (const value of [undefined, "", "   "]) {
      vi.stubEnv("TURNSTILE_SECRET_KEY", value);
      expect(turnstileEnabled()).toBe(false);
      await expect(verifyTurnstile(request(), undefined, action)).resolves.toBeUndefined();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts secret, token and client IP to siteverify with a short timeout", async () => {
    answer(ok);
    await expect(verifyTurnstile(request(), "tok-1", action)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(TURNSTILE_SITEVERIFY_URL);
    expect(init.method).toBe("POST");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const form = init.body as URLSearchParams;
    expect(form.get("secret")).toBe(SECRET);
    expect(form.get("response")).toBe("tok-1");
    expect(form.get("remoteip")).toBe("203.0.113.7");
    expect(TURNSTILE_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
  });

  it("uses the rightmost forwarded hop and omits remoteip when there is none", async () => {
    answer(ok);
    await verifyTurnstile(request({ "x-forwarded-for": "10.0.0.1, 198.51.100.2" }), "tok", action);
    expect((fetchMock.mock.calls[0][1].body as URLSearchParams).get("remoteip")).toBe("198.51.100.2");
    answer(ok);
    await verifyTurnstile(request({}), "tok", action);
    expect((fetchMock.mock.calls[1][1].body as URLSearchParams).has("remoteip")).toBe(false);
  });

  it.each([
    ["missing", undefined, 400],
    ["empty", "", 400],
    ["not a string", 42, 400],
    ["longer than 2048 characters", "x".repeat(2049), 403],
  ])("refuses a %s token without calling Cloudflare", async (_label, token, expected) => {
    expect(await status(verifyTurnstile(request(), token, action))).toBe(expected);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts a 2048-character token", async () => {
    answer(ok);
    expect(await status(verifyTurnstile(request(), "x".repeat(2048), action))).toBe("resolved");
  });

  it.each([
    ["an unsuccessful answer", { success: false, "error-codes": ["invalid-input-response"] }, 403],
    ["a spent or expired token", { success: false, "error-codes": ["timeout-or-duplicate"] }, 403],
    ["a success flag that is not literally true", { ...ok, success: "true" }, 403],
    ["another action", { ...ok, action: "contact_inquiry" }, 403],
    ["a missing action", { ...ok, action: undefined }, 403],
    ["another hostname", { ...ok, hostname: "evil.example" }, 403],
    ["a missing hostname", { ...ok, hostname: undefined }, 403],
    ["a bad secret", { success: false, "error-codes": ["invalid-input-secret"] }, 503],
    ["a missing secret", { success: false, "error-codes": ["missing-input-secret"] }, 503],
    ["a Cloudflare internal error", { success: false, "error-codes": ["internal-error"] }, 503],
  ])("fails closed on %s", async (_label, body, expected) => {
    answer(body);
    expect(await status(verifyTurnstile(request(), "tok", action))).toBe(expected);
  });

  it("matches the hostname case-insensitively", async () => {
    answer({ ...ok, hostname: "WWW.Manci.Test" });
    expect(await status(verifyTurnstile(request(), "tok", action))).toBe("resolved");
  });

  it("fails closed (503) when siteverify is unreachable, slow, non-200 or not JSON", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect(await status(verifyTurnstile(request(), "tok", action))).toBe(503);
    fetchMock.mockRejectedValueOnce(new DOMException("timed out", "TimeoutError"));
    expect(await status(verifyTurnstile(request(), "tok", action))).toBe(503);
    answer(ok, 500);
    expect(await status(verifyTurnstile(request(), "tok", action))).toBe(503);
    fetchMock.mockResolvedValueOnce(new Response("<html>", { status: 200 }));
    expect(await status(verifyTurnstile(request(), "tok", action))).toBe(503);
    answer(null);
    expect(await status(verifyTurnstile(request(), "tok", action))).toBe(503);
  });

  it("fails closed (503) when the site URL needed for the hostname check is missing", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
    expect(await status(verifyTurnstile(request(), "tok", action))).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never logs the token or the secret", async () => {
    const logs = [console.error, console.warn].map((fn) => vi.mocked(fn));
    answer({ ...ok, hostname: "evil.example" });
    await status(verifyTurnstile(request(), "secret-token-value", action));
    fetchMock.mockRejectedValueOnce(new Error(`boom ${SECRET}`));
    await status(verifyTurnstile(request(), "secret-token-value", action));
    const logged = logs.flatMap((fn) => fn.mock.calls.flat()).map(String).join(" ");
    expect(logged).not.toContain("secret-token-value");
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain("203.0.113.7");
  });

  it("with a Cloudflare test secret outside production, skips the action/hostname check", async () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", TEST_PASS_SECRET);
    answer({ success: true, hostname: "localhost", action: "test", "error-codes": [] });
    expect(await status(verifyTurnstile(request(), "XXXX.DUMMY.TOKEN.XXXX", action))).toBe("resolved");
    answer({ success: false, "error-codes": ["invalid-input-response"] });
    expect(await status(verifyTurnstile(request(), "XXXX.DUMMY.TOKEN.XXXX", action))).toBe(403);
  });

  it("refuses every request when a production build is configured with a test secret", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TURNSTILE_SECRET_KEY", TEST_PASS_SECRET);
    expect(await status(verifyTurnstile(request(), "XXXX.DUMMY.TOKEN.XXXX", action))).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("turnstileSiteKey", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is null unless NEXT_PUBLIC_TURNSTILE_SITE_KEY is set", () => {
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "");
    expect(turnstileSiteKey()).toBeNull();
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", " 0x4AAA ");
    expect(turnstileSiteKey()).toBe("0x4AAA");
  });

  it("keeps action names within Turnstile's charset and length", () => {
    for (const value of Object.values(TURNSTILE_ACTIONS)) expect(value).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
  });
});
