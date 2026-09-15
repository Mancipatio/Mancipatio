import type { Metadata } from "next";
import {
  Body,
  Button,
  ButtonRow,
  H2,
  MX_ROUTES,
  PageHeader,
  Section,
} from "@/components/mx";

export const metadata: Metadata = {
  title: "Legal structure — Manci",
  description:
    "The legal structure behind a Manci token: a Serbian SPV, an instrument that binds the issuer, a share pledge registered in holders' favour where the instrument allows one, and a documented route to enforcement.",
};

/**
 * CONTENT OWNERSHIP: the substance of this page — what the SPV is, how the
 * right attaches to the token, what the pledge protects, and what conversion
 * and enforcement involve concretely — is written by the legal cofounder.
 *
 * Until that copy arrives this page says only what the platform can already
 * back: the structure is built per issuance, the specifics live in that
 * issuance's whitepaper, and pledge/SPV applicability is stated per instrument.
 *
 * The prototype shipped a six-point BRIEF here (the list of what this page must
 * cover). That brief is a task list, not content — publishing it hands the
 * reader a page of questions with no answers. It stays in the prototype and in
 * the legal cofounder's queue, not on the site.
 */
export default function LegalStructurePage() {
  return (
    <>
      <PageHeader
        eyebrow="The structure"
        title="The token is the easy part."
        lede="Minting a token takes minutes. Making it mean something takes a legal structure a court will recognise: a Serbian SPV, an instrument that binds the issuer, a share pledge registered in holders' favour where the instrument allows one, and a documented route to enforcement."
      />

      <Section>
        <H2>Built per issuance, not assumed once</H2>
        <Body className="mt-4">
          The structure is put together for each issuance rather than assumed
          once for everyone. What the issuer commits to, what the holder can
          claim, and how that claim is enforced are set out in that
          issuance&rsquo;s whitepaper before anything is sold.
        </Body>
        <Body className="mt-3.5">
          Which instruments can carry a registered share pledge, and which
          require a Serbian SPV, differs by instrument — each instrument page
          states its own terms rather than inheriting a generic promise.
        </Body>
        <ButtonRow>
          <Button href={MX_ROUTES.instruments} variant="ghost">
            Compare the instruments
          </Button>
          <Button href={MX_ROUTES.whitepapers} variant="ghost">
            What a whitepaper covers
          </Button>
        </ButtonRow>
      </Section>

      <Section>
        <H2>Working through a specific structure</H2>
        <Body className="mt-4">
          The full legal documentation is prepared with the issuer during
          engagement — the incorporation route, the pledge registration, and
          the conversion mechanics for that particular instrument. If you are
          weighing an issuance, that is where those questions get answered
          concretely rather than in general terms.
        </Body>
        <ButtonRow>
          <Button href={MX_ROUTES.apply}>Apply to issue</Button>
          <Button href={MX_ROUTES.contact} variant="ghost">
            Ask a question first
          </Button>
        </ButtonRow>
      </Section>
    </>
  );
}
