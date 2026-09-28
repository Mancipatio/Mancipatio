/**
 * Finalized raw account reads shared by the probes and the inventory.
 */
import {
  address,
  getBase58Decoder,
  type Address,
  type Base58EncodedBytes,
} from "@solana/kit";
import type { ChainRpc } from "./rpc";

export type RawAccount = {
  address: Address;
  owner: Address;
  lamports: bigint;
  executable: boolean;
  data: Uint8Array;
};

type WireAccount = {
  owner: Address;
  lamports: bigint;
  executable: boolean;
  data: readonly [string, string] | string[];
};

function fromWire(address: Address, value: WireAccount | null): RawAccount | null {
  if (!value) return null;
  return {
    address,
    owner: value.owner,
    lamports: BigInt(value.lamports),
    executable: value.executable,
    data: new Uint8Array(Buffer.from(value.data[0], "base64")),
  };
}

export type DataSlice = { offset: number; length: number };

/** getMultipleAccounts at finalized, 100 keys per call, base64. */
export async function fetchRawAccounts(
  rpc: ChainRpc,
  addresses: Address[],
  dataSlice?: DataSlice,
): Promise<Map<Address, RawAccount | null>> {
  const out = new Map<Address, RawAccount | null>();
  const unique = [...new Set(addresses)];
  for (let start = 0; start < unique.length; start += 100) {
    const batch = unique.slice(start, start + 100);
    const { value } = await rpc
      .getMultipleAccounts(batch, {
        encoding: "base64",
        commitment: "finalized",
        ...(dataSlice ? { dataSlice } : {}),
      })
      .send();
    value.forEach((account, i) => out.set(batch[i], fromWire(batch[i], account as WireAccount | null)));
  }
  return out;
}

export async function fetchRawAccount(rpc: ChainRpc, address: Address): Promise<RawAccount | null> {
  const { value } = await rpc
    .getAccountInfo(address, { encoding: "base64", commitment: "finalized" })
    .send();
  return fromWire(address, value as WireAccount | null);
}

export type MemcmpFilter = { offset: number; bytes: Uint8Array };

/** getProgramAccounts at finalized with memcmp filters (base58 bytes). */
export async function fetchProgramAccounts(
  rpc: ChainRpc,
  program: Address,
  filters: MemcmpFilter[],
  dataSlice?: DataSlice,
): Promise<RawAccount[]> {
  const base58 = getBase58Decoder();
  const result = await rpc
    .getProgramAccounts(program, {
      encoding: "base64",
      commitment: "finalized",
      filters: filters.map((filter) => ({
        memcmp: {
          offset: BigInt(filter.offset),
          bytes: base58.decode(filter.bytes) as Base58EncodedBytes,
          encoding: "base58" as const,
        },
      })),
      ...(dataSlice ? { dataSlice } : {}),
    })
    .send();
  const rows = result as unknown as { pubkey: Address; account: WireAccount }[];
  return rows.map((row) => fromWire(row.pubkey, row.account)!);
}

export function hasDiscriminator(data: Uint8Array, discriminator: Uint8Array): boolean {
  if (data.length < discriminator.length) return false;
  for (let i = 0; i < discriminator.length; i++) if (data[i] !== discriminator[i]) return false;
  return true;
}

/** The Clock sysvar (slot u64, epoch_start_timestamp i64, epoch u64, leader_schedule_epoch u64, unix_timestamp i64). */
export const CLOCK_SYSVAR = address("SysvarC1ock11111111111111111111111111111111");
const CLOCK_UNIX_TIMESTAMP_OFFSET = 32;

/**
 * The chain's `Clock::unix_timestamp` (seconds), the time every timelock
 * (`eta`, `expires_at`) is compared against; null when the sysvar cannot be
 * read. Never the local clock.
 */
export async function fetchChainTime(
  rpc: ChainRpc,
  commitment: "finalized" | "confirmed" = "finalized",
): Promise<bigint | null> {
  const { value } = await rpc.getAccountInfo(CLOCK_SYSVAR, { encoding: "base64", commitment }).send();
  if (!value) return null;
  const data = Buffer.from((value as WireAccount).data[0], "base64");
  if (data.length < CLOCK_UNIX_TIMESTAMP_OFFSET + 8) return null;
  return data.readBigInt64LE(CLOCK_UNIX_TIMESTAMP_OFFSET);
}

