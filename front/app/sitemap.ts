import type { MetadataRoute } from "next";
import { sitemapEntries } from "@/lib/sitemap";

// /sitemap.xml: the public marketing and documentation pages this deployment
// shows (lib/sitemap.ts), on the configured site origin (lib/site-url.ts).
// Empty unless the build may be indexed (lib/indexing.ts), the same switch as
// app/robots.ts, which names this file only then. Built at build time (no
// request-time APIs), like the NEXT_PUBLIC_* values it reads.
export default function sitemap(): MetadataRoute.Sitemap {
  return sitemapEntries();
}
