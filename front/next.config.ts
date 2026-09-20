import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The local preview uses this exact loopback hostname; production is unchanged.
  allowedDevOrigins: ["127.0.0.1"],
  poweredByHeader: false,
  async headers() {
    return ["/account/:path*", "/api/account/:path*"].map((source) => ({
      source,
      headers: [
        { key: "Cache-Control", value: "no-store" },
        { key: "Referrer-Policy", value: "no-referrer" },
        { key: "X-Robots-Tag", value: "noindex, nofollow" },
      ],
    }));
  },
  async redirects() {
    return [
      // Absorbed into the homepage. Note: redirect destinations can't carry a
      // hash, so this lands on "/".
      { source: "/why-mancipatio", destination: "/", permanent: true },
      // /how-it-works used to redirect here; it is a real page again. The old
      // redirect was permanent (308), so browsers that followed it have it
      // cached — this temporary redirect exists only to unstick them and can
      // be dropped once the cached entries age out.
      { source: "/invest", destination: "/investors", permanent: false },
    ];
  },
};

export default nextConfig;
