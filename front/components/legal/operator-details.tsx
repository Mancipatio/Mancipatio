import type { ReactNode } from "react";
import {
  hasOperatorEntity,
  type Operator,
  type OperatorLicence,
} from "@/lib/legal/operator";

/**
 * The operator record (lib/legal/operator.ts) as page blocks. Server-safe (no
 * hooks). A field that is not set renders as nothing (the mx rule: no
 * "pending", no placeholder); the devnet record renders its pilot notice.
 */

function DetailList({ rows }: { rows: Array<[string, ReactNode]> }) {
  if (rows.length === 0) return null;
  return (
    <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt className="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-mx-ink-faint">
            {label}
          </dt>
          <dd className="mt-1 text-[15px] leading-relaxed text-mx-ink">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Mail({ address }: { address: string }) {
  return (
    <a className="mx-link" href={`mailto:${address}`}>
      {address}
    </a>
  );
}

/** Registered name, office, MB, PIB and register; null without an entity. */
export function OperatorCompanyDetails({ operator }: { operator: Operator }) {
  if (!hasOperatorEntity(operator)) return null;
  const rows: Array<[string, ReactNode]> = [];
  if (operator.legalName) rows.push(["Registered name", operator.legalName]);
  if (operator.shortName) rows.push(["Short name", operator.shortName]);
  if (operator.registeredOffice) rows.push(["Registered office", operator.registeredOffice]);
  if (operator.registrationNumber) rows.push(["Registration number (MB)", operator.registrationNumber]);
  if (operator.taxId) rows.push(["Tax ID (PIB)", operator.taxId]);
  if (operator.register) {
    rows.push([
      "Register",
      operator.register.url ? (
        <a className="mx-link" href={operator.register.url} target="_blank" rel="noopener noreferrer">
          {operator.register.name} ↗
        </a>
      ) : (
        operator.register.name
      ),
    ]);
  }
  return <DetailList rows={rows} />;
}

/** The licence: authority, decision, date, services and register entry. */
export function OperatorLicenceDetails({ licence }: { licence: OperatorLicence }) {
  const rows: Array<[string, ReactNode]> = [
    ["Issued by", licence.authority],
    ["Decision number", licence.decisionNumber],
    ["Decision date", licence.decisionDate],
    [
      "Licensed services",
      <ul key="services" className="list-disc space-y-1 pl-5">
        {licence.services.map((service) => (
          <li key={service}>{service}</li>
        ))}
      </ul>,
    ],
  ];
  if (licence.registerUrl) {
    rows.push([
      "Public register",
      <a key="register" className="mx-link" href={licence.registerUrl} target="_blank" rel="noopener noreferrer">
        Entry in the regulator&apos;s register ↗
      </a>,
    ]);
  }
  return <DetailList rows={rows} />;
}

/** Legal, privacy, security and DPO addresses that are set. */
export function OperatorContactDetails({ operator }: { operator: Operator }) {
  const { legal, privacy, security, dpo } = operator.contacts;
  const rows: Array<[string, ReactNode]> = [];
  if (legal) rows.push(["Legal notices", <Mail key="legal" address={legal} />]);
  if (privacy) rows.push(["Personal data", <Mail key="privacy" address={privacy} />]);
  if (dpo) rows.push(["Data protection officer", <Mail key="dpo" address={dpo} />]);
  if (security) rows.push(["Security reports", <Mail key="security" address={security} />]);
  return <DetailList rows={rows} />;
}
