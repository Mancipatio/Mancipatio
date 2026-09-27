// 8.4: the mainnet build guards of next.config.ts — the browser and server
// RPC (front-app-5, podaci-infra-2), the operations requirements with named
// waivers (front-app-8/12, ops-qa-2/9/18), the feature-flag spellings
// (front-app-8) — and the report-only Content-Security-Policy with its report
// endpoint (front-app-6).
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  MAINNET_OPS_REQUIREMENTS,
  assertBuildFeatureFlags,
  assertBuildMainnetOps,
  assertBuildRpc,
  contentSecurityPolicy,
} from "@/next.config";
import { summarizeCspReport } from "@/lib/server/csp-report";
import { POST as cspReport } from "@/app/api/csp-report/route";

const BUILD = "phase-production-build";
const DEV = "phase-development-server";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** A mainnet environment that satisfies every 8.4 guard (placeholder values, no secrets). */
const OPS = {
  NEXT_PUBLIC_NETWORK: "mainnet",
  NEXT_PUBLIC_SOLANA_RPC_URL: "https://browser.rpc.example/?api-key=browser-key",
  NEXT_PUBLIC_SOLANA_WS_URL: "wss://browser.rpc.example/?api-key=browser-key",
  HELIUS_MAINNET_RPC: "https://mainnet.helius-rpc.com/?api-key=server-key",
  SENTRY_DSN: "https://abc123@o1.ingest.de.sentry.io/42",
  HEALTH_TOKEN: "h".repeat(32),
  TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
  ALERT_WEBHOOK_URL: "https://alerts.example/hook",
  SESSION_SECRET: "s".repeat(48),
  NEXT_PUBLIC_SITE_URL: "https://www.manci.io",
};

