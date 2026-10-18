// F072, the purchase path: the launchpad records a buy right after the send,
// so its evidence check almost always runs before finalization — and that
// "not yet" MUST stay a 503 here. processPurchaseJob marks a job whose check
// answered 4xx invalid for good, and only pending jobs are retried by the
// worker (lib/server/purchase-records.ts); the custody routes' typed 409
// (AwaitingFinalizationError) must never reach the queue. Run with the real
// requirePurchaseEvidence, unlike tests/purchase-retry-deadline.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
type DbResult = { data: unknown; error: null | { code?: string; message: string } };
const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  from: vi.fn(),
  calls: [] as Array<[string, ...unknown[]]>,
  responses: [] as DbResult[],
}));
vi.mock("@/lib/network", () => ({ detectNetwork: () => "devnet" }));
vi.mock("@/lib/server/rpc", () => ({
  getServerRpc: () => ({
    getTransaction: (...args: unknown[]) => ({ send: () => mocks.transaction(...args) }),
  }),
}));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseAdmin: () => ({ from: mocks.from }) }));
import { getBase58Decoder } from "@solana/kit";
import {
  AwaitingFinalizationError,
  PURCHASE_NOT_FINALIZED_MESSAGE,
  requirePurchaseEvidence,
} from "@/lib/server/chain-evidence";
import { processPurchaseJob } from "@/lib/server/purchase-records";
import { SiwsError } from "@/lib/server/siws";

const signature = getBase58Decoder().decode(new Uint8Array(64).fill(9));
const JOB = { id: "job-1", network: "devnet", buyer: "buyer", sale_pubkey: "sale", signature, requested_instruction: -1, attempts: 2 };
const commitments = () => mocks.transaction.mock.calls.map((c) => (c[1] as { commitment: string }).commitment);
const update = () => mocks.calls.find(([method]) => method === "update")?.[1] as Record<string, unknown> | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.calls.length = 0;
  mocks.responses.length = 0;
  mocks.from.mockImplementation((table: string) => {
    mocks.calls.push(["from", table]);
    const query = Object.fromEntries(
      ["select", "eq", "neq", "lte", "order", "limit", "insert", "update", "single", "maybeSingle", "abortSignal"].map((method) => [
        method,
        (...args: unknown[]) => {
          mocks.calls.push([method, ...args]);
          return query;
        },
      ]),
    ) as Record<string, unknown>;
    query.then = (resolve: (value: DbResult) => unknown) =>
      Promise.resolve(mocks.responses.shift() ?? { data: null, error: null }).then(resolve);
    return query;
  });
});
afterEach(() => vi.restoreAllMocks());

describe("a purchase recorded before finalization stays a pending job", () => {
  it("requirePurchaseEvidence answers the 503 of before (not the custody 409) while the node does not show the transaction at finalized", async () => {
    mocks.transaction.mockResolvedValue(null);
    const error = await requirePurchaseEvidence(signature, JOB.sale_pubkey, JOB.buyer).then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(SiwsError);
    expect(error).not.toBeInstanceOf(AwaitingFinalizationError);
    expect(error).toMatchObject({ status: 503, message: PURCHASE_NOT_FINALIZED_MESSAGE });
    // One finalized read (and the wording's confirmed one): no ~6 s of re-reads
    // before the route's 202 — the queue's worker is the retry.
    expect(commitments()).toEqual(["finalized", "confirmed"]);
  });
  it("processPurchaseJob with the real check: status pending, the job stays pending with its next attempt scheduled, nothing thrown", async () => {
    mocks.transaction.mockResolvedValue(null);
    await expect(processPurchaseJob(JOB)).resolves.toMatchObject({ status: "pending", id: null, jobId: JOB.id });
    expect(update()).toMatchObject({ status: "pending", attempts: JOB.attempts + 1, last_error: PURCHASE_NOT_FINALIZED_MESSAGE });
    expect(typeof update()?.next_attempt_at).toBe("string");
    expect(mocks.calls).toContainEqual(["neq", "status", "complete"]);
    expect(mocks.calls.some(([method]) => method === "insert")).toBe(false);
  });
  it("a transaction the network ran and failed is still invalid for good (400)", async () => {
    mocks.transaction.mockResolvedValue({ slot: 5, meta: { err: { InstructionError: [0, "Custom"] } } });
    await expect(processPurchaseJob(JOB)).rejects.toMatchObject({ status: 400 });
    expect(update()).toMatchObject({ status: "invalid" });
  });
});
