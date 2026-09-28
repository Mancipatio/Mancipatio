import type { Metadata } from "next";
import {
  Body,
  Card,
  H2,
  MX_ROUTES,
  PageHeader,
  Section,
  TextLink,
} from "@/components/mx";
import {
  OperatorCompanyDetails,
  OperatorContactDetails,
  OperatorLicenceDetails,
} from "@/components/legal/operator-details";
import { hasOperatorEntity, operatorFor } from "@/lib/legal/operator";
import { detectNetwork } from "@/lib/network";

/**
 * Company and licence: who operates Manci on this network, its registration
 * details, the licence it holds, the law that governs the Terms, and the
 * support, legal, privacy and security contacts. Everything comes from the
 * operator record (lib/legal/operator.ts); a field that is not set is not
 * shown. The devnet record has no entity and shows its pilot notice instead.
 */
export const metadata: Metadata = {
  title: "Company and licence — Manci",
  description:
    "The company that operates Manci, its registration details and licence, and how to reach it.",
};

export default function CompanyPage() {
  const network = detectNetwork();
  const operator = operatorFor(network);
  const entity = hasOperatorEntity(operator);
  return (
    <>
      <PageHeader
        eyebrow="Legal"
        title="Company and licence"
        lede={`Who operates Manci on Solana ${network}, under which licence, and how to reach us.`}
      />

      {operator.pilotNotice && (
        <Section>
          <Card className="max-w-[760px]" title="Pilot">
            <p>{operator.pilotNotice}</p>
          </Card>
        </Section>
      )}

      {entity && (
        <Section>
          <H2 className="mb-6">Operator</H2>
          <OperatorCompanyDetails operator={operator} />
        </Section>
      )}

      {entity && (
        <Section>
          <H2 className="mb-6">Licence</H2>
          {operator.licence ? (
            <OperatorLicenceDetails licence={operator.licence} />
          ) : (
            <Body>No licence is recorded for the operator.</Body>
          )}
        </Section>
      )}

      {(operator.governingLaw || operator.disputeResolution) && (
        <Section>
          <H2>Governing law and disputes</H2>
          {operator.governingLaw && (
            <Body className="mt-4">
              The Terms of Service are governed by {operator.governingLaw}.
            </Body>
          )}
          {operator.disputeResolution && (
            <Body className="mt-3.5">
              Disputes are resolved by {operator.disputeResolution}.
            </Body>
          )}
        </Section>
      )}

      <Section>
        <H2 className="mb-6">Contacts</H2>
        <OperatorContactDetails operator={operator} />
        <Body className="mt-6">
          For anything else, use the{" "}
          <TextLink href={MX_ROUTES.contact}>contact form</TextLink>.
        </Body>
      </Section>

      <Section>
        <p>
          <TextLink href={MX_ROUTES.terms}>Terms of Service →</TextLink>
        </p>
        <p className="mt-3">
          <TextLink href={MX_ROUTES.privacy}>Privacy policy →</TextLink>
        </p>
        <p className="mt-3">
          <TextLink href={MX_ROUTES.risks}>Risk disclosure →</TextLink>
        </p>
      </Section>
    </>
  );
}
