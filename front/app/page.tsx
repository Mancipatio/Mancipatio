import type { Metadata } from "next";
import { AppShell } from "@/components/app-shell";
import { MarketOverview } from "@/components/market-overview";

export const metadata: Metadata = {
  title: "Overview · Mancipatio",
  description: "Explore real-world assets, primary sales, OTC offers and your vesting on Solana.",
};

export default function HomePage() {
  return <AppShell><MarketOverview /></AppShell>;
}
