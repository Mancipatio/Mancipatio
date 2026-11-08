// SERVER-ONLY — the chain side of the cap table (lib/cap-table.ts): an
// asset, its share classes with a mint, each mint's supply, the custody
// vaults of each class with their escrow balances and, for the admin and
// issuer views, every holder of the mint.
//
// Read fresh from this network's server RPC (lib/server/rpc.ts verifies the
// cluster) at FINALIZED commitment, the commitment the conversions' outcome
// evidence was recorded at (lib/server/custody-evidence.ts), so a just-landed
// realize never shows as a mismatch. Every read FAILS CLOSED: an RPC failure
// is a 503, never a reconciliation computed from partial data; an address
// that is not this program's asset is a 404.
//
// The holder list is the same Token-2022 scan as loadMintHolders
// (lib/distributions.ts, a client module): every token account of the mint
// (memcmp on the mint at offset 0), summed per owner, then the owners
// classified from their own accounts (lib/cap-table.ts HolderKind).

import "server-only";

import {
  address,
  fetchEncodedAccount,
  fetchEncodedAccounts,
  getBase58Decoder,
  type Address,
  type Base58EncodedBytes,
} from "@solana/kit";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  decodeAsset,
  decodeIssuer,
  findAssetPda,
  findIssuerPda,
  getAssetDiscriminatorBytes,
  getCustodyVaultDecoder,
  getCustodyVaultDiscriminatorBytes,
  getIssuerDiscriminatorBytes,
  type CustodyVault,
} from "@/lib/generated/asset_registry";
import { getMintDecoder } from "@solana-program/token-2022";
import { decodeShareClassV2 } from "@/lib/account-versions";
import { findShareClassPda } from "@/lib/pdas";
import { getServerRpc } from "@/lib/server/rpc";
import { SiwsError } from "@/lib/server/siws";
import {
  VAULT_KINDS,
  VAULT_STATES,
  type AssetIdentity,
  type ChainHolder,
  type ClassChainFacts,
  type CustodyVaultFacts,
  type HolderKind,
} from "@/lib/cap-table";

const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
/** getMultipleAccounts takes at most 100 addresses. */
const CHUNK = 100;
/** CustodyVault v2 appended `deposited` (8) and `kyc_registry` (32): a v1 account is that much shorter. */
const CUSTODY_V2_TAIL_BYTES = 40;

const FINALIZED = "finalized" as const;
const budget = () => AbortSignal.timeout(12_000);
const accountConfig = () => ({ commitment: FINALIZED, abortSignal: budget() });

export type AssetChain = {
  identity: AssetIdentity;
  /** The issuer authority: its own token account is the treasury. */
  issuerAuthority: string;
  classes: ClassChainFacts[];
};

/** The chain could not be read: the caller retries. */
function unavailable(err: unknown): never {
  if (err instanceof SiwsError) throw err;
  console.error("[cap-table] chain read failed:", err instanceof Error ? err.message : String(err));
  throw new SiwsError(503, "On-chain supply data unavailable — try again");
}

function sameBytes(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length < b.length) return false;
  for (let i = 0; i < b.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
}

function base64Bytes(data: unknown): Uint8Array | null {
  if (!Array.isArray(data) || data[1] !== "base64" || typeof data[0] !== "string") return null;
  return new Uint8Array(Buffer.from(data[0], "base64"));
}

/** jsonParsed token account → { mint, owner, amount }, or null for anything else. */
function parsedTokenAccount(data: unknown): { mint: string; owner: string; amount: bigint } | null {
  if (!data || typeof data !== "object" || !("parsed" in data)) return null;
  const info = (data as { parsed?: { info?: { mint?: unknown; owner?: unknown; tokenAmount?: { amount?: unknown } } } }).parsed?.info;
  const amount = info?.tokenAmount?.amount;
  if (typeof info?.mint !== "string" || typeof info.owner !== "string" || typeof amount !== "string" || !/^\d+$/.test(amount)) return null;
  return { mint: info.mint, owner: info.owner, amount: BigInt(amount) };
}

