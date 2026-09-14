// A failed indexer page must discard the entire snapshot and use chain data.
// Decoders are mocked because this suite tests source selection and paging;
// account layout correctness belongs to the generated codecs.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NetworkData } from "@/lib/enumerate";

const { getSupabaseMock } = vi.hoisted(() => ({
  getSupabaseMock: vi.fn(),
}));

vi.mock("@/lib/supabase", () => ({ getSupabase: getSupabaseMock }));
vi.mock("@/lib/network", () => ({ detectNetwork: () => "devnet" }));
vi.mock("@/lib/legacy-accounts", () => ({
  decodeReadableShareClass: (bytes: Uint8Array) => ({ ...JSON.parse(new TextDecoder().decode(bytes)), version: 2 }),
  isLegacyShareClass: () => false,
}));
vi.mock("@/lib/siws-client", () => ({ signedFetch: vi.fn() }));
vi.mock("@/lib/generated/asset_registry", () => {
  const names = [
    "Asset", "CustodyVault", "Issuer", "Offer", "Proposal",
    "RightsIssuance", "Sale", "ShareClass", "VestingMilestone", "VoteRecord",
  ];
  return Object.fromEntries(names.map((name) => [
    `get${name}Decoder`,
    () => ({ decode: (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes)) }),
  ]));
});

import { loadNetworkPreferIndexer } from "@/lib/indexer";

const TABLE_KEYS = {
  issuers: "issuers",
  assets: "assets",
  share_classes: "shareClasses",
  sales: "sales",
  offers: "offers",
  rights_issuances: "rightsIssuances",
  milestones: "milestones",
} as const satisfies Record<string, keyof NetworkData>;

type Table = keyof typeof TABLE_KEYS;
type RawRow = { raw: { base64: string }; layout_version: number; account_version: number };
type PageResult = { data: RawRow[] | null; error: { message: string } | null };

function row(table: Table, id = 0): RawRow {
  return {
    raw: { base64: btoa(JSON.stringify({ source: "indexer", table, id })) },
    layout_version: 2, account_version: table === "share_classes" ? 2 : 1,
  };
}

function page(rows: RawRow[]): PageResult {
  return { data: rows, error: null };
}

function stubIndexer(resultFor: (table: Table, from: number) => PageResult, state = { status: "ready", completed_at: new Date().toISOString(), checked_at: new Date().toISOString() }) {
  const requests: { table: Table; from: number; to: number }[] = [];
  getSupabaseMock.mockReturnValue({
    from(table: Table) {
      const builder = {
        select: () => builder,
        maybeSingle: async () => ({ data: state, error: null }),
        eq: () => builder,
        order: () => builder,
        range: async (from: number, to: number) => {
          requests.push({ table, from, to });
          return resultFor(table, from);
        },
      };
      return builder;
    },
  });
  return requests;
}

function chainSnapshot(): NetworkData {
  // Distinct sentinels ensure no successful indexer table leaks into fallback.
  return Object.fromEntries(Object.values(TABLE_KEYS).map((key) => [
    key, [{ source: "chain", key }],
  ])) as unknown as NetworkData;
}

beforeEach(() => {
  getSupabaseMock.mockReset();
});

describe("loadNetworkPreferIndexer", () => {
  it("uses the complete chain snapshot when one first page fails and other tables have data", async () => {
    stubIndexer((table) => table === "sales"
      ? { data: null, error: { message: "indexer unavailable" } }
      : page([row(table)]));
    const chain = chainSnapshot();
    const fallback = vi.fn(async () => chain);

    const result = await loadNetworkPreferIndexer(fallback);

    expect(result).toBe(chain);
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it("discards a full first page when the second page fails instead of returning a partial market", async () => {
    const firstPage = Array.from({ length: 1000 }, (_, id) => row("assets", id));
    const requests = stubIndexer((table, from) => {
      if (table !== "assets") return page([row(table)]);
      return from === 0
        ? page(firstPage)
        : { data: null, error: { message: "second page timed out" } };
    });
    const chain = chainSnapshot();
    const fallback = vi.fn(async () => chain);

    const result = await loadNetworkPreferIndexer(fallback);

    expect(requests.filter(({ table }) => table === "assets")).toEqual([
      { table: "assets", from: 0, to: 999 },
      { table: "assets", from: 1000, to: 1999 },
    ]);
    expect(result).toBe(chain);
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it("keeps every successful indexer page and does not call RPC when all tables contain data", async () => {
    const requests = stubIndexer((table, from) => {
      if (table !== "assets") return page([row(table)]);
      return from === 0
        ? page(Array.from({ length: 1000 }, (_, id) => row(table, id)))
        : page([row(table, 1000)]);
    });
    const fallback = vi.fn(async () => chainSnapshot());

    const result = await loadNetworkPreferIndexer(fallback);

    expect(fallback).not.toHaveBeenCalled();
    expect(result.assets).toHaveLength(1001);
    expect(result.assets[1000]).toEqual({ source: "indexer", table: "assets", id: 1000 });
    for (const [table, key] of Object.entries(TABLE_KEYS)) {
      expect(result[key][0]).toMatchObject({ source: "indexer", table, id: 0 });
    }
    expect(new Set(requests.map(({ table }) => table))).toEqual(new Set(Object.keys(TABLE_KEYS)));
  });

  it.each(["warming", "degraded"])("uses chain data when indexer is %s", async (status) => {
    const calls = stubIndexer((table) => page([row(table)]), { status, completed_at: new Date().toISOString(), checked_at: new Date().toISOString() });
    const fallback = vi.fn(async () => chainSnapshot());
    await loadNetworkPreferIndexer(fallback); expect(fallback).toHaveBeenCalledOnce(); expect(calls).toHaveLength(0);
  });
  it("rejects stale readiness and does not read misleading partial tables", async () => {
    const calls = stubIndexer((table) => page([row(table)]), { status: "ready", completed_at: new Date().toISOString(), checked_at: new Date(Date.now() - 301_000).toISOString() });
    const fallback = vi.fn(async () => chainSnapshot()); await loadNetworkPreferIndexer(fallback);
    expect(fallback).toHaveBeenCalledOnce(); expect(calls).toHaveLength(0);
  });
  it.each(["layout", "version", "bytes"])("does not silently hide a row with invalid %s", async (field) => {
    stubIndexer((table) => {
      const r = row(table);
      if (table === "share_classes") {
        if (field === "layout") r.layout_version = 1;
        if (field === "version") r.account_version = 1;
        if (field === "bytes") r.raw.base64 = "not-json";
      }
      return page([r]);
    });
    const fallback = vi.fn(async () => chainSnapshot()); await loadNetworkPreferIndexer(fallback); expect(fallback).toHaveBeenCalledOnce();
  });

  it("propagates an RPC failure after an indexer page error instead of returning partial data", async () => {
    stubIndexer((table) => table === "offers"
      ? { data: null, error: { message: "indexer offline" } }
      : page([row(table)]));
    const rpcFailure = new Error("RPC unavailable");
    const fallback = vi.fn(async () => { throw rpcFailure; });

    await expect(loadNetworkPreferIndexer(fallback)).rejects.toBe(rpcFailure);
    expect(fallback).toHaveBeenCalledTimes(1);
  });
});
