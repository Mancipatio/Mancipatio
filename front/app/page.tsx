import type { Metadata } from "next";
import Link from "next/link";
import { Montserrat } from "next/font/google";
import { BrandLogo } from "@/components/brand-logo";
import { IconArrowUpRight, IconFile, IconLayers, IconShield } from "@/components/icons";
import { MANCI_X_URL } from "@/components/follow-on-x";
import { OwnershipVisual } from "@/components/marketing/ownership-visual";
import { detectNetwork, networkLabel } from "@/lib/network";
import { KYC_ONLY_MESSAGE, kycOnly } from "@/lib/features";
import { offeredAssetClasses } from "@/lib/pilot-scope";
import { ASSET_TYPES } from "@/lib/asset-types";
import { operatorFor, operatorFooterLine } from "@/lib/legal/operator";
import styles from "./landing.module.css";

const brandFont = Montserrat({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-brand", display: "swap" });

export const metadata: Metadata = {
  title: "Manci — Real assets. Clear rights. On-chain.",
  description:
    "Meet Manci: infrastructure for real-world assets on Solana. Explore asset records, understand ownership rights and complete identity verification.",
};

const capabilities = [
  {
    number: "01",
    icon: IconFile,
    title: "Know the asset",
    description: "Explore the asset registry and review the issuer, documents and ownership records behind each asset.",
    href: "/marketplace",
    link: "Explore the registry",
  },
  {
    number: "02",
    icon: IconLayers,
    title: "Understand your rights",
    description: "Learn how the asset, its legal structure and the rights attached to its tokens fit together.",
    href: "/docs",
    link: "Read the documentation",
  },
  {
    number: "03",
    icon: IconShield,
    title: "Verify your identity",
    description: "Create an account and complete identity verification for yourself or your company in one workspace.",
    href: "/verify",
    link: "Start verification",
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
              <p className={styles.eyebrow}><span /> REAL-WORLD ASSETS ON SOLANA</p>
              <h1 id="intro-title">Real assets.<br />Clear rights.<br /><span>On-chain.</span></h1>
              <p className={styles.lead}>We’re building the infrastructure to connect real-world assets with digital ownership. Understand the asset, review its rights and find your place in the Manci workspace.</p>
              <div className={styles.actions}>
                <Link href="/app" className={styles.primary}>Explore the app <IconArrowUpRight size={19} /></Link>
                <Link href="/how-it-works" className={styles.textLink}>How it works <span aria-hidden="true">→</span></Link>
              </div>
              <p className={styles.stage}><span /> {network === "mainnet" ? "Built on Solana mainnet" : `Explore on Solana ${networkLabel(network).toLowerCase()} · Test environment`}</p>
              {kycOnly(network) && <p className={styles.scopeNotice}>{KYC_ONLY_MESSAGE}</p>}
            </div>
            <figure className={styles.visual}>
              <OwnershipVisual />
              <figcaption><span>Real-world value</span><span aria-hidden="true">→</span><span>Defined rights</span><span aria-hidden="true">→</span><span>Digital ownership</span></figcaption>
            </figure>
          </section>

          <div className={styles.assetBand}>
            <div className={styles.container}><span className={styles.assetBandLabel}>UNDERSTAND THE ASSET</span><p>{assetTypes.map((asset, index) => <span className={styles.assetName} key={asset.slug}>{index > 0 && <span aria-hidden="true">/</span>}{asset.title}</span>)}</p><Link href={assetGuide} aria-label={assetTypes.length === 1 ? "Read the asset guide" : "Explore offered asset types"}><IconArrowUpRight size={20} /></Link></div>
          </div>

          <section className={styles.about} aria-labelledby="about-title">
            <div className={styles.container}>
              <div className={styles.aboutHeading}>
                <div><p className={styles.eyebrow}>MEET MANCI</p><h2 id="about-title">Real ownership.<br /><span>A clearer picture.</span></h2></div>
                <div className={styles.aboutCopy}><p>Manci brings asset records, documentation and identity verification into one workspace on Solana. We start with what ownership means: the asset, its issuer and the rights it carries.</p><Link href="/about" className={styles.textLink}>More about us <IconArrowUpRight size={17} /></Link></div>
              </div>
              <div className={styles.capabilities}>
                {capabilities.map(({ number, icon: Icon, title, description, href, link }) => <article key={number} className={styles.capability}><div className={styles.capabilityTop}><Icon size={25} /><span>{number}</span></div><h3>{title}</h3><p>{description}</p><Link href={href}>{link} <IconArrowUpRight size={17} /></Link></article>)}
              </div>
              <div className={styles.nextStep}>
                <div><p className={styles.eyebrow}>YOUR NEXT STEP</p><h2>Explore what’s possible.</h2><p>Get to know the platform, or talk to us about your asset.</p></div>
                <div className={styles.actions}><Link href="/app" className={styles.primary}>Open app <IconArrowUpRight size={19} /></Link><Link href="/contact" className={styles.textLink}>Let’s talk <IconArrowUpRight size={17} /></Link></div>
              </div>
            </div>
          </section>
        </main>
      </div>

      <footer className={styles.footer}>
        <div className={`${styles.container} ${styles.footerTop}`}><Link href="/" className={styles.logo}><BrandLogo /></Link><p>Real-world assets. Connected.</p><nav aria-label="Footer navigation"><Link href="/about">About</Link><Link href="/docs">Docs</Link><a href={MANCI_X_URL} target="_blank" rel="noopener noreferrer" aria-label="Manci on X (opens in a new tab)">X <IconArrowUpRight size={13} /></a><Link href="/contact">Contact</Link></nav></div>
        <div className={`${styles.container} ${styles.footerBottom}`}><span>© {new Date().getFullYear()} Manci</span><div><Link href="/risks">Risks</Link><Link href="/legal/terms">Terms</Link><Link href="/legal/privacy">Privacy</Link><Link href="/legal/company">Company &amp; licence</Link></div></div>
        {operatorLine && <p className={`${styles.container} ${styles.operatorLine}`}>{operatorLine}</p>}
      </footer>
    </div>
  );
}
