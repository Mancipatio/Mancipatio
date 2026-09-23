// POST /api/sale-approvals/reserve — step 1 of an Admin sale approval
// ("saleApprovals.reserve", signed; requireAdmin).
//
// Validates the approval terms against the chain and the reviewed
// application, then reserves their EUR value against the subject's rolling
// 12-month cap (0066 reserve_sale_capacity, under a per-subject lock). The
// admin's wallet then sends approve_sale with the returned application hash
// and calls /confirm; if the transaction fails, /release with tx_failed.
//
// Params: application_id (uuid) OR reason (super admin, manual approval);
// share_class, sale_id, payment_mint, max_gross_raise, min_price_per_unit,
// max_price_per_unit (u64 decimal strings, payment-mint base units),
// raise_type ("mature" | "startup"), expires_at (unix seconds, <= 90 days),
// cliff_months / vesting_months (0/0 for mature; startup: the application's).

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdmin, requireSuperAdmin } from "@/lib/server/admin-gate";
import { requireFeature } from "@/lib/server/feature-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";
import {
  SALE_APPROVAL_MAX_TTL_SECS,
  UUID_RE,
  addressParam,
  applicationSnapshot,
  capacityError,
  manualSnapshot,
  snapshotHash,
  u64Param,
  type ApplicationForSnapshot,
  type RaiseTypeName,
  type SaleApprovalTerms,
} from "@/lib/server/sale-capacity";
import {
  accountExists,
  applicantWallets,
  subjectSpvId,
  paymentMintDecimals,
  saleAndApprovalPdas,
  shareClassChain,
} from "../_lib";

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "saleApprovals.reserve");
    await requireAdmin(wallet);
    const network = detectNetwork();
    const sb = getSupabaseAdmin();

    const applicationId = typeof params.application_id === "string" && params.application_id ? params.application_id : null;
    const reason = typeof params.reason === "string" ? params.reason.trim() : "";
    if (applicationId !== null && !UUID_RE.test(applicationId)) throw new SiwsError(400, "application_id must be a UUID");
    if (applicationId === null) {
      // An approval without a reviewed application is a super-admin decision.
      await requireSuperAdmin(wallet);
      if (reason.length < 5 || reason.length > 1000) throw new SiwsError(400, "A reason (5-1000 characters) is required without an application");
    }
    const raiseType = params.raise_type;
    if (raiseType !== "mature" && raiseType !== "startup") throw new SiwsError(400, "raise_type must be mature or startup");
    if (raiseType === "startup") requireFeature("startupRaises");
    const shareClass = addressParam(params.share_class, "share_class");
    const paymentMint = addressParam(params.payment_mint, "payment_mint");
    const saleId = u64Param(params.sale_id, "sale_id");
    const maxGross = u64Param(params.max_gross_raise, "max_gross_raise", { positive: true });
    const minPrice = u64Param(params.min_price_per_unit, "min_price_per_unit", { positive: true });
    const maxPrice = u64Param(params.max_price_per_unit, "max_price_per_unit", { positive: true });
    const expiresAt = u64Param(params.expires_at, "expires_at", { positive: true });
    if (minPrice > maxPrice) throw new SiwsError(400, "min_price_per_unit must not exceed max_price_per_unit");
    const months = (v: unknown, field: string) => {
      const n = typeof v === "number" ? v : typeof v === "string" && /^\d{1,3}$/.test(v) ? Number(v) : NaN;
      if (!Number.isInteger(n) || n < 0 || n > 255) throw new SiwsError(400, `${field} must be 0-255`);
      return n;
    };
    const cliffMonths = months(params.cliff_months ?? 0, "cliff_months");
    const vestingMonths = months(params.vesting_months ?? 0, "vesting_months");
    if (raiseType === "mature" ? cliffMonths !== 0 || vestingMonths !== 0 : vestingMonths <= cliffMonths) {
      throw new SiwsError(400, "A mature sale has no payout schedule (0/0); a startup sale needs vesting months above the cliff");
    }
    const nowSecs = BigInt(Math.floor(Date.now() / 1000));
    // A little slack below the on-chain 90 days: the chain clock can lag.
    if (expiresAt <= nowSecs + BigInt(60) || expiresAt > nowSecs + BigInt(SALE_APPROVAL_MAX_TTL_SECS - 600)) {
      throw new SiwsError(400, "expires_at must be in the future and less than 90 days away");
    }

    let application: (ApplicationForSnapshot & { status: string }) | null = null;
    if (applicationId) {
      const { data, error } = await sb.from("launch_applications")
        .select("id,network,status,applicant_wallet,revision_count,reviewed_at,company_name,raise_type,raise_amount,equity_offered,cliff_months,vesting_months")
        .eq("id", applicationId).eq("network", network).maybeSingle();
      if (error) throw new SiwsError(503, "Could not load the application");
      if (!data) throw new SiwsError(404, "Application not found on this network");
      application = data as ApplicationForSnapshot & { status: string };
      if (application.status !== "approved") throw new SiwsError(409, "The application is not approved");
      if (application.raise_type !== raiseType) throw new SiwsError(409, "The raise type must match the application");
      if (raiseType === "startup" && (application.cliff_months !== cliffMonths || application.vesting_months !== vestingMonths)) {
        throw new SiwsError(409, "The cliff and vesting months must match the application");
      }
    }

    // On-chain: the share class chain, a verified issuer owned by the applicant,
    // and a sale id that has never been used or approved.
    const chain = await shareClassChain(shareClass);
    if (!chain.issuerVerified) throw new SiwsError(409, "The issuer is not KYB-verified");
    if (application) {
      const wallets = await applicantWallets(sb, application.applicant_wallet);
      if (!wallets.includes(chain.authority)) {
        throw new SiwsError(409, "The share class's issuer authority is not a wallet of this applicant");
      }
    }
    if (network === "mainnet" && chain.authority === wallet) {
      throw new SiwsError(403, "On mainnet an issuer's own key cannot approve its sale; ask another admin");
    }
    const { sale, approval } = await saleAndApprovalPdas(shareClass, saleId);
    if (await accountExists(sale)) throw new SiwsError(409, "A sale with this id already exists for the share class");
    if (await accountExists(approval)) throw new SiwsError(409, "This sale id already has an on-chain approval");
    const decimals = await paymentMintDecimals(paymentMint);
    const spvId = await subjectSpvId(sb, chain.asset, chain.issuer);

    const terms: SaleApprovalTerms = {
      shareClass, saleId, issuer: chain.issuer, paymentMint, maxGrossRaise: maxGross,
      minPricePerUnit: minPrice, maxPricePerUnit: maxPrice, raiseType: raiseType as RaiseTypeName, expiresAt,
      cliffMonths, vestingMonths,
    };
    const snapshot = application ? applicationSnapshot(application, terms) : manualSnapshot(network, reason, terms);
    const hash = snapshotHash(snapshot);

    const { data, error } = await sb.rpc("reserve_sale_capacity", {
      p_network: network, p_share_class_pda: shareClass, p_sale_id: saleId.toString(), p_approval_pda: approval,
      p_sale_pda: sale, p_asset_pda: chain.asset, p_issuer_pda: chain.issuer, p_spv_id: spvId,
      p_application_id: applicationId, p_application_snapshot: snapshot, p_application_hash: hash.hex,
      p_payment_mint: paymentMint, p_payment_decimals: decimals, p_max_gross_raise: maxGross.toString(),
      p_min_price_per_unit: minPrice.toString(), p_max_price_per_unit: maxPrice.toString(), p_raise_type: raiseType,
      p_expires_at: new Date(Number(expiresAt) * 1000).toISOString(), p_reserved_by: wallet,
      p_cliff_months: cliffMonths, p_vesting_months: vestingMonths,
    });
    if (error) throw capacityError(error);
    const result = data as { id: string; amount_eur: number; subject: string; existing: boolean; capacity: unknown };
    return NextResponse.json({
      ok: true,
      data: {
        reservation_id: result.id, approval_pda: approval, sale_pda: sale, application_hash: hash.hex,
        amount_eur: result.amount_eur, subject: result.subject, existing: result.existing, capacity: result.capacity,
        issuer: chain.issuer, asset: chain.asset, payment_decimals: decimals,
      },
    });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
