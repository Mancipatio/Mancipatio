// The burn's finality wait behind Confirm conversion / Confirm delivery: the
// evidence API verifies a realize at `finalized`, so the handler saves the
// receipt, waits for the signature to be finalized (bounded, never throwing)
// and only then records — the first recording is the one that succeeds.
import { describe, expect, it, vi } from "vitest";
import {
  REALIZE_FINALITY_TIMEOUT_MS,
  waitForFinalizedSignature,
} from "@/lib/custody-authority";

type Status = { err: unknown; confirmationStatus: string } | null;
type Rpc = Parameters<typeof waitForFinalizedSignature>[0];

/** An RPC whose status reads answer in order; an Error is a failed read. */
function rpcWith(...answers: (Status | Error)[]) {
  const statuses = vi.fn();
  for (const answer of answers) {
    if (answer instanceof Error) statuses.mockRejectedValueOnce(answer);
    else statuses.mockResolvedValueOnce({ value: [answer] });
  }
  return { statuses, rpc: { getSignatureStatuses: () => ({ send: statuses }) } as unknown as Rpc };
}
const noSleep = async () => {};
const confirmed: Status = { err: null, confirmationStatus: "confirmed" };
const finalized: Status = { err: null, confirmationStatus: "finalized" };

describe("waitForFinalizedSignature", () => {
  it("polls until finalized; a status not yet known, a failed read and a mere confirmation count as not yet", async () => {
    const polled = rpcWith(null, new Error("down"), confirmed, finalized);
    expect(await waitForFinalizedSignature(polled.rpc, "s", { sleep: noSleep })).toBe("finalized");
    expect(polled.statuses).toHaveBeenCalledTimes(4);
  });

  it("a transaction that landed with an error is failed", async () => {
    const failed = rpcWith({ err: { InstructionError: [0, "X"] }, confirmationStatus: "processed" });
    expect(await waitForFinalizedSignature(failed.rpc, "s", { sleep: noSleep })).toBe("failed");
  });

  it("gives up at the timeout without throwing, and defaults to the handler's window", async () => {
    const never = rpcWith(null, null, null);
    expect(await waitForFinalizedSignature(never.rpc, "s", { timeoutMs: 0, sleep: noSleep })).toBe("timeout");
    expect(never.statuses).toHaveBeenCalledTimes(1);
    expect(REALIZE_FINALITY_TIMEOUT_MS).toBe(45_000);
    expect(REALIZE_FINALITY_TIMEOUT_MS).toBeLessThan(60_000);
  });

  it("cuts each status read off with its own signal", async () => {
    const seen: (AbortSignal | undefined)[] = [];
    const rpc = {
      getSignatureStatuses: () => ({
        send: async (options?: { abortSignal?: AbortSignal }) => {
          seen.push(options?.abortSignal);
          return { value: [finalized] };
        },
      }),
    } as unknown as Rpc;
    expect(await waitForFinalizedSignature(rpc, "s", { sleep: noSleep })).toBe("finalized");
    expect(seen[0]).toBeInstanceOf(AbortSignal);
  });
});
