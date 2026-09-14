"use client";

// Push-based revenue distributions (docs §2–§5).
//
// The issuer sends funds (e.g. USDT) to the program escrow via
// `create_distribution` (which also flips the status to Distributing), pro-rata
// payouts are computed off-chain from a holder snapshot, and `distribute_batch`
// pushes each holder's share straight to their payment-token account
// (remaining_accounts[i] receives amounts[i], order-aligned). `close_distribution`
// sweeps the rounding remainder to a refund account.
//
// This module hosts the shared client-side pieces:
//   - enumeration of Distribution accounts (getProgramAccounts scan + decode)
//   - the holder snapshot (live Token-2022 mint scan)
//   - pro-rata math (BigInt floor — never over-allocates, dust stays for close)
//   - payment-mint token-program detection (classic SPL vs Token-2022)

import type { SolanaClient } from "@solana/client";
import { isAddress, type Address, type Base58EncodedBytes } from "@solana/kit";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  DistributionStatus,
  getDistributionDecoder,
  getDistributionDiscriminatorBytes,
  type Distribution,
} from "@/lib/generated/asset_registry";
import { fetchPlainPaymentMintTokenProgram } from "@/lib/transaction-builders";
import { DISTRIBUTION_PLAN_BATCH_SIZE } from "@/lib/distribution-plans";
import { merkleRoot, snapshotLeaf } from "@/lib/merkle";

type Rpc = SolanaClient["runtime"]["rpc"];

export const TOKEN_2022_ADDRESS =
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" as Address;
// Payment mints (USDC/USDT) are usually classic SPL Token.
export const TOKEN_CLASSIC_ADDRESS =
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;
const SYSTEM_PROGRAM_ADDRESS = "11111111111111111111111111111111" as Address;

/**
 * Recipients per `distribute_batch` transaction. Each recipient also needs an
 * idempotent create-ATA instruction in the same tx, so one batch is
 * N create-ATA ixs + 1 distribute ix with N remaining accounts.
 */
export const DISTRIBUTE_BATCH_SIZE = DISTRIBUTION_PLAN_BATCH_SIZE;

// ── Enumeration ─────────────────────────────────────────────────────────────

/** A decoded Distribution together with the address it lives at. */
export type DistributionRecord = {
  address: Address;
  distribution: Distribution;
};

/**
 * Scans the asset_registry program for Distribution accounts and decodes them.
 * Mirrors `loadPayoutVaults` in lib/payout-vault.ts — Distributions are not
 * part of NetworkData, so we resolve them directly.
 */
export async function loadDistributions(
  rpc: Rpc,
): Promise<DistributionRecord[]> {
  const res = await rpc
    .getProgramAccounts(ASSET_REGISTRY_PROGRAM_ADDRESS, {
      encoding: "base64",
      commitment: "finalized",
    })
    .send();
  const disc = getDistributionDiscriminatorBytes();
  const decoder = getDistributionDecoder();
  const out: DistributionRecord[] = [];
  let skipped = 0;
  for (const r of res) {
    const b64 = (r.account.data as readonly [string, string])[0];
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    if (bytes.length < 8) continue;
    let match = true;
    for (let i = 0; i < 8; i += 1) {
      if (bytes[i] !== disc[i]) {
        match = false;
        break;
      }
    }
    if (!match) continue;
    // Decode per-account defensively: an account carrying the Distribution
    // discriminator but a stale/legacy byte layout (e.g. created by an older
    // program binary during a deploy gap) throws in the fixed-size codec. One
    // such account must NEVER blank the whole payouts/rights page, so skip it.
    try {
      out.push({ address: r.pubkey, distribution: decoder.decode(bytes) });
    } catch (err) {
      skipped += 1;
      console.warn(
        `[distributions] skipped undecodable account ${r.pubkey.toString()} (legacy layout?):`,
        err,
      );
    }
  }
  if (skipped > 0) {
    console.warn(
      `[distributions] ${skipped} distribution account(s) skipped — undecodable layout`,
    );
  }
  return out;
}

// ── Labels & display helpers ──────────────────────────────────────────────────

export const DISTRIBUTION_STATUS_LABEL: Record<DistributionStatus, string> = {
  [DistributionStatus.Funding]: "Funding",
  [DistributionStatus.Distributing]: "Distributing",
  [DistributionStatus.Closed]: "Closed",
};

export const DISTRIBUTION_STATUS_BADGE: Record<DistributionStatus, string> = {
  [DistributionStatus.Funding]: "border-amber-200 bg-amber-50 text-amber-700",
  [DistributionStatus.Distributing]:
    "border-emerald-200 bg-emerald-50 text-emerald-700",
  [DistributionStatus.Closed]: "border-slate-300 bg-slate-100 text-slate-500",
};

// ── Holder snapshot ───────────────────────────────────────────────────────────

export type HolderWeight = { wallet: string; weight: bigint };