/** A CustodyVault from its bytes; a v1 account (no deposit ledger or pinned registry) reads with those fields zeroed. */
function decodeVault(bytes: Uint8Array): CustodyVault {
  const decoder = getCustodyVaultDecoder();
  try {
    return decoder.decode(bytes);
  } catch {
    const padded = new Uint8Array(bytes.length + CUSTODY_V2_TAIL_BYTES);
    padded.set(bytes);
    return decoder.decode(padded);
  }
}

/** The asset at `assetPda` (this program's account, at its own derived address) and its issuer authority. */
async function readAssetAccounts(assetPda: Address) {
  const rpc = getServerRpc();
  const encoded = await fetchEncodedAccount(rpc, assetPda, accountConfig());
  if (!encoded.exists || encoded.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS ||
      !sameBytes(encoded.data, getAssetDiscriminatorBytes())) {
    throw new SiwsError(404, "Asset not found on chain");
  }
  let asset;
  try {
    asset = decodeAsset(encoded).data;
  } catch {
    throw new SiwsError(404, "Asset not found on chain");
  }
  const [expected] = await findAssetPda({ issuer: asset.issuer, assetId: asset.assetId });
  if (expected !== assetPda) throw new SiwsError(404, "Asset not found on chain");

  const issuerAccount = await fetchEncodedAccount(rpc, asset.issuer, accountConfig());
  if (!issuerAccount.exists || issuerAccount.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS ||
      !sameBytes(issuerAccount.data, getIssuerDiscriminatorBytes())) {
    throw new SiwsError(409, "The asset's issuer account is missing on chain");
  }
  const issuer = decodeIssuer(issuerAccount).data;
  const [issuerPda] = await findIssuerPda({ legalEntityId: issuer.legalEntityId });
  if (issuerPda !== asset.issuer) throw new SiwsError(409, "The asset's issuer account is not at its derived address");
  return { asset, issuerAuthority: issuer.authority.toString() };
}

type ShareClassRead = {
  pda: string;
  classIndex: number;
  mint: string;
  maxSupply: bigint | null;
  cumulativeCap: boolean;
  lifetimeMinted: bigint;
  circulatingSupply: bigint;
  lockedSupply: bigint;
};

/** The asset's share classes that have a mint (a class without one holds no units: the conversion marker). */
async function readShareClasses(assetPda: Address, count: number): Promise<ShareClassRead[]> {
  const rpc = getServerRpc();
  const pdas = await Promise.all(Array.from({ length: count }, (_, i) => findShareClassPda(assetPda, i)));
  const out: ShareClassRead[] = [];
  for (const group of chunks(pdas)) {
    const accounts = await fetchEncodedAccounts(rpc, group, accountConfig());
    for (const account of accounts) {
      if (!account.exists) continue;
      if (account.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS) {
        throw new SiwsError(409, "A share class account is not owned by the registry program");
      }
      let sc;
      try {
        sc = decodeShareClassV2(new Uint8Array(account.data));
      } catch (err) {
        throw new SiwsError(409, err instanceof Error ? err.message : "Unsupported share class layout");
      }
      if (sc.asset.toString() !== assetPda || !sc.mintInitialized) continue;
      out.push({
        pda: account.address.toString(),
        classIndex: sc.classIndex,
        mint: sc.mint.toString(),
        maxSupply: sc.maxSupply.__option === "Some" ? BigInt(sc.maxSupply.value) : null,
        cumulativeCap: sc.cumulativeCap,
        lifetimeMinted: BigInt(sc.lifetimeMinted),
        circulatingSupply: BigInt(sc.circulatingSupply),
        lockedSupply: BigInt(sc.lockedSupply),
      });
    }
  }
  return out.sort((a, b) => a.classIndex - b.classIndex);
}

/**
 * Each mint's supply (Token-2022 mints only: every share-class mint is one).
 * Only the 82-byte base layout is decoded, so no extension of the mint (hook,
 * permanent delegate, close authority, metadata) can make the read fail.
 */
