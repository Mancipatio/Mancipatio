"use client";

// Payouts / Merkle drop helpers.
//
// CSV format expected by parseSnapshotCsv:
//   wallet,shares
//   <pubkey>,<number>
// Lines starting with '#' and a leading header row (case-insensitive) are
// tolerated. Whitespace is trimmed.

import { type Address } from "@solana/kit";
import type { WalletSession } from "@solana/client";
import { merkleProof, merkleRoot, snapshotLeaf } from "@/lib/merkle";
import { signedFetch } from "@/lib/siws-client";

export type PayoutKind = "dividend" | "buyback" | "airdrop" | "other";

export type PayoutStatus =
  | "draft"
  | "snapshot_taken"
  | "merkle_built"
  | "funded"
  | "live"
  | "claimed_full"
  | "cancelled";

export type Payout = {
  id: string;
  created_at: string;
  updated_at: string;
  asset_mint: string;
  asset_label: string;
  kind: PayoutKind;
  total_amount: number;
  currency: string;
  per_share: number | null;
  snapshot_at: string;
  snapshot_source: "csv" | "indexer" | "manual";
  holder_count: number;
  total_shares: number;
  merkle_root: string | null;
  merkle_built_at: string | null;
  status: PayoutStatus;
  funded_tx: string | null;
  funded_at: string | null;
  notes: string;
  author: string;
  // Airdrop execution (migration 0021).
  payment_mint: string | null;
  payment_decimals: number;
  airdrop_started_at: string | null;
  airdrop_completed_at: string | null;
};

export type PayoutRecipient = {
  payout_id: string;
  wallet: string;
  shares: number;
  amount: number;
  merkle_index: number;
  merkle_proof: string[];           // hex-encoded sibling nodes
  claimed: boolean;
  claimed_at: string | null;
  claimed_tx: string | null;
  send_error: string | null;
};

/**
 * Converts a decimal amount (e.g. "12.5") to base units as a bigint using
 * pure string manipulation — no float multiplication, so no precision loss.
 * Fractional digits beyond `decimals` are truncated (never rounded up), which
 * matches the buildMerkle convention of never over-allocating. Handles inputs
 * with up to 8 decimal places (buildMerkle's precision) and scientific
 * notation produced by Number#toString.
 *
 * toBaseUnits("12.5", 6) === BigInt(12500000)
 */
export function toBaseUnits(amount: number | string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new Error(`Invalid decimals: ${decimals}`);
  }
  let s = typeof amount === "number" ? amount.toString() : amount.trim();
  if (!s) throw new Error("Empty amount");

  // Expand scientific notation (e.g. "1.2e-7") into plain decimal form.
  const sci = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(s);
  if (sci) {
    const [, sign, intPart, fracPart = "", expStr] = sci;
    const exp = parseInt(expStr, 10);
    const digits = intPart + fracPart;
    const pointIdx = intPart.length + exp; // decimal point position in `digits`
    let out: string;
    if (pointIdx <= 0) {
      out = "0." + "0".repeat(-pointIdx) + digits;
    } else if (pointIdx >= digits.length) {
      out = digits + "0".repeat(pointIdx - digits.length);
    } else {
      out = digits.slice(0, pointIdx) + "." + digits.slice(pointIdx);
    }
    s = sign + out;
  }

  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (!m[2] && !m[3])) {
    throw new Error(`Not a decimal number: "${s}"`);
  }
  if (m[1] === "-") throw new Error(`Amount must not be negative: "${s}"`);

  const whole = m[2] || "0";
  const frac = (m[3] || "").slice(0, decimals).padEnd(decimals, "0");
  return BigInt(whole + frac || "0");
}

// ---------------------------------------------------------------------------
// Signed write wrappers (W2-SD4) — every off-chain payout-ledger write goes
// through SIWS-signed, admin-gated routes (app/api/payouts/*). The connected
// WalletSession (useWalletConnection().wallet) is always the FIRST param.
// All four THROW on failure with the server's error message.
// ---------------------------------------------------------------------------

/** Payout columns accepted by /api/payouts/create. `author`, `holder_count`
 *  and timestamps are stamped server-side. */
export type NewPayoutInput = {
  asset_mint: string;
  asset_label: string;
  kind: PayoutKind;
  total_amount: number;
  currency: string;
  per_share: number | null;
  snapshot_source: "csv" | "indexer" | "manual";
  total_shares: number;
  merkle_root: string | null;
  status: PayoutStatus;
  payment_mint: string | null;
  payment_decimals: number;
  notes: string;
};

export type NewPayoutRecipientInput = {
  wallet: string;
  shares: number;
  amount: number;
  merkle_index: number;
  /** Hex-encoded sibling nodes. */
  merkle_proof: string[];
};

/** Create a payout + its recipient rows. Returns the new payout id. */
export async function createPayout(
  session: WalletSession | null | undefined,
  payout: NewPayoutInput,
  recipients: NewPayoutRecipientInput[],
): Promise<string> {
  const data = await signedFetch<{ id: string }>(
    session,
    "/api/payouts/create",
    "payouts.create",
    { payout, recipients },
  );
  return data.id;
}

