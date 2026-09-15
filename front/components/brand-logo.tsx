import Image from "next/image";

/** Use inside a home link; the image supplies the link's accessible name. */
export function BrandLogo() {
  return (
    <span className="brand-logo">
      <Image src="/brand/manci-logo.png" width={1320} height={730} alt="Manci" className="brand-logo-image" sizes="140px" loading="eager" />
    </span>
  );
}