async function readMintSupplies(mints: string[]): Promise<Map<string, bigint>> {
  const rpc = getServerRpc();
  const out = new Map<string, bigint>();
  for (const group of chunks(mints.map((m) => address(m)))) {
    const accounts = await fetchEncodedAccounts(rpc, group, accountConfig());
    for (const account of accounts) {
      if (!account.exists) throw new SiwsError(409, "A share-class mint is missing on chain");
      if (account.programAddress !== TOKEN_2022) throw new SiwsError(409, "A share-class mint is not a Token-2022 mint");
      const data = new Uint8Array(account.data);
      // The base mint, or an extended mint (account type 1 at byte 165): never a token account.
      if (data.length !== 82 && !(data.length >= 166 && data[165] === 1)) {
        throw new SiwsError(409, "A share-class mint account is not a mint");
      }
      const mint = getMintDecoder().decode(data.subarray(0, 82));
      if (!mint.isInitialized) throw new SiwsError(409, "A share-class mint is not initialized");
      out.set(account.address.toString(), BigInt(mint.supply));
    }
  }
  return out;
}

/** The live custody vaults of a class, with their escrow balances. */
async function readCustodyVaults(shareClassPda: string, mint: string): Promise<CustodyVaultFacts[]> {
  const rpc = getServerRpc();
  const discriminator = getBase58Decoder().decode(getCustodyVaultDiscriminatorBytes()) as Base58EncodedBytes;
  const rows = await rpc.getProgramAccounts(ASSET_REGISTRY_PROGRAM_ADDRESS, {
    encoding: "base64",
    commitment: FINALIZED,
    filters: [
      { memcmp: { offset: BigInt(0), bytes: discriminator, encoding: "base58" } },
      { memcmp: { offset: BigInt(8), bytes: shareClassPda as unknown as Base58EncodedBytes, encoding: "base58" } },
    ],
  }).send({ abortSignal: budget() });
  const vaults: Array<{ pda: string; vault: CustodyVault }> = [];
  for (const row of rows) {
    const bytes = base64Bytes(row.account.data);
    if (!bytes) throw new SiwsError(503, "Unexpected custody vault encoding");
    const vault = decodeVault(bytes);
    if (vault.shareClass.toString() !== shareClassPda) continue;
    vaults.push({ pda: row.pubkey.toString(), vault });
  }
  const balances = new Map<string, bigint>();
  for (const group of chunks(vaults.map((v) => v.vault.escrow))) {
    const res = await rpc.getMultipleAccounts(group, { encoding: "jsonParsed", commitment: FINALIZED }).send({ abortSignal: budget() });
    res.value.forEach((account, i) => {
      const parsed = parsedTokenAccount(account?.data);
      if (parsed && parsed.mint === mint) balances.set(group[i].toString(), parsed.amount);
    });
  }
  return vaults
    .map(({ pda, vault }) => ({
      pda,
      vaultId: vault.vaultId.toString(),
      kind: VAULT_KINDS[vault.vaultType] ?? "vesting",
      state: VAULT_STATES[vault.state] ?? "expired",
      escrow: vault.escrow.toString(),
      escrowUnits: balances.get(vault.escrow.toString()) ?? null,
    }))
    .sort((a, b) => (BigInt(a.vaultId) < BigInt(b.vaultId) ? -1 : 1));
}

/**
 * Every holder of the mint, summed per owner and classified: the issuer
 * authority (treasury), a custody vault of this class, another account of
 * the registry program (an escrow), an account of another program, or a
 * wallet (a system account, or no account at all).
 */
async function readHolders(mint: string, issuerAuthority: string, custodyPdas: ReadonlySet<string>): Promise<ChainHolder[]> {
  const rpc = getServerRpc();
  const res = await rpc.getProgramAccounts(address(TOKEN_2022), {
    encoding: "jsonParsed",
    commitment: FINALIZED,
    filters: [{ memcmp: { offset: BigInt(0), bytes: mint as unknown as Base58EncodedBytes, encoding: "base58" } }],
  }).send({ abortSignal: budget() });
  const byOwner = new Map<string, bigint>();
  for (const item of res as unknown as Array<{ account?: { data?: unknown } }>) {
    const parsed = parsedTokenAccount(item.account?.data);
    if (!parsed || parsed.mint !== mint || parsed.amount === BigInt(0)) continue;
    byOwner.set(parsed.owner, (byOwner.get(parsed.owner) ?? BigInt(0)) + parsed.amount);
  }
  const owners = [...byOwner.keys()].sort();
  const programOf = new Map<string, string | null>();
  for (const group of chunks(owners.map((o) => address(o)))) {
    const infos = await rpc.getMultipleAccounts(group, { encoding: "base64", commitment: FINALIZED }).send({ abortSignal: budget() });
    infos.value.forEach((account, i) => programOf.set(group[i].toString(), account ? account.owner.toString() : null));
  }
  return owners.map((owner) => {
    const program = programOf.get(owner) ?? null;
    let kind: HolderKind = "wallet";
    if (owner === issuerAuthority) kind = "treasury";
    else if (custodyPdas.has(owner)) kind = "custody";
    else if (program === ASSET_REGISTRY_PROGRAM_ADDRESS) kind = "escrow";
    else if (program !== null && program !== SYSTEM_PROGRAM) kind = "program";
    return { owner, units: byOwner.get(owner)!, kind };
  });
}

