import { notFound } from "next/navigation";
import { Button, ButtonRow, Card, Grid, PageHeader, Section, TextLink } from "@/components/mx";
import { CATEGORY_SLUGS, assetTypeBySlug, type CategorySlug } from "@/lib/asset-types";
import { CategoryOffers } from "./category-offers";

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
    return { title: "Market · Mancipatio" };
  }
  return {
    title: `${record.title} · Live market · Mancipatio`,
    description: `Published ${record.title.toLowerCase()} listings on Mancipatio. ${record.oneLine}`,
  };
}

export default async function CategoryMarketPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const record = assetTypeBySlug(slug);
  if (!record) notFound();
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
        <Card title="Holder listings" body="Find resale listings and compare the available terms.">
          <TextLink href={`/markets/resell?type=${slug}`}>Open the resell board →</TextLink>
        </Card>
        <Card title="Understand the instrument" body="Read the category guide, then check the documents of the specific issuance.">
          <TextLink href={`/markets/types/${slug}`}>Read the asset guide →</TextLink>
        </Card>
      </Grid>
    </Section>
  </>;
}
