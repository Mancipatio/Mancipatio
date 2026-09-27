import Link from "next/link";
import { BrandLogo } from "@/components/brand-logo";
import { Badge } from "./badge";
import { Disclaimer, FootNote } from "./footnote";
import { MX_FOOTER_COLUMNS, MX_NETWORK_STAGE_LABEL, MX_ROUTES } from "./nav";
import { Wrap } from "./section";
import { detectNetwork } from "@/lib/network";
import { hasOperatorEntity, licenceLine, operatorFor } from "@/lib/legal/operator";

/** This build's operator (lib/legal/operator.ts). */
const OPERATOR = operatorFor(detectNetwork());

/** "<office> · MB … · PIB …" when a legal entity operates this network; null
 *  on the devnet pilot. */
function operatorCompanyLine(): string | null {
  if (!hasOperatorEntity(OPERATOR)) return null;
  return [
    OPERATOR.registeredOffice,
    OPERATOR.registrationNumber ? `MB ${OPERATOR.registrationNumber}` : null,
    OPERATOR.taxId ? `PIB ${OPERATOR.taxId}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The copyright holder: the registered name, or the brand on the pilot. */
const COPYRIGHT_HOLDER = hasOperatorEntity(OPERATOR)
  ? (OPERATOR.legalName?.trim() ?? OPERATOR.brand)
  : OPERATOR.brand;

/**
 * Marketing footer: four columns over a hairline, then the disclaimer band.
 * Link inventory lives in `./nav` so header, footer and pages can't drift.
 * The copyright line names the operator from lib/legal/operator.ts.
 */
export function SiteFooter() {
  const companyLine = operatorCompanyLine();
  return (
    <footer className="mx-foot">
      <Wrap>
        <div className="mx-foot-cols">
          <div>
            <Link href={MX_ROUTES.home} className="mx-logo mb-3.5">
              <BrandLogo />
            </Link>
            <p className="mx-small max-w-[26em]">
              Tokenization infrastructure and legal structuring. We provide the
              rails and the legal wrapper; we don&rsquo;t set the issuer&rsquo;s
              terms.
            </p>
            <p className="mt-4">
              <Badge>{MX_NETWORK_STAGE_LABEL}</Badge>
            </p>
          </div>

          {MX_FOOTER_COLUMNS.map((col) => (
            <div key={col.title}>
              <h4>{col.title}</h4>
              {col.links.map((l) => (
                <Link key={l.href} href={l.href} className="mx-foot-link">
                  {l.label}
                </Link>
              ))}
            </div>
          ))}
        </div>

        <div className="mx-foot-base">
          <Disclaimer>
            Manci provides tokenization infrastructure and legal
            structuring. Nothing on this site is investment advice or an offer
            to sell securities. Tokenized instruments carry risk, including
            total loss. Read the risk disclosure before participating.
          </Disclaimer>
          <FootNote>
            © {new Date().getFullYear()} {COPYRIGHT_HOLDER}
            {companyLine && <> · {companyLine}</>}
            {" · "}
            <Link href={MX_ROUTES.company} className="mx-link">
              Company &amp; licence
            </Link>
          </FootNote>
          {OPERATOR.licence && (
            <FootNote>Licence: {licenceLine(OPERATOR.licence)}</FootNote>
          )}
        </div>
      </Wrap>
    </footer>
  );
}
