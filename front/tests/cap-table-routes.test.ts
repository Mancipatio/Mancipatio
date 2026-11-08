// The cap table routes (/api/cap-table/*): the admin gate on the operator's
// reads, writes and export; the issuer's ownership check; the open public
// read. The chain side (lib/server/cap-table-chain.ts), the signature and
// the gates are mocked; the database is the in-memory stand-in, so the
// network scoping, the columns each audience reads, the register writes and
// the audit-before-export rule run for real. Personal data (dossier links,
// names, staff notes, void reasons) never reaches the issuer or the public.
import { getAddressDecoder } from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { memorySupabase, type MemorySupabase } from "./helpers/memory-supabase";

vi.mock("server-only", () => ({}));
const h = vi.hoisted(() => ({
  signed: vi.fn(),
  admin: vi.fn(),
  profileAdmin: vi.fn(),
  owner: vi.fn(),
  chain: vi.fn(),
  entryClass: vi.fn(),
  db: null as MemorySupabase | null,
  selects: [] as Array<{ table: string; columns: string }>,
  insertError: null as null | { table: string; error: { code: string; message: string } },
}));
vi.mock("@/lib/server/siws", async (original) => ({
  ...(await original<typeof import("@/lib/server/siws")>()), verifySigned: h.signed,
}));
vi.mock("@/lib/server/admin-gate", () => ({ requireAdmin: h.admin }));
vi.mock("@/lib/server/profile-read", () => ({ isProfileAdmin: h.profileAdmin, requireProfileOwner: h.owner }));
vi.mock("@/lib/server/cap-table-chain", () => ({ readAssetChain: h.chain, readEntryShareClass: h.entryClass }));
vi.mock("@/lib/network", () => ({ detectNetwork: () => "devnet" }));
// The in-memory client, recording the columns of every SELECT and able to
// answer an insert with a database error (the partial unique index, 23505).
vi.mock("@/lib/supabase-server", () => ({
  getSupabaseAdmin: () => ({
    from: (table: string) => {
      const builder = h.db!.client.from(table) as Record<string, (...args: unknown[]) => unknown>;
      const select = builder.select;
      builder.select = (columns?: unknown, opts?: unknown) => {
        h.selects.push({ table, columns: typeof columns === "string" ? columns : "*" });
        return select(columns, opts);
      };
      if (h.insertError?.table === table) {
        const error = h.insertError.error;
        builder.insert = () => ({ select: () => ({ maybeSingle: async () => ({ data: null, error }) }) });
      }
      return builder;
    },
    rpc: (name: string, args?: Record<string, unknown>) => h.db!.client.rpc(name, args),
  }),
}));

import { POST as adminRead } from "@/app/api/cap-table/admin-read/route";
import { POST as issuerRead } from "@/app/api/cap-table/issuer-read/route";
import { GET as publicRead } from "@/app/api/cap-table/public/route";
import { POST as exportCsv } from "@/app/api/cap-table/export/route";
import { POST as registerCreate } from "@/app/api/cap-table/register-create/route";
import { POST as registerVoid } from "@/app/api/cap-table/register-void/route";
import { SiwsError } from "@/lib/server/siws-error";
import { isSessionReadAction } from "@/lib/siws-session";
import { refusedInMaintenance } from "@/lib/maintenance";
import type { AssetChain } from "@/lib/server/cap-table-chain";

// Deterministic test keys (32 equal bytes each), no real account.
const key = (seed: number) => getAddressDecoder().decode(new Uint8Array(32).fill(seed)).toString();
const ADMIN = key(11);
const ISSUER = key(12);
const ASSET = key(13);
const OTHER_ASSET = key(14);
const CLASS = key(15);
const OTHER_CLASS = key(16);
const MINT = key(17);
const HOLDER = key(18);
const VAULT_1 = key(19);
const VAULT_2 = key(20);
const TX_1 = "1".repeat(87) + "A";
const TX_2 = "2".repeat(87) + "B";
const SHA = "ab".repeat(32);
const CLIENT = "d0000000-0000-4000-8000-000000000001";
const R_CONVERTED = "c0000000-0000-4000-8000-000000000001";
const R_DEPOSITED = "c0000000-0000-4000-8000-000000000002";
const R_MAINNET = "c0000000-0000-4000-8000-000000000003";
const R_OTHER_CLASS = "c0000000-0000-4000-8000-000000000004";
const E_RECORDED = "e0000000-0000-4000-8000-000000000001";
const E_VOIDED = "e0000000-0000-4000-8000-000000000002";
const E_MAINNET = "e0000000-0000-4000-8000-000000000003";
/** Strings that must never reach the issuer or the public. */
const PERSONAL = [CLIENT, "Jane Example", "Typo for Jane", "staff note about Jane", "holder_client_id", "client_id", "void_reason", "voided_by", "\"note\""];

