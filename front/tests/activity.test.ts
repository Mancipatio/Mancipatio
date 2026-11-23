// The overview's activity feed (GET /api/activity/public, lib/activity.ts,
// lib/server/activity.ts): the latest register entries and public issuer
// updates of this network, newest first. The database is the in-memory
// stand-in, so the network scoping, the status and visibility filters, the
// archive rule and the columns of every SELECT run for real. No case number,
// holder, wallet or issuer text is read, so none can be returned.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { memorySupabase, type MemorySupabase } from "./helpers/memory-supabase";

vi.mock("server-only", () => ({}));
const h = vi.hoisted(() => ({
  db: null as MemorySupabase | null,
  selects: [] as Array<{ table: string; columns: string }>,
}));
vi.mock("@/lib/network", () => ({ detectNetwork: () => "devnet" }));
vi.mock("@/lib/supabase-server", () => ({
  getSupabaseAdmin: () => ({
    from: (table: string) => {
      const builder = h.db!.client.from(table) as Record<string, (...args: unknown[]) => unknown>;
      const select = builder.select;
      builder.select = (columns?: unknown, opts?: unknown) => {
        h.selects.push({ table, columns: typeof columns === "string" ? columns : "*" });
        return select(columns, opts);
      };
      return builder;
    },
  }),
}));

import { GET } from "@/app/api/activity/public/route";
import { ACTIVITY_LIMIT, activityDate, activityText, byActivityDesc, registryName, type PublicActivity } from "@/lib/activity";

const ASSET = "AssetAssetAssetAssetAssetAssetAssetAsset1";
const OTHER = "AssetAssetAssetAssetAssetAssetAssetAsset2";
const GONE = "AssetAssetAssetAssetAssetAssetAssetAsset3";
const ISSUER = "IssuerIssuerIssuerIssuerIssuerIssuerIssu1";
const GONE_ISSUER = "IssuerIssuerIssuerIssuerIssuerIssuerIssu2";
const get = (query = "") => GET(new Request(`http://localhost/api/activity/public${query}`));

const entry = (over: Record<string, unknown> = {}) => ({
  network: "devnet", asset_pda: ASSET, share_class_pda: "Class1", units: "250", percent_bps: "250", registry: "APR",
  decision_ref: "BD 1/2026", decision_date: "2026-10-09", decision_doc_sha256: "ab".repeat(32), realize_tx: "tx",
  holder_client_id: "d0000000-0000-4000-8000-000000000001", note: "staff note", status: "recorded", created_by: "AdminWallet",
  ...over,
});
const update = (over: Record<string, unknown> = {}) => ({
  network: "devnet", id: "u1", issuer_pda: ISSUER, asset_pda: ASSET, kind: "quarterly_report", title: "Q3 figures", body: "Issuer text",
  visibility: "public", status: "published", published_at: "2026-11-02T10:00:00.000Z", published_by: "IssuerWallet",
  ...over,
});

beforeEach(() => {
  h.db = memorySupabase();
  h.db.ordered = true;
  h.selects.length = 0;
});

