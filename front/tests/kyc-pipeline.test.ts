// KYC pipeline pure logic — the client-side halves of the recompute state
// machine, magic-link TTL and the jurisdiction/expiry semantics shared with
// the on-chain program, PLUS the authoritative server branch of the TTL check
// (requireClientToken) — the mirror test alone gave false confidence while
// the server was fail-open on unparseable dates.
import { describe, expect, it, vi } from "vitest";

// app/api/clients/_helpers.ts guards itself with `import "server-only"`;
// stub that marker so the SERVER implementation (not a mirror) is under test.
vi.mock("server-only", () => ({}));

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ONBOARDING_TOKEN_TTL_DAYS,
  isOnboardingTokenExpired,
  recomputeKycDecision,
  type ClientKycStatus,
} from "@/lib/clients";
import {
  DEFAULT_APPROVED_JURISDICTIONS,
  bitmapHasCode,
  isDefaultApprovedJurisdiction,
  isJurisdictionRepresentable,
  isPassportExpired,
  issueBlockers,
  jurisdictionBitmap,
} from "@/lib/passport";
import {
  assertWalletNotTerminal,
  isOnboardingTokenLive,
  isTerminalKycStatus,
  requireClientToken,
  terminalKycStatusForWallet,
} from "@/app/api/clients/_helpers";

const DAY_MS = 24 * 3600 * 1000;

// ── recompute state machine (more_info → pending) ───────────────────────────

describe("recomputeKycDecision", () => {
  it("flips more_info back to pending when no requirements stay open", () => {
    expect(recomputeKycDecision("more_info", 0)).toBe("pending");
  });

  it("keeps more_info while any requirement is open", () => {
    expect(recomputeKycDecision("more_info", 1)).toBeNull();
    expect(recomputeKycDecision("more_info", 7)).toBeNull();
  });

  it("never touches any other state (cleared checklist or not)", () => {
    const others: ClientKycStatus[] = [
      "pending",
      "verified",
      "rejected",
      "suspended",
      "expired",
    ];
    for (const s of others) {
      expect(recomputeKycDecision(s, 0)).toBeNull();
      expect(recomputeKycDecision(s, 3)).toBeNull();
    }
  });
});

// ── magic-link TTL ──────────────────────────────────────────────────────────

describe("isOnboardingTokenExpired", () => {
  const now = Date.parse("2026-08-01T12:00:00Z");
  const iso = (ms: number) => new Date(ms).toISOString();

  it("treats a missing token as expired (nothing to redeem)", () => {
    expect(isOnboardingTokenExpired(null, null, iso(now), now)).toBe(true);
  });

  it("honours an explicit expiry stamp", () => {
    expect(
      isOnboardingTokenExpired("tok", iso(now + DAY_MS), iso(now - 30 * DAY_MS), now),
    ).toBe(false);
    expect(
      isOnboardingTokenExpired("tok", iso(now - 1), iso(now), now),
    ).toBe(true);
  });

  it("falls back to created_at + 14 days for pre-0041 rows", () => {
    const freshCreated = iso(now - (ONBOARDING_TOKEN_TTL_DAYS - 1) * DAY_MS);
    const staleCreated = iso(now - (ONBOARDING_TOKEN_TTL_DAYS + 1) * DAY_MS);
    expect(isOnboardingTokenExpired("tok", null, freshCreated, now)).toBe(false);
    expect(isOnboardingTokenExpired("tok", null, staleCreated, now)).toBe(true);
  });

  it("fails closed on unparseable dates", () => {
    expect(isOnboardingTokenExpired("tok", "not-a-date", "also-not", now)).toBe(true);
    expect(isOnboardingTokenExpired("tok", null, "garbage", now)).toBe(true);
  });
});

// ── SERVER magic-link TTL (requireClientToken — the authoritative branch) ───

