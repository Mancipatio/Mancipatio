// /api/admin/document-anchor (record) and /list: Super Admin only (on-chain
// Platform.admin, after the SIWS check), the transaction read back from the
// server RPC and verified, and recorded only once finalized (confirmed or
// unseen = "not yet") as one server audit row "operator" / "document_anchor";
// idempotent per signature, also across instances (the row id is derived
// from the signature, the primary key refuses a second row); nothing written
// for a wrong signer, a wrong text, an extra instruction or a failed
// transaction. A row counts as a recorded anchor only with the id the route
// derives (the list, the duplicate check and /api/audit/list's
// anchor_verified). SIWS, the admin gate and the RPC are mocked; Supabase is
// in memory and the real server audit writer is used.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { memorySupabase } from "./helpers/memory-supabase";
import { buildTx, type Ix } from "./helpers/chain-tx";

vi.mock("server-only", () => ({}));
const db = vi.hoisted(() => ({ ref: null as null | ReturnType<typeof import("./helpers/memory-supabase").memorySupabase> }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseAdmin: () => db.ref!.client }));

const SA = "8TEmJBkcoBsUjRPftZ3kdWb9NmZDy7Zy3a7GqFCK5Nx9";
const ADMIN = "6AnFbinF7X12mACTVEGfjWZyzYGAShEscAB5UgV3vHsP";
const REFERENCE = "MANCI-2026-0001";
const SHA = "a2546dd318ea95b210a4eb62a45b84341d74fa065c3da1c1279fd62135f22bc7";
const SIG = "5RBDZNDobPiJGpQsfcvPLuSdzyUXRxBnpXNU4sFQg2ud3sTiSPyWnPrfvyN4myMYTvEUWjtYnGijuryNNrXqeDqm";
const SIG2 = "3vSXmWYxioJaTwCRytEr7xHDKinyJ35UMYie4mNdMceH8ncu2V3qCQ8VexzhMbLV3KUv1s7jhAdHR8YBdVEV5YUJ";
const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const CB = "ComputeBudget111111111111111111111111111111";

const state = vi.hoisted(() => ({
  wallet: "",
  action: "",
  params: {} as Record<string, unknown>,
  superAdmins: new Set<string>(),
  /** commitment → signature → transaction (json) */
  txs: { finalized: new Map<string, unknown>(), confirmed: new Map<string, unknown>() },
  rpcCalls: [] as string[],
  rpcFails: false,
  /** When set, every chain read waits for it (a request held mid-flight). */
  rpcGate: null as Promise<void> | null,
}));

vi.mock("@/lib/network", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/network")>()),
  detectNetwork: () => "mainnet",
}));
vi.mock("@/lib/server/siws", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/siws")>()),
  verifySigned: vi.fn(async (_req: Request, action: string) => {
    state.action = action;
    return { wallet: state.wallet, params: state.params, via: "session" };
  }),
}));
vi.mock("@/lib/server/admin-gate", async () => {
  const { SiwsError } = await import("@/lib/server/siws-error");
  return {
    requireAdmin: vi.fn(),
    requireSuperAdmin: vi.fn(async (wallet: string) => {
      if (!state.superAdmins.has(wallet)) throw new SiwsError(403, "Super admin privileges required");
    }),
  };
});
vi.mock("@/lib/server/rpc", () => ({
  getServerRpc: () => ({
    getTransaction: (signature: string, config: { commitment: "finalized" | "confirmed" }) => ({
      send: async () => {
        state.rpcCalls.push(`${config.commitment}:${signature}`);
        if (state.rpcGate) await state.rpcGate;
        if (state.rpcFails) throw new Error("rpc down");
        return state.txs[config.commitment].get(signature) ?? null;
      },
    }),
  }),
}));

