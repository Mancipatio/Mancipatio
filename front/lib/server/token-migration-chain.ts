// SERVER-ONLY — the chain reads of the token migration routes
// (app/api/token-migrations). Every read goes through the network-verified
// server RPC (lib/server/rpc.ts) and fails CLOSED: an RPC failure is a 503
// ("try again"), never an empty answer, and a mismatch is a 4xx with the
// reason. Kept apart from lib/server/token-migrations.ts (the database side)
// so the route tests can stand in for the chain alone.

import "server-only";

import {
  address,
  fetchEncodedAccount,
  fetchEncodedAccounts,
  isSome,
  type Address,
  type MaybeEncodedAccount,
  type Signature,
} from "@solana/kit";
import { AccountState, getMintDecoder, getTokenDecoder } from "@solana-program/token-2022";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  fetchMaybeAsset,
  fetchMaybeIssuer,
  fetchMaybeShareClass,
  findAssetPda,
  findIssuerPda,
} from "@/lib/generated/asset_registry";
import { findShareClassPda } from "@/lib/pdas";
import { getServerRpc } from "@/lib/server/rpc";
import { SiwsError } from "@/lib/server/siws";
import { inspectOldMint, type OldMintVerdict } from "@/lib/token-migration/old-mint";
import { TOKEN_PROGRAM_2022 } from "@/lib/token-migration/model";
import { associatedTokenAccount } from "@/lib/token-migration/transactions";

const READ_TIMEOUT_MS = 12_000;
const read = () => ({ commitment: "confirmed" as const, abortSignal: AbortSignal.timeout(READ_TIMEOUT_MS) });

function unavailable(what: string, err: unknown): never {
  if (err instanceof SiwsError) throw err;
  console.error(`[token-migrations] ${what}:`, err instanceof Error ? err.message : String(err));
  throw new SiwsError(503, "The Solana network could not be read right now — try again");
}

/** The old mint's verdict (lib/token-migration/old-mint.ts), read at `confirmed`. 400 when the address is not a mint. */
export async function readOldMint(oldMint: string): Promise<OldMintVerdict> {
  let account: MaybeEncodedAccount;
  try {
    account = await fetchEncodedAccount(getServerRpc(), address(oldMint), read());
  } catch (err) {
    unavailable("old mint read failed", err);
  }
  if (!account.exists) throw new SiwsError(400, "There is no account at that mint address on this network");
  try {
    return inspectOldMint({ programAddress: account.programAddress, data: account.data });
  } catch (err) {
    throw new SiwsError(400, err instanceof Error ? err.message : "That address is not a token mint");
  }
}

type TokenAccountFacts = { mint: string; owner: string; amount: bigint; frozen: boolean; delegated: boolean; closeAuthority: boolean };

function decodeTokenAccount(account: MaybeEncodedAccount, program: string): TokenAccountFacts | null {
  if (!account.exists || account.programAddress !== program || account.data.length < 165) return null;
  try {
    const t = getTokenDecoder().decode(account.data);
    return {
      mint: t.mint.toString(),
      owner: t.owner.toString(),
      amount: t.amount,
      frozen: t.state === AccountState.Frozen,
      delegated: isSome(t.delegate) && t.delegatedAmount > BigInt(0),
      closeAuthority: isSome(t.closeAuthority),
    };
  } catch {
    return null;
  }
}

export type ExcludedBalance = {
  /** The address as the operator entered it. */
  address: string;
  /** "token-account": the address is a token account of the old mint; "owner": the sum of its token accounts of the old mint. */
  kind: "token-account" | "owner";
  amount: bigint;
};

/**
 * The balance of the old mint behind each excluded address: a token account
 * of the mint counts itself (a liquidity pool's vault account, for example);
 * any other address counts as an owner, and every token account it owns of
 * the mint is summed. At most 100 addresses (the column's own limit).
 */
