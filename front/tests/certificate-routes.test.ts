// app/api/admin/certificates/*: admin only (on-chain Admin record after the
// SIWS check, before any read; create, sign and anchor the Super Admin's
// alone, Platform.admin), each route on its own signed action (list,
// read, preview, sign and anchor as session actions, create and revoke with
// a fresh signature; sign and anchor still wait out maintenance). Create
// reads the chain, validates everything before it spends a number, and stores
// the canonical payload with its hash; sign stores only the draft signer's
// verified signature of exactly that certificate; anchor takes only an anchor
// the document-anchor route recorded for that number and hash; revoke needs a
// reason. SIWS, the admin gate and the RPC are mocked; Supabase is in memory
// (the lifecycle guard itself: tests/certificates.postgres.test.ts).
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  AssetStatus,
  AssetType,
  ShareClassType,
  getAssetDecoder,
  getAssetEncoder,
  getShareClassEncoder,
} from "@/lib/generated/asset_registry";
import { getBase64Decoder, none, some, type Address } from "@solana/kit";
import { memorySupabase } from "./helpers/memory-supabase";
import {
  ASSET,
  COMPANY,
  EVIDENCE_TX,
  HOLDER,
  ISSUER,
  LEGAL_DOC_HASH,
  MINT,
  SHARE_CLASS,
  certificateSigner,
  fixedAddress,
} from "./helpers/certificate-fixtures";

vi.mock("server-only", () => ({}));
const db = vi.hoisted(() => ({ ref: null as null | ReturnType<typeof import("./helpers/memory-supabase").memorySupabase> }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseAdmin: () => db.ref!.client }));

const state = vi.hoisted(() => ({
  wallet: "",
  params: {} as Record<string, unknown>,
  via: "signature" as "signature" | "session",
  actions: [] as string[],
  admins: new Set<string>(),
  /** Platform.admin: the operator key that creates, signs and anchors. */
  superAdmins: new Set<string>(),
  accounts: new Map<string, { owner: string; data: Uint8Array }>(),
  /** owner → token accounts */
  tokens: new Map<string, Array<{ mint: string; amount: string; decimals: number; program?: string }>>(),
  supply: { amount: "250", decimals: 0 },
  statuses: new Map<string, { slot: bigint; err: unknown; confirmationStatus: string } | null>(),
  rpcCalls: [] as string[],
  rpcFails: false,
  allocations: [] as number[],
}));

vi.mock("@/lib/network", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/network")>()),
  detectNetwork: () => "devnet",
}));
vi.mock("@/lib/server/siws", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/siws")>()),
  verifySigned: vi.fn(async (_req: Request, action: string) => {
    state.actions.push(action);
    return { wallet: state.wallet, params: state.params, via: state.via };
  }),
}));
vi.mock("@/lib/server/admin-gate", async () => {
  const { SiwsError } = await import("@/lib/server/siws-error");
  return {
    requireAdmin: vi.fn(async (wallet: string) => {
      if (!state.admins.has(wallet) && !state.superAdmins.has(wallet)) throw new SiwsError(403, "Admin privileges required");
    }),
    requireSuperAdmin: vi.fn(async (wallet: string) => {
      if (!state.superAdmins.has(wallet)) throw new SiwsError(403, "Super admin privileges required");
    }),
  };
});
vi.mock("@/lib/server/rpc", () => {
  const call = <T>(name: string, answer: () => T) => ({
    send: async () => {
      state.rpcCalls.push(name);
      if (state.rpcFails) throw new Error("rpc down");
      return answer();
    },
  });
  return {
    getServerRpc: () => ({
      getAccountInfo: (address: string) =>
        call("getAccountInfo", () => {
          const account = state.accounts.get(address);
          return {
            context: { slot: BigInt(1) },
            value: account
              ? { data: [getBase64Decoder().decode(account.data), "base64"], executable: false, lamports: BigInt(1), owner: account.owner, space: BigInt(account.data.length), rentEpoch: BigInt(0) }
              : null,
          };
        }),
      getTokenAccountsByOwner: (owner: string, filter: { mint: string }) =>
        call("getTokenAccountsByOwner", () => ({
          context: { slot: BigInt(380_123_456) },
          value: (state.tokens.get(owner) ?? [])
            .filter((t) => t.mint === filter.mint)
            .map((t, i) => ({
              pubkey: fixedAddress(100 + i),
              account: {
                owner: t.program ?? "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
                data: { parsed: { info: { mint: t.mint, owner, tokenAmount: { amount: t.amount, decimals: t.decimals } }, type: "account" } },
              },
            })),
        })),
      getTokenSupply: () =>
        call("getTokenSupply", () => ({ context: { slot: BigInt(380_123_457) }, value: { amount: state.supply.amount, decimals: state.supply.decimals } })),
      getSignatureStatuses: (signatures: string[]) =>
        call("getSignatureStatuses", () => ({ context: { slot: BigInt(1) }, value: signatures.map((s) => state.statuses.get(s) ?? null) })),
    }),
  };
});