describe("GET /api/activity/public", () => {
  it("returns register entries and public issuer updates, newest first, with their public facts only", async () => {
    h.db!.rows("register_entries").push(entry());
    h.db!.rows("issuer_updates").push(update());
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toContain("s-maxage=60");
    const { ok, data } = await res.json();
    expect(ok).toBe(true);
    expect(data.items).toEqual([
      { kind: "update", at: "2026-11-02T10:00:00.000Z", asset_pda: ASSET, update_kind: "quarterly_report" },
      { kind: "registered", at: "2026-10-09", asset_pda: ASSET, units: "250", percent: "2.5", registry: "APR" },
    ]);
    // Nothing personal or issuer-written is in the answer.
    expect(JSON.stringify(data)).not.toMatch(/BD 1\/2026|staff note|AdminWallet|IssuerWallet|Q3 figures|Issuer text|d0000000|"tx"/);
  });

  it("selects only the columns it returns: no case number, dossier, wallet, title or body", async () => {
    await get();
    const columns = (table: string) => h.selects.filter((s) => s.table === table).map((s) => s.columns).join(",");
    expect(columns("register_entries")).toBe("asset_pda,units::text,percent_bps::text,registry,decision_date,status");
    expect(columns("issuer_updates")).toBe("asset_pda,issuer_pda,kind,visibility,status,published_at");
    for (const forbidden of ["decision_ref", "holder_client_id", "note", "created_by", "realize_tx", "title", "body", "published_by"]) {
      expect(columns("register_entries") + columns("issuer_updates")).not.toContain(forbidden);
    }
  });

  it("leaves out other networks, voided entries, drafts, holders-only and issuer-wide updates", async () => {
    h.db!.rows("register_entries").push(
      entry({ network: "mainnet" }),
      entry({ status: "voided" }),
      entry({ asset_pda: OTHER, units: "1", percent_bps: "0.01", decision_date: "2026-10-01" }),
    );
    h.db!.rows("issuer_updates").push(
      update({ network: "mainnet" }),
      update({ status: "draft", published_at: null }),
      update({ status: "withdrawn" }),
      update({ visibility: "holders" }),
      update({ asset_pda: null }),
      update({ kind: "something_else" }),
    );
    const { data } = await (await get()).json();
    expect(data.items).toEqual([
      { kind: "registered", at: "2026-10-01", asset_pda: OTHER, units: "1", percent: "0.0001", registry: "APR" },
    ]);
  });

  it("leaves out an archived asset and the assets of an archived issuer", async () => {
    h.db!.rows("asset_profiles").push(
      { network: "devnet", asset_pda: GONE, issuer_pda: ISSUER, status: "archived" },
      { network: "devnet", asset_pda: OTHER, issuer_pda: GONE_ISSUER, status: "published" },
      { network: "devnet", asset_pda: ASSET, issuer_pda: ISSUER, status: "published" },
    );
    h.db!.rows("issuer_profiles").push(
      { network: "devnet", issuer_pda: GONE_ISSUER, archive: { at: "2026-11-01" } },
      { network: "devnet", issuer_pda: ISSUER, archive: null },
    );
    h.db!.rows("register_entries").push(entry({ asset_pda: GONE }), entry({ asset_pda: OTHER }), entry());
    h.db!.rows("issuer_updates").push(update({ asset_pda: OTHER, issuer_pda: GONE_ISSUER }));
    const { data } = await (await get()).json();
    expect(data.items.map((item: PublicActivity) => item.asset_pda)).toEqual([ASSET]);
  });

  it("returns at most ACTIVITY_LIMIT items", async () => {
    for (let day = 1; day <= ACTIVITY_LIMIT + 5; day++) {
      h.db!.rows("register_entries").push(entry({ decision_date: `2026-09-${String(day).padStart(2, "0")}` }));
    }
    const { data } = await (await get()).json();
    expect(data.items).toHaveLength(ACTIVITY_LIMIT);
    expect(data.items[0].at).toBe(`2026-09-${ACTIVITY_LIMIT + 5}`);
  });

  it("takes no parameters and answers 503, uncached, when a table cannot be read", async () => {
    const withParam = await get("?asset=x");
    expect(withParam.status).toBe(400);
    expect(withParam.headers.get("Cache-Control")).toBe("no-store");
    h.db!.failReads.add("register_entries");
    const failed = await get();
    expect(failed.status).toBe(503);
    expect(failed.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("the feed's wording (lib/activity.ts)", () => {
  const registered: PublicActivity = { kind: "registered", at: "2026-10-09", asset_pda: ASSET, units: "250", percent: "2.5", registry: "APR" };
  const published: PublicActivity = { kind: "update", at: "2026-11-02T10:00:00.000Z", asset_pda: ASSET, update_kind: "annual_report" };

  it("says what happened in words, with the token's name", () => {
    expect(activityText(registered, "MANCI")).toEqual({
      title: "250 tokens of MANCI converted into registered ownership",
      detail: "2.5 % of the company, entered in the Serbian Business Registers Agency (APR).",
    });
    expect(activityText({ ...registered, units: "1" }, "MANCI").title).toBe("1 token of MANCI converted into registered ownership");
    expect(activityText({ ...registered, units: "12500" }, "MANCI").title).toContain("12,500 tokens");
    expect(activityText(published, "MANCI")).toEqual({
      title: "Annual report published for MANCI",
      detail: "Published by the issuer for token holders.",
    });
  });

  it("names a known registry in full and shows any other as recorded", () => {
    expect(registryName(" apr ")).toBe("the Serbian Business Registers Agency (APR)");
    expect(registryName("Companies House")).toBe("Companies House");
  });

  it("orders newest first and formats dates in UTC", () => {
    expect([registered, published].sort(byActivityDesc)).toEqual([published, registered]);
    expect(activityDate("2026-10-09")).toBe("9 Oct 2026");
    expect(activityDate("2026-11-02T23:30:00.000Z")).toBe("2 Nov 2026");
    expect(activityDate("not a date")).toBe("");
  });
});
