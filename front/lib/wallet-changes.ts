// What a wallet changed in a transaction while signing it.
//
// @solana/client accepts a wallet's modified message (modifyAndSignTransactions)
// and sends that one. Wallets do this to add their own priority fee or
// guard instructions; when the result is invalid for the network (a second
// compute-budget instruction, another network's blockhash), the RPC refuses
// it before execution with no program logs, and the error alone does not
// say why. The guarded wallet session (lib/guarded-wallet-connectors) keeps
// a one-line description of the latest change here, logs it to the console,
// and lib/tx-error adds it to the explanation of such a refusal.
import { getCompiledTransactionMessageDecoder, type ReadonlyUint8Array } from "@solana/kit";
import { COMPUTE_BUDGET_PROGRAM_ADDRESS, decodeComputeBudgetInstruction } from "@/lib/compute-budget";

type MessageSummary = { lifetime: string; instructions: string[] };

const COMPUTE_BUDGET_KINDS: Record<number, string> = {
  0: "RequestUnits",
  1: "RequestHeapFrame",
  4: "SetLoadedAccountsDataSizeLimit",
};

function short(value: string): string {
  return value.length > 10 ? `${value.slice(0, 4)}…${value.slice(-4)}` : value;
}

function summarize(messageBytes: ReadonlyUint8Array): MessageSummary {
  const message = getCompiledTransactionMessageDecoder().decode(messageBytes);
  const accounts = message.staticAccounts;
  const instructions = message.instructions.map((ix) => {
    const program = accounts[ix.programAddressIndex];
    if (!program) return "(lookup-table program)";
    if (program === COMPUTE_BUDGET_PROGRAM_ADDRESS) {
      const decoded = decodeComputeBudgetInstruction({ programAddress: program, data: ix.data });
      if (decoded?.kind === "limit") return `SetComputeUnitLimit(${decoded.units})`;
      if (decoded?.kind === "price") return `SetComputeUnitPrice(${decoded.microLamports})`;
      const kind = ix.data?.[0];
      return `ComputeBudget.${(kind !== undefined && COMPUTE_BUDGET_KINDS[kind]) || `#${kind ?? "?"}`}`;
    }
    return short(program);
  });
  return { lifetime: String(message.lifetimeToken), instructions };
}

function sameBytes(a: ReadonlyUint8Array, b: ReadonlyUint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * One line naming what the wallet changed between the message it was given
 * and the one it signed, or null when they are identical.
 */
export function describeWalletChange(
  before: ReadonlyUint8Array | undefined,
  after: ReadonlyUint8Array | undefined,
): string | null {
  if (!before || !after || sameBytes(before, after)) return null;
  let a: MessageSummary;
  let b: MessageSummary;
  try {
    a = summarize(before);
    b = summarize(after);
  } catch {
    return "the wallet changed the transaction before signing it";
  }
  const parts: string[] = [];
  if (a.lifetime !== b.lifetime) parts.push("replaced its blockhash");
  if (a.instructions.join() !== b.instructions.join()) {
    parts.push(`changed its instructions [${a.instructions.join(", ")}] → [${b.instructions.join(", ")}]`);
  }
  if (parts.length === 0) parts.push("changed its accounts or header");
  return `the wallet ${parts.join(" and ")} before signing`;
}

/** How long a noted change is attached to a failed send's explanation. */
export const WALLET_CHANGE_TTL_MS = 120_000;

let latest: { at: number; text: string } | null = null;

/** Called by the guarded session before each signing request. */
export function clearWalletChange(): void {
  latest = null;
}

/** Called by the guarded session when the wallet returned a different message. */
export function noteWalletChange(text: string, now: number = Date.now()): void {
  latest = { at: now, text };
}

/** The change noted for the latest signing request, if it is recent. */
export function recentWalletChange(now: number = Date.now()): string | null {
  return latest && now - latest.at <= WALLET_CHANGE_TTL_MS ? latest.text : null;
}
