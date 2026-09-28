import "server-only";
import { address } from "@solana/kit";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  fetchMaybeSale,
  fetchMaybeShareClass,
} from "@/lib/generated/asset_registry";
import { findSalePda, findShareClassPda } from "@/lib/pdas";
import { getServerRpc } from "@/lib/server/rpc";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";
import { SiwsError } from "@/lib/server/siws";
import { requireDocumentVersion } from "@/lib/server/document-versions";
import type { SaleDocumentTerms } from "@/lib/document-terms";
import {
  offeringClearance,
  sscApprovalRef,
  type OfferingClearanceProfile,
} from "@/lib/whitepaper-approval";
export async function saleAssetAddress(saleAddress: string) {
  try {
    const rpc = getServerRpc(),
      options = {
        commitment: "finalized" as const,
        abortSignal: AbortSignal.timeout(12_000),
      };
    const sale = await fetchMaybeSale(rpc, address(saleAddress), options);
    if (
      !sale.exists ||
      sale.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS ||
      (await findSalePda(sale.data.shareClass, sale.data.saleId)) !==
        saleAddress
    )
      throw new SiwsError(404, "Sale not found");
    const shareClass = await fetchMaybeShareClass(
      rpc,
      sale.data.shareClass,
      options,
    );
    if (
      !shareClass.exists ||
      shareClass.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS ||
      (await findShareClassPda(
        shareClass.data.asset,
        shareClass.data.classIndex,
      )) !== sale.data.shareClass
    )
      throw new SiwsError(404, "Share class not found");
    return shareClass.data.asset.toString();
  } catch (error) {
    if (error instanceof SiwsError) throw error;
    throw new SiwsError(503, "Sale document lookup unavailable");
  }
}
/** Columns every network reads. */
const DOCUMENT_COLUMNS = "whitepaper_path,whitepaper_sha256,whitepaper_version_id,whitepaper_status,ssc_decision_ref";
/** Mainnet also reads the verified decision document (0048) and the offering
 *  exemption (migration 0076). Test networks never select the 0076 columns,
 *  so a front deployed before 0076 is applied keeps working. */
const MAINNET_DOCUMENT_COLUMNS =
  `${DOCUMENT_COLUMNS},ssc_decision_version_id,offering_exemption_ref,offering_exemption_reason`;

/**
 * The verified document a sale's purchases and commitments accept (served by
 * /api/launchpad/terms, re-checked by /api/launchpad/commit), with the
 * whitepaper's SSC decision reference for the sale page's approval label. On
 * MAINNET the offering must also be cleared (lib/whitepaper-approval.ts
 * offeringClearance: an SSC-approved whitepaper or a recorded exemption),
 * otherwise 409 — so no purchase or commitment can be prepared in the app.
 */
export async function publishedSaleDocument(
  sale: string,
): Promise<SaleDocumentTerms> {
  const asset = await saleAssetAddress(sale);
  const network = detectNetwork();
  const result = await getSupabaseAdmin()
    .from("asset_profiles")
    .select(network === "mainnet" ? MAINNET_DOCUMENT_COLUMNS : DOCUMENT_COLUMNS)
    .eq("asset_pda", asset)
    .eq("network", network)
    .eq("is_published", true)
    .eq("status", "published")
    .in("whitepaper_status", ["published", "ssc_approved"])
    .maybeSingle();
  if (result.error) throw new SiwsError(503, "Document metadata unavailable");
  const p = result.data as unknown as (OfferingClearanceProfile & {
    whitepaper_path: string | null;
    whitepaper_sha256: string | null;
    whitepaper_version_id: string | null;
  }) | null;
  if (
    !p?.whitepaper_version_id ||
    typeof p.whitepaper_path !== "string" ||
    !p.whitepaper_path.startsWith(`whitepapers/${asset}/`)
  )
    throw new SiwsError(
      409,
      "The issuer must publish a verified document version before accepting investments in the app",
    );
  const clearance = offeringClearance(p, network);
  if (!clearance.cleared) throw new SiwsError(409, clearance.reason);
  const v = await requireDocumentVersion(
    "documents",
    p.whitepaper_path,
    p.whitepaper_sha256,
  );
  if (v.id !== p.whitepaper_version_id)
    throw new SiwsError(409, "Published document version mismatch");
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!base) throw new SiwsError(503, "Document storage unavailable");
  return {
    sale,
    asset,
    versionId: v.id,
    sha256: v.sha256,
    verifiedAt: v.verified_at,
    url: `${base}/storage/v1/object/public/documents/${v.path.split("/").map(encodeURIComponent).join("/")}`,
    sscDecisionRef: sscApprovalRef(p, network),
  };
}
