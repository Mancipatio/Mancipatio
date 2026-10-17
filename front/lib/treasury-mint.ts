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
// same transaction when the caller asks for it (Send to wallets and the
// admin panel both decide with lib/public-sale mintRepausesPrimary: Primary
// issuance is global, so it is closed again in the very transaction that
// used it, unless a sale of any issuer is Open and needs it). Measured:
// 626 B with the send path's compute-budget instructions
// (tests/send-outcome.test.ts).
//
// Before the reservation is signed, the gate the send path applies later
// (lib/pause-gate.ts) is read here: KYC-only mode and the 0x02 pause refuse
// the mint without a signature, a reservation row or the release prompts a
// refused reservation used to cost (one every 15 s for up to 3 minutes).
import type { TransactionPrepareAndSendRequest, WalletSession } from "@solana/client";
import type { Address, Instruction, TransactionSigner } from "@solana/kit";
import { getCreateAssociatedTokenIdempotentInstructionAsync } from "@solana-program/token-2022";
import {
  AssetRegistryInstruction,
  getMintToTreasuryInstructionAsync,
  getSetPauseFlagsInstructionAsync,
  type ShareClass,
} from "@/lib/generated/asset_registry";
import { kycOnly } from "@/lib/features";
import { resolveIssuerPermission, ISSUER_CAPABILITIES } from "@/lib/issuer-permissions";
import { detectNetwork, type Network } from "@/lib/network";
import { PAUSE_PRIMARY } from "@/lib/pause-flags";
import { clearPauseFlagsCache, heldBit, KycOnlyFlowError, PausedFlowError, readPauseFlags } from "@/lib/pause-gate";
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
 * Says before anything is signed what the send path would refuse after the
 * reservation (lib/pause-gate.ts, the same words): KYC-only mode
 * (KycOnlyFlowError) and the emergency pause on mint_to_treasury, 0x02
 * (PausedFlowError), the flags read through the gate's short cache. An
 * unreadable Platform refuses nothing, as the gate does: the program
 * decides. `opts` are readPauseFlags' (tests inject the read).
 */
export async function assertTreasuryMintAllowed(
  rpc: unknown,
  opts: { network?: Network } & NonNullable<Parameters<typeof readPauseFlags>[1]> = {},
): Promise<void> {
  const { network = detectNetwork(), ...read } = opts;
  if (kycOnly(network)) throw new KycOnlyFlowError(AssetRegistryInstruction.MintToTreasury);
  const flags = await readPauseFlags(rpc, read);
  if (flags === null || flags === 0) return;
  const bit = heldBit(flags, AssetRegistryInstruction.MintToTreasury, { data: null, facts: {} });
  if (bit !== null) throw new PausedFlowError(bit, AssetRegistryInstruction.MintToTreasury);
}

/**
 * Gate → reserve → build → send → wait for the network. Returns once the
 * mint is confirmed, refused or not confirmed in time (`outcome`), with the
 * audit row written for that outcome. Throws (the reservation released once
 * the blockhash expires) when nothing was sent; before the reservation
 * (KYC-only mode, the 0x02 pause, a key without the Mint capability) nothing
 * is reserved at all.
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
    // Said before the reservation: what would refuse the mint after it (the
    // send path checks again), and the Mint capability the proof needs, so a
    // key without it reserves nothing (nothing would release that for 30 min).
    await assertTreasuryMintAllowed(rpc);
    const signer = walletSigner(session);
    const adminRecord = await resolveIssuerPermission(rpc, input.issuerPda, signer.address, ISSUER_CAPABILITIES.Mint);
    input.onStage?.("reserve");
    const reserved = await reserveTreasuryMint(session, {
      share_class: input.scPda,
      amount_units: input.amount.toString(),
      amount_eur: input.amountEur,
      reason: input.reason,
    });
    reservationId = reserved.reservation_id;
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
    // A status read the RPC refused for a moment (429) is retried within the
    // timeout, never answered "unknown" at once (lib/simulation-gate retryReads).
    const outcome = await confirmThenReport(() => waitForSignature(rpc, sig, { timeoutMs: input.confirmTimeoutMs ?? 60_000, retryReads: true }), {
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

/** The ledger's floor (migration 0080) and the route's ceiling (route.ts) for a declared EUR value. */
export const DECLARED_EUR_MIN = 1;
export const DECLARED_EUR_MAX = 1e12;

export type DeclaredEur = { ok: true; eur: number } | { ok: false; error: string };

const DECLARED_EUR_HINT = "e.g. 1000 or 1000.50";

/**
 * The EUR value typed into the admin panel's field, read strictly: digits
 * with at most two decimals after a dot, exactly as typed. "1.000" and
 * "1,000" are ambiguous (one euro or one thousand, by locale), so grouping
 * separators and a third decimal are refused rather than guessed: the
 * raise-limit ledger booked €1 for "1.000" while the confirmation echoed
 * "€1.000". The value is counted in integer cents (no float drift), at
 * least DECLARED_EUR_MIN and at most DECLARED_EUR_MAX; the error is the
 * sentence shown under the field.
 */
export function parseDeclaredEur(input: string): DeclaredEur {
  const s = input.trim().replace(/^€\s*/, "");
  if (s === "") return { ok: false, error: "Enter the EUR value this mint counts against the raise limit." };
  if (/[,\s]/.test(s)) return { ok: false, error: `Use "." for cents and no thousands separators, ${DECLARED_EUR_HINT}.` };
  const m = /^(\d{1,13})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) {
    if (/^\d{14,}(?:\.\d*)?$/.test(s)) return { ok: false, error: "Too large." };
    // Digits with a third decimal or a second dot: a thousands separator, not cents.
    const dots = s.split(".").length - 1;
    const grouped = /^[\d.]+$/.test(s) && (dots > 1 || (dots === 1 && s.length - s.indexOf(".") - 1 > 2));
    return grouped
      ? { ok: false, error: "At most 2 decimals (cents). For one thousand type 1000 — no thousands separators." }
      : { ok: false, error: `Enter the EUR value as a number, ${DECLARED_EUR_HINT}.` };
  }
  const cents = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  const eur = cents / 100;
  if (eur < DECLARED_EUR_MIN) return { ok: false, error: "At least €1 (the raise-limit ledger's floor)." };
  if (eur > DECLARED_EUR_MAX) return { ok: false, error: "Too large." };
  return { ok: true, eur };
}

const EUR_FORMAT = new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR", minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "€1,000.00", "€1.00": the parsed value echoed under the field and in the confirmation (the en-IE EUR style of /admin/spvs). */
export function formatDeclaredEur(eur: number): string {
  return EUR_FORMAT.format(eur);
}

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
