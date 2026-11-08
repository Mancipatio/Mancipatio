// The fee schedule and charges routes (migration 0089) over an in-memory
// service-role client: the signed action and the gate of every admin route
// (publish and retire: the Super Admin), the public route's projection
// (published rows of this network only, nothing private, an outage never
// read as "no fee"), compare-and-swap on every write, network scoping,
// server-side pricing of charges, and the audit rows. Runs in both vitest
// projects (vitest.config.ts KYC_ONLY_OPEN_SUITES): the public price list
// and the admin console stay open in KYC-only mode.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { memorySupabase, type Row } from "./helpers/memory-supabase";

vi.mock("server-only", () => ({}));
const h = vi.hoisted(() => ({
  signed: vi.fn(),
  admin: vi.fn(),
  superAdmin: vi.fn(),
  db: null as ReturnType<typeof import("./helpers/memory-supabase").memorySupabase> | null,
}));
vi.mock("@/lib/server/siws", async (original) => ({
  ...(await original<typeof import("@/lib/server/siws")>()),
  verifySigned: h.signed,
}));
vi.mock("@/lib/server/admin-gate", () => ({ requireAdmin: h.admin, requireSuperAdmin: h.superAdmin }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseAdmin: () => h.db!.client }));
vi.mock("@/lib/network", () => ({ detectNetwork: () => "devnet" }));

import { GET as publicFees } from "@/app/api/fees/public/route";
import { POST as list } from "@/app/api/fees/schedule-list/route";
import { POST as save } from "@/app/api/fees/schedule-save/route";
import { POST as publish } from "@/app/api/fees/schedule-publish/route";
import { POST as retire } from "@/app/api/fees/schedule-retire/route";
import { POST as remove } from "@/app/api/fees/schedule-delete/route";
import { POST as defaults } from "@/app/api/fees/schedule-defaults/route";
import { POST as chargeCreate } from "@/app/api/fees/charge-create/route";
import { POST as chargeUpdate } from "@/app/api/fees/charge-update/route";
import { SiwsError } from "@/lib/server/siws-error";
import { isSessionReadAction } from "@/lib/siws-session";
import { refusedInMaintenance } from "@/lib/maintenance";
import { PUBLIC_FEE_COLUMNS } from "@/lib/fees/schedule";

type Route = (request: Request) => Promise<Response>;
const SCHEDULE = "fee_schedule";
const CHARGES = "fee_charges";
const ADMIN = "AdminWa11et1111111111111111111111111111111";
const NOW = "2026-11-08T10:00:00.000000+00:00";
const LATER = "2026-11-08T10:00:01.000000+00:00";
const PAST = "2026-11-01T00:00:00.000Z";
const FUTURE = "2099-01-01T00:00:00.000Z";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ISSUER = "FJs1EM1ND89L9sUXaS8VBKYXjmoXCkkVSJKRE19hmYxS";

function fee(extra: Row = {}): Row {
  return {
    id: id(1), network: "devnet", kind: "conversion", payer: "holder", fixed_eur: 0, rate_bps: 100, min_eur: 150, max_eur: null,
    collection: "invoice", public_label: "Conversion into registered ownership", public_note: "Notary costs at cost.",
    status: "draft", effective_from: null, published_at: null, published_by: null, retired_at: null, retired_by: null,
    created_by: "creator", updated_by: "creator", created_at: NOW, updated_at: NOW, ...extra,
  };
}
const published = (extra: Row = {}) => fee({ status: "published", effective_from: PAST, published_at: PAST, published_by: "super", ...extra });

async function call(route: Route, params: Record<string, unknown> = {}, via: "signature" | "session" = "signature") {
  h.signed.mockResolvedValue({ wallet: ADMIN, params, via });
  const response = await route(new Request("https://manci.test/api/fees", { method: "POST", body: "{}" }));
  // The route's JSON envelope ({ ok, data } or { ok: false, error }), read as the browser would.
  const body = await response.json();
  return { response, status: response.status, body };
}
const audits = () => h.db!.rows("audit_events");

