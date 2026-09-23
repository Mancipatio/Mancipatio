// Admin sale approvals (program package 2B) — browser helpers.
//
// The chain is the source of truth for which approvals exist: the issuer
// launchpad lists them with getProgramAccounts (SaleApproval discriminator +
// `issuer` at byte 48, dataSize 213). The /api/sale-approvals/* routes keep
// the EUR raise-cap ledger around them (0066).

import type { SolanaClient, WalletSession } from "@solana/client";
import { getBase58Decoder, signature as toSignature, type Address, type Base58EncodedBytes } from "@solana/kit";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  getSaleApprovalDecoder,
  getSaleApprovalDiscriminatorBytes,
  type SaleApproval,
} from "@/lib/generated/asset_registry";
import { signedFetch } from "@/lib/siws-client";

type Rpc = SolanaClient["runtime"]["rpc"];

/** `8 + SaleApproval::INIT_SPACE` (pinned by the program's layout test). */
export const SALE_APPROVAL_SIZE = 213;
/** Byte offsets of the memcmp filters (pinned by the program's layout test). */
const SHARE_CLASS_OFFSET = 8;
const ISSUER_OFFSET = 48;
/** Mirrors SALE_APPROVAL_MAX_TTL_SECS in the program (90 days). */
export const SALE_APPROVAL_MAX_TTL_SECS = 7_776_000;

export type SaleApprovalAccount = SaleApproval & { address: Address };

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

async function listApprovals(rpc: Rpc, offset: number, key: Address): Promise<SaleApprovalAccount[]> {
  const discriminator = getBase58Decoder().decode(getSaleApprovalDiscriminatorBytes()) as Base58EncodedBytes;
  const rows = await rpc.getProgramAccounts(ASSET_REGISTRY_PROGRAM_ADDRESS, {
    encoding: "base64",
    commitment: "confirmed",
    filters: [
      { dataSize: BigInt(SALE_APPROVAL_SIZE) },
      { memcmp: { offset: BigInt(0), bytes: discriminator, encoding: "base58" } },
      { memcmp: { offset: BigInt(offset), bytes: key as unknown as Base58EncodedBytes, encoding: "base58" } },
    ],
  }).send();
  const decoder = getSaleApprovalDecoder();
  return rows.map((r) => ({
    ...decoder.decode(b64ToBytes((r.account.data as readonly [string, string])[0])),
    address: r.pubkey,
  }));
}

/** Every live approval of an issuer (the Issuer PDA), expired ones included. */
export function listIssuerSaleApprovals(rpc: Rpc, issuerPda: Address) {
  return listApprovals(rpc, ISSUER_OFFSET, issuerPda);
}

/** Every live approval of one share class. */
export function listShareClassSaleApprovals(rpc: Rpc, shareClass: Address) {
  return listApprovals(rpc, SHARE_CLASS_OFFSET, shareClass);
}

export function isApprovalLive(a: Pick<SaleApproval, "expiresAt">, nowSecs = Math.floor(Date.now() / 1000)) {
  return a.expiresAt >= BigInt(nowSecs);
}

/** Largest `total_for_sale` the approval allows at `price` (0 when price is 0). */
export function maxUnitsAt(a: Pick<SaleApproval, "maxGrossRaise">, price: bigint): bigint {
  return price > BigInt(0) ? a.maxGrossRaise / price : BigInt(0);
}

/** Whole-token decimal text -> base units (exact; no floating point). */
export function toBaseUnits(text: string, decimals: number): bigint | null {
  const t = text.trim();
  const m = /^(\d{1,20})(?:\.(\d+))?$/.exec(t);
  if (!m) return null;
  const frac = m[2] ?? "";
  if (frac.length > decimals) return null;
  return BigInt(m[1]) * BigInt(10) ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
}

