import { afterEach, describe, expect, it, vi } from "vitest";
import { address } from "@solana/kit";
import { loadHoldings } from "@/lib/holdings";
import { enrichPortfolioHoldings } from "@/lib/portfolio-overview";
import { getOpenPassportRequest } from "@/lib/passport";
import { findAssetPda, type Asset, type ShareClass } from "@/lib/generated/asset_registry";

const OWNER = address("11111111111111111111111111111111");
const OTHER = address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const MINT = address("So11111111111111111111111111111111111111112");
const MINT_B = address("ComputeBudget111111111111111111111111111111");

function rpcResult(value: unknown) {
  return { getTokenAccountsByOwner: vi.fn(() => ({ send: vi.fn().mockResolvedValue(value) })) } as unknown as Parameters<typeof loadHoldings>[0];
}
function account(amount: string) {
  return { pubkey: OTHER, account: { data: { parsed: { info: { mint: MINT, tokenAmount: { amount } } } } } };
}

describe("portfolio balance reads", () => {
  it("propagates RPC failure instead of reporting an empty wallet", async () => {
    const rpc = { getTokenAccountsByOwner: () => ({ send: vi.fn().mockRejectedValue(new Error("RPC unavailable")) }) } as unknown as Parameters<typeof loadHoldings>[0];
    await expect(loadHoldings(rpc, OWNER)).rejects.toThrow("RPC unavailable");
  });
  it("distinguishes an empty wallet from unreadable token accounts", async () => {
    await expect(loadHoldings(rpcResult({ value: [] }), OWNER)).resolves.toEqual([]);
    await expect(loadHoldings(rpcResult({}), OWNER)).rejects.toThrow("unavailable");
    await expect(loadHoldings(rpcResult({ value: [{ pubkey: OTHER, account: { data: ["AAAA", "base64"] } }] }), OWNER)).rejects.toThrow("decoded");
  });
  it("preserves balances above Number.MAX_SAFE_INTEGER and drops zero balances", async () => {
    const result = await loadHoldings(rpcResult({ value: [account("9007199254740993"), account("0")] }), OWNER);
    expect(result).toEqual([{ mint: MINT, account: OTHER, balance: BigInt("9007199254740993") }]);
  });
  it("does not silently discard malformed amounts and report partial balances", async () => {
    for (const amount of ["", "1.5", "-1", "bad"]) {
      await expect(loadHoldings(rpcResult({ value: [account("100"), account(amount)] }), OWNER)).rejects.toThrow("decoded");
    }
  });
});

describe("portfolio asset identities and totals", () => {
  it("keeps same-named assets from different issuers distinct and combines accounts of one mint", async () => {
    const assets = [OWNER, OTHER].map((issuer) => ({ issuer, name: "Same name", assetId: "BOND" }) as Asset);
    const pdas = await Promise.all(assets.map(async (asset) => (await findAssetPda(asset))[0]));
    const shareClasses = [MINT, MINT_B].map((mint, i) => ({ mint, asset: pdas[i], classIndex: 0, classType: 0 }) as ShareClass);
    const rows = await enrichPortfolioHoldings({ assets, shareClasses }, [
      { mint: MINT, account: "a", balance: BigInt("9007199254740993") },
      { mint: MINT, account: "b", balance: BigInt(2) },
      { mint: MINT_B, account: "c", balance: BigInt(4) },
      { mint: OWNER, account: "unrelated", balance: BigInt(99) },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0].balance).toBe(BigInt("9007199254740995"));
    expect(rows.map((row) => row.assetPda)).toEqual(pdas);
    expect(new Set(rows.map((row) => row.assetPda)).size).toBe(2);
    expect(rows.map((row) => row.assetName)).toEqual(["Same name", "Same name"]);
  });
  it("retains a known share balance and canonical link when asset metadata is unavailable", async () => {
    const rows = await enrichPortfolioHoldings({ assets: [], shareClasses: [{ mint: MINT, asset: OTHER, classIndex: 0, classType: 0 } as ShareClass] }, [{ mint: MINT, account: "a", balance: BigInt(5) }]);
    expect(rows[0]).toMatchObject({ assetPda: OTHER, balance: BigInt(5), assetName: "Asset details unavailable" });
  });
});

describe("passport application status reads", () => {
  afterEach(() => vi.unstubAllGlobals());
  const reply = (body: unknown, status = 200) => vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status })));
  it("returns null only for an explicitly confirmed absence of an application", async () => {
    reply({ ok: true, data: { open: null } });
    await expect(getOpenPassportRequest(OWNER)).resolves.toBeNull();
    reply({ ok: true, data: {} });
    await expect(getOpenPassportRequest(OWNER)).rejects.toThrow("unavailable");
  });
  it("preserves an existing review request", async () => {
    const open = { id: "request", status: "in_review", created_at: "2026-11-07T10:00:00Z" };
    reply({ ok: true, data: { open } });
    await expect(getOpenPassportRequest(OWNER)).resolves.toEqual(open);
  });
  it("surfaces transport, HTTP and invalid payload failures instead of inviting a duplicate application", async () => {
    reply({ ok: false }, 503);
    await expect(getOpenPassportRequest(OWNER)).rejects.toThrow("unavailable");
    reply({ ok: true, data: { open: { id: "x", status: "approved", created_at: "invalid" } } });
    await expect(getOpenPassportRequest(OWNER)).rejects.toThrow("could not be read");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(getOpenPassportRequest(OWNER)).rejects.toThrow("offline");
  });
});
