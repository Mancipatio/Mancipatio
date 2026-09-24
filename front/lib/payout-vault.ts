"use client";

// PayoutVault lifecycle helpers (issuer + admin scope).
//
// Thin typed wrappers around the Codama-generated PayoutVault instructions plus
// the on-chain bookkeeping needed to drive them from the UI:
//   - PDA resolution (vault / escrow / vote PDAs)
//   - enumeration of PayoutVault accounts (getProgramAccounts scan + decode)
//   - state / label maps shared by the issuer dashboard and admin oversight
//   - a content-hash helper so a free-text founder update can be committed to
//     `post_update` as the on-chain 32-byte digest.
//
// On-chain reference (asset_registry):
//   open_payout_vault  — escrow sweep + vault init  (sale.status==Open, raise==Startup)
//   post_update        — monthly content hash       (vault.state==Active, founder)
//   release_payout     — time-gated tranche         (vault.state==Active)
//   freeze_vault       — 3+ overdue periods         (vault.state==Active)
//   open_vault_vote    — frozen-vault investor vote (admin gate, state==Frozen)
//   finalize_vault_vote— tally → Cancelled/Active   (state==Frozen, vote ended)
//   route_yield        — distribute third/third/third (admin gate, state==Active)

import { getBase58Decoder, type Base58EncodedBytes, type Address } from "@solana/kit";
import type { SolanaClient } from "@solana/client";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  findOpenPayoutVaultEscrowPda,
  findVaultPda,
  fetchMaybeVaultVote,
  getVaultVoteDecoder,
  getVaultVoteDiscriminatorBytes,
  VaultVoteOutcome,
  type VaultVote,
  getPayoutVaultDiscriminatorBytes,
  PayoutVaultState,
  type PayoutVault,
} from "@/lib/generated/asset_registry";

import { decodePayoutVaultV2 } from "@/lib/account-versions";

type Rpc = SolanaClient["runtime"]["rpc"];

// ── PDA helpers ───────────────────────────────────────────────────────────────

/** `["payout", sale]` — the PayoutVault PDA for a given sale. */
export async function payoutVaultPda(sale: Address): Promise<Address> {
  const [pda] = await findVaultPda({ sale });
  return pda;
}

/** `["payout_escrow", vault]` — payment-token escrow owned by the vault PDA. */
export async function payoutEscrowPda(vault: Address): Promise<Address> {
  const [pda] = await findOpenPayoutVaultEscrowPda({ vault });
  return pda;
}

export { vaultVotePda } from "@/lib/payout-vote-pda";
import { vaultVotePda } from "@/lib/payout-vote-pda";
export type VaultVoteRecord = { address: Address; vote: VaultVote };
export async function currentVaultVote(rpc: Rpc, vault: Address, round: bigint): Promise<VaultVoteRecord | null> {
  if (round === BigInt(0)) return null;
  const pda = await vaultVotePda(vault, round);
  const a = await fetchMaybeVaultVote(rpc, pda, { commitment: "finalized", abortSignal: AbortSignal.timeout(10_000) });
  if (!a.exists) return null;
  if (a.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS || a.data.version !== 2 || a.data.round !== round || a.data.payoutVault !== vault ||
    !a.data.discriminator.every((b, i) => b === getVaultVoteDiscriminatorBytes()[i])) throw new Error("Vault vote identity or round mismatch");
  return { address: pda, vote: a.data };
}
export async function loadVaultVoteHistory(rpc: Rpc, vault: Address): Promise<VaultVoteRecord[]> {
  const disc = getVaultVoteDiscriminatorBytes();
  const records = await rpc.getProgramAccounts(ASSET_REGISTRY_PROGRAM_ADDRESS, { commitment: "finalized", encoding: "base64",
    filters: [{ memcmp: { offset: BigInt(0), encoding: "base58", bytes: getBase58Decoder().decode(disc) as Base58EncodedBytes } },
      { memcmp: { offset: BigInt(8), encoding: "base58", bytes: vault as unknown as Base58EncodedBytes } }] }).send({ abortSignal: AbortSignal.timeout(10_000) });
  const history: VaultVoteRecord[] = [];
  for (const r of records) {
    if (r.account.owner !== ASSET_REGISTRY_PROGRAM_ADDRESS) throw new Error("Unexpected vault vote owner");
    const bytes = Uint8Array.from(atob(r.account.data[0]), (c) => c.charCodeAt(0));
    if (!disc.every((b, i) => b === bytes[i])) throw new Error("Unexpected vault vote discriminator");
    const vote = getVaultVoteDecoder().decode(bytes);
    if (vote.version !== 2 || vote.payoutVault !== vault || await vaultVotePda(vault, vote.round) !== r.pubkey) throw new Error("Invalid vault vote history identity");
    history.push({ address: r.pubkey, vote });
  }
  return history.sort((a, b) => a.vote.round > b.vote.round ? -1 : a.vote.round < b.vote.round ? 1 : 0);
}
export function vaultVoteActions(vault: PayoutVault, vote: VaultVote | null, nowSec: number) {
  const current = vault.version === 2 && vote?.version === 2 && vote.round === vault.voteRound;
  const pending = current && vault.state === PayoutVaultState.Frozen && vault.votePending && vote.outcome === VaultVoteOutcome.Pending;
  return {
    canOpen: vault.version === 2 && vault.state === PayoutVaultState.Frozen && !vault.votePending,
    canFinalize: !!pending && BigInt(nowSec) >= vote.endTs,
    canCast: !!pending && BigInt(nowSec) >= vote.startTs && BigInt(nowSec) < vote.endTs,
    canRefund: !!current && vault.state === PayoutVaultState.Cancelled && !vault.votePending && vote.outcome === VaultVoteOutcome.ReturnCapital,
  };
}