/** Result of a mint-holder scan, split by owner-account classification. */
export type MintHolderScan = {
  /**
   * Wallet holders — owner accounts owned by the system program (or not yet
   * funded on-chain). Sorted by wallet, weights summed per owner.
   */
  holders: HolderWeight[];
  /**
   * Owner accounts owned by a program (deal/offer/vault/distribution escrow
   * PDAs and the like) — not payable wallets, excluded from `holders`.
   */
  excluded: HolderWeight[];
  /** Sum of `excluded` weights, for the "N escrow-held balances" UI note. */
  excludedWeight: bigint;
};

/**
 * Every non-zero Token-2022 holder of a mint (memcmp on mint at offset 0),
 * summed per owner wallet. Same scan as `loadMintHolders` in
 * app/portfolio/rights/page.tsx, hosted here so the admin distribution flow
 * can snapshot a share class' holder base directly from chain.
 *
 * After the balance scan the owner accounts are batch-fetched
 * (`getMultipleAccounts`, chunks of 100) and classified: owners that exist
 * on-chain but are NOT owned by the system program are PDAs (escrows), and
 * land in `excluded` instead of `holders`. Missing owner accounts are kept as
 * holders — an unfunded wallet is still a valid payout destination.
 */
export async function loadMintHolders(
  rpc: Rpc,
  mint: Address,
): Promise<MintHolderScan> {
  const res = await rpc
    .getProgramAccounts(TOKEN_2022_ADDRESS, {
      encoding: "jsonParsed",
      commitment: "finalized",
      filters: [
        {
          memcmp: {
            offset: BigInt(0),
            bytes: mint.toString() as Base58EncodedBytes,
            encoding: "base58",
          },
        },
      ],
    })
    .send();
  const byOwner = new Map<string, bigint>();
  for (const item of res) {
    const data = item.account?.data as unknown;
    if (!data || typeof data !== "object" || !("parsed" in data)) continue;
    const info = (
      data as {
        parsed?: {
          info?: { owner?: string; tokenAmount?: { amount?: string } };
        };
      }
    ).parsed?.info;
    if (!info?.owner || !info?.tokenAmount?.amount) continue;
    const amount = BigInt(info.tokenAmount.amount);
    if (amount === BigInt(0)) continue;
    byOwner.set(info.owner, (byOwner.get(info.owner) ?? BigInt(0)) + amount);
  }
  const all = [...byOwner.entries()]
    .map(([wallet, weight]) => ({ wallet, weight }))
    .sort((a, b) => (a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0));

  // Classify owner accounts: program-owned owners are escrows, not wallets.
  const programOwned = new Set<string>();
  const CHUNK = 100;
  for (let i = 0; i < all.length; i += CHUNK) {
    const chunk = all.slice(i, i + CHUNK).map((r) => r.wallet as Address);
    const infos = await rpc
      .getMultipleAccounts(chunk, {
        encoding: "base64",
        commitment: "finalized",
      })
      .send();
    infos.value.forEach((acc, j) => {
      if (acc && acc.owner.toString() !== SYSTEM_PROGRAM_ADDRESS.toString()) {
        programOwned.add(chunk[j].toString());
      }
    });
  }
  const holders: HolderWeight[] = [];
  const excluded: HolderWeight[] = [];
  let excludedWeight = BigInt(0);
  for (const row of all) {
    if (programOwned.has(row.wallet)) {
      excluded.push(row);
      excludedWeight += row.weight;
    } else {
      holders.push(row);
    }
  }
  return { holders, excluded, excludedWeight };
}

// ── Snapshot Merkle builder ───────────────────────────────────────────────────

export type SnapshotMerkle = {
  root: Uint8Array;
  rootHex: string;
  totalWeight: bigint;
  count: number;
};

/**
 * Builds the sorted-pair SHA-256 snapshot tree over `(wallet, weight)` rows —
 * the exact leaf/tree shape /portfolio/rights rebuilds from a live mint scan
 * (`snapshotLeaf` + `merkleRoot` in lib/merkle.ts), so a root derived here is
 * reproducible by holders when they later derive claim/vote proofs.
 */
export async function buildSnapshotMerkle(
  rows: HolderWeight[],
): Promise<SnapshotMerkle> {
  const sorted = [...rows].sort((a, b) =>
    a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0,
  );
  const leaves = await Promise.all(
    sorted.map((r) => snapshotLeaf(r.wallet as Address, r.weight)),
  );
  const root = await merkleRoot(leaves);
  let rootHex = "";
  for (let i = 0; i < root.length; i += 1) {
    rootHex += root[i].toString(16).padStart(2, "0");
  }
  const totalWeight = sorted.reduce((acc, r) => acc + r.weight, BigInt(0));
  return { root, rootHex, totalWeight, count: sorted.length };
}

/**
 * Parses a `wallet,weight` CSV (integer base-unit weights — unlike
 * `parseSnapshotCsv` in lib/payouts.ts, which parses fractional share counts).
 * Duplicate wallets are summed; zero-weight rows are dropped.
 */