function assetChain(): AssetChain {
  return {
    identity: { asset_pda: ASSET, asset_id: "MANCI-2026", name: "Mancipatio", symbol: "MANCI", issuer_pda: "IssuerPda" },
    issuerAuthority: ISSUER,
    classes: [{
      shareClassPda: CLASS, classIndex: 0, mint: MINT, maxSupply: BigInt(10_000), cumulativeCap: false,
      lifetimeMinted: BigInt(10_000), circulatingSupply: BigInt(9_750), lockedSupply: BigInt(0), mintSupply: BigInt(9_750),
      custodyVaults: [
        { pda: VAULT_1, vaultId: "1", kind: "delivery_escrow", state: "realized", escrow: "Escrow1", escrowUnits: BigInt(0) },
        { pda: VAULT_2, vaultId: "2", kind: "delivery_escrow", state: "active", escrow: "Escrow2", escrowUnits: BigInt(100) },
      ],
      holders: [
        { owner: ISSUER, units: BigInt(9_000), kind: "treasury" },
        { owner: HOLDER, units: BigInt(650), kind: "wallet" },
        { owner: VAULT_2, units: BigInt(100), kind: "custody" },
      ],
    }],
  };
}

const conversion = (extra: Record<string, unknown>) => ({
  network: "devnet", share_class_pda: CLASS, holder_wallet: HOLDER, client_id: CLIENT, contact: "jane@example.test",
  note: "", admin_note: null, decided_at: "2026-10-10T12:00:00Z", created_at: "2026-10-01T00:00:00Z", ...extra,
});
const registerRow = (extra: Record<string, unknown>) => ({
  network: "devnet", share_class_pda: CLASS, asset_pda: ASSET, units: "250", percent_bps: "250.0000", registry: "APR",
  decision_ref: "BD 12345/2026", decision_date: "2026-10-09", decision_doc_sha256: SHA, conversion_request_id: R_CONVERTED,
  realize_tx: TX_1, holder_client_id: CLIENT, note: "staff note about Jane", status: "recorded", void_reason: null,
  voided_by: null, voided_at: null, created_by: ADMIN, created_at: "2026-10-10T13:00:00Z", ...extra,
});

function seedConversions() {
  h.db!.rows("conversion_requests").push(
    conversion({ id: R_CONVERTED, status: "converted", amount: 250, vault_pda: VAULT_1, outcome_tx: TX_1, outcome_evidence: { amountAtomic: "250", signature: TX_1 } }),
    conversion({ id: R_DEPOSITED, status: "deposited", amount: "100", vault_pda: VAULT_2, outcome_tx: null, outcome_evidence: null }),
    conversion({ id: R_MAINNET, network: "mainnet", status: "converted", amount: 999, vault_pda: VAULT_1, outcome_tx: TX_2 }),
    conversion({ id: R_OTHER_CLASS, share_class_pda: OTHER_CLASS, status: "converted", amount: 5, vault_pda: VAULT_1, outcome_tx: TX_2 }),
  );
  h.db!.rows("clients").push(
    { id: CLIENT, network: "devnet", display_name: "Jane Example", company_name: null },
    { id: "d0000000-0000-4000-8000-0000000000ff", network: "mainnet", display_name: "Mainnet person", company_name: null },
  );
}
function seedEntries() {
  h.db!.rows("register_entries").push(
    registerRow({ id: E_VOIDED, units: "25", percent_bps: "25.0000", status: "voided", void_reason: "Typo for Jane", voided_by: ADMIN, voided_at: "2026-10-10T12:30:00Z" }),
    registerRow({ id: E_RECORDED }),
    registerRow({ id: E_MAINNET, network: "mainnet", units: "999", decision_ref: "MAINNET-ONLY" }),
  );
}

async function call(route: (r: Request) => Promise<Response>, wallet: string, params: Record<string, unknown>, via: "signature" | "session" = "signature") {
  h.signed.mockResolvedValueOnce({ wallet, params, via });
  const response = await route(new Request("https://manci.test/api/cap-table", { method: "POST", body: "{}" }));
  return { response, body: await response.json() as { ok: boolean; data?: Record<string, unknown>; error?: string } };
}
async function get(query: string) {
  const response = await publicRead(new Request(`https://manci.test/api/cap-table/public${query}`));
  return { response, body: await response.json() as { ok: boolean; data?: Record<string, unknown>; error?: string } };
}
const auditRows = () => h.db!.rows("audit_events");
const tablesSelected = () => h.selects.map((s) => s.table);