/** publish_fee_schedule as 0089 defines it: compare-and-swap, then retire the kind's price and publish the draft. */
function publishRpc(args: Record<string, unknown>) {
  const rows = h.db!.rows(SCHEDULE);
  const draft = rows.find((r) => r.id === args.p_id && r.network === args.p_network);
  if (!draft) throw Object.assign(new Error("Fee not found"), { code: "P0002" });
  if (draft.status !== "draft" || draft.updated_at !== args.p_expected_updated_at) {
    throw Object.assign(new Error("This fee changed or is no longer a draft"), { code: "P0001" });
  }
  for (const r of rows) {
    if (r.network === draft.network && r.kind === draft.kind && r.status === "published") Object.assign(r, { status: "retired", retired_by: args.p_actor, retired_at: LATER });
  }
  Object.assign(draft, { status: "published", published_by: args.p_actor, published_at: LATER, effective_from: draft.effective_from ?? LATER, updated_at: LATER });
  return { ...draft };
}

/** The next insert into `table` answers this database error (a unique or check violation the memory client cannot model). */
function failNextInsert(table: string, code: string) {
  const from = h.db!.client.from;
  h.db!.client.from = (name: string) => {
    const builder = from(name) as { insert: (row: unknown) => unknown; maybeSingle: () => Promise<unknown> };
    if (name !== table) return builder;
    const insert = builder.insert;
    builder.insert = (row: unknown) => {
      insert(row);
      builder.maybeSingle = async () => ({ data: null, error: { code, message: "refused by the database" } });
      return builder;
    };
    return builder;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.admin.mockResolvedValue(undefined);
  h.superAdmin.mockResolvedValue(undefined);
  h.db = memorySupabase();
  h.db.defaults[SCHEDULE] = () => ({ created_at: NOW, updated_at: NOW, effective_from: null, published_at: null, published_by: null, retired_at: null, retired_by: null });
  h.db.defaults[CHARGES] = () => ({ created_at: NOW, updated_at: NOW, invoice_ref: null, waived_reason: null, invoiced_at: null, paid_at: null, waived_at: null });
  h.db.rpcs.publish_fee_schedule = publishRpc;
});

describe("authorization", () => {
  const ADMIN_ROUTES: Array<[string, Route, string]> = [
    ["schedule-list", list, "fees.scheduleList"],
    ["schedule-save", save, "fees.scheduleSave"],
    ["schedule-delete", remove, "fees.scheduleDelete"],
    ["schedule-defaults", defaults, "fees.scheduleDefaults"],
    ["charge-create", chargeCreate, "fees.chargeCreate"],
    ["charge-update", chargeUpdate, "fees.chargeUpdate"],
  ];

  it.each(ADMIN_ROUTES)("%s checks its signed action and the current admin role before any database work", async (_name, route, action) => {
    h.admin.mockRejectedValueOnce(new SiwsError(403, "Admin privileges required"));
    const { status } = await call(route, { fee: fee(), expected_updated_at: null });
    expect(status).toBe(403);
    expect(h.signed).toHaveBeenCalledWith(expect.any(Request), action);
    expect(h.admin).toHaveBeenCalledWith(ADMIN);
    expect(h.db!.rows(SCHEDULE)).toEqual([]);
    expect(h.db!.rows(CHARGES)).toEqual([]);
    expect(audits()).toEqual([]);
  });

  it.each([
    ["schedule-publish", publish, "fees.schedulePublish"],
    ["schedule-retire", retire, "fees.scheduleRetire"],
  ] as const)("%s needs the Super Admin, not just an Admin", async (_name, route, action) => {
    h.db!.rows(SCHEDULE).push(fee(), published({ id: id(2), kind: "otc" }));
    h.superAdmin.mockRejectedValueOnce(new SiwsError(403, "Super admin privileges required"));
    const { status } = await call(route, { id: id(1), expected_updated_at: NOW });
    expect(status).toBe(403);
    expect(h.signed).toHaveBeenCalledWith(expect.any(Request), action);
    expect(h.superAdmin).toHaveBeenCalledWith(ADMIN);
    expect(h.db!.rows(SCHEDULE).map((r) => r.status)).toEqual(["draft", "published"]);
    expect(audits()).toEqual([]);
  });

  it("lets only the admin list ride the wallet session; every write signs afresh and stops in maintenance", () => {
    expect(isSessionReadAction("fees.scheduleList")).toBe(true);
    expect(refusedInMaintenance("fees.scheduleList")).toBe(false);
    for (const action of ["fees.scheduleSave", "fees.schedulePublish", "fees.scheduleRetire", "fees.scheduleDelete", "fees.scheduleDefaults", "fees.chargeCreate", "fees.chargeUpdate"]) {
      expect(isSessionReadAction(action), action).toBe(false);
      expect(refusedInMaintenance(action), action).toBe(true);
    }
  });
});

