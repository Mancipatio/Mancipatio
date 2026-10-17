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
//   conversion.listMine    — holder reads their own rows (+ own KYC verdict)
//   conversion.adminList   — admin reads the full queue (admin gate on-chain)
//   conversion.adminUpdate — admin lifecycle writes (admin gate on-chain)
// Status transitions are additionally pinned by a DB trigger (migration 0034).
//
// The two reads are session reads (lib/siws-session.ts): one sign-in, then no
// prompt. A background refresh passes `interactive: false` and gets
// WalletSessionRequiredError instead of a wallet prompt when the session has
// lapsed. The holder's writes (cancel, deposited) THROW with the server's
// message, as create and reclaim do: a 409 "request changed", a 403 gate
// refusal or a 503 "not finalized" reads as what it is, never as a generic
// "could not update".

import type { WalletSession } from "@solana/client";
import { signedFetch, type SignedFetchInteractive } from "@/lib/siws-client";
import { notifyAdminBadges } from "@/lib/admin-badges-events";
import type { ConversionKycVerdict } from "@/lib/conversion-holder";

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

/** The row the create route answers with, when it has the shape the page renders. */
function createdRow(value: unknown): ConversionRequest | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Partial<ConversionRequest>;
  return typeof row.id === "string" &&
    typeof row.status === "string" &&
    typeof row.created_at === "string" &&
    typeof row.holder_wallet === "string" &&
    typeof row.network === "string"
    ? (row as ConversionRequest)
    : null;
}

/**
 * Create a conversion request for the connected wallet. Signed route; the
 * server enforces the KYC gate, the on-chain balance and the sum of the
 * wallet's open requests of the class (409). THROWS with the server's
 * message on failure (e.g. "Onboarding required …"). Returns the new request
 * id and, when the server answers with it, the created row — so the page can
 * show it before its reload lands.
 */
export async function createConversionRequest(
  session: WalletSession | null | undefined,
  input: ConversionRequestInput,
): Promise<{ id: string; request: ConversionRequest | null }> {
  const data = await signedFetch<{ id: string; request?: unknown }>(
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
  return { id: data.id, request: createdRow(data.request) };
}

/**
 * Holder cancels their own request (only while status is 'requested').
 * THROWS with the server's message (e.g. a 409 when the vault was opened
 * meanwhile) so the page can say what happened and re-list.
 */
export async function cancelConversionRequest(
  session: WalletSession | null | undefined,
  id: string,
): Promise<void> {
  await signedFetch(session, "/api/conversion/cancel", "conversion.cancel", {
    id,
  });
}

/**
 * Holder records the on-chain escrow deposit (vault_opened → deposited).
 * THROWS with the server's message: "not finalized" is retryable with the
 * saved receipt, an opened-vault or ownership refusal is not.
 */
export async function markConversionDeposited(
  session: WalletSession | null | undefined,
  id: string,
  depositTx: string | null,
): Promise<void> {
  await signedFetch(
    session,
    "/api/conversion/deposited",
    "conversion.deposited",
    { id, deposit_tx: depositTx },
  );
}

export type ConversionListMine = {
  requests: ConversionRequest[];
  /**
   * The create gate's verdict for the signer (null: the server could not
   * check it; the requests still loaded).
   */
  kyc: ConversionKycVerdict | null;
  /** Older field: the gate's effective status ("verified" only when eligible). */
  kycStatus: string | null;
};

function kycVerdict(value: unknown): ConversionKycVerdict | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<ConversionKycVerdict>;
  if (typeof v.eligible !== "boolean") return null;
  return {
    eligible: v.eligible,
    status: typeof v.status === "string" ? v.status : null,
    expired: v.expired === true,
    message: typeof v.message === "string" ? v.message : null,
  };
}

/**
 * Holder reads their own requests and their own KYC verdict. Signed — the
 * table has no anon SELECT (contact details are PII), so the server binds the
 * query to the verified signer. A session read: `opts.interactive` says how
 * far it may go for a session (lib/siws-client.ts; `false` for a timer, which
 * must never raise a wallet prompt). THROWS on failure — a
 * WalletSessionRequiredError when no session could be used — so the caller
 * can offer "Sign in" or "Retry".
 */
export async function listMyConversionRequests(
  session: WalletSession | null | undefined,
  opts: { interactive?: SignedFetchInteractive } = {},
): Promise<ConversionListMine> {
  const data = await signedFetch<{
    requests: ConversionRequest[];
    kyc?: unknown;
    kyc_status: string | null;
  }>(session, "/api/conversion/list-mine", "conversion.listMine", {}, { interactive: opts.interactive ?? true });
  return { requests: data.requests ?? [], kyc: kycVerdict(data.kyc), kycStatus: data.kyc_status ?? null };
}

/**
 * Admin reads the full queue (signed + on-chain admin gate), or only the
 * requests linked to `vaultPda` (unbounded by the 1000-row list cap). THROWS.
 * `opts.interactive` as in listMyConversionRequests.
 */
export async function adminListConversionRequests(
  session: WalletSession | null | undefined,
  vaultPda?: string,
  opts: { interactive?: SignedFetchInteractive } = {},
): Promise<ConversionRequest[]> {
  const data = await signedFetch<{ requests: ConversionRequest[] }>(
    session,
    "/api/conversion/admin-list",
    "conversion.adminList",
    vaultPda ? { vault_pda: vaultPda } : {},
    { interactive: opts.interactive ?? true },
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

/**
 * Admin lifecycle write (signed + on-chain admin gate on the server). Still
 * answers false on failure (app/admin/custody/page.tsx tests the boolean);
 * the server's message is only logged until that page handles a throw.
 */
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
