import type { Metadata } from "next";
import { detectNetwork } from "@/lib/network";
import { DevnetPrivacy } from "./devnet-privacy";
import { MainnetPrivacy } from "./mainnet-privacy";

/**
 * Privacy Policy, per network: the devnet pilot's text on devnet, testnet and
 * localnet (./devnet-privacy.tsx), counsel's mainnet text from
 * lib/legal/mainnet-copy.ts on mainnet (./mainnet-privacy.tsx). A mainnet
 * build is refused until that text and the operator record are complete
 * (next.config.ts assertBuildMainnetLegal).
 */
export const metadata: Metadata = {
  title: "Privacy Policy — Manci",
  description:
    "How Manci collects, uses and protects personal data of issuers, investors and visitors.",
};

export default function PrivacyPage() {
  return detectNetwork() === "mainnet" ? <MainnetPrivacy /> : <DevnetPrivacy />;
}
