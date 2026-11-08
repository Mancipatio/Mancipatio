// /migrations/<slug> — one token migration campaign in plain words: the
// ratio ("1 Manci unit for every L OLD; 1 unit = x % of <company>"), the
// shareholders' decision E, the granularity G, the units cap, the window,
// the Swap Terms document and its hash, the progress, and the proof table
// (every deposit with its wallet, amount, units, status and the deposit,
// delivery and refund transactions), then the final report and its SHA-256
// once the campaign completed. Server-rendered (indexable where the build
// allows it); drafts and unknown slugs are a 404. Everything shown is public
// on chain; a compliance hold reads only "Held for review".
import Link from "next/link";
import { notFound } from "next/navigation";
import { Body, Button, ButtonRow, H2, PageHeader, Section } from "@/components/mx";
import { detectNetwork, explorerAddressUrl, explorerTxUrl } from "@/lib/network";
import { navHrefVisible } from "@/lib/pilot-scope";
import { loadPublicMigration } from "@/lib/server/token-migrations-public";
import {
  DEPOSIT_STATUS_LABEL,
  MIGRATION_SOURCE_LABEL,
  MIGRATION_STATUS_LABEL,
  TOKEN_PROGRAM_2022,
  UNCLAIMED_POLICY_LABEL,
} from "@/lib/token-migration/model";
import { formatBaseUnits, formatEquityBps, formatPercentE4, formatUnits, unitPercent } from "@/lib/token-migration/ratio";
import type { PublicMigration } from "@/lib/token-migration/rows";
import { dateText, HowItWorks, MigrationModuleNotice, ratioWords } from "../shared";

export const dynamic = "force-dynamic";

async function load(slug: string): Promise<PublicMigration | null | "unavailable"> {
  try {
    return await loadPublicMigration(slug);
  } catch {
    return "unavailable";
  }
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const m = await load(slug);
  if (!m || m === "unavailable") return { title: "Token migration · Manci" };
  return {
    title: `${m.old_symbol} to ${m.company_name}: token migration · Manci`,
    description: `${ratioWords(m)}. Window ${dateText(m.window_opens_at)} to ${dateText(m.window_closes_at)}. Proof of every deposit and delivery.`,
  };
}

function short(value: string): string {
  return value.length > 12 ? `${value.slice(0, 4)}…${value.slice(-4)}` : value;
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-slate-100 py-2.5 sm:grid sm:grid-cols-[14rem_1fr] sm:gap-4">
      <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-1 break-words text-sm text-slate-800 sm:mt-0">{children}</dd>
    </div>
  );
}