export function parseWeightCsv(text: string): {
  rows: HolderWeight[];
  errors: string[];
} {
  const byWallet = new Map<string, bigint>();
  const errors: string[] = [];
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  lines.forEach((line, i) => {
    if (i === 0 && /wallet/i.test(line)) return; // header row
    const [w, a] = line.split(",").map((s) => s.trim());
    if (!w || !isAddress(w)) {
      errors.push(`Line ${i + 1}: invalid wallet address.`);
      return;
    }
    let weight: bigint;
    try {
      weight = BigInt(a ?? "");
    } catch {
      errors.push(`Line ${i + 1}: weight must be a whole number.`);
      return;
    }
    if (weight < BigInt(0)) {
      errors.push(`Line ${i + 1}: weight must not be negative.`);
      return;
    }
    if (weight === BigInt(0)) return;
    byWallet.set(w, (byWallet.get(w) ?? BigInt(0)) + weight);
  });
  return {
    rows: [...byWallet.entries()].map(([wallet, weight]) => ({
      wallet,
      weight,
    })),
    errors,
  };
}

// ── Pro-rata math ─────────────────────────────────────────────────────────────

export type ProRataRow = HolderWeight & {
  /** Floor(total_amount * weight / total_weight) in payment base units. */
  amount: bigint;
};

export type ProRataResult = {
  /** Rows with amount > 0 — the only ones `distribute_batch` accepts. */
  eligible: ProRataRow[];
  /** Rows whose floor-rounded amount is 0 (dust) — skipped on-chain. */
  skipped: ProRataRow[];
  totalWeight: bigint;
  allocated: bigint;
};

/**
 * Computes pro-rata payout amounts against a holder snapshot. Floor rounding
 * via BigInt division (same never-over-allocate convention as buildMerkle in
 * lib/payouts.ts): the allocated sum can be less than `totalAmount` and the
 * remainder stays in the escrow for `close_distribution` to refund.
 *
 * Rows are deterministic inputs to the immutable plan prepared before funding.
 * Resume uses committed batch receipts, never live-holder row offsets.
 */
export function computeProRata(
  rows: HolderWeight[],
  totalAmount: bigint,
): ProRataResult {
  const sorted = [...rows].sort((a, b) =>
    a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0,
  );
  const totalWeight = sorted.reduce((acc, r) => acc + r.weight, BigInt(0));
  const eligible: ProRataRow[] = [];
  const skipped: ProRataRow[] = [];
  let allocated = BigInt(0);
  for (const r of sorted) {
    const amount =
      totalWeight > BigInt(0)
        ? (totalAmount * r.weight) / totalWeight
        : BigInt(0);
    const row = { ...r, amount };
    if (amount > BigInt(0)) {
      eligible.push(row);
      allocated += amount;
    } else {
      skipped.push(row);
    }
  }
  return { eligible, skipped, totalWeight, allocated };
}

/** Largest-remainder allocation consumes the exact funding amount. Equal
 * fractional remainders are resolved by wallet ASCII order, recorded in plan. */
export function computeDistributionAllocation(
  rows: HolderWeight[],
  totalAmount: bigint,
): ProRataResult {
  if (totalAmount <= BigInt(0) || rows.some((row) => row.weight <= BigInt(0)))
    throw new Error("Positive funding and holder weights are required");
  const result = computeProRata(rows, totalAmount),
    totalWeight = result.totalWeight;
  if (totalWeight <= BigInt(0))
    throw new Error("A non-empty holder snapshot is required");
  const all = [...result.eligible, ...result.skipped].map((row) => ({
    ...row,
    remainder: (totalAmount * row.weight) % totalWeight,
  }));
  all.sort((a, b) =>
    a.remainder > b.remainder
      ? -1
      : a.remainder < b.remainder
        ? 1
        : a.wallet < b.wallet
          ? -1
          : a.wallet > b.wallet
            ? 1
            : 0,
  );
  let remaining = totalAmount - result.allocated;
  for (const row of all) {
    if (remaining === BigInt(0)) break;
    row.amount += BigInt(1);
    remaining -= BigInt(1);
  }
  if (remaining !== BigInt(0))
    throw new Error("Distribution remainder could not be assigned");
  const ordered = all
    .map(({ wallet, weight, amount }) => ({ wallet, weight, amount }))
    .sort((a, b) => (a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0));
  return {
    eligible: ordered.filter((row) => row.amount > BigInt(0)),
    skipped: ordered.filter((row) => row.amount === BigInt(0)),
    allocated: totalAmount,
    totalWeight,
  };
}

// ── Payment mint helpers ──────────────────────────────────────────────────────

/** Random u64 id, saved with the immutable plan before any funding. */
export function newDistributionId(): bigint {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return new DataView(bytes.buffer).getBigUint64(0, true);
}

/** Fail closed on RPC failures and unsupported fee/hook-bearing payment mints. */
export async function detectTokenProgram(
  rpc: Rpc,
  mint: Address,
): Promise<Address> {
  return fetchPlainPaymentMintTokenProgram(rpc, mint);
}