import { POST as listRoute } from "@/app/api/admin/certificates/list/route";
import { POST as readRoute } from "@/app/api/admin/certificates/read/route";
import { POST as previewRoute } from "@/app/api/admin/certificates/preview/route";
import { POST as createRoute } from "@/app/api/admin/certificates/create/route";
import { POST as signRoute } from "@/app/api/admin/certificates/sign/route";
import { POST as anchorRoute } from "@/app/api/admin/certificates/anchor/route";
import { POST as revokeRoute } from "@/app/api/admin/certificates/revoke/route";
import { CERTIFICATE_ACTIONS } from "@/lib/certificates/routes";
import { SESSION_READ_ACTIONS } from "@/lib/siws-session";
import { refusedInMaintenance } from "@/lib/maintenance";
import { sha256HexOfText } from "@/lib/certificates/canonical";
import { documentAnchorAuditId } from "@/lib/server/document-anchor";

type Route = (r: Request) => Promise<Response>;
type Body = { ok: boolean; data?: Record<string, unknown> & { payload?: Record<string, unknown> }; error?: string };

const ADMIN = fixedAddress(31);
const OTHER_ADMIN = fixedAddress(32);
const STRANGER = fixedAddress(33);
const SUPER = fixedAddress(34);
const ANCHOR_SIG = "3vSXmWYxioJaTwCRytEr7xHDKinyJ35UMYie4mNdMceH8ncu2V3qCQ8VexzhMbLV3KUv1s7jhAdHR8YBdVEV5YUJ";
const YEAR = new Date().getUTCFullYear();

async function call(route: Route, wallet: string, params: Record<string, unknown>, via: "signature" | "session" = "signature") {
  state.wallet = wallet;
  state.params = params;
  state.via = via;
  const res = await route(new Request("https://manci.test/api/admin/certificates", { method: "POST", body: "{}" }));
  return { status: res.status, body: (await res.json()) as Body };
}
const rows = () => db.ref!.rows("certificates");
const audits = () => db.ref!.rows("audit_events");

function putChain() {
  state.accounts.set(SHARE_CLASS, {
    owner: ASSET_REGISTRY_PROGRAM_ADDRESS,
    data: Uint8Array.from(getShareClassEncoder().encode({
      asset: ASSET as Address,
      mint: MINT as Address,
      classIndex: 0,
      classType: ShareClassType.Common,
      rightsBitfield: 35,
      liqPrefMultiplierBps: 10_000,
      liqSeniority: 0,
      votingWeight: 1,
      convertibleTo: none(),
      maxSupply: some(BigInt(1750)),
      circulatingSupply: BigInt(250),
      lockedSupply: BigInt(0),
      mintablePostLaunch: false,
      mintInitialized: true,
      supplyLocked: false,
      version: 2,
      bump: 255,
      lifetimeMinted: BigInt(500),
      cumulativeCap: false,
    })),
  });
  state.accounts.set(ASSET, {
    owner: ASSET_REGISTRY_PROGRAM_ADDRESS,
    data: Uint8Array.from(getAssetEncoder().encode({
      issuer: ISSUER as Address,
      assetId: "MANCI-2026",
      assetType: AssetType.Equity,
      name: "MANCI 17.5%",
      symbolPrefix: "MANCI",
      legalDocHash: Uint8Array.from(Buffer.from(LEGAL_DOC_HASH, "hex")),
      jurisdictionRules: { allowedCountries: new Uint8Array(32), maxHolders: 0, restrictedPeriodEnd: BigInt(0), allowP2p: true },
      status: AssetStatus.Active,
      shareClassesCount: 2,
      extraKycRegistry: none(),
      version: 1,
      bump: 254,
    })),
  });
  state.tokens.set(HOLDER, [{ mint: MINT, amount: "250", decimals: 0 }]);
}