describe("GET /api/fees/public", () => {
  it("returns only this network's published rows, in display order, in the public projection", async () => {
    h.db!.rows(SCHEDULE).push(
      published({ id: id(1) }),
      published({ id: id(2), kind: "tokenization_setup", payer: "issuer", fixed_eur: 2500, rate_bps: 0, min_eur: null, public_label: "Tokenization setup", public_note: "" }),
      fee({ id: id(3), kind: "otc", public_label: "Draft OTC" }),
      fee({ id: id(4), status: "retired", public_label: "Old conversion" }),
      published({ id: id(5), network: "mainnet", kind: "otc", public_label: "Mainnet OTC" }),
    );
    const response = await publicFees();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as { data: { fees: Row[] } };
    expect(body.data.fees.map((f) => f.public_label)).toEqual(["Tokenization setup", "Conversion into registered ownership"]);
    for (const row of body.data.fees) expect(Object.keys(row).sort()).toEqual(PUBLIC_FEE_COLUMNS.split(",").sort());
    expect(JSON.stringify(body)).not.toMatch(/super|creator|Draft OTC|Old conversion|Mainnet/);
    expect(h.signed).not.toHaveBeenCalled();
  });

  it("answers an empty list when nothing is published or 0089 is not applied yet", async () => {
    h.db!.rows(SCHEDULE).push(fee());
    expect(((await (await publicFees()).json()) as { data: { fees: unknown[] } }).data.fees).toEqual([]);
    for (const code of ["42P01", "PGRST205"]) {
      h.db!.failReads.add(SCHEDULE);
      h.db!.readErrorCodes[SCHEDULE] = code;
      const response = await publicFees();
      expect(response.status, code).toBe(200);
      expect(((await response.json()) as { data: { fees: unknown[] } }).data.fees).toEqual([]);
    }
  });

  it("answers 503, never an empty list, when the schedule cannot be read or a published row is malformed", async () => {
    h.db!.failReads.add(SCHEDULE);
    const failed = await publicFees();
    expect(failed.status).toBe(503);
    expect(((await failed.json()) as { error: string }).error).toMatch(/unavailable/);
    h.db!.failReads.clear();
    h.db!.rows(SCHEDULE).push(published(), published({ id: id(2), kind: "otc", rate_bps: 20_000 }));
    expect((await publicFees()).status).toBe(503);
  });
});

describe("the admin list", () => {
  it("lists every schedule row and the charges of this network only", async () => {
    h.db!.rows(SCHEDULE).push(fee(), published({ id: id(2), kind: "otc" }), fee({ id: id(3), network: "mainnet" }));
    h.db!.rows(CHARGES).push({ id: id(10), network: "devnet", kind: "otc", amount_eur: "150.00", base_amount_eur: "0", quantity: 1 }, { id: id(11), network: "mainnet", amount_eur: 1 });
    const { status, body, response } = await call(list, {}, "session");
    expect(status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body.data.schedule.map((r: Row) => r.id)).toEqual([id(1), id(2)]);
    expect(body.data.charges).toEqual([expect.objectContaining({ id: id(10), amount_eur: 150, base_amount_eur: 0 })]);
  });

  it("says when 0089 is not applied, and never lists an outage as an empty schedule", async () => {
    h.db!.failReads.add(SCHEDULE);
    h.db!.readErrorCodes[SCHEDULE] = "PGRST205";
    expect(await call(list)).toMatchObject({ status: 503, body: { error: expect.stringMatching(/migration 0089/) } });
    h.db!.readErrorCodes[SCHEDULE] = "XX000";
    expect(await call(list)).toMatchObject({ status: 503, body: { error: expect.stringMatching(/unavailable/) } });
  });
});

