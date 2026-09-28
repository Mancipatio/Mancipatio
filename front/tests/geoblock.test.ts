// Geoblocking by country (8.5; pravo-compliance-6): counsel's list in
// GEOBLOCK_COUNTRIES (ISO 3166 codes, or "none" on purpose), enforced by
// proxy.ts on the transactional API routes (451; fail closed on mainnet
// without Vercel's country header) and the app pages (/not-available), and
// required by a mainnet build (next.config.ts assertBuildGeoblock).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  GEOBLOCKED_API_ROUTES,
  GEOBLOCKED_MESSAGE,
  GEOBLOCKED_PAGE_PREFIXES,
  geoblockDecision,
  geoblockKind,
  parseGeoblockList,
} from "@/lib/geoblock";
import { assertBuildGeoblock } from "@/next.config";
import { config as proxyConfig, proxy } from "@/proxy";

afterEach(() => vi.unstubAllEnvs());

const BUILD = "phase-production-build";

describe("parseGeoblockList", () => {
  it("reads unset, none, and a list of country and region codes", () => {
    expect(parseGeoblockList(undefined)).toEqual({ ok: true, set: false });
    expect(parseGeoblockList("  ")).toEqual({ ok: true, set: false });
    expect(parseGeoblockList("None")).toMatchObject({ ok: true, set: true, none: true });
    const list = parseGeoblockList("kp, IR,cu SY,UA-43");
    expect(list).toMatchObject({ ok: true, set: true, none: false });
    if (list.ok && list.set) {
      expect([...list.countries]).toEqual(["KP", "IR", "CU", "SY"]);
      expect([...list.regions]).toEqual(["UA-43"]);
    }
  });

  it("refuses anything that is not a code", () => {
    for (const bad of ["Iran", "IRN", "U", "UA-", "UA-4444", "KP;IR"]) {
      expect(parseGeoblockList(bad).ok, bad).toBe(false);
    }
  });
});

describe("geoblockDecision", () => {
  const list = parseGeoblockList("KP,IR,UA-43");
  const decide = (country: string | null, network = "mainnet", kind: "api" | "page" = "api", region: string | null = null, config = list) =>
    geoblockDecision({ config, country, region, network, kind });

  it("blocks a listed country or region, and allows the rest", () => {
    expect(decide("IR")).toBe("blocked");
    expect(decide("kp", "devnet", "page")).toBe("blocked");
    expect(decide("UA", "mainnet", "api", "43")).toBe("blocked");
    expect(decide("UA", "mainnet", "api", "30")).toBe("allow");
    expect(decide("RS")).toBe("allow");
  });

  it("mainnet fails closed on a transactional route without the country header; pages and devnet do not", () => {
    expect(decide(null)).toBe("unknown");
    expect(decide("")).toBe("unknown");
    expect(decide(null, "mainnet", "page")).toBe("allow");
    expect(decide(null, "devnet")).toBe("allow");
  });

  it("'none' blocks nothing; an unset or broken list refuses mainnet transactions only", () => {
    expect(decide("IR", "mainnet", "api", null, parseGeoblockList("none"))).toBe("allow");
    expect(decide("IR", "mainnet", "api", null, parseGeoblockList(undefined))).toBe("unknown");
    expect(decide("IR", "mainnet", "page", null, parseGeoblockList(undefined))).toBe("allow");
    expect(decide("IR", "devnet", "api", null, parseGeoblockList(undefined))).toBe("allow");
    expect(decide("RS", "mainnet", "api", null, parseGeoblockList("Iran"))).toBe("unknown");
  });
});

