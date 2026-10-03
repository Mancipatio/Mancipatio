// The one browser reader of the Primary-issuance (0x02) rules: every Open
// sale of every issuer with its issuer and that issuer's IssuerFreeze. The
// pre-clear check, its "Close Primary issuance again", /admin/launchpad's
// re-pause offer and its guard, "End and collect" and the "Send to wallets"
// re-pause all read through it, so a frozen issuer's Open sale (buy.rs:
// IssuerProceedsFrozen) counts the same everywhere (lib/sale-liveness). The
// primary-open-idle alarm reads the same facts from the mirror
// (lib/server/alarm-checks primaryIdleReport).
//
// Reads: the Open sales (confirmed, lib/distribution-chain listOpenSales),
// share class → asset → issuer (confirmed; those links never change), and
// the freezes at finalized — one getMultipleAccounts per step (≤ 100
// accounts each). A freeze is `true` only for an account the registry owns
// at ["issuer_freeze", issuer] that decodes and names that issuer; `false`
// when the account does not exist; `null` when it could not be told (the
// read failed, the issuer could not be resolved, or the account is not a
// freeze), and each rule then counts it by its own side of safety
// (lib/sale-liveness FreezePolicy).
//
// Node-safe (tests/open-sales-chain.test.ts).
import {
  fetchEncodedAccounts,
  type Address,
  type Commitment,
  type EncodedAccount,
  type GetMultipleAccountsApi,
  type GetProgramAccountsApi,
  type MaybeEncodedAccount,
  type Rpc,
} from "@solana/kit";
import { ASSET_REGISTRY_PROGRAM_ADDRESS, decodeAsset, decodeIssuerFreeze, decodeShareClass } from "@/lib/generated/asset_registry";
import { findIssuerFreezePda } from "@/lib/pdas";
import { listOpenSales, type OpenSale } from "@/lib/distribution-chain";
import type { SaleWithFreeze } from "@/lib/sale-liveness";

/** An Open sale with its issuer (null: not resolved) and that issuer's freeze (null: could not be read). */
export type OpenSaleWithFreeze = OpenSale & SaleWithFreeze & { issuer: Address | null };

type ChainRpc = Rpc<GetProgramAccountsApi & GetMultipleAccountsApi>;

const BATCH = 100;

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

/** The accounts at `addresses` (in batches), or null when a read fails. */
async function readAccounts(rpc: ChainRpc, addresses: readonly Address[], commitment: Commitment): Promise<Map<Address, MaybeEncodedAccount> | null> {
  const out = new Map<Address, MaybeEncodedAccount>();
  try {
    for (let i = 0; i < addresses.length; i += BATCH) {
      const chunk = addresses.slice(i, i + BATCH);
      const accounts = await fetchEncodedAccounts(rpc, chunk, { commitment, abortSignal: AbortSignal.timeout(10_000) });
      chunk.forEach((address, j) => out.set(address, accounts[j]));
    }
    return out;
  } catch {
    return null;
  }
}

/** The registry's own account, decoded; null when missing, foreign or malformed. */
function decodeOwned<T>(account: MaybeEncodedAccount | undefined, decode: (a: EncodedAccount) => { data: T }): T | null {
  if (!account?.exists || account.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS) return null;
  try {
    return decode(account).data;
  } catch {
    return null;
  }
}

/** The issuer's freeze from the account at its freeze PDA: true / false, or null when it cannot be told. */
export function freezeFromAccount(account: MaybeEncodedAccount | undefined, issuer: Address): boolean | null {
  if (!account) return null;
  if (!account.exists) return false;
  const freeze = decodeOwned(account, (a) => decodeIssuerFreeze(a));
  return freeze !== null && freeze.issuer === issuer ? true : null;
}

/**
 * Every Open sale (of every issuer) with its issuer and whether that issuer is
 * frozen (finalized). Fails only when the Open sales themselves cannot be
 * listed; a link or a freeze that cannot be read leaves `frozen` null.
 */
export async function listOpenSalesWithFreezes(rpc: ChainRpc): Promise<OpenSaleWithFreeze[]> {
  const sales = await listOpenSales(rpc);
  if (sales.length === 0) return [];

  const classes = unique(sales.map((s) => s.shareClass));
  const classAccounts = await readAccounts(rpc, classes, "confirmed");
  const assetOf = new Map<Address, Address>();
  for (const c of classes) {
    const sc = decodeOwned(classAccounts?.get(c), (a) => decodeShareClass(a));
    if (sc) assetOf.set(c, sc.asset);
  }

  const assets = unique([...assetOf.values()]);
  const assetAccounts = assets.length > 0 ? await readAccounts(rpc, assets, "confirmed") : null;
  const issuerOf = new Map<Address, Address>();
  for (const a of assets) {
    const asset = decodeOwned(assetAccounts?.get(a), (acc) => decodeAsset(acc));
    if (asset) issuerOf.set(a, asset.issuer);
  }

  const issuers = unique([...issuerOf.values()]);
  const pdas = await Promise.all(issuers.map((issuer) => findIssuerFreezePda(issuer)));
  const freezeAccounts = issuers.length > 0 ? await readAccounts(rpc, pdas, "finalized") : null;
  const frozenOf = new Map<Address, boolean | null>();
  issuers.forEach((issuer, i) => frozenOf.set(issuer, freezeFromAccount(freezeAccounts?.get(pdas[i]), issuer)));

  return sales.map((s) => {
    const asset = assetOf.get(s.shareClass);
    const issuer = asset ? (issuerOf.get(asset) ?? null) : null;
    return { ...s, issuer, frozen: issuer ? (frozenOf.get(issuer) ?? null) : null };
  });
}