describe("drafts", () => {
  const input = { kind: "conversion", payer: "holder", fixed_eur: "0", rate_bps: 100, min_eur: "150", max_eur: null, public_label: "Conversion", public_note: "", effective_from: null };

  it("creates a private draft stamped by the server, ignoring a submitted network, author or status, and audits it", async () => {
    const { status, body } = await call(save, { fee: { ...input, network: "mainnet", status: "published", created_by: "spoofed" }, expected_updated_at: null });
    expect(status).toBe(200);
    expect(body.data.fee).toMatchObject({ network: "devnet", status: "draft", created_by: ADMIN, updated_by: ADMIN, fixed_eur: 0, min_eur: 150 });
    expect(h.db!.rows(SCHEDULE)[0]).toMatchObject({ fixed_eur: "0.00", min_eur: "150.00", collection: "invoice" });
    expect(audits()).toEqual([expect.objectContaining({
      ix_name: "fee_schedule_save", category: "platform", actor_wallet: ADMIN, target_label: body.data.fee.id,
      reason: "Fee draft created: Conversion (1 % of the conversion value, minimum EUR 150)",
      metadata: expect.objectContaining({ op: "create", kind: "conversion", actor_verified: true, actor_source: "siws-signature", network: "devnet" }),
    })]);
  });

  it("edits a draft only from its current revision, never a published or another network's row", async () => {
    h.db!.rows(SCHEDULE).push(fee(), published({ id: id(2) }), fee({ id: id(3), network: "mainnet" }));
    const edited = await call(save, { id: id(1), fee: { ...input, public_label: "Edited" }, expected_updated_at: NOW });
    expect(edited.status).toBe(200);
    expect(edited.body.data.fee).toMatchObject({ public_label: "Edited", updated_by: ADMIN, created_by: "creator" });
    h.db!.rows(SCHEDULE)[0].updated_at = LATER;
    expect((await call(save, { id: id(1), fee: { ...input, public_label: "Stale" }, expected_updated_at: NOW })).status).toBe(409);
    expect((await call(save, { id: id(2), fee: input, expected_updated_at: NOW })).status).toBe(409);
    expect((await call(save, { id: id(3), fee: input, expected_updated_at: NOW })).status).toBe(409);
    expect(h.db!.rows(SCHEDULE).map((r) => r.public_label)).toEqual(["Edited", "Conversion into registered ownership", "Conversion into registered ownership"]);
  });

  it("refuses bad input with its reason, and a database failure without echoing it", async () => {
    expect(await call(save, { fee: input })).toMatchObject({ status: 400, body: { error: expect.stringMatching(/expected_updated_at/) } });
    expect(await call(save, { fee: { ...input, rate_bps: 10_001 }, expected_updated_at: null })).toMatchObject({ status: 400, body: { error: expect.stringMatching(/rate_bps/) } });
    expect(await call(save, { fee: { ...input, min_eur: "200", max_eur: "100" }, expected_updated_at: null })).toMatchObject({ status: 400 });
    h.db!.failWrites.add(SCHEDULE);
    const failed = await call(save, { fee: { ...input, public_label: "Secret plan" }, expected_updated_at: null });
    expect(failed.status).toBe(503);
    expect(JSON.stringify(failed.body)).not.toContain("Secret plan");
    expect(audits()).toEqual([]);
  });

  it("deletes only an unchanged draft of this network", async () => {
    h.db!.rows(SCHEDULE).push(fee(), published({ id: id(2) }), fee({ id: id(3), network: "mainnet" }));
    expect((await call(remove, { id: id(2), expected_updated_at: NOW })).status).toBe(409);
    expect((await call(remove, { id: id(3), expected_updated_at: NOW })).status).toBe(409);
    expect((await call(remove, { id: id(1), expected_updated_at: LATER })).status).toBe(409);
    const deleted = await call(remove, { id: id(1), expected_updated_at: NOW });
    expect(deleted).toMatchObject({ status: 200, body: { data: { id: id(1), kind: "conversion" } } });
    expect(h.db!.rows(SCHEDULE).map((r) => r.id)).toEqual([id(2), id(3)]);
    expect(audits()).toEqual([expect.objectContaining({ ix_name: "fee_schedule_delete", target_label: id(1) })]);
  });
});

