import { Body, H2, MX_ROUTES, Section, TextLink } from "@/components/mx";
import { hasOperatorEntity, operatorNumbers, type Operator } from "@/lib/legal/operator";

/**
 * The Privacy Policy's controller block (GDPR art. 13(1)(a) and (b): the
 * controller's identity and contact details, and the DPO's when there is
 * one), generated from the operator record so it matches the footer and
 * /legal/company: each number under the name its jurisdiction gives it
 * ("registration number (MB)", "BVI company number"). Without an entity
 * (devnet) it states the pilot notice.
 */
export function ControllerSection({ operator }: { operator: Operator }) {
  const { privacy, dpo } = operator.contacts;
  const entity = hasOperatorEntity(operator);
  if (!entity && !operator.pilotNotice && !privacy) return null;
  const identity = [
    operator.legalName?.trim(),
    operator.registeredOffice?.trim(),
    ...operatorNumbers(operator, "label").map(([name, number]) => `${name} ${number}`),
  ].filter(Boolean);
  return (
    <Section>
      <H2>Controller</H2>
      <div className="mx-body mt-4 space-y-4">
        {entity ? (
          <p>Controller of your personal data: {identity.join(", ")}.</p>
        ) : (
          operator.pilotNotice && <p>{operator.pilotNotice}</p>
        )}
        {privacy && (
          <p>
            Questions and requests about your personal data:{" "}
            <a className="mx-link" href={`mailto:${privacy}`}>
              {privacy}
            </a>
            .
          </p>
        )}
        {dpo && (
          <p>
            Data protection officer:{" "}
            <a className="mx-link" href={`mailto:${dpo}`}>
              {dpo}
            </a>
            .
          </p>
        )}
      </div>
      <Body className="mt-4">
        <TextLink href={MX_ROUTES.company}>Company and licence →</TextLink>
      </Body>
    </Section>
  );
}
