import type { Metadata } from "next";
import { Body, PageHeader, Section, Small } from "@/components/mx";
import { WhitepapersBoard } from "./whitepapers-board";

export const metadata: Metadata = {
  title: "Whitepapers & disclosures — Manci",
  description:
    "Browse published issuer whitepapers and basic asset information, with document fingerprints and recorded approval references where available.",
};

export default function WhitepapersPage() {
  return (
    <>
      <PageHeader
        eyebrow="Issuer documents"
        title="Whitepapers & disclosures"
        lede="Find the issuer documents behind each published asset: its whitepaper, or the basic information available on its asset page."
      >
        <Small className="mt-5 max-w-[760px]">
          Whitepapers and basic information are provided by the issuers. A
          document has been approved by the Serbian Securities Commission (SSC)
          only where it is marked as approved, with the decision reference
          given; otherwise it has not been approved. Nothing on this page is
          investment advice.
        </Small>
      </PageHeader>

      <Section>
        <Body className="mb-5">
          A server-verified document has a fixed version and file hash.
          Historical references are labeled separately. A primary purchase
          identifies the exact version you accept; a newer publication does not
          replace that recorded acceptance.
        </Body>
        <WhitepapersBoard />
      </Section>
    </>
  );
}
