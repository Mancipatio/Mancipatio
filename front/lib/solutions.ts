/** Route labels and workflow steps. Operational details live once in the guide renderer. */
export type Solution = {
  slug: string;
  name: string;
  eyebrow: string;
  appHref: string;
  howItWorks: { step: string; note: string }[];
};
export const SOLUTIONS: Solution[] = [
  {
    slug: "issuer-registry",
    name: "Issuer Registry & KYB",
    eyebrow: "Onboarding",
    appHref: "/apply",
    howItWorks: [
      {
        step: "Register",
        note: "The issuer submits its legal entity ID and jurisdiction.",
      },
      {
        step: "Review",
        note: "A Manci admin runs KYB due diligence off-chain.",
      },
      {
        step: "Verify",
        note: "The Super Admin records the issuer as Verified on-chain.",
      },
      {
        step: "Issue",
        note: "The current verified issuer uses the permissions required for each issuance action.",
      },
    ],
  },
  {
    slug: "tokenization",
    name: "Asset & RWA Tokenization",
    eyebrow: "Issuance",
    appHref: "/markets/types",
    howItWorks: [
      {
        step: "Verified issuer",
        note: "Only a KYB-verified issuer may create an asset.",
      },
      {
        step: "Create the asset",
        note: "Pick the asset type, name, symbol and jurisdiction rules.",
      },
      {
        step: "Add share classes",
        note: "Structure the cap table on top of the asset.",
      },
      {
        step: "Go active",
        note: "Move the asset to Active and start issuing tokens.",
      },
    ],
  },
  {
    slug: "share-classes",
    name: "Share Classes & Token-2022 Mints",
    eyebrow: "Structuring",
    appHref: "/markets/types",
    howItWorks: [
      {
        step: "Add a class",
        note: "Define type, rights, preference, voting weight and cap.",
      },
      {
        step: "Initialize the mint",
        note: "Deploy the Token-2022 mint for the class.",
      },
      {
        step: "Mint to treasury",
        note: "Issue the class's units into the issuer treasury.",
      },
      {
        step: "Lock supply",
        note: "Lock the class once the structure is final.",
      },
    ],
  },
  {
    slug: "compliance",
    name: "Compliance Engine",
    eyebrow: "Compliance",
    appHref: "/security",
    howItWorks: [
      {
        step: "Hook attached",
        note: "Every share-class mint ships with the transfer hook wired in.",
      },
      {
        step: "Screen on transfer",
        note: "Each transfer checks source and destination against the blocklist.",
      },
      {
        step: "Settle or reject",
        note: "Compliant transfers settle atomically; blocked ones revert.",
      },
      {
        step: "Clawback path",
        note: "The permanent delegate stands ready for court-ordered action.",
      },
    ],
  },
  {
    slug: "custody",
    name: "Custody Vaults",
    eyebrow: "Custody",
    appHref: "/security",
    howItWorks: [
      {
        step: "Open a vault",
        note: "Choose the vault type, amount, realize action and deadline.",
      },
      {
        step: "Fund the escrow",
        note: "Share units move into the program-owned escrow.",
      },
      {
        step: "Trigger",
        note: "The current authorized custodian triggers the lifecycle event.",
      },
      {
        step: "Complete or return",
        note: "Complete the event, or use its permitted return route after a positive deadline.",
      },
    ],
  },
  {
    slug: "launchpad",
    name: "Launchpad",
    eyebrow: "Primary markets",
    appHref: "/marketplace/launchpad",
    howItWorks: [
      {
        step: "Open the sale",
        note: "The issuer sets price, supply and window on a share class.",
      },
      {
        step: "Investors buy",
        note: "Eligible buyers accept the displayed document version and sign the atomic purchase.",
      },
      {
        step: "Proceeds escrow",
        note: "Payment accumulates in a program-owned escrow.",
      },
      {
        step: "Close the sale",
        note: "Proceeds follow the configured issuer or startup-vault route.",
      },
    ],
  },
  {
    slug: "otc",
    name: "OTC Market",
    eyebrow: "Secondary markets",
    appHref: "/marketplace/otc",
    howItWorks: [
      {
        step: "Create the offer",
        note: "The maker sets units, price and payment mint.",
      },
      {
        step: "Fund the escrow",
        note: "The maker deposits the units into the program escrow.",
      },
      {
        step: "Take the offer",
        note: "A buyer pays and receives the units atomically.",
      },
      {
        step: "Or cancel",
        note: "The maker reclaims the escrow any time before the offer is filled.",
      },
    ],
  },
  {
    slug: "governance",
    name: "Governance",
    eyebrow: "Governance",
    appHref: "/marketplace/governance",
    howItWorks: [
      {
        step: "Take a snapshot",
        note: "Capture holders and weights into a Merkle tree off-chain.",
      },
      {
        step: "Create the proposal",
        note: "An admin opens the proposal carrying the snapshot root.",
      },
      {
        step: "Holders vote",
        note: "Each voter submits their weight and a Merkle proof.",
      },
      {
        step: "Finalize",
        note: "After the window, anyone finalizes the weighted result.",
      },
    ],
  },
  {
    slug: "rights-vesting",
    name: "Rights Tokens & Vesting",
    eyebrow: "Vesting",
    appHref: "/marketplace/governance",
    howItWorks: [
      {
        step: "Create the issuance",
        note: "Open the Rights issuance and its escrow, then fund that escrow through the supported funding route.",
      },
      {
        step: "Publish a milestone",
        note: "An admin publishes a milestone with its entitlement Merkle root.",
      },
      {
        step: "Holders claim",
        note: "Each holder claims with a Merkle proof of their entitlement.",
      },
      {
        step: "Underlying delivered",
        note: "The program releases the underlying from escrow to the claimer.",
      },
    ],
  },
];
export function getSolution(slug: string): Solution | undefined {
  return SOLUTIONS.find((solution) => solution.slug === slug);
}
