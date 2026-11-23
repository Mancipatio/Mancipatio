import Image from "next/image";
import { approvedAssetLogo } from "@/lib/asset-branding";
import { assetInitials } from "@/lib/asset-presentation";

/**
 * A company's mark next to its token, the same wherever the token is listed:
 * the approved logo (lib/asset-branding.ts) or, without one, the initials of
 * the name. Decorative: the name is always printed next to it.
 */
export function AssetLogo({
  assetPda,
  name,
  size = 40,
  className = "asset-logo",
}: {
  assetPda: string | null | undefined;
  name: string;
  size?: number;
  className?: string;
}) {
  const logo = approvedAssetLogo(assetPda);
  return (
    <span className={className} style={{ width: size, height: size }} aria-hidden="true">
      {logo
        ? <Image src={logo.src} width={size} height={size} alt="" sizes={`${size}px`} />
        : assetInitials(name)}
    </span>
  );
}
