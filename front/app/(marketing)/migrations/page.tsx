// /migrations — the public list of token migration campaigns (every campaign
// that has opened: open, closed, completed or cancelled; drafts never show).
// Rendered on the server from lib/server/token-migrations-public.ts so the
// facts are in the page for readers and search engines alike; indexable
// where the build allows indexing (lib/indexing.ts). While the module is off
// the page says so above the campaigns, which stay: their proof is public.
import Link from "next/link";
import { Body, Button, ButtonRow, EmptyState, H2, PageHeader, Section } from "@/components/mx";
import { loadPublicMigrations, type PublicMigrationSummary } from "@/lib/server/token-migrations-public";
import { navHrefVisible } from "@/lib/pilot-scope";
import { MIGRATION_STATUS_LABEL } from "@/lib/token-migration/model";
import { formatBaseUnits, formatUnits } from "@/lib/token-migration/ratio";
import { dateText, HowItWorks, MigrationModuleNotice, ratioWords } from "./shared";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Token migrations · Manci",
  description:
    "Companies that already issued a token on Solana can move their holders onto Manci: holders exchange the token for units of the company's share class at a published ratio.",
};

function CampaignCard({ m }: { m: PublicMigrationSummary }) {
  const qualified = BigInt(m.old_total_supply) - BigInt(m.excluded_amount);
  return (
    <article className="rounded-xl border border-slate-200 bg-white p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-lg font-semibold text-slate-900">
          <Link href={`/migrations/${m.slug}`} className="hover:underline">{m.old_name} ({m.old_symbol}) → {m.company_name}</Link>
        </h3>
        <span className="mx-badge">{MIGRATION_STATUS_LABEL[m.status]}</span>
      </div>
      <p className="mt-2 text-sm text-slate-700">{ratioWords(m)}.</p>
      <dl className="mt-3 grid gap-x-6 gap-y-1 text-xs text-slate-600 sm:grid-cols-2">
        <div><dt className="inline font-medium">Window: </dt><dd className="inline">{dateText(m.window_opens_at)} to {dateText(m.window_closes_at)}</dd></div>
        <div><dt className="inline font-medium">Holders: </dt><dd className="inline">{m.progress.holders}</dd></div>
        <div><dt className="inline font-medium">Deposited: </dt><dd className="inline">{formatBaseUnits(BigInt(m.progress.depositedBase), m.old_decimals)} of {formatBaseUnits(qualified, m.old_decimals)} {m.old_symbol}</dd></div>
        <div><dt className="inline font-medium">Units delivered: </dt><dd className="inline">{formatUnits(BigInt(m.progress.unitsDelivered))} of {formatUnits(BigInt(m.units_cap))}</dd></div>
      </dl>
      <p className="mt-3 text-sm"><Link href={`/migrations/${m.slug}`} className="text-brand-700 underline underline-offset-2">Campaign facts and proof →</Link></p>
    </article>
  );
}

export default async function MigrationsPage() {
  let campaigns: PublicMigrationSummary[] = [];
  let unavailable = false;
  try {
    campaigns = await loadPublicMigrations();
  } catch {
    unavailable = true;
  }
  const live = campaigns.filter((m) => m.status === "open");
  const past = campaigns.filter((m) => m.status !== "open");
  return (
    <>
      <PageHeader
        eyebrow="Token migration"
        title="Move a token community onto Manci."
        lede="A company that already issued a token on Solana can give its holders units of its share class on Manci. Holders deposit the old token during an opt-in window and receive units at a ratio published in advance."
      >
        {navHrefVisible("/portfolio/migration") && (
          <ButtonRow>
            <Button href="/portfolio/migration">Migrate a token</Button>
          </ButtonRow>
        )}
      </PageHeader>
      <Section>
        <MigrationModuleNotice />
        <H2>Open campaigns</H2>
        {unavailable ? (
          <Body className="mt-4">The campaigns are temporarily unavailable. Please try again shortly.</Body>
        ) : live.length === 0 ? (
          <EmptyState className="mt-4" title="No campaign is open right now." hint="Open campaigns appear here with their ratio, window and Swap Terms." />
        ) : (
          <div className="mt-6 grid gap-4">{live.map((m) => <CampaignCard key={m.id} m={m} />)}</div>
        )}
      </Section>
      {past.length > 0 && (
        <Section>
          <H2>Closed and past campaigns</H2>
          <div className="mt-6 grid gap-4">{past.map((m) => <CampaignCard key={m.id} m={m} />)}</div>
        </Section>
      )}
      <Section>
        <H2>How a migration works</H2>
        <HowItWorks />
        <Body className="mt-6">
          Units are tokens of the company&apos;s share class, held in the holder&apos;s own wallet. The Swap Terms of each campaign
          define what the units represent; the exchange itself needs no identity verification, while converting units into a
          registered ownership stake later is a separate step that requires KYC, where it is offered.
        </Body>
      </Section>
    </>
  );
}
