// Archive (soft delete, off chain; lib/archive.ts) — the pure rules: the
// reason, what stands in the way (and who may override it), the stored
// record, the protected fields.archive, the list filter and the custom asset
// ID of the tokenize flow (A3).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Address } from "@solana/kit";
import { findAssetPda, findIssuerPda } from "@/lib/generated/asset_registry";
import { findShareClassPda } from "@/lib/pdas";
import type { NetworkData } from "@/lib/enumerate";
import {
  ARCHIVE_REASON_MIN,
  EMPTY_ARCHIVED,
  archivedSetFrom,
  assetArchiveBlockers,
  assetArchiveRecord,
  checkArchiveReason,
  hideArchived,
  isWithdrawn,
  issuerArchiveRefusal,
  lockableAtZero,
  protectArchive,
  readArchiveRecord,
  type ArchiveClassFacts,
  type AssetArchiveFacts,
} from "@/lib/archive";
import { assetIdCandidates, validateCustomAssetId } from "@/lib/tokenize-shares";

const B = (n: number) => BigInt(n);
const cls = (over: Partial<ArchiveClassFacts> = {}): ArchiveClassFacts => ({
  address: "HRcahPjAhX9ssiY5WvNJxHmy5vuDL7Q6GF6J5gNGjgwC",
  classIndex: 0,
  circulating: B(0),
  lifetimeMinted: B(0),
  supplyLocked: false,
  ...over,
});
const facts = (over: Partial<AssetArchiveFacts> = {}): AssetArchiveFacts => ({
  draft: true,
  classes: [cls(), cls({ classIndex: 1, address: "Pc4auCy8Fnwxs7EcFwBGKqV3SudxCKEEDLHbEHujBpK" })],
  openSales: 0,
  liveApprovals: 0,
  ...over,
});

describe("the reason", () => {
  it("is required, trimmed and bounded", () => {
    expect(checkArchiveReason("").ok).toBe(false);
    expect(checkArchiveReason("x".repeat(ARCHIVE_REASON_MIN - 1)).ok).toBe(false);
    expect(checkArchiveReason(42).ok).toBe(false);
    expect(checkArchiveReason("x".repeat(501)).ok).toBe(false);
    expect(checkArchiveReason("bad\u0007bell char").ok).toBe(false);
    expect(checkArchiveReason("  test asset, test legal PDF  ")).toEqual({ ok: true, reason: "test asset, test legal PDF" });
  });
});

