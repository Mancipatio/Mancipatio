import type { Metadata } from "next";
import { Body, Bullets, Button, ButtonRow, H2, MX_ROUTES, PageHeader, Section, TextLink } from "@/components/mx";
import { PilotModuleNotice } from "@/components/pilot-module-notice";
import { scopeEnabled } from "@/lib/features";
import { indexingAllowed } from "@/lib/indexing";
import { navHrefVisible, type ModuleRouteState } from "@/lib/pilot-scope";

const PAUSED_STATE: ModuleRouteState = {
  route: { prefix: "/solutions/serbian-spv", modules: ["issuance"], mode: "notice" },
  off: ["issuance"],
  disabled: true,
};

export function generateMetadata(): Metadata {
  const shown = navHrefVisible("/solutions/serbian-spv");
  return {
    title: "Issuing through a Serbian SPV — Manci",
    description: shown
      ? "A Serbian special purpose vehicle (SPV) becomes the company behind your token. Your project gets the same model which Manci used: a right to convert and government registers anyone can check."
      : "Issuing through a Serbian SPV is not available at the moment.",
    ...(!shown && indexingAllowed() ? { robots: { index: false, follow: true } } : {}),
  };
}

export default function SerbianSpvGuidePage() {
  return (
    <>
      <PageHeader
        eyebrow="Onboarding / Platform guide"
        title="No Serbian company? Use a Serbian SPV."
        lede="A Serbian special purpose vehicle (SPV) becomes the company behind your token. Your project gets the same model which Manci used: a right to convert and government registers anyone can check."
      />

      {!scopeEnabled("issuance") && (
        <Section>
          <PilotModuleNotice state={PAUSED_STATE} gate />
        </Section>
      )}

      <Section>
        <H2>Who it&apos;s for</H2>
        <Bullets className="mt-4">
          <li>A company incorporated outside Serbia.</li>
          <li>Founders who don&apos;t have a company yet.</li>
        </Bullets>
        <Body className="mt-4">
          Already have a Serbian company? Skip this page. You issue directly.
        </Body>
      </Section>

      <Section>
        <H2>Your project, a Serbian vehicle</H2>
        <Body className="mt-4">
          You don&apos;t need to move your business to Serbia. The SPV will own what the issuance needs: a stake in
          your foreign company, specific assets, intellectual property or contractual rights. You decide what goes
          in.
        </Body>
        <Body className="mt-4">
          When investors convert, they become registered owners of the Serbian SPV.
        </Body>
      </Section>

      <Section id="workflow">
        <H2>How it works</H2>
        <ol className="mx-body mt-4 list-decimal space-y-3 pl-6">
          <li>
            <strong>Apply.</strong> Tell us about your project and choose who sets up the SPV: our partners or your own lawyer.
          </li>
          <li>
            <strong>Get a quote.</strong> A person reviews your application. Third-party costs are quoted before any work starts.
          </li>
          <li>
            <strong>Incorporate.</strong> The SPV&apos;s founding documents are signed and filed with the Serbian Business Registers Agency
            (BRA), which decides on the incorporation application within five working days of filing.
          </li>
          <li>
            <strong>Structure.</strong> Define what the SPV owns, what the tokens give investors and how much equity you want to tokenize.
          </li>
          <li>
            <strong>Issuance.</strong> Complete the usual verification and issuance steps on Manci.
          </li>
          <li>
            <strong>Run it.</strong> Like every other  company, the SPV needs to do accounting and files annual financial statements with
            BRA. We can recommend lawyers and accountants in Serbia, or you can use your own. Conversions are
            registered with BRA as they come in.
          </li>
        </ol>
      </Section>

      <Section id="requirements">
        <H2>What you&apos;ll need</H2>
        <Body className="mt-4">
          The exact list is confirmed for your case. It usually includes:
        </Body>
        <Bullets className="mt-4">
          <li>Identity verification on Manci: KYC for individuals, KYB for companies.</li>
          <li>Your company&apos;s registry extract and articles of association, if applicable.</li>
          <li>Information on who owns and controls the company: shareholders, beneficial owners and directors.</li>
          <li>The decision of your company&apos;s competent body approving the issuance, where applicable.</li>
          <li>The issuance terms: what rights the token gives, the amount and the price.</li>
          <li>Set of documents for the BRA.</li>
        </Bullets>
      </Section>

      <Section id="details">
        <H2>Good to know</H2>
        <Bullets className="mt-4">
          <li>
            <strong>Costs.</strong> Incorporation, notary, registry fees, translations and legal drafting are third-party costs, quoted
            up front.
          </li>
          <li>
            <strong>Platform limit.</strong> Quick &amp; easy to do: up to EUR 3,000,000 per issuer or its SPV in any 12 months. Higher value
            tokenisation are possible, but require additional checks.
          </li>
          <li>
            <strong>Minimum share capital.</strong> A Serbian limited liability company (d.o.o.) can be set up with a minimum share capital of RSD 100
            (about USD 1).
          </li>
          <li>
            <strong>No Serbian partner needed.</strong> Foreign individuals and companies can own 100% of a Serbian d.o.o.
          </li>
          <li>
            <strong>A real bank account.</strong> It’s easy for Serbian companies to open bank accounts, so your SPV will operate inside the regular
            banking system. Many offshore companies struggle to get a bank account.
          </li>
          <li>
            <strong>Fiat on- and off-ramps.</strong> The SPV can convert crypto into fiat and back to crypto through licensed local providers, such as
            ECD and Crypto12, both authorised by the National Bank of Serbia.
          </li>
          <li>
            <strong>Your stake, your call.</strong> You decide how much of the SPV&apos;s equity to tokenize. The rest stays in your hands.
          </li>
          <li>
            <strong>Built per issuance.</strong> What the SPV holds and what holders can claim is set out in the issuance documents and can be
            structured differently for different projects.
          </li>
        </Bullets>
        <Body className="mt-4">
          Why Serbia, and how conversion works: <TextLink href="/legal-structure">Legal structure</TextLink>
        </Body>
        <ButtonRow>
          <Button href={MX_ROUTES.apply}>Apply to issue</Button>
          <Button href={MX_ROUTES.contact} variant="ghost">Ask a question first</Button>
        </ButtonRow>
      </Section>
    </>
  );
}
