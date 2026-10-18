import Link from "next/link";
import { BrandLogo } from "@/components/brand-logo";
import { Badge } from "./badge";
import { Disclaimer, FootNote } from "./footnote";
import { MX_FOOTER_COLUMNS, MX_NETWORK_STAGE_LABEL, MX_ROUTES } from "./nav";
import { Wrap } from "./section";
import { detectNetwork } from "@/lib/network";
import { navHrefVisible } from "@/lib/pilot-scope";
import {
  copyrightHolder,
  licenceLine,
  operatorFor,
  operatorRegistrationLine,
} from "@/lib/legal/operator";

/** This build's operator (lib/legal/operator.ts). */
const OPERATOR = operatorFor(detectNetwork());

/**
 * Marketing footer: four columns over a hairline, then the disclaimer band.
 * Link inventory lives in `./nav` so header, footer and pages can't drift.
 * The copyright line names the operator from lib/legal/operator.ts, like
 * the app footer that the pages render today (components/app-shell.tsx).
 */
export function SiteFooter() {
  const companyLine = operatorRegistrationLine(OPERATOR);
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
              {/* No link into a module switched off on this network (lib/pilot-scope.ts). */}
              {col.links.filter((l) => navHrefVisible(l.href)).map((l) => (
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
            © {new Date().getFullYear()} {copyrightHolder(OPERATOR)}
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
