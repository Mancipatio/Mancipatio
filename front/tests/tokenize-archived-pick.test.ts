// The tokenize flow's asset ID pick (lib/tokenize-shares-chain
// pickTokenizeAssetId) with archived tokens (lib/archive.ts): an archived
// token under an ID is passed over silently — never resumed, never in the
// duplicate prompt — and a typed asset ID (Advanced) is tried alone.
import { describe, expect, it, vi } from "vitest";
import type { Address } from "@solana/kit";

const chain = vi.hoisted(() => ({ existing: new Map<string, Record<string, unknown>>() }));

vi.mock("@/lib/generated/asset_registry", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/generated/asset_registry")>();
  return {
    ...original,
    fetchAllMaybeAsset: vi.fn(async (_rpc: unknown, pdas: Address[]) =>
      pdas.map((address) => {
        const data = chain.existing.get(address.toString());
        return data ? { exists: true, address, data } : { exists: false, address };
      })),
    fetchMaybeShareClass: vi.fn(async (_rpc: unknown, address: Address) => ({ exists: false, address })),
  };
});

import { AssetStatus, AssetType, findAssetPda } from "@/lib/generated/asset_registry";
import { pickTokenizeAssetId } from "@/lib/tokenize-shares-chain";
import { assetIdCandidates, needsDuplicateConfirmation } from "@/lib/tokenize-shares";

const ISSUER = "B4tYFfqtw1Ya3Pv6vQAy7ZjXbbCtEsNksr4kZt963DBw" as Address;
const intent = { name: "Mancipatio 5%", symbolPrefix: "MANCI", tokens: BigInt(5_000) };
const draftToken = { assetType: AssetType.Equity, status: AssetStatus.Draft, name: "Mancipatio 5%", symbolPrefix: "MANCI", shareClassesCount: 0 };
const pdaOf = async (assetId: string) => (await findAssetPda({ issuer: ISSUER, assetId }))[0].toString();
const pick = (candidates: string[], archived?: Set<string>) =>
  pickTokenizeAssetId({} as never, {
    issuer: ISSUER, candidates, intent, canInitMint: false, profileSaved: async () => true, archived,
  });

describe("tokenize asset ID pick with archived tokens", () => {
  it("an unfinished token under the base ID is continued — unless it is archived, then a new ID is used without a duplicate prompt", async () => {
    const base = await pdaOf("MANCI-5PCT");
    chain.existing = new Map([[base, draftToken]]);
    const resumed = await pick(assetIdCandidates(null, "MANCI-5PCT"));
    expect(resumed).toMatchObject({ assetId: "MANCI-5PCT", step: { kind: "add_class" } });

    const fresh = await pick(assetIdCandidates(null, "MANCI-5PCT"), new Set([base]));
    expect(fresh).toMatchObject({ assetId: "MANCI-5PCT-2", step: { kind: "create" }, skipped: [] });
    expect(needsDuplicateConfirmation(fresh!)).toBe(false);
  });

  it("a non-archived finished token next to it still raises the duplicate prompt (only it is listed)", async () => {
    const base = await pdaOf("MANCI-5PCT");
    const second = await pdaOf("MANCI-5PCT-2");
    chain.existing = new Map([
      [base, draftToken],
      [second, { ...draftToken, status: AssetStatus.Active, shareClassesCount: 0 }],
    ]);
    const res = await pick(assetIdCandidates(null, "MANCI-5PCT"), new Set([base]));
    expect(res).toMatchObject({ assetId: "MANCI-5PCT-3", step: { kind: "create" } });
    expect(res!.skipped.map((s) => s.assetId)).toEqual(["MANCI-5PCT-2"]);
    expect(needsDuplicateConfirmation(res!)).toBe(true);
  });

  it("a typed asset ID is the only candidate: free → created as is; taken (even archived) → null, never a \"-2\"", async () => {
    chain.existing = new Map();
    expect(await pick(assetIdCandidates("MANCI-2026", "MANCI-5PCT"))).toMatchObject({ assetId: "MANCI-2026", step: { kind: "create" }, skipped: [] });
    const taken = await pdaOf("MANCI-2026");
    chain.existing = new Map([[taken, { ...draftToken, status: AssetStatus.Active, shareClassesCount: 0 }]]);
    expect(await pick(assetIdCandidates("MANCI-2026", "MANCI-5PCT"))).toBeNull();
    chain.existing = new Map([[taken, draftToken]]);
    expect(await pick(assetIdCandidates("MANCI-2026", "MANCI-5PCT"), new Set([taken]))).toBeNull();
  });
});