describe("suggested defaults", () => {
  it("creates the owner's suggested prices as drafts once, skipping kinds that already have a draft or a price", async () => {
    h.db!.rows(SCHEDULE).push(published({ id: id(9) }));
    const first = await call(defaults);
    expect(first.status).toBe(200);
    expect(first.body.data.skipped).toEqual(["conversion"]);
    const created = h.db!.rows(SCHEDULE).filter((r) => r.id !== id(9));
    expect(created.map((r) => [r.kind, r.payer, r.fixed_eur, r.rate_bps, r.min_eur, r.status, r.network, r.created_by])).toEqual([
      ["tokenization_setup", "issuer", "2500.00", 0, null, "draft", "devnet", ADMIN],
      ["migration_setup", "issuer", "5000.00", 0, null, "draft", "devnet", ADMIN],
      ["migration_per_holder", "issuer", "2.00", 0, null, "draft", "devnet", ADMIN],
    ]);
    expect(audits()).toEqual([expect.objectContaining({ ix_name: "fee_schedule_defaults", category: "platform" })]);
    const second = await call(defaults);
    expect(second.body.data).toEqual({ created: [], skipped: ["tokenization_setup", "conversion", "migration_setup", "migration_per_holder"] });
    expect(h.db!.rows(SCHEDULE)).toHaveLength(4);
    expect(audits()).toHaveLength(1);
  });

  it("publishes nothing on an empty schedule", async () => {
    await call(defaults);
    expect(h.db!.rows(SCHEDULE).map((r) => r.status)).toEqual(["draft", "draft", "draft", "draft"]);
    expect(((await (await publicFees()).json()) as { data: { fees: unknown[] } }).data.fees).toEqual([]);
  });
});

describe("publish and retire", () => {
  it("publishes a draft through publish_fee_schedule, retiring the price it replaces, and audits both", async () => {
    h.db!.rows(SCHEDULE).push(fee({ id: id(1), rate_bps: 50 }), published({ id: id(2), public_label: "Old conversion" }));
    const rpc = vi.spyOn(h.db!.rpcs, "publish_fee_schedule");
    const { status, body } = await call(publish, { id: id(1), expected_updated_at: NOW });
    expect(status).toBe(200);
    expect(rpc).toHaveBeenCalledWith({ p_id: id(1), p_network: "devnet", p_actor: ADMIN, p_expected_updated_at: NOW });
    expect(body.data.fee).toMatchObject({ id: id(1), status: "published", published_by: ADMIN });
    expect(body.data.replaced).toMatchObject({ id: id(2), public_label: "Old conversion" });
    expect(h.db!.rows(SCHEDULE).map((r) => r.status)).toEqual(["published", "retired"]);
    expect(audits()).toEqual([expect.objectContaining({
      ix_name: "fee_schedule_publish", category: "platform", target_label: id(1),
      reason: "Fee published: Conversion into registered ownership (0.5 % of the conversion value, minimum EUR 150, paid by the holder); replaces 1 % of the conversion value, minimum EUR 150",
      metadata: expect.objectContaining({ replaced_fee_id: id(2), kind: "conversion", actor_verified: true }),
    })]);
  });

  it("maps a stale revision to 409, an unknown fee to 404 and a database without 0089 to 503", async () => {
    h.db!.rows(SCHEDULE).push(fee());
    expect((await call(publish, { id: id(1), expected_updated_at: LATER })).status).toBe(409);
    expect((await call(publish, { id: id(7), expected_updated_at: NOW })).status).toBe(404);
    delete h.db!.rpcs.publish_fee_schedule;
    expect(await call(publish, { id: id(1), expected_updated_at: NOW })).toMatchObject({ status: 503, body: { error: expect.stringMatching(/migration 0089/) } });
    expect((await call(publish, { id: "nope", expected_updated_at: NOW })).status).toBe(400);
    expect(audits()).toEqual([]);
  });

  it("retires only the published price of this network from its current revision", async () => {
    h.db!.rows(SCHEDULE).push(published(), fee({ id: id(2) }), published({ id: id(3), network: "mainnet" }));
    expect((await call(retire, { id: id(2), expected_updated_at: NOW })).status).toBe(409);
    expect((await call(retire, { id: id(3), expected_updated_at: NOW })).status).toBe(409);
    expect((await call(retire, { id: id(1), expected_updated_at: LATER })).status).toBe(409);
    const retired = await call(retire, { id: id(1), expected_updated_at: NOW });
    expect(retired.status).toBe(200);
    expect(h.db!.rows(SCHEDULE)[0]).toMatchObject({ status: "retired", retired_by: ADMIN, updated_by: ADMIN });
    expect(audits()).toEqual([expect.objectContaining({ ix_name: "fee_schedule_retire", target_label: id(1) })]);
  });
});

