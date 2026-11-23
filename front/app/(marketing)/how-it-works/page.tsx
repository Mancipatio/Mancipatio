import Link from "next/link";
import {
  Body,
  Button,
  ButtonRow,
  Card,
  Grid,
  H2,
  PageHeader,
  Section,
  Steps,
} from "@/components/mx";
import { navHrefVisible } from "@/lib/pilot-scope";

export const metadata = {
  title: "Issuing an asset · Manci",
  description:
    "The issuer process: KYC or KYB, verification review, token issuance request, documentation and primary sale.",
};

const STEPS = [
  {
    title: "Complete KYC or KYB",
    body: "Verify your identity (KYC) as an individual founder or your company (KYB). Submit the requested documents from the issuer workspace.",
  },
  {
    title: "Follow the verification review",
    body: "Check your status while the team reviews the submission. If changes or additional documents are requested, update the same request and resubmit. Continue once verification is approved.",
  },
  {
    title: "Request token issuance",
    body: "Submit the equity issuance application with the proposed asset, rights, amount and schedule. Follow its review and respond to any requested changes.",
  },
  {
    title: "Finalize the terms and documents",
    body: "Agree the legal and commercial terms for this issuance. Prepare the required entity structure, rights documentation and disclosures before proceeding.",
  },
  {
    title: "Issue the tokens",
    body: "Register the approved asset and configure its token classes and supply to match the agreed terms.",
  },
  {
    title: "Open the primary sale",
    body: "Publish the approved sale terms so investors can review the documents and purchase the available tokens. Review holdings and transaction history in Portfolio.",
  },
];

// The guides of modules switched off on this network are left out (lib/pilot-scope.ts).
const AFTER_ISSUANCE = [
  {
    href: "/solutions/otc",
    title: "Secondary trading",
    body: "How offers, escrow funding, settlement and cancellation work.",
  },
  {
    href: "/solutions/rights-vesting",
    title: "Vesting & claims",
    body: "Scheduled releases, beneficiary positions and Rights-token claims.",
  },
  {
    href: "/portfolio/conversion",
    title: "Convert tokens into company shares",
    body: "A verified holder can request conversion of eligible tokens they own, subject to the issuance terms and review.",
  },
  {
    href: "/portfolio/delivery",
    title: "Physical delivery",
    body: "Follow an eligible physical asset through delivery or return.",
  },
  {
    href: "/solutions/governance",
    title: "Governance",
    body: "Review proposals, snapshots and voting procedures.",
  },
].filter((card) => navHrefVisible(card.href));

// What each side has once a company's token is issued. Each line restates the
// Terms of Service (the issuer is responsible for its instrument; the Operator
// is not the issuer and takes no legal title; issuers pay what their
// engagement agreement provides) or the landing page's four steps. The token
// page says the same to a holder (components/asset-roles.tsx).
const WHO_GETS_WHAT = [
  {
    title: "Your company",
    body: "Issues a token for the stake it chooses, up to a cap recorded on Solana, and stays responsible for the token, its documents and its disclosures. When a holder converts, the company completes the legal transfer and the entry in the official register.",
  },
  {
    title: "Your token holders",
    body: "Hold a documented right to acquire a share, in their own wallets, and can transfer it. Holding a token alone does not make them registered shareholders: where you offer conversion and it is available, they verify their identity, and the registered share replaces the burned tokens.",
  },
  {
    title: "Manci",
    body: "Verifies the company, runs issuance and conversion on Solana and publishes the record of each register entry next to the token. Manci is not the issuer and takes no legal title to what backs the token. The company pays what its engagement agreement provides.",
  },
];

export default function HowItWorksPage() {
  return (
    <>
      <PageHeader
        eyebrow="Issuer guide"
        title="Issuing an asset"
        lede="The common path from an application to an issued asset. The documents and requirements are specific to each issuance."
      >
        <ButtonRow>
          <Button href="/issuer">Start with KYC / KYB</Button>
          <Button href="/contact" variant="ghost">
            Contact the team
          </Button>
        </ButtonRow>
      </PageHeader>
      <Section>
        <H2>The issuance process</H2>
        <Steps className="mt-5" items={STEPS} />
        <p className="mt-5">
          <Link className="mx-link" href="/legal-structure">
            Read about the legal structure →
          </Link>
        </p>
      </Section>
      <Section id="who-gets-what">
        <H2>Who gets what</H2>
        <Grid cols={3} className="mt-5">
          {WHO_GETS_WHAT.map((card) => (
            <Card key={card.title} title={card.title} body={card.body} />
          ))}
        </Grid>
        <p className="mt-5">
          <Link className="mx-link" href="/pricing">
            Fees and costs →
          </Link>
        </p>
      </Section>
      {/* Income distributions and claims: hidden with the module switched off (lib/pilot-scope.ts). */}
      {navHrefVisible("/portfolio/rights") && <Section id="distributions">
        <H2>Income distributions</H2>
        <Body className="mt-4">
          Where an instrument pays income, review its terms and the approved
          recipient snapshot. For push distributions, the operator saves the
          recipients and exact amounts before funding. The app then resumes the
          same committed groups using on-chain receipts; it never rebuilds them
          from changed balances.
        </Body>
        <Body className="mt-4">
          The payout plan allocates the full funding amount using a stated
          rounding rule. A contract can distribute deposited funds; it cannot
          create revenue or make an unfunded payment. Startup vault investor
          entitlements use their separate original-investor snapshot. Review the
          applicable records in your portfolio.
        </Body>
        <p className="mt-5">
          <Link className="mx-link" href="/portfolio/rights">
            Open income & claims →
          </Link>
        </p>
      </Section>}
      {AFTER_ISSUANCE.length > 0 && <Section>
        <H2>After issuance</H2>
        <Grid cols={2} className="mt-5">
          {AFTER_ISSUANCE.map((card) => (
            <Card key={card.href} href={card.href} title={card.title} body={card.body} />
          ))}
        </Grid>
      </Section>}
    </>
  );
}