import { POST as recordRoute, maxDuration } from "@/app/api/admin/document-anchor/route";
import { documentAnchorAuditId } from "@/lib/server/document-anchor";
import { POST as listRoute } from "@/app/api/admin/document-anchor/list/route";
import { POST as auditRoute } from "@/app/api/audit/route";
import { POST as auditListRoute } from "@/app/api/audit/list/route";
import { SESSION_READ_ACTIONS } from "@/lib/siws-session";
import { refusedInMaintenance } from "@/lib/maintenance";
import { SERVER_ONLY_AUDIT_CATEGORIES, ServerAuditRowExistsError, writeServerAudit } from "@/lib/server/audit";
import { SiwsError } from "@/lib/server/siws-error";
import { DOCUMENT_ANCHOR_LIST_LIMIT, DOCUMENT_ANCHOR_NOT_YET } from "@/lib/document-anchor";
import type { SupabaseClient } from "@supabase/supabase-js";

const utf8 = (text: string) => new TextEncoder().encode(text);
const cb = (): Ix => ({ program: CB, accounts: [], data: new Uint8Array([2, 0, 0, 0, 0]) });
const memo = (text = `${REFERENCE} sha256:${SHA}`, accounts = [SA]): Ix => ({ program: MEMO_PROGRAM, accounts, data: utf8(text) });
/** The transaction as getTransaction (json) returns it, with the roles an anchor compiles to (the fee payer writable, every other key read-only). */
function chainTx(over: { signature?: string; payer?: string; instructions?: Ix[]; err?: unknown } = {}) {
  const { tx } = buildTx({
    signature: over.signature ?? SIG,
    payer: over.payer ?? SA,
    instructions: (over.instructions ?? [cb(), memo()]).map((ix) => ({ ix })),
    err: over.err,
  });
  const { message } = tx.transaction;
  const header = { ...message.header, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: message.accountKeys.length - 1 };
  return { ...tx, transaction: { ...tx.transaction, message: { ...message, header } } };
}

/** An anchor row as the record route writes it (derived id, success, finalized), for rows a test puts in place. */
function anchorRow(signature: string, over: { reference?: string; sha256?: string; created_at?: string; commitment?: string } = {}) {
  return {
    id: documentAnchorAuditId("mainnet", signature),
    created_at: over.created_at ?? "2026-10-05T10:00:00.000Z",
    network: "mainnet",
    category: "operator",
    ix_name: "document_anchor",
    actor_wallet: SA,
    tx_signature: signature,
    status: "success",
    metadata: {
      reference: over.reference ?? REFERENCE,
      sha256: over.sha256 ?? SHA,
      slot: 100,
      block_time: 1_700_000_000,
      commitment: over.commitment ?? "finalized",
    },
  };
}

async function call(route: (r: Request) => Promise<Response>, wallet: string, params: Record<string, unknown>) {
  state.wallet = wallet;
  state.params = params;
  const res = await route(new Request("https://www.manci.io/api/admin/document-anchor", { method: "POST", body: "{}" }));
  return { status: res.status, body: (await res.json()) as { ok: boolean; data?: Record<string, unknown> & Record<string, unknown>[]; error?: string } };
}
const record = (params: Record<string, unknown> = {}, wallet = SA) =>
  call(recordRoute, wallet, { signature: SIG, reference: REFERENCE, sha256: SHA, ...params });
const rows = () => db.ref!.rows("audit_events");

beforeEach(() => {
  db.ref = memorySupabase();
  // audit_events.id is the table's primary key (migration 0001).
  db.ref.uniqueIds.add("audit_events");
  state.superAdmins = new Set([SA]);
  state.txs.finalized.clear();
  state.txs.confirmed.clear();
  state.rpcCalls = [];
  state.rpcFails = false;
  state.rpcGate = null;
});