describe("charges", () => {
  const REQUEST = id(20);
  const APPLICATION = id(30);
  const CLIENT = id(40);
  const seed = () => {
    h.db!.rows(SCHEDULE).push(
      published({ id: id(1) }),
      published({ id: id(2), kind: "tokenization_setup", payer: "issuer", fixed_eur: 2500, rate_bps: 0, min_eur: null, public_label: "Tokenization setup" }),
      published({ id: id(3), kind: "migration_per_holder", payer: "issuer", fixed_eur: 2, rate_bps: 0, min_eur: null, public_label: "Token migration delivery" }),
      published({ id: id(4), kind: "otc", payer: "seller", effective_from: FUTURE }),
    );
    h.db!.rows("conversion_requests").push(
      { id: REQUEST, network: "devnet", client_id: CLIENT, status: "deposited" },
      { id: id(21), network: "devnet", client_id: CLIENT, status: "cancelled" },
      { id: id(22), network: "mainnet", client_id: CLIENT, status: "deposited" },
    );
    h.db!.rows("launch_applications").push(
      { id: APPLICATION, network: "devnet", status: "approved", linked_issuer: ISSUER },
      { id: id(31), network: "devnet", status: "rejected", linked_issuer: null },
    );
    h.db!.rows("clients").push({ id: CLIENT, network: "devnet" }, { id: id(41), network: "mainnet" });
  };

  it("prices a conversion charge from the published fee and bills the requesting holder's client", async () => {
    seed();
    const small = await call(chargeCreate, { kind: "conversion", ref_type: "conversion_request", ref_id: REQUEST, base_amount_eur: "10000" });
    expect(small.status).toBe(200);
    expect(small.body.data.quote).toEqual({ cents: 15_000, eur: 150, basis: "minimum", formulaCents: 10_000 });
    expect(h.db!.rows(CHARGES)[0]).toMatchObject({
      network: "devnet", kind: "conversion", schedule_id: id(1), payer_client_id: CLIENT, issuer_pda: null, ref_type: "conversion_request",
      ref_id: REQUEST, base_amount_eur: "10000.00", quantity: 1, amount_eur: "150.00", status: "due", created_by: ADMIN,
    });
    expect(audits()).toEqual([expect.objectContaining({
      ix_name: "fee_charge_create", category: "platform",
      reason: `Fee charge booked: Conversion into registered ownership, EUR 150 (minimum) for conversion_request ${REQUEST}`,
      metadata: expect.objectContaining({ payer_client_id: CLIENT, amount_eur: 150, basis: "minimum" }),
    })]);
    h.db!.rows(CHARGES).length = 0;
    const large = await call(chargeCreate, { kind: "conversion", ref_type: "conversion_request", ref_id: REQUEST, base_amount_eur: 50_000 });
    expect(large.body.data.charge).toMatchObject({ amount_eur: 500, base_amount_eur: 50_000 });
  });

  it("never takes a payer from the request for a conversion, and refuses requests that did not go ahead", async () => {
    seed();
    expect((await call(chargeCreate, { kind: "conversion", ref_type: "conversion_request", ref_id: REQUEST, base_amount_eur: 1, payer_client_id: id(41) })).status).toBe(400);
    expect(await call(chargeCreate, { kind: "conversion", ref_type: "conversion_request", ref_id: id(21), base_amount_eur: 1 }))
      .toMatchObject({ status: 409, body: { error: expect.stringMatching(/cancelled/) } });
    expect((await call(chargeCreate, { kind: "conversion", ref_type: "conversion_request", ref_id: id(22), base_amount_eur: 1 })).status).toBe(404);
    expect((await call(chargeCreate, { kind: "conversion", ref_type: "conversion_request", ref_id: id(29), base_amount_eur: 1 })).status).toBe(404);
    expect(h.db!.rows(CHARGES)).toEqual([]);
  });

  it("charges an application's tokenization setup, adopting its linked issuer and checking the payer", async () => {
    seed();
    expect((await call(chargeCreate, { kind: "tokenization_setup", ref_type: "application", ref_id: id(31) })).status).toBe(409);
    expect(await call(chargeCreate, { kind: "tokenization_setup", ref_type: "application", ref_id: APPLICATION, payer_client_id: id(41) }))
      .toMatchObject({ status: 400, body: { error: "Unknown client" } });
    const ok = await call(chargeCreate, { kind: "tokenization_setup", ref_type: "application", ref_id: APPLICATION, payer_client_id: CLIENT });
    expect(ok.status).toBe(200);
    expect(h.db!.rows(CHARGES)[0]).toMatchObject({ amount_eur: "2500.00", issuer_pda: ISSUER, payer_client_id: CLIENT, base_amount_eur: "0.00" });
  });

  it("multiplies a per-holder fee by the delivered wallets", async () => {
    seed();
    const { body } = await call(chargeCreate, { kind: "migration_per_holder", ref_type: "migration", ref_id: "PILOT-2026-01", quantity: 180 });
    expect(body.data.charge).toMatchObject({ amount_eur: 360, quantity: 180 });
  });

  it("refuses to charge while no price of the kind is published or in effect", async () => {
    seed();
    expect(await call(chargeCreate, { kind: "primary_sale", ref_type: "application", ref_id: APPLICATION, base_amount_eur: 1 }))
      .toMatchObject({ status: 409, body: { error: expect.stringMatching(/No Primary sale fee is published/) } });
    expect(await call(chargeCreate, { kind: "otc", ref_type: "asset", ref_id: ISSUER, base_amount_eur: 1 }))
      .toMatchObject({ status: 409, body: { error: expect.stringMatching(/not in effect yet/) } });
    expect(h.db!.rows(CHARGES)).toEqual([]);
  });

  it("maps a second open charge for the same reference to 409, and a price changed underneath to 409", async () => {
    seed();
    failNextInsert(CHARGES, "23505");
    expect(await call(chargeCreate, { kind: "conversion", ref_type: "conversion_request", ref_id: REQUEST, base_amount_eur: 1 }))
      .toMatchObject({ status: 409, body: { error: expect.stringMatching(/already has an open charge/) } });
    failNextInsert(CHARGES, "23514");
    expect(await call(chargeCreate, { kind: "conversion", ref_type: "conversion_request", ref_id: REQUEST, base_amount_eur: 1 }))
      .toMatchObject({ status: 409, body: { error: expect.stringMatching(/published fee changed/) } });
    expect(audits()).toEqual([]);
  });

  it("moves a charge forward from its current revision only, and audits each move", async () => {
    const row = { id: id(50), network: "devnet", kind: "conversion", schedule_id: id(1), amount_eur: "150.00", base_amount_eur: "10000.00", quantity: 1, status: "due", invoice_ref: null, waived_reason: null, created_at: NOW, updated_at: NOW };
    h.db!.rows(CHARGES).push({ ...row }, { ...row, id: id(51), network: "mainnet" });
    expect((await call(chargeUpdate, { id: id(50), expected_updated_at: NOW, status: "paid" })).status).toBe(409);
    expect((await call(chargeUpdate, { id: id(50), expected_updated_at: NOW, status: "invoiced" })).status).toBe(400);
    expect((await call(chargeUpdate, { id: id(51), expected_updated_at: NOW, status: "invoiced", invoice_ref: "INV-1" })).status).toBe(409);
    expect((await call(chargeUpdate, { id: id(50), expected_updated_at: LATER, status: "invoiced", invoice_ref: "INV-1" })).status).toBe(409);
    const invoiced = await call(chargeUpdate, { id: id(50), expected_updated_at: NOW, status: "invoiced", invoice_ref: "INV-2026-014" });
    expect(invoiced.status).toBe(200);
    expect(h.db!.rows(CHARGES)[0]).toMatchObject({ status: "invoiced", invoice_ref: "INV-2026-014", updated_by: ADMIN });
    expect(audits()).toEqual([expect.objectContaining({
      ix_name: "fee_charge_update", reason: "Fee charge of EUR 150 marked invoiced (invoice INV-2026-014)",
    })]);
    expect((await call(chargeUpdate, { id: id(50), expected_updated_at: NOW, status: "waived", waived_reason: "no" })).status).toBe(400);
    const waived = await call(chargeUpdate, { id: id(50), expected_updated_at: NOW, status: "waived", waived_reason: "Design partner" });
    expect(waived.status).toBe(200);
    expect(h.db!.rows(CHARGES)[1]).toMatchObject({ status: "due", network: "mainnet" });
  });
});
