// Mainnet whitepaper gate (gap 2026-09-28 lansiranje-2): on mainnet a sale
// may be approved (/api/sale-approvals/reserve → requireMainnetOfferingClearance)
// and its document served for purchases and commitments
// (lib/server/sale-document.ts publishedSaleDocument) only with an
// SSC-approved whitepaper (status + decision reference) or a recorded offering
// exemption; test networks are unchanged and never read the 0076 columns. The
// exemption itself is admin-only and needs the super admin to record
// (/api/profiles/upsert). Chain reads, SIWS, the admin gate and Supabase are
// mocked; the routes and helpers run for real.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  network: "devnet" as "devnet" | "mainnet",
  wallet: "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2",
  params: {} as Record<string, unknown>,
  admin: true,
  superAdmin: false,
  /** What asset_profiles .maybeSingle() returns. */
  profile: null as Record<string, unknown> | null,
  profileError: null as { message: string } | null,
  selects: [] as Array<{ table: string; columns: string }>,
  upserts: [] as Array<Record<string, unknown>>,
  audits: [] as Array<Record<string, unknown>>,
}));

const SALE = "6D6TgUKrYY6dJrCUZ6LcJKt5EGGdCUgHtVeUKmRZbUJ2";
const SHARE_CLASS = "Pc4auCy8Fnwxs7EcFwBGKqV3SudxCKEEDLHbEHujBpK";
const ASSET = "3n1mQ6zsrVpQyzFCkr9qFVGgU3qHiHQeAvGtaVJk9oNr";
const VERSION = "10000000-0000-4000-8000-000000000001";
const SHA = "ab".repeat(32);
const PATH = `whitepapers/${ASSET}/abcd1234-wp.pdf`;

vi.mock("@/lib/network", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/network")>()),
  detectNetwork: () => state.network,
}));
vi.mock("@/lib/server/rpc", () => ({ getServerRpc: () => ({}) }));
vi.mock("@/lib/pdas", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/pdas")>()),
  findSalePda: vi.fn(async () => SALE),
  findShareClassPda: vi.fn(async () => SHARE_CLASS),
}));
vi.mock("@/lib/generated/asset_registry", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/generated/asset_registry")>();
  const account = (data: Record<string, unknown>) => ({ exists: true, programAddress: original.ASSET_REGISTRY_PROGRAM_ADDRESS, data });
  return {
    ...original,
    fetchMaybeSale: vi.fn(async () => account({ shareClass: SHARE_CLASS, saleId: BigInt(1) })),
    fetchMaybeShareClass: vi.fn(async () => account({ asset: ASSET, classIndex: 0 })),
  };
});
vi.mock("@/lib/server/document-versions", () => ({
  requireDocumentVersion: vi.fn(async () => ({ id: VERSION, sha256: SHA, verified_at: "2026-09-01T00:00:00Z", path: PATH })),
}));
vi.mock("@/lib/server/siws", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/siws")>()),
  verifySigned: vi.fn(async () => ({ wallet: state.wallet, params: state.params, via: "signature" })),
}));
vi.mock("@/lib/server/admin-gate", async () => {
  const { SiwsError } = await import("@/lib/server/siws-error");
  return {
    requireAdmin: vi.fn(async () => {
      if (!state.admin) throw new SiwsError(403, "Admin privileges required");
    }),
    requireSuperAdmin: vi.fn(async () => {
      if (!state.superAdmin) throw new SiwsError(403, "Super admin privileges required");
    }),
  };
});
vi.mock("@/lib/server/profile-read", () => ({ requireProfileOwner: vi.fn(async () => {}) }));
vi.mock("@/lib/server/audit", () => ({
  actorSourceOf: () => "siws-signature",
  writeServerAudit: vi.fn(async (_sb: unknown, input: Record<string, unknown>) => {
    state.audits.push(input);
    return "audit-1";
  }),
}));
vi.mock("@/lib/supabase-server", () => ({
  getSupabaseAdmin: () => ({
    from: (table: string) => {
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      Object.assign(builder, {
        select: (columns: string) => {
          state.selects.push({ table, columns });
          return builder;
        },
        eq: chain, in: chain, limit: chain,
        upsert: (row: Record<string, unknown>) => {
          state.upserts.push(row);
          return Promise.resolve({ error: null });
        },
        maybeSingle: async () => ({ data: state.profile, error: state.profileError }),
      });
      return builder;
    },
  }),
}));