export async function readExcludedBalances(oldMint: string, program: string, addresses: readonly string[]): Promise<ExcludedBalance[]> {
  if (addresses.length === 0) return [];
  try {
    const rpc = getServerRpc();
    const accounts = await fetchEncodedAccounts(rpc, addresses.map((a) => address(a)), read());
    const out: ExcludedBalance[] = [];
    for (let i = 0; i < addresses.length; i++) {
      const asToken = decodeTokenAccount(accounts[i], program);
      if (asToken && asToken.mint === oldMint) {
        out.push({ address: addresses[i], kind: "token-account", amount: asToken.amount });
        continue;
      }
      const owned = await rpc
        .getTokenAccountsByOwner(address(addresses[i]), { mint: address(oldMint) }, { encoding: "jsonParsed", ...read() })
        .send();
      let amount = BigInt(0);
      for (const item of owned.value ?? []) {
        const parsed = (item.account?.data as { parsed?: { info?: { mint?: string; tokenAmount?: { amount?: string } } } } | undefined)?.parsed;
        const raw = parsed?.info?.tokenAmount?.amount;
        if (parsed?.info?.mint !== oldMint || typeof raw !== "string" || !/^\d+$/.test(raw)) continue;
        amount += BigInt(raw);
      }
      out.push({ address: addresses[i], kind: "owner", amount });
    }
    return out;
  } catch (err) {
    unavailable("excluded balances read failed", err);
  }
}

export type ShareClassFacts = {
  shareClass: string;
  asset: string;
  issuer: string;
  mint: string;
  /** The on-chain asset's name (the default company name of a campaign). */
  assetName: string;
  /** The class's supply cap, when it has one. */
  maxSupply: bigint | null;
};

/**
 * The share class a campaign delivers, verified on chain at `confirmed`:
 * registry-owned ShareClass, Asset and Issuer whose PDAs derive from each
 * other, an initialized Token-2022 mint with 0 decimals. 404 / 409 with the
 * reason otherwise.
 */
export async function readShareClassFacts(shareClassPda: string): Promise<ShareClassFacts> {
  try {
    const rpc = getServerRpc();
    const shareClass = address(shareClassPda);
    const sc = await fetchMaybeShareClass(rpc, shareClass, read());
    if (!sc.exists || sc.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS || (await findShareClassPda(sc.data.asset, sc.data.classIndex)) !== shareClass) {
      throw new SiwsError(404, "That share class does not exist on this network");
    }
    if (!sc.data.mintInitialized) throw new SiwsError(409, "That share class has no mint yet: initialize its mint first");
    const asset = await fetchMaybeAsset(rpc, sc.data.asset, read());
    if (!asset.exists || asset.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS
      || (await findAssetPda({ issuer: asset.data.issuer, assetId: asset.data.assetId }))[0] !== sc.data.asset) {
      throw new SiwsError(404, "The share class's asset does not exist on this network");
    }
    const issuer = await fetchMaybeIssuer(rpc, asset.data.issuer, read());
    if (!issuer.exists || issuer.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS
      || (await findIssuerPda({ legalEntityId: issuer.data.legalEntityId }))[0] !== asset.data.issuer) {
      throw new SiwsError(404, "The share class's issuer does not exist on this network");
    }
    const mintAccount = await fetchEncodedAccount(rpc, sc.data.mint, read());
    if (!mintAccount.exists || mintAccount.programAddress !== TOKEN_PROGRAM_2022) {
      throw new SiwsError(409, "The share class's mint is not a Token-2022 mint on this network");
    }
    const decimals = getMintDecoder().decode(mintAccount.data).decimals;
    if (decimals !== 0) throw new SiwsError(409, `The share class's mint has ${decimals} decimals; units must be whole (0 decimals)`);
    return {
      shareClass: shareClassPda,
      asset: sc.data.asset.toString(),
      issuer: asset.data.issuer.toString(),
      mint: sc.data.mint.toString(),
      assetName: asset.data.name,
      maxSupply: sc.data.maxSupply.__option === "Some" ? sc.data.maxSupply.value : null,
    };
  } catch (err) {
    unavailable("share class read failed", err);
  }
}

export type DepositAccountState =
  | { ok: true; amount: bigint }
  | { ok: false; problem: string };

/**
 * The campaign's deposit account before it opens: it exists under the old
 * mint's program, belongs to the deposit owner, holds the old mint, is not
 * frozen, has no delegate and no close authority, and holds nothing yet
 * (every token in it must be a recorded deposit). Read at `confirmed`, right
 * after the admin's wallet created it.
 */
