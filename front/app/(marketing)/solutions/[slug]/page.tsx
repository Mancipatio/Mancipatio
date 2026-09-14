import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import {
  Body,
  Button,
  ButtonRow,
  Card,
  Grid,
  H2,
  PageHeader,
  Section,
  Steps,
  TextLink,
  type StepItem,
} from "@/components/mx";
import { getSolution, SOLUTIONS } from "@/lib/solutions";

type ToolGuide = {
  intro: string;
  appHref: string;
  appLabel: string;
  details: { title: string; body: ReactNode }[];
  steps?: StepItem[];
};

// Each guide owns its operational details once. Shared security and legal
// explanations stay in their canonical references instead of repeated FAQs.
const GUIDES: Record<string, ToolGuide> = {
  "issuer-registry": {
    intro:
      "Register the legal entity behind an asset and follow its business-verification status before issuance.",
    appHref: "/apply",
    appLabel: "Apply to issue",
    details: [
      {
        title: "Issuer identity",
        body: "The registry records a legal entity ID and jurisdiction. Assets and their share classes link back to that issuer account.",
      },
      {
        title: "Issuer permissions",
        body: "The current issuer wallet must sign its actions. The Super Admin can grant or revoke separate Mint, Metadata and Conversion permissions. A separate global Admin role must be removed separately; KYB approval alone does not grant every operating permission.",
      },
      {
        title: "Status and suspension",
        body: "An issuer can be Pending, Verified, Rejected or Suspended. Current Verified status is required for new issuance and primary purchases. Suspension blocks those actions without removing existing token balances.",
      },
    ],
  },
  tokenization: {
    intro:
      "Create the asset record that connects an issuer, its documents and the token classes used for issuance and trading.",
    appHref: "/issuer/assets",
    appLabel: "Manage issuer assets",
    details: [
      {
        title: "Asset types",
        body: "Choose equity, revenue share, royalty, real estate, debt, commodity, physical good or other. An asset identifies the instrument; its share classes define the units and their economic terms.",
      },
      {
        title: "Document reference",
        body: "The asset references its legal document. Published whitepapers use a fixed version whose file hash is checked by the server. The purchase screen identifies the version you accept; historical unverified references are labeled separately. Read that issuance’s documents for its rights.",
      },
      {
        title: "Lifecycle",
        body: "Draft, Active, Frozen and Wound down describe the asset's lifecycle. Set up the share classes while the asset is Draft, before moving to issuance.",
      },
      {
        title: "Jurisdiction settings",
        body: "The asset records allowed countries, a holder cap, a restricted-transfer period and a peer-to-peer setting. Consult the security reference for how eligibility is checked in each transaction flow.",
      },
    ],
  },
  "share-classes": {
    intro:
      "Separate an asset into classes with their own rights, voting weight, supply settings and Token-2022 mint.",
    appHref: "/issuer/share-classes",
    appLabel: "Manage share classes",
    steps: [
      {
        title: "Add a class",
        body: "Define its type, rights, preference, voting weight and supply cap while the asset is Draft.",
      },
      {
        title: "Initialize the mint",
        body: "The issuer’s current wallet creates the mint using its Mint permission or a valid global Admin role.",
      },
      {
        title: "Mint to treasury",
        body: "Issue units into the issuer treasury for distribution through the supported sale and transfer flows.",
      },
      {
        title: "Lock supply",
        body: "An authorized admin records the end of launch distribution once the structure is final.",
      },
    ],
    details: [
      {
        title: "Separate classes and balances",
        body: "Common, preferred and debt tranches can carry different terms. Each class has its own mint and balance; holding one class does not mean holding the others.",
      },
      {
        title: "Rights and payment order",
        body: "Class settings include vote, dividend, liquidation preference, convertible, redeemable and transferable rights. Voting weight, the preference multiplier in basis points and seniority are recorded separately.",
      },
      {
        title: "Supply cap versus supply lock",
        body: "A maximum supply limits issuance. Physical-good classes also track lifetime minted units, so burning does not reopen their issuance allowance. Lock supply is a one-way Admin action; check the cap and post-launch minting setting when assessing dilution.",
      },
      {
        title: "Unique physical goods",
        body: "A unique physical good uses one class capped at one unit, with post-launch minting disabled. This prevents separate classes from representing multiple claims to the same item.",
      },
    ],
  },
  compliance: {
    intro:
      "Understand where a token's transfer checks apply and where to review the eligibility requirements for your wallet.",
    appHref: "/portfolio",
    appLabel: "View investor passport",
    steps: [
      {
        title: "Hook attached",
        body: "A share-class mint is initialized with its transfer hook.",
      },
      {
        title: "Screen the transfer",
        body: "The hook checks the transfer under the class's configured compliance mode.",
      },
      {
        title: "Settle or reject",
        body: "The transaction settles only if its required checks pass.",
      },
    ],
    details: [
      {
        title: "Before receiving units",
        body: "Check the class's compliance mode and your investor passport in Portfolio. For a KYC-gated class, approval, expiry and jurisdiction affect the receiving wallet's eligibility.",
      },
      {
        title: "Rules and restricted actions",
        body: (
          <>
            The{" "}
            <TextLink href="/security">
              security and compliance reference
            </TextLink>{" "}
            explains transfer modes, issuance checks, escrow exits, the
            blocklist and the permanent delegate. Use that reference for the
            scope of each authority and control.
          </>
        ),
      },
    ],
  },
  custody: {
    intro:
      "Follow escrowed units through conversion, delivery and redemption, including their completion and return paths.",
    appHref: "/portfolio/delivery",
    appLabel: "Open delivery requests",
    details: [
      {
        title: "Vault types and states",
        body: "Custody vault types cover vesting, conversion pending, delivery escrow and redemption queues. The lifecycle moves from Active to Triggered to Realized, with a separate revert path for an untriggered vault after its deadline.",
      },
      {
        title: "Completion and return",
        body: "Completion burns escrowed units and records the result. Once a positive deadline has passed, a holder return can be submitted permissionlessly for an Active or Triggered vault. Before then, operator actions require the current authorized custodian. Return eligibility and recipient checks still apply.",
      },
      {
        title: "Delivery requests",
        body: "Delivery deposits tokens into escrow. A completed return releases the holder’s recorded deposit; confirmed delivery burns the units. A holder’s refund may complete while the vault still contains someone else’s surplus. Review the actual request and transaction state.",
      },
      {
        title: "Interrupted recording",
        body: "If the wallet submitted a deposit or return but the app record is pending, keep the transaction receipt and retry recording the existing action. Refresh and verify the vault before sending anything again.",
      },
      {
        title: "Conversion requests",
        body: (
          <>
            <TextLink href="/portfolio/conversion">
              Conversion requests
            </TextLink>{" "}
            track units escrowed for an off-chain conversion. They are returned
            if cancelled and burned once the conversion is executed.
          </>
        ),
      },
    ],
  },
  launchpad: {
    intro:
      "Buy newly issued units in a primary sale, or configure a sale and collect its proceeds as an issuer.",
    appHref: "/marketplace/launchpad",
    appLabel: "Browse primary sales",
    details: [
      {
        title: "Review the sale terms",
        body: "Check the share class, payment token, price, remaining supply and current eligibility. Read the published whitepaper version and accept it before purchase; your signed purchase records that version and its file hash.",
      },
      {
        title: "Payment and proceeds",
        body: "The purchase mints units and deposits payment into escrow atomically. Proceeds follow the sale’s configured route: issuer withdrawal or a startup payout vault with its own release rules. Closing a sale does not override those rules.",
      },
      {
        title: "Resume the record",
        body: "A confirmed purchase can appear as pending while finalization or recording completes. Use its saved receipt to retry recording. Issuers likewise publish an already opened sale from the saved address instead of opening another one.",
      },
      {
        title: "After a purchase",
        body: (
          <>
            Purchased units appear in Portfolio. Existing holders can use the{" "}
            <TextLink href="/solutions/otc">OTC market</TextLink> to offer units
            for resale; a sale does not promise a future buyer or market price.
          </>
        ),
      },
    ],
  },
  otc: {
    intro:
      "Create a sell offer for existing units, fund its escrow and settle with a buyer under the recorded terms.",
    appHref: "/marketplace/otc",
    appLabel: "Browse OTC offers",
    details: [
      {
        title: "Price and funding",
        body: "An offer records the number of units, total price and payment token. Creating an offer and funding it are separate actions: an offer can be taken only after its required deposit has been recorded.",
      },
      {
        title: "Settlement",
        body: "Taking a funded offer exchanges the buyer's payment and escrowed units in one transaction. A maker can post without an existing counterparty; completion requires a buyer to accept the terms.",
      },
      {
        title: "Cancellation and expiry",
        body: "The maker can cancel before the offer is filled. An optional expiry prevents later fills; after expiry, anyone can trigger the on-chain refund of the escrowed units to the maker.",
      },
    ],
  },
  governance: {
    intro:
      "Read advisory proposals, submit a snapshot-weighted vote and review the result after the voting window closes.",
    appHref: "/marketplace/governance",
    appLabel: "Browse proposals",
    details: [
      {
        title: "Snapshot eligibility",
        body: "A proposal commits a holder snapshot as a Merkle root. Your proof establishes the weight assigned to your wallet in that snapshot; later token purchases or transfers do not change that proposal's voting weight.",
      },
      {
        title: "Startup payout-vault rights",
        body: "Startup vault votes, return-capital refunds and investor yield use the saved original-investor entitlement snapshot for that vault or round. Selling or buying tokens later does not replace that snapshot. These rights are separate from an ordinary current-holder vote or a new income distribution.",
      },
      {
        title: "Vote and outcome",
        body: "For, Against and Abstain are counted by weight. A vote record tracks participation for the proposal. Finalization records an advisory result; it does not automatically execute an issuer action.",
      },
    ],
  },
  "rights-vesting": {
    intro:
      "Use vesting series for scheduled delivery to named wallets, or claim milestones from an existing Rights Token issuance.",
    appHref: "/portfolio/vesting",
    appLabel: "View my vesting positions",
    steps: [
      {
        title: "Set up a series",
        body: (
          <>
            In <TextLink href="/issuer/vesting-series">Vesting series</TextLink>
            , choose one token, one schedule, recipient allocations and the
            delivery settings, then submit them for review.
          </>
        ),
      },
      {
        title: "Create, finalize and fund",
        body: "Approval saves the exact terms. Create a Draft, add its approved recipient positions in resumable batches, and finalize before the first unlock. Fund it only after finalization and the completed series record.",
      },
      {
        title: "Follow the schedule",
        body: "Recipients see their unlock dates, funding and series settings in My vesting positions.",
      },
      {
        title: "Receive unlocked tokens",
        body: "Claim-mode recipients claim their available amount; push mode lets a transaction deliver it to the recorded recipient.",
      },
    ],
    details: [
      {
        title: "Series positions stay with the recipient",
        body: "Each series has one token, one schedule and named recipient positions. The app supports up to 48 tranches and 200 recipients. Draft positions cannot release tokens; finalized positions become deliverable only when the allocation is fully funded.",
      },
      {
        title: "Timing and delivery settings",
        body: "Timing can be automatic or require approval within a configured window. In approval mode, an unlocked tranche becomes deliverable when approved or when that window lapses. Delivery is either recipient claim or push to the recorded wallet.",
      },
      {
        title: "Cancellation and recovery settings",
        body: "An incomplete or expired Draft can be aborted without creating recipient or pre-cliff entitlement. After finalization, cancellation and wallet-recovery options follow the approved settings. Cancelling an Active series preserves its calculated final vested entitlement.",
      },
      {
        title: "Funding and surplus",
        body: "New deposits cannot exceed the scheduled total. The app shows cumulative deposits and the actual remaining escrow balance separately. Active surplus can be withdrawn only above the unreleased recipient reserve; legacy or gifted surplus may require receiver verification.",
      },
      {
        title: "Resume after interruption",
        body: "Use the saved series and transaction receipts to continue missing setup batches or retry recording. Do not recreate positions or repeat a deposit whose confirmation is still being checked.",
      },
      {
        title: "Legacy Rights Token claims",
        body: "Rights Tokens are a separate token model. Each milestone has its own unlock time, funded pool and saved wallet-entitlement snapshot. Selling the token does not rewrite an existing milestone snapshot or create a vesting-series position.",
      },
    ],
  },
};

