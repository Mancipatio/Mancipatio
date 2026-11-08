import type { Metadata } from "next";
import { cache } from "react";
import {
  Body,
  Button,
  ButtonRow,
  Card,
  DataTable,
  FootNote,
  Grid,
  H2,
  MX_ROUTES,
  PageHeader,
  Section,
  TextLink,
  type TableRow,
} from "@/components/mx";

import { navHrefVisible } from "@/lib/pilot-scope";
import { describeFee, formatFeeDate } from "@/lib/fees/quote";
import {
  FEE_KIND_INVOICED_WHEN,
  FEE_KIND_LABEL,
  FEE_PAYER_LABEL,
  feeServiceOffered,
  type PublicFee,
} from "@/lib/fees/schedule";
import { loadPublishedFees } from "@/lib/server/fee-schedule";

// The price list is the published rows of fee_schedule (migration 0089),
// read on every request: an admin's publish or retire shows on the next
// view, with no deployment. Three states, each truthful on its own:
//   * nothing published (or 0089 not applied yet): the launch-phase page,
//     word for word as it was before the schedule existed;
//   * published fees: the table (what, who pays, how much, when it is
//     invoiced) and the pass-through of third-party costs;
//   * the schedule could not be read: no claim either way, and a way to ask.
// A fee whose service this build does not offer (lib/fees/schedule.ts
// FEE_KIND_SCOPE: KYC-only mode, a module switched off, token migration) is
// listed "where offered", never as an available service.
export const dynamic = "force-dynamic";

const TITLE = "Pricing — Manci";

const LAUNCH_DESCRIPTION =
  "No platform fees during the launch phase. SPV incorporation, legal drafting and regulatory filings are third-party costs, quoted per engagement before any work starts.";

/** `checkedAt`: when the fees were read, what "applies from" is judged against. */
type Schedule = { state: "none" } | { state: "published"; fees: PublicFee[]; checkedAt: number } | { state: "unavailable" };

/** One read per request, shared by the metadata and the page. */
const loadSchedule = cache(async (): Promise<Schedule> => {
  try {
    const fees = await loadPublishedFees();
    return fees.length > 0 ? { state: "published", fees, checkedAt: Date.now() } : { state: "none" };
  } catch {
    return { state: "unavailable" };
  }
});

export async function generateMetadata(): Promise<Metadata> {
  const schedule = await loadSchedule();
  if (schedule.state === "published") {
    return {
      title: TITLE,
      description:
        "Manci's published fees: what each service costs, who pays and when it is invoiced. Third-party costs are passed through at cost and quoted before work starts.",
    };
  }
  if (schedule.state === "unavailable") {
    return {
      title: TITLE,
      description: "What Manci charges, who pays and when it is invoiced. Third-party costs are quoted before work starts.",
    };
  }
  return { title: TITLE, description: LAUNCH_DESCRIPTION };
}

const ENGAGEMENT: Array<{ title: string; body: string }> = [
  {
    title: "Structuring",
    body: "Legal and commercial structuring of the instrument, shaped to your deal.",
  },
  {
    title: "SPV incorporation",
    body: "Where Serbian law requires one, incorporated and administered for the issuance.",
  },
  {
    title: "Tokenisation",
    body: "Token design, on-chain issuance, and the compliance rails.",
  },
  {
    title: "Whitepaper",
    body: "Drafting and publication of the whitepaper or basic token information.",
  },
  {
    title: "Distribution rails",
    body: navHrefVisible("/marketplace/otc") ? "Primary sales and secondary trading through OTC escrow." : "The approved primary sale and allocation process.",
  },
];

function EngagementSection() {
  return (
    <Section>
      <H2 className="mb-6">What an engagement covers</H2>
      <Grid cols={3}>
        {ENGAGEMENT.map((e) => (
          <Card key={e.title} title={e.title} body={e.body} />
        ))}
      </Grid>
      <ButtonRow>
        <Button href={MX_ROUTES.apply}>Apply to issue</Button>
      </ButtonRow>
    </Section>
  );
}

