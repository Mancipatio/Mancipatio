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
    "Understand transfer checks, custody rules, the emergency pause and operational authorities in the Manci app, and how to report a vulnerability.",
};

// Describe supported controls without claiming local changes are already deployed.
const PILLARS: Array<{ title: string; body: string }> = [
  {
    title: "Compliance transfer hook",
    body: "The transfer hook checks the source token-account owner against the blocklist, including delegated transfers. KYC-gated classes also check the receiver’s passport. Destinations use immutable token-account ownership; narrow program-controlled recovery paths have their own checks.",
  },
  {
    title: "Primary sales follow the class's mode",
    body: "Buying an Open class in a primary sale needs no identity verification. A primary sale mints rather than transfers, and minting does not invoke the transfer hook — so on a KYC-gated class the program checks the buyer's passport itself, and refuses the purchase outright if the proof accounts are absent. The gate cannot be skipped by leaving them out.",
  },
  {
    title: "Verification at conversion and delivery",
    body: "Identity verification (KYC) is required when a token becomes something off-chain: converting it into shares of the company, or redeeming it for a physical good. The platform checks a live, verified client profile before it accepts either request. Commitments, OTC escrow requests and resell listings need no verification, but still refuse a client profile that compliance has suspended.",
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
    title: "Emergency pause",
    body: "Any Manci admin can pause one or more areas of platform-mediated activity: onboarding, primary sales, trading through Manci, custody entry, distributions and payouts to issuers. Only the Super Admin can resume them. A pause never blocks exits — cancels, expiries, refunds, claims and custody returns keep working — and the transfer hook does not read it, so holders can still move tokens between wallets under the usual transfer checks.",
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
        <H2>When verification is required</H2>
        <Body className="mt-4">
          Buying and trading tokens does not require identity verification:
          primary sales, OTC offers and resell listings of an Open class need
          none. Verification (KYC) is required when you convert tokens into
          shares of the company or take delivery of a physical good. The
          platform checks it before it accepts a conversion or delivery
          request; it is not an on-chain check. The platform can switch a
          class to KYC-gated, for example at the issuer&apos;s request; buying
          or receiving that class then requires an approved investor passport,
          because every transfer checks the receiving wallet.
        </Body>
      </Section>

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
        <H2>Reporting a vulnerability</H2>
        <Body className="mt-4">
          If you find a security issue in the Manci programs or app, email{" "}
          <a className="mx-link" href="mailto:security@mancipatio.io">
            security@mancipatio.io
          </a>
          . Describe the issue, the affected program, page or instruction, and
          the steps to reproduce it. Test only on devnet or with your own
          accounts and assets, never with other people&apos;s funds or data,
          and give us reasonable time to fix the issue before disclosing it.
        </Body>
        <Body className="mt-4">
          Both on-chain programs embed a security.txt with this contact, and
          the app publishes one at{" "}
          <a className="mx-link" href="/.well-known/security.txt">
            /.well-known/security.txt
          </a>
          .
        </Body>
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