export type PayoutUpdatePatch = {
  status?: PayoutStatus;
  fundedTx?: string;
  /** true -> server stamps airdrop_started_at = now. */
  airdropStarted?: boolean;
  /** true -> server stamps airdrop_completed_at = now. */
  airdropCompleted?: boolean;
};

/** Lifecycle update (mark funded / go live / cancel / airdrop stamps).
 *  Server stamps funded_at when status moves to "funded". */
export async function updatePayout(
  session: WalletSession | null | undefined,
  id: string,
  patch: PayoutUpdatePatch,
): Promise<void> {
  await signedFetch(session, "/api/payouts/update", "payouts.update", {
    id,
    ...patch,
  });
}

/** Mark a sent airdrop batch as claimed (claimed_at stamped server-side). */
export async function markPayoutRecipientsClaimed(
  session: WalletSession | null | undefined,
  payoutId: string,
  wallets: string[],
  claimedTx: string,
): Promise<void> {
  await signedFetch(session, "/api/payouts/recipients", "payouts.recipients", {
    payoutId,
    op: "mark_claimed",
    wallets,
    claimedTx,
  });
}

/** Record a send failure on still-unclaimed recipient rows of a batch. */
export async function setPayoutRecipientsSendError(
  session: WalletSession | null | undefined,
  payoutId: string,
  wallets: string[],
  sendError: string,
): Promise<void> {
  await signedFetch(session, "/api/payouts/recipients", "payouts.recipients", {
    payoutId,
    op: "set_error",
    wallets,
    sendError,
  });
}

export type SnapshotRow = { wallet: string; shares: number };

export type ParseResult = {
  rows: SnapshotRow[];
  errors: string[];
};

export function parseSnapshotCsv(text: string): ParseResult {
  const rows: SnapshotRow[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i].trim();
    if (!raw) continue;
    if (raw.startsWith("#")) continue;

    const parts = raw.split(/[,;\t]/).map((s) => s.trim());
    if (parts.length < 2) {
      errors.push(`Line ${i + 1}: expected two columns, got "${raw}"`);
      continue;
    }
    const [wallet, sharesStr] = parts;

    // Skip a header row.
    if (
      i === 0 &&
      /^(wallet|address|pubkey)$/i.test(wallet) &&
      /^(shares|amount|weight)$/i.test(sharesStr)
    ) {
      continue;
    }

    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) {
      errors.push(`Line ${i + 1}: "${wallet}" is not a valid base58 pubkey`);
      continue;
    }
    if (seen.has(wallet)) {
      errors.push(`Line ${i + 1}: wallet ${wallet} appears more than once`);
      continue;
    }
    const shares = Number(sharesStr);
    if (!Number.isFinite(shares) || shares <= 0) {
      errors.push(
        `Line ${i + 1}: shares "${sharesStr}" is not a positive number`,
      );
      continue;
    }
    seen.add(wallet);
    rows.push({ wallet, shares });
  }

  return { rows, errors };
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

export type BuiltMerkle = {
  rootHex: string;
  perWallet: Array<{
    wallet: string;
    shares: number;
    amount: number;
    index: number;
    proofHex: string[];
  }>;
  totalShares: number;
  perShare: number;
};

/**
 * Builds the Merkle tree for a snapshot and computes per-recipient amounts.
 *
 * Leaves are sorted by wallet (lexicographic on the base58 string) so the
 * tree is reproducible from the same input. Per-recipient amount uses 8
 * decimal places (truncated, not rounded) so we can never over-allocate;
 * dust stays with the issuer.
 */
export async function buildMerkle(
  rows: SnapshotRow[],
  totalAmount: number,
): Promise<BuiltMerkle> {
  const sorted = [...rows].sort((a, b) =>
    a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0,
  );
  const totalShares = sorted.reduce((acc, r) => acc + r.shares, 0);
  const perShare = totalShares > 0 ? totalAmount / totalShares : 0;

  // We hash address || u64-LE(shares). Shares are floor'd to a u64 to match
  // the on-chain helper. For the v0.1 tooling that's fine: snapshots are
  // share counts (integers in practice). If we ever pass fractional weights
  // we'd flip the helper to a fixed-point representation.
  const leaves = await Promise.all(
    sorted.map((r) =>
      snapshotLeaf(r.wallet as Address, BigInt(Math.floor(r.shares))),
    ),
  );
  const root = await merkleRoot(leaves);

  const perWallet = await Promise.all(
    sorted.map(async (r, idx) => ({
      wallet: r.wallet,
      shares: r.shares,
      amount: Math.floor(r.shares * perShare * 1e8) / 1e8,
      index: idx,
      proofHex: (await merkleProof(leaves, idx)).map(toHex),
    })),
  );

  return {
    rootHex: toHex(root),
    perWallet,
    totalShares,
    perShare,
  };
}
