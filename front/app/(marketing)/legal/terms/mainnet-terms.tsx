import {
  Body,
  H2,
  MX_ROUTES,
  Section,
  TextLink,
} from "@/components/mx";
import {
  LegalDocumentMissing,
  LegalDocumentView,
} from "@/components/legal/legal-document";
import { MAINNET_TERMS } from "@/lib/legal/mainnet-copy";
import { operatorFor, operatorSentence } from "@/lib/legal/operator";

/**
 * Terms of Service on MAINNET: counsel's clauses (lib/legal/mainnet-copy.ts),
 * framed by the blocks generated from the operator record
 * (lib/legal/operator.ts) so they match the footer and /legal/company:
 * who operates the Service (and its licence) before the clauses; governing
 * law, the forum for disputes and the contact address after them.
 */
export function MainnetTerms() {
  if (!MAINNET_TERMS) return <LegalDocumentMissing title="Terms of Service" />;
  const operator = operatorFor("mainnet");
  const operatorText = operatorSentence(operator);
  return (
    <LegalDocumentView
      title="Terms of Service"
      document={MAINNET_TERMS}
      before={
        operatorText ? (
          <Section>
            <H2 className="text-[19px] leading-snug tracking-normal">Operator</H2>
            <Body className="mt-4">{operatorText}</Body>
            <p className="mt-4">
              <TextLink href={MX_ROUTES.company}>Company and licence →</TextLink>
            </p>
          </Section>
        ) : null
      }
      after={
        <Section>
          {(operator.governingLaw || operator.disputeResolution) && (
            <>
              <H2 className="text-[19px] leading-snug tracking-normal">
                Governing law and disputes
              </H2>
              {operator.governingLaw && (
                <Body className="mt-4">
                  These Terms are governed by {operator.governingLaw}.
                </Body>
              )}
              {operator.disputeResolution && (
                <Body className="mt-3.5">
                  Disputes are resolved by {operator.disputeResolution}.
                </Body>
              )}
            </>
          )}
          {operator.contacts.legal && (
            <>
              <H2 className="mt-10 text-[19px] leading-snug tracking-normal">Contact</H2>
              <Body className="mt-4">
                <a className="mx-link" href={`mailto:${operator.contacts.legal}`}>
                  {operator.contacts.legal}
                </a>
              </Body>
            </>
          )}
          <p className="mt-8">
            <TextLink href={MX_ROUTES.privacy}>Privacy policy →</TextLink>
          </p>
        </Section>
      }
    />
  );
}