beforeEach(() => {
  vi.clearAllMocks();
  h.db = memorySupabase();
  h.selects.length = 0;
  h.insertError = null;
  h.admin.mockImplementation(async (wallet: string) => { if (wallet !== ADMIN) throw new SiwsError(403, "Admin privileges required"); });
  h.profileAdmin.mockImplementation(async (wallet: string) => wallet === ADMIN);
  h.owner.mockImplementation(async (wallet: string, pda: string) => {
    if (wallet !== ISSUER || pda !== ASSET) throw new SiwsError(403, "Profile access denied");
  });
  h.chain.mockImplementation(async (pda: string) => {
    if (pda !== ASSET) throw new SiwsError(404, "Asset not found on chain");
    return assetChain();
  });
  h.entryClass.mockResolvedValue({ assetPda: ASSET, maxSupply: BigInt(10_000) });
});

describe("gates", () => {
  it.each([
    ["admin-read", adminRead, "capTable.adminRead", { asset_pda: ASSET }],
    ["export", exportCsv, "capTable.export", { asset_pda: ASSET, personal_data: true }],
    ["register-create", registerCreate, "capTable.registerCreate", { share_class_pda: CLASS }],
    ["register-void", registerVoid, "capTable.registerVoid", { id: E_RECORDED, reason: "x" }],
  ] as const)("%s: the signed action, then the admin gate, before any read", async (_name, route, action, params) => {
    seedConversions();
    seedEntries();
    const { response } = await call(route, ISSUER, params);
    expect(response.status).toBe(403);
    expect(h.signed).toHaveBeenCalledWith(expect.any(Request), action);
    expect(h.admin).toHaveBeenCalledWith(ISSUER);
    expect(h.selects).toEqual([]);
    expect(h.chain).not.toHaveBeenCalled();
    expect(auditRows()).toEqual([]);
    expect(h.db!.rows("register_entries")).toHaveLength(3);
  });

  it("issuer-read: another wallet's asset is refused before any read; an admin reads without the ownership check", async () => {
    seedConversions();
    const refused = await call(issuerRead, ISSUER, { asset_pda: OTHER_ASSET });
    expect(refused.response.status).toBe(403);
    expect(h.signed).toHaveBeenCalledWith(expect.any(Request), "capTable.issuerRead");
    expect(h.owner).toHaveBeenCalledWith(ISSUER, OTHER_ASSET, "asset");
    expect(h.selects).toEqual([]);
    expect(h.chain).not.toHaveBeenCalled();
    const stranger = await call(issuerRead, HOLDER, { asset_pda: ASSET });
    expect(stranger.response.status).toBe(403);
    const admin = await call(issuerRead, ADMIN, { asset_pda: ASSET });
    expect(admin.response.status).toBe(200);
    expect(h.owner).toHaveBeenCalledTimes(2);
  });

  it("reads are session actions; recording, voiding and the export need a fresh signature and wait out maintenance", () => {
    for (const action of ["capTable.adminRead", "capTable.issuerRead"]) {
      expect(isSessionReadAction(action), action).toBe(true);
      expect(refusedInMaintenance(action), action).toBe(false);
    }
    for (const action of ["capTable.registerCreate", "capTable.registerVoid", "capTable.export"]) {
      expect(isSessionReadAction(action), action).toBe(false);
      expect(refusedInMaintenance(action), action).toBe(true);
    }
  });

  it("refuses a malformed asset address with 400 and reads nothing", async () => {
    for (const asset_pda of [undefined, "", "not-an-address", 5]) {
      const { response } = await call(adminRead, ADMIN, { asset_pda });
      expect(response.status, String(asset_pda)).toBe(400);
    }
    expect(h.chain).not.toHaveBeenCalled();
  });
});

