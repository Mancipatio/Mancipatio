// next.config.ts refuses a Vercel build without an explicit, valid
// NEXT_PUBLIC_NETWORK (lib/network.ts would otherwise guess from the RPC URL
// and fall back to devnet), and any mainnet build until the legal copy is
// approved for mainnet (MAINNET_LEGAL_COPY_APPROVED=true). Local builds, CI
// (NEXT_PUBLIC_NETWORK=devnet), `next dev` and tests keep working.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isAddress } from "@solana/kit";
import config, {
  assertBuildKycRegistry,
  assertBuildNetwork,
  assertBuildSupabase,
  assertBuildTurnstile,
  isBase58Address,
  SUPABASE_PROJECT_REFS,
} from "@/next.config";
import { parseKycRegistryPin } from "@/lib/kyc-registry-pin";

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
        assertBuildNetwork(BUILD, {
          VERCEL: "1",
          VERCEL_ENV: "production",
          NEXT_PUBLIC_NETWORK: network,
          MAINNET_LEGAL_COPY_APPROVED: "true",
        }),
      ).not.toThrow();
    }
  });

  it("refuses a mainnet build until the legal copy is approved for mainnet", () => {
    // The Terms / Privacy pages still say "runs on Solana devnet, no real
    // assets" — binding text that would be false on mainnet.
    for (const env of [
      { NEXT_PUBLIC_NETWORK: "mainnet" },
      { NEXT_PUBLIC_NETWORK: " Mainnet ", MAINNET_LEGAL_COPY_APPROVED: "" },
      { NEXT_PUBLIC_NETWORK: "mainnet", MAINNET_LEGAL_COPY_APPROVED: "1" },
      { NEXT_PUBLIC_NETWORK: "mainnet", MAINNET_LEGAL_COPY_APPROVED: "TRUE" },
      { VERCEL: "1", VERCEL_ENV: "production", NEXT_PUBLIC_NETWORK: "mainnet" },
    ]) {
      expect(() => assertBuildNetwork(BUILD, env), JSON.stringify(env)).toThrow(
        /Refusing a mainnet build: .*MAINNET_LEGAL_COPY_APPROVED=true/,
      );
    }
    expect(() =>
      assertBuildNetwork(BUILD, {
        NEXT_PUBLIC_NETWORK: "mainnet",
        MAINNET_LEGAL_COPY_APPROVED: " true ",
      }),
    ).not.toThrow();
    // Test networks never need it; dev and the production server never check.
    for (const network of ["devnet", "testnet", "localnet"]) {
      expect(() => assertBuildNetwork(BUILD, { NEXT_PUBLIC_NETWORK: network })).not.toThrow();
    }
    expect(() => assertBuildNetwork(DEV, { NEXT_PUBLIC_NETWORK: "mainnet" })).not.toThrow();
    expect(() => assertBuildNetwork(SERVER, { NEXT_PUBLIC_NETWORK: "mainnet" })).not.toThrow();
  });

  it("leaves local builds, dev and the production server alone", () => {
    expect(() => assertBuildNetwork(BUILD, {})).not.toThrow();
    expect(() => assertBuildNetwork(BUILD, { NEXT_PUBLIC_NETWORK: "devnet" })).not.toThrow();
    expect(() => assertBuildNetwork(DEV, { VERCEL: "1" })).not.toThrow();
    expect(() => assertBuildNetwork(SERVER, { VERCEL: "1" })).not.toThrow();
  });
});

