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
  SectionHead,
  Small,
  instrumentHref,
  type TableCell,
  type TableRow,
} from "@/components/mx";
import {
  INSTRUMENT_LIST,
  isNotApplicable,
  TERM_FIELDS,
  termLabel,
  type TermKey,
  type TermSet,
  type TermValue,
} from "@/lib/instruments";
import { scopeEnabled } from "@/lib/features";

import { assetClassOffered } from "@/lib/pilot-scope";

const introduction = "Explore the instruments available on Manci and the rights they carry. The terms of every issuance are published on the platform.";

export const metadata = {
  title: "Asset types · Manci",
  description: introduction,
};

/** lib/instruments.ts settledTermKeys(), over the rows of the offered asset
 *  classes only (lib/asset-classes.ts): a column is kept when every row
 *  shown answers it. */
function settledKeysFor(sets: readonly TermSet[]): TermKey[] {
  return TERM_FIELDS.filter((f) => sets.every((s) => s.terms[f.key] !== undefined)).map((f) => f.key);
}

/** A settled answer is printed as written; "not applicable" is a dash, which
 *  the legend below explains. There is no third state on this page: a term
 *  that is not settled is dropped from the table entirely, so `undefined`
 *  cannot reach a cell — `settledKeysFor()` only returns keys every row
 *  shown answers. */
function cell(value: TermValue | undefined): TableCell {
  if (value === undefined || isNotApplicable(value)) {
    return { value: "—", tone: "na" };
  }
  return value;
}

export default function InstrumentsIndexPage() {
  // Offered asset classes only (lib/asset-classes.ts; equity on mainnet).
  const instruments = INSTRUMENT_LIST.filter((i) => assetClassOffered(i.slug));
  const sets = instruments.flatMap((i) => i.terms);
  const keys = settledKeysFor(sets);
  const columns = [
    "Instrument",
    "The right it carries",
    ...keys.map(termLabel),
  ];
  const rows: TableRow[] = sets.map((set) => ({
    header: set.title,
    cells: [set.right, ...keys.map((key) => cell(set.terms[key]))],
  }));

  return (
    <>
      <PageHeader title="Asset types" lede={introduction} />

      <Section>
        <SectionHead title="Available asset types" />
        <Grid cols={instruments.length === 1 ? 2 : 4} className="mt-7">
          {instruments.map((instrument) => (
            <Card
              key={instrument.slug}
              title={instrument.slug === "equity" ? "Company ownership." : instrument.label}
              body={instrument.blurb}
              href={instrumentHref(instrument.slug)}
            />
          ))}
        </Grid>
        <Body className="mt-4">
          Each instrument page explains what the token is, who it&apos;s for, its terms at a glance and what happens if the issuer doesn&apos;t perform.
        </Body>
      </Section>

      {instruments.length > 1 && (
        <Section>
          <Small className="mb-2.5">
            Scroll the table sideways on a narrow screen →
          </Small>
          <DataTable
            columns={columns}
            rows={rows}
            minWidth={860}
            caption="The rights each instrument carries, side by side"
          />
          <FootNote className="mt-3">
            A dash means not applicable to this instrument.
          </FootNote>
          {(assetClassOffered("real_estate") || assetClassOffered("other")) && (
            <FootNote className="mt-2">
              {assetClassOffered("real_estate") &&
                "Real estate appears twice because rental income and ownership carry different rights."}
              {assetClassOffered("real_estate") && assetClassOffered("other") && " "}
              {assetClassOffered("other") &&
                "Bespoke structures under Other have no standard terms, so they are not listed here."}
            </FootNote>
          )}
        </Section>
      )}

      <Section>
        <H2>Discuss your issuance</H2>
        <Body className="mt-4">
          {/* KYC-only mode (lib/features.ts): applications are paused; the
              contact form stays. */}
          {scopeEnabled("issuance")
            ? "Tell us what you have. A real person reviews every application. If our model isn't right for your project, we'll tell you."
            : "Tell us what you have. A person reads every message and comes back either way — including to say that none of these instruments is right for it."}
        </Body>
        <ButtonRow>
          <Button href={MX_ROUTES.apply}>Apply to issue</Button>
          <Button href={MX_ROUTES.contact} variant="ghost">
            Tell us your idea
          </Button>
        </ButtonRow>
      </Section>
    </>
  );
}
