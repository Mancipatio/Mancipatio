// Investor relations (0090) through the real routes of /api/issuer-updates
// and the issuer-update branch of /api/storage/upload: an issuer's authority
// writes for its own issuer only (and only while KYB Verified on chain, with
// its own assets); readers never receive drafts, withdrawn updates or, unless
// the chain shows them holding units, holders-only content (fail closed on
// RPC trouble, nothing without a signature); attachments reuse the server's
// verified document versions in the private bucket; the anchor is the memo
// the server computes itself, verified on the finalized transaction.
// SIWS, the issuer-authority and admin checks, the registry accounts, the
// token balances and the RPC are mocked; Supabase is in memory.
import { getAddressDecoder } from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { memorySupabase } from "./helpers/memory-supabase";
import { buildTx, type Ix } from "./helpers/chain-tx";

vi.mock("server-only", () => ({}));

type Memory = ReturnType<typeof import("./helpers/memory-supabase").memorySupabase>;
const h = vi.hoisted(() => ({
  db: null as Memory | null,
  touched: [] as string[],
  signedUrls: [] as string[],
  uploadUrls: [] as string[],
  wallet: "",
  params: {} as Record<string, unknown>,
  actions: [] as string[],
  unsigned: false,
  rpcDown: false,
  /** issuer PDA → its authority wallet */
  authorities: new Map<string, string>(),
  /** issuer PDA → KybStatus */
  kyb: new Map<string, number>(),
  /** asset PDA → issuer PDA (each fixture asset has one share class whose mint is mint:<asset>) */
  assets: new Map<string, string>(),
  /** wallet → mint → base units */
  balances: new Map<string, Map<string, bigint>>(),
  admins: new Set<string>(),
  txs: { finalized: new Map<string, unknown>(), confirmed: new Map<string, unknown>() },
}));

vi.mock("@/lib/network", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/network")>()),
  detectNetwork: () => "devnet",
}));
vi.mock("@/lib/supabase-server", () => ({
  getSupabaseAdmin: () => ({
    from: (table: string) => { h.touched.push(table); return (h.db!.client.from as (t: string) => unknown)(table); },
    rpc: (...args: unknown[]) => (h.db!.client.rpc as (...a: unknown[]) => unknown)(...args),
    storage: {
      from: (bucket: string) => ({
        createSignedUrl: async (path: string, ttl: number) => {
          h.signedUrls.push(`${bucket}/${path}`);
          return { data: { signedUrl: `https://storage.test/${bucket}/${path}?ttl=${ttl}` }, error: null };
        },
        createSignedUploadUrl: async (path: string) => {
          h.uploadUrls.push(`${bucket}/${path}`);
          return { data: { token: "upload-token" }, error: null };
        },
      }),
    },
  }),
}));
vi.mock("@/lib/server/siws", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/server/siws")>();
  return {
    ...real,
    verifySigned: vi.fn(async (_request: Request, action: string) => {
      if (h.unsigned) throw new real.SiwsError(401, "Missing signature");
      h.actions.push(action);
      return { wallet: h.wallet, params: h.params, via: "signature" };
    }),
  };
});
vi.mock("@/lib/server/profile-read", async (importOriginal) => {
  const { SiwsError } = await import("@/lib/server/siws-error");
  return {
    ...(await importOriginal<typeof import("@/lib/server/profile-read")>()),
    requireProfileOwner: vi.fn(async (wallet: string, pda: string, kind: string) => {
      if (h.rpcDown) throw new SiwsError(503, "Profile authorization unavailable — try again");
      if (kind !== "issuer" || h.authorities.get(pda) !== wallet) throw new SiwsError(403, "Profile access denied");
    }),
    isProfileAdmin: vi.fn(async (wallet: string) => h.admins.has(wallet)),
  };
});
vi.mock("@/lib/server/admin-gate", async () => {
  const { SiwsError } = await import("@/lib/server/siws-error");
  const gate = async (wallet: string) => { if (!h.admins.has(wallet)) throw new SiwsError(403, "Admin privileges required"); };
  return { requireAdmin: vi.fn(gate), requireSuperAdmin: vi.fn(gate) };
});
vi.mock("@/lib/server/rpc", () => ({
  getServerRpc: () => ({
    getTransaction: (signature: string, config: { commitment: "finalized" | "confirmed" }) => ({
      send: async () => h.txs[config.commitment].get(signature) ?? null,
    }),
  }),
}));
vi.mock("@/lib/pdas", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/pdas")>()),
  findShareClassPda: vi.fn(async (asset: string, index: number) => `${asset}#${index}`),
}));
vi.mock("@/lib/server/token-holdings", async (importOriginal) => {
  const { SiwsError } = await import("@/lib/server/siws-error");
  return {
    ...(await importOriginal<typeof import("@/lib/server/token-holdings")>()),
    getToken2022Balances: vi.fn(async (owner: string) => {
      if (h.rpcDown) throw new SiwsError(503, "On-chain balance check unavailable — try again");
      return h.balances.get(owner) ?? new Map();
    }),
  };
});
vi.mock("@/lib/generated/asset_registry", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/generated/asset_registry")>();
  const down = () => { if (h.rpcDown) throw new Error("rpc down"); };
  const account = (address: string, data: Record<string, unknown>) =>
    ({ exists: true, address, programAddress: original.ASSET_REGISTRY_PROGRAM_ADDRESS, data });
  return {
    ...original,
    fetchMaybeIssuer: vi.fn(async (_rpc: unknown, address: string) => {
      down();
      return h.kyb.has(address)
        ? account(address, { discriminator: original.getIssuerDiscriminatorBytes(), kybStatus: h.kyb.get(address), authority: h.authorities.get(address) })
        : { exists: false, address };
    }),
    fetchMaybeAsset: vi.fn(async (_rpc: unknown, address: string) => {
      down();
      const issuer = h.assets.get(address);
      // The fixture's assetId is the asset's own address (findAssetPda below derives it back).
      return issuer
        ? account(address, { discriminator: original.getAssetDiscriminatorBytes(), issuer, assetId: address, shareClassesCount: 1 })
        : { exists: false, address };
    }),
    findAssetPda: vi.fn(async ({ assetId }: { assetId: string }) => [assetId, 255]),
    fetchAllMaybeShareClass: vi.fn(async (_rpc: unknown, addresses: string[]) => {
      down();
      return addresses.map((address) => {
        const asset = address.split("#")[0];
        return h.assets.has(asset)
          ? account(address, { discriminator: original.getShareClassDiscriminatorBytes(), asset, mint: `mint:${asset}`, mintInitialized: true })
          : { exists: false, address };
      });
    }),
  };
});

