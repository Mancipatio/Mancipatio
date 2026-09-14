"use client";

// Fee schedule + per-client waivers — ALL access goes through signed server
// routes (SIWS + on-chain admin gate):
//   fees.list          — admin read of fee_config + fee_waivers (waivers carry
//                        client ids, discount reasons and granting-admin
//                        wallets — business-confidential, so reads are gated
//                        too)
//   fees.configUpsert  — add/edit a fee_config row
//   fees.configDelete  — remove a fee_config row
//   fees.waiverUpsert  — add/edit a fee_waivers row (granted_by is stamped
//                        with the VERIFIED signer server-side)
//   fees.waiverDelete  — remove a fee_waivers row

import type { WalletSession } from "@solana/client";
import { signedFetch } from "@/lib/siws-client";

export type FeeType =
  | "issuance"
  | "sale"
  | "otc"
  | "conversion"
  | "withdrawal"
  | "mint"
  | "governance";

export type FeeConfig = {
  id: string;
  created_at: string;
  updated_at: string;
  network: string;
  fee_type: FeeType;
  rate_bps: number;
  recipient: string;
  share_bps: number;
  label: string;
  enabled: boolean;
};

export type FeeWaiver = {
  id: string;
  created_at: string;
  updated_at: string;
  network: string;
  client_id: string;
  fee_type: FeeType;
  override_bps: number;
  expires_at: string | null;
  reason: string;
  granted_by: string;
};

export const FEE_TYPES: FeeType[] = [
  "issuance",
  "sale",
  "otc",
  "conversion",
  "withdrawal",
  "mint",
  "governance",
];

export const FEE_TYPE_LABEL: Record<FeeType, string> = {
  issuance: "Issuance",
  sale: "Primary sale",
  otc: "OTC trade",
  conversion: "Conversion",
  withdrawal: "Withdrawal",
  mint: "Mint",
  governance: "Governance",
};

/**
 * Admin-only combined read (signed — ONE wallet signature loads both tables).
 * THROWS on failure (rejected signature, 401/403, transport) rather than
 * returning empties, so callers can distinguish "no fees" from "load failed".
 */
export async function listFees(
  session: WalletSession | null | undefined,
): Promise<{ config: FeeConfig[]; waivers: FeeWaiver[] }> {
  const data = await signedFetch<{
    config: FeeConfig[];
    waivers: FeeWaiver[];
  }>(session, "/api/fees/list", "fees.list", {});
  return { config: data.config ?? [], waivers: data.waivers ?? [] };
}

export async function upsertFeeConfig(
  session: WalletSession | null | undefined,
  row: Omit<FeeConfig, "id" | "created_at" | "updated_at" | "network">,
): Promise<void> {
  await signedFetch(session, "/api/fees/config-upsert", "fees.configUpsert", {
    fee_type: row.fee_type,
    rate_bps: row.rate_bps,
    recipient: row.recipient,
    share_bps: row.share_bps,
    label: row.label,
    enabled: row.enabled,
  });
}

export async function deleteFeeConfig(
  session: WalletSession | null | undefined,
  id: string,
): Promise<void> {
  await signedFetch(session, "/api/fees/config-delete", "fees.configDelete", {
    id,
  });
}

// granted_by is no longer part of the input — the server stamps it with the
// verified signing wallet.
export async function upsertFeeWaiver(
  session: WalletSession | null | undefined,
  row: Omit<
    FeeWaiver,
    "id" | "created_at" | "updated_at" | "network" | "granted_by"
  >,
): Promise<void> {
  await signedFetch(session, "/api/fees/waiver-upsert", "fees.waiverUpsert", {
    client_id: row.client_id,
    fee_type: row.fee_type,
    override_bps: row.override_bps,
    expires_at: row.expires_at,
    reason: row.reason,
  });
}

export async function deleteFeeWaiver(
  session: WalletSession | null | undefined,
  id: string,
): Promise<void> {
  await signedFetch(session, "/api/fees/waiver-delete", "fees.waiverDelete", {
    id,
  });
}

export function bpsToPercent(bps: number): string {
  return (bps / 100).toFixed(2) + "%";
}
