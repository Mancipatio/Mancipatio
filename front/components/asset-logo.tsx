import Image from "next/image";
import { approvedAssetLogo, uploadedLogoUrl } from "@/lib/asset-branding";
import { assetInitials } from "@/lib/asset-presentation";

/**
 * A company's mark next to its token, the same wherever the token is listed:
 * the logo an admin approved (the published profile's `logo_path`), else the
 * operator's own file for the asset (lib/asset-branding.ts), else the
 * initials of the name. Decorative: the name is always printed next to it.
 */
export function AssetLogo({
  assetPda,
  name,
  logoPath,
  size = 40,
  className = "asset-logo",
}: {
  assetPda: string | null | undefined;
  name: string;
  /** The published profile's approved logo path, when it has one. */
  logoPath?: string | null;
  size?: number;
  className?: string;
}) {
  const uploaded = uploadedLogoUrl(assetPda, logoPath);
  const logo = uploaded ? null : approvedAssetLogo(assetPda);
  return (
    <span className={className} style={{ width: size, height: size }} aria-hidden="true">
      {uploaded
        // A file in the storage bucket, outside the image optimizer's hosts: a plain element, sized here.
        // eslint-disable-next-line @next/next/no-img-element
        ? <img src={uploaded} width={size} height={size} alt="" loading="lazy" decoding="async" />
        : logo
          ? <Image src={logo.src} width={size} height={size} alt="" sizes={`${size}px`} />
          : assetInitials(name)}
    </span>
  );
}
