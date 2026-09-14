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
} from "@/components/mx";

export const metadata: Metadata = {
  title: "Pricing — Mancipatio",
  description:
    "No platform fees during the launch phase. SPV incorporation, legal drafting and regulatory filings are third-party costs, quoted per engagement before any work starts.",
};

const ENGAGEMENT: Array<{ title: string; body: string }> = [
  {
    title: "Structuring",
    body: "Legal and commercial structuring of the instrument, shaped to your deal.",
  },
  {
    title: "SPV incorporation",
    body: "Where Serbian law requires one, incorporated and administered for the issuance.",
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
    title: "Distribution rails",
    body: "The venues your token trades through, including OTC escrow.",
  },
];

export default function PricingPage() {
  return (
    <>
      <PageHeader
        eyebrow="Pricing"
        title="No platform fees during the launch phase."
        lede="We're not charging issuers or holders while we onboard our first cohort. When we introduce platform fees, existing issuers will be told before anything changes."
      />

      <Section>
        <H2>What is not ours</H2>
        <Body className="mt-4">
          SPV incorporation, legal drafting and regulatory filings are real
          third-party costs. They&rsquo;re quoted per engagement before any work
          starts. Nothing is charged on-chain.
        </Body>
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
