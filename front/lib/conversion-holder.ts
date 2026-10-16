import type { Address } from "@solana/kit";
import type { SolanaClient } from "@solana/client";

type TokenAccount = { pubkey: string; account: { data: unknown } };
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" as Address;

/** Several token accounts can hold the same mint. An unreadable response is
 * unknown ownership, never a successful empty balance or a partial total. */
export function conversionBalances(rows: readonly TokenAccount[]): Map<string, bigint> {
  const balances = new Map<string, bigint>();
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.pubkey)) continue;
    seen.add(row.pubkey);
    const info = (row.account.data as { parsed?: { info?: { mint?: unknown; tokenAmount?: { amount?: unknown } } } } | null)?.parsed?.info;
    const amount = info?.tokenAmount?.amount;
    if (typeof info?.mint !== "string" || !info.mint || typeof amount !== "string" || !/^\d+$/.test(amount)) {
      throw new Error("Could not verify your token balances. Please try again.");
    }
    const balance = BigInt(amount);
    if (balance > BigInt(0)) balances.set(info.mint, (balances.get(info.mint) ?? BigInt(0)) + balance);
  }
  return balances;
}

/** Unlike the portfolio's best-effort reader, an RPC failure remains visible. */
export async function loadConversionBalances(rpc: SolanaClient["runtime"]["rpc"], owner: Address) {
  const response = await rpc.getTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM }, { encoding: "jsonParsed" }).send();
  return conversionBalances(response.value);
}

/** Older loads and requests started before a wallet change cannot commit. */
export function latestConversionRead() {
  let revision = 0;
  return {
    begin(isCurrent: () => boolean) {
      const started = ++revision;
      return () => started === revision && isCurrent();
    },
    invalidate() { revision++; },
  };
}

export function validConversionAmount(amount: string, balance: bigint): boolean {
  const value = amount.trim();
  if (!/^\d+$/.test(value)) return false;
  const units = BigInt(value);
  return units > BigInt(0) && units <= balance && units <= BigInt(Number.MAX_SAFE_INTEGER);
}
