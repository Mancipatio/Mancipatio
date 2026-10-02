/**
 * `npm run ops:inspect-tx`: decodes a transaction copied from the "Ledger
 * (USB)" notice and prints the hash the Ledger must show; see
 * scripts/ops/inspect-tx.ts and ops/runbook-mainnet.md §5. Offline: no RPC,
 * no keys. The vitest file exists only to run TypeScript with the `@/` alias.
 */
import { it } from "vitest";
import { runInspectTx } from "./inspect-tx";

it("ops:inspect-tx", () => {
  runInspectTx(process.env, (line) => process.stdout.write(`${line}\n`));
});
