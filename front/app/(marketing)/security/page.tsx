import type { Metadata } from "next";
import {
  Body,
  Card,
  FootNote,
  Grid,
  H2,
  PageHeader,
  Section,
} from "@/components/mx";

export const metadata: Metadata = {
  title: "Security & compliance — Manci",
  description:
    "Understand transfer checks, custody rules and operational authorities in the Manci app.",
};

// Describe supported controls without claiming local changes are already deployed.
const PILLARS: Array<{ title: string; body: string }> = [
  {
    title: "Compliance transfer hook",
    body: "The transfer hook checks the source token-account owner against the blocklist, including delegated transfers. KYC-gated classes also check the receiver’s passport. Destinations use immutable token-account ownership; narrow program-controlled recovery paths have their own checks.",
  },
  {
    title: "Issuance is gated too",
    body: "A primary sale mints rather than transfers, and minting does not invoke the transfer hook — so on a KYC-gated class the program checks the buyer's passport itself, and refuses the purchase outright if the proof accounts are absent. The gate cannot be skipped by leaving them out.",
  },
  {
    title: "Permanent delegate",
    body: "Each share-class mint carries a Token-2022 permanent delegate — the share class's own program address, not a person. One instruction uses it: an admin clawback of a revoked or expired holder on a KYC-gated class. The seized units can only land in a quarantine vault whose every exit burns them, and the instruction refuses to target the platform's own escrows.",
  },
  {
    title: "Program-mediated custody",
    body: "Primary sales, OTC deals, conversions, deliveries and redemptions move through escrow accounts owned by program-derived addresses. Movements require the program’s authorized instructions and their checks.",
  },
  {
    title: "Role-gated authority",
    body: "Privileged actions check current on-chain authority. Issuer Mint, Metadata and Conversion permissions can be scoped to one issuer; the blocklist has a separate authority. Platform and blocklist replacement require the new wallet to accept. Program upgrade authority is separate.",
  },
];

const PROGRAMS: Array<{ name: string; id: string; note: string }> = [
  {
    name: "asset_registry",
    id: "FJs1EM1ND89L9sUXaS8VBKYXjmoXCkkVSJKRE19hmYxS",
    note: "Registry, Token-2022 mints, custody, launchpad, OTC, governance and rights tokens.",
  },
  {
    name: "transfer_hook",
    id: "GBDyesyTr266LqKeFq95r1DeigRyHpfw6ACWdjENHAPy",
    note: "The Token-2022 transfer hook — the sanctions blocklist, and receiver eligibility on KYC-gated classes.",
  },
];

export default function SecurityPage() {
  return (
    <>
      <PageHeader
        eyebrow="Security & compliance"
        title="Compliance enforced by the chain."
        lede="Understand the controls used by the app and confirm the selected network and release before testing privileged actions."
      />

      <Section>
        <H2>Transfer checks depend on the class</H2>
        <Body className="mt-4">
          Open-mode classes apply the source-owner blocklist. KYC-gated classes
          also require the receiving wallet’s approved, unexpired passport and
          permitted jurisdiction. Initial purchases and supported settlement
          flows check their own eligibility because minting and escrow delivery
          have additional rules.
        </Body>
        <Body className="mt-4">
          A verified program escrow can receive units under its defined route.
          Exiting an escrow does not grant a general identity exemption:
          recipient checks still apply, with narrow returns of recorded deposits
          handled by the program. Attaching a legacy escrow identity does not
          invent past funding or make gifted surplus exempt.
        </Body>
      </Section>

      <Section>
        <H2 className="mb-6">Platform controls</H2>
        <Grid cols={2}>
          {PILLARS.map((p) => (
            <Card key={p.title} title={p.title} body={p.body} />
          ))}
        </Grid>
      </Section>

      <Section>
        <H2 className="mb-6">Testing and release status</H2>
        <Card
          className="max-w-[760px]"
          title="Verify the release being tested"
          body="Local code review and passing tests do not prove that the same program version is deployed. A pilot requires matching program, app and database versions, configured authorities and a verified network. Use test assets until that release has been checked."
        />
        <p className="mt-4">
          <a className="mx-link" href="/docs/pilot">
            Pilot operator guide →
          </a>
        </p>
      </Section>

      <Section>
        <H2 className="mb-6">On-chain programs</H2>
        <Grid cols={2}>
          {PROGRAMS.map((p) => (
            <Card
              key={p.name}
              title={<span className="font-mono">{p.name}</span>}
            >
              <p className="mt-1 font-mono text-[12px] leading-relaxed break-all text-mx-ink-faint">
                {p.id}
              </p>
              <p className="mt-2">{p.note}</p>
            </Card>
          ))}
        </Grid>
        <FootNote className="mt-4">
          These are the configured program identifiers. Confirm the selected
          cluster and deployed release; an address alone does not identify its
          code version.
        </FootNote>
      </Section>
    </>
  );
}