function NotOursSection() {
  return (
    <Section>
      <H2>What is not ours</H2>
      <Body className="mt-4">
        SPV incorporation, legal drafting and regulatory filings are real
        third-party costs. They&rsquo;re quoted per engagement before any work
        starts. Nothing is charged on-chain.
      </Body>
    </Section>
  );
}

/** Before any fee is published: the launch-phase page, unchanged. */
function LaunchPricing() {
  return (
    <>
      <PageHeader
        eyebrow="Pricing"
        title="No platform fees during the launch phase."
        lede="We're not charging issuers or holders while we onboard our first cohort. When we introduce platform fees, existing issuers will be told before anything changes."
      />

      <NotOursSection />

      <EngagementSection />
    </>
  );
}

/** The table rows, one per published fee, in display order. */
function feeRows(fees: PublicFee[], now: number): { rows: TableRow[]; upcoming: boolean } {
  const upcoming = fees.some((fee) => Date.parse(fee.effective_from) > now);
  const seen = new Set<string>();
  const rows = fees.map((fee) => {
    let label = fee.public_label.trim();
    // Row headers key the table: two prices with one label stay apart.
    if (seen.has(label)) label = `${label} (${FEE_KIND_LABEL[fee.kind]})`;
    seen.add(label);
    const header = feeServiceOffered(fee.kind) ? label : `${label} (where offered)`;
    const cells = [FEE_PAYER_LABEL[fee.payer], describeFee(fee), FEE_KIND_INVOICED_WHEN[fee.kind]];
    if (upcoming) cells.push(Date.parse(fee.effective_from) > now ? formatFeeDate(fee.effective_from) : "In effect");
    return { header, cells };
  });
  return { rows, upcoming };
}

function PublishedPricing({ fees, checkedAt }: { fees: PublicFee[]; checkedAt: number }) {
  const { rows, upcoming } = feeRows(fees, checkedAt);
  const notes = fees.filter((fee) => fee.public_note.trim());
  return (
    <>
      <PageHeader
        eyebrow="Pricing"
        title="What Manci charges."
        lede="The published fees for Manci's services: who pays, how much and when it is invoiced. Fees are invoiced in euros; nothing is charged on-chain."
      />

      <Section>
        <H2 className="mb-6">Published fees</H2>
        <DataTable
          caption="Manci's published fees"
          columns={["Service", "Who pays", "How much", "When it is invoiced", ...(upcoming ? ["Applies from"] : [])]}
          rows={rows}
          minWidth={upcoming ? 900 : 760}
        />
        {notes.map((fee) => (
          <FootNote key={fee.kind} className="mt-3">
            {fee.public_label.trim()}: {fee.public_note.trim()}
          </FootNote>
        ))}
        <FootNote className="mt-3">
          A fee applies only where its service is offered. You pay the Solana
          network fees of your own transactions.
        </FootNote>
      </Section>

      <Section>
        <H2>Third-party costs</H2>
        <Body className="mt-4">
          Third-party costs (legal drafting, SPV incorporation, notary,
          business register) are passed through at cost and quoted before work
          starts.
        </Body>
      </Section>

      <EngagementSection />
    </>
  );
}

/** The schedule could not be read: no claim about fees either way. */
function UnavailablePricing() {
  return (
    <>
      <PageHeader
        eyebrow="Pricing"
        title="Pricing"
        lede={
          <>
            The fee schedule could not be loaded right now. Please reload the
            page, or <TextLink href={MX_ROUTES.contact}>contact us</TextLink> for
            current pricing.
          </>
        }
      />

      <NotOursSection />

      <EngagementSection />
    </>
  );
}

export default async function PricingPage() {
  const schedule = await loadSchedule();
  if (schedule.state === "published") return <PublishedPricing fees={schedule.fees} checkedAt={schedule.checkedAt} />;
  if (schedule.state === "unavailable") return <UnavailablePricing />;
  return <LaunchPricing />;
}
