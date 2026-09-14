import { Suspense } from "react";
import { Body, Button, ButtonRow, H2, PageHeader, Section, TextLink } from "@/components/mx";
import { SkeletonTable } from "@/components/skeleton";
import { ResellBoard } from "./resell-board";

export const metadata = {
  title: "Resell board · Mancipatio",
  description: "Holder listings and live OTC offers for tokenized assets on Mancipatio.",
};

export default function ResellPage() {
  return <>
    <PageHeader eyebrow="Secondary market" title="Resell board"
      lede="Browse holder listings, review their terms and open the corresponding asset or OTC offer.">
      <ButtonRow>
        <Button href="/marketplace/otc">Browse OTC offers</Button>
        <Button href="/portfolio/listings" variant="ghost">My sell listings</Button>
      </ButtonRow>
    </PageHeader>
    <Section>
      <Suspense fallback={<SkeletonTable rows={4} cols={6} />}><ResellBoard /></Suspense>
    </Section>
    <Section>
      <H2>From a listing to a trade</H2>
      <Body className="mt-3">A holder listing expresses an intention to sell. An OTC offer records the actual settlement terms and funding. Review the asset documents and the offer status before taking action.</Body>
      <div className="mt-4"><TextLink href="/solutions/otc">Read the OTC guide →</TextLink></div>
    </Section>
  </>;
}