describe("admin reconciliation", () => {
  it("reads this network's rows of the asset's classes, with the dossier links, and reconciles them", async () => {
    seedConversions();
    seedEntries();
    const { response, body } = await call(adminRead, ADMIN, { asset_pda: ASSET }, "session");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(h.chain).toHaveBeenCalledWith(ASSET, { holders: true });
    const table = body.data!.table as { classes: Array<Record<string, unknown>>; state: string; network: string };
    expect(table.network).toBe("devnet");
    const c = table.classes[0] as {
      conversions: Array<{ id: string; client_id?: string; escrow_units: string | null }>;
      entries: Array<{ id: string; holder_client_id?: string; note?: string; void_reason?: string | null }>;
      checks: Array<{ id: string; state: string }>;
      chain: Record<string, unknown>;
    };
    expect(c.conversions.map((v) => v.id)).toEqual([R_CONVERTED, R_DEPOSITED]);
    expect(c.conversions[0].client_id).toBe(CLIENT);
    expect(c.conversions[1].escrow_units).toBe("100");
    expect(c.entries.map((e) => e.id)).toEqual([E_VOIDED, E_RECORDED]);
    expect(c.entries[1]).toMatchObject({ holder_client_id: CLIENT, note: "staff note about Jane" });
    expect(c.entries[0].void_reason).toBe("Typo for Jane");
    expect(c.chain).toMatchObject({ in_conversion: "100", burned_by_conversions: "250", treasury: "9000" });
    expect(c.checks.every((k) => k.state === "pass"), JSON.stringify(c.checks)).toBe(true);
    expect(JSON.stringify(table)).not.toContain("MAINNET-ONLY");
    expect(JSON.stringify(table)).not.toContain(R_MAINNET);
    expect(JSON.stringify(table)).not.toContain(R_OTHER_CLASS);
  });

  it("fails closed when the records cannot be read", async () => {
    h.db!.failReads.add("register_entries");
    const { response, body } = await call(adminRead, ADMIN, { asset_pda: ASSET });
    expect(response.status).toBe(503);
    expect(body.data).toBeUndefined();
  });

  it("passes the chain's 404 and 503 through", async () => {
    expect((await call(adminRead, ADMIN, { asset_pda: OTHER_ASSET })).response.status).toBe(404);
    h.chain.mockRejectedValueOnce(new SiwsError(503, "On-chain supply data unavailable — try again"));
    expect((await call(adminRead, ADMIN, { asset_pda: ASSET })).response.status).toBe(503);
  });
});

describe("issuer view", () => {
  it("wallets, units and decision references only: no dossier link, name, note, void reason or voided entry", async () => {
    seedConversions();
    seedEntries();
    const { response, body } = await call(issuerRead, ISSUER, { asset_pda: ASSET }, "session");
    expect(response.status).toBe(200);
    const text = JSON.stringify(body.data);
    for (const secret of PERSONAL) expect(text, secret).not.toContain(secret);
    const c = (body.data!.table as { classes: Array<{ entries: Array<{ id: string; decision_ref: string }>; holders: Array<{ owner: string }> }> }).classes[0];
    expect(c.entries.map((e) => [e.id, e.decision_ref])).toEqual([[E_RECORDED, "BD 12345/2026"]]);
    expect(c.holders.map((x) => x.owner)).toEqual([ISSUER, HOLDER, VAULT_2]);
    // The personal columns are not even read for the issuer.
    const read = h.selects.filter((s) => s.table === "conversion_requests" || s.table === "register_entries");
    expect(read.length).toBe(2);
    for (const { columns } of read) expect(columns).not.toMatch(/client_id|note|void_reason|voided_by|created_by|contact/);
    expect(tablesSelected()).not.toContain("clients");
  });
});

