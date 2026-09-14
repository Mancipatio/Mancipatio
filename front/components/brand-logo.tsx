import Image from "next/image";

/** Use inside a home link; the image supplies the link's accessible name. */
export function BrandLogo() {
  return (
    <span className="brand-logo">
      <Image src="/brand/mancipatio-logo.png" width={1050} height={472} alt="Mancipatio" className="brand-logo-image" sizes="198px" loading="eager" />
    </span>
  );
}
