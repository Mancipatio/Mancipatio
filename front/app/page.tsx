import type { Metadata } from "next";
import { AppShell } from "@/components/app-shell";
import { MarketOverview } from "@/components/market-overview";

export const metadata: Metadata = {
  title: "Overview · Manci",
  description: "Explore tokenized real-world assets and their primary sales on Solana, and follow your holdings in your portfolio.",
};

export default function HomePage() {
  return <AppShell><MarketOverview /></AppShell>;
}
