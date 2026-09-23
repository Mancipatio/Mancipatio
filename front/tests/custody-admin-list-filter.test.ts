import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verify: vi.fn(),
  admin: vi.fn(),
  eqs: [] as [string, unknown][],
  tables: [] as string[],
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/siws", async (original) => ({
  ...(await original<typeof import("@/lib/server/siws")>()),
  verifySigned: mocks.verify,
}));
vi.mock("@/lib/server/admin-gate", () => ({ requireAdmin: mocks.admin }));
vi.mock("@/lib/supabase-server", () => ({
  getSupabaseAdmin: () => {
    const builder = {
      select: () => builder,
      eq: (column: string, value: unknown) => {
        mocks.eqs.push([column, value]);
        return builder;
      },
      order: () => builder,
      then: (resolve: (v: unknown) => unknown) =>
        resolve({ data: [{ id: "r1" }], error: null }),
    };
    return {
      from: (table: string) => {
        mocks.tables.push(table);
        return builder;
      },
    };
  },
}));

import { POST as deliveryList } from "@/app/api/delivery/admin-list/route";
import { POST as conversionList } from "@/app/api/conversion/admin-list/route";

const VAULT = "FJs1EM1ND89L9sUXaS8VBKYXjmoXCkkVSJKRE19hmYxS";
const request = () => new Request("https://app.test/api/x", { method: "POST" });

describe("2D: delivery / conversion admin lists filter by vault_pda", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.eqs = [];
    mocks.tables = [];
    mocks.admin.mockResolvedValue(undefined);
  });

  it.each([
    [deliveryList, "delivery_requests"],
    [conversionList, "conversion_requests"],
  ] as const)("adds the signed vault_pda filter (%#)", async (route, table) => {
    mocks.verify.mockResolvedValue({ wallet: "admin", params: { vault_pda: VAULT } });
    const response = await route(request());
    expect(response.status).toBe(200);
    expect(mocks.tables).toEqual([table]);
    expect(mocks.eqs).toContainEqual(["vault_pda", VAULT]);
  });

  it.each([deliveryList, conversionList])(
    "keeps the full queue without the param (%#)",
    async (route) => {
      mocks.verify.mockResolvedValue({ wallet: "admin", params: {} });
      expect((await route(request())).status).toBe(200);
      expect(mocks.eqs.map(([column]) => column)).not.toContain("vault_pda");
    },
  );

  it.each([deliveryList, conversionList])(
    "rejects a vault_pda that is not an address (%#)",
    async (route) => {
      mocks.verify.mockResolvedValue({ wallet: "admin", params: { vault_pda: "x' or 1=1" } });
      expect((await route(request())).status).toBe(400);
      expect(mocks.tables).toEqual([]);
    },
  );
});
