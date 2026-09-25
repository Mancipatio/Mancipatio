"use client";

// Delivery requests — rows carry the holder's physical delivery address +
// contact (PII), so BOTH reads and writes go through signed server routes
// (SIWS); delivery_requests has NO anon SELECT (migration 0031). The server,
// not the browser, decides who may read/create/cancel/advance a request:
//   delivery.create      — holder creates (server re-checks the KYC gate)
//   delivery.cancel      — holder cancels while still 'requested'
//   delivery.deposited   — holder records the on-chain escrow deposit
//   delivery.reclaim     — holder records a post-deadline permissionless return
//   delivery.listMine    — holder reads their own rows (bound to the signer)
//   delivery.adminList   — admin reads the full queue (admin gate on-chain)
//   delivery.adminUpdate — admin lifecycle writes (admin gate on-chain)
// Status transitions are additionally pinned by a DB trigger (migration 0030).

import type { WalletSession } from "@solana/client";
import { signedFetch } from "@/lib/siws-client";
import { notifyAdminBadges } from "@/lib/admin-badges-events";

// NOTE: the legacy 'approved' status was dropped from the front — the flow
// goes requested → vault_opened directly (approval == opening the vault).
// The DB schema still allows it for old rows; none are produced anymore.
export type DeliveryStatus =
  | "requested"
  | "vault_opened"
  | "deposited"
  | "in_delivery"
  | "delivered"
  | "cancelled"
  | "returned";

export type DeliveryRequest = {
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
  delivery_details: string;
  contact: string;
  status: DeliveryStatus;
  vault_pda: string | null;
  vault_id: number | null;
  admin_note: string | null;
  decided_by: string | null;
  decided_at: string | null;
  deposit_tx: string | null;
  outcome_tx: string | null;
};

// holder_wallet / client_id are no longer part of the input — the server
// derives both from the verified signature (wallet → clients row).
export type DeliveryRequestInput = {
  share_class_pda: string;
  mint: string;
  asset_pda?: string;
  asset_label?: string;
  amount: number;
  delivery_details: string;
  contact: string;
};

/**
 * Create a delivery request for the connected wallet. Signed route; the
 * server enforces the KYC gate. THROWS with the server's message on failure
 * (e.g. "Delivery is available to onboarded, KYC-verified clients only").
 * Returns the new request id.
 */
export async function createDeliveryRequest(
  session: WalletSession | null | undefined,
  input: DeliveryRequestInput,
): Promise<string> {
  const data = await signedFetch<{ id: string }>(
    session,
    "/api/delivery/create",
    "delivery.create",
    {
      share_class_pda: input.share_class_pda,
      mint: input.mint,
      asset_pda: input.asset_pda,
      asset_label: input.asset_label ?? "",
      amount: input.amount,
      delivery_details: input.delivery_details,
      contact: input.contact,
    },
  );
  return data.id;
}

/** Holder cancels their own request (only while status is 'requested'). */
export async function cancelDeliveryRequest(
  session: WalletSession | null | undefined,
  id: string,
): Promise<boolean> {
  try {
    await signedFetch(session, "/api/delivery/cancel", "delivery.cancel", {
      id,
    });
    return true;
  } catch (err) {
    console.warn("[delivery] cancel failed:", err);
    return false;
  }
}

/** Holder records the on-chain escrow deposit (vault_opened → deposited). */
export async function markDeliveryDeposited(
  session: WalletSession | null | undefined,
  id: string,
  depositTx: string | null,
): Promise<boolean> {
  try {
    await signedFetch(
      session,
      "/api/delivery/deposited",
      "delivery.deposited",
      { id, deposit_tx: depositTx },
    );
    return true;
  } catch (err) {
    console.warn("[delivery] mark deposited failed:", err);
    return false;
  }
}

/**
 * Holder records a permissionless post-deadline escrow return
 * (deposited / in_delivery → returned). The holder sends
 * `return_custody_vault` on-chain first (permissionless after the deadline),
 * then calls this to flip the row. The server verifies the actual holder
 * transfer and cleared deposit ledger before writing. THROWS with the server message on failure.
 */
export async function reclaimDeliveryRequest(
  session: WalletSession | null | undefined,
  id: string,
  outcomeTx: string | null,
): Promise<void> {
  await signedFetch(session, "/api/delivery/reclaim", "delivery.reclaim", {
    id,
    outcome_tx: outcomeTx,
  });
  notifyAdminBadges();
}

export type DeliveryAdminPatch = {
  status?: Exclude<DeliveryStatus, "requested">;
  vault_pda?: string;
  vault_id?: number;
  admin_note?: string | null;
  deposit_tx?: string | null;
  outcome_tx?: string | null;
  /** Stamp decided_by/decided_at with the signing admin + now (server-side). */
  decide?: boolean;
};

/** Admin lifecycle write (signed + on-chain admin gate on the server). */
export async function adminUpdateDeliveryRequest(
  session: WalletSession | null | undefined,
  id: string,
  patch: DeliveryAdminPatch,
): Promise<boolean> {
  try {
    await signedFetch(
      session,
      "/api/delivery/admin-update",
      "delivery.adminUpdate",
      { id, ...patch },
    );
    notifyAdminBadges();
    return true;
  } catch (err) {
    console.warn("[delivery] admin update failed:", err);
    return false;
  }
}

/**
 * Admin reads the full queue (signed + on-chain admin gate), optionally by
 * `status` and/or only the requests linked to `vaultPda` (unbounded by the
 * 1000-row list cap). THROWS.
 */
export async function adminListDeliveryRequests(
  session: WalletSession | null | undefined,
  status?: DeliveryStatus,
  vaultPda?: string,
): Promise<DeliveryRequest[]> {
  const data = await signedFetch<{ requests: DeliveryRequest[] }>(
    session,
    "/api/delivery/admin-list",
    "delivery.adminList",
    {
      ...(status ? { status } : {}),
      ...(vaultPda ? { vault_pda: vaultPda } : {}),
    },
  );
  return data.requests ?? [];
}

/**
 * Holder reads their own requests + own KYC status (signed; bound to the
 * signer) in one round-trip. THROWS on transport/auth errors.
 */
export async function listMyDeliveryRequests(
  session: WalletSession | null | undefined,
): Promise<{ requests: DeliveryRequest[]; kycStatus: string | null }> {
  const data = await signedFetch<{
    requests: DeliveryRequest[];
    kyc_status: string | null;
  }>(session, "/api/delivery/list-mine", "delivery.listMine");
  return { requests: data.requests ?? [], kycStatus: data.kyc_status ?? null };
}
