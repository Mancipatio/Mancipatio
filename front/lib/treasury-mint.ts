"use client";

// Mint into the ISSUER TREASURY, headless: the one copy of the raise-limit
// reservation, the destination binding, the confirmation wait and the release
// on failure. TreasuryMintPanel (/admin/share-classes) and "Send to wallets"
// (which creates only the shortfall of a list) both run it.
//
// Program package 2B: only an Admin issuer key reaches the treasury, and the
// mint counts against the issuer's (SPV's) rolling 12-month raise limit: its
// declared EUR value is reserved first (/api/sale-approvals/treasury-mint, a
// signed message) and booked by the server once the transaction finalizes.
// A send that never left the browser releases the reservation once its
// blockhash can no longer land.
//
// One transaction: [create the treasury token account (idempotent),
// mint_to_treasury, set_pause_flags(set 0x02)?]. The re-pause rides in the
// same transaction when the distribution asks for it (Primary issuance is
// global: it is closed again in the very transaction that used it, unless a
// sale of any issuer is Open and needs it). Measured: 626 B with the send
// path's compute-budget instructions (tests/send-outcome.test.ts).
import type { TransactionPrepareAndSendRequest, WalletSession } from "@solana/client";
import type { Address, Instruction, TransactionSigner } from "@solana/kit";
import { getCreateAssociatedTokenIdempotentInstructionAsync } from "@solana-program/token-2022";
import {
  getMintToTreasuryInstructionAsync,
  getSetPauseFlagsInstructionAsync,
  type ShareClass,
} from "@/lib/generated/asset_registry";
import { resolveIssuerPermission, ISSUER_CAPABILITIES } from "@/lib/issuer-permissions";
import { PAUSE_PRIMARY } from "@/lib/pause-flags";
import { clearPauseFlagsCache } from "@/lib/pause-gate";
import { releaseWhenExpired, reserveTreasuryMint } from "@/lib/sale-approvals";
import { recordAudit } from "@/lib/supabase";
import { tokenAccountOf, TOKEN_2022 } from "@/lib/share-transfer";
import { waitForSignature, type SignatureOutcome } from "@/lib/simulation-gate";
import { confirmThenReport } from "@/lib/send-outcome";
import { walletSigner } from "@/lib/wallet-signer";
import type { Rpc } from "@/lib/tokenize-shares-chain";

/** The raise-limit ledger needs a reason of 5–1000 characters (treasury-mint route). */
export const TREASURY_MINT_REASON_MIN = 5;

/** The mint transaction's instructions, in program order. */
export async function buildTreasuryMintIxs(input: {
  signer: TransactionSigner;
  issuerPda: Address;
  asset: Address;
  scPda: Address;
  mint: Address;
  amount: bigint;
  /** The issuer-permission proof for Mint (the Admin record of an Admin issuer key). */
  adminRecord: Address;
  /** Close Primary issuance (0x02) again in the same transaction. */
  repause: boolean;
}): Promise<{ instructions: Instruction[]; destination: Address }> {
  const destination = await tokenAccountOf(input.signer.address, input.mint);
  const instructions: Instruction[] = [
    await getCreateAssociatedTokenIdempotentInstructionAsync({
      payer: input.signer,
      owner: input.signer.address,
      mint: input.mint,
      tokenProgram: TOKEN_2022,
    }),
    await getMintToTreasuryInstructionAsync({
      authority: input.signer,
      adminRecord: input.adminRecord,
      issuer: input.issuerPda,
      asset: input.asset,
      shareClass: input.scPda,
      destination,
      tokenProgram: TOKEN_2022,
      amount: input.amount,
    }),
  ];
  // After the mint: mint_to_treasury reads 0x02 when it runs, set_pause_flags then closes it.
  if (input.repause) {
    instructions.push(await getSetPauseFlagsInstructionAsync({ authority: input.signer, setMask: PAUSE_PRIMARY, clearMask: 0 }));
  }
  return { instructions, destination };
}

/** What useSendTransaction().send takes (the verified client's prepareAndSend). */
export type SendFn = (request: TransactionPrepareAndSendRequest) => Promise<string>;

export type TreasuryMintResult = {
  signature: string;
  reservationId: string;
  lastValidBlockHeight: bigint;
  destination: Address;
  outcome: SignatureOutcome;
};

export class TreasuryMintError extends Error {
  /** The mint left the browser (it may still land); the reservation is not released here. */
  readonly sent: boolean;
  constructor(cause: unknown, sent: boolean) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "TreasuryMintError";
    this.sent = sent;
  }
}

/**
 * Reserve → build → send → wait for the network. Returns once the mint is
 * confirmed, refused or not confirmed in time (`outcome`), with the audit
 * row written for that outcome. Throws (the reservation released once the
 * blockhash expires) when nothing was sent.
 */
