"use client";

// Sanctions blocklist held by the transfer_hook program: one BlockEntry PDA
// (["blocked", wallet]) per blocked wallet, administered by the singleton
// BlocklistAuthority. Entries are enumerated via getProgramAccounts +
// discriminator match — same pattern as lib/enumerate.ts.

import type { SolanaClient } from "@solana/client";
import { fetchEncodedAccount, type Address } from "@solana/kit";
import {
  findBlockEntryPda,
  getBlockEntryDecoder,
  getBlockEntryDiscriminatorBytes,
  TRANSFER_HOOK_PROGRAM_ADDRESS,
  type BlockEntry,
} from "@/lib/generated/transfer_hook";

type Rpc = SolanaClient["runtime"]["rpc"];

export type BlockEntryRow = { pda: Address; entry: BlockEntry };

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export async function listBlockEntries(rpc: Rpc): Promise<BlockEntryRow[]> {
  const res = await rpc
    .getProgramAccounts(TRANSFER_HOOK_PROGRAM_ADDRESS, { encoding: "base64" })
    .send();
  const disc = getBlockEntryDiscriminatorBytes();
  const decode = getBlockEntryDecoder();
  const out: BlockEntryRow[] = [];
  for (const r of res) {
    const data = b64ToBytes((r.account.data as readonly [string, string])[0]);
    if (data.length < 8) continue;
    let match = true;
    for (let i = 0; i < 8; i += 1) {
      if (data[i] !== disc[i]) {
        match = false;
        break;
      }
    }
    if (match) out.push({ pda: r.pubkey, entry: decode.decode(data) });
  }
  return out;
}

export type LiveBlockEntry = {
  pda: Address;
  /** `BlockEntry.added_by` — the BlocklistAuthority key that blocked. */
  addedBy: Address;
};

function hasPrefix(data: ArrayLike<number>, prefix: ArrayLike<number>): boolean {
  if (data.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i += 1)
    if (data[i] !== prefix[i]) return false;
  return true;
}

/**
 * The holder's live BlockEntry, or null. Mirrors the registry's
 * `util::require_blocklisted`: the account at `["blocked", holder]` must be
 * owned by the hook, carry the BlockEntry discriminator and name `holder` —
 * anything else (closed, foreign-owned, malformed) means "not blocked".
 * RPC failures propagate.
 */
export async function fetchBlockEntry(
  rpc: Parameters<typeof fetchEncodedAccount>[0],
  holder: Address,
): Promise<LiveBlockEntry | null> {
  const [pda] = await findBlockEntryPda({ wallet: holder });
  const account = await fetchEncodedAccount(rpc, pda);
  if (!account.exists) return null;
  if (account.programAddress !== TRANSFER_HOOK_PROGRAM_ADDRESS) return null;
  const data = account.data;
  if (!hasPrefix(data, getBlockEntryDiscriminatorBytes())) return null;
  let entry: BlockEntry;
  try {
    entry = getBlockEntryDecoder().decode(data);
  } catch {
    return null;
  }
  if (entry.wallet !== holder) return null;
  return { pda, addedBy: entry.addedBy };
}
