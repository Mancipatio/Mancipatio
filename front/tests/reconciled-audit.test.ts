// lib/server/reconciled-audit: the retry worker's chain-checked "Send to
// wallets" row is recognized only by what the unsigned /api/audit cannot
// write — its id (derived from the network and the signature), actor
// "server" and metadata.actor_source "retry-worker" — and /api/audit/list
// hands that verdict to the admin audit page as chain_checked. A row posted
// to /api/audit with the worker's metadata markers is not chain-checked.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({
  verify: vi.fn(),
  admin: vi.fn(),
  rows: [] as Record<string, unknown>[],
}));
vi.mock("@/lib/server/siws", () => {
  class SiwsError extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    SiwsError,
    verifySigned: mocks.verify,
    siwsErrorResponse: (err: unknown) => Response.json({ ok: false }, { status: err instanceof SiwsError ? err.status : 500 }),
  };
});
vi.mock("@/lib/server/admin-gate", () => ({ requireAdmin: mocks.admin }));
vi.mock("@/lib/network", async (orig) => ({ ...(await orig<typeof import("@/lib/network")>()), detectNetwork: () => "mainnet" }));
vi.mock("@/lib/supabase-server", () => ({
  getSupabaseAdmin: () => {
    const query: Record<string, unknown> = {};
    for (const method of ["select", "eq", "order", "range"]) query[method] = () => query;
    query.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: mocks.rows, error: null }).then(resolve);
    return { from: () => query };
  },
}));

import { POST as list } from "@/app/api/audit/list/route";
import { reconciledAuditRow } from "@/lib/server/distribution-audits";
import { RECONCILED_METADATA_KEYS, isReconciledAuditRow, reconciledAuditId } from "@/lib/server/reconciled-audit";

const SIG = "5".repeat(88);
const OTHER_SIG = "4".repeat(88);
const WALLET = "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2";

/** The worker's row as the database returns it. */
const worker = (over: Record<string, unknown> = {}) => ({
  id: reconciledAuditId("mainnet", SIG),
  created_at: "2026-10-04T12:10:00.000Z",
  ix_name: "share_class_distribution",
  category: "share-class",
  actor_wallet: "server",
  target_label: null,
  tx_signature: SIG,
  reason: "Finalized on chain (checked by the server)",
  status: "success",
  metadata: { chain_outcome: "finalized", reconciled_by_server: true, reconciled_by: "retry-worker", actor_verified: false, actor_source: "retry-worker" },
  ...over,
});

