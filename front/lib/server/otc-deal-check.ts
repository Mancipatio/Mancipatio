// SERVER-ONLY — the on-chain proof behind "this OTC request's escrow is open"
// (sim gap G2). /api/otc/admin-update flips a request to `created` and emails
// both parties "Open your deals" with the deal address; that address must be
// a real OtcDeal of this program, at finalized, still Open, and exactly the
// request's deal: its share class, mint, parties, amount, price and payment
// mint. Anything else is refused, so neither a mistake nor a compromised
// admin session can point the parties at another account.
import "server-only";
import { address, fetchEncodedAccount } from "@solana/kit";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  findDealPda,
  getOtcDealDecoder,
  getOtcDealDiscriminatorBytes,
  OtcDealStatus,
  type OtcDeal,
} from "@/lib/generated/asset_registry";
import { getServerRpc } from "@/lib/server/rpc";
import { SiwsError } from "@/lib/server/siws";

/** The otc_requests columns the deal must match. */
export type OtcRequestTerms = {
  share_class_pda: string;
  mint: string;
  seller_wallet: string;
  buyer_wallet: string;
  amount: number | string;
  price: number | string;
  payment_mint: string;
};

/** The first term of `row` the decoded deal does not carry, or null. */
export function otcDealMismatch(deal: OtcDeal, row: OtcRequestTerms): string | null {
  const same = (a: unknown, b: unknown) => String(a) === String(b);
  const units = (value: number | string) => {
    try {
      return BigInt(String(value));
    } catch {
      return null;
    }
  };
  if (!same(deal.shareClass, row.share_class_pda)) return "share class";
  if (!same(deal.mint, row.mint)) return "mint";
  if (!same(deal.seller, row.seller_wallet)) return "seller";
  if (!same(deal.buyer, row.buyer_wallet)) return "buyer";
  if (deal.amount !== units(row.amount)) return "amount";
  if (deal.price !== units(row.price)) return "price";
  if (!same(deal.paymentMint, row.payment_mint)) return "payment mint";
  return null;
}

/**
 * Reads `dealPda` at finalized and returns the decoded deal when it is an
 * Open OtcDeal of this program whose terms are `row`'s. Throws SiwsError:
 * 503 when the chain cannot be read, 409 when the deal is not (yet) visible
 * at finalized or not Open, 400 when it is not this request's deal.
 */
export async function readOpenDealForRequest(dealPda: string, row: OtcRequestTerms): Promise<OtcDeal> {
  let account;
  try {
    account = await fetchEncodedAccount(getServerRpc(), address(dealPda), {
      commitment: "finalized",
      abortSignal: AbortSignal.timeout(12_000),
    });
  } catch {
    throw new SiwsError(503, "Deal lookup unavailable — nothing was changed; try again");
  }
  if (!account.exists) {
    throw new SiwsError(
      409,
      "The deal is not visible on-chain at finalized commitment yet — retry in a few seconds; nothing was changed.",
    );
  }
  if (account.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS) {
    throw new SiwsError(400, "deal_pda is not an account of the Manci program");
  }
  const bytes = account.data;
  const discriminator = getOtcDealDiscriminatorBytes();
  if (bytes.length < discriminator.length || !discriminator.every((byte, index) => bytes[index] === byte)) {
    throw new SiwsError(400, "deal_pda is not an OTC deal");
  }
  let deal: OtcDeal;
  try {
    deal = getOtcDealDecoder().decode(bytes);
  } catch {
    throw new SiwsError(400, "deal_pda is not an OTC deal");
  }
  const [expected] = await findDealPda({ shareClass: deal.shareClass, dealId: deal.dealId });
  if (expected !== dealPda) throw new SiwsError(400, "OTC deal identity mismatch");
  if (deal.status !== OtcDealStatus.Open) {
    throw new SiwsError(409, "The on-chain deal is no longer open — nothing was changed");
  }
  const mismatch = otcDealMismatch(deal, row);
  if (mismatch) {
    throw new SiwsError(400, `The on-chain deal does not match this request (${mismatch}) — nothing was changed`);
  }
  return deal;
}
