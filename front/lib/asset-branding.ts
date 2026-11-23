// Approved company logos, shown wherever a token is listed (the overview, the
// marketplace, the asset page).
//
// A logo is the fastest way to pass one company off as another, so a logo is
// never taken from an issuer-writable field or a remote URL: it is a file in
// this repository (public/tokens/), added here by the operator once the
// company's verification (KYB) is done. An asset without an entry shows its
// initials instead (components/asset-logo.tsx).
//
// Keyed by network and asset PDA: the same asset id can exist under another
// issuer, and devnet PDAs are not mainnet's.

import { detectNetwork, type Network } from "@/lib/network";

export type ApprovedLogo = {
  /** Path under public/, served by this site. */
  src: string;
};

const APPROVED_LOGOS: Partial<Record<Network, Readonly<Record<string, ApprovedLogo>>>> = {
  mainnet: {
    // MANCI, the company token of Mancipatio d.o.o.: the image the mint's
    // metadata already carries (public/tokens/manci0.json).
    HzjgBogwPPMzj5m2CgGLyPUv5Qz27TmvbFy9MWbevuv6: { src: "/tokens/manci0.png" },
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