import { POST as saveRoute } from "@/app/api/issuer-updates/save/route";
import { POST as publishRoute } from "@/app/api/issuer-updates/publish/route";
import { POST as discardRoute } from "@/app/api/issuer-updates/discard/route";
import { POST as attachRoute } from "@/app/api/issuer-updates/attach/route";
import { POST as detachRoute } from "@/app/api/issuer-updates/detach/route";
import { POST as withdrawRoute } from "@/app/api/issuer-updates/withdraw/route";
import { POST as mineRoute } from "@/app/api/issuer-updates/mine/route";
import { POST as adminListRoute } from "@/app/api/issuer-updates/admin-list/route";
import { POST as holderRoute } from "@/app/api/issuer-updates/holder/route";
import { POST as documentUrlRoute } from "@/app/api/issuer-updates/document-url/route";
import { POST as anchorRoute } from "@/app/api/issuer-updates/anchor/route";
import { GET as publicRoute } from "@/app/api/issuer-updates/public/route";
import { GET as documentRoute } from "@/app/api/issuer-updates/document/route";
import { POST as uploadRoute } from "@/app/api/storage/upload/route";
import { issuerUpdateDigest, type IssuerUpdateDocumentRow, type IssuerUpdateRow } from "@/lib/server/issuer-updates";
import { isSessionReadAction } from "@/lib/siws-session";
import { refusedInMaintenance } from "@/lib/maintenance";
import { DOCUMENT_ANCHOR_NOT_YET, DOCUMENT_ANCHOR_REFERENCE_PATTERN } from "@/lib/document-anchor";
import { documentDestination } from "@/lib/document-integrity";
import {
  issuerUpdateAnchorReference,
  issuerUpdateRecordText,
  issuerUpdateUploadPath,
  parseDocumentFileName,
  parseIssuerUpdateDraft,
  parseWithdrawReason,
} from "@/lib/issuer-updates";

const key = (seed: number) => getAddressDecoder().decode(new Uint8Array(32).fill(seed)).toString();
const ISSUER_A = key(31);
const AUTH_A = key(32);
const ISSUER_B = key(33);
const AUTH_B = key(34);
const ISSUER_C = key(35);
const AUTH_C = key(36);
const ASSET_A = key(37);
const ASSET_A2 = key(38);
const ASSET_B = key(39);
const ADMIN = key(40);
const HOLDER = key(41);
const STRANGER = key(42);
const NOW = "2026-11-08T10:00:00.123456+00:00";
const SHA = "a".repeat(64);
const UPDATES = "issuer_updates";
const DOCS = "issuer_update_documents";
const VERIFIED = 1;
const PENDING = 0;

type Route = (request: Request) => Promise<Response>;

async function call(route: Route, wallet: string, params: Record<string, unknown>) {
  h.wallet = wallet;
  h.params = params;
  const res = await route(new Request("https://manci.test/api/issuer-updates", { method: "POST", body: "{}" }));
  return { status: res.status, body: (await res.json()) as { ok: boolean; error?: string; data?: Record<string, unknown> } };
}
async function get(route: Route, query: string) {
  return route(new Request(`https://manci.test/api/issuer-updates?${query}`));
}