/** Base units -> whole-token decimal text. */
export function fromBaseUnits(value: bigint, decimals: number): string {
  if (decimals === 0) return value.toString();
  const s = value.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, -decimals);
  const frac = s.slice(-decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

// ── Ledger routes ──────────────────────────────────────────────────────────

export type Capacity = {
  cap: number; issued: number; reserved: number; used: number; remaining: number;
  window_start: string; cap_source: "spv" | "platform" | "client"; subject: string;
};

export type ReserveResult = {
  reservation_id: string; approval_pda: Address; sale_pda: Address; application_hash: string;
  amount_eur: number; subject: string; existing: boolean; capacity: Capacity; issuer: Address; asset: Address;
  payment_decimals: number;
};

export type ReserveInput = {
  application_id?: string | null;
  reason?: string;
  share_class: string;
  sale_id: string;
  payment_mint: string;
  max_gross_raise: string;
  min_price_per_unit: string;
  max_price_per_unit: string;
  raise_type: "mature" | "startup";
  expires_at: string;
  cliff_months: number;
  vesting_months: number;
};

export type ReservationRow = {
  id: string; kind: "sale" | "treasury_mint"; status: "reserved" | "consumed" | "booked" | "released";
  share_class_pda: string; sale_id: string | number | null; approval_pda: string | null; sale_pda: string | null;
  application_id: string | null; application_hash: string; payment_mint: string | null; payment_decimals: number | null;
  max_gross_raise: string | number | null; min_price_per_unit: string | number | null; max_price_per_unit: string | number | null;
  raise_type: "mature" | "startup" | null; expires_at: string | null; amount_eur: number; booked_amount_eur: number | null;
  chain_confirmed_at: string | null; release_reason: string | null; last_error: string | null; reserved_by: string;
  subject: string; created_at: string;
};

export type MyApproval = {
  approval_pda: string; share_class_pda: string; sale_id: string; application_id: string | null;
  application_hash: string; status: string; raise_type: "mature" | "startup" | null; expires_at: string | null;
  company_name: string | null; cliff_months: number | null; vesting_months: number | null;
};

export type FxRate = {
  network: string; payment_mint: string; kind: "eur_peg" | "rate"; eur_per_token: number | string; decimals: number;
  source: string; as_of: string; max_age: string; updated_by: string | null; updated_at: string;
};

type Session = WalletSession | null | undefined;

export const reserveSaleApproval = (session: Session, input: ReserveInput) =>
  signedFetch<ReserveResult>(session, "/api/sale-approvals/reserve", "saleApprovals.reserve", input);

export const confirmSaleApproval = (session: Session, reservationId: string, signature: string | null) =>
  signedFetch<{ reservation_id: string; status: string }>(session, "/api/sale-approvals/confirm", "saleApprovals.confirm", {
    reservation_id: reservationId, ...(signature ? { signature } : {}),
  });

export const releaseSaleApproval = (
  session: Session, reservationId: string, reason: "tx_failed" | "revoked" | "admin",
  proof: { last_valid_block_height?: string; signature?: string } = {},
) =>
  signedFetch<{ reservation_id: string; status: string }>(session, "/api/sale-approvals/release", "saleApprovals.release", {
    reservation_id: reservationId, reason, ...proof,
  });

/**
 * After a failed send: the transaction may still land until its blockhash
 * expires, so the server releases the reservation only once the finalized
 * chain is past `lastValidBlockHeight` (retried here for up to ~3 minutes).
 * Best effort; the retry worker releases it otherwise.
 */
export async function releaseWhenExpired(session: Session, reservationId: string, lastValidBlockHeight: bigint) {
  const until = Date.now() + 180_000;
  while (Date.now() < until) {
    try {
      return await releaseSaleApproval(session, reservationId, "tx_failed", { last_valid_block_height: lastValidBlockHeight.toString() });
    } catch (err) {
      if (!(err instanceof Error) || !/may still land/.test(err.message)) return null;
    }
    await new Promise((resolve) => setTimeout(resolve, 15_000));
  }
  return null;
}

export type SettleResult = { reservation_id: string; status: string; booked_amount_eur: number | null; book_error: string | null };

/** Best effort after close_sale / open_payout_vault; the retry worker is the backstop. */
export const settleSaleCapacity = (session: Session, sale: string) =>
  signedFetch<SettleResult>(session, "/api/sale-approvals/settle", "saleApprovals.settle", { sale });

/**
 * The server books a sale from its FINALIZED state, so wait for the close
 * transaction to finalize (up to 90 s) before settling. Null when it did not
 * finalize in time or failed: the retry worker books it later.
 */
export async function settleWhenFinalized(rpc: Rpc, session: Session, sale: string, signature: string): Promise<SettleResult | null> {
  const until = Date.now() + 90_000;
  while (Date.now() < until) {
    const status = (
      await rpc.getSignatureStatuses([toSignature(signature)], { searchTransactionHistory: true })
        .send({ abortSignal: AbortSignal.timeout(10_000) })
    ).value[0];
    if (status?.err) return null;
    if (status?.confirmationStatus === "finalized") return settleSaleCapacity(session, sale);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  return null;
}

export const listSaleReservations = (
  session: Session, filter: { application_id: string } | { share_class: string } | { manual: true }, live = false,
) =>
  signedFetch<ReservationRow[]>(session, "/api/sale-approvals/list", "saleApprovals.list", { ...filter, ...(live ? { live } : {}) });

export const saleCapacityFor = (session: Session, shareClass: string) =>
  signedFetch<{
    subject: string; spv_id: string | null; issuer: string; asset: string; issuer_authority: string;
    issuer_verified: boolean; capacity: Capacity; max_reserved_sale_id: string | null;
  }>(session, "/api/sale-approvals/capacity", "saleApprovals.capacity", { share_class: shareClass });

export const mySaleApprovals = (session: Session, issuer: string) =>
  signedFetch<MyApproval[]>(session, "/api/sale-approvals/mine", "saleApprovals.mine", { issuer });

export const reserveTreasuryMint = (
  session: Session,
  input: { share_class: string; amount_units: string; amount_eur: number; reason: string },
) => signedFetch<{ reservation_id: string; amount_eur: number; subject: string; capacity: Capacity }>(
  session, "/api/sale-approvals/treasury-mint", "saleApprovals.treasuryMint", input);

export const bookTreasuryMint = (session: Session, reservationId: string, signature: string) =>
  signedFetch<{ reservation_id: string; status: string; booked_amount_eur: number }>(
    session, "/api/sale-approvals/treasury-mint", "saleApprovals.treasuryMintBook", { reservation_id: reservationId, signature });

/** Books a treasury mint once its transaction finalized (up to 90 s); null when it did not. */
export async function bookTreasuryMintWhenFinalized(rpc: Rpc, session: Session, reservationId: string, signature: string) {
  const until = Date.now() + 90_000;
  while (Date.now() < until) {
    const status = (
      await rpc.getSignatureStatuses([toSignature(signature)], { searchTransactionHistory: true })
        .send({ abortSignal: AbortSignal.timeout(10_000) })
    ).value[0];
    if (status?.err) return null;
    if (status?.confirmationStatus === "finalized") return bookTreasuryMint(session, reservationId, signature);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  return null;
}

export const readFxRates = (session: Session) =>
  signedFetch<FxRate[]>(session, "/api/admin-config/fx-rates", "adminConfig.fxRatesRead", {});

export const writeFxRate = (
  session: Session,
  input: { op: "upsert"; payment_mint: string; kind: "eur_peg" | "rate"; eur_per_token?: string; source: string; max_age_days?: number }
    | { op: "delete"; payment_mint: string },
) => signedFetch<FxRate[]>(session, "/api/admin-config/fx-rates", "adminConfig.fxRatesWrite", input);

/** EUR value (rounded up to cents) of `baseUnits` at a rate — display only; the server computes the counted value. */
export function eurValue(baseUnits: bigint, rate: FxRate | null): number | null {
  if (!rate) return null;
  const perToken = Number(rate.eur_per_token);
  const tokens = Number(fromBaseUnits(baseUnits, rate.decimals));
  return Math.ceil(tokens * perToken * 100) / 100;
}
