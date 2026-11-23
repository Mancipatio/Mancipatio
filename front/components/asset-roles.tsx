import Link from "next/link";
import type { ReactNode } from "react";

/**
 * "Who gets what" on a token's page: what the holder has, what the company
 * that issued the token does, and what Manci does, each in plain sentences.
 *
 * Every line restates something already in force, never a new promise:
 *   - the Terms of Service (lib/legal/mainnet-copy.ts): tokens are bearer
 *     instruments; the issuer is responsible for its instrument; the
 *     Operator is not the issuer, is not a party to the instrument and takes
 *     no legal title; issuers pay what their engagement agreement provides;
 *   - the landing page's four steps (app/page.tsx): a documented right to
 *     acquire a share; verification and escrow; the entry in the official
 *     register; the burn; "Holding a token alone does not make you a
 *     registered shareholder";
 *   - the token's own figures: the share of the company one token is, only
 *     when the published profile gives it (lib/profile-public.ts).
 * The token's documents decide; this block says so and links the Terms, the
 * risk disclosure and the fees.
 */
export function AssetRoles({
  name,
  companyShares,
  oneTokenPercent,
  conversionHref,
  verified,
  legalDocRecorded = false,
}: {
  /** The token's public name. */
  name: string;
  /** Whether the asset is company ownership (equity): the lines about shares and the register apply only then. */
  companyShares: boolean;
  /** "0.01" when the published figures give the share of one token, else null. */
  oneTokenPercent: string | null;
  /** The conversion page when conversion is available on this network, else null. */
  conversionHref: string | null;
  /** Whether the issuer's verification is complete. */
  verified: boolean;
  /** Whether the token's legal document is fixed on chain by its SHA-256 (shown under On-chain details). */
  legalDocRecorded?: boolean;
}) {
  const holder: ReactNode[] = companyShares
    ? [
        oneTokenPercent
          ? <>A documented right to acquire a share in the company: <strong>{oneTokenPercent} % of the company per token</strong>.</>
          : <>A documented right to acquire a share in the company. The size of that share per token is set in the token&apos;s documents.</>,
        <>The token itself, in your own wallet. Tokens are bearer instruments: whoever controls the wallet can transfer them.</>,
        <>Not yet a place in the company register. Holding a token alone does not make you a registered shareholder.</>,
        conversionHref
          ? <>A path to registered ownership. Where the issuer offers conversion and it is available, you verify your identity and place your tokens in escrow; the ownership is entered in the official register and the tokens are burned. <Link href={conversionHref}>Convert to shares</Link></>
          : <>A path to registered ownership where the issuer offers conversion and it is available. Conversion is not open on this network at present.</>,
      ]
    : [
        <>The rights set out in the token&apos;s documents, and nothing beyond them.</>,
        <>The token itself, in your own wallet. Tokens are bearer instruments: whoever controls the wallet can transfer them.</>,
      ];
  const issuer: ReactNode[] = [
    <>Is responsible for the token, its documents and its disclosures.</>,
    <>Can issue tokens only up to the cap recorded on Solana. The cap and what is issued are under Supply and conversions.</>,
    ...(companyShares ? [<>Completes the legal transfer and the entry in the official register when a holder converts.</>] : []),
    <>Pays Manci what its engagement agreement provides.</>,
  ];
  const platform: ReactNode[] = [
    verified
      ? <>Has verified the company that issued this token.</>
      : <>Verifies the company that issued this token. That verification is not complete.</>,
    ...(companyShares ? [<>Runs the conversion on Solana, the escrow and the burn, and records each register entry next to it on this page.</>] : []),
    <>Is not the issuer and is not a party to the token between you and the issuer. It does not take legal title to what backs the token.</>,
  ];
  const columns = [
    { title: "You, the token holder", lead: "What you have", items: holder },
    { title: "The company", lead: "What the issuer does", items: issuer },
    { title: "Manci", lead: "What the platform does", items: platform },
  ];
  return (
    <section className="mt-10" aria-labelledby="asset-roles-heading">
      <h2 id="asset-roles-heading" className="text-xs font-semibold uppercase tracking-widest text-mx-ink-faint">
        Who gets what
      </h2>
      <div className="mt-4 grid gap-px overflow-hidden rounded-[3px] border border-mx-rule bg-mx-rule md:grid-cols-3">
        {columns.map((column) => (
          <div key={column.title} className="bg-white p-6">
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-mx-ink-faint">{column.lead}</p>
            <h3 className="mt-1 text-base font-semibold text-mx-ink">{column.title}</h3>
            <ul className="mt-4 space-y-3 text-sm leading-relaxed text-mx-ink-soft [&_a]:text-mx-indigo [&_a]:underline [&_a]:underline-offset-2 [&_strong]:font-semibold [&_strong]:text-mx-ink">
              {column.items.map((item, index) => <li key={index}>{item}</li>)}
            </ul>
          </div>
        ))}
      </div>
      <p className="mt-3 text-xs leading-relaxed text-mx-ink-faint [&_a]:underline [&_a]:underline-offset-2">
        A summary of {name}, not its terms: the token&apos;s documents and the{" "}
        <Link href="/legal/terms">Terms of Service</Link> decide.{legalDocRecorded ? " The token's legal document is fixed on Solana by its SHA-256, under On-chain details: whoever holds a copy can check it is that document." : ""} Read the{" "}
        <Link href="/risks">risk disclosure</Link> and the <Link href="/pricing">fees and costs</Link> before you take part.
      </p>
    </section>
  );
}