function row(over: Partial<IssuerUpdateRow> = {}): IssuerUpdateRow {
  return {
    network: "devnet", id: crypto.randomUUID(), issuer_pda: ISSUER_A, asset_pda: ASSET_A, kind: "update",
    title: "Second plant opened", body: "We opened the second plant in Novi Sad.", period_label: null, visibility: "public",
    status: "published", published_at: NOW, published_by: AUTH_A, withdrawn_at: null, withdrawn_by: null,
    withdrawn_by_role: null, withdrawn_reason: null, anchor_tx: null, created_by: AUTH_A, updated_by: AUTH_A,
    created_at: NOW, updated_at: NOW, ...over,
  };
}
function doc(update: IssuerUpdateRow, over: Partial<IssuerUpdateDocumentRow> = {}): IssuerUpdateDocumentRow & { network: string } {
  return {
    network: "devnet", id: crypto.randomUUID(), update_id: update.id, file_name: "Q3 report.pdf",
    storage_path: `issuer-updates/${update.issuer_pda}/devnet/${SHA}/Q3_report.pdf`, sha256: SHA, size_bytes: 1000,
    content_type: "application/pdf", created_at: NOW, ...over,
  };
}
const put = (...rows: IssuerUpdateRow[]) => { h.db!.rows(UPDATES).push(...rows); return rows; };
const putDoc = (...docs: Array<ReturnType<typeof doc>>) => { h.db!.rows(DOCS).push(...docs); return docs; };
const stored = (id: string) => h.db!.rows(UPDATES).find((r) => r.id === id) as IssuerUpdateRow | undefined;
const draftInput = (over: Record<string, unknown> = {}) => ({
  asset_pda: ASSET_A, kind: "update", title: "Q3 progress", body: "Revenue grew.\n\nThe plant opened.", period_label: null, visibility: "public", ...over,
});
const hold = (wallet: string, asset: string, amount = BigInt(5)) => {
  const mints = h.balances.get(wallet) ?? new Map<string, bigint>();
  mints.set(`mint:${asset}`, amount);
  h.balances.set(wallet, mints);
};

beforeEach(() => {
  vi.clearAllMocks();
  h.db = memorySupabase();
  h.db.ordered = true;
  h.db.uniqueIds.add(UPDATES);
  h.db.defaults[UPDATES] = () => ({
    id: crypto.randomUUID(), created_at: NOW, updated_at: NOW, published_at: null, published_by: null, withdrawn_at: null,
    withdrawn_by: null, withdrawn_by_role: null, withdrawn_reason: null, anchor_tx: null,
  });
  h.db.defaults[DOCS] = () => ({ id: crypto.randomUUID(), created_at: NOW });
  h.touched.length = 0;
  h.signedUrls.length = 0;
  h.uploadUrls.length = 0;
  h.actions.length = 0;
  h.unsigned = false;
  h.rpcDown = false;
  h.authorities = new Map([[ISSUER_A, AUTH_A], [ISSUER_B, AUTH_B], [ISSUER_C, AUTH_C]]);
  h.kyb = new Map([[ISSUER_A, VERIFIED], [ISSUER_B, VERIFIED], [ISSUER_C, PENDING]]);
  h.assets = new Map([[ASSET_A, ISSUER_A], [ASSET_A2, ISSUER_A], [ASSET_B, ISSUER_B]]);
  h.balances = new Map();
  h.admins = new Set([ADMIN]);
  h.txs = { finalized: new Map(), confirmed: new Map() };
});

