import { Button, ButtonRow, Card, Grid, H2, PageHeader, Section, TextLink } from "@/components/mx";
import { MANCI_CASE_STUDY_URL } from "@/lib/manci-token";
import { navHrefVisible } from "@/lib/pilot-scope";

export const metadata = {
  title: "Quick answers — Manci",
  description: "Short answers to what people ask most. Each one links to the full explanation.",
};

type Question = {
  question: string;
  answer: string;
  link?: { label: string; href: string };
  guide?: string;
};

const GROUPS: { title: string; questions: Question[]; availableAt?: string }[] = [
  {
    title: "Manci and the structure",
    questions: [
      {
        question: "Is Manci an offshore structure?",
        answer: "The platform is operated by Manci International Ltd (BVI). The equity behind the tokens sits in Serbian companies, recorded in Serbian public registers. When you convert, your ownership is recorded in the Serbian register, not with the operator.",
        link: { label: "Legal structure", href: "/legal-structure" },
      },
      {
        question: "What does a token give me?",
        answer: "A right to convert into equity in a Serbian company. Some issuances add payouts while you hold. The exact terms are in each issuance's documents.",
        link: { label: "Asset types", href: "/markets/types" },
      },
      {
        question: "Is a token the same as equity?",
        answer: "No. The token gives you the right to convert. You become a member of the company when the BRA (a government agency) records the transfer.",
        link: { label: "Company ownership", href: "/markets/types/equity" },
      },
      {
        question: "Who is legally responsible for my token rights?",
        answer: "The token issuer is bound by the issuance documents. Manci provides the infrastructure, while the issuer is responsible for fulfilling its obligations.",
        link: { label: "Legal structure", href: "/legal-structure" },
      },
      {
        question: "How do I check a company before I buy?",
        answer: "Look it up in the BRA register using the registration number in the issuance documents, and check the token on Solana.",
        link: { label: "See the MANCI case study", href: MANCI_CASE_STUDY_URL },
      },
    ],
  },
  {
    title: "Buying and holding",
    questions: [
      {
        question: "Do I need KYC to buy?",
        guide: "/solutions/compliance",
        answer: "Not unless the issuance requires it. You verify your identity when you convert.",
      },
      {
        question: "Can I invest if I live outside Serbia?",
        guide: "/solutions/compliance",
        answer: "Yes, provided your jurisdiction and the terms of the issuance allow it. You don't need to be a Serbian citizen to own equity in a Serbian d.o.o. (LLC).",
      },
      {
        question: "Can I sell my tokens?",
        answer: "Yes, subject to the issuance's transfer rules. Transfer them or trade them peer to peer on DeFi OTC. There is no guaranteed buyer or price.",
        link: { label: "OTC trading", href: "/solutions/otc" },
      },
      {
        question: "Do I get voting rights or dividends?",
        guide: "/markets/types/equity",
        answer: "Once you convert, you vote as a member, and the company decides on profit distribution. Before that, you get payouts only as per the issuance documents.",
      },
      {
        question: "What if the founders refuse to transfer the equity?",
        answer: "Where a lien has been registered, it can be enforced under the issuance documents. Please note that the enforcement can be lengthy and may not cover your full investment.",
        link: { label: "Risk disclosure", href: "/risks" },
      },
      {
        question: "What if the company fails?",
        answer: "The token can lose all its value. Where a registered lien secures conversion, it protects you if the issuer refuses to convert, not if the business fails.",
        link: { label: "Risk disclosure", href: "/risks" },
      },
      {
        question: "What if Manci stops operating?",
        answer: "After conversion, your ownership is recorded in the government register and doesn't depend on Manci. Before conversion, your rights are set in the issuance documents, but trading, escrow and conversion process through the platform may be affected.",
        link: { label: "Risk disclosure", href: "/risks" },
      },
      {
        question: "Does Manci guarantee my investment?",
        answer: "No. Manci verifies issuers, but verification is not an endorsement of the business or a guarantee of returns.",
        link: { label: "Risk disclosure", href: "/risks" },
      },
    ],
  },
  {
    title: "Converting",
    availableAt: "/portfolio/conversion",
    questions: [
      {
        question: "How does conversion work?",
        answer: "Request it on the platform, pass KYC, and send your tokens into the escrow. You and the token issuer sign the transfer, BRA registers it, and the tokens are burned.",
        link: { label: "Company ownership", href: "/markets/types/equity" },
      },
      {
        question: "How long does it take?",
        guide: "/markets/types/equity",
        answer: "BRA makes decisions within five working days of a proper filing.",
      },
    ],
  },
  {
    title: "For issuers",
    questions: [
      {
        question: "Can a company outside Serbia issue?",
        answer: "Yes, through a Serbian SPV.",
        link: { label: "Issuing through a Serbian SPV", href: "/solutions/serbian-spv" },
      },
      {
        question: "Do I have to use your lawyers?",
        guide: "/legal-structure",
        answer: "No. Our partners in Serbia can set everything up, or you can choose your own lawyer.",
      },
      {
        question: "What does it cost?",
        answer: "Fees and costs are quoted individually for each issuance, before any work begins.",
        link: { label: "Fees & costs", href: "/pricing" },
      },
      {
        question: "How do I apply?",
        answer: "Verify your account and submit an application. A real person reviews every application, and if our model isn't right for your project, we will tell you.",
        link: { label: "Apply to issue", href: "/apply" },
      },
    ],
  },
  {
    title: "Technical",
    questions: [
      {
        question: "Which blockchain and token standard?",
        guide: "/solutions/share-classes",
        answer: "Solana, with Token-2022 mints.",
      },
      {
        question: "Has the code been audited?",
        guide: "/security",
        answer: "Not yet. Manci's smart contracts have had internal security reviews only.",
      },
      {
        question: "My transaction went through but the app still shows pending. What now?",
        answer: "Keep the receipt and use the retry-record action. Check the purchase, deposit or sale first, and don't send the same funds again.",
        link: { label: "Pilot operator guide", href: "/docs/pilot" },
      },
    ],
  },
];

export default function FaqPage() {
  return (
    <>
      <PageHeader eyebrow="Help" title="Quick answers" lede={metadata.description} />
      {GROUPS.filter((group) => !group.availableAt || navHrefVisible(group.availableAt)).map((group) => (
        <Section key={group.title}>
          <H2 className="mb-6">{group.title}</H2>
          <Grid cols={2}>
            {group.questions.filter(({ link }) => !link || navHrefVisible(link.href)).map((item) => (
              <Card key={item.question} title={item.question} body={item.answer} href={item.guide && navHrefVisible(item.guide) ? item.guide : undefined}>
                {item.link && (
                  <p className="mt-4"><TextLink href={item.link.href}>{item.link.label}</TextLink></p>
                )}
              </Card>
            ))}
          </Grid>
        </Section>
      ))}
      <Section>
        <H2>Still have a question?</H2>
        <ButtonRow><Button href="/contact">Contact the team</Button></ButtonRow>
      </Section>
    </>
  );
}
