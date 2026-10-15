// Shared by the two "Send to wallets" compliance routes: screen-recipients
// (screens and records) and distribution-evidence (checks the records and
// writes the run's evidence). Same parameters, same caller rule.

import { isAddress, type Address } from "@solana/kit";
import { SiwsError } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { scopeEnabled } from "@/lib/features";
import { requireArea } from "@/lib/server/feature-gate";
import { isAdminWallet, shareClassChain } from "@/app/api/sale-approvals/_lib";

/** Most recipients one request may carry (the client wrappers chunk). */
export const MAX_RECIPIENTS_PER_REQUEST = 100;

/** 1–100 distinct addresses, or 400. */
export function recipientWallets(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_RECIPIENTS_PER_REQUEST) {
    throw new SiwsError(400, `wallets must be an array of 1–${MAX_RECIPIENTS_PER_REQUEST} addresses`);
  }
  return [
    ...new Set(
      raw.map((w) => {
        if (typeof w !== "string" || !isAddress(w)) throw new SiwsError(400, "wallets must contain valid addresses only");
        return w;
      }),
    ),
  ];
}

/** A distribution run id (lib/distribution-journal distributionRunId: SHA-256 hex), or 400. */
export function runIdParam(raw: unknown, required: boolean): string | null {
  if ((raw === undefined || raw === null) && !required) return null;
  if (typeof raw !== "string" || !/^[0-9a-f]{64}$/.test(raw)) throw new SiwsError(400, "run_id must be a distribution run id");
  return raw;
}

/**
 * Who may ask: the class's issuer authority (the treasury that sends) or an
 * Admin (403 otherwise). KYC-only mode (lib/features.ts): a non-admin
 * issuer's "Send to wallets" is an issuance entry (403); an Admin issuer key
 * (the operator) keeps it, as the admin console stays whole. This is the
 * server check of "Send to wallets" only: an Admin's direct transfer from
 * the console (Admin -> Share classes, "Send to holder") calls no route.
 */
export async function requireClassSender(shareClass: Address, wallet: string): Promise<void> {
  const chain = await shareClassChain(shareClass);
  if (chain.authority !== wallet) {
    await requireAdmin(wallet);
    return;
  }
  if (!scopeEnabled("issuance") && !(await isAdminWallet(wallet))) requireArea("issuance");
}
