import type { Metadata } from "next";
import { Body, Bullets, Button, ButtonRow, H2, MX_ROUTES, PageHeader, Section, TextLink } from "@/components/mx";
import { MANCI_CASE_STUDY_URL } from "@/lib/manci-token";

export const metadata: Metadata = {
  title: "Legal structure — Manci",
  description: "Minting a token on any blockchain takes minutes. Making it mean something takes a legal structure that real courts recognise. Ours runs under Serbian law, in an EU candidate country.",
};

export default function LegalStructurePage() {
  return (
    <>
      <PageHeader
        eyebrow="The structure"
        title="The token is the easy part."
        lede="Minting a token on any blockchain takes minutes. Making it mean something takes a legal structure that real courts recognise. Ours runs under Serbian law, in an EU candidate country."
      />

      <Section>
        <H2>Two ways to issue equity</H2>
        <Bullets className="mt-4">
          <li>
            <strong>A Serbian company</strong> issues directly. Its owners tokenize part of their own equity.
          </li>
          <li>
            <strong>A company outside Serbia, or founders without a company,</strong> issue through a Serbian SPV. Manci can arrange it through its partners in the Republic of Serbia, or
            you can bring one your own lawyer has set up. The same model then runs on the SPV&apos;s equity.{" "}
            <TextLink href="/solutions/serbian-spv">How the SPV works</TextLink>
          </li>
        </Bullets>
      </Section>

      <Section>
        <H2>Why Serbia</H2>
        <Bullets className="mt-4">
          <li><strong>Europe, onshore.</strong> Serbia is an EU candidate country, not a secrecy jurisdiction.</li>
          <li>
            <strong>Civil law.</strong> Written statutes, notarized contracts and public state registers, not trust in a registered agent.
          </li>
          <li>
            <strong>A dedicated digital assets law.</strong> Serbia has had a dedicated legal framework for digital assets since 2021. It explicitly allows this
            kind of issuance.
          </li>
          <li>
            <strong>Everything on public record.</strong> Company owners and liens are in government registers anyone can search online.
          </li>
        </Bullets>
      </Section>

      <Section>
        <H2>The right and the register</H2>
        <ol className="mx-body mt-4 list-decimal space-y-3 pl-6">
          <li>
            <strong>The right.</strong> Every token carries the right to convert into equity, set out in the issuance documents and binding
            on the token issuer.
          </li>
          <li>
            <strong>The register.</strong> When you convert, a government agency records you as a shareholder and the tokens are burned.
          </li>
        </ol>
      </Section>

      <Section>
        <H2>Already put into practice</H2>
        <Body className="mt-4">
          This structure has already run in a live issuance on Solana mainnet. Tokens were sold, equity was liened, and a token holder became a registered member of a Serbian company. <TextLink href={MANCI_CASE_STUDY_URL}>See the MANCI token</TextLink> and verify the records yourself.
        </Body>
      </Section>

      <Section>
        <H2>Why you don&apos;t have to just trust us</H2>
        <Body className="mt-4">
          Company ownership, registered liens and changes in ownership are recorded in government agency’s public
          records. Token supply, transfers and burns are recorded on Solana. Check both before you buy.
        </Body>
      </Section>

      <Section>
        <H2>Where Manci fits in</H2>
        <Body className="mt-4">
          Manci brings the technology and the legal structure together. The token issuer makes the commitments, and
          your rights are defined in the issuance documents. Once you convert, your ownership is recorded in a
          government register, not just on a platform, and it does not depend on Manci continuing to operate.
        </Body>
      </Section>

      <Section>
        <H2>Built per issuance</H2>
        <Body className="mt-4">
          Every issuance has its own documents: what the token gives you, who is bound, how conversion works and any
          payouts. They are published with the token. Different assets need different legal structures, so the rights
          and protections depend on the instrument.
        </Body>
      </Section>

      <Section>
        <H2>Raising?</H2>
        <Body className="mt-4">
          We can arrange the whole structure with you and our partners in Serbia, from incorporation to the conversion
          mechanics. Already have a company and your own lawyer? Come as you are.
        </Body>
        <ButtonRow>
          <Button href={MX_ROUTES.apply}>Apply to issue</Button>
          <Button href={MX_ROUTES.contact} variant="ghost">Ask a question first</Button>
        </ButtonRow>
      </Section>
    </>
  );
}
