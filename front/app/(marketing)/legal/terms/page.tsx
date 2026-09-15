import type { Metadata } from "next";
import type { ReactNode } from "react";
import {
  Badge,
  Body,
  Bullets,
  Card,
  H2,
  MX_ROUTES,
  MX_STAGE_LABEL,
  PageHeader,
  Section,
  Small,
  TextLink,
} from "@/components/mx";

/**
 * Terms of Service — prototype `#page-terms`.
 *
 * The prototype's version of this page is a placeholder ("To be drafted by the
 * legal team"), so it does not replace anything: every operative clause below
 * is the existing text, carried over word for word. Only the presentation
 * changed. Legal wording is not edited here.
 */
export const metadata: Metadata = {
  title: "Terms of Service — Manci",
  description:
    "Terms governing access to and use of the Manci tokenization platform.",
};

const LAST_UPDATED = "2026-05-25";

export default function TermsPage() {
  return (
    <>
      <PageHeader
        eyebrow="Legal"
        title="Terms of Service"
        lede="Terms governing access to and use of the Manci tokenization platform."
      >
        <Small className="mt-5">Last updated: {LAST_UPDATED}</Small>
      </PageHeader>

      <Section>
        <Card className="max-w-[760px]" title="Devnet pilot">
          <p>
            The current release runs on Solana devnet. No real assets are
            tokenized, no fiat changes hands, and tokens minted here have{" "}
            <em>no</em> economic value. These terms cover the use of the
            dashboards and the early-access program; a separate set of terms
            will govern mainnet operations when launched.
          </p>
          <p className="mt-3.5">
            <Badge variant="stage">{MX_STAGE_LABEL}</Badge>
          </p>
        </Card>
      </Section>

      <Section>
        <Clause title="1. Acceptance" first>
          <Body>
            By connecting a wallet or registering an issuer entity on
            mancipatio.io (&quot;Manci&quot;, &quot;Service&quot;), you
            agree to these Terms. If you don&apos;t agree, do not connect or
            register.
          </Body>
        </Clause>

        <Clause title="2. Eligibility">
          <Bullets
            items={[
              "You must be at least 18 years old.",
              "You are responsible for ensuring that using the Service is lawful where you reside and where the represented legal entity is incorporated.",
              "You must not be a resident of, or otherwise located in, a jurisdiction subject to comprehensive OFAC/EU sanctions (currently: North Korea, Iran, Cuba, Syria, Crimea, the Donetsk People's Republic and the Luhansk People's Republic).",
            ]}
          />
        </Clause>

        <Clause title="3. No financial advice, no securities offer">
          <Body>
            Nothing on the Service is investment, legal, tax or accounting
            advice. The platform is technology infrastructure — issuers and
            investors are independently responsible for the legal
            characterization of any token issued or transacted on it.
          </Body>
          <Body className="mt-3.5">
            Manci does not solicit or facilitate the offer or sale of
            securities to the public in any jurisdiction in which such offer
            would require registration with a securities regulator unless we
            have explicitly enabled the relevant compliance flow for that
            jurisdiction.
          </Body>
        </Clause>

        <Clause title="4. Issuer obligations">
          <Bullets
            items={[
              "Maintain accurate KYB information and update us promptly on any material change to the entity, its UBOs or its compliance posture.",
              "Treat the issuer authority wallet as a master key. Loss of control of the wallet can compromise the entity. Hardware wallets and Squads multisig are strongly recommended.",
              "Obtain all licences and consents required to tokenize an asset under the applicable legal regime.",
            ]}
          />
        </Clause>

        <Clause title="5. Investor obligations">
          <Bullets
            items={[
              "Take responsibility for the security of your own wallet, private keys and any seed phrases.",
              "Pass the KYC step on any transaction touching the platform's compliance touchpoints (initial sale, on-platform OTC, delivery, conversion).",
              "Understand that tokens are bearer instruments — off-platform transfers and self-custody mean Manci cannot recover them if they leave your control.",
            ]}
          />
        </Clause>

        <Clause title="6. Fees">
          <Body>
            Network (Solana) fees are paid by the user signing the transaction.
            There is no fixed protocol fee charged on-chain; commercial terms
            for tokenisation engagements are agreed per engagement and disclosed
            in the applicable engagement agreement. Devnet operations are
            subsidized.
          </Body>
        </Clause>

        <Clause title="7. Service availability">
          <Body>
            The Service is provided &quot;as is&quot;. We don&apos;t guarantee
            uptime, latency or feature stability during the devnet pilot.
            Maintenance windows may interrupt operations without notice.
          </Body>
        </Clause>

        <Clause title="8. Custody and asset risk">
          <Body>
            Manci acts as an <em>escrow agent</em> for custody flows — the
            platform&apos;s custody program holds tokens in PDA-owned escrows
            during conversion, delivery and redemption. We do not take legal
            title to off-chain assets backing tokens.
          </Body>
        </Clause>

        <Clause title="9. Disputes">
          <Body>
            Any dispute arising under these Terms shall be governed by the law
            of the issuer&apos;s incorporation jurisdiction where applicable,
            otherwise the law of the platform operator&apos;s jurisdiction (to
            be confirmed before mainnet launch). The parties agree to attempt
            good-faith resolution before initiating formal proceedings.
          </Body>
        </Clause>

        <Clause title="10. Changes">
          <Body>
            We may update these Terms. The &quot;Last updated&quot; date
            reflects the most recent change. Continued use of the Service after
            a change constitutes acceptance.
          </Body>
        </Clause>

        <Clause title="11. Contact">
          <Body>
            <a className="mx-link" href="mailto:legal@mancipatio.io">
              legal@mancipatio.io
            </a>
          </Body>
        </Clause>
      </Section>

      <Section>
        <Body>
          How we store and handle personal data is set out separately.
        </Body>
        <p className="mt-5">
          <TextLink href={MX_ROUTES.privacy}>Privacy policy →</TextLink>
        </p>
      </Section>
    </>
  );
}

/**
 * One numbered clause: an h2 and its body. Local to this page — the mx system
 * has no legal-document primitive and doesn't need one.
 */
function Clause({
  title,
  first = false,
  children,
}: {
  title: string;
  first?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={first ? undefined : "mt-10"}>
      <H2 className="text-[19px] leading-snug tracking-normal">{title}</H2>
      <div className="mt-4">{children}</div>
    </div>
  );
}