describe("POST /api/admin/document-anchor", () => {
  it("records a verified anchor: one server row operator / document_anchor with the chain facts", async () => {
    state.txs.finalized.set(SIG, chainTx());
    const res = await record();
    expect(res.status).toBe(200);
    expect(state.action).toBe("admin.documentAnchorRecord");
    expect(res.body.data).toMatchObject({
      reference: REFERENCE, sha256: SHA, signature: SIG, signer: SA, slot: 100, blockTime: 1_700_000_000, commitment: "finalized", duplicate: false,
    });
    expect(rows()).toHaveLength(1);
    expect(res.body.data!.id).toBe(documentAnchorAuditId("mainnet", SIG));
    expect(rows()[0]).toMatchObject({
      id: documentAnchorAuditId("mainnet", SIG),
      network: "mainnet",
      category: "operator",
      ix_name: "document_anchor",
      actor_wallet: SA,
      target_label: REFERENCE,
      tx_signature: SIG,
      status: "success",
    });
    expect(rows()[0].metadata).toMatchObject({
      reference: REFERENCE,
      sha256: SHA,
      memo: `${REFERENCE} sha256:${SHA}`,
      memo_program: MEMO_PROGRAM,
      signer: SA,
      slot: 100,
      block_time: 1_700_000_000,
      block_time_iso: "2023-11-14T22:13:20.000Z",
      commitment: "finalized",
      wallet_guard_instructions: 0,
      actor_verified: true,
      actor_source: "siws-session",
    });
  });

  it("records the shape Phantom signs on mainnet: Lighthouse assertions around the memo, counted in the row", async () => {
    // The guards of mainnet 5RBDZ… byte for byte (kind 6 AssertAccountInfoMulti):
    // 37 bytes on a writable account before the instruction, 26 on the fee payer after it.
    const LIGHTHOUSE = "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95";
    const before: Ix = {
      program: LIGHTHOUSE,
      accounts: ["FJaWxqhSxjYsH8yMqc76H769vL8kapaFvEWB37yxom4Z"],
      data: new Uint8Array([6, 4, 1, 2, 212, 151, 7, 199, 145, 164, 1, 97, 251, 49, 229, 43, 85, 240, 11, 2, 122, 221, 205, 89, 194, 119, 196, 193, 254, 167, 96, 45, 227, 160, 90, 203, 0]),
    };
    const after: Ix = { program: LIGHTHOUSE, accounts: [SA], data: new Uint8Array([6, 4, 3, 0, 96, 146, 99, 59, 0, 0, 0, 0, 4, 3, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]) };
    const limit: Ix = { program: CB, accounts: [], data: new Uint8Array([2, 64, 13, 3, 0]) };
    const price: Ix = { program: CB, accounts: [], data: new Uint8Array([3, 160, 134, 1, 0, 0, 0, 0, 0]) };
    state.txs.finalized.set(SIG, chainTx({ instructions: [limit, price, before, memo(), after] }));
    const res = await record();
    expect(res.status).toBe(200);
    expect(rows()[0].metadata).toMatchObject({ wallet_guard_instructions: 2 });
    // A Lighthouse MemoryWrite (0) is not a guard.
    state.txs.finalized.set(SIG2, chainTx({ signature: SIG2, instructions: [cb(), { ...after, data: new Uint8Array([0, 0]) }, memo()] }));
    const write = await record({ signature: SIG2 });
    expect(write.status).toBe(400);
    expect(write.body.error).toMatch(/not an assertion/);
    expect(rows()).toHaveLength(1);
  });

  it("records only a finalized transaction: unseen or confirmed-only answers 'not yet' (503) and writes nothing", async () => {
    const unseen = await record();
    expect(unseen.status).toBe(503);
    expect(unseen.body.error!.startsWith(DOCUMENT_ANCHOR_NOT_YET)).toBe(true);
    expect(rows()).toHaveLength(0);
    // Confirmed but not finalized yet: checked, then "not yet" (the page retries).
    state.txs.confirmed.set(SIG, chainTx());
    const confirmed = await record();
    expect(confirmed.status).toBe(503);
    expect(confirmed.body.error!.startsWith(DOCUMENT_ANCHOR_NOT_YET)).toBe(true);
    expect(confirmed.body.error).toMatch(/it is confirmed/);
    expect(rows()).toHaveLength(0);
    state.txs.finalized.set(SIG, chainTx());
    const res = await record();
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ commitment: "finalized" });
    expect(rows()[0].metadata).toMatchObject({ commitment: "finalized" });
    expect(state.rpcCalls).toEqual([`finalized:${SIG}`, `confirmed:${SIG}`, `finalized:${SIG}`, `confirmed:${SIG}`, `finalized:${SIG}`]);
  });

  it("refuses a wrong anchor that is only confirmed at once (400), without waiting for finalized", async () => {
    state.txs.confirmed.set(SIG, chainTx({ instructions: [cb(), memo(`${REFERENCE} sha256:${"0".repeat(64)}`)] }));
    const res = await record();
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/memo text is not/);
    expect(rows()).toHaveLength(0);
  });

  it("keeps one row when two instances record the same signature at once (the derived id is the primary key)", async () => {
    state.txs.finalized.set(SIG, chainTx());
    // Another instance inserts the same anchor between this one's re-check and its insert.
    let raced = false;
    db.ref!.beforeInsert = (table) => {
      if (table !== "audit_events" || raced) return;
      raced = true;
      rows().push(anchorRow(SIG));
    };
    const res = await record();
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: documentAnchorAuditId("mainnet", SIG), duplicate: true });
    expect(rows()).toHaveLength(1);
  });

  it("after losing that race: 409 when the winner holds another anchor, 409 'being recorded' when it is not readable as a record", async () => {
    state.txs.finalized.set(SIG, chainTx());
    // The other instance recorded this signature as another reference.
    db.ref!.beforeInsert = (table) => {
      if (table === "audit_events" && rows().length === 0) rows().push(anchorRow(SIG, { reference: "MANCI-2026-0009" }));
    };
    const other = await record();
    expect(other.status).toBe(409);
    expect(other.body.error).toMatch(/already recorded as another anchor/);
    expect(rows()).toHaveLength(1);
    // The id is taken, but the row is not (yet) readable as a finalized record.
    rows().length = 0;
    db.ref!.beforeInsert = (table) => {
      if (table === "audit_events" && rows().length === 0) rows().push(anchorRow(SIG, { commitment: "confirmed" }));
    };
    const unreadable = await record();
    expect(unreadable.status).toBe(409);
    expect(unreadable.body.error).toMatch(/This anchor is being recorded — try again in a moment/);
    expect(rows()).toHaveLength(1);
  });

  it("refuses a concurrent second request for the same signature on one instance (409), then records once", async () => {
    state.txs.finalized.set(SIG, chainTx());
    let release!: () => void;
    state.rpcGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = record();
    // Let the first request reach its chain read (it holds the signature from then on).
    await vi.waitFor(() => expect(state.rpcCalls).toHaveLength(1));
    const second = await record();
    expect(second.status).toBe(409);
    expect(second.body.error).toMatch(/This anchor is being recorded — try again in a moment/);
    release();
    const done = await first;
    expect(done.status).toBe(200);
    expect(done.body.data).toMatchObject({ duplicate: false });
    expect(rows()).toHaveLength(1);
    // Released: the next request answers the row.
    state.rpcGate = null;
    expect((await record()).body.data).toMatchObject({ duplicate: true });
  });

  it("writeServerAudit: a unique violation without a caller id is a 503, never ServerAuditRowExistsError", async () => {
    const conflict = {
      from: () => ({
        insert: () => ({
          select: () => ({ single: async () => ({ data: null, error: { code: "23505", message: "duplicate key value" } }) }),
        }),
      }),
    } as unknown as SupabaseClient;
    const input = { ix_name: "document_anchor", category: "operator" as const, actor_wallet: SA, actor_source: "siws-session" as const, reason: "test" };
    const withoutId = await writeServerAudit(conflict, input).catch((err: unknown) => err);
    expect(withoutId).toBeInstanceOf(SiwsError);
    expect(withoutId).not.toBeInstanceOf(ServerAuditRowExistsError);
    expect((withoutId as SiwsError).status).toBe(503);
    // With a caller id the same answer means that row exists.
    const withId = await writeServerAudit(conflict, { ...input, id: documentAnchorAuditId("mainnet", SIG) }).catch((err: unknown) => err);
    expect(withId).toBeInstanceOf(ServerAuditRowExistsError);
    expect((withId as ServerAuditRowExistsError).id).toBe(documentAnchorAuditId("mainnet", SIG));
  });

  it("derives one row id per network and signature (a uuid)", () => {
    const id = documentAnchorAuditId("mainnet", SIG);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(documentAnchorAuditId("mainnet", SIG)).toBe(id);
    expect(documentAnchorAuditId("devnet", SIG)).not.toBe(id);
    expect(documentAnchorAuditId("mainnet", SIG2)).not.toBe(id);
  });

  it("allows itself a 60 s function duration (two chain reads of up to 12 s)", () => {
    expect(maxDuration).toBe(60);
  });

  it("is idempotent per signature: the second call answers the same row, without a chain read", async () => {
    state.txs.finalized.set(SIG, chainTx());
    const first = await record();
    const calls = state.rpcCalls.length;
    const second = await record();
    expect(second.status).toBe(200);
    expect(second.body.data).toMatchObject({ id: first.body.data!.id, duplicate: true });
    expect(rows()).toHaveLength(1);
    expect(state.rpcCalls.length).toBe(calls);
    // The same signature claimed as another anchor is refused.
    const other = await record({ reference: "MANCI-2026-0002" });
    expect(other.status).toBe(409);
    expect(rows()).toHaveLength(1);
  });

  it("is the Super Admin's only: an Admin or a stranger gets 403 and nothing is read or written", async () => {
    state.txs.finalized.set(SIG, chainTx({ payer: ADMIN, instructions: [cb(), memo(undefined, [ADMIN])] }));
    const res = await record({}, ADMIN);
    expect(res.status).toBe(403);
    expect(state.rpcCalls).toEqual([]);
    expect(rows()).toHaveLength(0);
  });

  it("refuses a transaction signed by another wallet", async () => {
    state.txs.finalized.set(SIG, chainTx({ payer: ADMIN, instructions: [cb(), memo(undefined, [ADMIN])] }));
    const res = await record();
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/^Not recorded: The fee payer is not the Super Admin wallet/);
    expect(rows()).toHaveLength(0);
  });

  it("refuses a wrong text, an extra instruction and a failed transaction", async () => {
    state.txs.finalized.set(SIG, chainTx({ instructions: [cb(), memo(`${REFERENCE} sha256:${"0".repeat(64)}`)] }));
    expect((await record()).body.error).toMatch(/memo text is not/);
    state.txs.finalized.set(SIG, chainTx({ instructions: [cb(), memo(), { program: "11111111111111111111111111111111", accounts: [SA, ADMIN], data: new Uint8Array([2, 0, 0, 0]) }] }));
    expect((await record()).body.error).toMatch(/instruction the anchor does not have/);
    state.txs.finalized.set(SIG, chainTx({ err: { InstructionError: [1, "MissingRequiredSignature"] } }));
    const failed = await record();
    expect(failed.status).toBe(400);
    expect(failed.body.error).toMatch(/did not complete successfully/);
    expect(rows()).toHaveLength(0);
  });

  it("validates its params before any read", async () => {
    for (const params of [
      { signature: "not-a-signature" },
      { signature: 42 },
      { reference: "MANCI 2026" },
      { reference: "" },
      { sha256: SHA.toUpperCase() },
      { sha256: SHA.slice(1) },
    ]) {
      const res = await record(params);
      expect(res.status).toBe(400);
    }
    expect(state.rpcCalls).toEqual([]);
    expect(rows()).toHaveLength(0);
  });

  it("fails closed when the RPC or the audit log is unavailable", async () => {
    state.rpcFails = true;
    expect((await record()).status).toBe(503);
    state.rpcFails = false;
    state.txs.finalized.set(SIG, chainTx());
    db.ref!.failWrites.add("audit_events");
    const res = await record();
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/^Audit log unavailable — the anchor is on chain but not recorded yet/);
    // The shared writer's wording is about releases; an anchor's is not.
    expect(res.body.error).not.toMatch(/released/);
    expect(rows()).toHaveLength(0);
  });
});