export function generateStaticParams() {
  return SOLUTIONS.map((solution) => ({ slug: solution.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const solution = getSolution(slug);
  return {
    title: solution ? `${solution.name} — Mancipatio` : "Mancipatio",
    description: GUIDES[slug]?.intro,
  };
}

export default async function SolutionPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const solution = getSolution(slug);
  const guide = GUIDES[slug];
  if (!solution || !guide) notFound();

  const sourceSteps = solution.howItWorks.map(({ step, note }) => ({
    title: step,
    body: note,
  }));
  const isVesting = slug === "rights-vesting";

  return (
    <>
      <PageHeader
        eyebrow={`${solution.eyebrow} / Platform guide`}
        title={solution.name}
        lede={guide.intro}
      >
        <ButtonRow>
          <Button href={guide.appHref}>{guide.appLabel}</Button>
          <TextLink href="/docs#platform-tools">All platform guides →</TextLink>
        </ButtonRow>
      </PageHeader>

      <Section id="workflow">
        <H2>{isVesting ? "Vesting series workflow" : "Workflow"}</H2>
        <Steps className="mt-6" items={guide.steps ?? sourceSteps} />
      </Section>

      {isVesting ? (
        <Section id="legacy-rights">
          <H2>Legacy Rights Token workflow</H2>
          <Body className="mt-3">
            Existing Rights Token holders use{" "}
            <TextLink href="/portfolio/rights">My claims</TextLink> for
            milestone claims. This flow is separate from vesting series.
          </Body>
          <Steps className="mt-6" items={sourceSteps} />
        </Section>
      ) : null}

      <Section id="details">
        <H2 className="mb-6">Details to check</H2>
        <Grid cols={2}>
          {guide.details.map((detail) => (
            <Card key={detail.title} title={detail.title} body={detail.body} />
          ))}
        </Grid>
      </Section>

      <Section id="references">
        <H2>Related reference</H2>
        <Body className="mt-3">
          Read the shared rules for{" "}
          <TextLink href="/security">security and compliance</TextLink> and the{" "}
          <TextLink href="/legal-structure">legal structure</TextLink> that
          connects token terms to the underlying instrument.
        </Body>
      </Section>
    </>
  );
}
