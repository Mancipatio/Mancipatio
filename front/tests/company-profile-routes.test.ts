// The company fields of a token's profile on the two routes that write them
// (migration 0093):
//   POST /api/profiles/upsert   company_name, team and link_* are validated
//                               under lib/company-profile.ts; a logo is the
//                               asset's verified upload; only an admin
//                               approves it, the server stamps who and when,
//                               and a new or removed file is unapproved again
//   POST /api/storage/upload    logos/<asset>/…: PNG or JPEG of at most 1 MB,
//                               from an admin or the asset's issuer authority,
//                               content-addressed in the public bucket
// SIWS, the admin gate, the ownership check, the document-version check and
// Supabase are mocked; the routes run for real.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  wallet: "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2",
  params: {} as Record<string, unknown>,
  admin: true,
  owner: true,
  /** The stored profile row (the route's first read). */
  profile: null as Record<string, unknown> | null,
  /** The stored logo columns (the route's logo read). */
  logo: null as Record<string, unknown> | null,
  versionOk: true,
  selects: [] as Array<{ table: string; columns: string }>,
  upserts: [] as Array<Record<string, unknown>>,
  inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
  audits: [] as Array<Record<string, unknown>>,
  versionChecks: [] as Array<unknown[]>,
  ownerChecks: [] as Array<unknown[]>,
}));

const ASSET = "3n1mQ6zsrVpQyzFCkr9qFVGgU3qHiHQeAvGtaVJk9oNr";
const OTHER = "Pc4auCy8Fnwxs7EcFwBGKqV3SudxCKEEDLHbEHujBpK";
const SHA = "ab".repeat(32);
const SHA2 = "cd".repeat(32);
const LOGO = `logos/${ASSET}/devnet/${SHA}/logo.png`;
const LOGO2 = `logos/${ASSET}/devnet/${SHA2}/logo.png`;

vi.mock("@/lib/network", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/network")>()),
  detectNetwork: () => "devnet",
}));
vi.mock("@/lib/server/siws", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/siws")>()),
  verifySigned: vi.fn(async () => ({ wallet: state.wallet, params: state.params, via: "signature" })),
}));
vi.mock("@/lib/server/admin-gate", async () => {
  const { SiwsError } = await import("@/lib/server/siws-error");
  const gate = vi.fn(async () => {
    if (!state.admin) throw new SiwsError(403, "Admin privileges required");
  });
  return { requireAdmin: gate, requireSuperAdmin: gate };
});
vi.mock("@/lib/server/profile-read", async () => {
  const { SiwsError } = await import("@/lib/server/siws-error");
  return {
    requireProfileOwner: vi.fn(async (...args: unknown[]) => {
      state.ownerChecks.push(args);
      if (!state.owner) throw new SiwsError(403, "Only the asset's issuer may do this");
    }),
  };
});
vi.mock("@/lib/server/document-versions", async () => {
  const { SiwsError } = await import("@/lib/server/siws-error");
  return {
    requireDocumentVersion: vi.fn(async (...args: unknown[]) => {
      state.versionChecks.push(args);
      if (!state.versionOk) throw new SiwsError(409, "Document version is not verified");
      return { id: "10000000-0000-4000-8000-000000000001" };
    }),
  };
});
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
      let columns = "";
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      Object.assign(builder, {
        select: (selected: string) => {
          columns = selected;
          state.selects.push({ table, columns: selected });
          return builder;
        },
        eq: chain, in: chain, limit: chain,
        upsert: (row: Record<string, unknown>) => {
          state.upserts.push(row);
          return Promise.resolve({ error: null });
        },
        insert: (row: Record<string, unknown>) => {
          state.inserts.push({ table, row });
          return Promise.resolve({ error: null });
        },
        maybeSingle: async () => ({ data: columns.startsWith("logo_path") ? state.logo : state.profile, error: null }),
      });
      return builder;
    },
    storage: { from: () => ({ createSignedUploadUrl: async () => ({ data: { token: "upload-token" }, error: null }) }) },
  }),
}));

import { POST as upsertRoute } from "@/app/api/profiles/upsert/route";
import { POST as uploadRoute } from "@/app/api/storage/upload/route";

beforeEach(() => {
  state.params = {};
  state.admin = true;
  state.owner = true;
  state.profile = null;
  state.logo = null;
  state.versionOk = true;
  for (const list of [state.selects, state.upserts, state.inserts, state.audits, state.versionChecks, state.ownerChecks]) list.length = 0;
});

