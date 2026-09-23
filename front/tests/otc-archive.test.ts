import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({
  accounts: new Map<string, { owner: string; data: Uint8Array }>(),
  upserts: [] as unknown[],
  updates: [] as { patch: unknown; filters: unknown[][] }[],
  archived: null as unknown,
  verify: vi.fn(),
  admin: vi.fn(),
}));
vi.mock("@/lib/network", () => ({ detectNetwork: () => "devnet" }));
vi.mock("@/lib/server/rpc", () => ({
  getServerRpc: () => ({
    getAccountInfo: (addr: string) => ({
      send: async () => {
        const hit = mocks.accounts.get(addr);
        return {
          context: { slot: BigInt(1) },
          value: hit
            ? { data: [Buffer.from(hit.data).toString("base64"), "base64"], executable: false, lamports: BigInt(1), owner: hit.owner, rentEpoch: BigInt(0), space: BigInt(hit.data.length) }
            : null,
        };
      },
    }),
  }),
}));
vi.mock("@/lib/supabase-server", () => ({
  getSupabaseAdmin: () => ({
    from: (table: string) => {
      const filters: unknown[][] = [];
      let patch: unknown = null;
      const q = {
        select: () => q,
        eq: (...args: unknown[]) => { filters.push(args); return q; },
        maybeSingle: async () => ({ data: table === "indexer_closed_rows" ? mocks.archived : null, error: null }),
        upsert: async (row: unknown) => { mocks.upserts.push(row); return { error: null }; },
        update: (value: unknown) => { patch = value; return q; },
        then: (resolve: (v: unknown) => void) => { mocks.updates.push({ patch, filters }); resolve({ error: null }); },
      };
      return q;
    },
  }),
}));
vi.mock("@/lib/server/siws", async (original) => ({ ...await original<typeof import("@/lib/server/siws")>(), verifySigned: mocks.verify }));
vi.mock("@/lib/server/admin-gate", () => ({ requireAdmin: mocks.admin }));
import { getAddressDecoder } from "@solana/kit";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  findDealPda,
  getOtcDealEncoder,
  OtcDealStatus,
} from "@/lib/generated/asset_registry";
import { CLOSED_ACCOUNT_TAG } from "@/lib/closed-account";
import { POST } from "@/app/api/otc/admin-update/route";

const key = (n: number) => getAddressDecoder().decode(new Uint8Array(32).fill(n));
const admin = key(1);
const shareClass = key(2);
async function putDeal(status: OtcDealStatus) {
  const [pda] = await findDealPda({ shareClass, dealId: BigInt(9) });
  mocks.accounts.set(pda, {
    owner: ASSET_REGISTRY_PROGRAM_ADDRESS,
    data: new Uint8Array(
      getOtcDealEncoder().encode({
        admin, buyer: key(3), seller: key(4), shareClass, mint: key(5), paymentMint: key(6),
        assetEscrow: key(7), paymentEscrow: key(8), amount: BigInt(10), price: BigInt(20),
        assetDeposited: true, paymentDeposited: true, status, dealId: BigInt(9), expiresAt: BigInt(0),
        version: 1, bump: 255, assetDepositedAmount: BigInt(10), paymentDepositedAmount: BigInt(20),
      }),
    ),
  });
  return pda;
}
const call = async (wallet: string, dealPda: string) => {
  mocks.verify.mockResolvedValue({ wallet, params: { archive: true, deal_pda: dealPda } });
  return POST(new Request("https://app.test/api/otc/admin-update", { method: "POST", body: "{}" }));
};

describe("OTC deal archive before reclaim (2D)", () => {
  beforeEach(() => {
    mocks.accounts.clear(); mocks.upserts.length = 0; mocks.updates.length = 0; mocks.archived = null;
    mocks.admin.mockResolvedValue(undefined);
  });
  it("archives a terminal deal for its admin and closes the linked request", async () => {
    const pda = await putDeal(OtcDealStatus.Completed);
    const response = await call(admin, pda);
    expect(response.status).toBe(200);
    expect(mocks.upserts).toHaveLength(1);
    expect(mocks.upserts[0]).toMatchObject({ network: "devnet", table_name: "otc_deals", pda, row: { raw: { base64: expect.any(String) } } });
    expect(mocks.updates.at(-1)).toMatchObject({ patch: { status: "completed" }, filters: expect.arrayContaining([["deal_pda", pda], ["status", "created"]]) });
  });
  it("rejects an open deal", async () => {
    const pda = await putDeal(OtcDealStatus.Open);
    expect((await call(admin, pda)).status).toBe(409);
    expect(mocks.upserts).toHaveLength(0);
  });
  it("rejects an Admin who is not the deal's admin", async () => {
    const pda = await putDeal(OtcDealStatus.Cancelled);
    expect((await call(key(9), pda)).status).toBe(403);
    expect(mocks.upserts).toHaveLength(0);
  });
  it("accepts a retry after the reclaim only when the archive exists", async () => {
    const pda = await putDeal(OtcDealStatus.Expired);
    mocks.accounts.set(pda, { owner: ASSET_REGISTRY_PROGRAM_ADDRESS, data: CLOSED_ACCOUNT_TAG });
    expect((await call(admin, pda)).status).toBe(409);
    mocks.archived = { pda };
    expect((await call(admin, pda)).status).toBe(200);
    expect(mocks.upserts).toHaveLength(0);
  });
});
