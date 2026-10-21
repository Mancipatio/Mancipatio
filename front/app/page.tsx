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
import { operatorFor, operatorFooterLine } from "@/lib/legal/operator";
import styles from "./landing.module.css";

const brandFont = Montserrat({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-brand", display: "swap" });

export const metadata: Metadata = {
  title: "Manci — From token to registered owner",
  description:
    "Company shares tokenized on Solana. Discover Manci's documented path from eligible company-share tokens through verification, conversion and registration to ownership.",
};

const ownershipSteps = [
  {
    number: "01",
    icon: IconCoins,
    title: "Token",
    description: "An eligible company-share token carries a documented right to acquire a real share.",
    detail: "A claim to a share",
  },
  {
    number: "02",
    icon: IconLock,
    title: "Convert",
    description: "Complete KYC and place eligible tokens in escrow for the conversion process.",
    detail: "Verification + escrow",
  },
  {
    number: "03",
    icon: IconBuilding,
    title: "Register",
    description: "Complete the legal transfer and enter the share ownership in the official register.",
    detail: "Legal registration",
  },
  {
    number: "04",
    icon: IconCheck,
    title: "Burn",
    description: "After registration is confirmed, the escrowed tokens are burned. The registered share remains.",
    detail: "Registered ownership",
  },
];

export default function HomePage() {
  const network = detectNetwork();
  const offered = offeredAssetClasses(network);
  const assetTypes = ASSET_TYPES.filter((asset) => offered.includes(asset.slug as typeof offered[number]));
  const assetGuide = assetTypes.length === 1 ? `/markets/types/${assetTypes[0].slug}` : "/markets/types";
  const operatorLine = operatorFooterLine(operatorFor(network), new Date().getFullYear());

  return (
    <div className={`${styles.page} ${brandFont.variable}`}>
      <a className={styles.skip} href="#main-content">Skip to content</a>
      <div className={styles.intro}>
        <header className={`${styles.container} ${styles.header}`}>
          <Link href="/" className={styles.logo}><BrandLogo /></Link>
          <nav className={styles.nav} aria-label="Main navigation">
            <Link href="/about">About</Link>
            <Link href="/docs">Docs</Link>
            <a href={MANCI_X_URL} target="_blank" rel="noopener noreferrer" aria-label="Manci on X (opens in a new tab)">X <IconArrowUpRight size={13} /></a>
            <Link href="/app" className={styles.navCta}>Open app <IconArrowUpRight size={16} /></Link>
          </nav>
        </header>

        <main id="main-content" tabIndex={-1}>
          <section className={`${styles.container} ${styles.hero}`} aria-labelledby="intro-title">
            <div>
              <p className={styles.eyebrow}><span /> PRIVATE COMPANY SHARES · ON SOLANA</p>
              <h1 id="intro-title">From token to<br />registered<br /><span>owner.</span></h1>
              <p className={styles.lead}>Company shares tokenized on Solana, end to end.</p>
              <p className={styles.heroCopy}>A documented path from a company-share token to registered ownership, through verification, conversion and legal registration.</p>
              <div className={styles.actions}>
                <Link href="/app" className={styles.primary}>Explore the app <IconArrowUpRight size={19} /></Link>
                <a href="#ownership-path" className={styles.textLink}>How it works <span aria-hidden="true">↓</span></a>
              </div>
              <p className={styles.stage}><span /> {network === "mainnet" ? "Built on Solana mainnet" : `Explore on Solana ${networkLabel(network).toLowerCase()} · Test environment`}</p>
              {kycOnly(network) && <p className={styles.scopeNotice}>{KYC_ONLY_MESSAGE}</p>}
            </div>
            <figure className={styles.visual}>
              <OwnershipVisual />
              <figcaption>A documented claim. A path to registered ownership.</figcaption>
            </figure>
          </section>

          <div className={styles.assetBand}>
            <div className={styles.container}><span className={styles.assetBandLabel}>UNDERSTAND THE ASSET</span><p>{assetTypes.map((asset, index) => <span className={styles.assetName} key={asset.slug}>{index > 0 && <span aria-hidden="true">/</span>}{asset.title}</span>)}</p><Link href={assetGuide} aria-label={assetTypes.length === 1 ? "Read the asset guide" : "Explore offered asset types"}><IconArrowUpRight size={20} /></Link></div>
          </div>

          <section id="ownership-path" className={styles.about} aria-labelledby="about-title">
            <div className={styles.container}>
              <div className={styles.aboutHeading}>
                <div><p className={styles.eyebrow}>MEET MANCI</p><h2 id="about-title">Private companies.<br /><span>A path to ownership.</span></h2></div>
                <div className={styles.aboutCopy}><p>We bring together Solana engineering, legal structuring and company verification. Our focus is private companies and the people who hold their tokens, with a documented route from a token-holder claim to registered share ownership.</p><Link href="/about" className={styles.textLink}>More about us <IconArrowUpRight size={17} /></Link></div>
              </div>
              <ol className={styles.capabilities} aria-label="From token to registered owner: four steps">
                {ownershipSteps.map(({ number, icon: Icon, title, description, detail }) => (
                  <li key={number} className={styles.capability}>
                    <div className={styles.capabilityTop}><Icon size={25} /><span>{number}</span></div>
                    <h3>{title}</h3><p>{description}</p><span className={styles.stepDetail}>{detail}</span>
                  </li>
                ))}
              </ol>
              <p className={styles.processNote}>Token rights, eligibility and conversion requirements are defined in each issuance’s documents. Holding a token alone does not make you a registered shareholder. <Link href="/docs">Read the documentation <span aria-hidden="true">↗</span></Link></p>

              <div className={styles.otc}>
                <div className={styles.otcCopy}>
                  <p className={styles.eyebrow}>PEER TO PEER · SETTLED ON SOLANA</p>
                  <h3>A second path: trade the token.</h3>
                  <p>Manci’s OTC model connects sellers and buyers through smart-contract escrow, without converting the token into a registered share.</p>
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
              <div className={styles.nextStep}>
                <div><p className={styles.eyebrow}>YOUR NEXT STEP</p><h2>Get to know Manci.</h2><p>Explore the registry, create an account and complete identity verification.</p></div>
                <div className={styles.actions}><Link href="/app" className={styles.primary}>Open app <IconArrowUpRight size={19} /></Link><Link href="/verify" className={styles.textLink}>Get verified <IconArrowUpRight size={17} /></Link></div>
              </div>
            </div>
          </section>
        </main>
      </div>

      <footer className={styles.footer}>
        <div className={`${styles.container} ${styles.footerTop}`}><Link href="/" className={styles.logo}><BrandLogo /></Link><p>From token to registered owner.</p><nav aria-label="Footer navigation"><Link href="/about">About</Link><Link href="/docs">Docs</Link><a href={MANCI_X_URL} target="_blank" rel="noopener noreferrer" aria-label="Manci on X (opens in a new tab)">X <IconArrowUpRight size={13} /></a><Link href="/contact">Contact</Link></nav></div>
        <div className={`${styles.container} ${styles.footerBottom}`}><span>© {new Date().getFullYear()} Manci</span><div><Link href="/risks">Risks</Link><Link href="/legal/terms">Terms</Link><Link href="/legal/privacy">Privacy</Link><Link href="/legal/company">Company &amp; licence</Link></div></div>
        {operatorLine && <p className={`${styles.container} ${styles.operatorLine}`}>{operatorLine}</p>}
      </footer>
    </div>
  );
}
