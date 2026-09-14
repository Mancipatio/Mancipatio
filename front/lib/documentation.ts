/** Canonical navigation and topic ownership for the public knowledge base. */
export type DocumentationTopic = {
  href: string;
  title: string;
  description: string;
  keywords?: string;
};
export type DocumentationGroup = {
  id: string;
  title: string;
  description: string;
  topics: DocumentationTopic[];
};

export const DOCUMENTATION_GROUPS: DocumentationGroup[] = [
  {
    id: "getting-started",
    title: "Getting started",
    description: "Find your way from a first visit to your first action.",
    topics: [
      {
        href: "/investors",
        title: "Investor guide",
        description:
          "Explore an asset, review its documents and participate in a sale.",
        keywords: "buy buying wallet portfolio onboarding",
      },
      {
        href: "/how-it-works",
        title: "Issuing an asset",
        description:
          "The shared process from an issuer application to token issuance.",
        keywords: "issuer launch apply company",
      },
      {
        href: "/faq",
        title: "Common questions",
        description: "Short answers and directions to the relevant guide.",
        keywords: "help faq support",
      },
    ],
  },
  {
    id: "asset-reference",
    title: "Assets & documents",
    description:
      "Understand the instrument, then read the terms of the actual issuance.",
    topics: [
      {
        href: "/markets/types",
        title: "Asset types",
        description:
          "Compare the eight categories and open their individual fact sheets.",
        keywords:
          "equity debt real estate royalty revenue share commodity physical",
      },
      {
        href: "/markets/whitepapers",
        title: "Whitepapers & disclosures",
        description:
          "Published issuer documents, basic information and document references.",
        keywords: "pdf documents library whitepaper approved",
      },
    ],
  },
  {
    id: "platform-tools",
    title: "Platform guides",
    description: "How each part of the asset lifecycle works inside the app.",
    topics: [
      {
        href: "/solutions/issuer-registry",
        title: "Issuer registration & KYB",
        description: "Issuer identity, verification and registry status.",
        keywords: "company onboarding",
      },
      {
        href: "/solutions/tokenization",
        title: "Asset registration",
        description: "Create the asset record and attach its documentation.",
        keywords: "tokenization rwa",
      },
      {
        href: "/solutions/share-classes",
        title: "Share classes & supply",
        description: "Separate token classes, rights and supply controls.",
        keywords: "mint token-2022 cap",
      },
      {
        href: "/solutions/launchpad",
        title: "Primary sales",
        description: "Sale terms, purchases and the proceeds workflow.",
        keywords: "buy launchpad funding",
      },
      {
        href: "/solutions/otc",
        title: "OTC trading",
        description: "Create and fund an offer, settle it or cancel it.",
        keywords: "sell selling buy buying secondary market escrow",
      },
      {
        href: "/solutions/custody",
        title: "Custody & delivery",
        description: "Escrow states, delivery, returns and token burning.",
        keywords: "redeem physical asset",
      },
      {
        href: "/solutions/governance",
        title: "Governance",
        description: "Proposals, snapshots, votes and outcomes.",
        keywords: "voting rights",
      },
      {
        href: "/solutions/rights-vesting",
        title: "Vesting & claims",
        description:
          "Vesting series, scheduled releases and Rights-token claims.",
        keywords: "unlock milestone income merkle",
      },
      {
        href: "/solutions/compliance",
        title: "Eligibility & passports",
        description:
          "Investor eligibility and the checks used in app workflows.",
        keywords: "kyc compliance identity restrictions",
      },
    ],
  },
  {
    id: "trust-and-rules",
    title: "Trust & rules",
    description: "The legal framework, token controls and risks to understand.",
    topics: [
      {
        href: "/legal-structure",
        title: "Legal structure",
        description: "How the documented rights relate to a specific issuance.",
        keywords: "spv pledge conversion recourse",
      },
      {
        href: "/security",
        title: "Security & controls",
        description:
          "Program authorities, transfer controls and custody mechanisms.",
        keywords: "blocklist clawback transfer hook",
      },
      {
        href: "/risks",
        title: "Risk disclosure",
        description: "Issuer, liquidity, legal and technology risks.",
        keywords: "default investment",
      },
      {
        href: "/legal/terms",
        title: "Terms of service",
        description: "The terms governing use of the platform.",
      },
      {
        href: "/legal/privacy",
        title: "Privacy policy",
        description: "How personal information is handled.",
      },
    ],
  },
  {
    id: "reference",
    title: "Platform information",
    description: "Costs, background and support.",
    topics: [
      {
        href: "/docs/pilot",
        title: "Pilot operator guide",
        description:
          "Check a test release, approved funding and recovery of pending records.",
        keywords: "operator test devnet recovery retry receipt deployment",
      },
      {
        href: "/pricing",
        title: "Fees & costs",
        description: "Platform pricing and costs of structuring an issuance.",
      },
      {
        href: "/about",
        title: "About Mancipatio",
        description: "The project, its purpose and current stage.",
      },
      {
        href: "/contact",
        title: "Contact & support",
        description: "Discuss an asset, an application or a question.",
      },
    ],
  },
];

export const DOCUMENTATION_TOPICS = DOCUMENTATION_GROUPS.flatMap(
  (group) => group.topics,
);

export function documentationTopic(
  path: string,
): DocumentationTopic | undefined {
  return (
    DOCUMENTATION_TOPICS.find((topic) => topic.href === path) ??
    (path.startsWith("/markets/types/")
      ? DOCUMENTATION_TOPICS.find((topic) => topic.href === "/markets/types")
      : undefined)
  );
}

export function isDocumentationPath(path: string): boolean {
  return (
    path === "/docs" ||
    path === "/platform" ||
    path === "/solutions" ||
    Boolean(documentationTopic(path))
  );
}
