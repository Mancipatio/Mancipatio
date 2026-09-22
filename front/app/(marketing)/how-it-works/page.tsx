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

export const metadata = {
  title: "Issuing an asset · Manci",
  description:
    "The shared issuer process: onboarding, application, review, documentation, registration and distribution.",
};

const STEPS = [
  {
    title: "Complete issuer onboarding",
    body: "Register the issuing entity, provide the requested verification documents and accept the terms of service.",
  },
  {
    title: "Describe the proposed issuance",
    body: "For an equity raise, submit the launchpad application. For other asset types, contact the team to scope the asset, rights, amount and schedule.",
  },
  {
    title: "Complete the review",
    body: "The team reviews the proposal and supporting documents. An application can be approved, returned for changes or declined; requested changes are submitted for another review.",
  },
  {
    title: "Finalize the structure and documents",
    body: "Agree the legal and commercial terms for this issuance. Prepare the required entity structure, rights documentation and disclosures before proceeding.",
  },
  {
    title: "Register the asset and its share classes",
    body: "Record the asset and configure the token classes, their rights and supply settings to match the approved terms.",
  },
  {
    title: "Distribute the tokens",
    body: "Use the agreed sale or allocation process. Investors review the issuance terms; buying and trading need no identity verification unless you make the class KYC-gated. Holders verify their identity when they convert tokens into company shares or take delivery of a physical good.",
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
          <Button href="/apply">Apply for an equity raise</Button>
          <Button href="/contact" variant="ghost">
            Discuss another asset
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
      <Section id="distributions">
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
      </Section>
      <Section>
        <H2>After issuance</H2>
        <Grid cols={2} className="mt-5">
          <Card
            href="/solutions/otc"
            title="Secondary trading"
            body="How offers, escrow funding, settlement and cancellation work."
          />
          <Card
            href="/solutions/rights-vesting"
            title="Vesting & claims"
            body="Scheduled releases, beneficiary positions and Rights-token claims."
          />
          <Card
            href="/solutions/custody"
            title="Custody & delivery"
            body="Follow the asset through escrow, delivery or return."
          />
          <Card
            href="/solutions/governance"
            title="Governance"
            body="Review proposals, snapshots and voting procedures."
          />
        </Grid>
      </Section>
    </>
  );
}
