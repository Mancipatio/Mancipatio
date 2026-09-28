import { Body, Button, ButtonRow, PageHeader, Section, TextLink } from "@/components/mx";

// Shown in place of an app page when the visitor's country is on the
// operator's geoblock list (proxy.ts, lib/geoblock.ts; 8.5). The list is
// counsel's decision (GEOBLOCK_COUNTRIES).
export const metadata = {
  title: "Not available in your country · Manci",
  description: "Manci's services are not offered in your country.",
  robots: { index: false, follow: false },
};

export default function NotAvailablePage() {
  return <>
    <PageHeader eyebrow="Availability" title="Not available in your country"
      lede="Manci's investment services are not offered where you are connecting from.">
      <ButtonRow>
        <Button href="/">Back to the homepage</Button>
        <Button href="/contact" variant="ghost">Contact support</Button>
      </ButtonRow>
    </PageHeader>
    <Section>
      <Body>
        The platform does not serve every country: the operator excludes the
        countries its legal advisers name, including jurisdictions under
        comprehensive sanctions. Your location is estimated from your
        connection, so no purchase, trade, listing, passport or verification
        can be started from here.
      </Body>
      <Body className="mt-3">
        If you already hold tokens and need to close a position, or you believe
        your location was detected wrongly, contact support.
      </Body>
      <div className="mt-4"><TextLink href="/legal/terms">Read the eligibility terms →</TextLink></div>
    </Section>
  </>;
}
