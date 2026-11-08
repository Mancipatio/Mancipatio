import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import "./workspace.css";
import "./documentation.css";
import "./document-library.css";
import "./account.css";
import { Providers } from "./providers";
import { MaintenanceBanner } from "@/components/maintenance-banner";
import { ManciAssistant } from "@/components/manci-assistant";
import { indexingAllowed } from "@/lib/indexing";
import { SITE_OPEN_GRAPH, siteUrl } from "@/lib/site-url";
import { MANCI_X_HANDLE } from "@/lib/social";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  // Canonical links, og:url and the og:image URL resolve against the
  // configured site origin (lib/site-url.ts: NEXT_PUBLIC_SITE_URL when it is
  // an https origin, else https://www.manci.io; never a request's Host).
  metadataBase: new URL(siteUrl()),
  // The defaults for a page without its own title or description.
  title: "Manci — company shares on Solana",
  description:
    "Manci tokenizes shares of private companies on Solana, with a documented path from token to registered ownership.",
  // Every page names itself as canonical ("./" resolves against the page's
  // own path; a query string never makes a second URL) unless it sets its own.
  alternates: { canonical: "./" },
  // Shallow defaults every page inherits: Next.js fills og:title and
  // og:description, and the Twitter card's title, description and image,
  // from the page's own title, description and app/opengraph-image.tsx. A
  // page that sets its own openGraph or twitter replaces these whole.
  openGraph: { ...SITE_OPEN_GRAPH, url: "./" },
  twitter: { card: "summary_large_image", site: MANCI_X_HANDLE },
  // No indexing unless this is a mainnet build that opted in with
  // NEXT_PUBLIC_ALLOW_INDEXING=true (lib/indexing.ts; app/robots.ts agrees).
  robots: indexingAllowed()
    ? { index: true, follow: true }
    : {
        index: false,
        follow: false,
        nocache: true,
        googleBot: {
          index: false,
          follow: false,
          noimageindex: true,
        },
      },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <MaintenanceBanner />
        <Providers>{children}</Providers>
        <ManciAssistant />
      </body>
    </html>
  );
}
