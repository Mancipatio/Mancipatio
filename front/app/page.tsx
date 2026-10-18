import type { Metadata } from "next";
import { AppShell } from "@/components/app-shell";
import { MarketOverview } from "@/components/market-overview";
import { navHrefVisible } from "@/lib/pilot-scope";

// Only the markets this network runs (lib/pilot-scope.ts).
const offers = [
  "real-world assets",
  ...(navHrefVisible("/marketplace/launchpad") ? ["primary sales"] : []),
  ...(navHrefVisible("/marketplace/otc") ? ["OTC offers"] : []),
  ...(navHrefVisible("/portfolio/vesting") ? ["your vesting"] : []),
];

export const metadata: Metadata = {
  title: "Overview · Manci",
  description: offers.length === 1
    ? `Explore ${offers[0]} on Solana.`
    : `Explore ${offers.slice(0, -1).join(", ")} and ${offers[offers.length - 1]} on Solana.`,
};

export default function HomePage() {
  return <AppShell><MarketOverview /></AppShell>;
}