describe("the routes it covers", () => {
  it("classifies transactional API routes and app pages; everything else passes", () => {
    expect(geoblockKind("/api/launchpad/commit")).toBe("api");
    expect(geoblockKind("/api/otc/create/")).toBe("api");
    expect(geoblockKind("/marketplace")).toBe("page");
    expect(geoblockKind("/marketplace/launchpad/Sale111")).toBe("page");
    expect(geoblockKind("/portfolio/offers")).toBe("page");
    for (const open of ["/", "/legal/terms", "/not-available", "/api/health", "/api/internal/alarms", "/api/otc/list",
      "/api/launchpad/terms", "/admin/kyc", "/api/conversion/cancel", "/marketplaces"]) {
      expect(geoblockKind(open), open).toBeNull();
    }
  });

  it("every listed API route exists, and the proxy's matcher reaches every listed route and page", () => {
    const matchers = proxyConfig.matcher.map((m) => new RegExp(`^${m.replace(/\/:path\*$/, "(/.*)?")}$`));
    for (const route of GEOBLOCKED_API_ROUTES) {
      expect(existsSync(join(process.cwd(), "app", route, "route.ts")), route).toBe(true);
      expect(matchers.some((m) => m.test(route)), route).toBe(true);
    }
    for (const page of GEOBLOCKED_PAGE_PREFIXES) {
      expect(matchers.some((m) => m.test(page)), page).toBe(true);
    }
  });
});

describe("proxy.ts", () => {
  const request = (path: string, headers: Record<string, string> = {}) =>
    new NextRequest(new URL(path, "https://www.manci.io"), { method: path.startsWith("/api/") ? "POST" : "GET", headers });

  it("answers 451 to a transactional request from a listed country", async () => {
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "mainnet");
    vi.stubEnv("GEOBLOCK_COUNTRIES", "KP,IR");
    const res = proxy(request("/api/launchpad/commit", { "x-vercel-ip-country": "IR" }));
    expect(res.status).toBe(451);
    expect(await res.json()).toEqual({ ok: false, error: GEOBLOCKED_MESSAGE, code: "GEOBLOCKED" });
    const unknown = proxy(request("/api/otc/create"));
    expect(unknown.status).toBe(451);
    expect(await unknown.json()).toMatchObject({ code: "COUNTRY_UNKNOWN" });
  });

  it("shows /not-available in place of an app page, and passes everything else", () => {
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "mainnet");
    vi.stubEnv("GEOBLOCK_COUNTRIES", "KP,IR");
    const blocked = proxy(request("/marketplace/launchpad?x=1", { "x-vercel-ip-country": "KP" }));
    expect(blocked.headers.get("x-middleware-rewrite")).toBe("https://www.manci.io/not-available");
    const served = proxy(request("/marketplace", { "x-vercel-ip-country": "RS" }));
    expect(served.headers.get("x-middleware-next")).toBe("1");
    expect(proxy(request("/portfolio")).headers.get("x-middleware-next")).toBe("1");
    expect(proxy(request("/api/launchpad/commit", { "x-vercel-ip-country": "RS" })).headers.get("x-middleware-next")).toBe("1");
  });

  it("devnet without a list or a header lets everything through", () => {
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
    vi.stubEnv("GEOBLOCK_COUNTRIES", "");
    expect(proxy(request("/api/launchpad/commit")).headers.get("x-middleware-next")).toBe("1");
  });
});

describe("next.config.ts assertBuildGeoblock", () => {
  it("a mainnet build needs the list, or 'none' written down", () => {
    expect(() => assertBuildGeoblock(BUILD, { NEXT_PUBLIC_NETWORK: "mainnet" })).toThrow(/GEOBLOCK_COUNTRIES is not set/);
    expect(() => assertBuildGeoblock(BUILD, { NEXT_PUBLIC_NETWORK: "mainnet", GEOBLOCK_COUNTRIES: "none" })).not.toThrow();
    expect(() => assertBuildGeoblock(BUILD, { NEXT_PUBLIC_NETWORK: "mainnet", GEOBLOCK_COUNTRIES: "KP,IR,UA-43" })).not.toThrow();
  });

  it("any production build refuses a malformed list; devnet may leave it unset; dev is not checked", () => {
    expect(() => assertBuildGeoblock(BUILD, { NEXT_PUBLIC_NETWORK: "devnet", GEOBLOCK_COUNTRIES: "Iran" })).toThrow(/not an ISO 3166/);
    expect(() => assertBuildGeoblock(BUILD, { NEXT_PUBLIC_NETWORK: "devnet" })).not.toThrow();
    expect(() => assertBuildGeoblock("phase-development-server", { NEXT_PUBLIC_NETWORK: "mainnet" })).not.toThrow();
  });
});