describe("public supply", () => {
  it("open and cached: aggregates and the non-personal register columns of this network", async () => {
    seedConversions();
    seedEntries();
    const { response, body } = await get(`?asset=${ASSET}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=0, s-maxage=60, stale-while-revalidate=300");
    expect(h.signed).not.toHaveBeenCalled();
    expect(h.chain).toHaveBeenCalledWith(ASSET, { holders: false });
    expect(body.data).toMatchObject({
      network: "devnet", asset_pda: ASSET,
      classes: [{
        share_class_pda: CLASS, max_supply: "10000", unit_percent: "0.01", issued: "10000", outstanding: "9750", in_conversion: "100",
        converted: { count: 1, units: "250", percent: "2.5" },
        records: [{ decision_date: "2026-10-09", units: "250", percent: "2.5", registry: "APR", decision_doc_sha256: SHA, realize_tx: TX_1 }],
      }],
    });
    const text = JSON.stringify(body.data);
    for (const secret of [...PERSONAL, "BD 12345", "MAINNET-ONLY", HOLDER, R_CONVERTED, E_RECORDED, ADMIN]) expect(text, secret).not.toContain(secret);
    for (const { table, columns } of h.selects) {
      expect(columns, table).not.toMatch(/client_id|decision_ref|note|void|holder_wallet|contact|created_by|\bid\b|\*/);
    }
    expect(tablesSelected().sort()).toEqual(["conversion_requests", "register_entries"]);
  });

  it("refuses a missing or malformed address and extra parameters without caching the refusal", async () => {
    for (const query of ["", "?asset=", "?asset=nope", `?asset=${ASSET}&nocache=1`, `?asset=${ASSET}&asset=${OTHER_ASSET}`]) {
      const { response } = await get(query);
      expect(response.status, query).toBe(400);
      expect(response.headers.get("cache-control"), query).toBe("no-store");
    }
    expect(h.chain).not.toHaveBeenCalled();
    const missing = await get(`?asset=${OTHER_ASSET}`);
    expect(missing.response.status).toBe(404);
    expect(missing.response.headers.get("cache-control")).toBe("no-store");
    h.chain.mockRejectedValueOnce(new SiwsError(503, "On-chain supply data unavailable — try again"));
    const down = await get(`?asset=${ASSET}`);
    expect(down.response.status).toBe(503);
    expect(down.response.headers.get("cache-control")).toBe("no-store");
  });
});

describe("register entries", () => {
  const input = (extra: Record<string, unknown> = {}) => ({
    share_class_pda: CLASS, units: "250", percent_bps: "250", decision_ref: "BD 12345/2026",
    decision_date: "2026-10-09", decision_doc_sha256: SHA, ...extra,
  });

  it("records a linked entry: realize signature and dossier from the request, asset from the chain, actor from the signature", async () => {
    seedConversions();
    const { response, body } = await call(registerCreate, ADMIN, input({
      conversion_request_id: R_CONVERTED, asset_pda: OTHER_ASSET, network: "mainnet", created_by: "spoofed", status: "voided",
    }));
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(h.entryClass).toHaveBeenCalledWith(CLASS);
    const [row] = h.db!.rows("register_entries");
    expect(row).toMatchObject({
      network: "devnet", asset_pda: ASSET, share_class_pda: CLASS, units: "250", percent_bps: "250", registry: "APR",
      conversion_request_id: R_CONVERTED, realize_tx: TX_1, holder_client_id: CLIENT, created_by: ADMIN, status: "recorded",
    });
    expect(body.data!.entry).toMatchObject({ units: "250", percent: "2.5", realize_tx: TX_1, holder_client_id: CLIENT });
    const audit = auditRows().find((r) => r.ix_name === "register_entry_record")!;
    expect(audit).toMatchObject({ category: "custody", actor_wallet: ADMIN, target_label: CLASS, tx_signature: TX_1, network: "devnet" });
    expect(JSON.stringify(audit)).not.toContain(CLIENT);
  });

  it("refuses requests that are not converted, of another class or network, or with another realize signature", async () => {
    seedConversions();
    const status = async (extra: Record<string, unknown>) => (await call(registerCreate, ADMIN, input(extra))).response.status;
    expect(await status({ conversion_request_id: R_DEPOSITED, units: "100", percent_bps: "100" })).toBe(409);
    expect(await status({ conversion_request_id: R_MAINNET })).toBe(404);
    expect(await status({ conversion_request_id: R_OTHER_CLASS })).toBe(409);
    expect(await status({ conversion_request_id: R_CONVERTED, realize_tx: TX_2 })).toBe(409);
    expect(await status({ holder_client_id: "d0000000-0000-4000-8000-0000000000ff" })).toBe(400);
    expect(await status({ units: "10001", percent_bps: "10000" })).toBe(400);
    expect(h.db!.rows("register_entries")).toEqual([]);
  });

  it("refuses malformed input before reading the chain or the database", async () => {
    for (const extra of [{ units: "0" }, { percent_bps: "0" }, { decision_doc_sha256: "00" }, { decision_date: "2099-01-01" }, { decision_ref: "" }]) {
      const { response } = await call(registerCreate, ADMIN, input(extra));
      expect(response.status, JSON.stringify(extra)).toBe(400);
    }
    expect(h.entryClass).not.toHaveBeenCalled();
    expect(h.selects).toEqual([]);
  });

  it("answers 409 when the request already has a recorded entry, and records without an audit row if that write fails", async () => {
    seedConversions();
    h.insertError = { table: "register_entries", error: { code: "23505", message: "duplicate key value violates unique constraint \"register_entries_conversion_once\"" } };
    const duplicate = await call(registerCreate, ADMIN, input({ conversion_request_id: R_CONVERTED }));
    expect(duplicate.response.status).toBe(409);
    expect(duplicate.body.error).toMatch(/already has a recorded register entry/);
    h.insertError = { table: "register_entries", error: { code: "23514", message: "The decision date is in the future" } };
    expect((await call(registerCreate, ADMIN, input())).response.status).toBe(409);
    h.insertError = null;
    h.db!.failWrites.add("audit_events");
    const recorded = await call(registerCreate, ADMIN, input());
    expect(recorded.response.status).toBe(200);
    expect(h.db!.rows("register_entries")).toHaveLength(1);
  });

  it("voids a recorded entry of this network once, with a reason and the signer", async () => {
    seedEntries();
    const voided = await call(registerVoid, ADMIN, { id: E_RECORDED, reason: "Wrong percent" });
    expect(voided.response.status).toBe(200);
    expect(h.db!.rows("register_entries").find((r) => r.id === E_RECORDED)).toMatchObject({
      status: "voided", void_reason: "Wrong percent", voided_by: ADMIN,
    });
    expect(auditRows().find((r) => r.ix_name === "register_entry_void")).toMatchObject({ category: "custody", target_label: CLASS });
    expect((await call(registerVoid, ADMIN, { id: E_RECORDED, reason: "Again" })).response.status).toBe(409);
    expect((await call(registerVoid, ADMIN, { id: E_MAINNET, reason: "Other network" })).response.status).toBe(404);
    expect((await call(registerVoid, ADMIN, { id: "e0000000-0000-4000-8000-0000000000ff", reason: "Missing" })).response.status).toBe(404);
    expect((await call(registerVoid, ADMIN, { id: E_VOIDED })).response.status).toBe(400);
    expect(h.db!.rows("register_entries").find((r) => r.id === E_MAINNET)!.status).toBe("recorded");
  });
});

describe("CSV export", () => {
  it("the plain file holds no personal data and is logged before it is returned", async () => {
    seedConversions();
    seedEntries();
    const { response, body } = await call(exportCsv, ADMIN, { asset_pda: ASSET });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const file = body.data as { filename: string; csv: string; personal_data: boolean };
    expect(file.personal_data).toBe(false);
    expect(file.filename).toMatch(/^manci-cap-table-MANCI-2026-\d{4}-\d{2}-\d{2}\.csv$/);
    for (const secret of [CLIENT, "Jane Example", "Typo for Jane", "staff note about Jane"]) expect(file.csv, secret).not.toContain(secret);
    expect(file.csv).toContain("BD 12345/2026");
    expect(tablesSelected()).not.toContain("clients");
    expect(auditRows()).toEqual([expect.objectContaining({
      ix_name: "cap_table_export", category: "share-class", target_label: ASSET, actor_wallet: ADMIN,
      metadata: expect.objectContaining({ personal_data: false, actor_verified: true, actor_source: "siws-signature" }),
    })]);
  });

  it("the personal-data file names the holders and logs a KYC access row per dossier", async () => {
    seedConversions();
    seedEntries();
    const { response, body } = await call(exportCsv, ADMIN, { asset_pda: ASSET, personal_data: true });
    expect(response.status).toBe(200);
    const file = body.data as { filename: string; csv: string; personal_data: boolean };
    expect(file.personal_data).toBe(true);
    expect(file.filename).toMatch(/-personal-data\.csv$/);
    expect(file.csv).toContain(`${CLIENT},Jane Example`);
    expect(file.csv).not.toContain("Mainnet person");
    expect(auditRows()).toEqual([expect.objectContaining({
      ix_name: "cap_table_export_personal_data", category: "kyc", target_label: CLIENT,
      metadata: expect.objectContaining({ personal_data: true, asset_pda: ASSET, clients: 1 }),
    })]);
  });

  it("returns nothing when the access cannot be logged", async () => {
    seedConversions();
    seedEntries();
    h.db!.failWrites.add("audit_events");
    for (const personal_data of [false, true]) {
      const { response, body } = await call(exportCsv, ADMIN, { asset_pda: ASSET, personal_data });
      expect(response.status).toBe(503);
      expect(body.data).toBeUndefined();
    }
  });

  it("personal_data must be a boolean", async () => {
    expect((await call(exportCsv, ADMIN, { asset_pda: ASSET, personal_data: "yes" })).response.status).toBe(400);
    expect(h.chain).not.toHaveBeenCalled();
  });
});