describe("assertBuildRpc", () => {
  it("requires the browser RPC, its WebSocket and the server RPC on mainnet, none of them public", () => {
    const warn = vi.fn();
    expect(() => assertBuildRpc(BUILD, OPS, warn)).not.toThrow();
    // The browser URL is inlined: an api-key in it must be a domain-restricted key.
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/restricted to this site's origin/));
    const cases: [Record<string, string | undefined>, RegExp][] = [
      [{ NEXT_PUBLIC_SOLANA_RPC_URL: undefined }, /NEXT_PUBLIC_SOLANA_RPC_URL is not set/],
      [{ NEXT_PUBLIC_SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com" }, /not https:\/\/api\.mainnet-beta\.solana\.com/],
      [{ NEXT_PUBLIC_SOLANA_RPC_URL: "http://browser.rpc.example" }, /must be a https:\/\/ URL/],
      [{ NEXT_PUBLIC_SOLANA_WS_URL: undefined }, /NEXT_PUBLIC_SOLANA_WS_URL is not set/],
      [{ NEXT_PUBLIC_SOLANA_WS_URL: "wss://api.mainnet-beta.solana.com" }, /NEXT_PUBLIC_SOLANA_WS_URL must be a wss:/],
      [{ NEXT_PUBLIC_SOLANA_WS_URL: "https://browser.rpc.example" }, /NEXT_PUBLIC_SOLANA_WS_URL must be a wss:/],
      [{ HELIUS_MAINNET_RPC: undefined }, /SOLANA_MAINNET_RPC is not set/],
      [{ HELIUS_MAINNET_RPC: "https://api.devnet.solana.com" }, /HELIUS_MAINNET_RPC must be/],
    ];
    for (const [over, error] of cases) expect(() => assertBuildRpc(BUILD, { ...OPS, ...over }, warn), JSON.stringify(over)).toThrow(error);
    expect(() => assertBuildRpc(BUILD, { ...OPS, HELIUS_MAINNET_RPC: "", SOLANA_MAINNET_RPC: "https://rpc.other.example" }, warn)).not.toThrow();
  });

  it("leaves other networks, dev and the production server alone", () => {
    expect(() => assertBuildRpc(BUILD, { NEXT_PUBLIC_NETWORK: "devnet" })).not.toThrow();
    expect(() => assertBuildRpc(DEV, { NEXT_PUBLIC_NETWORK: "mainnet" })).not.toThrow();
    expect(() => assertBuildRpc("phase-production-server", { NEXT_PUBLIC_NETWORK: "mainnet" })).not.toThrow();
  });
});

describe("assertBuildMainnetOps", () => {
  it("passes with every requirement met; names each missing one", () => {
    expect(() => assertBuildMainnetOps(BUILD, OPS)).not.toThrow();
    const missing: Record<string, Record<string, string>> = {
      sentry: { SENTRY_DSN: "https://abc123@o1.ingest.us.sentry.io/42" },
      "health-token": { HEALTH_TOKEN: "short" },
      turnstile: { NEXT_PUBLIC_TURNSTILE_SITE_KEY: "" },
      "alert-webhook": { ALERT_WEBHOOK_URL: "http://alerts.example/hook" },
      "session-secret": { SESSION_SECRET: "x".repeat(31) },
      "site-url": { NEXT_PUBLIC_SITE_URL: "https://www.manci.io/app" },
    };
    expect(Object.keys(missing).sort()).toEqual(Object.keys(MAINNET_OPS_REQUIREMENTS).sort());
    for (const [name, over] of Object.entries(missing)) {
      expect(() => assertBuildMainnetOps(BUILD, { ...OPS, ...over }), name).toThrow(new RegExp(`\\[${name}\\]`));
    }
  });

  it("MAINNET_OPS_WAIVERS waives by name, knowingly (a warning), and refuses an unknown name", () => {
    const warn = vi.fn();
    const env = { ...OPS, SENTRY_DSN: "", HEALTH_TOKEN: "", MAINNET_OPS_WAIVERS: "sentry, Health-Token" };
    expect(() => assertBuildMainnetOps(BUILD, env, warn)).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/waived .*sentry, health-token/));
    expect(() => assertBuildMainnetOps(BUILD, { ...env, MAINNET_OPS_WAIVERS: "sentry" }, warn)).toThrow(/\[health-token\]/);
    expect(() => assertBuildMainnetOps(BUILD, { ...OPS, MAINNET_OPS_WAIVERS: "sentyr" }, warn)).toThrow(/unknown requirement\(s\): sentyr/);
  });

  it("checks mainnet production builds only", () => {
    expect(() => assertBuildMainnetOps(BUILD, { NEXT_PUBLIC_NETWORK: "devnet" })).not.toThrow();
    expect(() => assertBuildMainnetOps(DEV, { NEXT_PUBLIC_NETWORK: "mainnet" })).not.toThrow();
  });
});

describe("assertBuildFeatureFlags", () => {
  it("refuses a flag value lib/features.ts cannot read, on any network", () => {
    expect(() => assertBuildFeatureFlags(BUILD, { NEXT_PUBLIC_FEATURE_ISSUER_ROTATION: "ture" })).toThrow(/NEXT_PUBLIC_FEATURE_ISSUER_ROTATION="ture"/);
    expect(() => assertBuildFeatureFlags(BUILD, { NEXT_PUBLIC_NETWORK: "devnet", NEXT_PUBLIC_FEATURE_PASSPORT_CLOSE: "enabled" })).toThrow();
    for (const value of ["true", "FALSE", " 1 ", "On", "no", ""]) {
      expect(() => assertBuildFeatureFlags(BUILD, { NEXT_PUBLIC_FEATURE_STARTUP_RAISES: value }), value).not.toThrow();
    }
    expect(() => assertBuildFeatureFlags(DEV, { NEXT_PUBLIC_FEATURE_ISSUER_ROTATION: "ture" })).not.toThrow();
  });
});

