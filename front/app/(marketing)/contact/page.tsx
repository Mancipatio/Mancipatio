import {
  Button,
  ButtonRow,
  Card,
  Grid,
  H2,
  MX_ROUTES,
  PageHeader,
  Section,
} from "@/components/mx";
import { ContactForm } from "./contact-form";

export const metadata = {
  title: "Contact · Custom tokenization · Mancipatio",
  description:
    "Have an idea that needs tokenization infrastructure? Tell us about it — we evaluate the idea, propose a solution and design a dedicated process together.",
};

const PROCESS: Array<{ step: string; label: string; body: string }> = [
  {
    step: "01",
    label: "You reach out",
    body: "Tell us what you want to tokenize — rights, services, platform utility, or one of the main categories.",
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
            Browse the main categories
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
    </>
  );
}
