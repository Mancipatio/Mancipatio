import type { Metadata } from "next";
import {
  Body,
  Bullets,
  Button,
  ButtonRow,
  Card,
  Eyebrow,
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
import { securityReviewFact } from "@/lib/legal/audit";
import { SecurityAuditReportLink } from "@/components/legal/security-review";
import {
  hasOperatorEntity,
  operatorFor,
  type Operator,
} from "@/lib/legal/operator";

/**
 * "About" — prototype `#page-about`.
 *
 * The prototype's headline ("Three people, one thesis.") and its team section
 * were a brief, not content: they needed real names and roles, and the
 * prototype's own rule is that an unsupported claim renders as nothing. The
 * team below is the company's own statement (2026-11-24): who holds which
 * role, and each person's lines as the company gave them, word for word.
 * Manci is operated by the entity lib/legal/operator.ts names. Everything else
 * is copy this site already carried, or a statement the prototype itself makes.
 *
 * The two pieces of the brief that *can* be honoured are here: one paragraph
 * on why the structure comes before the code, and one honest line on where the
 * platform actually is.
 */
export const metadata: Metadata = {
  title: "About — Manci",
  description:
    "Why Manci starts with the legal structure rather than the token, and where the platform actually is today.",
};

/** Who holds which role at Manci and what each brings, as the company states it. */
const TEAM = [
  {
    name: "Mladen Rakić",
    role: "CEO and CTO",
    lines: [
      "Founded and exited two companies: betting and data/video distribution",
      "Designed and built both Solana programs and the full platform",
    ],
  },
  {
    name: "Vladimir Rajković",
    role: "Chief Legal Officer",
    lines: [
      "Lawyer; legal advisor to Superteam Balkan",
      "Legal structuring, white papers and the regulatory path",
    ],
  },
  {
    name: "Miloš Pavlović",
    role: "COO",
    lines: [
      "Angel investor in crypto",
      "Based in New York: operations, partnerships and the issuer pipeline",
    ],
  },
  {
    name: "Dušan Romčević",
    role: "Co-founder",
    lines: [
      "Ex-securities regulator; drafted Serbia's Digital Assets Act",
      "Based in London: Head of Legal at an FCA-authorised EMI",
      "Legal lead in the UK, Italy, Panama, El Salvador and Mauritius",
    ],
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
  const facts = [`Operated by ${operator.legalName?.trim()}`];
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
  `Two on-chain programs, deployed on Solana ${NETWORK}`,
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
        lede="Manci is tokenization infrastructure on Solana — built so that issuing, regulating and trading a real asset on-chain is as rigorous as doing it on paper, and far faster."
      />

      <Section>
        <H2>The name</H2>
        <Body className="mt-4">
          Manci is short for <em>mancipatio</em>, the formal ceremony in Roman
          law that transferred ownership of the most valuable kinds of property —
          land, buildings, the things that mattered. It was deliberate,
          witnessed and final. We took the name because that is what tokenized
          ownership should be: a transfer that is precise, transparent and
          binding.
        </Body>

        <H2 className="mt-10">The mission</H2>
        <Body className="mt-4">
          Bring asset issuance, verification, document review and ownership
          records into one workspace. Each available service follows the
          approved terms of the issuance.
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

      <Section id="team">
        <H2>The team</H2>
        <Grid cols={2} className="mt-5">
          {TEAM.map((person) => (
            <Card key={person.name} title={person.name} body={person.role}>
              <Bullets className="mt-3" items={person.lines} />
            </Card>
          ))}
        </Grid>
      </Section>

      <Section variant="dark">
        <Eyebrow>The honest line</Eyebrow>
        <H2 className="mb-7">Where things stand</H2>
        <Facts items={WHERE_THINGS_STAND} />
        <SecurityAuditReportLink className="mt-7" />
        <p className="mt-7">
          <TextLink href={MX_ROUTES.company}>Company and licence →</TextLink>
        </p>
      </Section>

      {ISSUANCE_OPEN && (
      <Section>
        <H2>Two ways in.</H2>
        <Body className="mt-4">
          Issuers apply and a person reads every application. Investors can join
          the list and we&apos;ll notify them when the first offering opens.
        </Body>
        <ButtonRow>
          <Button href={MX_ROUTES.apply}>Apply to issue</Button>
          <Button href={MX_ROUTES.instruments} variant="ghost">
            See the asset types
          </Button>
        </ButtonRow>
      </Section>
      )}
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
