import type { Metadata } from "next";
import {
  Body,
  Bullets,
  Button,
  ButtonRow,
  Card,
  Grid,
  H2,
  MX_ROUTES,
  PageHeader,
  Section,
  Steps,
  TextLink,
} from "@/components/mx";
import { PilotModuleNotice } from "@/components/pilot-module-notice";
import { scopeEnabled } from "@/lib/features";
import { navHrefVisible, type ModuleRouteState } from "@/lib/pilot-scope";
import { SPV_CHOICE_LABEL, SPV_COSTS, SPV_REQUIREMENTS } from "@/lib/apply-spv";

/**
 * Public guide: how a company incorporated outside Serbia (or a founder
 * without a company) issues on Manci, through a Serbian SPV that Manci
 * incorporates and administers for the issuance. The /apply panel for the
 * same applicants (lib/apply-spv.ts) links here and shares its lists.
 *
 * Issuance is a core area that KYC-only mode pauses (lib/features.ts
 * scopeEnabled("issuance")): while it is paused the page carries the same
 * "Paused." notice as every paused page, the button into /apply is hidden
 * (navHrefVisible), and menus leave the guide out (KYC_ONLY_NAV_PREFIXES).
 *
 * Careful, factual copy only: what the platform does (the SPV registry and
 * its rolling cap, migrations 0018 / 0066), what is off-chain (notary
 * certification and the APR registration), and costs as the pricing page
 * states them. What holders can claim is the issuance's documents' business,
 * as /legal-structure says. Listed in the PR under "Copy for counsel review".
 */

const PAUSED_STATE: ModuleRouteState = {
  route: { prefix: "/solutions/serbian-spv", modules: ["issuance"], mode: "notice" },
  off: ["issuance"],
  disabled: true,
};

export const metadata: Metadata = {
  title: "Issuing through a Serbian SPV — Manci",
  description:
    "For companies incorporated outside Serbia: company ownership, debt and revenue share are issued through a Serbian SPV that Manci incorporates and administers for the issuance. Third-party costs are quoted before any work starts.",
};

export default function SerbianSpvGuidePage() {
  const paused = !scopeEnabled("issuance");
  const registryGuide = "/solutions/issuer-registry";
  return (
    <>
      <PageHeader
        eyebrow="Onboarding / Platform guide"
        title="Issuing through a Serbian SPV"
        lede="Company ownership, debt and revenue share on Manci are issued by a Serbian company. If yours is incorporated elsewhere, or you do not have a company yet, Manci incorporates a Serbian special-purpose vehicle (SPV) and administers it for the issuance."
      >
        <ButtonRow>
          {navHrefVisible(MX_ROUTES.apply) && <Button href={MX_ROUTES.apply}>Apply to issue</Button>}
          <Button href={MX_ROUTES.contact} variant="ghost">
            Ask a question first
          </Button>
        </ButtonRow>
      </PageHeader>

      {paused && (
        <Section>
          <PilotModuleNotice state={PAUSED_STATE} gate />
        </Section>
      )}

      <Section id="workflow">
        <H2>How it works</H2>
        <Steps
          className="mt-6"
          items={[
            {
              title: "Apply and choose the SPV",
              body: `In the application, say where your company is incorporated and tick “${SPV_CHOICE_LABEL}” A founder applying as an individual always issues through an SPV.`,
            },
            {
              title: "Review and quote",
              body: "A person reviews the application. Before any work starts, you receive a quote for the third-party costs of your engagement.",
            },
            {
              title: "Incorporation, off-chain",
              body: "Manci prepares the SPV's founding documents. The signatures are certified by a notary and the company is registered with the Serbian Business Registers Agency (APR). These steps happen outside the platform.",
            },
            {
              title: "Issuance",
              body: "The SPV becomes the issuer on Manci and follows the usual issuer process: company verification (KYB), the asset and its share classes, then the approved placement.",
            },
            {
              title: "Administration",
              body: "Manci administers the SPV for the issuance. What holders can claim, and how, is set out in the issuance's documents before anything is placed.",
            },
          ]}
        />
      </Section>

      <Section id="requirements">
        <H2>What you will need to provide</H2>
        <Body className="mt-3">The exact list is confirmed for your engagement. It usually includes:</Body>
        <Bullets className="mt-4 max-w-[760px]" items={[...SPV_REQUIREMENTS]} />
      </Section>

      <Section id="details">
        <H2 className="mb-6">Details to check</H2>
        <Grid cols={2}>
          <Card title="Costs" body={SPV_COSTS} />
          <Card
            title="A cap per SPV"
            body="Issuance through each SPV is capped at EUR 3 million in any rolling 12 months. The platform checks the cap before a sale is approved and before new tokens are created for a direct distribution."
          />
          <Card
            title="Already a Serbian company?"
            body="A company incorporated in Serbia issues directly as the issuer, without an SPV. It goes through the same verification and issuance steps."
          />
          <Card
            title="Built per issuance"
            body="The structure is put together for each issuance rather than assumed once for everyone. Whether an instrument needs an SPV, and what the SPV's role is, is confirmed for your case during the engagement."
          />
        </Grid>
      </Section>

      <Section id="references">
        <H2>Related reference</H2>
        <Body className="mt-3">
          Read the <TextLink href="/legal-structure">legal structure</TextLink>{" "}
          behind a token and how <TextLink href="/pricing">fees and costs</TextLink>{" "}
          are charged.
          {navHrefVisible(registryGuide) ? (
            <>
              {" "}The <TextLink href={registryGuide}>issuer registration guide</TextLink> covers
              verification and the issuer record.
            </>
          ) : null}
        </Body>
      </Section>
    </>
  );
}
