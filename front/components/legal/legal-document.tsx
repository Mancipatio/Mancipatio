import type { ReactNode } from "react";
import { Body, Bullets, H2, PageHeader, Section, Small } from "@/components/mx";
import type { LegalClause, LegalDocument } from "@/lib/legal/document";

/**
 * Renders a LegalDocument (counsel's mainnet text, lib/legal/mainnet-copy.ts)
 * in the same presentation as the devnet Terms: page header with "Last
 * updated", then numbered clauses. `before` and `after` take the blocks the
 * page generates from the operator record (who operates the Service,
 * governing law, contacts), so counsel's text never repeats them.
 */
export function LegalDocumentView({
  title,
  document,
  before,
  after,
}: {
  title: string;
  document: LegalDocument;
  before?: ReactNode;
  after?: ReactNode;
}) {
  return (
    <>
      <PageHeader eyebrow="Legal" title={title} lede={document.lede}>
        <Small className="mt-5">Last updated: {document.lastUpdated}</Small>
      </PageHeader>
      {before}
      <Section>
        {document.clauses.map((clause, index) => (
          <ClauseView key={clause.title} clause={clause} first={index === 0} />
        ))}
      </Section>
      {after}
    </>
  );
}

/** Shown on a mainnet `next dev` before counsel's text is in the slot (a
 *  mainnet build refuses to ship this state). */
export function LegalDocumentMissing({ title }: { title: string }) {
  return (
    <>
      <PageHeader eyebrow="Legal" title={title} />
      <Section>
        <Body>This document has not been published yet.</Body>
      </Section>
    </>
  );
}

function ClauseView({ clause, first }: { clause: LegalClause; first: boolean }) {
  return (
    <div className={first ? undefined : "mt-10"}>
      <H2 className="text-[19px] leading-snug tracking-normal">{clause.title}</H2>
      <div className="mt-4 space-y-3.5">
        {clause.blocks.map((block, index) =>
          block.kind === "paragraph" ? (
            <Body key={index}>{block.text}</Body>
          ) : (
            <Bullets key={index} items={block.items} />
          ),
        )}
      </div>
    </div>
  );
}
