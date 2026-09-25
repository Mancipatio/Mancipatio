"use client";

// Conversion requests — the convertible-share-class mirror of
// lib/delivery.ts. A holder of a share class with an on-chain conversion
// target (`convertible_to`) asks to convert tokens into the off-chain right;
// admin opens a conversion escrow (a DeliveryEscrow-TYPE custody vault — the
// only vault type whose on-chain exits are return-to-holder /
// burn-on-confirm; revert, which burns, is banned for it), the holder
// deposits, and the vault is realized (burn) once the off-chain conversion
// is executed — or returned if it falls through.
//
// UNLIKE delivery_requests, conversion_requests has NO anon RLS policies at
// all (rows carry holder contact details — PII), so READS are signed too:
//   conversion.create      — holder creates (server re-checks the KYC gate)
//   conversion.cancel      — holder cancels while still 'requested'
//   conversion.deposited   — holder records the on-chain escrow deposit
//   conversion.listMine    — holder reads their own rows
//   conversion.adminList   — admin reads the full queue (admin gate on-chain)
//   conversion.adminUpdate — admin lifecycle writes (admin gate on-chain)
// Status transitions are additionally pinned by a DB trigger (migration 0034).

import type { WalletSession } from "@solana/client";
import { signedFetch } from "@/lib/siws-client";
import { notifyAdminBadges } from "@/lib/admin-badges-events";

// NOTE: 'approved' exists in the DB CHECK for parity with delivery (0020) but
// is never produced — the flow goes requested → vault_opened directly
// (approval == opening the vault).
export type ConversionStatus =
  | "requested"
  | "vault_opened"
  | "deposited"
  | "converted"
  | "cancelled"
  | "returned";

export type ConversionRequest = {
  id: string;
  created_at: string;
  updated_at: string;
  network: string;
  holder_wallet: string;
  client_id: string | null;
  share_class_pda: string;
  mint: string;
  asset_pda: string | null;
  asset_label: string;
  amount: number;
  contact: string;
  note: string;
  status: ConversionStatus;
  vault_pda: string | null;
  vault_id: number | null;
  admin_note: string | null;
  decided_by: string | null;
  decided_at: string | null;
  deposit_tx: string | null;
  outcome_tx: string | null;
};

// holder_wallet / client_id are derived server-side from the verified
// signature (wallet → clients row) — never part of the input.
export type ConversionRequestInput = {
  share_class_pda: string;
  mint: string;
  asset_pda?: string;
  asset_label?: string;
  amount: number;
  contact: string;
  note?: string;
};

/**
 * Create a conversion request for the connected wallet. Signed route; the
 * server enforces the KYC gate. THROWS with the server's message on failure
 * (e.g. "Conversion is available to onboarded, KYC-verified clients only").
 * Returns the new request id.
 */
export async function createConversionRequest(
  session: WalletSession | null | undefined,
  input: ConversionRequestInput,
): Promise<string> {
  const data = await signedFetch<{ id: string }>(
    session,
    "/api/conversion/create",
    "conversion.create",
    {
      share_class_pda: input.share_class_pda,
      mint: input.mint,
      asset_pda: input.asset_pda,
      asset_label: input.asset_label ?? "",
      amount: input.amount,
      contact: input.contact,
      note: input.note ?? "",
    },
  );
  return data.id;
}

/** Holder cancels their own request (only while status is 'requested'). */
export async function cancelConversionRequest(
  session: WalletSession | null | undefined,
  id: string,
): Promise<boolean> {
  try {
    await signedFetch(session, "/api/conversion/cancel", "conversion.cancel", {
      id,
    });
    return true;
  } catch (err) {
    console.warn("[conversion] cancel failed:", err);
    return false;
  }
}

/** Holder records the on-chain escrow deposit (vault_opened → deposited). */
export async function markConversionDeposited(
  session: WalletSession | null | undefined,
  id: string,
  depositTx: string | null,
): Promise<boolean> {
  try {
    await signedFetch(
      session,
      "/api/conversion/deposited",
      "conversion.deposited",
      { id, deposit_tx: depositTx },
    );
    return true;
  } catch (err) {
    console.warn("[conversion] mark deposited failed:", err);
    return false;
  }
}

/**
 * Holder reads their own requests. Signed — the table has no anon SELECT
 * (contact details are PII), so the server binds the query to the verified
 * signer. THROWS on failure (e.g. the user declined the signature) so the
 * caller can offer a retry.
 */
export async function listMyConversionRequests(
  session: WalletSession | null | undefined,
): Promise<{ requests: ConversionRequest[]; kycStatus: string | null }> {
  const data = await signedFetch<{
    requests: ConversionRequest[];
    kyc_status: string | null;
  }>(session, "/api/conversion/list-mine", "conversion.listMine");
  return { requests: data.requests ?? [], kycStatus: data.kyc_status ?? null };
}

/**
 * Admin reads the full queue (signed + on-chain admin gate), or only the
 * requests linked to `vaultPda` (unbounded by the 1000-row list cap). THROWS.
 */
export async function adminListConversionRequests(
  session: WalletSession | null | undefined,
  vaultPda?: string,
): Promise<ConversionRequest[]> {
  const data = await signedFetch<{ requests: ConversionRequest[] }>(
    session,
    "/api/conversion/admin-list",
    "conversion.adminList",
    vaultPda ? { vault_pda: vaultPda } : {},
  );
  return data.requests ?? [];
}

export type ConversionAdminPatch = {
  status?: Exclude<ConversionStatus, "requested">;
  vault_pda?: string;
  vault_id?: number;
  admin_note?: string | null;
  deposit_tx?: string | null;
  outcome_tx?: string | null;
  /** Stamp decided_by/decided_at with the signing admin + now (server-side). */
  decide?: boolean;
};

/** Admin lifecycle write (signed + on-chain admin gate on the server). */
export async function adminUpdateConversionRequest(
  session: WalletSession | null | undefined,
  id: string,
  patch: ConversionAdminPatch,
): Promise<boolean> {
  try {
    await signedFetch(
      session,
      "/api/conversion/admin-update",
      "conversion.adminUpdate",
      { id, ...patch },
    );
    notifyAdminBadges();
    return true;
  } catch (err) {
    console.warn("[conversion] admin update failed:", err);
    return false;
  }
}

/** Record the finalized permissionless return; this sends no chain transaction. */
export async function reclaimConversionRequest(
  session: WalletSession | null | undefined,
  id: string,
  outcomeTx: string,
): Promise<void> {
  await signedFetch(session, "/api/conversion/reclaim", "conversion.reclaim", {
    id,
    outcome_tx: outcomeTx,
  });
  notifyAdminBadges();
}
