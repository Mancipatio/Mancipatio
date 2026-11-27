import Link from "next/link";
import { DataTable } from "@/components/mx/data-table";

const milestones = [
  "Each token carries the right to request conversion into 0.01% of the company's share capital.",
  "The equity interest behind the tokens is under a registered pledge (lien) in the Serbian Pledge Register: APR decision no. 6526/2026 of 12 October 2026, covering 15% of the company's share capital.",
  "250 tokens were converted: government agency registered the transfer on 9 October 2026, and the tokens were burned the next day. The conversion record below shows the agency’s decision.",
  "Manci ran the conversion escrow and the burn on Solana, and recorded the agency’s decision.",
];

const ownershipFacts = [
  ["1 unit", "Right to acquire 0.01% of the share capital"],
  ["Class cap", "1,750 units (right to acquire up to 17.5% of the share capital)"],
  ["Voting rights", "Yes, once your token becomes an ownership stake"],
  ["Convertible into registered equity", "Yes"],
  ["Registered lien", "Yes"],
  ["Allocation covered by the lien", "1,500 tokens"],
  ["Public offering", "None, it was a private placement."],
];

export function ManciCaseStudy({ conversionHref }: { conversionHref: string | null }) {
  return (
    <>
      <section className="mt-10" aria-labelledby="manci-milestones">
        <h2 id="manci-milestones" className="text-lg font-semibold text-mx-ink">Already done</h2>
        <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-relaxed text-mx-ink-soft">
          {milestones.map((line) => <li key={line}>{line}</li>)}
        </ul>
      </section>
      <section className="mt-8" aria-labelledby="manci-register">
        <h2 id="manci-register" className="text-lg font-semibold text-mx-ink">Verify it yourself</h2>
        <p className="mt-3 max-w-3xl text-sm leading-relaxed text-mx-ink-soft">
          {"You'd check a token on the blockchain before buying it. Check the company the same way: its owners, their stakes and the lien behind the tokens are all in the Serbian state register, open to anyone."}
        </p>
        <p className="mt-2 text-sm text-mx-ink">
          Mancipatio d.o.o. Beograd, registration no. 22213415 · <a className="underline underline-offset-2" href="https://www.apr.gov.rs">APR</a>
        </p>
      </section>
      <section className="mt-8" aria-labelledby="manci-ownership-facts">
        <h2 id="manci-ownership-facts" className="text-lg font-semibold text-mx-ink">Company ownership facts</h2>
        <DataTable
          className="mt-3 [&_tbody_th]:whitespace-normal"
          caption="Company ownership facts"
          columns={["Field", "Value"]}
          minWidth={0}
          rows={ownershipFacts.map(([header, value]) => ({ header, cells: [value] }))}
        />
        <div className="mt-4 flex flex-wrap gap-4 text-sm text-mx-ink-soft underline underline-offset-2">
          {conversionHref && <Link href={conversionHref}>Request conversion</Link>}
          <Link href="/risks">Risk disclosure</Link>
          <Link href="/pricing">Fees &amp; costs</Link>
          <Link href="/legal/terms">Terms of Service</Link>
        </div>
      </section>
    </>
  );
}
