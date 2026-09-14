// lib/server/vesting-mint-gate.ts × /api/vesting-series/{create,update,
// admin-review} (F05 residual): the input-time mint check in the issuer form
// is client-only. A request submitted through the SIWS API directly, or a
// mint whose Token-2022 extensions / hook binding changed after submission,
// could still be APPROVED and only fail at prepare-creation — where approved
// terms are immutable and the client can only abandon the request. These
// tests pin the authoritative server gates: submission and resubmission
// refuse an unsupported mint, approval refuses it with a "send back" hint,
// RPC trouble is a retryable 503 (never "the mint is bad"), and the
// non-approval decisions stay possible for a request with a bad mint.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Address } from "@solana/kit";
import { getMintEncoder } from "@solana-program/token-2022";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  params: {} as Record<string, unknown>,
  wallet: "",
  row: null as Record<string, unknown> | null,
  inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
  updates: [] as Array<{ table: string; patch: Record<string, unknown> }>,
  rpc: null as unknown,
  rpcCalls: 0,
}));

vi.mock("@/lib/server/siws", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/server/siws")>();
  return {
    ...real,
    verifySigned: vi.fn(async () => ({
      wallet: state.wallet,
      params: state.params,
    })),
  };
});
vi.mock("@/lib/server/admin-gate", () => ({
  requireAdmin: vi.fn(async () => {}),
  requireSuperAdmin: vi.fn(async () => {}),
}));
vi.mock("@/lib/server/kyc-gate", () => ({
  requireVerifiedClient: vi.fn(async () => ({ clientId: "client-1" })),
}));
vi.mock("@/lib/server/rpc", () => ({
  getServerRpc: () => state.rpc,
}));
vi.mock("@/lib/supabase-server", () => ({
  getSupabaseAdmin: () => ({
    from: (table: string) => {
      let pendingInsert: Record<string, unknown> | null = null;
      let pendingUpdate: Record<string, unknown> | null = null;
      const terminal = async () => {
        if (pendingInsert) {
          state.inserts.push({ table, row: pendingInsert });
          return { data: { id: "series-1" }, error: null };
        }
        if (pendingUpdate) {
          state.updates.push({ table, patch: pendingUpdate });
          return { data: { id: state.row?.id ?? "series-1" }, error: null };
        }
        return { data: table === "vesting_series" ? state.row : null, error: null };
      };
      const builder = {
        select: () => builder,
        eq: () => builder,
        is: () => builder,
        insert: (row: Record<string, unknown>) => {
          pendingInsert = row;
          return builder;
        },
        update: (patch: Record<string, unknown>) => {
          pendingUpdate = patch;
          return builder;
        },
        single: terminal,
        maybeSingle: terminal,
        then: (
          resolve: (v: unknown) => unknown,
          reject?: (e: unknown) => unknown,
        ) => terminal().then(resolve, reject),
      };
      return builder;
    },
  }),
}));

import { TOKEN_2022, TOKEN_CLASSIC } from "@/lib/transaction-builders";
import { SiwsError } from "@/lib/server/siws";
import { requireSupportedVestingMint } from "@/lib/server/vesting-mint-gate";
import { POST as createRoute } from "@/app/api/vesting-series/create/route";
import { POST as updateRoute } from "@/app/api/vesting-series/update/route";
import { POST as reviewRoute } from "@/app/api/vesting-series/admin-review/route";

const CLIENT = "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2" as Address;
const ADMIN = "11111111111111111111111111111111";
const CLASSIC_MINT = "8sHgqRqBEXaSkhcyzXtY3vBSfGqBbTeR2SkVFDcxrfd9" as Address;
const T22_MINT = "6D6TgUKrYY6dJrCUZ6LcJKt5EGGdCUgHtVeUKmRZbUJ2" as Address;
const NON_TRANSFERABLE = "4KcVAsHCdcCPpDxYPHV7ZLcTU1sfKZBLZTz3H1B5mMhx" as Address;
const MISSING = "3n1mQ6zsrVpQyzFCkr9qFVGgU3qHiHQeAvGtaVJk9oNr" as Address;