// ── Enumeration ─────────────────────────────────────────────────────────────

/** A decoded PayoutVault together with the address it lives at. */
export type PayoutVaultRecord = {
  address: Address;
  vault: PayoutVault;
};

/**
 * Scans the asset_registry program for PayoutVault accounts and decodes them.
 *
 * PayoutVaults are not part of NetworkData (they are sale-seeded, not in the
 * issuer/asset graph), so we resolve them directly via getProgramAccounts and
 * a discriminator filter — mirroring the custody-vault fallback scan in
 * app/admin/custody/page.tsx.
 */
export async function loadPayoutVaults(rpc: Rpc): Promise<PayoutVaultRecord[]> {
  const res = await rpc
    .getProgramAccounts(ASSET_REGISTRY_PROGRAM_ADDRESS, { encoding: "base64", commitment: "finalized" })
    .send();
  const disc = getPayoutVaultDiscriminatorBytes();
  const out: PayoutVaultRecord[] = [];
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
    if (match) {
      if (r.account.owner !== ASSET_REGISTRY_PROGRAM_ADDRESS) throw new Error("Unexpected payout vault owner");
      const vault = decodePayoutVaultV2(bytes);
      if (await payoutVaultPda(vault.sale) !== r.pubkey) throw new Error("Payout vault PDA mismatch");
      out.push({ address: r.pubkey, vault });
    }
  }
  return out;
}

// ── Labels & display helpers ──────────────────────────────────────────────────

export const VAULT_STATE_LABEL: Record<PayoutVaultState, string> = {
  [PayoutVaultState.Active]: "Active",
  [PayoutVaultState.Frozen]: "Frozen",
  [PayoutVaultState.Completed]: "Completed",
  [PayoutVaultState.Cancelled]: "Cancelled",
};

export const VAULT_STATE_BADGE: Record<PayoutVaultState, string> = {
  [PayoutVaultState.Active]: "border-emerald-200 bg-emerald-50 text-emerald-700",
  [PayoutVaultState.Frozen]: "border-rose-200 bg-rose-50 text-rose-700",
  [PayoutVaultState.Completed]: "border-slate-300 bg-slate-100 text-slate-600",
  [PayoutVaultState.Cancelled]: "border-slate-300 bg-slate-100 text-slate-500",
};

/** Seconds in a month — matches `MONTH` in the on-chain constants. */
export const MONTH_SECONDS = 2_592_000;

/**
 * UNIX timestamp (seconds) of the i-th tranche / update period boundary.
 * Tranche `i` (0-based) is due at `start_ts + i * MONTH`.
 */
export function periodTs(vault: PayoutVault, periodIndex: number): number {
  return Number(vault.startTs) + periodIndex * MONTH_SECONDS;
}

/**
 * Whether the next release tranche is time-due AND has its required update
 * posted (the on-chain `release_payout` guards). Returns false in any terminal
 * or blocked state.
 */
export function nextReleaseReady(vault: PayoutVault, nowSec: number): boolean {
  if (vault.version !== 2 || vault.state !== PayoutVaultState.Active) return false;
  if (vault.tranchesReleased >= vault.numTranches) return false;
  const due = periodTs(vault, vault.tranchesReleased);
  if (nowSec < due) return false;
  // Each release requires an update for that period to already be posted.
  return vault.updatesPosted > vault.tranchesReleased;
}

/**
 * Whether the next monthly update is time-due and still owed (the on-chain
 * `post_update` guards: updates_posted < num_tranches, now >= period_start).
 */
export function nextUpdateDue(vault: PayoutVault, nowSec: number): boolean {
  if (vault.version !== 2 || vault.state !== PayoutVaultState.Active) return false;
  if (vault.updatesPosted >= vault.numTranches) return false;
  const periodStart = periodTs(vault, vault.updatesPosted);
  return nowSec >= periodStart;
}

/**
 * Periods overdue = elapsed-since-start (1-based, capped at num_tranches) minus
 * updates already posted. Mirrors the freeze/finalize math on-chain; a value
 * >= 3 (MISSED_FREEZE_THRESHOLD) makes the vault freezable.
 */
export function periodsOverdue(vault: PayoutVault, nowSec: number): number {
  const start = Number(vault.startTs);
  const elapsed =
    nowSec <= start ? 0 : Math.floor((nowSec - start) / MONTH_SECONDS) + 1;
  const periodsElapsed = Math.max(0, Math.min(elapsed, vault.numTranches));
  return Math.max(0, periodsElapsed - vault.updatesPosted);
}

export const MISSED_FREEZE_THRESHOLD = 3;

/** Whether the vault meets the on-chain freeze precondition. */
export function isFreezable(vault: PayoutVault, nowSec: number): boolean {
  return (
    vault.version === 2 && vault.state === PayoutVaultState.Active &&
    periodsOverdue(vault, nowSec) >= MISSED_FREEZE_THRESHOLD
  );
}

/**
 * Hashes a short free-text founder update to the 32-byte digest the program
 * stores as the period's content hash (`post_update.content_hash`). SHA-256 of
 * the UTF-8 text — deterministic and re-derivable from the same content.
 */
export async function hashUpdateContent(text: string): Promise<Uint8Array> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(digest);
}

/** Lower-case hex of a byte array — for displaying a committed content hash. */
export function toHex(bytes: ReadonlyUint8ArrayLike): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

type ReadonlyUint8ArrayLike = ArrayLike<number>;
