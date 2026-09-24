"use client";

// Sanctions blocklist held by the transfer_hook program: one BlockEntry PDA
// (["blocked", wallet]) per blocked wallet, administered by the singleton
// BlocklistAuthority.
//
// The hook checks the SENDER only (it derives ["blocked", source_owner]); no
// program checks the receiver. A passport issued to a blocklisted wallet
// therefore lets it receive KycGated units, so the passport issue gate reads
// the receiver's BlockEntry PDA (fetchBlockEntries / fetchBlockEntry) and
// fails closed when that read fails (lib/passport issueBlockers).

import type { SolanaClient } from "@solana/client";
import {
  fetchEncodedAccount,
  fetchEncodedAccounts,
  getBase58Decoder,
  type Address,
  type Base58EncodedBytes,
  type MaybeEncodedAccount,
} from "@solana/kit";
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

/**
 * Every BlockEntry (the /admin/blocklist table). The scan is filtered by the
 * BlockEntry discriminator on the RPC side; each row is re-checked here.
 */
export async function listBlockEntries(rpc: Rpc): Promise<BlockEntryRow[]> {
  const disc = getBlockEntryDiscriminatorBytes();
  const res = await rpc
    .getProgramAccounts(TRANSFER_HOOK_PROGRAM_ADDRESS, {
      encoding: "base64",
      filters: [
        {
          memcmp: {
            offset: BigInt(0),
            encoding: "base58",
            bytes: getBase58Decoder().decode(disc) as Base58EncodedBytes,
          },
        },
      ],
    })
    .send();
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
 * The live entry in `account` for `holder`, or null. Mirrors the registry's
 * `util::require_blocklisted`: owned by the hook, the BlockEntry
 * discriminator, and naming `holder` — anything else (closed, foreign-owned,
 * malformed) means "not blocked".
 */
function liveEntry(account: MaybeEncodedAccount, holder: Address): LiveBlockEntry | null {
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
  return { pda: account.address, addedBy: entry.addedBy };
}

/** The holder's live BlockEntry, or null. RPC failures propagate. */
export async function fetchBlockEntry(
  rpc: Parameters<typeof fetchEncodedAccount>[0],
  holder: Address,
): Promise<LiveBlockEntry | null> {
  const [pda] = await findBlockEntryPda({ wallet: holder });
  return liveEntry(await fetchEncodedAccount(rpc, pda), holder);
}

/** getMultipleAccounts accepts at most 100 addresses. */
export const BLOCK_ENTRY_CHUNK = 100;

/**
 * The live BlockEntry of each wallet that has one, keyed by wallet. Reads the
 * `["blocked", w]` PDAs directly in chunks of BLOCK_ENTRY_CHUNK (no program
 * scan), with the same checks as fetchBlockEntry. Throws on any RPC error:
 * the caller must treat the blocklist status as unknown (fail closed).
 */
export async function fetchBlockEntries(
  rpc: Parameters<typeof fetchEncodedAccounts>[0],
  wallets: readonly Address[],
): Promise<Map<string, LiveBlockEntry>> {
  const unique = [...new Set(wallets.map((w) => w.toString()))] as Address[];
  const pdas = await Promise.all(
    unique.map(async (w) => (await findBlockEntryPda({ wallet: w }))[0]),
  );
  const out = new Map<string, LiveBlockEntry>();
  for (let i = 0; i < unique.length; i += BLOCK_ENTRY_CHUNK) {
    const accounts = await fetchEncodedAccounts(rpc, pdas.slice(i, i + BLOCK_ENTRY_CHUNK));
    accounts.forEach((account, j) => {
      const holder = unique[i + j];
      const live = liveEntry(account, holder);
      if (live) out.set(holder, live);
    });
  }
  return out;
}