const base = {
  mintAuthority: CLIENT,
  supply: BigInt(10),
  decimals: 6,
  isInitialized: true,
  freezeAuthority: null,
};
const plainMint = () =>
  new Uint8Array(getMintEncoder().encode({ ...base, extensions: null }));
const ACCOUNTS: Record<string, { owner: Address; data: Uint8Array }> = {
  [CLASSIC_MINT]: { owner: TOKEN_CLASSIC, data: plainMint() },
  [T22_MINT]: { owner: TOKEN_2022, data: plainMint() },
  [NON_TRANSFERABLE]: {
    owner: TOKEN_2022,
    data: new Uint8Array(
      getMintEncoder().encode({
        ...base,
        extensions: [{ __kind: "NonTransferable" }],
      }),
    ),
  },
};

function stubRpc(fail?: Error) {
  return {
    getAccountInfo: (address: Address) => ({
      send: async () => {
        state.rpcCalls += 1;
        if (fail) throw fail;
        const account = ACCOUNTS[address.toString()];
        return {
          context: { slot: BigInt(1) },
          value: account
            ? {
                data: [Buffer.from(account.data).toString("base64"), "base64"],
                owner: account.owner,
                executable: false,
                lamports: BigInt(1),
                space: BigInt(account.data.length),
                rentEpoch: BigInt(0),
              }
            : null,
        };
      },
    }),
  };
}
type Rpc = Parameters<typeof requireSupportedVestingMint>[0];

const FUTURE = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;

function formParams(tokenMint: string): Record<string, unknown> {
  return {
    token_mint: tokenMint,
    token_label: "Test vesting",
    timing_mode: "auto",
    delivery_mode: "claim",
    approval_window_secs: 0,
    pre_cliff_bps: 0,
    recovery_enabled: false,
    cancellation_enabled: false,
    schedule: [{ unlock_ts: FUTURE, amount: "100" }],
    recipients: [{ wallet: CLIENT, allocation: "100" }],
  };
}

function submittedRow(tokenMint: string): Record<string, unknown> {
  return {
    id: "series-1",
    network: "devnet",
    client_wallet: CLIENT,
    status: "submitted",
    updated_at: "2026-09-08T00:00:00.000Z",
    approved_terms_hash: null,
    series_pda: null,
    ...formParams(tokenMint),
  };
}

const request = () =>
  new Request("http://localhost/api/vesting-series/x", { method: "POST" });

