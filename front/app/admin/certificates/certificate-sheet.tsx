// The printable certificate: one A4 sheet (two pages or so) laid out for the
// browser's "Save as PDF" (app/admin/certificates/print). Everything on it
// comes from the stored payload and row; the statement is the payload's own
// text, under its own hash. It shows the holder's name and ID number when
// the payload has them: the printed certificate is the holder's document,
// and only admins open this page.
//
// The last section prints the signed bytes themselves (the canonical JSON),
// so the paper or PDF copy carries every signed fact; the holder's file for
// /certificates/verify is the JSON download of the admin page (the same
// bytes, whose SHA-256 is the certificate's).

import type { ReactNode } from "react";
import { CERTIFICATE_MESSAGE_HEADER, formatUnits, type CertificateDetail } from "@/lib/certificates/payload";
import { explorerTxUrl, isTestNetwork, networkLabel } from "@/lib/network";

/** Screen and print rules of the sheet; print shows the sheet alone (nothing else the layout draws). */
export const CERTIFICATE_PRINT_CSS = `
.certificate-sheet { width: 210mm; max-width: 100%; margin: 0 auto; background: #fff; color: #0f172a; }
@page { size: A4; margin: 15mm 14mm; }
@media print {
  html, body { background: #fff !important; }
  body *:not(:has(.certificate-sheet)):not(.certificate-sheet):not(.certificate-sheet *) { display: none !important; }
  body *:has(.certificate-sheet) {
    display: block !important; position: static !important; margin: 0 !important; padding: 0 !important;
    border: 0 !important; box-shadow: none !important; background: none !important; width: auto !important;
    max-width: none !important; min-width: 0 !important; height: auto !important; min-height: 0 !important;
    overflow: visible !important; transform: none !important;
  }
  .certificate-sheet { width: auto !important; box-shadow: none !important; border: 0 !important; padding: 0 !important; }
  .certificate-section { break-inside: avoid; }
  .certificate-appendix { break-before: page; }
  .certificate-no-print { display: none !important; }
  a { color: inherit !important; text-decoration: none !important; }
}
`;

const STATUS_LINE: Record<CertificateDetail["status"], string> = {
  draft: "DRAFT — not signed, not a certificate",
  signed: "Signed",
  anchored: "Signed and anchored on chain",
  revoked: "REVOKED",
};

function utc(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : `${date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "")} UTC`;
}

function Section({ title, children, className = "" }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section className={`certificate-section mt-6 ${className}`}>
      <h2 className="border-b border-slate-300 pb-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-600">{title}</h2>
      <dl className="mt-2 grid grid-cols-[minmax(0,13rem)_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-[12.5px] leading-snug">{children}</dl>
    </section>
  );
}

function Row({ label, children, mono = false }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <>
      <dt className="text-slate-500">{label}</dt>
      <dd className={`min-w-0 break-words text-slate-900 ${mono ? "break-all font-mono text-[11.5px]" : ""}`}>{children}</dd>
    </>
  );
}

const units = (value: string) => `${formatUnits(BigInt(value))} ${value === "1" ? "unit" : "units"}`;
const percent = (value: string, rounded: boolean) => `${value} %${rounded ? " (rounded to 8 decimal places)" : ""}`;

