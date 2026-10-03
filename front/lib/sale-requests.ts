// Public-sale requests (Distribute → Public sale) — browser wrappers of
// /api/sale-requests/* (lib/server/sale-requests holds the rules).
import type { WalletSession } from "@solana/client";
import { signedFetch, type SignedFetchInteractive } from "@/lib/siws-client";
import type { OfferingClearance } from "@/lib/whitepaper-approval";
import type { SaleDurationDays, SaleRequest } from "@/lib/public-sale";

type Session = WalletSession | null | undefined;

export type SaleRequestRow = {
  asset: string;
  display_name: string | null;
  request: SaleRequest | null;
  /** From the raise-cap ledger: the operator approved it, its sale opened, or closed (null: none yet). */
  outcome: "approved" | "opened" | "closed" | null;
  /** Pending list only: the offering clearance (mainnet; test networks are always cleared). */
  clearance?: OfferingClearance;
};

/** Request a public sale; publishes the buyer document in the same signed call. */
export const submitSaleRequest = (
  session: Session,
  input: {
    share_class: string;
    price_per_unit: string;
    tokens: string;
    duration_days: SaleDurationDays;
    document: { path: string; sha256: string };
  },
) => signedFetch<{ request: SaleRequest; asset: string }>(session, "/api/sale-requests/submit", "saleRequests.submit", input);

/** One class's request (its issuer or an Admin), or every request waiting for the operator (Admin). */
export const listSaleRequests = (
  session: Session,
  filter: { share_class: string } | { pending: true },
  opts: { interactive?: SignedFetchInteractive } = {},
) => signedFetch<SaleRequestRow[]>(session, "/api/sale-requests/list", "saleRequests.list", filter, opts);

/** Withdraw (issuer), decline (Admin, with a reason) or mark opened (issuer, with the Sale address). */
export const decideSaleRequest = (
  session: Session,
  input: { share_class: string; request_id: string } & (
    | { action: "withdraw" }
    | { action: "decline"; reason: string }
    | { action: "opened"; sale: string }
  ),
) => signedFetch<{ request: SaleRequest }>(session, "/api/sale-requests/decide", "saleRequests.decide", input);