import { offeringClearance, OFFERING_NOT_CLEARED } from "@/lib/whitepaper-approval";
import { publishedSaleDocument } from "@/lib/server/sale-document";
import { requireMainnetOfferingClearance } from "@/app/api/sale-approvals/_lib";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { POST as upsertRoute } from "@/app/api/profiles/upsert/route";

const PUBLISHED = {
  whitepaper_path: PATH, whitepaper_sha256: SHA, whitepaper_version_id: VERSION,
  whitepaper_status: "published", ssc_decision_ref: null,
};

beforeEach(() => {
  state.network = "devnet";
  state.params = {};
  state.admin = true;
  state.superAdmin = false;
  state.profile = null;
  state.profileError = null;
  state.selects = [];
  state.upserts = [];
  state.audits = [];
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
});

describe("offeringClearance", () => {
  const base = { whitepaper_status: "published" as const, ssc_decision_ref: null, offering_exemption_ref: null, offering_exemption_reason: null };

  it("clears every offering on test networks (unchanged)", () => {
    for (const network of ["devnet", "testnet", "localnet"] as const) {
      expect(offeringClearance(null, network)).toEqual({ cleared: true, basis: "test_network" });
      expect(offeringClearance(base, network)).toEqual({ cleared: true, basis: "test_network" });
    }
  });

  it("mainnet: an SSC-approved whitepaper with its decision reference, or a complete exemption", () => {
    expect(offeringClearance({ ...base, whitepaper_status: "ssc_approved", ssc_decision_ref: " 5/0-01/26 " }, "mainnet"))
      .toEqual({ cleared: true, basis: "ssc_approved", ref: "5/0-01/26" });
    expect(offeringClearance({ ...base, offering_exemption_ref: "Opinion 12/2026", offering_exemption_reason: "Fewer than 20 investors" }, "mainnet"))
      .toEqual({ cleared: true, basis: "exemption", ref: "Opinion 12/2026" });
  });

  it("mainnet: refuses a published-only whitepaper, a reference without approval, a half exemption, no profile", () => {
    const refused = { cleared: false, reason: OFFERING_NOT_CLEARED };
    expect(offeringClearance(base, "mainnet")).toEqual(refused);
    expect(offeringClearance({ ...base, ssc_decision_ref: "5/0-01/26" }, "mainnet")).toEqual(refused);
    expect(offeringClearance({ ...base, whitepaper_status: "ssc_approved", ssc_decision_ref: "  " }, "mainnet")).toEqual(refused);
    expect(offeringClearance({ ...base, offering_exemption_ref: "Opinion 12/2026" }, "mainnet")).toEqual(refused);
    expect(offeringClearance({ ...base, offering_exemption_reason: "Private placement" }, "mainnet")).toEqual(refused);
    expect(offeringClearance(null, "mainnet")).toEqual(refused);
  });
});

describe("publishedSaleDocument", () => {
  it("devnet: serves a published document without reading the 0076 columns, labeled not approved", async () => {
    state.profile = PUBLISHED;
    const terms = await publishedSaleDocument(SALE);
    expect(terms).toMatchObject({ sale: SALE, asset: ASSET, versionId: VERSION, sha256: SHA, sscDecisionRef: null });
    expect(state.selects).toEqual([{ table: "asset_profiles", columns: expect.not.stringContaining("offering_exemption") }]);
  });

  it("mainnet: refuses (409) an offering that is not cleared", async () => {
    state.network = "mainnet";
    state.profile = { ...PUBLISHED, offering_exemption_ref: null, offering_exemption_reason: null };
    await expect(publishedSaleDocument(SALE)).rejects.toMatchObject({ status: 409, message: OFFERING_NOT_CLEARED });
    expect(state.selects[0].columns).toContain("offering_exemption_ref,offering_exemption_reason");
  });

  it("mainnet: serves an SSC-approved document with its decision reference, or an exempt one", async () => {
    state.network = "mainnet";
    state.profile = { ...PUBLISHED, whitepaper_status: "ssc_approved", ssc_decision_ref: "5/0-01/26" };
    expect((await publishedSaleDocument(SALE)).sscDecisionRef).toBe("5/0-01/26");
    state.profile = { ...PUBLISHED, offering_exemption_ref: "Opinion 12/2026", offering_exemption_reason: "Fewer than 20 investors" };
    expect((await publishedSaleDocument(SALE)).sscDecisionRef).toBeNull();
  });
});

