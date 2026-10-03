"use client";

// The sale page's Overview tab: first the legal blocks (`lead`: the
// investment documents and the risk warning, beside the buy card), then the
// token summary of a tokenized share class (lib/sale-page tokenSummaryLines),
// then the issuer's pitch — only the sections that have something to say (a
// tokenized sale has no application, so "The problem — / Why now —" never
// shows empty).

import type { ReactNode } from "react";
import { InfoBox } from "@/components/launchpad/primitives";
import type { LaunchListing, PublicApplication } from "@/lib/launchpad";

export function SaleOverview({
  listing,
  app,
  lead,
  tokenSummary = [],
  about = null,
  company,
}: {
  listing: LaunchListing | null;
  app: PublicApplication | null;
  /** The legal blocks shown first. */
  lead?: ReactNode;
  /** The token summary lines of a tokenized share class (empty: none). */
  tokenSummary?: readonly string[];
  /** The asset profile's description, shown when the application says nothing. */
  about?: string | null;
  company: string;
}) {
  const problem = listing?.problem ?? app?.problem_or_why;
  const whyNow = listing?.why_now;
  const tractionEntries = Object.entries(listing?.traction ?? {});
  const investors = app?.existing_investors ?? listing?.existing_investors;
  const aboutText = !problem && !whyNow ? about?.trim() : null;

  return (
    <div className="space-y-8">
      {lead && <div className="space-y-4">{lead}</div>}

      {tokenSummary.length > 0 && (
        <section data-sale-token-summary="">
          <h2 className="mb-3 text-[15px] font-semibold text-mx-ink">The tokens</h2>
          <ul className="space-y-1.5 text-sm leading-relaxed text-mx-ink-soft">
            {tokenSummary.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>
      )}

      {aboutText && (
        <section>
          <h2 className="mb-3 text-[15px] font-semibold text-mx-ink">About {company}</h2>
          <p className="whitespace-pre-line text-sm leading-relaxed text-mx-ink-soft">{aboutText}</p>
        </section>
      )}

      {problem && (
        <section>
          <h2 className="mb-3 text-[15px] font-semibold text-mx-ink">The problem</h2>
          <p className="text-sm leading-relaxed text-mx-ink-soft">{problem}</p>
        </section>
      )}

      {whyNow && (
        <section>
          <h2 className="mb-3 text-[15px] font-semibold text-mx-ink">Why now</h2>
          <p className="text-sm leading-relaxed text-mx-ink-soft">{whyNow}</p>
        </section>
      )}

      {tractionEntries.length > 0 && (
        <section>
          <h2 className="mb-3 text-[15px] font-semibold text-mx-ink">Traction</h2>
          <div className="grid grid-cols-3 gap-3">
            {tractionEntries.map(([key, value]) => (
              <div key={key} className="rounded-[3px] border border-mx-rule bg-white p-4 text-center">
                <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-mx-ink-faint">{key}</p>
                <p className="mt-1.5 text-xl font-semibold text-mx-indigo">{value}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      {investors && (
        <section>
          <InfoBox>
            <p className="mb-1 font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-mx-ink-faint">Notable investors</p>
            <p className="font-medium text-mx-ink">{investors}</p>
          </InfoBox>
        </section>
      )}
    </div>
  );
}
