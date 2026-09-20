import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { accountSiteOrigin } from "@/lib/server/account-origin";
import { SiwsError } from "@/lib/server/siws";

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://www.mancipatio.io");
});
afterEach(() => vi.unstubAllEnvs());

describe("account links use an explicitly trusted origin", () => {
  it("pins production links despite request URL, Host, and forwarding headers", () => {
    const request = new Request("https://attacker.example/api/account/google/start", {
      headers: { host: "other.example", "x-forwarded-host": "evil.example", "x-forwarded-proto": "http" },
    });
    expect(accountSiteOrigin(request)).toBe("https://www.mancipatio.io");
  });

  it("does not enable the loopback exemption in production", () => {
    expect(accountSiteOrigin(new Request("http://localhost:3000/api/account")))
      .toBe("https://www.mancipatio.io");
  });

  it.each([
    "", "not a URL", "http://www.mancipatio.io", "javascript:alert(1)",
    "https://user:password@www.mancipatio.io", "https://www.mancipatio.io/account",
    "https://www.mancipatio.io/?return=https://evil.example", "https://www.mancipatio.io/#callback",
    "//www.mancipatio.io",
  ])("fails closed for invalid production configuration %j", (configured) => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", configured);
    const request = new Request("https://valid-looking.example/api/account");
    expect(() => accountSiteOrigin(request)).toThrow(SiwsError);
    try { accountSiteOrigin(request); } catch (error) {
      expect((error as SiwsError).status).toBe(503);
      expect((error as Error).message).not.toContain(configured || "valid-looking.example");
    }
  });

  it.each(["http://localhost:3000", "http://127.0.0.1:3001", "http://[::1]:3002", "https://localhost:3443"])
  ("supports an explicit local development origin %s", (origin) => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
    expect(accountSiteOrigin(new Request(`${origin}/api/account/google/start`))).toBe(origin);
  });

  it.each(["https://localhost.evil.example", "https://127.0.0.1.evil.example", "https://preview.example"])
  ("does not infer trust from non-loopback development host %s", (origin) => {
    vi.stubEnv("NODE_ENV", "development");
    expect(accountSiteOrigin(new Request(`${origin}/api/account`))).toBe("https://www.mancipatio.io");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
    expect(() => accountSiteOrigin(new Request(`${origin}/api/account`))).toThrow(SiwsError);
  });

  it("does not allow a non-web scheme through the development loopback exemption", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
    expect(() => accountSiteOrigin(new Request("ftp://localhost/account"))).toThrow(SiwsError);
  });
});