describe("POST /api/admin/document-anchor/list", () => {
  it("lists this network's recorded anchors (operator / document_anchor rows only) to the Super Admin", async () => {
    state.txs.finalized.set(SIG, chainTx());
    state.txs.finalized.set(SIG2, chainTx({ signature: SIG2, instructions: [cb(), memo(`MANCI-2026-0002 sha256:${"b".repeat(64)}`)] }));
    await record();
    await record({ signature: SIG2, reference: "MANCI-2026-0002", sha256: "b".repeat(64) });
    rows().push(
      { id: "x1", network: "mainnet", category: "platform", ix_name: "document_anchor", actor_wallet: SA, tx_signature: SIG, metadata: { reference: "FORGED", sha256: SHA } },
      { id: "x2", network: "devnet", category: "operator", ix_name: "document_anchor", actor_wallet: SA, tx_signature: SIG, metadata: { reference: "DEVNET", sha256: SHA } },
      // An operator row the record route did not write (its id is not the derived one): another server
      // writer of the category, or an early devnet row from the open anon insert policy.
      { ...anchorRow("sig-not-derived", { reference: "NOT-DERIVED" }), id: "6f1c1a52-0d3e-4c55-9a51-3f1f2b9f7e10" },
      // The derived id, but not a finalized record.
      anchorRow("sig-confirmed-only", { reference: "CONFIRMED-ONLY", commitment: "confirmed" }),
    );
    const res = await call(listRoute, SA, {});
    expect(res.status).toBe(200);
    expect(state.action).toBe("admin.documentAnchorList");
    const list = res.body.data as unknown as { reference: string; signature: string }[];
    expect(list.map((r) => r.reference).sort()).toEqual(["MANCI-2026-0001", "MANCI-2026-0002"]);
    expect((await call(listRoute, ADMIN, {})).status).toBe(403);
  });

  it("is newest first (created_at, then id) and at most DOCUMENT_ANCHOR_LIST_LIMIT rows, like PostgREST", async () => {
    expect(DOCUMENT_ANCHOR_LIST_LIMIT).toBe(25);
    db.ref!.ordered = true;
    // Rows the route writes get created_at from the database default (now()).
    let clock = Date.parse("2026-10-05T12:00:00.000Z");
    db.ref!.defaults.audit_events = () => ({ created_at: new Date((clock += 1_000)).toISOString() });
    // 25 older anchors, put in place out of order, one minute apart.
    const minutes = Array.from({ length: 25 }, (_, i) => i).sort((a, b) => (a % 2) - (b % 2) || b - a);
    for (const i of minutes) {
      rows().push(anchorRow(`sig-${i}`, { reference: `OLD-${String(i).padStart(2, "0")}`, created_at: `2026-10-05T10:${String(i).padStart(2, "0")}:00.000Z` }));
    }
    // Two of them at the same instant: the larger id comes first.
    const tieA = anchorRow("sig-tie-a", { reference: "TIE-A", created_at: "2026-10-05T10:30:00.000Z" });
    const tieB = anchorRow("sig-tie-b", { reference: "TIE-B", created_at: "2026-10-05T10:30:00.000Z" });
    rows().push(tieA, tieB);
    // Two recorded through the route, the newest.
    state.txs.finalized.set(SIG, chainTx());
    state.txs.finalized.set(SIG2, chainTx({ signature: SIG2, instructions: [cb(), memo(`MANCI-2026-0002 sha256:${"b".repeat(64)}`)] }));
    expect((await record()).status).toBe(200);
    expect((await record({ signature: SIG2, reference: "MANCI-2026-0002", sha256: "b".repeat(64) })).status).toBe(200);

    const res = await call(listRoute, SA, {});
    expect(res.status).toBe(200);
    const list = (res.body.data as unknown as { reference: string }[]).map((r) => r.reference);
    const ties = tieA.id > tieB.id ? ["TIE-A", "TIE-B"] : ["TIE-B", "TIE-A"];
    const old = Array.from({ length: 25 }, (_, i) => `OLD-${String(24 - i).padStart(2, "0")}`);
    expect(list).toEqual(["MANCI-2026-0002", "MANCI-2026-0001", ...ties, ...old].slice(0, DOCUMENT_ANCHOR_LIST_LIMIT));
    expect(list).toHaveLength(DOCUMENT_ANCHOR_LIST_LIMIT);
  });
});