beforeEach(() => {
  state.params = {};
  state.wallet = CLIENT;
  state.row = null;
  state.inserts = [];
  state.updates = [];
  state.rpc = stubRpc();
  state.rpcCalls = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("requireSupportedVestingMint", () => {
  it("returns the owning program for a supported mint", async () => {
    const rpc = state.rpc as Rpc;
    expect(await requireSupportedVestingMint(rpc, CLASSIC_MINT, "submission")).toBe(
      TOKEN_CLASSIC,
    );
    expect(await requireSupportedVestingMint(rpc, ` ${T22_MINT} `, "approval")).toBe(
      TOKEN_2022,
    );
  });

  it("refuses an unsupported mint with 400 and stage-specific copy", async () => {
    const rpc = state.rpc as Rpc;
    await expect(
      requireSupportedVestingMint(rpc, NON_TRANSFERABLE, "submission"),
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/^Unsupported token mint: .*NonTransferable/),
    });
    await expect(
      requireSupportedVestingMint(rpc, NON_TRANSFERABLE, "approval"),
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(
        /^Cannot approve: .*NonTransferable.*Send the request back for changes/,
      ),
    });
    await expect(
      requireSupportedVestingMint(rpc, MISSING, "approval"),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      requireSupportedVestingMint(rpc, "not-a-mint", "submission"),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("fails closed with a retryable 503 when the RPC cannot answer", async () => {
    const flaky = stubRpc(new TypeError("Failed to fetch")) as unknown as Rpc;
    const error = await requireSupportedVestingMint(
      flaky,
      CLASSIC_MINT,
      "approval",
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SiwsError);
    expect((error as SiwsError).status).toBe(503);
    expect((error as SiwsError).message).toMatch(/Could not verify the mint/);
    expect((error as SiwsError).message).toMatch(/was not approved/);
    expect((error as SiwsError).message).not.toMatch(/Re-check before submitting/);
  });
});

describe("POST /api/vesting-series/create", () => {
  it("stores a request for a supported mint", async () => {
    state.params = formParams(T22_MINT);
    const res = await createRoute(request());
    expect(res.status).toBe(200);
    expect(state.inserts.map((i) => i.table)).toEqual([
      "vesting_series",
      "vesting_series_events",
    ]);
    expect(state.inserts[0].row).toMatchObject({
      token_mint: T22_MINT,
      status: "submitted",
    });
  });

  it("refuses an unsupported mint before anything is persisted", async () => {
    state.params = formParams(NON_TRANSFERABLE);
    const res = await createRoute(request());
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/NonTransferable/);
    expect(state.inserts).toEqual([]);
  });

  it("answers 503 (not 'unsupported') when the RPC is down", async () => {
    state.rpc = stubRpc(new TypeError("fetch failed"));
    state.params = formParams(CLASSIC_MINT);
    const res = await createRoute(request());
    expect(res.status).toBe(503);
    expect(state.inserts).toEqual([]);
  });
});

describe("POST /api/vesting-series/update", () => {
  it("refuses a resubmission that switches to an unsupported mint", async () => {
    state.row = { ...submittedRow(CLASSIC_MINT), status: "needs_changes" };
    state.params = { id: "series-1", ...formParams(NON_TRANSFERABLE) };
    const res = await updateRoute(request());
    expect(res.status).toBe(400);
    expect(state.updates).toEqual([]);
    expect(state.inserts).toEqual([]);
  });

  it("resubmits with a supported mint", async () => {
    state.row = { ...submittedRow(CLASSIC_MINT), status: "needs_changes" };
    state.params = { id: "series-1", ...formParams(T22_MINT) };
    const res = await updateRoute(request());
    expect(res.status).toBe(200);
    expect(state.updates[0]?.patch).toMatchObject({
      token_mint: T22_MINT,
      status: "submitted",
    });
  });
});

describe("POST /api/vesting-series/admin-review", () => {
  beforeEach(() => {
    state.wallet = ADMIN;
  });

  it("approves a request whose mint passes the live check", async () => {
    state.row = submittedRow(CLASSIC_MINT);
    state.params = { id: "series-1", decision: "approved" };
    const res = await reviewRoute(request());
    expect(res.status).toBe(200);
    expect(state.rpcCalls).toBeGreaterThan(0);
    expect(state.updates[0]?.patch).toMatchObject({ status: "approved" });
    expect(state.updates[0]?.patch.approved_terms_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(state.inserts[0]?.row).toMatchObject({ action: "approved" });
  });

  it("refuses to approve a request whose mint is unsupported NOW", async () => {
    // The row passed shape validation at submission; only the live extension
    // state (here: NonTransferable) makes it unrealizable.
    state.row = submittedRow(NON_TRANSFERABLE);
    state.params = { id: "series-1", decision: "approved" };
    const res = await reviewRoute(request());
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/^Cannot approve/);
    expect(body.error).toMatch(/NonTransferable/);
    expect(body.error).toMatch(/Send the request back for changes/);
    expect(state.updates).toEqual([]);
    expect(state.inserts).toEqual([]);
  });

  it("does not approve on RPC failure (503, nothing recorded)", async () => {
    state.rpc = stubRpc(new TypeError("Failed to fetch"));
    state.row = submittedRow(CLASSIC_MINT);
    state.params = { id: "series-1", decision: "approved" };
    const res = await reviewRoute(request());
    expect(res.status).toBe(503);
    expect(state.updates).toEqual([]);
  });

  it("still lets the team send back or reject a request with a bad mint", async () => {
    for (const decision of ["needs_changes", "rejected"]) {
      state.row = submittedRow(NON_TRANSFERABLE);
      state.updates = [];
      state.params = {
        id: "series-1",
        decision,
        reason: "Choose a mint the vesting flow can escrow",
      };
      const res = await reviewRoute(request());
      expect(res.status).toBe(200);
      expect(state.updates[0]?.patch).toMatchObject({ status: decision });
    }
    expect(state.rpcCalls).toBe(0);
  });
});
