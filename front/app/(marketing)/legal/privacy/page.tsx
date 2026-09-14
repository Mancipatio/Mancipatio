import type { Metadata } from "next";
import {
  H2,
  PageHeader,
  Section as DocumentSection,
  Small,
} from "@/components/mx";

export const metadata: Metadata = {
  title: "Privacy Policy — Mancipatio",
  description:
    "How Mancipatio collects, uses and protects personal data of issuers, investors and visitors.",
};

const LAST_UPDATED = "2026-05-25";

export default function PrivacyPage() {
  return (
    <article>
      <PageHeader eyebrow="Legal" title="Privacy Policy">
        <Small className="mt-5">Last updated: {LAST_UPDATED}</Small>
      </PageHeader>

      <div>
        <Section title="1. Who we are">
          <p>
            Mancipatio (&quot;we&quot;, &quot;us&quot;, &quot;the platform&quot;) operates a tokenization
            and custody infrastructure for real-world assets and investments on
            Solana. This Privacy Policy describes how we collect, use and
            protect personal data when you visit mancipatio.io or use the
            issuer / investor consoles.
          </p>
          <p>
            For the avoidance of doubt: <strong>this v0.1 release runs on
            Solana <em>devnet</em></strong>. No real assets or fiat are ever
            transferred. The platform is in pilot.
          </p>
        </Section>

        <Section title="2. Data we collect">
          <ul>
            <li>
              <strong>Wallet addresses</strong>: every connected Solana wallet
              address is processed to deliver the service and recorded
              on-chain when you sign a transaction. Wallet addresses are
              public by their nature.
            </li>
            <li>
              <strong>On-chain transaction signatures and metadata</strong>:
              once you sign a transaction, the resulting signature, slot and
              instruction arguments are public and indexed by us in a
              Postgres database.
            </li>
            <li>
              <strong>Issuer / KYB documents</strong>: when registering an
              issuer entity, off-chain documents (incorporation,
              board resolution, UBO declaration, etc.) may be uploaded for
              KYB review. In v0.1 we use a stub flow; once a KYC provider
              (Sumsub) is wired up, identity data is handed to that
              provider and we store only their decision + a reference.
            </li>
            <li>
              <strong>Client KYC identity documents</strong>: during client
              onboarding, individuals and entities upload identity/KYC
              documents which our team reviews manually. These are stored in a
              private bucket and access is logged.
            </li>
            <li>
              <strong>Launch-application data</strong>: when you apply to raise
              on the launchpad, we collect founder details (name, email,
              Twitter/LinkedIn), company information, valuation, revenue and
              pitch materials.
            </li>
            <li>
              <strong>Investor-passport requests</strong>: jurisdiction,
              accreditation level and supporting details submitted to obtain or
              renew an on-chain investor passport.
            </li>
            <li>
              <strong>Delivery &amp; contact details</strong>: physical delivery
              addresses and contact details for delivery requests, contact-form
              inquiries, and contact information attached to resell-board
              listings.
            </li>
            <li>
              <strong>Contact info</strong>: email and an optional phone
              number entered in the onboarding form. Stored in Supabase.
            </li>
            <li>
              <strong>Operational metadata</strong>: IP address, user-agent
              and timestamps from request logs. Retained for 30 days, used
              only for security/abuse detection.
            </li>
          </ul>
        </Section>

        <Section title="3. Why we process it">
          <ul>
            <li>To verify the legal identity of issuers (regulatory KYB).</li>
            <li>To prevent fraud, sanctioned-party transactions and abuse.</li>
            <li>
              To run the on-chain platform and provide the dashboards (legitimate
              interest under GDPR Art. 6(1)(f) and contractual necessity
              under Art. 6(1)(b)).
            </li>
            <li>
              To comply with applicable AML/CTF and securities regulations in
              the jurisdictions we serve.
            </li>
          </ul>
        </Section>

        <Section title="4. Who sees it">
          <ul>
            <li>
              <strong>Mancipatio operators</strong> (Super Admin and Admin
              roles) — for KYB review and incident response.
            </li>
            <li>
              <strong>Sub-processors</strong>: Vercel (hosting), Supabase
              (database + storage), Helius (RPC + on-chain webhooks), and a
              KYC provider once enabled. Each is bound by their own DPA.
            </li>
            <li>
              <strong>Public</strong>: anything on-chain is, by design, public.
              Wallet addresses, asset metadata, share-class supply and
              transaction signatures are visible to anyone.
            </li>
          </ul>
        </Section>

        <Section title="5. Where it lives">
          <p>
            Off-chain personal data is stored in EU-region infrastructure
            (Vercel and Supabase Frankfurt). On-chain data lives on the
            Solana blockchain, which is globally replicated.
          </p>
        </Section>

        <Section title="6. How long we keep it">
          <ul>
            <li>
              KYB documents: <strong>7 years</strong> after the issuer relationship
              ends, in line with AML record-keeping obligations in most
              relevant jurisdictions.
            </li>
            <li>Audit log entries: same as KYB.</li>
            <li>Request logs (IP, user-agent): 30 days.</li>
            <li>
              On-chain transactions: <strong>permanent</strong> (the
              blockchain itself).
            </li>
          </ul>
        </Section>

        <Section title="7. Your rights (GDPR / UK GDPR / similar)">
          <ul>
            <li>Right to access and obtain a copy of your data.</li>
            <li>Right to rectification of inaccurate data.</li>
            <li>
              Right to erasure of off-chain data (the on-chain reference can be
              orphaned but the on-chain bytes themselves cannot be removed).
            </li>
            <li>Right to restrict or object to processing.</li>
            <li>Right to data portability where applicable.</li>
            <li>
              Right to lodge a complaint with a supervisory authority in the
              EU/EEA.
            </li>
          </ul>
          <p>
            To exercise any of these, write to{" "}
            <a href="mailto:privacy@mancipatio.io">privacy@mancipatio.io</a>{" "}
            with the wallet you control as the subject and a signed message
            proving control over it.
          </p>
        </Section>

        <Section title="8. Security">
          <p>
            We encrypt off-chain personal data at rest, restrict service-role
            keys to server-only contexts, gate destructive admin actions
            behind explicit confirmation and audit logging, and require
            hardware-wallet signing for Super Admin operations on mainnet
            (when launched).
          </p>
        </Section>

        <Section title="9. Changes">
          <p>
            We&apos;ll update this page when the data practices change. The
            &quot;Last updated&quot; date at the top reflects the most recent
            revision.
          </p>
        </Section>

        <Section title="10. Contact">
          <p>
            <a href="mailto:privacy@mancipatio.io">privacy@mancipatio.io</a>
          </p>
        </Section>
      </div>
    </article>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <DocumentSection>
      <H2>{title}</H2>
      <div className="mx-body mt-4 space-y-4 [&_ul]:list-disc [&_ul]:pl-5 [&_li]:mt-2 [&_a]:underline [&_a]:underline-offset-2">
        {children}
      </div>
    </DocumentSection>
  );
}