describe("an issuer writes for its own issuer only", () => {
  it("creates a private draft for its issuer; network, status and authors are the server's", async () => {
    const res = await call(saveRoute, AUTH_A, { issuer: ISSUER_A, update: draftInput() });
    expect(res.status).toBe(200);
    expect(h.actions).toEqual(["issuerUpdates.save"]);
    const [saved] = h.db!.rows(UPDATES) as IssuerUpdateRow[];
    expect(saved).toMatchObject({ network: "devnet", issuer_pda: ISSUER_A, asset_pda: ASSET_A, status: "draft", created_by: AUTH_A, updated_by: AUTH_A });
    expect(res.body.data?.update).toMatchObject({ id: saved.id, status: "draft", anchor: null });
  });

  it("refuses issuer A's authority writing for issuer B, naming B's asset, or an unverified issuer — and writes nothing", async () => {
    expect((await call(saveRoute, AUTH_A, { issuer: ISSUER_B, update: draftInput({ asset_pda: ASSET_B }) })).status).toBe(403);
    const foreignAsset = await call(saveRoute, AUTH_A, { issuer: ISSUER_A, update: draftInput({ asset_pda: ASSET_B }) });
    expect(foreignAsset).toMatchObject({ status: 400, body: { error: "This asset is not one of the issuer's assets" } });
    const unverified = await call(saveRoute, AUTH_C, { issuer: ISSUER_C, update: draftInput({ asset_pda: null }) });
    expect(unverified.status).toBe(403);
    expect(unverified.body.error).toMatch(/verified issuer/);
    expect(h.db!.rows(UPDATES)).toEqual([]);
  });

  it("never lets another issuer's authority edit, publish, discard, attach to, detach from or withdraw an update", async () => {
    const [draft] = put(row({ status: "draft", published_at: null, published_by: null }));
    const [published] = put(row());
    const [file] = putDoc(doc(draft));
    const editAsB = await call(saveRoute, AUTH_B, { issuer: ISSUER_B, id: draft.id, expected_updated_at: NOW, update: draftInput({ asset_pda: ASSET_B }) });
    expect(editAsB.status).toBe(409); // its own issuer matches no row of A's
    expect((await call(saveRoute, AUTH_B, { issuer: ISSUER_A, id: draft.id, expected_updated_at: NOW, update: draftInput() })).status).toBe(403);
    expect((await call(publishRoute, AUTH_B, { id: draft.id, expected_updated_at: NOW })).status).toBe(403);
    expect((await call(discardRoute, AUTH_B, { id: draft.id, expected_updated_at: NOW })).status).toBe(403);
    expect((await call(attachRoute, AUTH_B, { id: draft.id, path: file.storage_path, sha256: SHA, file_name: "x.pdf" })).status).toBe(403);
    expect((await call(detachRoute, AUTH_B, { id: file.id })).status).toBe(403);
    expect((await call(withdrawRoute, AUTH_B, { id: published.id, reason: "Not my update but I want it gone" })).status).toBe(403);
    expect(stored(draft.id)).toMatchObject({ status: "draft", title: draft.title });
    expect(stored(published.id)?.status).toBe("published");
    expect(h.db!.rows(DOCS)).toHaveLength(1);
  });

  it("edits a draft by compare-and-swap, publishes it, and refuses to publish it twice", async () => {
    const [draft] = put(row({ status: "draft", published_at: null, published_by: null }));
    expect((await call(saveRoute, AUTH_A, { issuer: ISSUER_A, id: draft.id, expected_updated_at: "2026-11-08T09:00:00Z", update: draftInput() })).status).toBe(409);
    const edited = await call(saveRoute, AUTH_A, { issuer: ISSUER_A, id: draft.id, expected_updated_at: NOW, update: draftInput({ title: "Revised" }) });
    expect(edited.status).toBe(200);
    expect(stored(draft.id)?.title).toBe("Revised");
    expect((await call(publishRoute, AUTH_A, { id: draft.id, expected_updated_at: "2026-11-08T09:00:00Z" })).status).toBe(409);
    expect((await call(publishRoute, AUTH_A, { id: draft.id, expected_updated_at: NOW })).status).toBe(200);
    expect(stored(draft.id)).toMatchObject({ status: "published", published_by: AUTH_A });
    expect((await call(publishRoute, AUTH_A, { id: draft.id, expected_updated_at: NOW })).status).toBe(409);
    expect((await call(saveRoute, AUTH_A, { issuer: ISSUER_A, id: draft.id, expected_updated_at: NOW, update: draftInput() })).status).toBe(409);
    expect((await call(discardRoute, AUTH_A, { id: draft.id, expected_updated_at: NOW })).status).toBe(409);
  });

  it("caps open drafts per issuer", async () => {
    put(...Array.from({ length: 50 }, () => row({ status: "draft", published_at: null, published_by: null })));
    const res = await call(saveRoute, AUTH_A, { issuer: ISSUER_A, update: draftInput() });
    expect(res.status).toBe(409);
    expect(h.db!.rows(UPDATES)).toHaveLength(50);
  });

  it("withdraws: the issuer as issuer, an admin as moderation (with an audit row); never a draft, never twice", async () => {
    const [mine, moderated] = put(row(), row());
    const [draft] = put(row({ status: "draft", published_at: null, published_by: null }));
    expect((await call(withdrawRoute, AUTH_A, { id: mine.id, reason: "short" })).status).toBe(400);
    expect((await call(withdrawRoute, AUTH_A, { id: mine.id, reason: "Posted by mistake" })).status).toBe(200);
    expect(stored(mine.id)).toMatchObject({ status: "withdrawn", withdrawn_by: AUTH_A, withdrawn_by_role: "issuer", withdrawn_reason: "Posted by mistake" });
    expect(h.db!.rows("audit_events")).toEqual([]);
    expect((await call(withdrawRoute, ADMIN, { id: moderated.id, reason: "Promises returns to holders" })).status).toBe(200);
    expect(stored(moderated.id)).toMatchObject({ status: "withdrawn", withdrawn_by: ADMIN, withdrawn_by_role: "admin" });
    expect(h.db!.rows("audit_events")).toMatchObject([{ ix_name: "issuer_update_withdraw", category: "issuers", actor_wallet: ADMIN, target_label: `issuer-update:${moderated.id}` }]);
    expect((await call(withdrawRoute, ADMIN, { id: moderated.id, reason: "Promises returns to holders" })).status).toBe(409);
    expect((await call(withdrawRoute, AUTH_A, { id: draft.id, reason: "Drafts are discarded instead" })).status).toBe(409);
  });

  it("lists an issuer's own updates to its authority only, with the memo to anchor; the moderation list to admins only", async () => {
    const [published, draft] = put(row(), row({ status: "draft", published_at: null, published_by: null }));
    put(row({ issuer_pda: ISSUER_B, asset_pda: ASSET_B, published_by: AUTH_B, created_by: AUTH_B, updated_by: AUTH_B }));
    expect((await call(mineRoute, AUTH_B, { issuer: ISSUER_A })).status).toBe(403);
    const mine = await call(mineRoute, AUTH_A, { issuer: ISSUER_A });
    const updates = mine.body.data?.updates as Array<{ id: string; anchor: { reference: string; sha256: string } | null }>;
    expect(updates.map((u) => u.id).sort()).toEqual([published.id, draft.id].sort());
    expect(updates.find((u) => u.id === published.id)?.anchor).toEqual({
      reference: `manci-update:${published.id}`, sha256: issuerUpdateDigest(published, []),
    });
    expect(updates.find((u) => u.id === draft.id)?.anchor).toBeNull();
    expect((await call(adminListRoute, AUTH_A, {})).status).toBe(403);
    const admin = await call(adminListRoute, ADMIN, { status: "all" });
    expect((admin.body.data?.updates as unknown[]).length).toBe(2); // the two published, never the draft
  });
});

