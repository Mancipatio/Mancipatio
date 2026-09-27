import type { Metadata } from "next";
import { detectNetwork } from "@/lib/network";
import { DevnetTerms } from "./devnet-terms";
import { MainnetTerms } from "./mainnet-terms";

/**
 * Terms of Service, per network: the devnet pilot's text on devnet, testnet
 * and localnet (./devnet-terms.tsx, unchanged), counsel's mainnet text from
 * lib/legal/mainnet-copy.ts on mainnet (./mainnet-terms.tsx). A mainnet build
 * is refused until that text and the operator record are complete
 * (next.config.ts assertBuildMainnetLegal).
 */
export const metadata: Metadata = {
  title: "Terms of Service — Manci",
  description:
    "Terms governing access to and use of the Manci tokenization platform.",
};

export default function TermsPage() {
  return detectNetwork() === "mainnet" ? <MainnetTerms /> : <DevnetTerms />;
}
