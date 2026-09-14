import type { Metadata } from "next";
import {
  Body,
  Button,
  ButtonRow,
  Eyebrow,
  Facts,
  H2,
  MX_ROUTES,
  MX_STAGE_LABEL,
  PageHeader,
  Section,
  TextLink,
} from "@/components/mx";

/**
 * "About" — prototype `#page-about`.
 *
 * The prototype's headline ("Three people, one thesis.") and its team section
 * are a brief, not content: they require three real names, roles and a line on
 * who wrote the legal framework. None of that exists in this repository, and
 * the prototype's own rule is that an unsupported claim renders as nothing —
 * so no headcount is asserted and no team block is stubbed. Everything below
 * is copy this site already carried, or a statement the prototype itself makes.
 *
 * The two pieces of the brief that *can* be honoured are here: one paragraph
 * on why the structure comes before the code, and one honest line on where the
 * platform actually is.
 */
export const metadata: Metadata = {
  title: "About — Mancipatio",
  description:
    "Why Mancipatio starts with the legal structure rather than the token, and where the platform actually is today.",
};

/** Short, checkable statements only — the dark band's whole value. */
const WHERE_THINGS_STAND = [
  `${MX_STAGE_LABEL} — nothing is issued live yet`,
  "Two on-chain programs, deployed on Solana devnet",
  "Both went through a systematic security review before deploy",
  "Asset registry, Token-2022 mints and program-owned custody",
  "Launchpad, OTC settlement, governance and vesting shipped",
  "Issuer applications are open and read by a person",
];

export default function AboutPage() {
  return (
    <>
      <PageHeader
        eyebrow="About"
        title="Ownership, transferred properly."
        lede="Mancipatio is tokenization infrastructure on Solana — built so that issuing, regulating and trading a real asset on-chain is as rigorous as doing it on paper, and far faster."
      />

      <Section>
        <H2>The name</H2>
        <Body className="mt-4">
          In Roman law, <em>mancipatio</em> was the formal ceremony that
          transferred ownership of the most valuable kinds of property — land,
          buildings, the things that mattered. It was deliberate, witnessed and
          final. We took the name because that is what tokenized ownership
          should be: a transfer that is precise, transparent and binding.
        </Body>

        <H2 className="mt-10">The mission</H2>
        <Body className="mt-4">
          Bring the whole lifecycle of asset ownership on-chain — not just the
          easy last mile. Issuance, compliance, custody, primary and secondary
          markets, governance and vesting, on one platform, enforced by code
          rather than entrusted to an operator.
        </Body>

        <H2 className="mt-10">Why the structure comes first</H2>
        <Body className="mt-4">
          Minting a token takes minutes. Making it mean something takes a legal
          structure a court will recognise: an issuer that is bound by the right
          the token carries, and a documented route to enforcement if it
          doesn&apos;t perform. We design that structure first and let the
          programs enforce what it already says.
        </Body>
        <Body className="mt-3.5">
          That is also why compliance isn&apos;t bolted on afterwards. It is
          wired into the mint itself, custody is owned by the program rather
          than by a wallet, and every authority is role-gated.
        </Body>
        <p className="mt-5">
          <TextLink href={MX_ROUTES.security}>
            How compliance is enforced →
          </TextLink>
        </p>
      </Section>

      <Section variant="dark">
        <Eyebrow>The honest line</Eyebrow>
        <H2 className="mb-7">Where things stand</H2>
        <Facts items={WHERE_THINGS_STAND} />
      </Section>

      <Section>
        <H2>Two ways in.</H2>
        <Body className="mt-4">
          Issuers apply and a person reads every application. Investors can join
          the list and we&apos;ll notify them when the first offering opens.
        </Body>
        <ButtonRow>
          <Button href={MX_ROUTES.apply}>Apply to issue</Button>
          <Button href={MX_ROUTES.instruments} variant="ghost">
            See the eight instruments
          </Button>
        </ButtonRow>
      </Section>
    </>
  );
}
