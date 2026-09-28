// Pilot scope (lansiranje-6): one switch per product module in
// lib/features.ts pilotModules(). On mainnet every module is OFF unless its
// NEXT_PUBLIC_FEATURE_* variable reads as on; elsewhere every module is ON
// unless it reads as off (a devnet rehearsal of the pilot). Off: the entry
// routes answer 403 before any work, the menu hides the module and its
// pages carry the notice (lib/pilot-scope.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
// The gate runs before the signature: a request that passes it stops here.
vi.mock("@/lib/server/siws", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/server/siws")>();
  return { ...real, verifySigned: vi.fn(async () => { throw new real.SiwsError(401, "signature checked"); }) };
});
const db = vi.hoisted(() => ({ touched: [] as string[] }));
vi.mock("@/lib/supabase-server", () => ({
  getSupabaseAdmin: () => ({ from: (table: string) => { db.touched.push(table); throw new Error("no database in this test"); } }),
}));

import { assertBuildFeatureFlags, FEATURE_FLAG_NAMES } from "@/next.config";
import { features, moduleDisabledMessage, PILOT_MODULE_ENV, PILOT_MODULES, pilotModules } from "@/lib/features";
import { moduleNoticeText, moduleRouteState, navHrefVisible } from "@/lib/pilot-scope";

const ALL_ON = Object.fromEntries(PILOT_MODULES.map((m) => [m, true]));
const ALL_OFF = Object.fromEntries(PILOT_MODULES.map((m) => [m, false]));
const clearModuleEnv = () => { for (const name of Object.values(PILOT_MODULE_ENV)) vi.stubEnv(name, ""); };

beforeEach(() => clearModuleEnv());
afterEach(() => vi.unstubAllEnvs());

describe("pilotModules()", () => {
  it("mainnet: every module is off by default, primary sales have no switch", () => {
    expect(pilotModules("mainnet")).toEqual(ALL_OFF);
  });

  it("mainnet: a module is on only for a value that reads as on", () => {
    for (const name of PILOT_MODULES) {
      for (const [value, on] of [["true", true], [" ON ", true], ["1", true], ["yes", true], ["false", false], ["ture", false], ["", false]] as const) {
        clearModuleEnv();
        vi.stubEnv(PILOT_MODULE_ENV[name], value);
        expect(pilotModules("mainnet"), `${name}=${value}`).toEqual({ ...ALL_OFF, [name]: on });
      }
    }
  });

  it.each(["devnet", "testnet", "localnet"] as const)("%s: every module is on unless it reads as off (a pilot rehearsal)", (network) => {
    expect(pilotModules(network)).toEqual(ALL_ON);
    for (const name of PILOT_MODULES) {
      clearModuleEnv();
      vi.stubEnv(PILOT_MODULE_ENV[name], "off");
      expect(pilotModules(network)).toEqual({ ...ALL_ON, [name]: false });
      vi.stubEnv(PILOT_MODULE_ENV[name], "maybe");
      expect(pilotModules(network)[name]).toBe(true);
    }
  });

  it("the existing feature flags keep their shape", () => {
    expect(Object.keys(features("mainnet")).sort()).toEqual(["issuerRotation", "passportClose", "payoutAirdrop", "startupRaises"]);
  });

  it("the build guard knows every module variable and refuses a typo in one", () => {
    for (const name of Object.values(PILOT_MODULE_ENV)) {
      expect(FEATURE_FLAG_NAMES).toContain(name);
      expect(() => assertBuildFeatureFlags("phase-production-build", { [name]: "ture" })).toThrow(new RegExp(name));
      expect(() => assertBuildFeatureFlags("phase-production-build", { [name]: "true" })).not.toThrow();
    }
  });

  it("names the module and says 'pilot' on mainnet", () => {
    expect(moduleDisabledMessage("secondaryTrading", "mainnet")).toBe(
      "Secondary trading (OTC deals, offers and the resell board): not available in the pilot on Solana mainnet.",
    );
    expect(moduleDisabledMessage("custodyDelivery", "devnet")).toBe("Physical delivery: switched off on Solana devnet.");
  });
});

