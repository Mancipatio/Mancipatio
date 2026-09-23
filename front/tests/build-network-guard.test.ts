// next.config.ts refuses a Vercel build without an explicit, valid
// NEXT_PUBLIC_NETWORK (lib/network.ts would otherwise guess from the RPC URL
// and fall back to devnet). Local builds, CI (NEXT_PUBLIC_NETWORK=devnet),
// `next dev` and tests keep working.
import { afterEach, describe, expect, it, vi } from "vitest";
import config, { assertBuildNetwork } from "@/next.config";

const BUILD = "phase-production-build";
const DEV = "phase-development-server";
const SERVER = "phase-production-server";

afterEach(() => vi.unstubAllEnvs());

describe("assertBuildNetwork", () => {
  it("fails a Vercel build with NEXT_PUBLIC_NETWORK unset", () => {
    expect(() => assertBuildNetwork(BUILD, { VERCEL: "1" })).toThrow(
      /NEXT_PUBLIC_NETWORK is not set for this Vercel build/,
    );
    expect(() =>
      assertBuildNetwork(BUILD, { VERCEL_ENV: "preview", NEXT_PUBLIC_NETWORK: "  " }),
    ).toThrow(/VERCEL_ENV=preview/);
    // The RPC URL is no substitute on Vercel.
    expect(() =>
      assertBuildNetwork(BUILD, {
        VERCEL: "1",
        VERCEL_ENV: "production",
        NEXT_PUBLIC_SOLANA_RPC_URL: "https://mainnet.helius-rpc.com/?api-key=x",
      }),
    ).toThrow(/not set/);
  });

  it("fails any production build with an invalid value", () => {
    expect(() => assertBuildNetwork(BUILD, { NEXT_PUBLIC_NETWORK: "mainnet-beta" })).toThrow(
      /NEXT_PUBLIC_NETWORK="mainnet-beta" is invalid/,
    );
    expect(() =>
      assertBuildNetwork(BUILD, { VERCEL: "1", NEXT_PUBLIC_NETWORK: "prod" }),
    ).toThrow(/invalid/);
  });

  it("accepts an explicit network on Vercel", () => {
    for (const network of ["mainnet", "devnet", "testnet", "localnet", " Mainnet "]) {
      expect(() =>
        assertBuildNetwork(BUILD, { VERCEL: "1", VERCEL_ENV: "production", NEXT_PUBLIC_NETWORK: network }),
      ).not.toThrow();
    }
  });

  it("leaves local builds, dev and the production server alone", () => {
    expect(() => assertBuildNetwork(BUILD, {})).not.toThrow();
    expect(() => assertBuildNetwork(BUILD, { NEXT_PUBLIC_NETWORK: "devnet" })).not.toThrow();
    expect(() => assertBuildNetwork(DEV, { VERCEL: "1" })).not.toThrow();
    expect(() => assertBuildNetwork(SERVER, { VERCEL: "1" })).not.toThrow();
  });
});

describe("next.config default export", () => {
  it("runs the guard against process.env and returns the config", () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "");
    expect(() => config(BUILD)).toThrow(/not set/);

    vi.stubEnv("NEXT_PUBLIC_NETWORK", "mainnet");
    const resolved = config(BUILD);
    expect(resolved.poweredByHeader).toBe(false);
    expect(typeof resolved.headers).toBe("function");
  });

  it("keeps the X-Robots-Tag noindex header on /account paths", async () => {
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
    const headers = await config(BUILD).headers!();
    const sources = headers.map((h) => h.source);
    expect(sources).toEqual(["/account/:path*", "/api/account/:path*"]);
    for (const entry of headers) {
      expect(entry.headers).toContainEqual({ key: "X-Robots-Tag", value: "noindex, nofollow" });
    }
  });
});