describe("assertBuildSupabase", () => {
  const MAINNET_REF = "mainnetprojectref001";
  const REFS = { devnet: SUPABASE_PROJECT_REFS.devnet, mainnet: MAINNET_REF };
  const url = (ref: string) => `https://${ref}.supabase.co`;
  const PUBLISHABLE = "sb_publishable_abcdefghijklmnopqrstuvwxyz";

  it("keeps SUPABASE_PROJECT_REFS equal to scripts/ops/targets.json", () => {
    const targets = JSON.parse(readFileSync(join(process.cwd(), "scripts/ops/targets.json"), "utf8"));
    expect(SUPABASE_PROJECT_REFS).toEqual({ devnet: targets.devnet.projectRef, mainnet: targets.mainnet.projectRef });
  });

  it("refuses every mainnet build while no mainnet project is recorded", () => {
    expect(() =>
      assertBuildSupabase(BUILD, { NEXT_PUBLIC_NETWORK: "mainnet", NEXT_PUBLIC_SUPABASE_URL: url(MAINNET_REF), NEXT_PUBLIC_SUPABASE_ANON_KEY: PUBLISHABLE }),
    ).toThrow(/no mainnet Supabase project is recorded/);
  });

  it("refuses a mainnet build on another project, without a URL, or with a legacy anon key", () => {
    const mainnet = { NEXT_PUBLIC_NETWORK: "mainnet", NEXT_PUBLIC_SUPABASE_ANON_KEY: PUBLISHABLE };
    expect(() => assertBuildSupabase(BUILD, { ...mainnet, NEXT_PUBLIC_SUPABASE_URL: url(REFS.devnet!) }, REFS)).toThrow(/must be https:\/\/mainnetprojectref001/);
    expect(() => assertBuildSupabase(BUILD, mainnet, REFS)).toThrow(/NEXT_PUBLIC_SUPABASE_URL must be/);
    expect(() => assertBuildSupabase(BUILD, { ...mainnet, NEXT_PUBLIC_SUPABASE_URL: "https://db.example.com" }, REFS)).toThrow(/must be/);
    for (const key of ["eyJhbGciOiJIUzI1NiJ9.legacy.jwt", "sb_secret_abcdefghijklmnopqrstuvwx", ""])
      expect(() => assertBuildSupabase(BUILD, { ...mainnet, NEXT_PUBLIC_SUPABASE_URL: url(MAINNET_REF), NEXT_PUBLIC_SUPABASE_ANON_KEY: key }, REFS), key)
        .toThrow(/publishable key/);
    expect(() => assertBuildSupabase(BUILD, { ...mainnet, NEXT_PUBLIC_SUPABASE_URL: `${url(MAINNET_REF)}/` }, REFS)).not.toThrow();
  });

  it("refuses a devnet build on another project and any non-mainnet build on the mainnet project", () => {
    expect(() => assertBuildSupabase(BUILD, { NEXT_PUBLIC_NETWORK: "devnet", NEXT_PUBLIC_SUPABASE_URL: url(MAINNET_REF) }, REFS)).toThrow(/points at the mainnet Supabase project/);
    expect(() => assertBuildSupabase(BUILD, { NEXT_PUBLIC_NETWORK: "testnet", NEXT_PUBLIC_SUPABASE_URL: url(MAINNET_REF) }, REFS)).toThrow(/points at the mainnet/);
    expect(() => assertBuildSupabase(BUILD, { NEXT_PUBLIC_NETWORK: "devnet", NEXT_PUBLIC_SUPABASE_URL: url("bbbbbbbbbbbbbbbbbbbb") }, REFS)).toThrow(/Refusing a devnet build/);
    expect(() => assertBuildSupabase(BUILD, { NEXT_PUBLIC_NETWORK: "devnet", NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321" }, REFS)).toThrow(/Refusing a devnet build/);
  });

  it("accepts devnet on its project, testnet on the devnet project, and builds without a URL off mainnet", () => {
    for (const env of [
      { NEXT_PUBLIC_NETWORK: "devnet", NEXT_PUBLIC_SUPABASE_URL: url(REFS.devnet!) },
      { NEXT_PUBLIC_NETWORK: "testnet", NEXT_PUBLIC_SUPABASE_URL: url(REFS.devnet!) },
      { NEXT_PUBLIC_NETWORK: "localnet", NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321" },
      { NEXT_PUBLIC_NETWORK: "devnet" }, // CI: no secrets
      { NEXT_PUBLIC_NETWORK: "devnet", VERCEL: "1", VERCEL_ENV: "preview" },
      {},
    ]) {
      expect(() => assertBuildSupabase(BUILD, env, REFS), JSON.stringify(env)).not.toThrow();
      expect(() => assertBuildSupabase(BUILD, env), JSON.stringify(env)).not.toThrow();
    }
  });

  it("checks production builds only", () => {
    for (const phase of [DEV, SERVER])
      expect(() => assertBuildSupabase(phase, { NEXT_PUBLIC_NETWORK: "mainnet" })).not.toThrow();
  });
});

describe("assertBuildTurnstile", () => {
  const SECRET = "0x4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const SITE_KEY = "0x4AAAAAAAAAAAAAAAAAAAAA";

  it("fails a production build with the Turnstile secret but no site key", () => {
    // The server would refuse every email sign-in and contact submission.
    for (const env of [
      { TURNSTILE_SECRET_KEY: SECRET },
      { TURNSTILE_SECRET_KEY: SECRET, NEXT_PUBLIC_TURNSTILE_SITE_KEY: "  " },
      { TURNSTILE_SECRET_KEY: ` ${SECRET} `, NEXT_PUBLIC_TURNSTILE_SITE_KEY: "", VERCEL: "1" },
    ]) {
      expect(() => assertBuildTurnstile(BUILD, env, () => {}), JSON.stringify(env)).toThrow(
        /TURNSTILE_SECRET_KEY is set but NEXT_PUBLIC_TURNSTILE_SITE_KEY is not/,
      );
    }
  });

  it("accepts both keys or neither, and only warns about a site key without the secret", () => {
    const warn = vi.fn();
    expect(() => assertBuildTurnstile(BUILD, {}, warn)).not.toThrow();
    expect(() => assertBuildTurnstile(BUILD, { TURNSTILE_SECRET_KEY: SECRET, NEXT_PUBLIC_TURNSTILE_SITE_KEY: SITE_KEY }, warn)).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
    expect(() => assertBuildTurnstile(BUILD, { NEXT_PUBLIC_TURNSTILE_SITE_KEY: SITE_KEY }, warn)).not.toThrow();
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0][0])).toMatch(/does not check its tokens/);
    expect(String(warn.mock.calls[0][0])).not.toContain(SITE_KEY);
  });

  it("checks production builds only", () => {
    for (const phase of [DEV, SERVER]) {
      expect(() => assertBuildTurnstile(phase, { TURNSTILE_SECRET_KEY: SECRET }, () => {})).not.toThrow();
    }
  });
});

const PIN = "5MofiJNCoCRkNg1f2Yd7368WkjiNxkZZmUTaQo7xLhku";

describe("assertBuildKycRegistry", () => {
  it("fails any production build whose pin is set but malformed", () => {
    for (const bad of ["garbage", "5MofiJNCoCRkNg1f2Yd7368WkjiNxkZZmUTaQo7xLhk0", PIN.slice(0, 30)]) {
      expect(() => assertBuildKycRegistry(BUILD, { NEXT_PUBLIC_KYC_REGISTRY: bad })).toThrow(/not a valid address/);
    }
    expect(() => assertBuildKycRegistry(BUILD, { NEXT_PUBLIC_KYC_REGISTRY: ` ${PIN} ` })).not.toThrow();
  });

  it("requires a pin for mainnet and Vercel production, only warns on Preview", () => {
    expect(() => assertBuildKycRegistry(BUILD, { NEXT_PUBLIC_NETWORK: "mainnet" })).toThrow(/is not set/);
    expect(() =>
      assertBuildKycRegistry(BUILD, { NEXT_PUBLIC_NETWORK: "devnet", VERCEL: "1", VERCEL_ENV: "production" }),
    ).toThrow(/is not set/);
    const warn = vi.fn();
    assertBuildKycRegistry(BUILD, { NEXT_PUBLIC_NETWORK: "devnet", VERCEL: "1", VERCEL_ENV: "preview" }, warn);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/NEXT_PUBLIC_KYC_REGISTRY is not set/));
    const quiet = vi.fn();
    assertBuildKycRegistry(BUILD, { NEXT_PUBLIC_NETWORK: "devnet" }, quiet); // local / CI
    expect(quiet).not.toHaveBeenCalled();
  });

  it("never checks outside a production build", () => {
    expect(() => assertBuildKycRegistry(DEV, { NEXT_PUBLIC_KYC_REGISTRY: "garbage" })).not.toThrow();
    expect(() => assertBuildKycRegistry(SERVER, { NEXT_PUBLIC_NETWORK: "mainnet" })).not.toThrow();
  });

  it("agrees with the runtime parser (@solana/kit isAddress)", () => {
    const samples = [
      PIN,
      "11111111111111111111111111111111",
      "FJs1EM1ND89L9sUXaS8VBKYXjmoXCkkVSJKRE19hmYxS",
      "GBDyesyTr266LqKeFq95r1DeigRyHpfw6ACWdjENHAPy",
      "1111111111111111111111111111111",
      "111111111111111111111111111111111",
      "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
      "5MofiJNCoCRkNg1f2Yd7368WkjiNxkZZmUTaQo7xLhkO",
      "not-an-address",
    ];
    for (const value of samples) {
      expect(isBase58Address(value), value).toBe(isAddress(value));
      if (isAddress(value)) expect(parseKycRegistryPin(value)).toBe(value);
      else expect(() => parseKycRegistryPin(value)).toThrow();
    }
  });
});

