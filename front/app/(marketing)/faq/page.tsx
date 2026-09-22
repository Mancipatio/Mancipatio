import {
  Card,
  Grid,
  MX_ROUTES,
  PageHeader,
  Section,
  TextLink,
} from "@/components/mx";

export const metadata = {
  title: "Quick answers — Manci",
  description:
    "Find the right guide for buying, verification, token documents, vesting and issuing on Manci.",
};

const QUESTIONS = [
  {
    question: "Where should I start as a buyer?",
    answer:
      "Start with the investor guide for the route from finding an asset to reviewing it and opening your portfolio.",
    href: MX_ROUTES.invest,
    link: "Investor guide",
  },
  {
    question: "What does a particular token give me?",
    answer:
      "Read the documents attached to that issuance. The instrument comparison explains the categories; an issuance's own documents describe its specific terms.",
    href: MX_ROUTES.whitepapers,
    link: "Find token documents",
  },
  {
    question: "Do I need to verify my identity to buy tokens?",
    answer:
      "No. Buying and trading tokens does not require identity verification. Verification (KYC) is required when you convert tokens into company shares or take delivery of a physical good. Some classes are KYC-gated by the issuer or the platform; buying or receiving those requires an approved investor passport.",
    href: MX_ROUTES.security,
    link: "Verification and transfer rules",
  },
  {
    question: "Where can I sell tokens I already hold?",
    answer:
      "The OTC guide explains creating, funding and filling an offer, with a direct link to the trading screen.",
    href: "/solutions/otc",
    link: "OTC trading guide",
  },
  {
    question: "Where do I check my vesting?",
    answer:
      "Open Vesting in your portfolio to review your positions, unlock schedule and available claims.",
    href: "/portfolio/vesting",
    link: "Open my vesting",
  },
  {
    question:
      "My wallet submitted a transaction but the app still shows pending. What now?",
    answer:
      "Keep the receipt and use the available retry-record action. First verify the existing purchase, deposit or sale address; do not send the same funds again just to update the app record.",
    href: "/docs/pilot",
    link: "Recovery and testing guide",
  },
  {
    question: "Where are the risks and legal terms explained?",
    answer:
      "Read the risk disclosure before deciding to participate, alongside the documents for the selected issuance.",
    href: MX_ROUTES.risks,
    link: "Risk disclosure",
  },
  {
    question: "How do I submit an asset for issuance?",
    answer:
      "The issuance guide covers the shared process and directs you to the application.",
    href: MX_ROUTES.howItWorks,
    link: "Issuance guide",
  },
  {
    question: "I need help with a specific case. Where do I go?",
    answer:
      "Use the contact form for questions about your project or a step in the app.",
    href: MX_ROUTES.contact,
    link: "Contact the team",
  },
];

export default function FaqPage() {
  return (
    <>
      <PageHeader
        eyebrow="Help"
        title="Quick answers"
        lede="Find the relevant guide or open the part of the app you need."
      />
      <Section>
        <Grid cols={2}>
          {QUESTIONS.map((item) => (
            <Card key={item.question} title={item.question} body={item.answer}>
              <p className="mt-4">
                <TextLink href={item.href}>{item.link} →</TextLink>
              </p>
            </Card>
          ))}
        </Grid>
      </Section>
    </>
  );
}
