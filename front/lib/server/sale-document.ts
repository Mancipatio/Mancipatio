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
export async function publishedSaleDocument(
  sale: string,
): Promise<SaleDocumentTerms> {
  const asset = await saleAssetAddress(sale);
  const result = await getSupabaseAdmin()
    .from("asset_profiles")
    .select("whitepaper_path,whitepaper_sha256,whitepaper_version_id")
    .eq("asset_pda", asset)
    .eq("network", detectNetwork())
    .eq("is_published", true)
    .eq("status", "published")
    .in("whitepaper_status", ["published", "ssc_approved"])
    .maybeSingle();
  if (result.error) throw new SiwsError(503, "Document metadata unavailable");
  const p = result.data;
  if (
    !p?.whitepaper_version_id ||
    typeof p.whitepaper_path !== "string" ||
    !p.whitepaper_path.startsWith(`whitepapers/${asset}/`)
  )
    throw new SiwsError(
      409,
      "The issuer must publish a verified document version before accepting investments in the app",
    );
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
  };
}
