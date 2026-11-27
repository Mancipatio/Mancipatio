import { Body, Bullets, Button, ButtonRow, Card, Grid, H2, PageHeader, Section, Steps, TextLink } from "@/components/mx";
import { features, moduleEnabled } from "@/lib/features";
import { detectNetwork } from "@/lib/network";
import { navHrefVisible } from "@/lib/pilot-scope";

export const metadata = {
  title: "Issuing an asset · Manci",
  description: "From application to issued tokens. The documents and requirements are set for each issuance.",
};

const STEPS = [
  {
    title: "Verify your account.",
    body: <>Sign in with your wallet, then verify yourself (KYC) or your company (KYB) from the <TextLink href="/issuer">issuer workspace</TextLink>. The application page asks for this first.</>,
  },
  {
    title: "The review.",
    body: "Track the status while the team reviews your submission. If changes or documents are requested, update the same request and resubmit. KYB approval alone doesn't grant operational permissions on the platform.",
  },
  {
    title: "Apply for issuance.",
    body: "Submit the equity issuance application: the asset, the rights, the amount, the schedule, and whether you issue directly or through a Serbian SPV. Follow the application review and respond to any requested changes.",
  },
  {
    title: "Finalize terms and documents.",
    body: "Agree the legal and commercial terms, including fees and costs. Set up the structure, obtain any required corporate approvals and prepare the issuance documents and disclosures.",
  },
  {
    title: "Register the asset.",
    body: "Register the approved asset and configure its share classes and supply to match the agreed terms.",
  },
  {
    title: "Distribute the tokens.",
    body: "Choose one of two routes:",
  },
];

export default function HowItWorksPage() {
  const network = detectNetwork();
  const afterIssuance = [
    { href: "/issuer/cap-table", title: "Holder registry.", body: "See who holds your tokens." },
    { href: "/issuer/updates", title: "Announcements.", body: "Publish updates that token holders can read in Portfolio." },
    { href: "/portfolio/conversion", title: "Conversion.", body: "Holders request conversion on the platform. The legal transfer is signed, the BRA registers it and the tokens are burned." },
    { href: "/solutions/otc", title: "DeFi OTC.", body: "Holders can trade your tokens peer to peer, under the issuance's transfer rules." },
    { href: "/solutions/governance", title: "Governance.", body: "Advisory votes based on a snapshot. A proposal passes only if votes for outweigh votes against. A tie fails, and abstentions don't affect the result." },
    {
      href: "/solutions/rights-vesting",
      title: "Vesting & claims.",
      body: [
        moduleEnabled("rights", network) && "Rights Token claims are available.",
        network === "mainnet" && !moduleEnabled("vesting", network) && "New vesting series aren't available on mainnet yet.",
      ].filter(Boolean).join(" "),
    },
  ].filter(({ href }) => navHrefVisible(href));

  return (
    <>
      <PageHeader eyebrow="Issuer guide" title="Issuing an asset" lede={metadata.description}>
        <ButtonRow>
          {navHrefVisible("/apply") && <Button href="/apply">Apply to issue</Button>}
          <Button href="/contact" variant="ghost">Contact the team</Button>
        </ButtonRow>
      </PageHeader>
      <Section>
        <H2>Before you apply</H2>
        <Bullets className="mt-4">
          <li><strong>Serbian company?</strong> You issue directly, there’s no need to incorporate an SPV.</li>
          <li><strong>Foreign company?</strong> Request a <TextLink href="/solutions/serbian-spv">Serbian SPV</TextLink> in your application.</li>
          <li><strong>Individual founder?</strong> Request a <TextLink href="/solutions/serbian-spv">Serbian SPV</TextLink> in your application.</li>
        </Bullets>
      </Section>
      <Section>
        <H2>The issuance process</H2>
        <Steps className="mt-5" items={STEPS} />
        <Bullets className="mt-4">
          <li><strong>Primary sale.</strong> Manci&apos;s admin approves the sale parameters for the class once. Investors pay in USDC, accept the issuance documents and separately acknowledge the risks. Each purchase mints tokens straight into the buyer&apos;s wallet.{!features(network).startupRaises && " New Startup sales can't be opened at the moment."}</li>
          <li><strong>Direct distribution from treasury.</strong> Tokens are minted into your treasury and distributed directly, as the <TextLink href="/legal/terms">Terms of Service</TextLink> allow. This needs your signature and Manci&apos;s admin role. The app doesn&apos;t process any payment for these tokens.</li>
        </Bullets>
      </Section>
      <Section>
        <H2 className="mb-6">Who does what</H2>
        <Grid cols={3}>
          <Card title="The token issuer." body={<>Issues tokens up to a cap recorded on Solana. The issuer is responsible for the rights attached to the tokens, the issuance documents and disclosures. When a holder converts, the issuer ensures that the legal transfer and APR registration are completed. <TextLink href="/legal-structure">How the legal structure works</TextLink></>} />
          <Card title="Token holders." body="Hold a right to convert into equity, in their own wallets, and can transfer it under the issuance's rules. They become registered members once APR records the transfer, and the tokens are then burned." />
          <Card title="Manci." body={<>Verifies issuers, runs issuance, escrow and conversion on Solana, and publishes the record of each registration next to the token. Manci is not the issuer and takes no legal title to what backs the token. Fees follow your engagement agreement. <TextLink href="/pricing">Fees &amp; costs</TextLink></>} />
        </Grid>
      </Section>
      {navHrefVisible("/portfolio/rights") && (
        <Section id="distributions">
          <H2>Payouts</H2>
          <Body className="mt-4">
            Where an issuance provides for payouts, the applicable terms determine how they are made. For push distributions, the operator saves the recipients and exact amounts from an approved snapshot before funding. Payouts then run in those committed groups using on-chain receipts, never rebuilt from changed balances. The full amount is allocated under a stated rounding rule. A contract can only distribute funds that were deposited: it can&apos;t create revenue or make an unfunded payment. <TextLink href="/portfolio/rights">Open income &amp; claims</TextLink>
          </Body>
        </Section>
      )}
      {afterIssuance.length > 0 && (
        <Section>
          <H2>After issuance</H2>
          <Grid cols={2} className="mt-5">
            {afterIssuance.map((card) => <Card key={card.href} {...card} />)}
          </Grid>
        </Section>
      )}
    </>
  );
}
