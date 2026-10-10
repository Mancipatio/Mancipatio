import type { Metadata } from "next";
import {
  Body,
  Button,
  ButtonRow,
  Card,
  Grid,
  H2,
  MX_ROUTES,
  PageHeader,
  Section,
  TextLink,
} from "@/components/mx";

/**
 * Pricing follows the fees clause of the Terms (lib/legal/mainnet-copy.ts,
 * clause 11): buyers and holders pay no fee to the operator, only the Solana
 * network fees of their own transactions; issuers pay what their engagement
 * agreement provides; a fee for buyers or holders comes only with a new
 * version of the Terms. Nothing here promises a phase, a cohort or a date.
 */
export const metadata: Metadata = {
  title: "Pricing — Manci",
  description:
    "No fees for buyers and holders. Issuers pay what their engagement agreement provides; legal drafting, regulatory filings and other third-party costs are quoted per engagement before any work starts.",
};

const ENGAGEMENT: Array<{ title: string; body: string }> = [
  {
    title: "Structuring",
    body: "Legal and commercial structuring of the instrument, shaped to your deal.",
  },
  {
    title: "Entity setup",
    body: "Where the structure calls for a special purpose vehicle, its incorporation and administration for the issuance.",
  },
  {
    title: "Tokenisation",
    body: "Token design, on-chain issuance, and the compliance rails.",
  },
  {
    title: "Whitepaper",
    body: "Drafting and publication of the whitepaper or basic token information.",
  },
  {
    title: "Distribution",
    body: "How your tokens reach holders: a primary sale the operator approves, transfers from your treasury to wallets you choose, and trading through Manci where it is available.",
  },
];

export default function PricingPage() {
  return (
    <>
      <PageHeader
        eyebrow="Pricing"
        title="No fees for buyers and holders."
        lede="Buying, holding and transferring tokens on Manci costs only the Solana network fees of your own transactions. Issuers pay what their engagement agreement provides. A fee for buyers or holders would come only with a new version of the Terms, published before it applies."
      />

      <Section>
        <H2>What is not ours</H2>
        <Body className="mt-4">
          Legal drafting, regulatory filings and any entity an issuance needs
          are real third-party costs. They&rsquo;re quoted per engagement
          before any work starts. No platform fee is taken on-chain.
        </Body>
        <p className="mt-5">
          <TextLink href={MX_ROUTES.terms}>Fees in the Terms →</TextLink>
        </p>
      </Section>

      <Section>
        <H2 className="mb-6">What an engagement covers</H2>
        <Grid cols={3}>
          {ENGAGEMENT.map((e) => (
            <Card key={e.title} title={e.title} body={e.body} />
          ))}
        </Grid>
        <ButtonRow>
          <Button href={MX_ROUTES.apply}>Apply to issue</Button>
        </ButtonRow>
      </Section>
    </>
  );
}
