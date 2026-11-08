import type { Metadata } from "next";
import {
  Body,
  Button,
  ButtonRow,
  Card,
  Grid,
  H2,
  PageHeader,
  Section,
  Steps,
  TextLink,
} from "@/components/mx";
import { PilotModuleNotice } from "@/components/pilot-module-notice";
import { moduleEnabled } from "@/lib/features";
import { indexingAllowed } from "@/lib/indexing";
import { navHrefVisible, type ModuleRouteState } from "@/lib/pilot-scope";
import { ESOP_PRESET } from "@/lib/esop-schedule";

/**
 * Public guide: employee equity (ESOP) vesting with a vesting series and the
 * series form's ESOP preset (lib/esop-schedule.ts).
 *
 * Vesting series are a pilot module (lib/features.ts `vesting`), off on
 * mainnet unless its switch and the Terms offer it. So the page never says
 * the service is available: while the module is off it carries the module
 * notice (the same component and sentence as every module page, "Paused."
 * in KYC-only mode), the button into the issuer form is hidden by
 * navHrefVisible, and menus leave the guide out (NAV_ROUTES, like the other
 * module guides). It is not served by app/(marketing)/solutions/[slug] on
 * purpose: that renderer replaces a guide of an off module with a stub, while
 * this guide keeps explaining the module next to its notice.
 *
 * Every statement about behaviour is what the program does (cancel_vesting_series,
 * vesting_deliverable_cumulative) and what the form submits; the plan's legal
 * terms are the company's own document. Listed in the PR under "Copy for
 * counsel review".
 */

const MODULE_STATE: ModuleRouteState = {
  route: { prefix: "/solutions/esop", modules: ["vesting"], mode: "notice" },
  off: ["vesting"],
  disabled: true,
};

const WINDOW_DAYS = ESOP_PRESET.approvalWindowSecs / 86_400;

export function generateMetadata(): Metadata {
  const off = !moduleEnabled("vesting");
  return {
    title: "Employee equity (ESOP) vesting — Manci",
    description:
      "How a company can vest tokens to employees with a vesting series: a 12-month cliff, then monthly unlocks to month 48, where the vesting module is offered.",
    // A guide of a module that is off stays readable by URL but out of search results.
    ...(off && indexingAllowed() ? { robots: { index: false, follow: true } } : {}),
  };
}

export default function EsopGuidePage() {
  const off = !moduleEnabled("vesting");
  const formHref = "/issuer/vesting-series";
  const positionsHref = "/portfolio/vesting";
  const vestingGuide = "/solutions/rights-vesting";
  return (
    <>
      <PageHeader
        eyebrow="Vesting / Platform guide"
        title="Employee equity (ESOP) vesting"
        lede="Grant company tokens to employees on a schedule: nothing for the first 12 months, then a quarter of the grant, then an equal part every month until month 48. Where the vesting module is offered, a company sets this up as a vesting series."
      >
        <ButtonRow>
          {navHrefVisible(formHref) && <Button href={formHref}>Set up a vesting series</Button>}
          <TextLink href="/docs#platform-tools">All platform guides →</TextLink>
        </ButtonRow>
      </PageHeader>

      {off && (
        <Section>
          <PilotModuleNotice state={MODULE_STATE} gate />
        </Section>
      )}

      <Section id="workflow">
        <H2>How the ESOP preset works</H2>
        <Steps
          className="mt-6"
          items={[
            {
              title: "Choose the token and the recipients",
              body: "One vesting series covers one token and one schedule, with named recipient wallets and each one's allocation.",
            },
            {
              title: "Apply the ESOP preset",
              body: `The preset “${ESOP_PRESET.label}” unlocks 25 % of the allocation ${ESOP_PRESET.cliffMonths} months after the vesting start, then 1/${ESOP_PRESET.totalMonths} every month until month ${ESOP_PRESET.totalMonths}. The amounts are exact: monthly tranches differ by at most one base unit, and the last one makes the total equal the allocation.`,
            },
            {
              title: "Review every setting",
              body: `The preset also sets approval timing with a ${WINDOW_DAYS}-day window, cancellation with nothing kept before the cliff, and wallet recovery. Change any of them, check the exact on-chain amounts and dates, then submit the terms for review.`,
            },
            {
              title: "Create, fund and follow",
              body: "After approval the company creates the series from its own wallet and funds it in full; recipients follow their unlock dates in their portfolio.",
            },
          ]}
        />
      </Section>

      <Section id="details">
        <H2 className="mb-6">Details to check</H2>
        <Grid cols={2}>
          <Card
            title="Approval delays delivery; it does not take anything back"
            body="With approval timing, a vested tranche is delivered once the company approves it or when the approval window lapses. Approval does not change what has vested: a cancellation keeps every vested tranche, approved or not."
          />
          <Card
            title="Cancellation applies to the whole series"
            body="Cancelling stops future vesting for every recipient of the series. Each recipient keeps what has vested; before the cliff, each keeps the pre-cliff share, which the preset sets to 0. To end one person's vesting without affecting the others, give each grant its own series."
          />
          <Card
            title="Settings fixed at creation"
            body="Timing, delivery, the approval window, recovery, cancellation and the pre-cliff share are fixed when the series is created. Cancellation can later be turned off, never back on. With recovery on, a recipient's position can be moved to a replacement wallet if they lose their key."
          />
          <Card
            title="Calendar months in UTC"
            body="Unlocks are counted in calendar months from the vesting start, in UTC. A start on the 31st unlocks on the last day of shorter months, including 29 February in a leap year."
          />
          <Card
            title="Whole units"
            body="Share-class tokens are whole units. When an allocation is smaller than the number of monthly unlocks, a month that would unlock less than one unit is skipped and the units unlock at the next tranche; the total still equals the allocation."
          />
          <Card
            title="The plan itself stays off-chain"
            body="The series delivers tokens on its schedule. The plan behind it, meaning who is granted what, leaver terms, tax and employment matters, is the company's own document, prepared with its advisers."
          />
        </Grid>
      </Section>

      <Section id="references">
        <H2>Related reference</H2>
        <Body className="mt-3">
          {navHrefVisible(vestingGuide) ? (
            <>
              The <TextLink href={vestingGuide}>vesting guide</TextLink> covers
              funding, delivery, surplus and resuming an interrupted setup.
            </>
          ) : (
            <>Funding, delivery and recovery details are in the vesting guide where the module is offered.</>
          )}{" "}
          {navHrefVisible(positionsHref) ? (
            <>
              Recipients see their schedule in{" "}
              <TextLink href={positionsHref}>My vesting positions</TextLink>.
            </>
          ) : null}
        </Body>
      </Section>
    </>
  );
}