describe("lib/pilot-scope.ts (menu, tabs and page notices)", () => {
  it("mainnet by default: module pages are off, primary sales and the portfolio are not", () => {
    expect(navHrefVisible("/marketplace/otc", "mainnet")).toBe(false);
    expect(navHrefVisible("/marketplace/otc/Offer1111", "mainnet")).toBe(false);
    expect(navHrefVisible("/markets/resell", "mainnet")).toBe(false);
    expect(navHrefVisible("/portfolio/governance", "mainnet")).toBe(false);
    expect(navHrefVisible("/portfolio/rights", "mainnet")).toBe(false);
    expect(navHrefVisible("/marketplace/launchpad", "mainnet")).toBe(true);
    expect(navHrefVisible("/portfolio", "mainnet")).toBe(true);
    expect(navHrefVisible("/portfolio/history", "mainnet")).toBe(true);
    expect(moduleRouteState("/marketplace/otc", "mainnet")).toMatchObject({ disabled: true, route: { mode: "gate" } });
    expect(moduleRouteState("/portfolio/offers", "mainnet")).toMatchObject({ disabled: true, route: { mode: "notice" } });
    expect(moduleRouteState("/marketplace/launchpad", "mainnet")).toBeNull();
  });

  it("a page of several modules stays until all are off, and names the ones that are", () => {
    vi.stubEnv(PILOT_MODULE_ENV.distributions, "true");
    const state = moduleRouteState("/portfolio/rights", "mainnet")!;
    expect(state).toMatchObject({ disabled: false, off: ["rights"] });
    expect(navHrefVisible("/portfolio/rights", "mainnet")).toBe(true);
    expect(moduleNoticeText(state, "mainnet")).toBe("Rights-Token issuances: not available in the pilot on Solana mainnet.");
  });

  it("devnet: nothing is hidden unless switched off", () => {
    expect(navHrefVisible("/marketplace/otc", "devnet")).toBe(true);
    expect(moduleRouteState("/marketplace/otc", "devnet")).toMatchObject({ disabled: false, off: [] });
    vi.stubEnv(PILOT_MODULE_ENV.secondaryTrading, "false");
    expect(navHrefVisible("/marketplace/otc", "devnet")).toBe(false);
  });
});

const ROUTES: Array<[string, string, () => Promise<{ POST: (r: Request) => Promise<Response> }>]> = [
  ["resell/create", "secondaryTrading", () => import("@/app/api/resell/create/route")],
  ["otc/admin-screen", "secondaryTrading", () => import("@/app/api/otc/admin-screen/route")],
  ["vesting-series/create", "vesting", () => import("@/app/api/vesting-series/create/route")],
  ["vesting-series/prepare-creation", "vesting", () => import("@/app/api/vesting-series/prepare-creation/route")],
  ["vesting-series/admin-review", "vesting", () => import("@/app/api/vesting-series/admin-review/route")],
  ["vesting/create", "rights", () => import("@/app/api/vesting/create/route")],
  ["distribution-plans/prepare", "distributions", () => import("@/app/api/distribution-plans/prepare/route")],
  ["distribution-plans/bind", "distributions", () => import("@/app/api/distribution-plans/bind/route")],
  ["conversion/create", "custodyConversion", () => import("@/app/api/conversion/create/route")],
  ["delivery/create", "custodyDelivery", () => import("@/app/api/delivery/create/route")],
];

describe("entry routes of a switched-off module answer 403 before any work", () => {
  it.each(ROUTES)("%s (%s)", async (_route, module, load) => {
    const { POST } = await load();
    const post = async () => {
      const res = await POST(new Request("https://manci.test/api/x", { method: "POST", body: "{}" }));
      return { status: res.status, body: (await res.json()) as { error?: string } };
    };
    db.touched.length = 0;
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "mainnet");
    const refused = await post();
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe(moduleDisabledMessage(module as never, "mainnet"));
    expect(db.touched).toEqual([]);
    // Switched on, the route goes on to its signature check.
    vi.stubEnv(PILOT_MODULE_ENV[module as keyof typeof PILOT_MODULE_ENV], "true");
    expect((await post()).status).toBe(401);
    // Devnet: on by default.
    clearModuleEnv();
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
    expect((await post()).status).toBe(401);
  });
});
