// A send is "done" only when the network says so. `tx.send` (the verified
// client's prepareAndSend) returns once the transaction is SUBMITTED; the
// success toast, the audit row and the page's refresh must wait for the
// confirmation, or a refresh reads the state from before the send and a
// "sent" audit row records a transfer the network may still refuse.
//
// confirmThenReport is that order in one place, for the single send
// (ShareTransferPanel), the treasury mint (lib/treasury-mint) and the
// distribution: wait → report the outcome → then settle (refresh).
//
// Pure and node-safe: tests/send-outcome.test.ts checks the order with fakes.
import type { SignatureOutcome } from "@/lib/simulation-gate";

export type SendReport = {
  /** The network confirmed it: success toast and audit row. */
  confirmed: () => void | Promise<void>;
  /** The network refused it: nothing moved. */
  failed: () => void | Promise<void>;
  /** Not confirmed in time, or the status could not be read: it may still land. */
  unconfirmed: (outcome: Exclude<SignatureOutcome, "confirmed" | "failed">) => void | Promise<void>;
  /** After the report, whatever the outcome: re-read the page's data. */
  settled?: (outcome: SignatureOutcome) => void | Promise<void>;
};

/** Waits for the outcome, reports it, then settles; returns the outcome. */
export async function confirmThenReport(wait: () => Promise<SignatureOutcome>, report: SendReport): Promise<SignatureOutcome> {
  const outcome = await wait();
  if (outcome === "confirmed") await report.confirmed();
  else if (outcome === "failed") await report.failed();
  else await report.unconfirmed(outcome);
  try {
    await report.settled?.(outcome);
  } catch {
    // The page's own refresh: the send has already settled and been reported.
  }
  return outcome;
}
