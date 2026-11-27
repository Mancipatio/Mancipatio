// Approved company logos, shown wherever a token is listed (the overview, the
// marketplace, the asset page).
//
// A logo is the fastest way to pass one company off as another, so a logo is
// shown only after the operator has looked at it. There are two sources:
//   - a file an issuer uploaded to logos/<asset PDA>/ in the public bucket,
//     shown once an admin approved it: the public profile carries its path
//     only then (lib/profile-public.ts), and the path is checked again here;
//   - a file in this repository (public/tokens/), added by the operator.
// Never a free-form address from a profile field. An asset with neither shows
// its initials instead (components/asset-logo.tsx).
//
// The repository entries are keyed by network and asset PDA: the same asset
// id can exist under another issuer, and devnet PDAs are not mainnet's.

import { detectNetwork, type Network } from "@/lib/network";
import { isLogoPathOf } from "@/lib/company-profile";
import { MANCI_MAINNET_ASSET } from "@/lib/manci-token";

export type ApprovedLogo = {
  /** Path under public/, served by this site. */
  src: string;
};

const APPROVED_LOGOS: Partial<Record<Network, Readonly<Record<string, ApprovedLogo>>>> = {
  mainnet: {
    // MANCI, the company token of Mancipatio d.o.o.: the image the mint's
    // metadata already carries (public/tokens/manci0.json).
    [MANCI_MAINNET_ASSET]: { src: "/tokens/manci0.png" },
  },
};

/** The approved logo of an asset on this network, or null (the caller shows initials). */
export function approvedAssetLogo(
  assetPda: string | null | undefined,
  network: Network = detectNetwork(),
): ApprovedLogo | null {
  if (!assetPda) return null;
  const logos = APPROVED_LOGOS[network];
  return logos && Object.prototype.hasOwnProperty.call(logos, assetPda) ? logos[assetPda] : null;
}

/**
 * The address of an uploaded logo an admin approved: the public bucket's
 * object for `logoPath`, only when that path is this asset's
 * (logos/<asset PDA>/…). null otherwise, and when the storage base is unset.
 */
export function uploadedLogoUrl(assetPda: string | null | undefined, logoPath: string | null | undefined): string | null {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!base || !assetPda || !isLogoPathOf(assetPda, logoPath)) return null;
  return `${base.replace(/\/+$/, "")}/storage/v1/object/public/documents/${logoPath}`;
}
