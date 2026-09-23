// SERVER-ONLY — shared helpers for /api/sale-approvals/* (program package 2B).
// The `_lib` underscore prefix keeps this file out of routing.

import "server-only";

import { fetchEncodedAccount, type Address } from "@solana/kit";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  KybStatus,
  fetchMaybeAsset,
  fetchMaybeIssuer,
  fetchMaybeShareClass,
  findAssetPda,
  findIssuerPda,
  findSaleApprovalPda,
} from "@/lib/generated/asset_registry";
import { findSalePda, findShareClassPda } from "@/lib/pdas";
import { getServerRpc } from "@/lib/server/rpc";
import { SiwsError } from "@/lib/server/siws";
import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from "@/lib/server/sale-capacity";
import type { SupabaseClient } from "@supabase/supabase-js";
import { detectNetwork } from "@/lib/network";

export { isAdminWallet } from "@/app/api/launchpad/_lib";

export type ShareClassChain = {
  shareClass: Address;
  asset: Address;
  issuer: Address;
  authority: Address;
  issuerVerified: boolean;
};

const read = { commitment: "confirmed" as const };

/** ShareClass → Asset → Issuer at `confirmed`, each PDA re-derived. */
export async function shareClassChain(shareClass: Address): Promise<ShareClassChain> {
  try {
    const rpc = getServerRpc();
    const config = { ...read, abortSignal: AbortSignal.timeout(12_000) };
    const sc = await fetchMaybeShareClass(rpc, shareClass, config);
    if (!sc.exists || sc.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS
      || (await findShareClassPda(sc.data.asset, sc.data.classIndex)) !== shareClass) {
      throw new SiwsError(404, "Share class not found on-chain");
    }
    const asset = await fetchMaybeAsset(rpc, sc.data.asset, config);
    if (!asset.exists || asset.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS
      || (await findAssetPda({ issuer: asset.data.issuer, assetId: asset.data.assetId }))[0] !== sc.data.asset) {
      throw new SiwsError(404, "Asset not found on-chain");
    }
    const issuer = await fetchMaybeIssuer(rpc, asset.data.issuer, config);
    if (!issuer.exists || issuer.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS
      || (await findIssuerPda({ legalEntityId: issuer.data.legalEntityId }))[0] !== asset.data.issuer) {
      throw new SiwsError(404, "Issuer not found on-chain");
    }
    return {
      shareClass, asset: sc.data.asset, issuer: asset.data.issuer, authority: issuer.data.authority,
      issuerVerified: issuer.data.kybStatus === KybStatus.Verified,
    };
  } catch (err) {
    if (err instanceof SiwsError) throw err;
    console.error("[api/sale-approvals] RPC failure resolving the share class:", err);
    throw new SiwsError(503, "On-chain check unavailable — try again");
  }
}

export async function saleAndApprovalPdas(shareClass: Address, saleId: bigint) {
  const [approval] = await findSaleApprovalPda({ shareClass, saleId });
  return { sale: await findSalePda(shareClass, saleId), approval };
}

/** Whether an account exists at `confirmed` (any owner). */
export async function accountExists(key: Address): Promise<boolean> {
  try {
    const account = await fetchEncodedAccount(getServerRpc(), key, { ...read, abortSignal: AbortSignal.timeout(12_000) });
    return account.exists;
  } catch (err) {
    console.error("[api/sale-approvals] RPC failure reading an account:", err);
    throw new SiwsError(503, "On-chain check unavailable — try again");
  }
}

/** A payment mint's decimals, read from chain (SPL Token or Token-2022). */
export async function paymentMintDecimals(mint: Address): Promise<number> {
  let account;
  try {
    account = await fetchEncodedAccount(getServerRpc(), mint, { ...read, abortSignal: AbortSignal.timeout(12_000) });
  } catch (err) {
    console.error("[api/sale-approvals] RPC failure reading the payment mint:", err);
    throw new SiwsError(503, "On-chain check unavailable — try again");
  }
  if (!account.exists || (account.programAddress !== TOKEN_PROGRAM && account.programAddress !== TOKEN_2022_PROGRAM)
    || account.data.length < 82 || account.data[45] !== 1) {
    throw new SiwsError(400, "payment_mint is not an initialized token mint");
  }
  // Mint layout: mint_authority COption(36) supply u64(8) decimals u8 @44 is_initialized @45.
  return account.data[44];
}

/** The wallets of the same person (0056 applicant_wallets). */
export async function applicantWallets(sb: SupabaseClient, wallet: string): Promise<string[]> {
  const { data, error } = await sb.rpc("applicant_wallets", { p_wallet: wallet, p_network: detectNetwork() });
  if (error || !Array.isArray(data)) throw new SiwsError(503, "Could not resolve the applicant's wallets");
  return data as string[];
}

/** The asset's SPV (asset_profiles.spv_id), or null for an issuer subject. */
export async function assetSpvId(sb: SupabaseClient, asset: string): Promise<string | null> {
  const { data, error } = await sb.from("asset_profiles").select("spv_id")
    .eq("network", detectNetwork()).eq("asset_pda", asset).maybeSingle();
  if (error) throw new SiwsError(503, "Could not read the asset profile");
  return (data?.spv_id as string | null | undefined) ?? null;
}

export function subjectOf(spvId: string | null, issuer: string): string {
  return spvId ? `spv:${spvId}` : `issuer:${issuer}`;
}

/** Columns the admin and issuer UIs read (never the raw snapshot by default). */
export const RESERVATION_FIELDS =
  "id,kind,status,share_class_pda,sale_id,approval_pda,sale_pda,asset_pda,issuer_pda,spv_id,subject,application_id," +
  "application_hash,payment_mint,payment_decimals,max_gross_raise,min_price_per_unit,max_price_per_unit,raise_type," +
  "expires_at,amount_units,amount_eur,fx_rate,fx_kind,fx_source,fx_as_of,reason,chain_confirmed_at,approve_signature," +
  "mint_signature,consumed_at,booked_amount_eur,booked_at,released_at,release_reason,last_error,reserved_by,created_at,updated_at";
