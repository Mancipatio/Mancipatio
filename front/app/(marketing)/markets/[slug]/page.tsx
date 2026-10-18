import { notFound } from "next/navigation";
import { Button, ButtonRow, Card, Grid, PageHeader, Section, TextLink } from "@/components/mx";
import { CATEGORY_SLUGS, assetTypeBySlug, type CategorySlug } from "@/lib/asset-types";
import { ASSET_CLASS_NOT_OFFERED, assetClassOffered, navHrefVisible } from "@/lib/pilot-scope";
import { indexingAllowed } from "@/lib/indexing";
import { CategoryOffers } from "./category-offers";

// All eight, offered or not (lib/asset-classes.ts): a class that is not
// offered keeps its URL and shows a notice (noindex).
export async function generateStaticParams() {
  return CATEGORY_SLUGS.map((slug) => ({ slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const record = assetTypeBySlug(slug);
  if (!record) {
    return { title: "Market · Manci" };
  }
  if (!assetClassOffered(record.slug)) {
    // A page's robots replaces the root layout's (lib/indexing.ts): only
    // where the build allows indexing is a noindex needed; elsewhere the
    // root's stricter policy (noindex, nofollow) stays.
    return { title: `${record.title} · Manci`, ...(indexingAllowed() ? { robots: { index: false, follow: true } } : {}) };
  }
  return {
    title: `${record.title} · Live market · Manci`,
    description: `Published ${record.title.toLowerCase()} listings on Manci. ${record.oneLine}`,
  };
}

export default async function CategoryMarketPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const record = assetTypeBySlug(slug);
  if (!record) notFound();
  // A class that is not offered on this network (lib/asset-classes.ts): the
  // notice only, no listings.
  if (!assetClassOffered(record.slug)) {
    return <PageHeader eyebrow={`${record.code} / Asset market`} title={record.title} lede={ASSET_CLASS_NOT_OFFERED}>
      <ButtonRow>
        <Button href="/marketplace" variant="ghost">Explore all assets</Button>
      </ButtonRow>
    </PageHeader>;
  }
  return <>
    <PageHeader eyebrow={`${record.code} / Asset market`} title={record.title} lede={record.oneLine}>
      <ButtonRow>
        <Button href="/marketplace">Explore all assets</Button>
        <Button href={`/markets/types/${slug}`} variant="ghost">Read the asset guide</Button>
      </ButtonRow>
    </PageHeader>
    <Section><CategoryOffers slug={record.slug as CategorySlug} title={record.title} /></Section>
    <Section>
      <Grid cols={2}>
        {/* The resell board is secondary trading (lib/pilot-scope.ts). */}
        {navHrefVisible("/markets/resell") && <Card title="Holder listings" body="Find resale listings and compare the available terms.">
          <TextLink href={`/markets/resell?type=${slug}`}>Open the resell board →</TextLink>
        </Card>}
        <Card title="Understand the instrument" body="Read the category guide, then check the documents of the specific issuance.">
          <TextLink href={`/markets/types/${slug}`}>Read the asset guide →</TextLink>
        </Card>
      </Grid>
    </Section>
  </>;
}