export default async function MigrationCampaignPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const m = await load(slug);
  if (m === "unavailable") {
    return (
      <>
        <PageHeader eyebrow="Token migration" title="Campaign" />
        <Section><Body>This campaign is temporarily unavailable. Please try again shortly.</Body></Section>
      </>
    );
  }
  if (!m) notFound();
  const network = detectNetwork();
  const lot = BigInt(m.lot_base_units);
  const qualified = BigInt(m.old_total_supply) - BigInt(m.excluded_amount);
  const cap = BigInt(m.units_cap);
  const granularity = BigInt(m.granularity);
  const deposited = BigInt(m.progress.depositedBase);
  const delivered = BigInt(m.progress.unitsDelivered);
  const capPercent = formatPercentE4((cap * BigInt(1_000_000)) / granularity);
  const depositedShare = qualified > BigInt(0) ? formatPercentE4((deposited * BigInt(1_000_000)) / qualified) : "0.0000";
  const link = (href: string, text: string) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="font-mono text-brand-700 underline underline-offset-2">{text}</a>
  );
  return (
    <>
      <PageHeader eyebrow={`Token migration · ${MIGRATION_STATUS_LABEL[m.status]}`} title={`${m.old_name} (${m.old_symbol}) → ${m.company_name}`} lede={`${ratioWords(m)}.`}>
        {m.status === "open" && navHrefVisible("/portfolio/migration") && (
          <ButtonRow><Button href="/portfolio/migration">Deposit {m.old_symbol}</Button></ButtonRow>
        )}
      </PageHeader>

      <Section>
        <MigrationModuleNotice />
        <H2>The campaign</H2>
        <dl className="mt-4">
          <Fact label="Ratio">{formatUnits(BigInt(1))} unit for every {formatBaseUnits(lot, m.old_decimals)} {m.old_symbol} (the lot). Deposits are whole lots, at least one.</Fact>
          <Fact label="One unit">{unitPercent(granularity)} % of {m.company_name} ({formatUnits(granularity)} units make 100 %)</Fact>
          <Fact label="Share for the holders">{formatEquityBps(m.equity_bps)} % decided; at most {formatUnits(cap)} units ({capPercent} %) can be delivered, the lot being rounded up</Fact>
          <Fact label="Opt-in window">{dateText(m.window_opens_at)} to {dateText(m.window_closes_at)}</Fact>
          <Fact label="Where the units come from">{MIGRATION_SOURCE_LABEL[m.source]}. {UNCLAIMED_POLICY_LABEL[m.unclaimed_policy]}.</Fact>
          {m.terms_doc_url && (
            <Fact label="Swap Terms">
              <a href={m.terms_doc_url} target="_blank" rel="noopener noreferrer" className="text-brand-700 underline underline-offset-2">Read the document</a>
              {m.terms_doc_sha256 && <span className="mt-1 block break-all font-mono text-xs text-slate-500">SHA-256 {m.terms_doc_sha256}</span>}
            </Fact>
          )}
          <Fact label="Old token">{m.old_name} ({m.old_symbol}), {m.old_decimals} decimals, {m.old_token_program === TOKEN_PROGRAM_2022 ? "Token-2022" : "SPL Token"} mint {link(explorerAddressUrl(m.old_mint, network), short(m.old_mint))}</Fact>
          <Fact label="Qualified supply">
            {formatBaseUnits(qualified, m.old_decimals)} {m.old_symbol}: total supply {formatBaseUnits(BigInt(m.old_total_supply), m.old_decimals)} minus {formatBaseUnits(BigInt(m.excluded_amount), m.old_decimals)} excluded
            {m.excluded_wallets.length > 0 && ` (${m.excluded_wallets.length} excluded ${m.excluded_wallets.length === 1 ? "wallet" : "wallets"}, balances read on ${dateText(m.supply_read_at)})`}
            {m.excluded_note && <span className="mt-1 block text-xs text-slate-500">{m.excluded_note}</span>}
          </Fact>
          <Fact label="Deposit account">{link(explorerAddressUrl(m.deposit_ata, network), short(m.deposit_ata))} (owner {link(explorerAddressUrl(m.deposit_owner, network), short(m.deposit_owner))})</Fact>
          <Fact label="Share class units">mint {link(explorerAddressUrl(m.new_mint, network), short(m.new_mint))}, delivered from {link(explorerAddressUrl(m.treasury_wallet, network), short(m.treasury_wallet))}</Fact>
          {m.old_tokens_burn_tx && m.old_tokens_burned && (
            <Fact label="Collected tokens burned">{formatBaseUnits(BigInt(m.old_tokens_burned), m.old_decimals)} {m.old_symbol} in {link(explorerTxUrl(m.old_tokens_burn_tx, network), short(m.old_tokens_burn_tx))}</Fact>
          )}
          {m.status === "completed" && m.final_report_sha256 && (
            <Fact label="Final report">
              <a href={`/api/token-migrations/report?slug=${encodeURIComponent(m.slug)}`} className="text-brand-700 underline underline-offset-2">Download the report (JSON)</a>
              <span className="mt-1 block break-all font-mono text-xs text-slate-500">SHA-256 {m.final_report_sha256}</span>
            </Fact>
          )}
        </dl>
      </Section>

      <Section>
        <H2>Progress</H2>
        <dl className="mt-4">
          <Fact label="Old tokens deposited">{formatBaseUnits(deposited, m.old_decimals)} of {formatBaseUnits(qualified, m.old_decimals)} {m.old_symbol} ({depositedShare} % of the qualified supply)</Fact>
          <Fact label="Units delivered">{formatUnits(delivered)} of {formatUnits(cap)}{BigInt(m.progress.unitsDue) > BigInt(0) ? `; ${formatUnits(BigInt(m.progress.unitsDue))} more due` : ""}</Fact>
          <Fact label="Holders">{m.progress.holders}</Fact>
          {m.progress.refundsDue > 0 && <Fact label="Refunds due">{m.progress.refundsDue}</Fact>}
        </dl>
      </Section>

      <Section>
        <H2>Proof</H2>
        <Body className="mt-3">Every deposit recorded for this campaign, in chain order, with its transactions on the explorer.</Body>
        {m.deposits.length === 0 ? (
          <p className="mt-4 text-sm text-slate-600">No deposit recorded yet.</p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="min-w-[720px] text-left text-xs">
              <thead className="text-slate-500">
                <tr><th className="py-2 pr-4">Wallet</th><th className="py-2 pr-4">Deposited</th><th className="py-2 pr-4">Units</th><th className="py-2 pr-4">Status</th><th className="py-2 pr-4">Deposit</th><th className="py-2 pr-4">Delivery or refund</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-slate-700">
                {m.deposits.map((d) => (
                  <tr key={d.deposit_tx}>
                    <td className="py-2 pr-4">{link(explorerAddressUrl(d.holder_wallet, network), short(d.holder_wallet))}</td>
                    <td className="py-2 pr-4 font-mono">{formatBaseUnits(BigInt(d.amount_base), m.old_decimals)}</td>
                    <td className="py-2 pr-4 font-mono">{formatUnits(BigInt(d.units_due))}</td>
                    <td className="py-2 pr-4">{DEPOSIT_STATUS_LABEL[d.status]}{d.reason ? ` (${d.reason})` : ""}</td>
                    <td className="py-2 pr-4">{link(explorerTxUrl(d.deposit_tx, network), short(d.deposit_tx))}</td>
                    <td className="py-2 pr-4">
                      {d.delivery_tx ? link(explorerTxUrl(d.delivery_tx, network), short(d.delivery_tx)) : d.refund_tx ? link(explorerTxUrl(d.refund_tx, network), short(d.refund_tx)) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section>
        <H2>How it works</H2>
        <HowItWorks />
        <p className="mt-6 text-sm"><Link href="/migrations" className="text-brand-700 underline underline-offset-2">All campaigns</Link></p>
      </Section>
    </>
  );
}
