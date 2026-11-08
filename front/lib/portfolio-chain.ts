// A wallet's share-class history read from the chain, for the portfolio
// export (lib/portfolio-export.ts): every transaction that changed the
// wallet's balance of a share-class mint, the block time of each transaction
// read, and the current balances. Node-safe (no React, no browser API):
// tests/portfolio-chain.test.ts.
//
// Which accounts: the wallet's Token-2022 accounts of share-class mints
// (getTokenAccountsByOwner, empty ones included) and, for every mint its
// records name, the wallet's associated token account even when it was
// closed (a closed account's history stays readable). Which transactions:
// each account's signatures, newest first, at most MAX_EXPORT_SIGNATURES in
// all (a longer history keeps the newest and says it is incomplete), plus
// the records' own signatures (a purchase, a conversion's deposit and
// outcome) for their block times. Failed transactions move nothing.
//
// A transaction's balance change is read from its pre/post token balances,
// summed over every account the wallet owns for the mint, so a move between
// two of the wallet's own accounts nets to nothing. The owners of the
// mint's other accounts in the transaction are kept: an escrow's owner is
// the conversion vault or the OTC deal, which is how the export tells an
// escrow deposit from a transfer.
//
// Reads are retried on a rate limit (lib/rpc-retry.ts) and run a few at a
// time; a read that still fails makes the history incomplete (and the export
// says so), never wrong.

import type {
  Address,
  GetSignaturesForAddressApi,
  GetTokenAccountsByOwnerApi,
  GetTransactionApi,
  Rpc,
  Signature,
} from "@solana/kit";
import { findAssociatedTokenPda } from "@solana-program/token-2022";
import type { ChainHistory, ChainMovement } from "@/lib/portfolio-export";
import { withRpcReadRetry } from "@/lib/rpc-retry";

const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" as Address;
const ZERO = BigInt(0);
const AMOUNT_RE = /^\d{1,30}$/;

/** At most this many transactions are read per export (the newest ones). */
export const MAX_EXPORT_SIGNATURES = 500;
/** getSignaturesForAddress's page (its maximum). */
const SIGNATURE_PAGE = 1_000;
/** Transactions read at once. */
const HISTORY_CONCURRENCY = 4;

type TokenBalance = {
  accountIndex?: number | bigint;
  mint?: string;
  owner?: string;
  uiTokenAmount?: { amount?: string };
};

/** The part of a getTransaction answer this module reads. */
export type RawHistoryTransaction = {
  blockTime?: number | bigint | null;
  meta?: {
    err?: unknown;
    preTokenBalances?: readonly TokenBalance[] | null;
    postTokenBalances?: readonly TokenBalance[] | null;
  } | null;
};

function amountOf(balance: TokenBalance): bigint {
  const amount = balance.uiTokenAmount?.amount;
  if (typeof amount !== "string" || !AMOUNT_RE.test(amount)) throw new Error("Unreadable token balance");
  return BigInt(amount);
}

/** The wallet's balance changes of share-class mints in one transaction (pure). */
export function movementsFromTransaction(
  tx: RawHistoryTransaction,
  signature: string,
  owner: string,
  shareMints: ReadonlySet<string>,
): { blockTime: number | null; movements: ChainMovement[] } {
  const raw = tx.blockTime;
  const blockTime = raw === null || raw === undefined || !Number.isSafeInteger(Number(raw)) ? null : Number(raw);
  if (!tx.meta || tx.meta.err) return { blockTime, movements: [] };
  const deltas = new Map<string, bigint>();
  const owners = new Map<string, Set<string>>();
  const visit = (balances: readonly TokenBalance[] | null | undefined, sign: 1 | -1) => {
    for (const balance of balances ?? []) {
      if (!balance.mint || !shareMints.has(balance.mint)) continue;
      const set = owners.get(balance.mint) ?? new Set<string>();
      if (balance.owner) set.add(balance.owner);
      owners.set(balance.mint, set);
      const amount = amountOf(balance);
      if (balance.owner === owner) {
        deltas.set(balance.mint, (deltas.get(balance.mint) ?? ZERO) + (sign === 1 ? amount : -amount));
      }
    }
  };
  visit(tx.meta.preTokenBalances, -1);
  visit(tx.meta.postTokenBalances, 1);
  const movements: ChainMovement[] = [];
  for (const [mint, delta] of deltas) {
    if (delta === ZERO) continue;
    movements.push({ signature, blockTime, mint, delta, owners: [...(owners.get(mint) ?? [])].filter((o) => o !== owner) });
  }
  return { blockTime, movements };
}

type ParsedAccount = { pubkey: string; mint: string; amount: bigint };

/** jsonParsed Token-2022 accounts; throws on an answer that cannot be read (never a silent empty balance). */
function parseTokenAccounts(value: unknown): ParsedAccount[] {
  if (!Array.isArray(value)) throw new Error("Token accounts are unavailable");
  return value.map((item) => {
    const entry = item as { pubkey?: unknown; account?: { data?: unknown } };
    const info = (entry.account?.data as { parsed?: { info?: { mint?: unknown; tokenAmount?: { amount?: unknown } } } } | null)?.parsed?.info;
    const amount = info?.tokenAmount?.amount;
    if (typeof entry.pubkey !== "string" || typeof info?.mint !== "string" || typeof amount !== "string" || !AMOUNT_RE.test(amount)) {
      throw new Error("Token accounts could not be decoded");
    }
    return { pubkey: entry.pubkey, mint: info.mint, amount: BigInt(amount) };
  });
}