const upsert = async (profile: Record<string, unknown>) => {
  state.params = { profile: { asset_pda: ASSET, category: "equity", ...profile } };
  const res = await upsertRoute(new Request("https://www.manci.io/api/profiles/upsert", { method: "POST", body: "{}" }));
  return { status: res.status, body: await res.json() };
};
const written = () => state.upserts.at(-1) ?? {};

describe("/api/profiles/upsert — the company's name, team and links", () => {
  it("stores them as the rules normalize them", async () => {
    state.admin = false;
    const { status } = await upsert({
      company_name: "  Mancipatio   d.o.o. ", team: [" Mladen Rakić — CEO & CTO ", ""],
      link_x: " https://x.com/Manci_rwa ", link_linkedin: "", link_github: "https://github.com/Mancipatio/Mancipatio",
    });
    expect(status).toBe(200);
    expect(written()).toMatchObject({
      company_name: "Mancipatio d.o.o.", team: ["Mladen Rakić — CEO & CTO"],
      link_x: "https://x.com/Manci_rwa", link_linkedin: null, link_github: "https://github.com/Mancipatio/Mancipatio",
    });
  });

  it("stores an emptied team as none", async () => {
    expect((await upsert({ team: [] })).status).toBe(200);
    expect(written().team).toBeNull();
  });

  it("refuses a look-alike link, an over-long team and a name that is not text, and writes nothing", async () => {
    for (const bad of [
      { link_x: "https://x.com.evil.example/Manci_rwa" }, { link_github: "http://github.com/Mancipatio" }, { link_linkedin: "https://linkedin.com/" },
      { team: Array.from({ length: 13 }, (_, i) => `Person ${i}`) }, { company_name: 42 }, { company_name: "a".repeat(201) },
    ]) {
      const { status } = await upsert(bad);
      expect(status, JSON.stringify(bad)).toBe(400);
    }
    expect(state.upserts).toEqual([]);
  });

  it("a patch that names none of them writes none of the 0093 columns and makes no logo read", async () => {
    expect((await upsert({ display_name: "MANCI" })).status).toBe(200);
    const keys = Object.keys(written());
    expect(keys.filter((key) => /^(company_name|team|link_|logo_)/.test(key))).toEqual([]);
    expect(state.selects.filter((select) => select.columns.startsWith("logo_path"))).toEqual([]);
  });
});

