import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import "./workspace.css";
import "./documentation.css";
import "./document-library.css";
import "./account.css";
import { Providers } from "./providers";
import { MaintenanceBanner } from "@/components/maintenance-banner";
import { indexingAllowed } from "@/lib/indexing";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_SITE_URL || "https://www.manci.io",
  ),
  title: "Manci — on-chain tokenization",
  description:
    "Manci issues, custodies, trades and vests tokenized real-world assets and investments on Solana.",
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
      </body>
    </html>
  );
}
