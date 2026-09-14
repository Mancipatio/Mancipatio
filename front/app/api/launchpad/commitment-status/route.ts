import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";
import {
  requirePurchaseEvidence,
  transactionSignature,
} from "@/lib/server/chain-evidence";
import {
  COMMITMENT_STATUSES,
  UUID_RE,
  isAdminWallet,
  saleIssuerAuthority,
} from "../_lib";

export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(
      request,
      "launchpad.commitmentStatus",
    );
    const id = typeof params.id === "string" ? params.id.trim() : "";
    if (!UUID_RE.test(id))
      throw new SiwsError(400, "id must be a commitment UUID");
    const status = typeof params.status === "string" ? params.status : "";
    if (!COMMITMENT_STATUSES.has(status))
      throw new SiwsError(400, "Unknown commitment status");
    const sb = getSupabaseAdmin();
    const network = detectNetwork();
    const { data: row, error } = await sb
      .from("commitments")
      .select(
        "id,sale_pubkey,investor_wallet,status,evidence_verified,settled_tx,instruction_index,document_version_id",
      )
      .eq("id", id)
      .eq("network", network)
      .maybeSingle();
    if (error) throw new SiwsError(503, "Commitment lookup unavailable");
    if (!row) throw new SiwsError(404, "Commitment not found");
    if (
      !(await isAdminWallet(wallet)) &&
      (await saleIssuerAuthority(row.sale_pubkey)) !== wallet
    )
      throw new SiwsError(
        403,
        "Only the platform admin or sale issuer may update commitments",
      );
    if (row.evidence_verified) {
      if (
        status === "settled" &&
        (!params.settled_tx || params.settled_tx === row.settled_tx)
      )
        return NextResponse.json({ ok: true, data: { id, status } });
      throw new SiwsError(
        409,
        "A verified purchase is immutable; record a separate proven refund",
      );
    }
    if (row.status === "cancelled")
      throw new SiwsError(409, "A cancelled commitment cannot be reopened");
    const patch: Record<string, unknown> = { status };
    if (status === "settled") {
      const signature = transactionSignature(params.settled_tx);
      const index = params.instruction_index;
      if (
        index !== undefined &&
        (typeof index !== "number" ||
          !Number.isInteger(index) ||
          index < 0 ||
          index > 255)
      )
        throw new SiwsError(400, "Invalid instruction index");
      const proof = await requirePurchaseEvidence(
        signature,
        row.sale_pubkey,
        row.investor_wallet,
        index as number | undefined,
      );
      if (
        row.document_version_id &&
        proof.terms?.versionId !== row.document_version_id
      )
        throw new SiwsError(
          409,
          "Purchase document acceptance differs from this pledge. Record the purchase separately without changing the accepted pledge terms",
        );
      if (row.document_version_id) {
        const version = await sb
          .from("document_versions")
          .select("sha256,bucket,path")
          .eq("id", row.document_version_id)
          .eq("network", network)
          .maybeSingle();
        if (version.error)
          throw new SiwsError(
            503,
            "Accepted document verification unavailable",
          );
        if (
          !version.data ||
          version.data.sha256 !== proof.terms?.sha256 ||
          version.data.bucket !== "documents" ||
          !version.data.path.startsWith(`whitepapers/${proof.asset}/`)
        )
          throw new SiwsError(
            409,
            "The purchase did not accept the verified document bytes for this asset",
          );
      }
      Object.assign(patch, {
        settled_tx: signature,
        evidence_verified: true,
        amount: proof.amount,
        payment_mint: proof.paymentMint,
        payment_decimals: proof.decimals,
        amount_atomic: proof.amountAtomic,
        units: proof.units,
        instruction_index: proof.instructionIndex,
        finalized_slot: proof.slot,
      });
    } else if (params.settled_tx !== undefined) {
      throw new SiwsError(
        400,
        "A payment signature belongs only to a verified settlement",
      );
    }
    const updated = await sb
      .from("commitments")
      .update(patch)
      .eq("id", id)
      .eq("network", network)
      .eq("status", row.status)
      .eq("evidence_verified", false)
      .select("id")
      .maybeSingle();
    if (updated.error)
      throw new SiwsError(
        updated.error.code === "23505" ? 409 : 503,
        updated.error.code === "23505"
          ? "This purchase instruction is already recorded"
          : "Commitment update unavailable",
      );
    if (!updated.data)
      throw new SiwsError(409, "Commitment changed; refresh before retrying");
    return NextResponse.json({ ok: true, data: { id, status } });
  } catch (error) {
    return siwsErrorResponse(error);
  }
}