describe("what stands in the way of archiving an asset", () => {
  it("nothing for the mainnet test token (class 0 cap 5000, nothing circulating, no sale)", () => {
    expect(assetArchiveBlockers(facts({ draft: false }))).toEqual([]);
  });

  it("an Open sale, a live approval and circulating supply, each said plainly", () => {
    const blockers = assetArchiveBlockers(facts({ openSales: 1, liveApprovals: 2, classes: [cls({ circulating: B(30), lifetimeMinted: B(30) })] }));
    expect(blockers.map((b) => b.code)).toEqual(["open_sale", "live_approval", "circulating"]);
    expect(blockers[0].message).toMatch(/1 sale is still Open on chain: buyers with a direct link can still buy/);
    expect(blockers[1].message).toMatch(/2 sale approvals are still live/);
    expect(blockers[2].message).toMatch(/30 token units are in circulation: holders still own them/);
  });

  it("the issuer path: its own Draft or never-minted asset with nothing in the way, else refused", () => {
    expect(issuerArchiveRefusal(facts())).toBeNull();
    expect(issuerArchiveRefusal(facts({ draft: false }))).toBeNull(); // active, never minted
    expect(issuerArchiveRefusal(facts({ draft: false, classes: [cls({ lifetimeMinted: B(5) })] })))
      .toMatch(/Tokens of this asset were created: only the platform's super admin/);
    // Burned back to 0 but minted once: still the super admin's call.
    expect(issuerArchiveRefusal(facts({ draft: false, classes: [cls({ lifetimeMinted: B(5), circulating: B(0) })] }))).not.toBeNull();
    expect(issuerArchiveRefusal(facts({ openSales: 1 }))).toMatch(/Only the platform's super admin can archive it now/);
    expect(issuerArchiveRefusal(facts({ liveApprovals: 1 }))).not.toBeNull();
  });

  it("lock at 0 is offered only on classes with nothing in circulation and not yet locked", () => {
    const f = facts({ classes: [cls(), cls({ classIndex: 1, supplyLocked: true }), cls({ classIndex: 2, circulating: B(1) })] });
    expect(lockableAtZero(f).map((c) => c.classIndex)).toEqual([0]);
  });
});

describe("the stored record", () => {
  const now = new Date("2026-10-03T10:00:00Z");
  it("keeps what the profile was, so unarchive restores it", () => {
    expect(assetArchiveRecord({ reason: "test token", wallet: "W", now, existing: { status: "published", is_published: true }, overridden: [] }))
      .toEqual({ reason: "test token", archived_by: "W", archived_at: now.toISOString(), previous_status: "published", previous_is_published: true, row_created: false });
    const created = assetArchiveRecord({ reason: "test token", wallet: "W", now, existing: null, overridden: ["circulating"] });
    expect(created).toMatchObject({ previous_status: "draft", previous_is_published: false, row_created: true, overridden: ["circulating"] });
  });

  it("reads back only a well-formed record", () => {
    expect(readArchiveRecord(null)).toBeNull();
    expect(readArchiveRecord({ reason: "x" })).toBeNull();
    expect(readArchiveRecord([])).toBeNull();
    expect(readArchiveRecord({ reason: "r", archived_by: "w", archived_at: "t" })).toMatchObject({ reason: "r" });
  });

  it("fields.archive is the archive route's alone", () => {
    const stored = { archive: { reason: "kept" }, tokenize: { a: 1 } };
    expect(protectArchive({ tokenize: { a: 2 }, archive: { reason: "forged" } }, stored)).toEqual({ tokenize: { a: 2 }, archive: { reason: "kept" } });
    expect(protectArchive({ archive: { reason: "forged" } }, null)).toEqual({});
    expect(protectArchive({ archive: { reason: "forged" } }, { tokenize: {} })).toEqual({});
  });
});

describe("hiding archived records from lists", () => {
  it("parses the public list defensively", () => {
    const set = archivedSetFrom({ assets: ["a", 1, null], issuers: "x", issuerArchiveAvailable: true });
    expect([...set.assets]).toEqual(["a"]);
    expect(set.issuers.size).toBe(0);
    expect(set.issuerArchiveAvailable).toBe(true);
    expect(archivedSetFrom(null)).toMatchObject({ issuerArchiveAvailable: false });
  });

  it("an asset is withdrawn when it or its issuer is archived", () => {
    const set = archivedSetFrom({ assets: ["A1"], issuers: ["I1"] });
    expect(isWithdrawn(set, "A1", "I2")).toBe(true);
    expect(isWithdrawn(set, "A2", "I1")).toBe(true);
    expect(isWithdrawn(set, "A2", "I2")).toBe(false);
    expect(isWithdrawn(EMPTY_ARCHIVED, "A1", "I1")).toBe(false);
  });

  async function network() {
    const legal = (s: string) => { const b = new Uint8Array(32); b.set(new TextEncoder().encode(s)); return b; };
    const issuers = [{ legalEntityId: legal("MANCI-5-2026") }, { legalEntityId: legal("OTHER-1") }];
    const [i1] = await findIssuerPda({ legalEntityId: issuers[0].legalEntityId });
    const [i2] = await findIssuerPda({ legalEntityId: issuers[1].legalEntityId });
    const assets = [
      { issuer: i1, assetId: "MANCI-5PCT", name: "Mancipatio 5%" },
      { issuer: i1, assetId: "MANCI-2026", name: "Mancipatio 5%" },
      { issuer: i2, assetId: "OTHER-1PCT", name: "Other 1%" },
    ];
    const pdas = await Promise.all(assets.map(async (a) => (await findAssetPda({ issuer: a.issuer, assetId: a.assetId }))[0]));
    const shareClasses = await Promise.all(pdas.flatMap((asset) => [0, 1].map(async (classIndex) => ({
      asset, classIndex, pda: await findShareClassPda(asset as Address, classIndex),
    }))));
    const sales = shareClasses.filter((sc) => sc.classIndex === 0).map((sc) => ({ shareClass: sc.pda, saleId: B(1) }));
    const rightsIssuances = shareClasses.filter((sc) => sc.classIndex === 0).map((sc) => ({ shareClass: sc.pda }));
    const data = {
      issuers, assets, shareClasses, sales, rightsIssuances, offers: [{ shareClass: shareClasses[0].pda }], milestones: [],
    } as unknown as NetworkData;
    return { data, i1: i1.toString(), i2: i2.toString(), pdas: pdas.map(String) };
  }

  it("leaves the data untouched when nothing is archived", async () => {
    const { data } = await network();
    expect(await hideArchived(data, EMPTY_ARCHIVED)).toBe(data);
  });

  it("an archived asset leaves with its classes, sales and rights issuances; offers (holders') stay", async () => {
    const { data, pdas } = await network();
    const out = await hideArchived(data, archivedSetFrom({ assets: [pdas[0]] }));
    expect(out.assets.map((a) => a.assetId)).toEqual(["MANCI-2026", "OTHER-1PCT"]);
    expect(out.shareClasses.map((sc) => sc.asset.toString())).not.toContain(pdas[0]);
    expect(out.sales).toHaveLength(2);
    expect(out.rightsIssuances).toHaveLength(2);
    expect(out.offers).toHaveLength(1);
    expect(out.issuers).toHaveLength(2);
  });

  it("an archived issuer leaves with every asset of it; the workspace keeps the issuer and its other assets", async () => {
    const { data, i1, pdas } = await network();
    const set = archivedSetFrom({ assets: [pdas[0]], issuers: [i1] });
    const pub = await hideArchived(data, set);
    expect(pub.issuers).toHaveLength(1);
    expect(pub.assets.map((a) => a.assetId)).toEqual(["OTHER-1PCT"]);
    expect(pub.sales).toHaveLength(1);
    const workspace = await hideArchived(data, set, { issuers: false });
    expect(workspace.issuers).toHaveLength(2);
    expect(workspace.assets.map((a) => a.assetId)).toEqual(["MANCI-2026", "OTHER-1PCT"]);
  });
});

describe("custom asset ID (tokenize → Advanced)", () => {
  it("validates the PDA seed: ≤ 32 bytes, A–Z 0–9 - _", () => {
    expect(validateCustomAssetId("MANCI-2026")).toBeNull();
    expect(validateCustomAssetId("A_1")).toBeNull();
    expect(validateCustomAssetId("X".repeat(32))).toBeNull();
    expect(validateCustomAssetId("X".repeat(33))).toMatch(/At most 32/);
    expect(validateCustomAssetId("")).toMatch(/Enter an asset ID/);
    expect(validateCustomAssetId("A")).toMatch(/At least 2/);
    expect(validateCustomAssetId("manci-2026")).toMatch(/capital letters/);
    expect(validateCustomAssetId("-MANCI")).toMatch(/starting with a letter or digit/);
    expect(validateCustomAssetId("MANČI")).toMatch(/capital letters/);
    expect(validateCustomAssetId("MANCI 2026")).toMatch(/capital letters/);
  });

  it("a typed ID is tried as is — never with a \"-2\" — else the automatic candidates", () => {
    expect(assetIdCandidates("MANCI-2026", "MANCI-5PCT")).toEqual(["MANCI-2026"]);
    expect(assetIdCandidates(" ", "MANCI-5PCT")[0]).toBe("MANCI-5PCT");
    expect(assetIdCandidates(null, "MANCI-5PCT").slice(0, 2)).toEqual(["MANCI-5PCT", "MANCI-5PCT-2"]);
  });
});

describe("wiring (read from the sources)", () => {
  const src = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

  it("the public lists leave archived records out; the workspace only archived assets", () => {
    for (const path of ["app/marketplace/page.tsx", "app/marketplace/launchpad/page.tsx", "components/market-overview.tsx"]) {
      expect(src(path), path).toContain("withoutArchived");
    }
    expect(src("app/issuer/page.tsx")).toContain("withoutArchivedAssets(");
    expect(src("app/issuer/assets/page.tsx")).toContain("showArchived ? myAssets : myAssets.filter((a) => !isArchived(a))");
    expect(src("app/admin/assets/page.tsx")).toContain("if (archived && !showArchived) return false;");
    expect(src("app/admin/issuers/page.tsx")).toContain("showArchived ||");
  });

  it("the other workspace and admin lists leave archived assets out too (review of PR #63)", () => {
    // Issuer workspace: share classes (no second "Mancipatio 5%" after re-tokenizing).
    expect(src("app/issuer/share-classes/page.tsx")).toContain("await withoutArchivedAssets(");
    // Admin lists: hidden unless "Show archived"; an Open sale stays (closing it is an admin's job).
    expect(src("app/admin/share-classes/page.tsx")).toContain("if (archived && !showArchived) return false;");
    expect(src("app/admin/rights/page.tsx")).toContain("if (archived && !showArchived) return false;");
    expect(src("app/admin/launchpad/page.tsx")).toContain(`if (archived && !showArchived && lc === "closed") return false;`);
    for (const path of ["app/admin/share-classes/page.tsx", "app/admin/rights/page.tsx", "app/admin/launchpad/page.tsx"]) {
      expect(src(path), path).toContain("<ShowArchivedToggle checked={showArchived}");
      expect(src(path), path).toContain("{archived && <ArchivedPill />}");
    }
    // The approval modal never offers an archived asset's class.
    expect(src("app/admin/applications/sale-approvals.tsx")).toContain("const offered = await withoutArchived(data);");
  });

  it("no route offers, approves or mints an archived asset again", () => {
    expect(src("app/api/sale-requests/submit/route.ts")).toContain("await requireNotArchived(sb, chain.asset, chain.issuer);");
    expect(src("app/api/sale-requests/submit/route.ts")).toContain(`.neq("status", "archived")`);
    expect(src("app/api/sale-approvals/reserve/route.ts")).toContain("await requireNotArchived(sb, chain.asset, chain.issuer);");
    expect(src("app/api/sale-approvals/treasury-mint/route.ts")).toContain("await requireNotArchived(sb, chain.asset, chain.issuer);");
  });

  it("direct links say withdrawn", () => {
    for (const path of ["app/marketplace/assets/[id]/page.tsx", "app/marketplace/issuers/[id]/page.tsx", "app/marketplace/launchpad/[sale]/page.tsx"]) {
      expect(src(path), path).toContain("<WithdrawnNotice");
    }
  });

  it("the tokenize flow: no archived token in Continue, none resumed or in the duplicate prompt, a typed ID tried alone", () => {
    const flow = src("components/tokenize-shares-flow.tsx");
    expect(flow).toContain("!archived.assets.has(r.pda.toString())");
    expect(flow).toContain("archived: archived.assets,");
    expect(flow).toContain("candidates: assetIdCandidates(customIdValue, baseAssetId(symbolPrefix, figures.p4)),");
    expect(flow).toContain("customIdTaken,");
    expect(flow).toContain('profile?.status === "archived"');
  });

  it("lock at 0 reuses the lock_supply sender (simulation-gated app sender) and the dialog states the record stays", () => {
    const button = src("components/lock-supply-button.tsx");
    expect(button).toContain("export function useLockSupply()");
    expect(button).toContain("getLockSupplyInstructionAsync({");
    expect(button).toContain("tx.send({ instructions: [ix], feePayer: signer })");
    const dialog = src("components/archive-dialog.tsx");
    expect(dialog).toContain("useLockSupply()");
    expect(dialog).toContain("ARCHIVE_PERMANENCE_NOTE");
    expect(dialog).toContain("Also lock supply at 0 (one-way)");
  });
});
