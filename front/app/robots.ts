import type { MetadataRoute } from "next";
import { indexingAllowed, NON_INDEXED_PATHS } from "@/lib/indexing";
import { siteHref } from "@/lib/site-url";

// Replaces the old static public/robots.txt ("Disallow: /" everywhere). The
// policy is lib/indexing.ts: every build disallows all crawling unless it is
// a mainnet build with NEXT_PUBLIC_ALLOW_INDEXING=true. Only then does it name
// the sitemap (app/sitemap.ts, empty in every other case), on the configured
// site origin (lib/site-url.ts). Built at build time (no request-time APIs),
// like the NEXT_PUBLIC_* values it reads.
export default function robots(): MetadataRoute.Robots {
  if (!indexingAllowed()) {
    return { rules: { userAgent: "*", disallow: "/" } };
  }
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: [...NON_INDEXED_PATHS],
    },
    sitemap: siteHref("/sitemap.xml"),
  };
}