describe("readers never receive drafts, withdrawn updates or holders-only content they do not hold", () => {
  function world() {
    const assetPublic = row({ title: "Asset news" });
    const issuerWide = row({ asset_pda: null, title: "Issuer-wide news" });
    const holdersOnly = row({ visibility: "holders", title: "Holders letter" });
    const issuerWideHolders = row({ asset_pda: null, visibility: "holders", title: "Holders AGM notice", kind: "notice" });
    const draft = row({ status: "draft", published_at: null, published_by: null, title: "Draft" });
    const withdrawn = row({ status: "withdrawn", withdrawn_at: NOW, withdrawn_by: ADMIN, withdrawn_by_role: "admin", withdrawn_reason: "Misleading claim", title: "Withdrawn" });
    const otherAsset = row({ asset_pda: ASSET_A2, title: "Other asset news" });
    const otherIssuerHolders = row({ issuer_pda: ISSUER_B, asset_pda: ASSET_B, visibility: "holders", title: "B holders letter" });
    put(assetPublic, issuerWide, holdersOnly, issuerWideHolders, draft, withdrawn, otherAsset, otherIssuerHolders);
    const files = {
      public: doc(assetPublic), holders: doc(holdersOnly), issuerWideHolders: doc(issuerWideHolders),
      draft: doc(draft), withdrawn: doc(withdrawn), otherIssuer: doc(otherIssuerHolders),
    };
    putDoc(...Object.values(files));
    return { assetPublic, issuerWide, holdersOnly, issuerWideHolders, draft, withdrawn, otherAsset, otherIssuerHolders, files };
  }

  it("the public list: published public updates of the asset and the issuer-wide ones, a count of holders-only, nothing private", async () => {
    const w = world();
    const res = await get(publicRoute, `issuer=${ISSUER_A}&asset=${ASSET_A}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { updates, holders_only } = (await res.json()).data as { updates: Array<Record<string, unknown>>; holders_only: number };
    expect(updates.map((u) => u.title).sort()).toEqual(["Asset news", "Issuer-wide news"]);
    expect(holders_only).toBe(2);
    for (const update of updates) {
      expect(Object.keys(update).sort()).toEqual(["anchor_tx", "asset_pda", "body", "documents", "id", "issuer_pda", "kind", "period_label", "published_at", "title", "visibility"]);
    }
    const documents = updates.find((u) => u.id === w.assetPublic.id)?.documents as Array<Record<string, unknown>>;
    expect(documents).toEqual([{ id: w.files.public.id, file_name: "Q3 report.pdf", sha256: SHA, size_bytes: 1000, content_type: "application/pdf" }]);
    expect(JSON.stringify(updates)).not.toMatch(/Holders letter|Draft|Withdrawn|Misleading|storage_path|issuer-updates\//);
  });

  it("the open document link serves a published public update's file only (404 otherwise, nothing signed)", async () => {
    const w = world();
    const ok = await get(documentRoute, `id=${w.files.public.id}`);
    expect(ok.status).toBe(302);
    expect(ok.headers.get("location")).toBe(`https://storage.test/documents-confidential/${w.files.public.storage_path}?ttl=120`);
    for (const file of [w.files.holders, w.files.draft, w.files.withdrawn, w.files.issuerWideHolders]) {
      expect((await get(documentRoute, `id=${file.id}`)).status).toBe(404);
    }
    expect((await get(documentRoute, `id=${crypto.randomUUID()}`)).status).toBe(404);
    expect(h.signedUrls).toEqual([`documents-confidential/${w.files.public.storage_path}`]);
  });

  it("the holder read: a wallet without units gets nothing; a holder gets its asset's and issuer-wide updates, never drafts, withdrawn or another issuer's", async () => {
    world();
    const stranger = await call(holderRoute, STRANGER, { assets: [ASSET_A] });
    expect(stranger.status).toBe(200);
    expect(stranger.body.data).toEqual({ holder_assets: [], updates: [] });

    hold(HOLDER, ASSET_A);
    const holder = await call(holderRoute, HOLDER, { assets: [ASSET_A, ASSET_B] });
    expect(holder.body.data?.holder_assets).toEqual([ASSET_A]);
    const updates = holder.body.data?.updates as Array<{ title: string; via_asset: string }>;
    expect(updates.map((u) => u.title).sort()).toEqual(["Asset news", "Holders AGM notice", "Holders letter", "Issuer-wide news"]);
    expect(updates.every((u) => u.via_asset === ASSET_A)).toBe(true);
    expect(JSON.stringify(updates)).not.toMatch(/B holders letter|"Draft"|Withdrawn|Other asset news/);
    expect(h.actions).toEqual(["issuerUpdates.holderRead", "issuerUpdates.holderRead"]);
  });

  it("a zero balance, an asset that is not the registry's, or an empty claim proves no holding", async () => {
    world();
    hold(HOLDER, ASSET_A, BigInt(0));
    expect((await call(holderRoute, HOLDER, { assets: [ASSET_A] })).body.data?.holder_assets).toEqual([]);
    hold(HOLDER, ASSET_A);
    h.assets.delete(ASSET_A); // no longer a registry asset at that address
    expect((await call(holderRoute, HOLDER, { assets: [ASSET_A] })).body.data).toEqual({ holder_assets: [], updates: [] });
    expect((await call(holderRoute, HOLDER, { assets: [] })).status).toBe(400);
    expect((await call(holderRoute, HOLDER, { assets: Array.from({ length: 21 }, (_, i) => key(100 + i)) })).status).toBe(400);
  });

  it("fails closed: an RPC failure answers 503 with no content, and nothing is read without a signature", async () => {
    world();
    hold(HOLDER, ASSET_A);
    h.rpcDown = true;
    const down = await call(holderRoute, HOLDER, { assets: [ASSET_A] });
    expect(down.status).toBe(503);
    expect(down.body.data).toBeUndefined();
    h.rpcDown = false;
    h.unsigned = true;
    h.touched.length = 0;
    for (const route of [holderRoute, documentUrlRoute, mineRoute, adminListRoute]) {
      const res = await call(route, HOLDER, { assets: [ASSET_A], id: crypto.randomUUID(), issuer: ISSUER_A });
      expect(res.status).toBe(401);
    }
    expect(h.touched).toEqual([]);
  });

  it("a document link is signed for holders of the update's asset, the issuer and admins — never for a stranger", async () => {
    const w = world();
    const open = (wallet: string, id: string, asset?: string) => call(documentUrlRoute, wallet, { id, ...(asset ? { asset } : {}) });
    expect((await open(STRANGER, w.files.public.id)).status).toBe(200);
    expect((await open(STRANGER, w.files.holders.id)).status).toBe(403);
    hold(HOLDER, ASSET_A);
    expect((await open(HOLDER, w.files.holders.id)).body.data?.url).toBe(`https://storage.test/documents-confidential/${w.files.holders.storage_path}?ttl=120`);
    // Issuer-wide: the held asset must be named, and be the issuer's own.
    expect((await open(HOLDER, w.files.issuerWideHolders.id)).status).toBe(403);
    expect((await open(HOLDER, w.files.issuerWideHolders.id, ASSET_A)).status).toBe(200);
    hold(HOLDER, ASSET_B);
    expect((await open(HOLDER, w.files.issuerWideHolders.id, ASSET_B)).status).toBe(403);
    // Withdrawn and draft files: their issuer and the admins only.
    for (const file of [w.files.withdrawn, w.files.draft]) {
      expect((await open(HOLDER, file.id, ASSET_A)).status).toBe(403);
      expect((await open(AUTH_A, file.id)).status).toBe(200);
      expect((await open(ADMIN, file.id)).status).toBe(200);
      expect((await open(AUTH_B, file.id)).status).toBe(403);
    }
    expect((await open(STRANGER, w.files.otherIssuer.id, ASSET_B)).status).toBe(403);
  });

  it("the reads are session reads; every write needs a fresh signature (and stops in maintenance)", () => {
    for (const action of ["holderRead", "documentUrl", "mine", "adminList", "anchor"]) {
      expect(isSessionReadAction(`issuerUpdates.${action}`), action).toBe(true);
    }
    for (const action of ["save", "publish", "discard", "attach", "detach", "withdraw"]) {
      expect(isSessionReadAction(`issuerUpdates.${action}`), action).toBe(false);
      expect(refusedInMaintenance(`issuerUpdates.${action}`), action).toBe(true);
    }
  });
});

describe("documents reuse the server's verified versions", () => {
  const draftWithVersion = (path = `issuer-updates/${ISSUER_A}/devnet/${SHA}/Q3_report.pdf`, bucket = "documents-confidential") => {
    const [draft] = put(row({ status: "draft", published_at: null, published_by: null }));
    const version = { id: crypto.randomUUID(), network: "devnet", bucket, path, sha256: SHA, size_bytes: 4321, mime_type: "application/pdf", verified_by: AUTH_A, verified_at: NOW };
    h.db!.rows("document_versions").push(version);
    return { draft, version };
  };

  it("attaches a verified version under the issuer's prefix, copying its hash, size and type (never the caller's)", async () => {
    const { draft, version } = draftWithVersion();
    const res = await call(attachRoute, AUTH_A, { id: draft.id, path: version.path, sha256: SHA, file_name: "Q3 report (final).pdf" });
    expect(res.status).toBe(200);
    expect(h.db!.rows(DOCS)).toMatchObject([{
      network: "devnet", update_id: draft.id, version_id: version.id, file_name: "Q3 report (final).pdf",
      storage_path: version.path, sha256: SHA, size_bytes: 4321, content_type: "application/pdf", created_by: AUTH_A,
    }]);
    expect((res.body.data?.update as { documents: unknown[] }).documents).toHaveLength(1);
    expect((await call(attachRoute, AUTH_A, { id: draft.id, path: version.path, sha256: SHA, file_name: "again.pdf" })).status).toBe(409);
  });

  it("refuses an unverified file, another hash, the public bucket, another issuer's or network's prefix, and published updates", async () => {
    const { draft, version } = draftWithVersion();
    const attach = (params: Record<string, unknown>) => call(attachRoute, AUTH_A, { id: draft.id, file_name: "x.pdf", ...params });
    expect((await attach({ path: version.path, sha256: "b".repeat(64) })).status).toBe(409);
    expect((await attach({ path: `issuer-updates/${ISSUER_A}/devnet/${"c".repeat(64)}/unverified.pdf`, sha256: "c".repeat(64) })).status).toBe(409);
    expect((await attach({ path: `issuer-updates/${ISSUER_B}/devnet/${SHA}/b.pdf`, sha256: SHA })).status).toBe(400);
    expect((await attach({ path: `issuer-updates/${ISSUER_A}/mainnet/${SHA}/m.pdf`, sha256: SHA })).status).toBe(400);
    expect((await attach({ path: `whitepapers/${ASSET_A}/devnet/${SHA}/w.pdf`, sha256: SHA })).status).toBe(400);
    expect((await attach({ path: version.path, sha256: SHA, file_name: "a/b.pdf" })).status).toBe(400);
    const publicCopy = draftWithVersion(`issuer-updates/${ISSUER_A}/devnet/${SHA}/public.pdf`, "documents");
    expect((await call(attachRoute, AUTH_A, { id: publicCopy.draft.id, path: publicCopy.version.path, sha256: SHA, file_name: "p.pdf" })).status).toBe(409);
    const [published] = put(row());
    expect((await call(attachRoute, AUTH_A, { id: published.id, path: version.path, sha256: SHA, file_name: "late.pdf" })).status).toBe(409);
    expect(h.db!.rows(DOCS)).toEqual([]);
  });

  it("detaches from a draft only", async () => {
    const [draft, published] = put(row({ status: "draft", published_at: null, published_by: null }), row());
    const [draftFile, publishedFile] = putDoc(doc(draft), doc(published));
    expect((await call(detachRoute, AUTH_A, { id: publishedFile.id })).status).toBe(409);
    expect((await call(detachRoute, AUTH_A, { id: draftFile.id })).status).toBe(200);
    expect(h.db!.rows(DOCS).map((d) => d.id)).toEqual([publishedFile.id]);
  });

  it("uploads go to the private bucket at a content-addressed path, authorized for the issuer's own authority only", async () => {
    const params = { bucket: "documents", path: issuerUpdateUploadPath(ISSUER_A, SHA, "Q3 report (final).pdf"), sha256: SHA, contentType: "application/pdf", size: 1000 };
    for (const wallet of [ADMIN, AUTH_B]) expect((await call(uploadRoute, wallet, params)).status).toBe(403);
    expect(h.db!.rows("document_uploads")).toEqual([]);
    expect((await call(uploadRoute, AUTH_A, params)).status).toBe(200);
    expect(h.db!.rows("document_uploads")).toMatchObject([{ bucket: "documents-confidential", path: `issuer-updates/${ISSUER_A}/devnet/${SHA}/Q3_report_final_.pdf`, wallet: AUTH_A }]);
    expect(documentDestination(`issuer-updates/${ISSUER_A}/${SHA.slice(0, 8)}-a.pdf`, SHA, "mainnet")).toBe(`issuer-updates/${ISSUER_A}/mainnet/${SHA}/a.pdf`);
    expect(documentDestination(`issuer-updates/${ISSUER_A}/${SHA.slice(0, 8)}-`, SHA, "devnet")).toBe(`issuer-updates/${ISSUER_A}/devnet/${SHA}/document`);
    for (const bad of [`issuer-updates/not-an-address/a.pdf`, `issuer-updates/${ISSUER_A}/x/y.pdf`, `issuer-updates/${ISSUER_A}`]) {
      expect(() => documentDestination(bad, SHA, "devnet"), bad).toThrow();
    }
  });
});

describe("validation", () => {
  it("parses a draft field by field: kinds, visibility, a report's period, lengths, control characters, the asset", () => {
    expect(parseIssuerUpdateDraft(draftInput({ title: "  Q3  ", body: "a\r\nb  " }))).toMatchObject({ title: "Q3", body: "a\nb" });
    expect(parseIssuerUpdateDraft(draftInput({ asset_pda: "", period_label: "" }))).toMatchObject({ asset_pda: null, period_label: null });
    const refused: Array<[Record<string, unknown>, RegExp]> = [
      [{ kind: "memo" }, /kind/], [{ visibility: "private" }, /who can read/], [{ title: "" }, /title/i],
      [{ title: "x".repeat(181) }, /180/], [{ title: "a\nb" }, /single line/], [{ body: " " }, /text/i],
      [{ body: "x".repeat(20_001) }, /20,000/], [{ body: "bad\u0007bell" }, /control/], [{ kind: "quarterly_report" }, /period/],
      [{ kind: "annual_report", period_label: "x".repeat(41) }, /40/], [{ asset_pda: "not-an-address" }, /asset/], [{ status: "published" }, /Unknown/],
    ];
    for (const [over, error] of refused) expect(() => parseIssuerUpdateDraft(draftInput(over)), JSON.stringify(over)).toThrow(error);
    expect(parseIssuerUpdateDraft(draftInput({ kind: "financial_statement", period_label: "FY 2025" })).kind).toBe("financial_statement");
    expect(() => parseWithdrawReason("too short")).toThrow(/10/);
    expect(() => parseWithdrawReason("x".repeat(501))).toThrow(/500/);
    expect(parseWithdrawReason("  Posted by mistake  ")).toBe("Posted by mistake");
    expect(() => parseDocumentFileName("a\\b.pdf")).toThrow();
    expect(parseDocumentFileName(" Report.pdf ")).toBe("Report.pdf");
  });

  it("refuses an invalid kind or visibility at the route and writes nothing", async () => {
    for (const over of [{ kind: "memo" }, { visibility: "everyone" }, { kind: "quarterly_report" }]) {
      expect((await call(saveRoute, AUTH_A, { issuer: ISSUER_A, update: draftInput(over) })).status, JSON.stringify(over)).toBe(400);
    }
    expect(h.db!.rows(UPDATES)).toEqual([]);
  });

  it("builds one canonical record per update, whatever the document order; the reference is a valid anchor reference", () => {
    const update = row();
    const a = doc(update, { sha256: "1".repeat(64), file_name: "a.pdf" });
    const b = doc(update, { sha256: "2".repeat(64), file_name: "b.pdf" });
    const text = issuerUpdateRecordText({ ...update, published_at: update.published_at!, documents: [b, a] });
    expect(text).toBe(issuerUpdateRecordText({ ...update, published_at: "2026-11-08T10:00:00.123Z", documents: [a, b] }));
    expect(JSON.parse(text)).toMatchObject({ v: 1, record: "manci-issuer-update", network: "devnet", published_at: "2026-11-08T10:00:00.123Z" });
    expect(JSON.parse(text).documents.map((d: { name: string }) => d.name)).toEqual(["a.pdf", "b.pdf"]);
    expect(issuerUpdateRecordText({ ...update, title: "Changed", published_at: update.published_at!, documents: [a, b] })).not.toBe(text);
    expect(DOCUMENT_ANCHOR_REFERENCE_PATTERN.test(issuerUpdateAnchorReference(update.id))).toBe(true);
  });
});

describe("the anchor is the server's own memo, verified on the finalized transaction", () => {
  const SIG = "5RBDZNDobPiJGpQsfcvPLuSdzyUXRxBnpXNU4sFQg2ud3sTiSPyWnPrfvyN4myMYTvEUWjtYnGijuryNNrXqeDqm";
  const SIG2 = "3vSXmWYxioJaTwCRytEr7xHDKinyJ35UMYie4mNdMceH8ncu2V3qCQ8VexzhMbLV3KUv1s7jhAdHR8YBdVEV5YUJ";
  const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
  const CB = "ComputeBudget111111111111111111111111111111";
  function chainTx(signature: string, payer: string, memoText: string) {
    const ixs: Ix[] = [
      { program: CB, accounts: [], data: new Uint8Array([2, 0, 0, 0, 0]) },
      { program: MEMO_PROGRAM, accounts: [payer], data: new TextEncoder().encode(memoText) },
    ];
    const { tx } = buildTx({ signature, payer, instructions: ixs.map((ix) => ({ ix })) });
    const { message } = tx.transaction;
    const header = { ...message.header, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: message.accountKeys.length - 1 };
    return { ...tx, transaction: { ...tx.transaction, message: { ...message, header } } };
  }

  it("records the issuer's finalized memo once; refuses another text, another signer, a draft, and waits for finalization", async () => {
    const [update, draft] = put(row(), row({ status: "draft", published_at: null, published_by: null }));
    const files = putDoc(doc(update));
    const memo = `${issuerUpdateAnchorReference(update.id)} sha256:${issuerUpdateDigest(update, files)}`;

    h.txs.confirmed.set(SIG, chainTx(SIG, AUTH_A, memo));
    const early = await call(anchorRoute, AUTH_A, { id: update.id, signature: SIG });
    expect(early.status).toBe(503);
    expect(early.body.error).toMatch(new RegExp(`^${DOCUMENT_ANCHOR_NOT_YET}`));

    h.txs.finalized.set(SIG2, chainTx(SIG2, AUTH_A, `${issuerUpdateAnchorReference(update.id)} sha256:${"f".repeat(64)}`));
    const wrongText = await call(anchorRoute, AUTH_A, { id: update.id, signature: SIG2 });
    expect(wrongText.status).toBe(400);
    expect(wrongText.body.error).toMatch(/memo text is not the expected anchor text/);

    h.txs.finalized.set(SIG2, chainTx(SIG2, AUTH_B, memo));
    h.authorities.set(ISSUER_A, AUTH_A);
    const otherSigner = await call(anchorRoute, AUTH_A, { id: update.id, signature: SIG2 });
    expect(otherSigner.body.error).toMatch(/fee payer is not the issuer authority wallet/);
    expect((await call(anchorRoute, AUTH_B, { id: update.id, signature: SIG2 })).status).toBe(403);
    expect(stored(update.id)?.anchor_tx).toBeNull();

    h.txs.finalized.set(SIG, chainTx(SIG, AUTH_A, memo));
    const recorded = await call(anchorRoute, AUTH_A, { id: update.id, signature: SIG });
    expect(recorded.status).toBe(200);
    expect(recorded.body.data).toMatchObject({ duplicate: false, update: { anchor_tx: SIG, anchor: null } });
    expect(stored(update.id)?.anchor_tx).toBe(SIG);
    expect((await call(anchorRoute, AUTH_A, { id: update.id, signature: SIG })).body.data?.duplicate).toBe(true);
    expect((await call(anchorRoute, AUTH_A, { id: update.id, signature: SIG2 })).status).toBe(409);
    expect((await call(anchorRoute, AUTH_A, { id: draft.id, signature: SIG })).status).toBe(409);
  });
});
