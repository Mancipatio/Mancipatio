import type { Metadata } from "next";
import Link from "next/link";
import { Montserrat } from "next/font/google";
import { BrandLogo } from "@/components/brand-logo";
import { IconArrowUpRight, IconBuilding, IconCheck, IconCoins, IconLock } from "@/components/icons";
import { MANCI_X_URL } from "@/components/follow-on-x";
import { OwnershipVisual } from "@/components/marketing/ownership-visual";
import { detectNetwork, networkLabel } from "@/lib/network";
import { KYC_ONLY_MESSAGE, kycOnly, scopeEnabled } from "@/lib/features";
import { offeredAssetClasses } from "@/lib/pilot-scope";
import { ASSET_TYPES } from "@/lib/asset-types";
import { MANCI_CASE_STUDY_URL } from "@/lib/manci-token";
import { operatorFor, operatorFooterLine } from "@/lib/legal/operator";
import { siteUrl } from "@/lib/site-url";
import { jsonLdScript, organizationJsonLd } from "@/lib/structured-data";
import styles from "./landing.module.css";
import { LandingCompanies } from "./landing-companies";

const brandFont = Montserrat({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-brand", display: "swap" });
const INTRO = "Tokens that convert into real equity in European companies. An issuance can also include a registered lien on the underlying equity.";

export const metadata: Metadata = {
  title: "Manci — From token to registered owner",
  description: INTRO,
};

const ownershipSteps = [
  {
    number: "01",
    icon: IconCoins,
    title: "Token",
    description: "A right to convert into equity.",
  },
  {
    number: "02",
    icon: IconLock,
    title: "Convert",
    description: "Start it on the platform. KYC, then your tokens go into escrow.",
  },
  {
    number: "03",
    icon: IconBuilding,
    title: "Register",
    description: "Complete the legal transfer and become a registered member of the company in Serbia's Business Register (BRA).",
  },
  {
    number: "04",
    icon: IconCheck,
    title: "Burn",
    description: "The tokens are burned. The equity stays with you.",
  },
];

export default function HomePage() {
  const network = detectNetwork();
  const issuanceOpen = scopeEnabled("issuance", network);
  const offered = offeredAssetClasses(network);
  const assetTypes = ASSET_TYPES.filter((asset) => offered.includes(asset.slug as typeof offered[number]));
  const assetGuide = assetTypes.length === 1 ? `/markets/types/${assetTypes[0].slug}` : "/markets/types";
  const operator = operatorFor(network);
  const operatorLine = operatorFooterLine(operator, new Date().getFullYear());

  return (
    <div className={`${styles.page} ${brandFont.variable}`}>
      {/* Organization JSON-LD from the operator record (lib/structured-data.ts); "<" is escaped. */}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(organizationJsonLd(operator, siteUrl())) }} />
      <a className={styles.skip} href="#main-content">Skip to content</a>
      <div className={styles.intro}>
        <header className={`${styles.container} ${styles.header}`}>
          <Link href="/" className={styles.logo}><BrandLogo /></Link>
          <nav className={styles.nav} aria-label="Main navigation">
            <Link href="/how-it-works" className={styles.navFounders}>For founders</Link>
            <Link href="/about">About</Link>
            <Link href="/docs">Docs</Link>
            <a href={MANCI_X_URL} target="_blank" rel="noopener noreferrer" aria-label="Manci on X (opens in a new tab)">X <IconArrowUpRight size={13} /></a>
            <Link href="/app" className={styles.navCta}>Open app <IconArrowUpRight size={16} /></Link>
          </nav>
        </header>

        <main id="main-content" tabIndex={-1}>
          <section className={`${styles.container} ${styles.hero}`} aria-labelledby="intro-title">
            <div>
              <p className={styles.eyebrow}><span /> TOKENIZED EQUITY · EUROPE · ON SOLANA</p>
              <h1 id="intro-title">From token to<br />registered<br /><span>owner.</span></h1>
              <p className={styles.lead}>{INTRO}</p>
              <div className={styles.actions}>
                <Link href="/marketplace" className={styles.primary}>Explore assets <IconArrowUpRight size={19} /></Link>
                {issuanceOpen
                  ? <Link href="/apply" className={styles.textLink}>Apply to issue <IconArrowUpRight size={17} /></Link>
                  : <Link href="/verify" className={styles.textLink}>Get verified <IconArrowUpRight size={17} /></Link>}
              </div>
              <p className={styles.caseStudy}>
                Proven on Solana mainnet: from token issuance to registered company ownership in Serbia.{" "}
                <a href={MANCI_CASE_STUDY_URL}>See the MANCI case study</a>
              </p>
              {network !== "mainnet" && <p className={styles.stage}><span /> Explore on Solana {networkLabel(network).toLowerCase()} · Test environment</p>}
              {kycOnly(network) && <p className={styles.scopeNotice}>{KYC_ONLY_MESSAGE}</p>}
            </div>
            <figure className={styles.visual}>
              <OwnershipVisual />
            </figure>
          </section>

          <div className={styles.assetBand}>
            <div className={styles.container}><span className={styles.assetBandLabel}>UNDERSTAND THE ASSET</span><p>{assetTypes.map((asset, index) => <span className={styles.assetName} key={asset.slug}>{index > 0 && <span aria-hidden="true">/</span>}{asset.title}</span>)}</p><Link href={assetGuide} aria-label={assetTypes.length === 1 ? "Read the asset guide" : "Explore offered asset types"}><IconArrowUpRight size={20} /></Link></div>
          </div>

          {/* The published tokens and the public record; renders nothing until a profile is published. */}
          <LandingCompanies />

          <section id="ownership-path" className={styles.about} aria-labelledby="ownership-title">
            <div className={styles.container}>
              <h2 id="ownership-title">The ownership path</h2>
              <ol className={styles.capabilities} aria-label="From token to registered owner: four steps">
                {ownershipSteps.map(({ number, icon: Icon, title, description }) => (
                  <li key={number} className={styles.capability}>
                    <div className={styles.capabilityTop}><Icon size={25} /><span>{number}</span></div>
                    <h3>{title}.</h3><p>{description}</p>
                  </li>
                ))}
              </ol>
              <p className={styles.processNote}>
                What each token gives you is set out in its issuance documents. Holding a token doesn&apos;t make you a registered member. Converting does.
              </p>

              <section className={styles.editorial} aria-labelledby="why-title">
                <div className={styles.aboutHeading}>
                  <div><p className={styles.eyebrow}>Why Manci</p><h2 id="why-title">Not another offshore SPV.</h2></div>
                  <div className={styles.aboutCopy}><p>Many tokenized assets sit in an offshore vehicle you can&apos;t look into. Manci tokens are backed by equity in companies in Europe (Republic of Serbia). Check both sides yourself: the token on the blockchain and the company in the state register.</p></div>
                </div>
                <ul className={styles.reasons}>
                  <li><strong>Real equity.</strong> Convert, and you own part of the company, not a contract with a middleman.</li>
                  <li><strong>The MANCI issuance.</strong> The Serbian Pledge Register records a lien on 15% of Mancipatio d.o.o. Beograd&apos;s share capital, backing 1,500 MANCI tokens.</li>
                  <li><strong>Public registers.</strong> Owners, liens and transfers are on record, open to anyone online.</li>
                </ul>
              </section>

              <section className={styles.editorial} aria-labelledby="meet-title">
                <div className={styles.aboutHeading}>
                  <div><Link className={styles.eyebrow} href="/about">Meet Manci <IconArrowUpRight size={14} /></Link><h2 id="meet-title">Private companies.<br /><span>A real path to ownership.</span></h2></div>
                  <div className={styles.aboutCopy}><p>We bring together Solana engineering, legal structuring and company verification, so a token can become registered equity.</p></div>
                </div>
              </section>

              <div className={styles.otc}>
                <div className={styles.otcCopy}>
                  <h3>Or just trade the token</h3>
                  <p>Buy or sell peer to peer on <Link className={styles.inlineLink} href="/solutions/otc">DeFi OTC</Link>. Smart-contract escrow holds both sides.</p>
                  {!scopeEnabled("secondaryTrading", network) && <span className={styles.availability}>OTC trading is currently paused.</span>}
                </div>
                <div className={styles.otcFlow} aria-label="OTC model: seller, smart-contract escrow, buyer">
                  <div><span>Seller</span><small>Posts an offer</small></div>
                  <span className={styles.flowArrow} aria-hidden="true">↔</span>
                  <div className={styles.escrow}><IconLock size={23} /><span>Escrow</span><small>Holds both sides</small></div>
                  <span className={styles.flowArrow} aria-hidden="true">↔</span>
                  <div><span>Buyer</span><small>Receives tokens</small></div>
                </div>
              </div>
              {issuanceOpen && (
                <section className={styles.editorial} aria-labelledby="raise-title">
                  <div className={styles.aboutHeading}>
                    <h2 id="raise-title">Raising capital?</h2>
                    <div className={styles.aboutCopy}>
                      <p>Tokenize equity in your company and reach a new pool of investors.</p>
                      <div className={styles.actions}>
                        <Link href="/apply" className={styles.textLink}>Apply to issue <IconArrowUpRight size={17} /></Link>
                        <Link href="/solutions/serbian-spv" className={styles.textLink}>Issuing through a Serbian SPV <IconArrowUpRight size={17} /></Link>
                      </div>
                    </div>
                  </div>
                </section>
              )}
              <div className={styles.nextStep}>
                <div><p className={styles.eyebrow}>Your next step</p><h2>Get to know Manci.</h2>
                  <p>{kycOnly(network) ? KYC_ONLY_MESSAGE : "Browse the marketplace. Buy and hold tokens without KYC unless the issuance requires it. Verify your identity when you're ready to convert."}</p>
                </div>
                <div className={styles.actions}>
                  <Link href="/app" className={styles.primary}>Open app <IconArrowUpRight size={19} /></Link>
                  <Link href="/docs" className={styles.textLink}>Read the docs <IconArrowUpRight size={17} /></Link>
                </div>
              </div>
              <p className={styles.processNote}>Tokens carry risk. <Link href="/risks" className={styles.inlineLink}>Read the risk disclosure</Link> before you buy.</p>
            </div>
          </section>
        </main>
      </div>

      <footer className={styles.footer}>
        <div className={`${styles.container} ${styles.footerTop}`}><Link href="/" className={styles.logo}><BrandLogo /></Link><p>From token to registered owner.</p><nav aria-label="Footer navigation"><Link href="/how-it-works">For founders</Link><Link href="/about">About</Link><Link href="/docs">Docs</Link><a href={MANCI_X_URL} target="_blank" rel="noopener noreferrer" aria-label="Manci on X (opens in a new tab)">X <IconArrowUpRight size={13} /></a><Link href="/contact">Contact</Link></nav></div>
        <div className={`${styles.container} ${styles.footerBottom}`}><span>© {new Date().getFullYear()} Manci</span><div><Link href="/risks">Risks</Link><Link href="/legal/terms">Terms</Link><Link href="/legal/privacy">Privacy</Link><Link href="/legal/company">Company &amp; licence</Link></div></div>
        {operatorLine && <p className={`${styles.container} ${styles.operatorLine}`}>{operatorLine}</p>}
      </footer>
    </div>
  );
}
