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
import { OperatorContactDetails } from "@/components/legal/operator-details";
import { operatorFor, operatorSentence } from "@/lib/legal/operator";
import { detectNetwork } from "@/lib/network";
import { ContactForm } from "./contact-form";

/** This build's operator (lib/legal/operator.ts). */
const OPERATOR = operatorFor(detectNetwork());

export const metadata = {
  title: "Contact & support · Manci",
  description:
    "Contact the team about an equity issuance, verification or a step in the app.",
};

const PROCESS: Array<{ step: string; label: string; body: string }> = [
  {
    step: "01",
    label: "You reach out",
    body: "Tell us about your equity issuance or the step in the app where you need help.",
  },
  {
    step: "02",
    label: "We evaluate & propose",
    body: "Our team evaluates the business idea and comes back with a proposed solution — technical and legal.",
  },
  {
    step: "03",
    label: "We build the process together",
    body: "If we agree, we create a dedicated process for your project, with the legal team making the token rights binding on the issuer.",
  },
];

export default function ContactPage() {
  return (
    <>
      <PageHeader
        eyebrow="Support"
        title="Contact & support"
        lede="Describe the asset you want to tokenize or ask about a step in the app."
      >
        <ButtonRow>
          <Button href={MX_ROUTES.instruments} variant="ghost">
            Review available asset types
          </Button>
        </ButtonRow>
      </PageHeader>

      <Section>
        <H2>Send an inquiry</H2>
        <div className="mt-6">
          <ContactForm />
        </div>
      </Section>

      <Section>
        <H2>What happens next</H2>
        <Grid cols={3} className="mt-6">
          {PROCESS.map((item) => (
            <Card
              key={item.step}
              title={`${item.step} · ${item.label}`}
              body={item.body}
            />
          ))}
        </Grid>
      </Section>

      <Section>
        <H2>Company and legal contacts</H2>
        {operatorSentence(OPERATOR) && (
          <Body className="mt-4">{operatorSentence(OPERATOR)}</Body>
        )}
        <div className="mt-6">
          <OperatorContactDetails operator={OPERATOR} />
        </div>
        <p className="mt-6">
          <TextLink href={MX_ROUTES.company}>Company and licence →</TextLink>
        </p>
      </Section>
    </>
  );
}