export function CertificateSheet({ detail, verifyUrl }: { detail: CertificateDetail; verifyUrl: string }) {
  const p = detail.payload;
  const test = isTestNetwork(p.network);
  const message = `${CERTIFICATE_MESSAGE_HEADER}\nNumber: ${detail.number}\nSHA-256: ${detail.payload_sha256}`;
  return (
    <article className="certificate-sheet relative px-10 py-10 shadow-card print:px-0 print:py-0">
      {(detail.status === "draft" || detail.status === "revoked") && (
        <p className="mb-6 rounded-md border-2 border-red-700 px-4 py-2 text-center text-sm font-bold uppercase tracking-[0.2em] text-red-800">
          {detail.status === "draft" ? "Draft — not signed — no validity" : `Revoked on ${utc(detail.revoked_at)}`}
        </p>
      )}
      {test && (
        <p className="mb-6 rounded-md border border-amber-400 bg-amber-50 px-4 py-2 text-center text-[12px] font-semibold text-amber-900">
          {networkLabel(p.network)} test network: this certificate has no legal effect, and the tokens it names have no economic value.
        </p>
      )}

      <header className="flex flex-wrap items-start justify-between gap-6 border-b-2 border-slate-900 pb-5">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.25em] text-slate-500">{p.operator.brand}</p>
          <h1 className="mt-2 text-[24px] font-semibold leading-tight text-slate-900">Certificate of tokenized interest</h1>
          <p className="mt-1 text-[13px] text-slate-600">{p.kind === "holding" ? "Holding certificate" : "Issuance certificate"}</p>
        </div>
        <div className="text-right">
          <p className="text-[11px] uppercase tracking-[0.15em] text-slate-500">Number</p>
          <p className="font-mono text-[20px] font-semibold text-slate-900">{detail.number}</p>
          <p className="mt-1 text-[12px] text-slate-600">Issued {utc(p.issued_at)}</p>
          <p className="text-[12px] text-slate-600">{STATUS_LINE[detail.status]}</p>
        </div>
      </header>

      <Section title="Issued by">
        <Row label="Operator">{p.operator.legal_name ?? `${p.operator.brand} (no designated legal entity on this network)`}</Row>
        {p.operator.registered_office && <Row label="Registered office">{p.operator.registered_office}</Row>}
        {p.operator.registration_number && (
          <Row label={p.operator.registration_number_label ?? "Registration number"}>{p.operator.registration_number}</Row>
        )}
        {p.operator.register && <Row label="Register">{p.operator.register}</Row>}
        <Row label="Network">Solana {networkLabel(p.network)}</Row>
      </Section>

      <section className="certificate-section mt-6">
        <h2 className="border-b border-slate-300 pb-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-600">Statement</h2>
        <p className="mt-2 text-[13.5px] leading-relaxed text-slate-900">{p.statement}</p>
      </section>

      <Section title="Company">
        <Row label="Legal name">{p.company.legal_name}</Row>
        <Row label="Registration number">{p.company.registration_number}</Row>
        <Row label="Registered address">{p.company.address}</Row>
      </Section>

      <Section title="Asset and share class">
        <Row label="Asset">
          {p.asset.asset_id} · {p.asset.name}
        </Row>
        <Row label="Token">{p.asset.symbol}, share class {p.share_class.class_index}</Row>
        <Row label="Token mint" mono>{p.share_class.mint}</Row>
        <Row label="Asset account" mono>{p.asset.asset_pda}</Row>
        <Row label="Share class account" mono>{p.share_class.share_class_pda}</Row>
        <Row label="Issuer account" mono>{p.asset.issuer_pda}</Row>
        <Row label="Maximum supply">{p.share_class.max_supply === null ? "No maximum" : units(p.share_class.max_supply)}</Row>
        <Row label="Scale">
          {units(p.share_class.units_for_100_percent)} = 100 % of the company; 1 unit = {percent(p.share_class.unit_percent, p.share_class.unit_percent_rounded)}
        </Row>
        <Row label="Legal documentation SHA-256" mono>{p.asset.legal_doc_hash}</Row>
      </Section>

      {p.holder && p.holding && (
        <Section title="Holder and holding">
          <Row label="Wallet" mono>{p.holder.wallet}</Row>
          {p.holder.name && <Row label="Holder (as given to the operator)">{p.holder.name}</Row>}
          {p.holder.id_number && <Row label="Identification number">{p.holder.id_number}</Row>}
          <Row label="Units held">{units(p.holding.units)}</Row>
          <Row label="Share of the company">{percent(p.holding.percent_of_company, p.holding.percent_of_company_rounded)}</Row>
          <Row label="Read at">slot {p.holding.slot} ({p.holding.commitment})</Row>
        </Section>
      )}
      {p.supply && (
        <Section title="Supply">
          <Row label="Maximum supply">
            {p.share_class.max_supply === null
              ? "No maximum"
              : `${units(p.share_class.max_supply)} (${percent(p.supply.max_supply_percent ?? "", p.supply.max_supply_percent_rounded)})`}
          </Row>
          <Row label="Issued to date">{units(p.supply.lifetime_minted)}</Row>
          <Row label="In circulation">
            {units(p.supply.circulating)} ({percent(p.supply.circulating_percent, p.supply.circulating_percent_rounded)})
          </Row>
          <Row label="Read at">slot {p.supply.slot} ({p.supply.commitment})</Row>
        </Section>
      )}

      <Section title="Chain evidence">
        <Row label="Asset registry program" mono>{p.chain_evidence.asset_registry_program}</Row>
        <Row label="Transfer hook program" mono>{p.chain_evidence.transfer_hook_program}</Row>
        <Row label="Token program" mono>{p.chain_evidence.token_program}</Row>
        {p.chain_evidence.transactions.map((tx) => (
          <Row key={tx.signature} label={tx.note ?? `Transaction (slot ${tx.slot})`} mono>
            {tx.signature} <span className="font-sans text-slate-500">(slot {tx.slot})</span>
          </Row>
        ))}
      </Section>

      <Section title="Integrity">
        <Row label="SHA-256 of the payload" mono>{detail.payload_sha256}</Row>
        <Row label="Signer (public key)" mono>{detail.signer}</Row>
        <Row label="Signature (base58)" mono>{detail.signature ?? "Not signed"}</Row>
        {detail.signature_format && (
          <Row label="Signed bytes">
            {detail.signature_format === "raw"
              ? "the message below, as UTF-8 text"
              : `a Solana off-chain message (${detail.signature_format}: version 0, application domain of zero bytes, restricted-ASCII format) whose text is the message below with its line breaks written as \\u000a`}
          </Row>
        )}
        <Row label="Signed message" mono>
          <span className="whitespace-pre-line">{message}</span>
        </Row>
        <Row label="On-chain anchor" mono>
          {detail.anchor_tx ? (
            <a href={explorerTxUrl(detail.anchor_tx, p.network)}>{detail.anchor_tx}</a>
          ) : (
            <span className="font-sans">Not anchored yet</span>
          )}
        </Row>
        {detail.anchor_tx && (
          <Row label="Anchor memo" mono>{`${detail.number} sha256:${detail.payload_sha256}`}</Row>
        )}
        {detail.anchor_tx && (
          <Row label="Anchored">
            slot {detail.anchor_slot ?? "—"}, {utc(detail.anchor_block_time)}
          </Row>
        )}
      </Section>

      <section className="certificate-section mt-6 rounded-md border border-slate-300 px-4 py-3 text-[12.5px] leading-relaxed text-slate-800">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-600">How to verify</h2>
        <ol className="mt-2 list-decimal space-y-1 pl-5">
          <li>
            Open <span className="break-all font-mono">{verifyUrl}</span>: it shows whether certificate {detail.number} is valid or
            revoked and what it states. Entered by hand, the page needs the number and the SHA-256 above; the number alone shows
            only whether the certificate is valid or revoked. It never shows the holder&apos;s name or identification number.
          </li>
          <li>The SHA-256 above is the hash of the payload printed at the end, exactly as signed (canonical JSON, UTF-8).</li>
          <li>The signature is an Ed25519 signature by the signer&apos;s public key over the signed message above.</li>
          <li>The anchor transaction carries the memo above, signed by the platform&apos;s Super Admin key, on Solana {networkLabel(p.network)}.</li>
        </ol>
      </section>

      <section className="certificate-section certificate-appendix mt-8">
        <h2 className="border-b border-slate-300 pb-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-600">
          Signed payload (canonical JSON)
        </h2>
        <p className="mt-2 break-all font-mono text-[9.5px] leading-snug text-slate-800">{detail.payload_canonical}</p>
      </section>
    </article>
  );
}
