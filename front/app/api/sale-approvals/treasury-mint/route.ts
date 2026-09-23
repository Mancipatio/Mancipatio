// POST /api/sale-approvals/treasury-mint — counts an Admin-issuer treasury
// mint against the raise cap (signed; requireAdmin).
//
// Since program package 2B only an Admin issuer key may mint_to_treasury into
// the issuer's own account (6128 otherwise), so these are platform SPV
// issuances. Before sending the mint, /admin/share-classes reserves its
// declared EUR value ("saleApprovals.treasuryMint": share_class, amount_units,
// amount_eur, reason). After the transaction finalizes it books it
// ("saleApprovals.treasuryMintBook": reservation_id, signature): the server
// requires exactly one top-level mint_to_treasury of that share class and
// amount, signed by the reserving admin, into an account the admin owns.
// A failed mint is released through /api/sale-approvals/release. The declared
// EUR value has a floor (0066: at least EUR 1 and the units at the share
// class's latest price). The retry worker books a mint the browser never
// booked, expires one that never landed, and rechecks released ones.

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";
import {
  addressParam,
  bookTreasuryMintRow,
  capacityError,
  dbU64,
  finalizedTreasuryTx,
  loadReservation,
  snapshotHash,
  treasuryMintEvidence,
  u64Param,
} from "@/lib/server/sale-capacity";
import { subjectSpvId, shareClassChain } from "../_lib";

const SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{64,96}$/;

export async function POST(request: Request) {
  try {
    const body = (await request.clone().json().catch(() => null)) as { payload?: { action?: unknown } } | null;
    const isBook = body?.payload?.action === "saleApprovals.treasuryMintBook";
    const { wallet, params } = await verifySigned(request, isBook ? "saleApprovals.treasuryMintBook" : "saleApprovals.treasuryMint");
    await requireAdmin(wallet);
    const sb = getSupabaseAdmin();
    const network = detectNetwork();

    if (isBook) {
      const signature = typeof params.signature === "string" && SIG_RE.test(params.signature) ? params.signature : null;
      if (!signature) throw new SiwsError(400, "A valid transaction signature is required");
      const reservation = await loadReservation(sb, String(params.reservation_id ?? ""));
      if (reservation.kind !== "treasury_mint") throw new SiwsError(400, "Not a treasury-mint reservation");
      if (reservation.reserved_by !== wallet) throw new SiwsError(403, "Only the admin who reserved this mint may book it");
      const tx = await finalizedTreasuryTx(signature);
      treasuryMintEvidence(tx, signature, {
        shareClass: reservation.share_class_pda, authority: reservation.reserved_by, amount: dbU64(reservation.amount_units),
      });
      const booked = await bookTreasuryMintRow(sb, reservation.id, signature);
      // The 0027 calendar-year trigger refused the SPV row: still counted (reserved).
      if (booked.book_error) throw new SiwsError(409, `Booking refused: ${booked.book_error}`);
      return NextResponse.json({ ok: true, data: { reservation_id: booked.id, status: booked.status, booked_amount_eur: booked.booked_amount_eur } });
    }

    const shareClass = addressParam(params.share_class, "share_class");
    const amountUnits = u64Param(params.amount_units, "amount_units", { positive: true });
    const amountEur = typeof params.amount_eur === "number" ? params.amount_eur : NaN;
    if (!Number.isFinite(amountEur) || amountEur <= 0 || amountEur > 1e12) throw new SiwsError(400, "amount_eur must be a positive number");
    const reason = typeof params.reason === "string" ? params.reason.trim() : "";
    if (reason.length < 5 || reason.length > 1000) throw new SiwsError(400, "A reason (5-1000 characters) is required");
    const chain = await shareClassChain(shareClass);
    if (chain.authority !== wallet) {
      throw new SiwsError(409, "Only the issuer's own (Admin) key can mint into its treasury");
    }
    const spvId = await subjectSpvId(sb, chain.asset, chain.issuer);
    const snapshot = {
      v: 1, kind: "treasury_mint", network, share_class: shareClass, asset: chain.asset, issuer: chain.issuer,
      amount_units: amountUnits.toString(), amount_eur: amountEur.toFixed(2), reason, reserved_by: wallet,
    };
    const { data, error } = await sb.rpc("reserve_treasury_mint_capacity", {
      p_network: network, p_share_class_pda: shareClass, p_asset_pda: chain.asset, p_issuer_pda: chain.issuer,
      p_spv_id: spvId, p_amount_units: amountUnits.toString(), p_amount_eur: amountEur, p_reason: reason,
      p_snapshot: snapshot, p_hash: snapshotHash(snapshot).hex, p_reserved_by: wallet,
    });
    if (error) throw capacityError(error);
    const reserved = data as { id: string; amount_eur: number; subject: string; capacity: unknown };
    return NextResponse.json({ ok: true, data: { reservation_id: reserved.id, amount_eur: reserved.amount_eur, subject: reserved.subject, capacity: reserved.capacity } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
