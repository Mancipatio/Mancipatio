import type { Metadata } from "next";
import { Body, Bullets, H2, PageHeader, Section, TextLink } from "@/components/mx";
import { SecurityAuditReportLink } from "@/components/legal/security-review";
import { SECURITY_AUDIT, securityReviewStatement } from "@/lib/legal/audit";
import { detectNetwork, isTestNetwork } from "@/lib/network";

export const metadata: Metadata = {
  title: "Risk disclosure — Manci",
  description: "Equity tokens on Manci come with a real right to equity, which the issuer can secure with a registered lien. They are still an investment in a private company, and you can lose some or all of your investment.",
};

export default function RisksPage() {
  const network = detectNetwork();
  return (
    <>
      <PageHeader
        eyebrow="Risk disclosure"
        title="Know the risks."
        lede="Equity tokens on Manci come with a real right to equity, which the issuer can secure with a registered lien. They are still an investment in a private company, and you can lose some or all of your investment."
      />

      <Section>
        <H2>The short version</H2>
        <Bullets className="mt-4">
          <li>Only invest what you can afford to lose.</li>
          <li>
            If a registered lien secures conversion, it protects you if the token issuer refuses to convert.
            It does not protect you if the business fails.
          </li>
          <li>There may be no buyers when you want to sell.</li>
          <li>Read the issuance documents. They decide what rights the token gives you.</li>
        </Bullets>
      </Section>

      <Section>
        <H2>The business behind the token can fail</H2>
        <Body className="mt-4">
          Most early-stage companies don&apos;t make it. If the company behind your token fails, its equity can
          become worthless, and so can your token. Payouts, where an issuer offers them, depend on the issuer and are
          not guaranteed. The information an issuer provides may also be incomplete or wrong.
        </Body>
      </Section>

      <Section>
        <H2>Enforcing a registered lien</H2>
        <Body className="mt-4">
          If the token issuer refuses to transfer the equity, a registered lien securing conversion can be enforced under the issuance documents.
          Enforcement takes time and money, may involve the Serbian courts, and the proceeds may not cover your
          investment.
        </Body>
      </Section>

      <Section>
        <H2>You may not be able to sell</H2>
        <Body className="mt-4">
          Trading on DeFi OTC depends on someone wanting to buy. There is no guaranteed buyer or price. After
          conversion, your stake isn&apos;t listed anywhere: selling it needs to follow the official procedure.
        </Body>
      </Section>

      <Section>
        <H2>Conversion takes time and paperwork</H2>
        <Body className="mt-4">
          Converting needs KYC, signatures and APR registration, and it can involve delays, costs or disputes. Your
          tokens sit in a smart contract escrow until it&apos;s done. If you can&apos;t pass KYC, you can&apos;t
          convert, and your tokens can be returned to you from the escrow.
        </Body>
      </Section>

      <Section>
        <H2>Technology risk</H2>
        <Body className="mt-4">
          Tokens are issued on the Solana blockchain. Smart contract bugs, network outages or a lost wallet can cost
          you access to your tokens. Lose your keys and Manci may not be able recover them for you (check the
          recovery rules for each issued token). Stablecoins used for payments, such as USDC, carry their own risks,
          including losing their peg.{" "}
          {SECURITY_AUDIT ? securityReviewStatement() : "Manci's smart contracts have not yet undergone an independent security audit."}
        </Body>
        <SecurityAuditReportLink className="mt-3.5" />
        {isTestNetwork(network) && (
          <Body className="mt-4">
            This is Solana {network}. Tokens on this test network have no economic value.
          </Body>
        )}
      </Section>

      <Section>
        <H2>Compliance controls can affect your tokens</H2>
        <Body className="mt-4">
          Manci runs on-chain compliance controls. These controls protect the platform but can also affect your
          rights and access to your tokens:
        </Body>
        <Bullets className="mt-4">
          <li>
            <strong>Sanctions blacklist.</strong> A blacklisted wallet can&apos;t send tokens. Manci can move the tokens into a quarantine vault and
            they may be burned.
          </li>
          <li>
            <strong>Emergency pause.</strong> Manci can pause activity on the platform, such as primary sales and trading through Manci. Exits and
            wallet-to-wallet transfers keep working.
          </li>
          <li>
            <strong>Issuer proceeds freeze.</strong> Manci can freeze an issuer&apos;s proceeds. Money already paid into that issuer&apos;s sale then
            stays locked in escrow: it isn&apos;t paid to the issuer and isn&apos;t refunded while the freeze
            lasts.
          </li>
          <li><strong>Upgrades.</strong> Manci&apos;s on-chain programs can be upgraded.</li>
        </Bullets>
        <Body className="mt-4">
          The sanctions blacklist and the emergency pause apply across the platform. Other controls can vary between issuances: which controls apply, when they can be used and what they mean for your rights are set out in the token&apos;s issuance documents. The technical details are on <TextLink href="/security">Security &amp; controls</TextLink>.
        </Body>
      </Section>

      <Section>
        <H2>The platform may stop operating</H2>
        <Body className="mt-4">
          Manci may have outages or stop operating. Before conversion, that can affect trading, escrow and
          conversion. After conversion, your ownership is recorded in the state register and doesn&apos;t depend on
          Manci.
        </Body>
      </Section>

      <Section>
        <H2>Rules can change</H2>
        <Body className="mt-4">
          Digital asset laws in Serbia and elsewhere keep changing. Tokens may be restricted in your country.
          Checking that, and paying any tax, is your responsibility.
        </Body>
      </Section>

      <Section>
        <H2>No safety net</H2>
        <Body className="mt-4">
          Tokens are not bank deposits. Serbian rules on deposit insurance, investor protection and financial
          services consumer protection don&apos;t apply to digital asset transactions, and no Serbian public
          authority guarantees the value of your tokens.
        </Body>
      </Section>

      <Section>
        <H2>What Manci does and doesn&apos;t do</H2>
        <Body className="mt-4">
          Manci verifies issuers and manages the issuance, the escrow and the burn. Verification is not an
          endorsement of the business or its prospects, and Manci doesn&apos;t give investment advice. Before
          conversion, your rights are set out in the issuance documents.
        </Body>
        <Body className="mt-4">
          Not sure? Talk to an independent adviser before you invest.
        </Body>
      </Section>
    </>
  );
}