const holdingParams = (over: Record<string, unknown> = {}) => ({
  kind: "holding",
  share_class: SHARE_CLASS,
  wallet: HOLDER,
  company: COMPANY,
  units_for_100_percent: "10000",
  holder_name: "Petar Petrović",
  holder_id_number: "ID-TEST-0001",
  ...over,
});

beforeEach(() => {
  db.ref = memorySupabase();
  db.ref.uniqueIds.add("audit_events");
  db.ref.defaults.certificates = () => ({
    id: crypto.randomUUID(),
    status: "draft",
    signature: null,
    signature_format: null,
    signed_at: null,
    anchor_tx: null,
    anchor_slot: null,
    anchor_block_time: null,
    anchored_at: null,
    revoked_at: null,
    revoked_by: null,
    revoke_reason: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  let counter = 0;
  state.allocations = [];
  db.ref.rpcs.allocate_certificate_number = (args) => {
    state.allocations.push(Number(args.p_year));
    counter += 1;
    return `MC-${String(args.p_year)}-${String(counter).padStart(4, "0")}`;
  };
  state.admins = new Set([ADMIN, OTHER_ADMIN]);
  state.superAdmins = new Set([SUPER]);
  state.actions = [];
  state.accounts.clear();
  state.tokens.clear();
  state.supply = { amount: "250", decimals: 0 };
  state.statuses.clear();
  state.rpcCalls = [];
  state.rpcFails = false;
  putChain();
});

/** A stored draft created through the route by `wallet` (the signer it names). */
async function draft(wallet = SUPER, params: Record<string, unknown> = holdingParams()) {
  const res = await call(createRoute, wallet, params);
  expect(res.status).toBe(200);
  return res.body.data as Record<string, unknown> & { id: string; number: string; payload_sha256: string };
}

describe("gates and actions", () => {
  const routes: Array<[string, Route, string, Record<string, unknown>]> = [
    ["list", listRoute, CERTIFICATE_ACTIONS.list, {}],
    ["read", readRoute, CERTIFICATE_ACTIONS.read, { id: "00000000-0000-4000-8000-000000000001" }],
    ["preview", previewRoute, CERTIFICATE_ACTIONS.preview, holdingParams()],
    ["create", createRoute, CERTIFICATE_ACTIONS.create, holdingParams()],
    ["sign", signRoute, CERTIFICATE_ACTIONS.sign, { id: "00000000-0000-4000-8000-000000000001", signature: ANCHOR_SIG }],
    ["anchor", anchorRoute, CERTIFICATE_ACTIONS.anchor, { id: "00000000-0000-4000-8000-000000000001" }],
    ["revoke", revokeRoute, CERTIFICATE_ACTIONS.revoke, { id: "00000000-0000-4000-8000-000000000001", reason: "Issued in error" }],
  ];

  it.each(routes)("%s refuses a non-admin with 403 before any read, on its own action", async (_name, route, action, params) => {
    const res = await call(route, STRANGER, params);
    expect(res.status).toBe(403);
    expect(state.actions).toEqual([action]);
    expect(state.rpcCalls).toEqual([]);
    expect(state.allocations).toEqual([]);
    expect(rows()).toHaveLength(0);
  });

  it("create, sign and anchor are the Super Admin's: an Admin is refused before any read; preview, list, read and revoke stay open to it", async () => {
    const created = await draft(SUPER);
    state.rpcCalls = [];
    const allocated = state.allocations.length;
    for (const [route, params] of [
      [createRoute, holdingParams()],
      [signRoute, { id: created.id, signature: ANCHOR_SIG }],
      [anchorRoute, { id: created.id }],
    ] as Array<[Route, Record<string, unknown>]>) {
      const res = await call(route, ADMIN, params, "session");
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/Super admin/);
    }
    expect(state.rpcCalls).toEqual([]);
    expect(state.allocations).toHaveLength(allocated);
    expect(rows()[0].status).toBe("draft");
    expect((await call(previewRoute, ADMIN, holdingParams(), "session")).status).toBe(200);
    expect((await call(listRoute, ADMIN, {}, "session")).status).toBe(200);
    expect((await call(readRoute, ADMIN, { id: created.id }, "session")).status).toBe(200);
    expect((await call(revokeRoute, ADMIN, { id: created.id, reason: "Discarded by an admin" })).status).toBe(200);
  });

  it("reads and the two evidence records are session actions; create and revoke need a signature; maintenance stops every write", () => {
    for (const action of [CERTIFICATE_ACTIONS.list, CERTIFICATE_ACTIONS.read, CERTIFICATE_ACTIONS.preview]) {
      expect(SESSION_READ_ACTIONS.has(action)).toBe(true);
      expect(refusedInMaintenance(action)).toBe(false);
    }
    for (const action of [CERTIFICATE_ACTIONS.sign, CERTIFICATE_ACTIONS.anchor]) {
      expect(SESSION_READ_ACTIONS.has(action)).toBe(true);
      expect(refusedInMaintenance(action)).toBe(true);
    }
    for (const action of [CERTIFICATE_ACTIONS.create, CERTIFICATE_ACTIONS.revoke]) {
      expect(SESSION_READ_ACTIONS.has(action)).toBe(false);
      expect(refusedInMaintenance(action)).toBe(true);
    }
  });
});

describe("preview", () => {
  it("reads the chain and prefills the scale and the company from the tokenization record, writing nothing", async () => {
    db.ref!.rows("asset_profiles").push({
      network: "devnet",
      asset_pda: ASSET,
      spv_id: null,
      fields: { tokenize: { tokens: "1750", percent_e4: "175000", granularity_percent: "0.01", company_name: "Primer d.o.o. Beograd" } },
    });
    const res = await call(previewRoute, ADMIN, { kind: "holding", share_class: SHARE_CLASS, wallet: HOLDER }, "session");
    expect(res.status).toBe(200);
    const data = res.body.data as Record<string, unknown> & { prefill: Record<string, unknown>; facts: Record<string, unknown> };
    expect(data.facts).toMatchObject({ asset_id: "MANCI-2026", symbol: "MANCI0", max_supply: "1750", holding: { units: "250", slot: "380123456" } });
    expect(data.prefill).toMatchObject({
      company: { legal_name: "Primer d.o.o. Beograd", registration_number: "", address: "" },
      company_source: "tokenization",
      units_for_100_percent: "10000",
      scale_source: "tokenization",
    });
    expect(data.payload).toBeNull();
    expect(data.problem).toMatch(/registration number is required/);
    expect(rows()).toHaveLength(0);
    expect(state.allocations).toEqual([]);

    // A company only partly typed is merged with the prefill and reported, not refused.
    const partial = await call(previewRoute, ADMIN, holdingParams({ company: { legal_name: "Typed d.o.o.", registration_number: "", address: "" } }), "session");
    expect(partial.status).toBe(200);
    expect(partial.body.data).toMatchObject({ payload: null, problem: expect.stringMatching(/registration number is required/) });

    const complete = await call(previewRoute, ADMIN, holdingParams({ units_for_100_percent: undefined }), "session");
    expect(complete.body.data).toMatchObject({ problem: null, payload: { holding: { units: "250", percent_of_company: "2.5" }, number: `MC-${YEAR}-0000` } });
  });

  it("prefills from the last certificate of the asset first (an admin's earlier corrections), never from a revoked one", async () => {
    const first = await draft();
    const res = await call(previewRoute, ADMIN, { kind: "issuance", share_class: SHARE_CLASS }, "session");
    expect(res.body.data).toMatchObject({ prefill: { company: COMPANY, company_source: "certificate", units_for_100_percent: "10000" } });
    expect((await call(revokeRoute, ADMIN, { id: first.id, reason: "Wrong company details" })).status).toBe(200);
    const after = await call(previewRoute, ADMIN, { kind: "issuance", share_class: SHARE_CLASS }, "session");
    expect(after.body.data).toMatchObject({ prefill: { company_source: null, units_for_100_percent: null } });
  });

  it("reports an on-chain name a certificate cannot state, and create spends no number on it", async () => {
    const asset = state.accounts.get(ASSET)!;
    const decoded = getAssetDecoder().decode(asset.data);
    state.accounts.set(ASSET, { ...asset, data: Uint8Array.from(getAssetEncoder().encode({ ...decoded, name: "MANCI\u202e%5.71" })) });
    const preview = await call(previewRoute, ADMIN, holdingParams(), "session");
    expect(preview.status).toBe(200);
    expect(preview.body.data).toMatchObject({ payload: null, problem: expect.stringMatching(/asset's name on chain contains an invisible/) });
    const created = await call(createRoute, SUPER, holdingParams());
    expect(created.status).toBe(400);
    expect(state.allocations).toEqual([]);
  });

  it("refuses an address that is not a share class (404 / 400) and answers 503 when the chain cannot be read", async () => {
    expect((await call(previewRoute, ADMIN, holdingParams({ share_class: fixedAddress(77) }), "session")).status).toBe(404);
    state.accounts.set(fixedAddress(78), { owner: fixedAddress(79), data: new Uint8Array(10) });
    expect((await call(previewRoute, ADMIN, holdingParams({ share_class: fixedAddress(78) }), "session")).status).toBe(400);
    state.rpcFails = true;
    expect((await call(previewRoute, ADMIN, holdingParams(), "session")).status).toBe(503);
  });
});

describe("create", () => {
  it("stores the canonical payload and its hash under the next number, naming the session wallet as signer", async () => {
    state.statuses.set(EVIDENCE_TX, { slot: BigInt(370_000_000), err: null, confirmationStatus: "finalized" });
    const created = await draft(SUPER, holdingParams({ evidence: [{ signature: EVIDENCE_TX, note: "Transfer of 500 units" }] }));
    expect(created).toMatchObject({ number: `MC-${YEAR}-0001`, status: "draft", kind: "holding", signer: SUPER, created_by: SUPER, holder_wallet: HOLDER });
    expect(state.allocations).toEqual([YEAR]);
    const row = rows()[0];
    expect(await sha256HexOfText(String(row.payload_canonical))).toBe(row.payload_sha256);
    const payload = JSON.parse(String(row.payload_canonical));
    expect(payload).toMatchObject({
      number: `MC-${YEAR}-0001`,
      network: "devnet",
      signer: { public_key: SUPER },
      holder: { wallet: HOLDER, name: "Petar Petrović", id_number: "ID-TEST-0001" },
      holding: { units: "250", percent_of_company: "2.5", slot: "380123456" },
      chain_evidence: { transactions: [{ signature: EVIDENCE_TX, slot: "370000000", note: "Transfer of 500 units" }] },
    });
    expect(payload.salt).toMatch(/^[0-9a-f]{32}$/);
    // The audit row is the server's, without the holder's name or ID number.
    expect(audits()).toHaveLength(1);
    expect(audits()[0]).toMatchObject({ category: "operator", ix_name: "certificate_create", actor_wallet: SUPER, target_label: `MC-${YEAR}-0001` });
    expect(JSON.stringify(audits()[0])).not.toMatch(/Petar|ID-TEST-0001/);
    // The next draft takes the next number, with its own salt.
    const second = await draft();
    expect(second.number).toBe(`MC-${YEAR}-0002`);
    expect(second.payload_sha256).not.toBe(created.payload_sha256);
  });

  it("spends no number on a wrong input, an empty holding, a missing evidence transaction or an unreadable chain", async () => {
    const refused = async (params: Record<string, unknown>, status: number, error?: RegExp) => {
      const res = await call(createRoute, SUPER, params);
      expect(res.status, JSON.stringify(params)).toBe(status);
      if (error) expect(res.body.error).toMatch(error);
    };
    await refused(holdingParams({ company: { ...COMPANY, address: "" } }), 400, /registered address/);
    await refused(holdingParams({ units_for_100_percent: "1000" }), 400, /maximum supply/);
    await refused(holdingParams({ holder_name: "Mancipatio\u202e" }), 400, /invisible/);
    state.tokens.set(HOLDER, []);
    await refused(holdingParams(), 400, /holds no units/);
    state.tokens.set(HOLDER, [{ mint: MINT, amount: "250", decimals: 2 }]);
    await refused(holdingParams(), 400, /decimals/);
    state.tokens.set(HOLDER, [{ mint: MINT, amount: "250", decimals: 0 }]);
    await refused(holdingParams({ evidence: [{ signature: EVIDENCE_TX }] }), 400, /not a transaction this network knows/);
    state.statuses.set(EVIDENCE_TX, { slot: BigInt(1), err: null, confirmationStatus: "confirmed" });
    await refused(holdingParams({ evidence: [{ signature: EVIDENCE_TX }] }), 400, /not finalized/);
    state.rpcFails = true;
    await refused(holdingParams(), 503);
    expect(state.allocations).toEqual([]);
    expect(rows()).toHaveLength(0);
  });

  it("creates an issuance certificate from the mint's supply", async () => {
    const created = await draft(SUPER, { kind: "issuance", share_class: SHARE_CLASS, company: COMPANY, units_for_100_percent: "10000" });
    expect(created).toMatchObject({ kind: "issuance", holder_wallet: null });
    expect(created.payload).toMatchObject({ supply: { circulating: "250", lifetime_minted: "500", max_supply_percent: "17.5" }, holder: null });
  });
});

describe("sign", () => {
  it("stores the draft signer's verified signature of exactly this certificate", async () => {
    const wallet = await certificateSigner();
    state.superAdmins.add(wallet.address);
    const created = await draft(wallet.address);
    const signature = await wallet.sign(created.number, created.payload_sha256);
    const res = await call(signRoute, wallet.address, { id: created.id, signature }, "session");
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: "signed", signature, signature_format: "raw" });
    expect(audits().map((a) => a.ix_name)).toEqual(["certificate_create", "certificate_sign"]);
    // The same signature again is answered, not refused.
    const again = await call(signRoute, wallet.address, { id: created.id, signature }, "session");
    expect(again.status).toBe(200);
    expect(audits()).toHaveLength(2);
  });

  it("accepts a Ledger's off-chain envelope and records that format", async () => {
    const wallet = await certificateSigner();
    state.superAdmins.add(wallet.address);
    const created = await draft(wallet.address);
    const signature = await wallet.sign(created.number, created.payload_sha256, "offchain-v0");
    const res = await call(signRoute, wallet.address, { id: created.id, signature, signature_format: "offchain-v0" }, "session");
    expect(res.body.data).toMatchObject({ status: "signed", signature_format: "offchain-v0" });
  });

  it("refuses another admin, a signature of something else and a malformed one, leaving the draft a draft", async () => {
    const wallet = await certificateSigner();
    const other = await certificateSigner();
    state.superAdmins.add(wallet.address);
    state.superAdmins.add(other.address);
    const created = await draft(wallet.address);
    const byOther = await call(signRoute, other.address, { id: created.id, signature: await other.sign(created.number, created.payload_sha256) }, "session");
    expect(byOther.status).toBe(403);
    expect(byOther.body.error).toMatch(/names .* as its signer/);
    const wrongHash = await call(signRoute, wallet.address, { id: created.id, signature: await wallet.sign(created.number, "0".repeat(64)) }, "session");
    expect(wrongHash.status).toBe(400);
    const wrongNumber = await call(signRoute, wallet.address, { id: created.id, signature: await wallet.sign(`MC-${YEAR}-0099`, created.payload_sha256) }, "session");
    expect(wrongNumber.status).toBe(400);
    expect((await call(signRoute, wallet.address, { id: created.id, signature: "abc" }, "session")).status).toBe(400);
    expect((await call(signRoute, wallet.address, { id: "nope", signature: ANCHOR_SIG }, "session")).status).toBe(400);
    expect((await call(signRoute, wallet.address, { id: crypto.randomUUID(), signature: ANCHOR_SIG }, "session")).status).toBe(404);
    expect(rows()[0].status).toBe("draft");
    // A tampered stored payload (its bytes no longer hash to the stored hash) is never signed.
    rows()[0].payload_canonical = String(rows()[0].payload_canonical).replace('"units":"250"', '"units":"2500"');
    const tampered = await call(signRoute, wallet.address, { id: created.id, signature: await wallet.sign(created.number, created.payload_sha256) }, "session");
    expect(tampered.status).toBe(500);
    expect(rows()[0].status).toBe("draft");
  });

  it("refuses to sign a revoked draft", async () => {
    const wallet = await certificateSigner();
    state.superAdmins.add(wallet.address);
    const created = await draft(wallet.address);
    expect((await call(revokeRoute, wallet.address, { id: created.id, reason: "Discarded draft" })).status).toBe(200);
    const res = await call(signRoute, wallet.address, { id: created.id, signature: await wallet.sign(created.number, created.payload_sha256) }, "session");
    expect(res.status).toBe(409);
  });
});

describe("anchor", () => {
  async function signed() {
    const wallet = await certificateSigner();
    state.superAdmins.add(wallet.address);
    const created = await draft(wallet.address);
    expect((await call(signRoute, wallet.address, { id: created.id, signature: await wallet.sign(created.number, created.payload_sha256) }, "session")).status).toBe(200);
    return created;
  }
  function recordedAnchor(signature: string, reference: string, sha256: string) {
    audits().push({
      id: documentAnchorAuditId("devnet", signature),
      created_at: "2026-11-08T10:20:00.000Z",
      network: "devnet",
      category: "operator",
      ix_name: "document_anchor",
      actor_wallet: fixedAddress(40),
      target_label: reference,
      tx_signature: signature,
      status: "success",
      metadata: { reference, sha256, slot: 380_124_000, block_time: 1_762_597_200, commitment: "finalized" },
    });
  }

  it("takes the recorded anchor of the certificate's number and hash, by signature or by looking it up", async () => {
    const created = await signed();
    recordedAnchor(ANCHOR_SIG, created.number, created.payload_sha256);
    const res = await call(anchorRoute, SUPER, { id: created.id }, "session");
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: "anchored", anchor_tx: ANCHOR_SIG, anchor_slot: 380_124_000, anchor_block_time: "2025-11-08T10:20:00.000Z" });
    expect(audits().some((a) => a.ix_name === "certificate_anchor" && a.tx_signature === ANCHOR_SIG)).toBe(true);
    // Again, with the signature: answered as it is.
    expect((await call(anchorRoute, SUPER, { id: created.id, signature: ANCHOR_SIG }, "session")).status).toBe(200);
  });

  it("refuses an anchor of another hash, one that is not recorded, and an unsigned draft", async () => {
    const created = await signed();
    recordedAnchor(ANCHOR_SIG, created.number, "0".repeat(64));
    const other = await call(anchorRoute, SUPER, { id: created.id, signature: ANCHOR_SIG }, "session");
    expect(other.status).toBe(400);
    expect((await call(anchorRoute, SUPER, { id: created.id }, "session")).status).toBe(404);
    const unrecorded = await call(anchorRoute, SUPER, { id: created.id, signature: EVIDENCE_TX }, "session");
    expect(unrecorded.status).toBe(409);
    expect(unrecorded.body.error).toMatch(/not recorded/);
    // A row that merely looks like an anchor (another id than the record route's) does not count.
    audits().push({
      id: crypto.randomUUID(), network: "devnet", category: "operator", ix_name: "document_anchor", tx_signature: EVIDENCE_TX,
      target_label: created.number, status: "success", actor_wallet: fixedAddress(41),
      metadata: { reference: created.number, sha256: created.payload_sha256, commitment: "finalized" },
    });
    expect((await call(anchorRoute, SUPER, { id: created.id }, "session")).status).toBe(404);
    const plain = await draft();
    expect((await call(anchorRoute, SUPER, { id: plain.id }, "session")).status).toBe(409);
    expect(rows().filter((r) => r.status === "anchored")).toHaveLength(0);
  });
});