export async function runTreasuryMint(input: {
  session: WalletSession;
  rpc: Rpc;
  send: SendFn;
  sc: Pick<ShareClass, "mint" | "asset">;
  scPda: Address;
  issuerPda: Address;
  amount: bigint;
  amountEur: number;
  reason: string;
  repause: boolean;
  /** Extra audit metadata (the distribution run). */
  audit?: Record<string, unknown>;
  onStage?: (stage: "reserve" | "sign" | "confirm") => void;
  /** Called once the transaction is submitted, before the wait (the distribution journal). */
  onSent?: (sent: { signature: string; lastValidBlockHeight: bigint; reservationId: string }) => void;
  confirmTimeoutMs?: number;
}): Promise<TreasuryMintResult> {
  const { session, rpc } = input;
  const actor = session.account.address.toString();
  let reservationId: string | null = null;
  let lastValidBlockHeight: bigint | null = null;
  let signature: string | null = null;
  try {
    input.onStage?.("reserve");
    const reserved = await reserveTreasuryMint(session, {
      share_class: input.scPda,
      amount_units: input.amount.toString(),
      amount_eur: input.amountEur,
      reason: input.reason,
    });
    reservationId = reserved.reservation_id;
    const signer = walletSigner(session);
    const adminRecord = await resolveIssuerPermission(rpc, input.issuerPda, signer.address, ISSUER_CAPABILITIES.Mint);
    const { instructions, destination } = await buildTreasuryMintIxs({
      signer,
      issuerPda: input.issuerPda,
      asset: input.sc.asset,
      scPda: input.scPda,
      mint: input.sc.mint,
      amount: input.amount,
      adminRecord,
      repause: input.repause,
    });
    // A known lifetime: after a failed send the reservation is released
    // only once this blockhash can no longer land (server-proven).
    const lifetime = (await rpc.getLatestBlockhash({ commitment: "confirmed" }).send()).value;
    lastValidBlockHeight = lifetime.lastValidBlockHeight;
    input.onStage?.("sign");
    signature = await input.send({ lifetime, prepareTransaction: { blockhashReset: false }, instructions, feePayer: signer });
    input.onSent?.({ signature, lastValidBlockHeight, reservationId });
    if (input.repause) clearPauseFlagsCache();
    input.onStage?.("confirm");
    const sig = signature;
    const id = reservationId;
    const audit = (status: "success" | "failed" | "pending", extra: Record<string, unknown> = {}) =>
      recordAudit({
        ix_name: "mint_to_treasury",
        category: "share-class",
        actor_wallet: actor,
        reason: input.reason,
        target_label: input.scPda.toString(),
        tx_signature: sig,
        status,
        metadata: {
          destination: "issuer_treasury",
          destination_wallet: actor,
          destination_token_account: destination.toString(),
          amount: input.amount.toString(),
          amount_eur: input.amountEur,
          reservation_id: id,
          repause_primary: input.repause,
          ...input.audit,
          ...extra,
        },
      });
    // The server books it: the alarm worker sees the finalized mint and the
    // retry worker's ledger stage books the reservation at the block date
    // (Talas 5.1). Until then it stays counted at the reserved value.
    const outcome = await confirmThenReport(() => waitForSignature(rpc, sig, { timeoutMs: input.confirmTimeoutMs ?? 60_000 }), {
      confirmed: () => void audit("success"),
      failed: () => void audit("failed", { error: "refused by the network" }),
      unconfirmed: (o) => void audit("pending", { confirmation: o }),
    });
    return { signature: sig, reservationId: id, lastValidBlockHeight, destination, outcome };
  } catch (err) {
    if (reservationId && signature === null && lastValidBlockHeight !== null) {
      // The mint may still land until its blockhash expires; the server
      // releases the reservation only after that (the worker otherwise).
      void releaseWhenExpired(session, reservationId, lastValidBlockHeight);
    }
    throw new TreasuryMintError(err, signature !== null);
  }
}

// ── The declared EUR value ──────────────────────────────────────────────────

/** "0.4", "12.5", "1000" (USD per token, at most 6 decimals) → millionths of a USD; null when invalid. */
export function parseUsdPerToken(input: string): bigint | null {
  const s = input.trim().replace(/^\$\s*/, "");
  const m = /^(\d{1,12})(?:\.(\d{1,6}))?$/.exec(s);
  if (!m) return null;
  const e6 = BigInt(m[1]) * BigInt(1_000_000) + BigInt((m[2] ?? "").padEnd(6, "0") || "0");
  return e6 > BigInt(0) ? e6 : null;
}

/**
 * The EUR value a treasury mint of `units` declares against the raise limit:
 * units × the USD value of one token (USD = USDC 1:1) × the live USDC→EUR
 * rate, rounded UP to the cent, and at least €1 (the ledger's floor).
 */
export function treasuryMintEur(input: { units: bigint; usdPerTokenE6: bigint; eurPerUsdc: number }): number {
  if (!(input.eurPerUsdc > 0) || !Number.isFinite(input.eurPerUsdc)) throw new Error("No USDC→EUR rate");
  const usd = Number(input.units * input.usdPerTokenE6) / 1_000_000;
  const eur = Math.ceil(usd * input.eurPerUsdc * 100 - 1e-9) / 100;
  return Math.max(1, eur);
}
