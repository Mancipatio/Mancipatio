import type { Metadata } from "next";
import {
  Body,
  Button,
  ButtonRow,
  Card,
  H2,
  MX_ROUTES,
  PageHeader,
  Section,
  Small,
  TextLink,
} from "@/components/mx";
import { detectNetwork, isTestNetwork } from "@/lib/network";

export const metadata: Metadata = {
  title: "Investor guide — Manci",
  description:
    "Find an asset, review its documents, connect your wallet and use the sale, OTC and portfolio screens.",
};

const STEPS = [
  {
    title: "01 · Explore the market",
    body: "Browse assets, open sales and funded OTC offers. Open an asset to review its issuer and available share classes.",
    links: [{ label: "Explore markets", href: MX_ROUTES.home }],
  },
  {
    title: "02 · Read the documents",
    body: "Review the selected issuance's rights, terms and disclosures. Use the instrument comparison when you need context for its asset category.",
    links: [
      { label: "Token documents", href: MX_ROUTES.whitepapers },
      { label: "Compare instruments", href: MX_ROUTES.instruments },
    ],
  },
  {
    title: "03 · Connect your wallet",
    body: "Connect a Solana wallet using the app's wallet control. Buying and trading tokens does not require identity verification. You verify (KYC) later, if you convert tokens into company shares or take delivery of a physical good. A class marked KYC-gated also requires an approved investor passport, shown in Portfolio.",
    links: [
      { label: "Open Portfolio", href: "/portfolio" },
      { label: "Verification rules", href: MX_ROUTES.security },
    ],
  },
  {
    title: "04 · Review a purchase",
    body: "Review the units, payment token, price and whether the class is KYC-gated. For a primary sale, read and accept the displayed document version before signing; the purchase records its version and file hash.",
    links: [
      { label: "Primary sales", href: "/marketplace/launchpad" },
      { label: "OTC offers", href: "/marketplace/otc" },
    ],
  },
];

export default function InvestorsPage() {
  const network = detectNetwork();
  return (
    <>
      <PageHeader
        eyebrow="Getting started"
        title="Investor guide"
        lede="Follow an asset from discovery and document review to purchase and your portfolio."
      >
        <ButtonRow>
          <Button href={MX_ROUTES.home}>Explore markets</Button>
          <Button href={MX_ROUTES.whitepapers} variant="ghost">
            Token documents
          </Button>
        </ButtonRow>
        <Small className="mt-5">
          The app currently runs on Solana {network}.
          {isTestNetwork(network) && " Test tokens have no economic value."}
        </Small>
      </PageHeader>

      <Section>
        <H2>Before your first purchase</H2>
        <ol className="mt-6 grid gap-4 md:grid-cols-2">
          {STEPS.map((step) => (
            <li key={step.title}>
              <Card title={step.title} body={step.body} className="h-full">
                <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2">
                  {step.links.map((link) => (
                    <TextLink key={link.href} href={link.href}>
                      {link.label} →
                    </TextLink>
                  ))}
                </div>
              </Card>
            </li>
          ))}
        </ol>
        <Body className="mt-6">
          Read the <TextLink href={MX_ROUTES.risks}>risk disclosure</TextLink>{" "}
          and the selected issuance&apos;s documents before deciding to
          participate. The{" "}
          <TextLink href={MX_ROUTES.legalStructure}>legal structure</TextLink>{" "}
          guide explains where the documented rights are defined.
        </Body>
      </Section>

      <Section>
        <H2>After a purchase</H2>
        <Body className="mt-4">
          Use Portfolio to review your holdings and transaction history. Its
          navigation also opens vesting, payouts, governance, conversion and
          delivery when relevant to your positions. If recording is pending, use
          the saved transaction receipt to retry the record instead of repeating
          the payment.
        </Body>
        <Body className="mt-4">
          Startup payout-vault entitlements follow their saved original-investor
          snapshot, even if token balances later change. Read the{" "}
          <TextLink href="/solutions/governance">
            snapshot and payout-rights guide
          </TextLink>{" "}
          for that distinction.
        </Body>
        <ButtonRow>
          <Button href="/portfolio">Open Portfolio</Button>
          <Button href="/portfolio/vesting" variant="ghost">
            Check vesting
          </Button>
        </ButtonRow>
      </Section>
    </>
  );
}