describe("requireClientToken (server)", () => {
  const CLIENT_ID = "00000000-0000-4000-8000-000000000000";
  const DAY = 24 * 3600 * 1000;

  /** Minimal chainable Supabase stub returning one clients row. */
  function sbWith(row: Record<string, unknown> | null): SupabaseClient {
    const filters: Record<string, unknown> = {};
    const builder = {
      select: () => builder,
      eq: (column: string, value: unknown) => {
        filters[column] = value;
        return builder;
      },
      maybeSingle: async () => {
        expect(filters).toHaveProperty("id", CLIENT_ID);
        expect(filters).toHaveProperty("network");
        const matches = row && Object.entries(filters).every(([key, value]) => row[key] === value);
        return { data: matches ? row : null, error: null };
      },
    };
    return { from: () => builder } as unknown as SupabaseClient;
  }

  function row(overrides: Record<string, unknown>): Record<string, unknown> {
    return {
      id: CLIENT_ID,
      network: "devnet",
      created_at: new Date(Date.now() - 1 * DAY).toISOString(),
      onboarding_token: "tok",
      wallet: null,
      email: null,
      kyc_status: "more_info",
      tos_accepted_at: null,
      display_name: "T",
      ...overrides,
    };
  }

  it("accepts a matching token before its stamped expiry", async () => {
    const sb = sbWith(
      row({
        onboarding_token_expires_at: new Date(Date.now() + DAY).toISOString(),
      }),
    );
    await expect(
      requireClientToken(sb, CLIENT_ID, "tok"),
    ).resolves.toMatchObject({ id: CLIENT_ID });
  });

  it("rejects (401) once the stamped expiry has passed", async () => {
    const sb = sbWith(
      row({
        onboarding_token_expires_at: new Date(Date.now() - 1000).toISOString(),
      }),
    );
    await expect(
      requireClientToken(sb, CLIENT_ID, "tok"),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("FAILS CLOSED (401) on an unparseable stamped expiry", async () => {
    const sb = sbWith(row({ onboarding_token_expires_at: "not-a-date" }));
    await expect(
      requireClientToken(sb, CLIENT_ID, "tok"),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("pre-0041 fallback: created_at + 14d (fresh passes, stale rejects)", async () => {
    const fresh = sbWith(
      row({ created_at: new Date(Date.now() - 13 * DAY).toISOString() }),
    );
    await expect(
      requireClientToken(fresh, CLIENT_ID, "tok"),
    ).resolves.toMatchObject({ id: CLIENT_ID });

    const stale = sbWith(
      row({ created_at: new Date(Date.now() - 15 * DAY).toISOString() }),
    );
    await expect(
      requireClientToken(stale, CLIENT_ID, "tok"),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("FAILS CLOSED (401) when the fallback created_at is unparseable", async () => {
    const sb = sbWith(row({ created_at: "garbage" }));
    await expect(
      requireClientToken(sb, CLIENT_ID, "tok"),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("does not expose an invitation from another network", async () => {
    const sb = sbWith(row({
      network: "mainnet",
      onboarding_token_expires_at: new Date(Date.now() + DAY).toISOString(),
    }));
    await expect(requireClientToken(sb, CLIENT_ID, "tok")).rejects.toMatchObject({ status: 404 });
  });

  it("rejects a wrong or missing token regardless of TTL", async () => {
    const sb = sbWith(
      row({
        onboarding_token_expires_at: new Date(Date.now() + DAY).toISOString(),
      }),
    );
    await expect(
      requireClientToken(sb, CLIENT_ID, "wrong"),
    ).rejects.toMatchObject({ status: 401 });
    await expect(requireClientToken(sb, CLIENT_ID, "")).rejects.toMatchObject({
      status: 401,
    });
  });
});

// ── on-chain passport expiry semantics ──────────────────────────────────────

describe("isPassportExpired", () => {
  const nowSec = 1_800_000_000;

  it("expiry == 0 is ALWAYS expired (chain: valid only while expiry > now)", () => {
    expect(isPassportExpired(0, nowSec)).toBe(true);
    expect(isPassportExpired(BigInt(0), nowSec)).toBe(true);
  });

  it("mirrors the strict `expiry > now` comparison", () => {
    expect(isPassportExpired(nowSec - 1, nowSec)).toBe(true);
    expect(isPassportExpired(nowSec, nowSec)).toBe(true); // equal → expired
    expect(isPassportExpired(nowSec + 1, nowSec)).toBe(false);
    expect(isPassportExpired(BigInt(nowSec + 3600), nowSec)).toBe(false);
  });
});

// ── jurisdiction bitmap (128 bytes = codes 0..1023, full ISO range) ──────────

describe("jurisdiction bitmap semantics", () => {
  it("representability boundary is 1024 (byte index < 128 on-chain)", () => {
    expect(isJurisdictionRepresentable(0)).toBe(true);
    expect(isJurisdictionRepresentable(255)).toBe(true);
    expect(isJurisdictionRepresentable(276)).toBe(true); // Germany
    expect(isJurisdictionRepresentable(688)).toBe(true); // Serbia
    expect(isJurisdictionRepresentable(826)).toBe(true); // UK
    expect(isJurisdictionRepresentable(999)).toBe(true); // top of ISO range
    expect(isJurisdictionRepresentable(1023)).toBe(true); // last encodable bit
    expect(isJurisdictionRepresentable(1024)).toBe(false);
    expect(isJurisdictionRepresentable(-1)).toBe(false);
    expect(isJurisdictionRepresentable(1.5)).toBe(false);
  });

  it("round-trips representable codes through the bitmap", () => {
    const bitmap = jurisdictionBitmap([40, 100, 250, 255, 276, 688, 826]);
    for (const code of [40, 100, 250, 255, 276, 688, 826]) {
      expect(bitmapHasCode(bitmap, code)).toBe(true);
    }
    // Neighbouring bits must stay clear.
    expect(bitmapHasCode(bitmap, 41)).toBe(false);
    expect(bitmapHasCode(bitmap, 249)).toBe(false);
    expect(bitmapHasCode(bitmap, 687)).toBe(false);
    expect(bitmapHasCode(bitmap, 689)).toBe(false);
  });

  it("silently drops codes ≥ 1024 exactly as the chain rejects them", () => {
    const bitmap = jurisdictionBitmap([250, 688, 1024, 2048]);
    expect(bitmapHasCode(bitmap, 250)).toBe(true); // France fits
    expect(bitmapHasCode(bitmap, 688)).toBe(true); // Serbia fits since the widening
    expect(bitmapHasCode(bitmap, 1024)).toBe(false); // beyond the bitmap
    expect(bitmapHasCode(bitmap, 2048)).toBe(false);
    // No stray bits from the dropped codes.
    expect(bitmap.length).toBe(128);
  });

  it("bitmapHasCode never reads past the 128-byte account layout", () => {
    const full = new Uint8Array(128).fill(0xff);
    expect(bitmapHasCode(full, 1023)).toBe(true);
    expect(bitmapHasCode(full, 1024)).toBe(false);
  });
});

// ── default approved set (submit validation + registry bootstrap) ───────────

describe("DEFAULT_APPROVED_JURISDICTIONS", () => {
  it("includes Serbia (688) so the platform home market can apply", () => {
    expect(isDefaultApprovedJurisdiction(688)).toBe(true);
  });

  it("rejects codes outside the set", () => {
    expect(isDefaultApprovedJurisdiction(999)).toBe(false);
    expect(isDefaultApprovedJurisdiction(0)).toBe(false);
    expect(isDefaultApprovedJurisdiction(840)).toBe(false); // US not onboarded
  });

  it("every default-approved jurisdiction is encodable on-chain", () => {
    const bitmap = jurisdictionBitmap([...DEFAULT_APPROVED_JURISDICTIONS]);
    // Since the 128-byte widening, intake approval implies issuability —
    // no code in the default set may be silently dropped by the bitmap.
    for (const code of DEFAULT_APPROVED_JURISDICTIONS) {
      expect(isJurisdictionRepresentable(code)).toBe(true);
      expect(bitmapHasCode(bitmap, code)).toBe(true);
    }
  });

  it("holds no duplicates", () => {
    expect(new Set(DEFAULT_APPROVED_JURISDICTIONS).size).toBe(
      DEFAULT_APPROVED_JURISDICTIONS.length,
    );
  });
});

// ── issue gate (SHARED by /admin/kyc and /admin/clients/[id]) ───────────────

describe("issueBlockers", () => {
  const NOW = Date.parse("2026-08-01T12:00:00Z");
  const DAY = 24 * 3600 * 1000;
  const verified = (expiresInDays: number) => ({
    kyc_status: "verified",
    kyc_expires_at: new Date(NOW + expiresInDays * DAY).toISOString(),
  });
  const registry = {
    approvedJurisdictions: jurisdictionBitmap([40, 250]),
    blockedJurisdictions: jurisdictionBitmap([100]),
  };

  it("passes a verified, in-date dossier with a representable approved jurisdiction", () => {
    expect(
      issueBlockers({
        client: verified(180),
        jurisdiction: 40,
        registry,
        walletBlocked: false,
        hasOpenAlert: false,
        nowMs: NOW,
      }),
    ).toEqual([]);
  });

  it("blocks when no dossier is linked", () => {
    const blockers = issueBlockers({
      client: null,
      jurisdiction: 40,
      registry,
      nowMs: NOW,
    });
    expect(blockers.some((b) => b.includes("No client dossier"))).toBe(true);
  });

  it("blocks every non-verified dossier state (incl. suspended/rejected)", () => {
    for (const s of ["pending", "more_info", "suspended", "rejected", "expired"]) {
      const blockers = issueBlockers({
        client: { kyc_status: s },
        jurisdiction: 40,
        registry,
        nowMs: NOW,
      });
      expect(blockers.some((b) => b.includes(`"${s}"`))).toBe(true);
    }
  });

  it("blocks a verified dossier whose off-chain KYC validity has EXPIRED (no silent extension)", () => {
    const blockers = issueBlockers({
      client: verified(-1),
      jurisdiction: 40,
      registry,
      nowMs: NOW,
    });
    expect(blockers.some((b) => b.includes("expired"))).toBe(true);
    // Unparseable stored expiry fails closed too.
    expect(
      issueBlockers({
        client: { kyc_status: "verified", kyc_expires_at: "garbage" },
        jurisdiction: 40,
        registry,
        nowMs: NOW,
      }).some((b) => b.includes("expired")),
    ).toBe(true);
    // A verified dossier with NO stored expiry falls back to the policy
    // window at issue time — allowed (legacy rows), not a blocker.
    expect(
      issueBlockers({
        client: { kyc_status: "verified", kyc_expires_at: null },
        jurisdiction: 40,
        registry,
        walletBlocked: false,
        hasOpenAlert: false,
        nowMs: NOW,
      }),
    ).toEqual([]);
  });

  it("blocks a missing jurisdiction — jurisdiction 0 passports must be impossible", () => {
    for (const j of [null, undefined, 0, -3, 1.5]) {
      const blockers = issueBlockers({
        client: verified(180),
        jurisdiction: j as number | null | undefined,
        registry,
        nowMs: NOW,
      });
      expect(blockers.some((b) => b.includes("No jurisdiction"))).toBe(true);
    }
  });

  it("passes Serbia (688) when the registry approves it — the old 32-byte bitmap could not encode it", () => {
    expect(
      issueBlockers({
        client: verified(180),
        jurisdiction: 688,
        registry: {
          approvedJurisdictions: jurisdictionBitmap([688]),
          blockedJurisdictions: jurisdictionBitmap([]),
        },
        walletBlocked: false,
        hasOpenAlert: false,
        nowMs: NOW,
      }),
    ).toEqual([]);
  });

  it("blocks codes ≥ 1024 (not representable in the 128-byte bitmap)", () => {
    const blockers = issueBlockers({
      client: verified(180),
      jurisdiction: 1024,
      registry,
      nowMs: NOW,
    });
    expect(blockers.some((b) => b.includes("≥ 1024"))).toBe(true);
  });

  it("enforces the registry approved/blocked bitmaps when the registry is loaded", () => {
    expect(
      issueBlockers({
        client: verified(180),
        jurisdiction: 56, // not in the approved bitmap
        registry,
        nowMs: NOW,
      }).some((b) => b.includes("approved bitmap")),
    ).toBe(true);
    expect(
      issueBlockers({
        client: verified(180),
        jurisdiction: 100, // in the BLOCKED bitmap
        registry,
        nowMs: NOW,
      }).some((b) => b.includes("BLOCKED")),
    ).toBe(true);
    // Registry unknown (load failure) → bitmap checks are skipped, not failed
    // (the chain enforces the receiver's jurisdiction on every gated transfer).
    expect(
      issueBlockers({
        client: verified(180),
        jurisdiction: 56,
        registry: null,
        walletBlocked: false,
        hasOpenAlert: false,
        nowMs: NOW,
      }),
    ).toEqual([]);
  });

  it("blocks sanctioned wallets and unresolved compliance alerts", () => {
    expect(
      issueBlockers({
        client: verified(180),
        jurisdiction: 40,
        registry,
        walletBlocked: true,
        nowMs: NOW,
      }).some((b) => b.includes("blocklist")),
    ).toBe(true);
    expect(
      issueBlockers({
        client: verified(180),
        jurisdiction: 40,
        registry,
        hasOpenAlert: true,
        nowMs: NOW,
      }).some((b) => b.includes("compliance alert")),
    ).toBe(true);
  });

  // Talas 3.1 OD3: the blocklist is sender-only on-chain, so a passport issued
  // to a blocklisted wallet would let it RECEIVE KycGated units. Unknown
  // blocklist or alert status must block, never skip.
  it("fails closed when the blocklist or the alert status is unknown", () => {
    const unknownBoth = issueBlockers({
      client: verified(180),
      jurisdiction: 40,
      registry,
      walletBlocked: null,
      hasOpenAlert: null,
      nowMs: NOW,
    });
    expect(unknownBoth).toEqual([
      "Blocklist status could not be loaded — retry before issuing.",
      "Compliance alert status could not be loaded — retry before issuing.",
    ]);
    const blocklistOnly = issueBlockers({
      client: verified(180),
      jurisdiction: 40,
      registry,
      walletBlocked: null,
      hasOpenAlert: false,
      nowMs: NOW,
    });
    expect(blocklistOnly).toEqual(["Blocklist status could not be loaded — retry before issuing."]);
    // An omitted value is unknown too.
    const alertOmitted = issueBlockers({
      client: verified(180),
      jurisdiction: 40,
      registry,
      walletBlocked: false,
      nowMs: NOW,
    });
    expect(alertOmitted).toEqual(["Compliance alert status could not be loaded — retry before issuing."]);
  });
});

// ── terminal-status gate over ALL rows of a wallet ──────────────────────────
//
// A wallet can carry several clients rows (historic duplicates; 0041's unique
// index is SKIPPED when they already exist). The self-service routes pick the
// OLDEST row to work with, so the terminal check must run over every row —
// otherwise suspending the newer dossier leaves the older `pending` row
// answering for the wallet and the suspension is invisible to the pipeline.

describe("terminal KYC status over all rows of a wallet", () => {
  const WALLET = "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2";

  /** Chainable stub whose .eq() resolves with the full row list. */
  function sbRows(
    rows: { kyc_status: string }[] | null,
    error: { message: string } | null = null,
  ): SupabaseClient {
    return {
      from: () => ({
        select: () => ({
          eq: async () => ({ data: rows, error }),
        }),
      }),
    } as unknown as SupabaseClient;
  }

  it("classifies only suspended / rejected as terminal", () => {
    expect(isTerminalKycStatus("suspended")).toBe(true);
    expect(isTerminalKycStatus("rejected")).toBe(true);
    for (const s of ["pending", "verified", "more_info", "expired", null, 7]) {
      expect(isTerminalKycStatus(s)).toBe(false);
    }
  });

  it("finds a terminal status on ANY row, not just the oldest", async () => {
    const sb = sbRows([
      { kyc_status: "pending" }, // oldest — what the dossier lookup returns
      { kyc_status: "suspended" }, // newer — carries the compliance verdict
    ]);
    await expect(terminalKycStatusForWallet(sb, WALLET)).resolves.toBe(
      "suspended",
    );
    await expect(assertWalletNotTerminal(sb, WALLET)).rejects.toMatchObject({
      name: "SiwsError",
      status: 403,
    });
  });

  it("passes a wallet whose rows are all non-terminal", async () => {
    const sb = sbRows([{ kyc_status: "pending" }, { kyc_status: "more_info" }]);
    await expect(terminalKycStatusForWallet(sb, WALLET)).resolves.toBeNull();
    await expect(assertWalletNotTerminal(sb, WALLET)).resolves.toBeUndefined();
  });

  it("passes a wallet with no rows at all (fresh applicant)", async () => {
    const sb = sbRows([]);
    await expect(terminalKycStatusForWallet(sb, WALLET)).resolves.toBeNull();
  });

  it("throws 500 rather than assuming 'clear' when the probe fails", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const sb = sbRows(null, { message: "boom" });
      await expect(terminalKycStatusForWallet(sb, WALLET)).rejects.toMatchObject(
        { name: "SiwsError", status: 500 },
      );
    } finally {
      spy.mockRestore();
    }
  });
});

// ── onboarding-link liveness (pre-0041 degradation) ─────────────────────────
//
// Without the 0041 column a freshly issued token gets NO expiry stamp, so the
// server falls back to created_at + 14d — already in the past for an older
// dossier. Routes must ask this BEFORE advertising a link, or they hand out a
// credential their own next request rejects.

describe("isOnboardingTokenLive", () => {
  const NOW = Date.parse("2026-08-01T12:00:00Z");
  const iso = (ms: number) => new Date(ms).toISOString();

  it("honours the 0041 stamp in both directions", () => {
    expect(isOnboardingTokenLive(iso(NOW - 90 * DAY_MS), iso(NOW + DAY_MS), NOW)).toBe(
      true,
    );
    expect(isOnboardingTokenLive(iso(NOW), iso(NOW - 1), NOW)).toBe(false);
  });

  it("falls back to created_at + 14d when there is no stamp", () => {
    expect(
      isOnboardingTokenLive(iso(NOW - (ONBOARDING_TOKEN_TTL_DAYS - 1) * DAY_MS), null, NOW),
    ).toBe(true);
    // The degraded case the routes must catch: old dossier, no stamp.
    expect(
      isOnboardingTokenLive(iso(NOW - (ONBOARDING_TOKEN_TTL_DAYS + 1) * DAY_MS), null, NOW),
    ).toBe(false);
  });

  it("is fail-closed on unparseable / missing dates", () => {
    expect(isOnboardingTokenLive("not-a-date", null, NOW)).toBe(false);
    expect(isOnboardingTokenLive(iso(NOW), "not-a-date", NOW)).toBe(false);
    expect(isOnboardingTokenLive(null, null, NOW)).toBe(false);
  });
});