export async function readDepositAccount(input: { depositAta: string; depositOwner: string; oldMint: string; program: string }): Promise<DepositAccountState> {
  let account: MaybeEncodedAccount;
  try {
    account = await fetchEncodedAccount(getServerRpc(), address(input.depositAta), read());
  } catch (err) {
    unavailable("deposit account read failed", err);
  }
  if (!account.exists) return { ok: false, problem: "The deposit account does not exist yet: create it with your wallet first (or wait a few seconds after creating it)." };
  const facts = decodeTokenAccount(account, input.program);
  if (!facts) return { ok: false, problem: "The deposit address is not a token account of the old token's program." };
  if (facts.mint !== input.oldMint) return { ok: false, problem: "The deposit account holds another token." };
  if (facts.owner !== input.depositOwner) return { ok: false, problem: "The deposit account belongs to another owner." };
  if (facts.frozen) return { ok: false, problem: "The deposit account is frozen: the old token's freeze authority must thaw it." };
  if (facts.delegated) return { ok: false, problem: "The deposit account has a delegate who could move deposits: revoke it first." };
  if (facts.closeAuthority) return { ok: false, problem: "The deposit account has a close authority: remove it first." };
  if (facts.amount !== BigInt(0)) return { ok: false, problem: "The deposit account already holds tokens: every token in it must be a recorded deposit, so use a fresh deposit owner." };
  return { ok: true, amount: facts.amount };
}

/** A wallet's balance of the old mint in its associated token account (0 without one), and whether that account is frozen. */
export async function readHolderBalance(input: { holder: string; oldMint: string; program: string }): Promise<{ amount: bigint; frozen: boolean }> {
  try {
    const ata = await associatedTokenAccount(input.holder, input.oldMint, input.program);
    const account = await fetchEncodedAccount(getServerRpc(), ata, read());
    const facts = decodeTokenAccount(account, input.program);
    if (!facts || facts.mint !== input.oldMint || facts.owner !== input.holder) return { amount: BigInt(0), frozen: false };
    return { amount: facts.amount, frozen: facts.frozen };
  } catch (err) {
    unavailable("holder balance read failed", err);
  }
}

/** The network's finalized slot now (the opening slot of a campaign). */
export async function readFinalizedSlot(): Promise<bigint> {
  try {
    return BigInt(await getServerRpc().getSlot({ commitment: "finalized" }).send({ abortSignal: AbortSignal.timeout(READ_TIMEOUT_MS) }));
  } catch (err) {
    unavailable("finalized slot read failed", err);
  }
}

export type DepositAccountEntry = { signature: string; slot: bigint; failed: boolean };

/**
 * One page of the finalized transactions that touched the deposit account,
 * NEWEST FIRST: below `before` (exclusive; from the newest when null), above
 * `until` (exclusive; down to the oldest when null), and at or after
 * `minSlot` (the opening slot). `exhausted` says nothing older remains in
 * that range (the page was short, or it reached `until` or the opening
 * slot). Failed transactions are listed too: they moved nothing, and the
 * reconcile passes over them.
 */
export async function depositAccountPage(
  depositAta: string,
  opts: { before: string | null; until: string | null; minSlot: bigint; limit: number },
): Promise<{ entries: DepositAccountEntry[]; exhausted: boolean }> {
  try {
    const page = await getServerRpc()
      .getSignaturesForAddress(address(depositAta) as Address, {
        commitment: "finalized",
        limit: opts.limit,
        ...(opts.before ? { before: opts.before as Signature } : {}),
        ...(opts.until ? { until: opts.until as Signature } : {}),
      })
      .send({ abortSignal: AbortSignal.timeout(READ_TIMEOUT_MS) });
    const entries: DepositAccountEntry[] = [];
    for (const entry of page) {
      const slot = BigInt(entry.slot);
      if (slot < opts.minSlot) return { entries, exhausted: true };
      entries.push({ signature: entry.signature, slot, failed: entry.err !== null });
    }
    return { entries, exhausted: page.length < opts.limit };
  } catch (err) {
    unavailable("deposit account history read failed", err);
  }
}