describe("isReconciledAuditRow", () => {
  it("is the worker's row: its id from the signature, actor server, actor_source retry-worker, a final status", () => {
    expect(isReconciledAuditRow("mainnet", worker())).toBe(true);
    expect(isReconciledAuditRow("mainnet", worker({ status: "failed" }))).toBe(true);
    // Postgres answers a uuid in lower case; any case of the same id is the same row.
    expect(isReconciledAuditRow("mainnet", worker({ id: reconciledAuditId("mainnet", SIG).toUpperCase() }))).toBe(true);
  });

  it("is not a row /api/audit could store, whatever its metadata says", () => {
    // The finding's forged row: the worker's markers, the database's own id, the route's actor_source.
    const forged = worker({
      id: "0b8e5a9e-58a4-4f1e-9f7e-0a6f4d1c2b3a",
      status: "failed",
      metadata: { reconciled_by_server: true, chain_outcome: "finalized_with_error", actor_verified: false, actor_source: "client-unsigned" },
    });
    expect(isReconciledAuditRow("mainnet", forged)).toBe(false);
    // Each requirement on its own.
    expect(isReconciledAuditRow("mainnet", worker({ id: "0b8e5a9e-58a4-4f1e-9f7e-0a6f4d1c2b3a" }))).toBe(false);
    expect(isReconciledAuditRow("mainnet", worker({ id: reconciledAuditId("mainnet", OTHER_SIG) }))).toBe(false);
    expect(isReconciledAuditRow("mainnet", worker({ id: reconciledAuditId("devnet", SIG) }))).toBe(false);
    expect(isReconciledAuditRow("devnet", worker())).toBe(false);
    expect(isReconciledAuditRow("mainnet", worker({ actor_wallet: WALLET }))).toBe(false);
    expect(isReconciledAuditRow("mainnet", worker({ metadata: { reconciled_by_server: true, actor_source: "client-unsigned" } }))).toBe(false);
    expect(isReconciledAuditRow("mainnet", worker({ metadata: { reconciled_by_server: true, actor_source: "siws-session" } }))).toBe(false);
    expect(isReconciledAuditRow("mainnet", worker({ metadata: null }))).toBe(false);
    expect(isReconciledAuditRow("mainnet", worker({ status: "pending" }))).toBe(false);
    expect(isReconciledAuditRow("mainnet", worker({ ix_name: "sale_capacity_alert" }))).toBe(false);
    expect(isReconciledAuditRow("mainnet", worker({ tx_signature: null }))).toBe(false);
    expect(isReconciledAuditRow("mainnet", {})).toBe(false);
  });

  it("recognizes every row the worker writes, and /api/audit drops exactly the keys it asserts", () => {
    const base = {
      network: "mainnet" as const,
      signature: SIG,
      pendingIds: ["pending-1"],
      pendingRows: 1,
      pendingCreatedAt: "2026-10-04T12:00:00.000Z",
      claimsFrom: null,
      now: new Date("2026-10-04T12:10:00.000Z"),
    };
    const rows = [
      reconciledAuditRow({ ...base, outcome: { kind: "finalized", slot: BigInt(1), err: null } }),
      reconciledAuditRow({ ...base, outcome: { kind: "finalized", slot: BigInt(1), err: { InstructionError: [0, "Custom"] } } }),
      reconciledAuditRow({ ...base, outcome: { kind: "expired" } }),
    ];
    for (const row of rows) expect(isReconciledAuditRow("mainnet", row)).toBe(true);
    // The route stamps these three itself; every other key of the worker's row is one a caller may not send.
    const stamps = new Set(["server_received_at", "actor_verified", "actor_source"]);
    const asserted = new Set(rows.flatMap((row) => Object.keys(row.metadata)).filter((key) => !stamps.has(key)));
    expect([...asserted].sort()).toEqual([...RECONCILED_METADATA_KEYS].sort());
  });
});

describe("/api/audit/list: chain_checked", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verify.mockResolvedValue({ wallet: WALLET, params: {} });
    mocks.admin.mockResolvedValue(undefined);
  });

  it("is computed by the server for each row: true only for the worker's own row", async () => {
    const browser = worker({
      id: "1c0d9f2e-6b7a-4c3d-8e9f-0a1b2c3d4e5f",
      actor_wallet: WALLET,
      metadata: { run_id: "run-1", actor_verified: false, actor_source: "client-unsigned" },
    });
    const forged = worker({
      id: "0b8e5a9e-58a4-4f1e-9f7e-0a6f4d1c2b3a",
      status: "failed",
      metadata: { reconciled_by_server: true, chain_outcome: "finalized_with_error", actor_verified: false, actor_source: "client-unsigned" },
    });
    // A caller cannot smuggle the flag in either: the route sets it on every row.
    const smuggled = { ...forged, id: "2d1e0a3f-7c8b-4d4e-9f0a-1b2c3d4e5f60", chain_checked: true };
    mocks.rows = [worker(), browser, forged, smuggled, { metadata: { actor_verified: false } }];
    const res = await list(new Request("http://localhost/api/audit/list", { method: "POST", body: "{}" }));
    expect(res.status).toBe(200);
    expect(mocks.admin).toHaveBeenCalledWith(WALLET);
    const { data } = (await res.json()) as { data: { id?: string; chain_checked: boolean; metadata: unknown }[] };
    expect(data.map((r) => r.chain_checked)).toEqual([true, false, false, false, false]);
    // The rows are otherwise returned as stored.
    expect(data[2].metadata).toEqual(forged.metadata);
  });
});
