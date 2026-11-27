import type { Metadata } from "next";
import {
  Body,
  Bullets,
  Button,
  ButtonRow,
  Card,
  Facts,
  Grid,
  H2,
  MX_NETWORK_STAGE_LABEL,
  MX_ROUTES,
  PageHeader,
  Section,
  TextLink,
} from "@/components/mx";
import { detectNetwork, isTestNetwork } from "@/lib/network";
import { KYC_ONLY_MESSAGE, scopeEnabled } from "@/lib/features";
import { modulesFact } from "@/lib/module-facts";
import { MANCI_CASE_STUDY_URL } from "@/lib/manci-token";
import { securityReviewFact } from "@/lib/legal/audit";
import { SecurityAuditReportLink } from "@/components/legal/security-review";
import {
  hasOperatorEntity,
  operatorFor,
  type Operator,
} from "@/lib/legal/operator";

const INTRO = "Manci is tokenization infrastructure on Solana, built in-house end to end. It turns equity in real companies into tokens, and tokens back into registered ownership.";

export const metadata: Metadata = {
  title: "About — Manci",
  description: INTRO,
};

/** Who holds which role at Manci and what each brings, as the company states it. */
const TEAM = [
  {
    name: "Mladen Rakić",
    role: "CEO and CTO",
    bio: "Founded and exited two companies, in betting and in data and video distribution. Designed and built both Solana programs and the full platform.",
  },
  {
    name: "Vladimir Rajković",
    role: "Chief Legal Officer",
    bio: "Attorney-at-law and legal advisor to Superteam Balkan. Focused on digital assets and cross-border structuring. Co-designed Manci's legal model, from token issuance to registered ownership.",
  },
  {
    name: "Miloš Pavlović",
    role: "COO",
    bio: "Angel investor in crypto. Based in New York: operations, partnerships and the issuer pipeline.",
  },
];

const NETWORK = detectNetwork();
const OPERATOR = operatorFor(NETWORK);
/** KYC-only mode (lib/features.ts): issuer applications are paused (modulesFact
 *  says so), and the page's way in is identity verification. */
const ISSUANCE_OPEN = scopeEnabled("issuance", NETWORK);

/** Who operates this network: the registered entity and its licence, or the
 *  pilot's plain statement that there is none yet (lib/legal/operator.ts). */
function operatorFacts(operator: Operator): string[] {
  if (!hasOperatorEntity(operator)) {
    return ["Pilot stage: no operating company designated yet"];
  }
  const name = operator.legalName?.trim().replace(/Ltd\.$/, "Ltd");
  const country = operator.registeredOffice?.endsWith("British Virgin Islands") ? " (BVI)" : "";
  const facts = [`Operated by ${name}${country}`];
  if (operator.licence) {
    facts.push(
      `Licence: ${operator.licence.authority}, decision ${operator.licence.decisionNumber}`,
    );
  }
  return facts;
}

/** Short, checkable statements only — the dark band's whole value. The stage
 *  lines follow the build's network (NEXT_PUBLIC_NETWORK); the security line
 *  follows lib/legal/audit.ts (no external audit is claimed before one exists);
 *  the modules line follows the module switches (modulesFact). */
const WHERE_THINGS_STAND = [
  isTestNetwork(NETWORK)
    ? `${MX_NETWORK_STAGE_LABEL} — nothing is issued live yet`
    : MX_NETWORK_STAGE_LABEL,
  ...operatorFacts(OPERATOR),
  "First conversion completed: a MANCI token holder became a registered member of Mancipatio d.o.o. Beograd, recorded by Serbian Business Registers Agency on 9 October 2026",
  `Two smart contracts deployed on Solana ${NETWORK}`,
  securityReviewFact(),
  "Asset registry, Token-2022 mints and program-owned custody",
  modulesFact(NETWORK),
  ...(ISSUANCE_OPEN ? ["Issuer applications are open and read by a person"] : []),
];

export default function AboutPage() {
  return (
    <>
      <PageHeader
        eyebrow="About"
        title="Ownership, transferred properly."
        lede={INTRO}
      />

      <Section>
        <H2>The name</H2>
        <Body className="mt-4">
          Manci is short for <em>mancipatio</em>, the formal ceremony in ancient Rome that
          was used to transfer ownership of the most valuable property: land, buildings, cows,
          the things that actually mattered at the time. It was deliberate and final.
          That is what tokenized ownership should be.
        </Body>

        <H2 className="mt-10">The mission</H2>
        <Body className="mt-4">
          Give anyone with a wallet a real path to owning part of a company, and give
          companies a new way to raise from the people who believe in them.
        </Body>

        <H2 className="mt-10">Why the structure comes first</H2>
        <Body className="mt-4">
          Minting a token takes minutes. Making it mean something takes a legal structure
          that real courts recognise: a token issuer bound by the right the token carries
          and a public register at the end. We build the legal structure
          first, then the technology around it.
        </Body>
        <Body className="mt-3.5">
          Compliance is wired into the mint itself, custody is held by the program rather
          than a wallet, and every authority is role-gated.{" "}
          <TextLink href={MX_ROUTES.security}>How compliance is enforced</TextLink>
        </Body>
      </Section>

      <Section>
        <H2>Built as infrastructure</H2>
        <Body className="mt-4">
          Manci isn&apos;t a front end on someone else&apos;s protocol. We made our own
          Solana infrastructure, and the whole platform runs on them:
        </Body>
        <Bullets className="mt-4" items={[
          "On-chain smart contracts",
          "Token-2022 issuance with compliance built in",
          "Program-owned custody and smart-contract escrow",
          "Primary sales and peer-to-peer settlement",
          "Token holder governance and asset lifecycle tools",
          "A legal framework that connects on-chain tokens to registered ownership",
        ]} />
        <Body className="mt-4">
          The architecture is built to support more asset classes. Company ownership is the first one live.
        </Body>
      </Section>

      <Section id="team">
        <H2>The team</H2>
        <Grid cols={3} className="mt-5">
          {TEAM.map((person) => (
            <Card
              key={person.name}
              title={<>{person.name}<span className="font-normal">, {person.role}.</span></>}
              body={person.bio}
            />
          ))}
        </Grid>
      </Section>

      <Section variant="dark">
        <H2 className="mb-7">Where things stand</H2>
        <Facts items={WHERE_THINGS_STAND} />
        <SecurityAuditReportLink className="mt-7" />
        <p className="mt-7 flex flex-wrap gap-x-5 gap-y-2">
          <TextLink href={MANCI_CASE_STUDY_URL}>See the MANCI case study</TextLink>
          <TextLink href={MX_ROUTES.company}>Company details</TextLink>
        </p>
        {ISSUANCE_OPEN && (
          <ButtonRow>
            <Button href={MX_ROUTES.apply}>Apply to issue</Button>
            <Button href={MX_ROUTES.instruments} variant="ghost">See the asset types</Button>
          </ButtonRow>
        )}
      </Section>
      {/* KYC-only mode: sign-up and identity verification are the way in. */}
      {!ISSUANCE_OPEN && (
        <Section>
          <H2>Sign up and get verified.</H2>
          <Body className="mt-4">{KYC_ONLY_MESSAGE}</Body>
          <ButtonRow>
            <Button href="/verify">Get verified</Button>
            <Button href={MX_ROUTES.instruments} variant="ghost">
              See the asset types
            </Button>
          </ButtonRow>
        </Section>
      )}
    </>
  );
}
