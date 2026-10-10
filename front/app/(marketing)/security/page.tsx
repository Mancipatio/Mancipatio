import type { Metadata } from "next";
import {
  Body,
  Bullets,
  Card,
  FootNote,
  Grid,
  H2,
  PageHeader,
  Section,
} from "@/components/mx";
import { operatorFor } from "@/lib/legal/operator";
import { detectNetwork } from "@/lib/network";

/** The operator's security contact (lib/legal/operator.ts). It must match the
 *  programs' embedded security.txt and public/.well-known/security.txt. */
const SECURITY_CONTACT = operatorFor(detectNetwork()).contacts.security;

export const metadata: Metadata = {
  title: "Security & compliance — Manci",
  description:
    "Understand transfer checks, custody rules, the emergency pause and operational authorities in the Manci app, and how to report a vulnerability.",
};

// Describe supported controls without claiming local changes are already deployed.
const PILLARS: Array<{ title: string; body: string }> = [
  {
    title: "Compliance transfer hook",
    body: "The transfer hook checks the source token-account owner against the blocklist, including delegated transfers. A blocklisted wallet cannot send tokens; the only exception is an admin clawback into a burn-only quarantine vault. KYC-gated classes also check the receiver’s passport. Destinations use immutable token-account ownership; narrow program-controlled recovery paths have their own checks.",
  },
  {
    title: "Primary sales follow the class's mode",
    body: "Buying an Open class in a primary sale needs no identity verification. A primary sale mints rather than transfers, and minting does not invoke the transfer hook — so on a KYC-gated class the program checks the buyer's passport itself, and refuses the purchase outright if the proof accounts are absent. The gate cannot be skipped by leaving them out.",
  },
  {
    title: "Verification at conversion and delivery",
    body: "Identity verification (KYC) is required when a token becomes something off-chain: converting it into shares of the company, or redeeming it for a physical good. The platform checks a live, verified client profile before it accepts either request, and the program checks the holder's investor passport again on-chain before the delivery escrow is realized. Commitments, OTC escrow requests and resell listings need no verification, but still refuse a client profile that compliance has suspended.",
  },
  {
    title: "Permanent delegate",
    body: "Each share-class mint carries a Token-2022 permanent delegate: the share class's own program address, not a person. Two admin instructions use it, and only to move a holder's units into a quarantine vault of the same class whose every exit burns them: on a KYC-gated class, a holder whose passport was revoked, or expired at least 30 days ago; on any class, Open or KYC-gated, a wallet on the sanctions blocklist. The blocklist has its own on-chain authority (the Blocklist Authority), separate from the Manci admin role: it adds the wallet, then a Manci admin signs the clawback. Neither instruction can target the platform's own escrows or send units to a wallet.",
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
    body: "Privileged actions check current on-chain authority. Issuer Mint, Metadata and Conversion permissions can be scoped to one issuer; the blocklist has a separate authority, which can also switch a share class between Open and KYC-gated transfer checks. Every role replacement requires the new wallet to accept, within 14 days. Program upgrade authority is separate.",
  },
  {
    title: "Issuer proceeds freeze",
    body: "Any Manci admin can freeze the proceeds of one issuer: its primary sales, sale withdrawals and payouts to the issuer stop. Only the Super Admin can lift the freeze. Money buyers already paid into that issuer’s sale stays locked in the sale’s escrow while the freeze lasts: it is not paid to the issuer, and there is no refund of it to buyers (they keep the units they bought). The exits of what the issuer does not receive keep working — cancelling an offer, expiring or cancelling an OTC deal, custody returns, investor yield and claims. When a party of an OTC deal is on the blocklist the deal cannot expire; a Manci admin cancels it, which returns the deposits. The freeze does not reach units the issuer’s own wallet already holds.",
  },
  {
    title: "Timelocked role changes",
    body: "Adding a Manci admin and replacing the Super Admin take effect only after a 48-hour waiting period, and must then be executed within 14 days; until then the change can be cancelled. Pausing and removing an admin are immediate.",
  },
  {
    title: "Key recovery",
    body: "If the Super Admin or Blocklist Authority key is lost, the program upgrade authority can propose a recovery to a new key, executable after 7 days. While it is pending the role cannot be rotated, and the current key holder can cancel it.",
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
        lede="Understand the controls the app and the on-chain programs apply, when identity verification is required, and how to report a vulnerability."
      />

      <Section>
        <H2>When verification is required</H2>
        <Body className="mt-4">
          Buying and trading tokens does not require identity verification:
          primary sales, OTC offers and resell listings of an Open class need
          none. Verification (KYC) is required when you convert tokens into
          shares of the company or take delivery of a physical good. It is
          checked twice: the platform checks your verified client profile
          before it accepts a conversion or delivery request, and the program
          checks it on-chain when the custody escrow holding your tokens is
          realized — your investor passport must be approved, unexpired and
          from a permitted jurisdiction. If that check fails, the escrow can
          return the deposited tokens to you instead; the return itself needs
          no verification. The platform can switch a class to KYC-gated, for
          example at the issuer&apos;s request; buying or receiving that class
          then requires an approved investor passport, because every transfer
          checks the receiving wallet.
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
          handled by the program.
        </Body>
      </Section>

      <Section>
        <H2>When tokens can be clawed back</H2>
        <Body className="mt-4">
          A Manci admin can move a holder&apos;s tokens without the
          holder&apos;s signature in exactly two cases, and only into a
          quarantine vault of the same share class from which the tokens can
          only be burned:
        </Body>
        <Bullets
          className="mt-4"
          items={[
            "On a KYC-gated class, when the holder’s investor passport was revoked, or expired at least 30 days ago: the 30-day grace lets the holder renew it first.",
            "On any class, Open or KYC-gated, when the holder’s wallet is on the sanctions blocklist. The Blocklist Authority, a separate on-chain role, adds the wallet; a Manci admin then signs the clawback. The program does not require the two roles to be held by different keys.",
          ]}
        />
        <Body className="mt-4">
          Seized tokens are not returned on-chain, including if the wallet is
          later removed from the blocklist. The emergency pause does not stop a
          clawback. Neither path can take tokens held in the platform&apos;s own
          escrows or send them to a wallet.
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
        <H2 className="mb-6">Pending and interrupted transactions</H2>
        <Card
          className="max-w-[760px]"
          title="Check the chain before you retry"
          body="A submitted transaction can confirm while the app or its RPC provider is unavailable, so a pending status is not proof of failure. Check the result on-chain and use the saved record's retry action; never repeat a payment or a deposit to update the app's record."
        />
        <p className="mt-4">
          <a className="mx-link" href="/docs/recovery">
            Transaction recovery guide →
          </a>
        </p>
      </Section>

      <Section>
        <H2>Reporting a vulnerability</H2>
        <Body className="mt-4">
          If you find a security issue in the Manci programs or app,{" "}
          {SECURITY_CONTACT ? (
            <>
              email{" "}
              <a className="mx-link" href={`mailto:${SECURITY_CONTACT}`}>
                {SECURITY_CONTACT}
              </a>
            </>
          ) : (
            "use the contact form"
          )}
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