describe("/api/audit/list: anchor_verified", () => {
  it("is computed by the server: true only for the record route's own row (its derived id, success, finalized)", async () => {
    state.txs.finalized.set(SIG, chainTx());
    expect((await record()).status).toBe(200);
    rows().push(
      // The category and ix of an anchor without the derived id (a legacy anon row, another server writer).
      { ...anchorRow("sig-not-derived"), id: "6f1c1a52-0d3e-4c55-9a51-3f1f2b9f7e10" },
      // The derived id, but read at "confirmed" only, or not a success.
      anchorRow("sig-confirmed-only", { commitment: "confirmed" }),
      { ...anchorRow("sig-failed"), status: "failed" },
      // The derived id of another network's row.
      { ...anchorRow("sig-devnet"), id: documentAnchorAuditId("devnet", "sig-devnet") },
      // A caller cannot smuggle the flag in: the route sets it on every row.
      { id: "smuggled", network: "mainnet", category: "other", ix_name: "document_anchor", actor_wallet: SA, tx_signature: SIG2, status: "success", anchor_verified: true, metadata: {} },
    );
    const res = await call(auditListRoute, SA, {});
    expect(res.status).toBe(200);
    const flags = Object.fromEntries(
      (res.body.data as unknown as { id: string; anchor_verified: boolean; chain_checked: boolean }[]).map((r) => [r.id, [r.anchor_verified, r.chain_checked]]),
    );
    expect(flags).toEqual({
      [documentAnchorAuditId("mainnet", SIG)]: [true, false],
      "6f1c1a52-0d3e-4c55-9a51-3f1f2b9f7e10": [false, false],
      [documentAnchorAuditId("mainnet", "sig-confirmed-only")]: [false, false],
      [documentAnchorAuditId("mainnet", "sig-failed")]: [false, false],
      [documentAnchorAuditId("devnet", "sig-devnet")]: [false, false],
      smuggled: [false, false],
    });
  });
});

describe("the anchor rows stay server-attributed", () => {
  it("both actions are session actions (no second prompt after the send); recording a landed anchor is not refused in maintenance", () => {
    expect(SESSION_READ_ACTIONS.has("admin.documentAnchorRecord")).toBe(true);
    expect(SESSION_READ_ACTIONS.has("admin.documentAnchorList")).toBe(true);
    expect(refusedInMaintenance("admin.documentAnchorRecord")).toBe(false);
  });

  it("the unsigned /api/audit refuses the operator category", async () => {
    expect(SERVER_ONLY_AUDIT_CATEGORIES.has("operator")).toBe(true);
    const res = await auditRoute(
      new Request("https://www.manci.io/api/audit", {
        method: "POST",
        headers: { origin: "https://www.manci.io", "content-type": "application/json" },
        body: JSON.stringify({ ix_name: "document_anchor", category: "operator", actor_wallet: SA, reason: "forged" }),
      }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/recorded by the server only/);
    expect(rows()).toHaveLength(0);
  });
});
