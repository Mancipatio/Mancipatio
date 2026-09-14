import { notFound } from "next/navigation";
import {
  Body,
  Bullets,
  Button,
  ButtonRow,
  Card,
  FootNote,
  Grid,
  H2,
  InstrumentCard,
  MX_ROUTES,
  PageHeader,
  Section,
  SectionHead,
  TextLink,
  TwoUp,
  type InstrumentRow,
} from "@/components/mx";
import {
  INSTRUMENT_LIST,
  TERM_FIELDS,
  instrumentBySlug,
  isNotApplicable,
  type InstrumentCta,
  type TermSet,
} from "@/lib/instruments";

/** Headings that contain an apostrophe live here rather than in JSX text. */
const HEADING_WHAT_IT_IS = "What it is";
const HEADING_WHO_ITS_FOR = "Who it's for";
const HEADING_DIFFERS = "What's different about issuing this one";
const HEADING_RECOURSE = "If the issuer doesn't perform";

export async function generateStaticParams() {
  return INSTRUMENT_LIST.map((instrument) => ({ slug: instrument.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const instrument = instrumentBySlug(slug);
  if (!instrument) {
    return { title: "Instrument · Mancipatio" };
  }
  return {
    title: `${instrument.label} · Mancipatio`,
    description: instrument.lede,
  };
}

/**
 * The same eight fields on every instrument page, fed from one data source.
 * A term that is not settled has no entry, and `InstrumentCard` drops the row
 * — an unresolved fact renders as nothing, never as "pending" or "TBD".
 */
function termRows(set: TermSet): InstrumentRow[] {
  return TERM_FIELDS.map((field) => {
    const value = set.terms[field.key];
    if (value === undefined) {
      return { label: field.label, value: null };
    }
    if (isNotApplicable(value)) {
      return { label: field.label, value: "Not applicable", tone: "na" };
    }
    return { label: field.label, value };
  });
}

function Ctas({ items }: { items: InstrumentCta[] }) {
  if (items.length === 0) return null;
  return (
    <ButtonRow>
      {items.map((cta) => (
        <Button key={cta.href} href={cta.href} variant={cta.variant}>
          {cta.label}
        </Button>
      ))}
    </ButtonRow>
  );
}

export default async function InstrumentPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const instrument = instrumentBySlug(slug);
  if (!instrument) {
    notFound();
  }

  const {
    label,
    lede,
    ctas,
    whatItIs,
    whoItsFor,
    factSheetEyebrow,
    factSheetTitle,
    factSheet,
    terms,
    typicalUse,
    differs,
    recourse,
  } = instrument;

  const factCards = factSheet.map((card) => (
    <Card key={card.heading} title={card.heading}>
      <Bullets className="mt-1.5" items={card.points} />
    </Card>
  ));

  return (
    <>
      <PageHeader eyebrow="Asset guide" title={label} lede={lede}>
        <Ctas items={ctas} />
      </PageHeader>

      {whatItIs || whoItsFor ? (
        <Section>
          {whatItIs ? (
            <>
              <H2>{HEADING_WHAT_IT_IS}</H2>
              {whatItIs.map((paragraph, i) => (
                <Body key={i} className="mt-4">
                  {paragraph}
                </Body>
              ))}
            </>
          ) : null}
          {whoItsFor ? (
            <>
              <H2 className={whatItIs ? "mt-10" : undefined}>
                {HEADING_WHO_ITS_FOR}
              </H2>
              <Bullets className="mt-4" items={whoItsFor} />
            </>
          ) : null}
        </Section>
      ) : null}

      {factSheet.length > 0 ? (
        <Section>
          <SectionHead eyebrow={factSheetEyebrow} title={factSheetTitle} />
          {factSheet.length >= 3 ? (
            <Grid cols={3} className="mt-7">
              {factCards}
            </Grid>
          ) : (
            <TwoUp className="mt-7 max-w-[900px]">{factCards}</TwoUp>
          )}
        </Section>
      ) : null}

      {terms.length > 0 ? (
        <Section>
          <SectionHead eyebrow="The instrument" title="Terms at a glance" />
          <TwoUp className="mt-6">
            {terms.map((set) => (
              <InstrumentCard
                key={set.title}
                title={set.title}
                rows={termRows(set)}
              />
            ))}
          </TwoUp>
          {typicalUse ? (
            <FootNote className="mt-4">Typical use: {typicalUse}</FootNote>
          ) : null}
        </Section>
      ) : null}

      {differs ? (
        <Section>
          <H2>{HEADING_DIFFERS}</H2>
          {differs.map((paragraph, i) => (
            <Body key={i} className="mt-4">
              {paragraph}
            </Body>
          ))}
          <p className="mt-5">
            <TextLink href={MX_ROUTES.howItWorks}>
              The full process →
            </TextLink>
          </p>
        </Section>
      ) : null}

      {recourse ? (
        <Section>
          <H2>{HEADING_RECOURSE}</H2>
          {recourse.map((paragraph, i) => (
            <Body key={i} className="mt-4">
              {paragraph}
            </Body>
          ))}
        </Section>
      ) : null}
    </>
  );
}