/**
 * The chain side of every share class of `assetPda` that has a mint. With
 * `holders: false` (the public view) the holder scan is skipped.
 */
export async function readAssetChain(assetPda: string, opts: { holders: boolean }): Promise<AssetChain> {
  let pda: Address;
  try {
    pda = address(assetPda);
  } catch {
    throw new SiwsError(400, "asset is not a valid address");
  }
  try {
    const { asset, issuerAuthority } = await readAssetAccounts(pda);
    const classes = await readShareClasses(pda, asset.shareClassesCount);
    const supplies = classes.length ? await readMintSupplies(classes.map((c) => c.mint)) : new Map<string, bigint>();
    const facts: ClassChainFacts[] = [];
    for (const sc of classes) {
      const custodyVaults = await readCustodyVaults(sc.pda, sc.mint);
      const holders = opts.holders
        ? await readHolders(sc.mint, issuerAuthority, new Set(custodyVaults.map((v) => v.pda)))
        : null;
      facts.push({
        shareClassPda: sc.pda,
        classIndex: sc.classIndex,
        mint: sc.mint,
        maxSupply: sc.maxSupply,
        cumulativeCap: sc.cumulativeCap,
        lifetimeMinted: sc.lifetimeMinted,
        circulatingSupply: sc.circulatingSupply,
        lockedSupply: sc.lockedSupply,
        mintSupply: supplies.get(sc.mint) ?? BigInt(0),
        custodyVaults,
        holders,
      });
    }
    return {
      identity: {
        asset_pda: assetPda,
        asset_id: asset.assetId,
        name: asset.name,
        symbol: asset.symbolPrefix,
        issuer_pda: asset.issuer.toString(),
      },
      issuerAuthority,
      classes: facts,
    };
  } catch (err) {
    return unavailable(err);
  }
}

export type EntryShareClass = { assetPda: string; maxSupply: bigint | null };

/**
 * The share class a register entry names: this program's ShareClass at its
 * derived address, with a mint. Its asset comes from the chain, never from
 * the caller. 400 when it is not one, 503 when the chain cannot be read.
 */
export async function readEntryShareClass(shareClassPda: string): Promise<EntryShareClass> {
  let pda: Address;
  try {
    pda = address(shareClassPda);
  } catch {
    throw new SiwsError(400, "share_class_pda is not a valid address");
  }
  try {
    const account = await fetchEncodedAccount(getServerRpc(), pda, accountConfig());
    if (!account.exists || account.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS) {
      throw new SiwsError(400, "share_class_pda is not a share class on this network");
    }
    let sc;
    try {
      sc = decodeShareClassV2(new Uint8Array(account.data));
    } catch {
      throw new SiwsError(400, "share_class_pda is not a share class on this network");
    }
    if ((await findShareClassPda(sc.asset, sc.classIndex)) !== pda) {
      throw new SiwsError(400, "share_class_pda is not a share class on this network");
    }
    if (!sc.mintInitialized) throw new SiwsError(409, "The share class has no mint, so it has no units to register");
    return {
      assetPda: sc.asset.toString(),
      maxSupply: sc.maxSupply.__option === "Some" ? BigInt(sc.maxSupply.value) : null,
    };
  } catch (err) {
    return unavailable(err);
  }
}
