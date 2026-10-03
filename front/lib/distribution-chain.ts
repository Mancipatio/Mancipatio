// Chain reads of "Send to wallets" that the single-recipient send does not
// need: the Open sales (of the class, for the room; of any issuer, for the
// re-pause rule), the Platform's pause flags and super admin read fresh (no
// cache), the treasury's recent transfers (the resume backstop) and the
// sender's SOL.
//
// Node-safe (no React, no browser API).
import {
  getBase58Decoder,
  type Address,
  type Base58EncodedBytes,
  type GetBalanceApi,
  type GetProgramAccountsApi,
  type GetSignaturesForAddressApi,
  type GetTransactionApi,
  type Rpc,
  type Signature,
} from "@solana/kit";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  SaleStatus,
  fetchMaybePlatform,
  findPlatformPda,
  getSaleDecoder,
  getSaleDiscriminatorBytes,
  getSaleSize,
} from "@/lib/generated/asset_registry";
import { transfersFromTransaction, type RawTransaction, type TreasuryTransfer } from "@/lib/distribution-journal";

/** Byte offsets of the Sale account (pinned by tests/distribution-supply.test.ts against the encoder). */
export const SALE_SHARE_CLASS_OFFSET = 8;
export const SALE_STATUS_OFFSET = 216;

export type OpenSale = { address: Address; shareClass: Address; totalForSale: bigint; sold: bigint };

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/** Open sales, of one class or of every issuer: discriminator, size and status filtered on the node. */
export async function listOpenSales(rpc: Rpc<GetProgramAccountsApi>, opts: { shareClass?: Address } = {}): Promise<OpenSale[]> {
  const discriminator = getBase58Decoder().decode(getSaleDiscriminatorBytes()) as Base58EncodedBytes;
  const open = getBase58Decoder().decode(Uint8Array.of(SaleStatus.Open)) as Base58EncodedBytes;
  const rows = await rpc
    .getProgramAccounts(ASSET_REGISTRY_PROGRAM_ADDRESS, {
      encoding: "base64",
      commitment: "confirmed",
      filters: [
        { dataSize: BigInt(getSaleSize()) },
        { memcmp: { offset: BigInt(0), bytes: discriminator, encoding: "base58" } },
        { memcmp: { offset: BigInt(SALE_STATUS_OFFSET), bytes: open, encoding: "base58" } },
        ...(opts.shareClass
          ? [{ memcmp: { offset: BigInt(SALE_SHARE_CLASS_OFFSET), bytes: opts.shareClass as unknown as Base58EncodedBytes, encoding: "base58" as const } }]
          : []),
      ],
    })
    .send();
  const decoder = getSaleDecoder();
  const sales: OpenSale[] = [];
  for (const r of rows) {
    const sale = decoder.decode(b64ToBytes((r.account.data as readonly [string, string])[0]));
    if (sale.status !== SaleStatus.Open) continue;
    if (opts.shareClass && sale.shareClass !== opts.shareClass) continue;
    sales.push({ address: r.pubkey, shareClass: sale.shareClass, totalForSale: BigInt(sale.totalForSale), sold: BigInt(sale.sold) });
  }
  return sales;
}

/** Σ(total_for_sale − sold) of the Open sales of one class: tokens `buy` will still mint. */
export function openSaleRemaining(sales: readonly OpenSale[]): bigint {
  return sales.reduce((sum, s) => sum + (s.totalForSale > s.sold ? s.totalForSale - s.sold : BigInt(0)), BigInt(0));
}

/** The Platform's pause flags and super admin at `confirmed`, never cached (the 10 s gate cache is for display). */
export async function readPlatformPause(rpc: Parameters<typeof fetchMaybePlatform>[0]): Promise<{ flags: number; superAdmin: Address } | null> {
  const [pda] = await findPlatformPda();
  const platform = await fetchMaybePlatform(rpc, pda, { commitment: "confirmed" });
  if (!platform.exists || platform.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS) return null;
  return { flags: platform.data.pauseFlags, superAdmin: platform.data.admin };
}

/** The sender's SOL, in lamports, at `confirmed`. */
export async function readLamports(rpc: Rpc<GetBalanceApi>, owner: Address): Promise<bigint> {
  const { value } = await rpc.getBalance(owner, { commitment: "confirmed" }).send();
  return BigInt(value);
}

/** getTransaction calls of one history scan in flight at once. */
const HISTORY_CONCURRENCY = 6;

export type TreasuryHistory = {
  /** Transfers out of the treasury, newest first. */
  transfers: TreasuryTransfer[];
  /** Signatures of `skip` (a run's own) the treasury's history holds without an error: they landed. */
  landed: Set<string>;
};

/**
 * Transfers out of the treasury token account since `sinceSec` (the resume
 * backstop; 0 for "any time"): its signatures, newest first, back to that
 * time (at most `limit`), each transaction decoded for transfer_checked from
 * `source`. A signature of `skip` is not decoded (the journal explains it),
 * but it is reported in `landed` when the history holds it without an
 * error: the proof it landed even when a status lookup no longer finds it.
 */
export async function recentTreasuryTransfers(
  rpc: Rpc<GetSignaturesForAddressApi & GetTransactionApi>,
  input: { source: Address; mint: Address; sinceSec: number; limit?: number; skip?: ReadonlySet<string> },
): Promise<TreasuryHistory> {
  const signatures = await rpc
    .getSignaturesForAddress(input.source, { limit: input.limit ?? 100, commitment: "confirmed" })
    .send();
  const landed = new Set<string>();
  const decode: string[] = [];
  for (const s of signatures) {
    if (s.blockTime !== null && Number(s.blockTime) < input.sinceSec) break;
    if (s.err) continue;
    if (input.skip?.has(s.signature)) landed.add(s.signature);
    else decode.push(s.signature);
  }
  const decoded: TreasuryTransfer[][] = new Array(decode.length);
  for (let i = 0; i < decode.length; i += HISTORY_CONCURRENCY) {
    const chunk = decode.slice(i, i + HISTORY_CONCURRENCY);
    const txs = await Promise.all(
      chunk.map((signature) =>
        rpc
          .getTransaction(signature as Signature, { commitment: "confirmed", encoding: "json", maxSupportedTransactionVersion: 0 })
          .send(),
      ),
    );
    txs.forEach((tx, k) => {
      decoded[i + k] = tx
        ? transfersFromTransaction(tx as unknown as RawTransaction, { signature: chunk[k], source: input.source, mint: input.mint })
        : [];
    });
  }
  return { transfers: decoded.flat(), landed };
}
