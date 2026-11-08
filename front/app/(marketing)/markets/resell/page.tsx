import { Suspense } from "react";
import { Body, Button, ButtonRow, H2, PageHeader, Section, TextLink } from "@/components/mx";
import { SkeletonTable } from "@/components/skeleton";
import { PilotModuleNotice } from "@/components/pilot-module-notice";
import { moduleRouteState } from "@/lib/pilot-scope";
import { indexingAllowed } from "@/lib/indexing";
import { ResellBoard } from "./resell-board";
import { RuntimePauseNotice } from "@/components/runtime-pause-notice";

// Secondary trading switched off (or paused by KYC-only mode): the page shows
// the notice, the description says so, and where the build allows indexing it
// is noindex, like the guide of a switched-off module (lib/indexing.ts).
const resellOff = moduleRouteState("/markets/resell")?.disabled === true;

export const metadata = {
  title: "Resell board · Manci",
  description: resellOff
    ? "The resell board is not available at the moment."
    : "Holder listings and live OTC offers for tokenized assets on Manci.",
  ...(resellOff && indexingAllowed() ? { robots: { index: false, follow: true } } : {}),
};

export default function ResellPage() {
  // Pilot scope: the resell board belongs to secondary trading.
  const moduleState = moduleRouteState("/markets/resell");
  if (moduleState?.disabled) {
    return <>
      <PageHeader eyebrow="Secondary market" title="Resell board" lede="Holder listings and OTC offers." />
      <Section><PilotModuleNotice state={moduleState} gate /></Section>
    </>;
  }
  return <>
    <PageHeader eyebrow="Secondary market" title="Resell board"
      lede="Browse holder listings, review their terms and open the corresponding asset or OTC offer.">
      <ButtonRow>
        <Button href="/marketplace/otc">Browse OTC offers</Button>
        <Button href="/portfolio/listings" variant="ghost">My sell listings</Button>
      </ButtonRow>
    </PageHeader>
    <Section>
      <RuntimePauseNotice path="/markets/resell" />
      <Suspense fallback={<SkeletonTable rows={4} cols={6} />}><ResellBoard /></Suspense>
    </Section>
    <Section>
      <H2>From a listing to a trade</H2>
      <Body className="mt-3">A holder listing expresses an intention to sell. An OTC offer records the actual settlement terms and funding. Review the asset documents and the offer status before taking action.</Body>
      <div className="mt-4"><TextLink href="/solutions/otc">Read the OTC guide →</TextLink></div>
    </Section>
  </>;
}