export type ShareHistoryRpc = Rpc<GetTokenAccountsByOwnerApi & GetSignaturesForAddressApi & GetTransactionApi>;

/**
 * Reads the history (see the header). Throws only when the wallet's token
 * accounts cannot be read at all; any later failure returns an incomplete
 * history with its reason.
 */
export async function loadShareHistory(
  rpc: ShareHistoryRpc,
  owner: Address,
  input: {
    shareMints: ReadonlySet<string>;
    /** Mints the records name: their associated token account is read even when closed. */
    recordMints: ReadonlySet<string>;
    /** Signatures the records name: read for their block times. */
    recordSignatures: ReadonlySet<string>;
    maxSignatures?: number;
    onProgress?: (done: number, total: number) => void;
    signal?: AbortSignal;
  },
): Promise<ChainHistory> {
  const signal = input.signal;
  const max = input.maxSignatures ?? MAX_EXPORT_SIGNATURES;
  const accountsAnswer = await withRpcReadRetry(
    (abortSignal) =>
      rpc
        .getTokenAccountsByOwner(owner, { programId: TOKEN_2022 }, { encoding: "jsonParsed" })
        .send({ abortSignal: abortSignal ?? AbortSignal.timeout(15_000) }),
    { signal },
  );
  const accounts = parseTokenAccounts(accountsAnswer.value).filter((a) => input.shareMints.has(a.mint));
  const balances = new Map<string, bigint>();
  for (const account of accounts) balances.set(account.mint, (balances.get(account.mint) ?? ZERO) + account.amount);

  const addresses = new Set(accounts.map((a) => a.pubkey));
  for (const mint of input.recordMints) {
    const [ata] = await findAssociatedTokenPda({ owner, mint: mint as Address, tokenProgram: TOKEN_2022 });
    addresses.add(ata.toString());
  }

  const problems: string[] = [];
  const listed = new Map<string, number | null>();
  let cut = false;
  for (const address of addresses) {
    let before: Signature | undefined;
    for (;;) {
      let page: readonly { signature: Signature; blockTime: unknown; err: unknown }[];
      try {
        page = await withRpcReadRetry(
          (abortSignal) =>
            rpc
              .getSignaturesForAddress(address as Address, { limit: SIGNATURE_PAGE, before, commitment: "confirmed" })
              .send({ abortSignal: abortSignal ?? AbortSignal.timeout(15_000) }),
          { signal },
        );
      } catch (error) {
        if (signal?.aborted) throw error;
        problems.push("the transaction list of an account could not be read");
        break;
      }
      for (const entry of page) {
        if (entry.err) continue;
        const time = entry.blockTime === null || entry.blockTime === undefined ? null : Number(entry.blockTime);
        listed.set(entry.signature, Number.isSafeInteger(time) ? time : null);
      }
      // A short page is the last one; a page that ends where it began would loop.
      const last = page[page.length - 1]?.signature;
      if (page.length < SIGNATURE_PAGE || last === undefined || last === before) break;
      if (listed.size >= max) {
        cut = true;
        break;
      }
      before = last;
    }
  }
  // Newest first, at most `max`; the records' own signatures are always read.
  let signatures = [...listed.entries()].sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0)).map(([s]) => s);
  if (signatures.length > max) {
    cut = true;
    signatures = signatures.slice(0, max);
  }
  const toRead = [...new Set([...signatures, ...input.recordSignatures])];
  if (cut) problems.push(`only the newest ${max} transactions were read`);

  const movements: ChainMovement[] = [];
  const blockTimes = new Map<string, number>();
  let failed = 0;
  let done = 0;
  input.onProgress?.(0, toRead.length);
  for (let i = 0; i < toRead.length; i += HISTORY_CONCURRENCY) {
    const chunk = toRead.slice(i, i + HISTORY_CONCURRENCY);
    await Promise.all(
      chunk.map(async (signature) => {
        try {
          const tx = await withRpcReadRetry(
            (abortSignal) =>
              rpc
                .getTransaction(signature as Signature, {
                  encoding: "json",
                  maxSupportedTransactionVersion: 0,
                  commitment: "confirmed",
                })
                .send({ abortSignal: abortSignal ?? AbortSignal.timeout(15_000) }),
            { signal },
          );
          if (!tx) {
            failed += 1;
            return;
          }
          const read = movementsFromTransaction(tx as unknown as RawHistoryTransaction, signature, owner.toString(), input.shareMints);
          if (read.blockTime !== null) blockTimes.set(signature, read.blockTime);
          movements.push(...read.movements);
        } catch (error) {
          if (signal?.aborted) throw error;
          failed += 1;
        } finally {
          done += 1;
          input.onProgress?.(done, toRead.length);
        }
      }),
    );
  }
  if (failed > 0) problems.push(`${failed} transaction${failed === 1 ? "" : "s"} could not be read`);
  return {
    movements,
    blockTimes,
    balances,
    complete: problems.length === 0,
    problem: problems.length ? problems.join("; ") : null,
  };
}