describe("contentSecurityPolicy (report-only)", () => {
  const directive = (policy: string, name: string) => policy.split("; ").find((d) => d.startsWith(`${name} `)) ?? "";

  it("allows the site, Supabase (https + wss), the browser RPC and Turnstile; frames nothing, reports to /api/csp-report", () => {
    const policy = contentSecurityPolicy({ ...OPS, NEXT_PUBLIC_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co" });
    expect(directive(policy, "connect-src").split(" ")).toEqual(expect.arrayContaining([
      "'self'", "https://abcdefghijklmnopqrst.supabase.co", "wss://abcdefghijklmnopqrst.supabase.co",
      "https://browser.rpc.example", "wss://browser.rpc.example", "https://challenges.cloudflare.com",
    ]));
    // Only origins: an api-key in the RPC URL never lands in the header.
    expect(policy).not.toContain("browser-key");
    expect(policy).not.toContain("api.mainnet-beta.solana.com");
    expect(directive(policy, "frame-src")).toBe("frame-src https://challenges.cloudflare.com");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("form-action 'self' https://accounts.google.com");
    expect(policy).toContain("report-uri /api/csp-report");
    expect(directive(policy, "script-src")).not.toContain("'unsafe-eval'");
    expect(directive(policy, "script-src")).not.toContain("vercel.live");
  });

  it("falls back to the network's public cluster; dev adds 'unsafe-eval'; Preview adds the Vercel toolbar", () => {
    const devnet = contentSecurityPolicy({ NEXT_PUBLIC_NETWORK: "devnet" });
    expect(directive(devnet, "connect-src")).toContain("https://api.devnet.solana.com wss://api.devnet.solana.com");
    // An explicit RPC without a WS URL: the same host over wss (lib/network.ts wsUrl).
    expect(directive(contentSecurityPolicy({ NEXT_PUBLIC_NETWORK: "devnet", NEXT_PUBLIC_SOLANA_RPC_URL: "https://devnet.helius-rpc.com/?api-key=k" }),
      "connect-src")).toContain("https://devnet.helius-rpc.com wss://devnet.helius-rpc.com");
    expect(directive(contentSecurityPolicy({}, true), "script-src")).toContain("'unsafe-eval'");
    const preview = contentSecurityPolicy({ NEXT_PUBLIC_NETWORK: "devnet", VERCEL_ENV: "preview" });
    expect(directive(preview, "script-src")).toContain("https://vercel.live");
    expect(directive(preview, "frame-src")).toContain("https://vercel.live");
  });
});

describe("CSP reports", () => {
  it("keeps the directive, the blocked origin and the page path — never a query string or a sample", () => {
    expect(summarizeCspReport({ "csp-report": {
      "document-uri": "https://www.manci.io/login/email?token=SECRET#x", "violated-directive": "script-src-elem",
      "blocked-uri": "https://evil.example/x.js?k=SECRET", disposition: "report", "script-sample": "SECRET",
    } })).toEqual([{ directive: "script-src-elem", blocked: "https://evil.example", page: "/login/email", disposition: "report" }]);
    expect(summarizeCspReport([
      { type: "csp-violation", body: { documentURL: "https://www.manci.io/admin?x=1", effectiveDirective: "connect-src",
        blockedURL: "wss://rpc.example/?api-key=SECRET", disposition: "enforce" } },
      { type: "deprecation", body: {} },
      { type: "csp-violation", body: { documentURL: "https://www.manci.io/", effectiveDirective: "script-src", blockedURL: "inline" } },
    ])).toEqual([
      { directive: "connect-src", blocked: "wss://rpc.example", page: "/admin", disposition: "enforce" },
      { directive: "script-src", blocked: "inline", page: "/", disposition: "report" },
    ]);
    expect(summarizeCspReport("nope")).toEqual([]);
    expect(summarizeCspReport(Array.from({ length: 50 }, () => ({ type: "csp-violation", body: {} })))).toHaveLength(10);
  });

  it("the endpoint logs one line per violation and answers 204; 413 over 16 KiB", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const post = (body: string) => cspReport(new Request("https://www.manci.io/api/csp-report", {
      method: "POST", headers: { "content-type": "application/csp-report", "x-real-ip": "192.0.2.1" }, body,
    }));
    const res = await post(JSON.stringify({ "csp-report": { "document-uri": "https://www.manci.io/a?t=SECRET",
      "effective-directive": "img-src", "blocked-uri": "https://img.example/p.png" } }));
    expect(res.status).toBe(204);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toBe('[csp] {"directive":"img-src","blocked":"https://img.example","page":"/a","disposition":"report"}');
    expect((await post("not json")).status).toBe(204);
    expect((await post("x".repeat(17 * 1024))).status).toBe(413);
  });
});
