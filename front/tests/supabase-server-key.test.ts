// lib/supabase-server.ts on mainnet accepts only a secret API key
// (sb_secret_…) for SUPABASE_SERVICE_ROLE_KEY (Talas 4.3, D13); other
// networks keep accepting the legacy key. Creating a client makes no request.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const LEGACY = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.LEGACY_SIGNATURE";
const SECRET = "sb_secret_abcdefghijklmnopqrstuvwxyz012345";

async function admin(network: string, key: string) {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_NETWORK", network);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abcdefghijabcdefghij.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", key);
  const { getSupabaseAdmin } = await import("@/lib/supabase-server");
  return getSupabaseAdmin;
}

afterEach(() => vi.unstubAllEnvs());

describe("getSupabaseAdmin key format", () => {
  it("refuses a legacy key on mainnet without echoing it", async () => {
    const getSupabaseAdmin = await admin("mainnet", LEGACY);
    expect(() => getSupabaseAdmin()).toThrow(/must be a secret API key \(sb_secret_…\) on mainnet/);
    expect(() => getSupabaseAdmin()).not.toThrow(/LEGACY_SIGNATURE/);
    expect(() => getSupabaseAdmin(AbortSignal.timeout(1000))).toThrow(/sb_secret_/);
  });

  it("accepts a secret key on mainnet and either format elsewhere", async () => {
    expect((await admin("mainnet", SECRET))()).toBeDefined();
    expect((await admin("devnet", LEGACY))()).toBeDefined();
    expect((await admin("devnet", SECRET))()).toBeDefined();
    expect((await admin("testnet", LEGACY))()).toBeDefined();
  });
});
