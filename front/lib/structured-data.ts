// Structured data (schema.org JSON-LD) for search engines. Directive-free and
// pure; the landing page renders the Organization block (app/page.tsx).
//
// The Organization is the operator of this network, from its one record
// (lib/legal/operator.ts): the brand always, and the legal name, registered
// office and registration number only when a legal entity is named, exactly
// as /legal/company shows them (the devnet pilot names none, so its block
// carries the brand alone). Nothing here is new information: every field is
// already public on the site or on the X profile.

import { hasOperatorEntity, operatorNumbers, type Operator } from "@/lib/legal/operator";
import { siteHref } from "@/lib/site-url";
import { MANCI_X_URL } from "@/lib/social";

export type JsonLd = Record<string, unknown>;

export function organizationJsonLd(operator: Operator, origin: string): JsonLd {
  const data: JsonLd = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: operator.brand,
    url: siteHref("/", origin),
    // The brand mark on its dark tile (app/icon.tsx, 256 px): the PNGs in
    // public/brand are white on transparent and vanish on a white result page.
    logo: siteHref("/icon", origin),
    sameAs: [MANCI_X_URL],
  };
  if (!hasOperatorEntity(operator)) return data;
  data.legalName = operator.legalName!.trim();
  const office = operator.registeredOffice?.trim();
  if (office) data.address = office;
  const numbers = operatorNumbers(operator, "label");
  if (numbers.length > 0) {
    data.identifier = numbers.map(([name, value]) => ({ "@type": "PropertyValue", propertyID: name, value }));
  }
  return data;
}

/**
 * The text of a `<script type="application/ld+json">`. JSON.stringify does
 * not escape "<", so a value containing "</script>" could end the element and
 * inject markup: every "<" becomes <, which JSON parsers read back as "<".
 */
export function jsonLdScript(data: JsonLd): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}
