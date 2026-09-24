// helius-webhook edge function configuration (Talas 4.3 §6): the database key
// is MANCI_SUPABASE_SECRET_KEY in the new sb_secret_ format with no legacy
// fallback, and anything missing answers 503 so Helius retries.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { notConfigured, readEdgeConfig } from "../supabase/functions/_shared/edge-config";

const FUNCTION_DIR = join(process.cwd(), "supabase/functions/helius-webhook");
const GOOD = {
  SUPABASE_URL: "https://gvnckuzmuwozlcohtuhx.supabase.co",
  MANCI_SUPABASE_SECRET_KEY: "sb_secret_abcdefghijklmnopqrstuv_-0123",
  HELIUS_WEBHOOK_SECRET: "h".repeat(40),
  INDEXER_NETWORK: "devnet",
};
const read = (env: Record<string, string | undefined>) => readEdgeConfig((name) => env[name]);

describe("edge function configuration", () => {
  it("accepts a complete configuration", () => {
    expect(read(GOOD)).toEqual({
      ok: true,
      config: { url: GOOD.SUPABASE_URL, key: GOOD.MANCI_SUPABASE_SECRET_KEY, secret: GOOD.HELIUS_WEBHOOK_SECRET, network: "devnet" },
    });
  });

  it.each([
    ["a legacy JWT service-role key", { MANCI_SUPABASE_SECRET_KEY: "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.sig" }],
    ["a publishable key", { MANCI_SUPABASE_SECRET_KEY: "sb_publishable_abcdefghijklmnopqrstuvwx" }],
    ["a short secret key", { MANCI_SUPABASE_SECRET_KEY: "sb_secret_short" }],
    ["a secret key with other characters", { MANCI_SUPABASE_SECRET_KEY: "sb_secret_abcdefghijklmnop qrstuvwx" }],
    ["no key", { MANCI_SUPABASE_SECRET_KEY: undefined }],
    ["a plain-http URL", { SUPABASE_URL: "http://gvnckuzmuwozlcohtuhx.supabase.co" }],
    ["a URL with credentials", { SUPABASE_URL: "https://user:pw@gvnckuzmuwozlcohtuhx.supabase.co" }],
    ["no URL", { SUPABASE_URL: undefined }],
    ["a short webhook secret", { HELIUS_WEBHOOK_SECRET: "short" }],
    ["a webhook secret with whitespace", { HELIUS_WEBHOOK_SECRET: `${"h".repeat(40)} ` }],
    ["no webhook secret", { HELIUS_WEBHOOK_SECRET: undefined }],
    ["an unknown network", { INDEXER_NETWORK: "mainnet-beta" }],
    ["no network", { INDEXER_NETWORK: undefined }],
  ])("refuses %s", (_label, override) => {
    expect(read({ ...GOOD, ...override })).toEqual({ ok: false });
  });

  it("never falls back to the legacy SUPABASE_SERVICE_ROLE_KEY (D12)", () => {
    expect(read({ ...GOOD, MANCI_SUPABASE_SECRET_KEY: undefined, SUPABASE_SERVICE_ROLE_KEY: "sb_secret_abcdefghijklmnopqrstuv" })).toEqual({ ok: false });
  });

  it("answers an unconfigured receiver with a retryable 503 that names nothing", async () => {
    const response = notConfigured();
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ message: "Indexer receiver is not configured" });
  });

  it("pins supabase-js to the locked version and functions-js exactly, with no remote URL imports", () => {
    const lock = JSON.parse(readFileSync(join(process.cwd(), "package-lock.json"), "utf8"));
    const locked = lock.packages["node_modules/@supabase/supabase-js"].version as string;
    const imports = JSON.parse(readFileSync(join(FUNCTION_DIR, "deno.json"), "utf8")).imports as Record<string, string>;
    expect(imports["@supabase/supabase-js"]).toBe(`npm:@supabase/supabase-js@${locked}`);
    expect(imports["@supabase/functions-js"]).toMatch(/^jsr:@supabase\/functions-js@\d+\.\d+\.\d+$/);
    expect(Object.keys(imports).sort()).toEqual(["@supabase/functions-js", "@supabase/supabase-js"]);
    const source = readFileSync(join(FUNCTION_DIR, "index.ts"), "utf8");
    expect(source).not.toMatch(/https:\/\/esm\.sh|SUPABASE_SERVICE_ROLE_KEY"/);
    expect(source).toContain('from "@supabase/supabase-js"');
    expect(source).toContain("readEdgeConfig(");
  });
});
