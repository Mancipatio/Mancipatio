import type { Metadata } from "next";
import { Body, Button, ButtonRow, H2, PageHeader, Section, Small, Steps, TextLink } from "@/components/mx";
import { detectNetwork, isTestNetwork } from "@/lib/network";
import { navHrefVisible } from "@/lib/pilot-scope";

const sales = navHrefVisible("/marketplace/launchpad");
const otc = navHrefVisible("/marketplace/otc");
const conversion = navHrefVisible("/portfolio/conversion");
const screens = [...(sales ? ["sale"] : []), ...(otc ? ["OTC"] : []), "portfolio"];

export const metadata: Metadata = {
  title: "Investor guide — Manci",
  description:
    `Find an asset, review its documents, connect your wallet and use the ${screens.length > 1 ? `${screens.slice(0, -1).join(", ")} and ` : ""}${screens[screens.length - 1]} screens.`,
};

export default function InvestorsPage() {
  const network = detectNetwork();
  const steps = [
    {
      title: "Find an asset.",
      body: <>Browse the <TextLink href="/marketplace">marketplace</TextLink>{sales && <>{otc ? ", " : " and "}<TextLink href="/marketplace/launchpad">open sales</TextLink></>}{otc && <> and <TextLink href="/marketplace/otc">funded DeFi OTC offers</TextLink></>}. Each asset shows the company behind it and its share classes.</>,
    },
    {
      title: "Check all sides.",
      body: <>Read the <TextLink href="/markets/whitepapers">issuance documents</TextLink>: what the token gives you, any payouts and the transfer rules. Then look the company up in the BRA register and the token on Solana. <TextLink href="/legal-structure">Legal structure</TextLink></>,
    },
    {
      title: "Connect your wallet.",
      body: <>Connect a Solana wallet and sign in by signing a message. Accept the <TextLink href="/legal/terms">Terms and Conditions</TextLink>. Every user goes through sanctions screening. KYC is needed only if the issuance requires it{conversion && ", or when you convert"}.</>,
    },
    ...(sales ? [{
      title: "Buy.",
      body: "Check the tokens, the price and the eligibility rules. Purchases currently use USDC on Solana, so keep some SOL for network fees. In a primary sale, you accept the issuance documents and separately acknowledge the risks before you sign. The purchase records the document version and its file hash.",
    }] : []),
    {
      title: conversion ? "Hold, sell or convert." : "Hold or sell.",
      body: <><TextLink href="/portfolio">Portfolio</TextLink> shows your holdings, transactions and issuer announcements, and you can <TextLink href="/portfolio/history">export your history as a CSV file</TextLink>. {conversion
        ? "Hold, sell under the issuance's transfer rules, or convert: pass KYC, your tokens go into escrow, the transfer is signed and registered with BRA, and the tokens are burned."
        : "Hold or sell under the issuance's transfer rules."} {navHrefVisible("/markets/types/equity") && <TextLink href="/markets/types/equity">Company ownership</TextLink>}</>,
    },
  ];

  return (
    <>
      <PageHeader
        eyebrow="Getting started"
        title="Investor guide"
        lede={sales && conversion ? "From finding a token to owning part of the company, in five steps." : "From finding a token to reviewing your holdings."}
      >
        <ButtonRow>
          <Button href="/marketplace">Explore assets</Button>
          <Button href="/risks" variant="ghost">Read the risk disclosure</Button>
        </ButtonRow>
        {isTestNetwork(network) && <Small className="mt-5">The app currently runs on Solana {network}. Test tokens have no economic value.</Small>}
      </PageHeader>
      <Section>
        <H2>{sales ? "Five steps" : "Four steps"}</H2>
        <Steps className="mt-6" items={steps} />
      </Section>
      <Section>
        <H2>Before you buy</H2>
        <Body className="mt-4">
          Read the risk disclosure and the issuance documents. You can lose some or all of your investment. <TextLink href="/risks">Risk disclosure</TextLink>
        </Body>
        <ButtonRow>
          <Button href="/portfolio">Open Portfolio</Button>
          {conversion && <Button href="/portfolio/conversion" variant="ghost">Convert tokens into equity</Button>}
        </ButtonRow>
      </Section>
    </>
  );
}