describe("/api/profiles/upsert — the logo", () => {
  it("an issuer sets the asset's verified upload; it is not approved", async () => {
    state.admin = false;
    expect((await upsert({ logo_path: LOGO, logo_sha256: SHA })).status).toBe(200);
    expect(state.versionChecks).toEqual([["documents", LOGO, SHA]]);
    expect(written()).toMatchObject({ logo_path: LOGO, logo_sha256: SHA, logo_approved_at: null, logo_approved_by: null });
  });

  it("refuses another asset's file, a path elsewhere, a missing hash and an unverified upload", async () => {
    state.admin = false;
    for (const bad of [
      { logo_path: `logos/${OTHER}/devnet/${SHA}/logo.png`, logo_sha256: SHA },
      { logo_path: `whitepapers/${ASSET}/logo.png`, logo_sha256: SHA },
      { logo_path: "https://evil.example/logo.png", logo_sha256: SHA },
      { logo_path: LOGO },
      { logo_path: LOGO, logo_sha256: "nothex" },
    ]) {
      expect((await upsert(bad)).status, JSON.stringify(bad)).toBe(400);
    }
    state.versionOk = false;
    expect((await upsert({ logo_path: LOGO, logo_sha256: SHA })).status).toBe(409);
    expect(state.upserts).toEqual([]);
  });

  it("an issuer cannot approve a logo or forge the approval stamps", async () => {
    state.admin = false;
    state.logo = { logo_path: LOGO, logo_sha256: SHA, logo_approved_at: null };
    const refused = await upsert({ logo_approved: true });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatch(/logo can only be approved by the platform/);
    expect(state.upserts).toEqual([]);
    expect((await upsert({ summary: "x", logo_approved_at: "2026-01-01T00:00:00Z", logo_approved_by: "Forged" })).status).toBe(200);
    expect(written()).not.toHaveProperty("logo_approved_at");
    expect(written()).not.toHaveProperty("logo_approved_by");
  });

  it("an admin approves the stored file: the server stamps who and when and audits it", async () => {
    state.logo = { logo_path: LOGO, logo_sha256: SHA, logo_approved_at: null };
    expect((await upsert({ logo_approved: true })).status).toBe(200);
    expect(state.versionChecks).toEqual([["documents", LOGO, SHA]]);
    expect(written()).toMatchObject({ logo_approved_by: state.wallet });
    expect(String(written().logo_approved_at)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // The decision is a patch key, never a column.
    expect(written()).not.toHaveProperty("logo_approved");
    expect(state.audits.map((audit) => audit.ix_name)).toEqual(["asset_logo_approve"]);
  });

  it("there is nothing to approve without a logo", async () => {
    const { status, body } = await upsert({ logo_approved: true });
    expect(status).toBe(409);
    expect(body.error).toMatch(/Upload a logo before approving it/);
    expect(state.upserts).toEqual([]);
  });

  it("a new file, or its removal, is unapproved again", async () => {
    state.admin = false;
    state.logo = { logo_path: LOGO, logo_sha256: SHA, logo_approved_at: "2026-11-01T00:00:00Z" };
    expect((await upsert({ logo_path: LOGO2, logo_sha256: SHA2 })).status).toBe(200);
    expect(written()).toMatchObject({ logo_path: LOGO2, logo_approved_at: null, logo_approved_by: null });
    expect((await upsert({ logo_path: null, logo_sha256: null })).status).toBe(200);
    expect(written()).toMatchObject({ logo_path: null, logo_sha256: null, logo_approved_at: null, logo_approved_by: null });
    // Sending the same file again leaves its approval alone.
    expect((await upsert({ logo_path: LOGO, logo_sha256: SHA })).status).toBe(200);
    expect(written()).not.toHaveProperty("logo_approved_at");
  });

  it("an admin withdraws an approval, on the record; and may upload and approve at once", async () => {
    state.logo = { logo_path: LOGO, logo_sha256: SHA, logo_approved_at: "2026-11-01T00:00:00Z" };
    expect((await upsert({ logo_approved: false })).status).toBe(200);
    expect(written()).toMatchObject({ logo_approved_at: null, logo_approved_by: null });
    expect(state.audits.map((audit) => audit.ix_name)).toEqual(["asset_logo_approval_withdraw"]);
    expect((await upsert({ logo_path: LOGO2, logo_sha256: SHA2, logo_approved: true })).status).toBe(200);
    expect(written()).toMatchObject({ logo_path: LOGO2, logo_approved_by: state.wallet });
  });
});

describe("/api/storage/upload — logos/<asset>/", () => {
  const upload = async (params: Record<string, unknown>) => {
    state.params = { bucket: "documents", path: `logos/${ASSET}/abcd1234-logo.png`, sha256: SHA, contentType: "image/png", size: 40_000, ...params };
    const res = await uploadRoute(new Request("https://www.manci.io/api/storage/upload", { method: "POST", body: "{}" }));
    return { status: res.status, body: await res.json() };
  };

  it("the asset's issuer authority uploads a PNG: content-addressed, in the public bucket", async () => {
    state.admin = false;
    expect((await upload({})).status).toBe(200);
    expect(state.ownerChecks).toEqual([[state.wallet, ASSET, "asset"]]);
    expect(state.inserts).toHaveLength(1);
    expect(state.inserts[0].row).toMatchObject({ bucket: "documents", path: `logos/${ASSET}/devnet/${SHA}/logo.png`, sha256: SHA, mime_type: "image/png", wallet: state.wallet });
  });

  it("an admin uploads one too; another wallet does not", async () => {
    expect((await upload({ contentType: "image/jpeg" })).status).toBe(200);
    state.admin = false;
    state.owner = false;
    expect((await upload({})).status).toBe(403);
    expect(state.inserts).toHaveLength(1);
  });

  it("refuses a PDF, an image over 1 MB and a path that is not an asset's", async () => {
    expect((await upload({ contentType: "application/pdf" })).status).toBe(400);
    const tooLarge = await upload({ size: 1024 * 1024 + 1 });
    expect(tooLarge.status).toBe(400);
    expect(tooLarge.body.error).toMatch(/PNG or JPEG of at most 1 MB/);
    expect((await upload({ size: 1024 * 1024 })).status).toBe(200);
    expect((await upload({ path: "logos/not-an-asset/logo.png" })).status).toBe(400);
    expect((await upload({ path: `logos/${ASSET}/deep/logo.png` })).status).toBe(400);
  });
});
