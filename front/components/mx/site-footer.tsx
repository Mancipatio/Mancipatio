import Link from "next/link";
import { BrandLogo } from "@/components/brand-logo";
import { Badge } from "./badge";
import { Disclaimer, FootNote } from "./footnote";
import { MX_FOOTER_COLUMNS, MX_ROUTES, MX_STAGE_LABEL } from "./nav";
import { Wrap } from "./section";

/**
 * Marketing footer: four columns over a hairline, then the disclaimer band.
 * Link inventory lives in `./nav` so header, footer and pages can't drift.
 */
export function SiteFooter() {
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
              <Badge>{MX_STAGE_LABEL}</Badge>
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
            Mancipatio provides tokenization infrastructure and legal
            structuring. Nothing on this site is investment advice or an offer
            to sell securities. Tokenized instruments carry risk, including
            total loss. Read the risk disclosure before participating.
          </Disclaimer>
          <FootNote>© {new Date().getFullYear()} Mancipatio</FootNote>
        </div>
      </Wrap>
    </footer>
  );
}
