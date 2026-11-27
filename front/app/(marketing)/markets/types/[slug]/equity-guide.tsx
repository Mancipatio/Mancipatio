import { Body, Bullets, DataTable, H2, Section } from "@/components/mx";

export function EquityGuide() {
  return (
    <>
      <Section>
        <H2>What it is</H2>
        <Body className="mt-4">
          A Company ownership token is your way to a real stake in a project you believe in. The project sits in a
          Serbian company (d.o.o. / LLC), and that company&apos;s equity stands behind every token. Convert through
          Manci whenever you choose, and the founders transfer your portion of the equity to you.
        </Body>
        <Body className="mt-4">
          Once the Serbian Business Registers Agency (APR) records the transfer, you become a shareholder.
        </Body>
        <Body className="mt-4">
          On top of the path to equity, an issuer can add payouts and other rights you enjoy while you hold the
          tokens: for an example, a fixed amount or a share of profit, until you convert.
        </Body>
      </Section>

      <Section>
        <H2>Who it&apos;s for</H2>
        <Bullets className="mt-4">
          <li>
            A project that wants to raise from its community, with a token people trust because real equity
            stands behind it.
          </li>
          <li>An investor who wants a stake in the business behind the token, not just exposure to the hype.</li>
        </Bullets>
      </Section>

      <Section>
        <H2>Why Manci is different</H2>
        <Body className="mt-4">
          The industry default: park the asset in an offshore SPV and sell you that vehicle&apos;s token. You get a
          contract with an offshore company. You can&apos;t see who owns it, and you never get a stake of your own.
          Offshore secrecy often works against the investor.
        </Body>
        <Body className="mt-4">
          With Manci, the equity sits in Europe (Republic of Serbia). The company and its owners are in a
          public government register that anyone can find online. Convert, and your own name goes
          into that register. Before you buy, check both sides yourself: the token on the blockchain and the company
          in the state register.
        </Body>
      </Section>

      <Section>
        <H2>Why convertible</H2>
        <Bullets className="mt-4">
          <li>Many tokens give holders no share in the business and no claim against the founders.</li>
          <li>A convertible token gives you a real right to equity.</li>
          <li>
            Trade it on DeFi OTC, hold it, or convert and become part of the project as a registered equity
            holder.
          </li>
        </Bullets>
      </Section>

      <Section>
        <H2>Becoming a member</H2>
        <Bullets className="mt-4">
          <li>You decide when to convert via the platform.</li>
          <li>Converting needs KYC. Buying and holding doesn&apos;t, unless required for the specific issuance.</li>
          <li>Your tokens go into an escrow while waiting for the transfer to be registered.</li>
          <li>
            You and the founders sign the transfer documents, and the transfer is inscribed in the government
            registry.
          </li>
          <li>Then the tokens are burned. The equity stays with you.</li>
          <li>Prefer to sell? Transfer the token. The rights go with it.</li>
        </Bullets>
      </Section>

      <Section>
        <H2>Structure &amp; protections</H2>
        <Bullets className="mt-4">
          <li>
            <strong>Who issues.</strong> Serbian companies issue tokens directly. Foreign companies and founders without a company issue
            tokens through a Serbian SPV, arranged through Manci&apos;s partners in the Republic of Serbia or by
            your own lawyer.
          </li>
          <li>
            <strong>Platform limit.</strong> Quick and easy: up to EUR 3,000,000 per issuer in any 12 months. Higher value issuances are
            possible, but require additional checks.
          </li>
          <li>
            <strong>Public state registers.</strong> Both the company register and the Pledge Register are run by a government agency. Anyone can check
            online who owns the company.
          </li>
          <li>
            <strong>Transfers.</strong> Tokens are freely transferable. Issuers can add conditions, such as limiting transfers to verified
            wallets.
          </li>
          <li>
            <strong>Payments before conversion.</strong> Optional: a fixed amount or a share of profit, paid straight to the wallet holding the tokens.
          </li>
        </Bullets>
      </Section>

      <Section>
        <H2>Terms at a glance</H2>
        <DataTable
          className="mt-5"
          columns={["Field", "Value"]}
          minWidth={420}
          rows={[
            { header: "Company behind the token", cells: ["A Serbian company, or a Serbian SPV"] },
            { header: "Rights before conversion", cells: ["Right to convert into equity, plus optional payouts set per issuance"] },
            { header: "Becoming a member", cells: ["Request + KYC → tokens in escrow → APR registration → token burn"] },
            { header: "Voting rights", cells: ["Yes, once your token becomes an ownership stake"] },
            { header: "Platform limit", cells: ["EUR 3,000,000 per issuer, any 12 months"] },
            { header: "Conversion", cells: ["Whenever you choose"] },
            { header: "Transfers", cells: ["Free by default; the issuer can add limits"] },
          ]}
        />
        <Body className="mt-4">
          Typical use: founders offering part of their company to investors.
        </Body>
      </Section>
    </>
  );
}