describe("requireMainnetOfferingClearance (sale approval reserve)", () => {
  it("refuses 409 without clearance, 503 when the profile cannot be read, passes when cleared", async () => {
    const sb = getSupabaseAdmin() as never;
    state.profile = { whitepaper_status: "published", ssc_decision_ref: null, offering_exemption_ref: null, offering_exemption_reason: null };
    await expect(requireMainnetOfferingClearance(sb, ASSET)).rejects.toMatchObject({ status: 409 });
    state.profile = null;
    await expect(requireMainnetOfferingClearance(sb, ASSET)).rejects.toMatchObject({ status: 409 });
    state.profileError = { message: "down" };
    await expect(requireMainnetOfferingClearance(sb, ASSET)).rejects.toMatchObject({ status: 503 });
    state.profileError = null;
    state.profile = { whitepaper_status: "ssc_approved", ssc_decision_ref: "5/0-01/26", offering_exemption_ref: null, offering_exemption_reason: null };
    await expect(requireMainnetOfferingClearance(sb, ASSET)).resolves.toBeUndefined();
  });
});

describe("/api/profiles/upsert — the offering exemption", () => {
  const call = async (profile: Record<string, unknown>) => {
    state.params = { profile: { asset_pda: ASSET, category: "equity", ...profile } };
    const res = await upsertRoute(new Request("https://www.manci.io/api/profiles/upsert", { method: "POST", body: "{}" }));
    return { status: res.status, body: await res.json() };
  };
  const exemption = { offering_exemption_ref: "Opinion 12/2026", offering_exemption_reason: "Fewer than 20 investors, EUR 50k minimum" };

  it("an issuer cannot set it", async () => {
    state.admin = false;
    const { status, body } = await call(exemption);
    expect(status).toBe(403);
    expect(body.error).toMatch(/offering exemption can only be recorded by the platform/);
    expect(state.upserts).toEqual([]);
  });

  it("recording one needs the super admin; the server stamps who and when and audits it", async () => {
    expect((await call(exemption)).status).toBe(403);
    expect(state.upserts).toEqual([]);
    state.superAdmin = true;
    expect((await call({ ...exemption, offering_exemption_recorded_by: "Forged1111111111111111111111111111111111111" })).status).toBe(200);
    expect(state.upserts[0]).toMatchObject({
      ...exemption,
      offering_exemption_recorded_by: state.wallet,
      offering_exemption_recorded_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    expect(state.audits[0]).toMatchObject({ ix_name: "offering_exemption_record", category: "assets", target_label: ASSET });
  });

  it("any admin can clear it; half an exemption or a too-short reason is refused", async () => {
    expect((await call({ offering_exemption_ref: null, offering_exemption_reason: null })).status).toBe(200);
    expect(state.upserts[0]).toMatchObject({
      offering_exemption_ref: null, offering_exemption_reason: null,
      offering_exemption_recorded_by: null, offering_exemption_recorded_at: null,
    });
    expect(state.audits[0]).toMatchObject({ ix_name: "offering_exemption_clear" });
    state.superAdmin = true;
    expect((await call({ offering_exemption_ref: "Opinion 12/2026" })).status).toBe(400);
    expect((await call({ ...exemption, offering_exemption_reason: "short" })).status).toBe(400);
  });

  it("a patch without the exemption fields never writes them", async () => {
    expect((await call({ display_name: "Acme" })).status).toBe(200);
    expect(Object.keys(state.upserts[0]).filter((k) => k.startsWith("offering_exemption"))).toEqual([]);
    expect(state.audits).toEqual([]);
  });
});