describe("revoke, list and read", () => {
  it("revokes with a reason only, once", async () => {
    const created = await draft();
    expect((await call(revokeRoute, ADMIN, { id: created.id, reason: "no" })).status).toBe(400);
    const res = await call(revokeRoute, OTHER_ADMIN, { id: created.id, reason: "Issued in error" });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: "revoked", revoked_by: OTHER_ADMIN, revoke_reason: "Issued in error" });
    expect((await call(revokeRoute, ADMIN, { id: created.id, reason: "Again" })).status).toBe(409);
  });

  it("lists rows without their payload, and serves the payload to an admin's detail", async () => {
    const created = await draft();
    const list = await call(listRoute, ADMIN, {}, "session");
    expect(list.status).toBe(200);
    const items = list.body.data as unknown as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ number: created.number, asset_label: "MANCI 17.5% · MANCI0 · class 0" });
    expect(JSON.stringify(items)).not.toMatch(/Petar|ID-TEST-0001|payload_canonical/);
    const detail = await call(readRoute, ADMIN, { id: created.id }, "session");
    expect(detail.body.data?.payload).toMatchObject({ holder: { name: "Petar Petrović" } });
    expect((await call(readRoute, ADMIN, { id: crypto.randomUUID() }, "session")).status).toBe(404);
  });
});