describe("next.config default export", () => {
  it("runs the guard against process.env and returns the config", () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "");
    expect(() => config(BUILD)).toThrow(/not set/);

    vi.stubEnv("NEXT_PUBLIC_NETWORK", "mainnet");
    vi.stubEnv("MAINNET_LEGAL_COPY_APPROVED", "");
    expect(() => config(BUILD)).toThrow(/Refusing a mainnet build/);

    vi.stubEnv("MAINNET_LEGAL_COPY_APPROVED", "true");
    // No mainnet Supabase project is recorded yet: every mainnet build stops here.
    expect(() => config(BUILD)).toThrow(/no mainnet Supabase project is recorded/);

    vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://aaaaaaaaaaaaaaaaaaaa.supabase.co");
    expect(() => config(BUILD)).toThrow(/Refusing a devnet build: NEXT_PUBLIC_SUPABASE_URL/);

    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", `https://${SUPABASE_PROJECT_REFS.devnet}.supabase.co`);
    vi.stubEnv("TURNSTILE_SECRET_KEY", "0x4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "");
    expect(() => config(BUILD)).toThrow(/NEXT_PUBLIC_TURNSTILE_SITE_KEY is not/);

    vi.stubEnv("TURNSTILE_SECRET_KEY", "");
    vi.stubEnv("NEXT_PUBLIC_KYC_REGISTRY", "");
    expect(() => config(BUILD)).toThrow(/NEXT_PUBLIC_KYC_REGISTRY is not set/);

    vi.stubEnv("NEXT_PUBLIC_KYC_REGISTRY", PIN);
    const resolved = config(BUILD);
    expect(resolved.poweredByHeader).toBe(false);
    expect(typeof resolved.headers).toBe("function");
  });

  it("keeps the X-Robots-Tag noindex header on /account paths", async () => {
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
    const headers = await config(BUILD).headers!();
    // Other rules (site-wide security headers, no-store pages) sit alongside;
    // the account rules must still be there and still carry noindex.
    const account = headers.filter((h) => h.source === "/account/:path*" || h.source === "/api/account/:path*");
    expect(account.map((h) => h.source)).toEqual(["/account/:path*", "/api/account/:path*"]);
    for (const entry of account) {
      expect(entry.headers).toContainEqual({ key: "X-Robots-Tag", value: "noindex, nofollow" });
    }
  });
});
