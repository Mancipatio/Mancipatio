// lib/deadline-bounds: the v1.0.0-rc deadlines, pinned to the Rust constants
// (the IDL carries none), and the pre-sign checks built on them.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as BOUNDS from "@/lib/deadline-bounds";
import { resolveDealExpiry } from "@/lib/otc-deal";

const RUST = readFileSync(join(process.cwd(), "../program/programs/asset_registry/src/constants.rs"), "utf8");
function rustSecs(name: string): number {
  const match = new RegExp(`pub const ${name}: i64 = ([0-9_]+);`).exec(RUST);
  if (!match) throw new Error(`${name} not found in constants.rs`);
  return Number(match[1].replace(/_/g, ""));
}

describe("deadline bounds mirror constants.rs", () => {
  it.each([
    ["MAX_SALE_DURATION_SECONDS", "MAX_SALE_DURATION_SECS"],
    ["OTC_DEAL_MAX_TTL_SECONDS", "OTC_DEAL_MAX_TTL_SECS"],
    ["MAX_KYC_VALIDITY_SECONDS", "MAX_KYC_VALIDITY_SECS"],
    ["DELIVERY_ESCROW_MIN_DEADLINE_SECONDS", "DELIVERY_ESCROW_MIN_DEADLINE_SECS"],
    ["DELIVERY_ESCROW_MAX_DEADLINE_SECONDS", "DELIVERY_ESCROW_MAX_DEADLINE_SECS"],
    ["MIN_VAULT_VOTING_PERIOD_SECONDS", "MIN_VAULT_VOTING_PERIOD_SECS"],
  ] as const)("%s = %s", (ts, rust) => {
    expect(BOUNDS[ts]).toBe(rustSecs(rust));
  });
});

describe("saleEndError (open_sale, 6145)", () => {
  const now = BigInt(1_000_000);
  const year = BigInt(BOUNDS.MAX_SALE_DURATION_SECONDS);
  it("requires an end after the start, at most 365 days after max(start, now)", () => {
    expect(BOUNDS.saleEndError(BigInt(0), BigInt(0), now)).toMatch(/every sale ends/);
    expect(BOUNDS.saleEndError(now, now, now)).toMatch(/end after it starts/);
    expect(BOUNDS.saleEndError(BigInt(0), now + year, now)).toBeNull();
    expect(BOUNDS.saleEndError(BigInt(0), now + year + BigInt(1), now)).toMatch(/at most 365 days/);
    // A future start moves the cap with it.
    expect(BOUNDS.saleEndError(now + BigInt(10), now + BigInt(10) + year, now)).toBeNull();
  });
});

describe("resolveDealExpiry (create_otc_deal, 6149)", () => {
  it("clamps a request's expiry to 90 days out", () => {
    const nowMs = 1_700_000_000_000;
    const nowSec = BigInt(nowMs / 1000);
    const far = new Date(nowMs + 200 * 86_400_000).toISOString();
    expect(resolveDealExpiry(far, nowMs)).toBe(nowSec + BigInt(BOUNDS.OTC_DEAL_MAX_TTL_SECONDS));
    expect(BOUNDS.clampDealExpiry(nowSec + BigInt(5), nowSec)).toBe(nowSec + BigInt(5));
  });
});
