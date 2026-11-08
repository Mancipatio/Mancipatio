// The issuer journey: where a company stands in the whole engagement, step by
// step, and who acts next. One pure function over data the app already reads;
// rendered at the top of the issuer workspace (/issuer, audience "issuer") and
// read-only in the admin issuer detail (/admin/issuers, audience "admin") by
// components/issuer-journey.tsx.
//
// The eight steps, in the order an engagement runs:
//   1. Company verification (KYB): the account's KYB review and the on-chain
//      Issuer's KYB status (lib/issuer-status.ts) — done only once the chain
//      says Verified, the status that unlocks issuance;
//   2. Application review (launch_applications);
//   3. Legal structure: a Serbian company issuing directly, or the Serbian SPV
//      Manci incorporates (spvs; the applicant's choice is
//      company_formation_requested, lib/apply-spv.ts);
//   4. The shareholders' decision and the issuance documents, whose hash the
//      asset records (Asset.legal_doc_hash, set once at create_asset);
//   5. The asset and its share classes on-chain, each with its token mint,
//      activated by Manci;
//   6. Units minted (ShareClass.lifetime_minted against max_supply);
//   7. Placement: an approved primary sale (Sale, SaleApproval, the
//      public-sale request) or direct issuance to named holders ("Send to
//      wallets": units that left the treasury other than by a sale);
//   8. Holders and conversions (conversion requests for the admin; for the
//      issuer, what the chain shows: units burned, as a completed conversion
//      burns them).
//
// Rules:
//   - Off-chain work (documents review, shareholders' decisions, the notary
//     and the business register) is EXPLAINED, never faked: such a step says
//     who is doing it and is marked `offChain`; it is "done" only on evidence
//     the app has (an approved application, an active SPV, a recorded hash).
//   - Data that could not be read is never read as progress: the step says so
//     (`unknown`) and keeps the most conservative state, never "done".
//   - States are the company's point of view ("waiting_on_you" = the company
//     acts next); the admin panel labels them "waiting on the issuer".
//   - Links go through navHrefVisible, so KYC-only mode (issuance paused) and
//     switched-off modules hide the entry actions while the tracker still
//     renders read-only; `paused` tells the panel to say so.
//
// Pure and node-safe: tests/issuer-journey.test.ts.

import type { AccountWalletKycStatus } from "@/lib/account";
import { KybStatus } from "@/lib/generated/asset_registry/types/kybStatus";
import { issuerStatus } from "@/lib/issuer-status";
import { moduleEnabled, scopeEnabled } from "@/lib/features";
import { navHrefVisible } from "@/lib/pilot-scope";
import { SERBIA_INCORPORATION, SERBIAN_SPV_GUIDE } from "@/lib/apply-spv";

/** ISO-3166 numeric code of Serbia (Issuer.jurisdiction; spvs.country defaults to it). */
export const SERBIA_ISO_NUMERIC = 688;

export type JourneyAudience = "issuer" | "admin";
export type JourneyState = "done" | "in_progress" | "waiting_on_manci" | "waiting_on_you" | "not_started" | "not_applicable";
export type JourneyActor = "issuer" | "manci" | "holders";
export type JourneyStepId =
  | "kyb"
  | "application"
  | "legal_structure"
  | "documents"
  | "on_chain"
  | "minted"
  | "placement"
  | "holders";

export const JOURNEY_STEP_TITLES: Record<JourneyStepId, string> = {
  kyb: "Company verification (KYB)",
  application: "Application review",
  legal_structure: "Legal structure",
  documents: "Shareholders' decision and issuance documents",
  on_chain: "Asset and share classes on-chain",
  minted: "Units minted",
  placement: "Placement",
  holders: "Holders and conversions",
};

export type JourneyApplication = {
  status: "pending" | "needs_changes" | "rejected" | "approved";
  applicantKind: "company" | "individual" | null;
  incorporation: string | null;
  companyFormationRequested: boolean;
};

export type JourneySpv = { name: string; status: "planned" | "incorporating" | "active" | "retired" };

export type JourneySaleRequest = {
  status: "requested" | "withdrawn" | "declined" | "opened";
  /** From the raise-cap ledger: approved (not opened yet), opened, closed; null: none yet. */
  outcome: "approved" | "opened" | "closed" | null;
};

export type JourneyClass = {
  mintInitialized: boolean;
  /** max_supply; null = uncapped. */
  maxSupply: bigint | null;
  /** Units ever created (burns never reduce it). */
  lifetimeMinted: bigint;
  /** Units in existence now (burns reduce it). */
  circulatingSupply: bigint;
  supplyLocked: boolean;
  /** Units in the issuer's treasury token account; null when it could not be read. */
  treasury: bigint | null;
  /** Units sold in this class's primary sales (the sum of Sale.sold). */
  sold: bigint;
  /** Sales of this class open now. */
  openSales: number;
  /** Live SaleApproval accounts of this class (approved, not opened); null when unread. */
  liveApprovals: number | null;
  /** The class's public-sale request; null: none; undefined: not read. */
  saleRequest?: JourneySaleRequest | null;
  /** Conversion requests of the class by stage (the admin reads them); undefined: not read. */
  conversions?: { requested: number; vaultOpened: number; deposited: number; converted: number };
};

export type JourneyAsset = {
  address: string;
  name: string;
  status: "draft" | "active" | "frozen" | "wound_down";
  /** Hex SHA-256 of the asset's legal document; null when the on-chain hash is all zeros. */
  legalDocHash: string | null;
  classes: JourneyClass[];
};

export type JourneyInput = {
  audience: JourneyAudience;
  /**
   * The account's own verification (issuer audience). null: signed out;
   * undefined: signed in but not loaded. The admin panel passes null and
   * reads the on-chain status alone.
   */
  verification?: { kyc: AccountWalletKycStatus; kyb: AccountWalletKycStatus; documentsRequested: number } | null;
  /**
   * The on-chain Issuer. null: none is registered (for this wallet);
   * undefined: not known (the chain snapshot is not in or failed, no wallet
   * is connected, or the wallet is not one of the account's).
   */
  issuer: { kybStatus: number; jurisdiction: number; authority: string } | null | undefined;
  /** The latest application; null: none on record; undefined: not read. */
  application: JourneyApplication | null | undefined;
  /** The SPV whose issuer_pda is this issuer; null: none; undefined: not read. */
  spv: JourneySpv | null | undefined;
  /** The issuer's assets (archived ones left out) with their classes; undefined: not read. */
  assets: JourneyAsset[] | undefined;
};

export type JourneyEnvironment = {
  /** navHrefVisible: KYC-only mode and switched-off modules hide entry links. */
  linkVisible: (href: string) => boolean;
  /** Issuance is open (KYC-only mode off). */
  issuanceOpen: boolean;
  /** Conversion into registered shares is offered on this network. */
  conversionOffered: boolean;
};

export type JourneyStep = {
  id: JourneyStepId;
  number: number;
  title: string;
  state: JourneyState;
  /** Who acts on this step now (or acted, once done). */
  actor: JourneyActor;
  /** One plain-English sentence. */
  explanation: string;
  /** Where it happens, for this audience; null when hidden or there is no page. */
  href: string | null;
  linkLabel: string | null;
  /** Part of the step happens off the platform (documents, decisions, notary, business register). */
  offChain: boolean;
  /** The data behind the step could not be read; the state is the conservative one. */
  unknown: boolean;
};

export type IssuerJourney = {
  steps: JourneyStep[];
  /** The first step waiting on someone (else the first in progress): who acts next. */
  next: JourneyStep | null;
  /** Issuance is paused (KYC-only mode): the tracker is read-only. */
  paused: boolean;
};

export function defaultJourneyEnvironment(): JourneyEnvironment {
  return {
    linkVisible: (href) => navHrefVisible(href),
    issuanceOpen: scopeEnabled("issuance"),
    conversionOffered: moduleEnabled("custodyConversion"),
  };
}

// ── helpers ─────────────────────────────────────────────────────────────────

const ZERO = BigInt(0);

function sum(values: readonly bigint[]): bigint {
  return values.reduce((a, b) => a + b, ZERO);
}

/** 12345 → "12,345" (exact for any bigint). */
export function formatUnits(n: bigint): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function plural(n: bigint | number, one: string, many: string): string {
  return `${typeof n === "bigint" ? formatUnits(n) : n} ${n === 1 || n === BigInt(1) ? one : many}`;
}

function shortHash(hex: string): string {
  return `${hex.slice(0, 8)}…${hex.slice(-8)}`;
}

/** The figures several steps read, computed once. */
type Facts = {
  classes: JourneyClass[];
  minted: bigint;
  circulating: bigint;
  burned: bigint;
  sold: bigint;
  openSales: number;
  /** Units that left the treasury or were minted straight to buyers; null when a treasury is unread. */
  placed: bigint | null;
  /** Units sent directly to named holders (placed minus sold); null when unknown. */
  direct: bigint | null;
  cap: bigint | null;
  allLocked: boolean;
  /** Live approvals not opened yet (a known 0 when none); null when unread. */
  liveApprovals: number | null;
  requestWaiting: boolean;
  requestApproved: boolean;
  requestDeclined: boolean;
  /** Units are with holders (sold, or sent out of the treasury). */
  holders: boolean;
  /** Whether units are with holders is known (a treasury read, or units sold). */
  holdersKnown: boolean;
  /** Every placement read is in: treasuries, approvals and each class's sale request. */
  placementKnown: boolean;
};

function facts(assets: readonly JourneyAsset[]): Facts {
  const classes = assets.flatMap((a) => a.classes);
  const minted = sum(classes.map((c) => c.lifetimeMinted));
  const circulating = sum(classes.map((c) => c.circulatingSupply));
  const sold = sum(classes.map((c) => c.sold));
  // A class without a mint has no treasury account: 0, exactly.
  const treasuryKnown = classes.every((c) => c.treasury !== null || !c.mintInitialized);
  const treasury = treasuryKnown ? sum(classes.map((c) => c.treasury ?? ZERO)) : null;
  const placed = treasury === null ? null : minted - treasury;
  const direct = placed === null ? null : placed > sold ? placed - sold : ZERO;
  const capped = classes.length > 0 && classes.every((c) => c.maxSupply !== null);
  const requests = classes.map((c) => c.saleRequest).filter((r): r is JourneySaleRequest => !!r);
  return {
    classes,
    minted,
    circulating,
    burned: minted > circulating ? minted - circulating : ZERO,
    sold,
    openSales: classes.reduce((n, c) => n + c.openSales, 0),
    placed,
    direct,
    cap: capped ? sum(classes.map((c) => c.maxSupply ?? ZERO)) : null,
    allLocked: classes.length > 0 && classes.every((c) => c.supplyLocked),
    liveApprovals: classes.some((c) => c.liveApprovals === null) ? null : classes.reduce((n, c) => n + (c.liveApprovals ?? 0), 0),
    requestWaiting: requests.some((r) => r.status === "requested" && r.outcome === null),
    requestApproved: requests.some((r) => r.status === "requested" && r.outcome === "approved"),
    requestDeclined: requests.some((r) => r.status === "declined"),
    holders: placed !== null ? placed > ZERO : sold > ZERO,
    holdersKnown: placed !== null || sold > ZERO,
    placementKnown:
      placed !== null &&
      !classes.some((c) => c.liveApprovals === null) &&
      classes.every((c) => c.saleRequest !== undefined),
  };
}

/** The input once the chain snapshot is in: the steps that read assets get this. */
type KnownInput = JourneyInput & { assets: JourneyAsset[] };

type Draft = Omit<JourneyStep, "id" | "number" | "title" | "href" | "linkLabel" | "unknown"> & {
  link?: readonly [href: string, label: string] | null;
  unknown?: boolean;
};

// ── the steps ───────────────────────────────────────────────────────────────

function kybStep(input: JourneyInput): Draft {
  const you = input.audience === "issuer";
  const offChain = true;
  const issuer = input.issuer;
  const statusLink = you ? (["/issuer/status", "Review status"] as const) : null;
  const docsLink = ["/issuer/verification?type=kyb", "Company documents"] as const;
  const dossier = issuer ? ([`/admin/clients?q=${encodeURIComponent(issuer.authority)}`, "KYB dossier"] as const) : null;
  if (issuer) {
    switch (issuer.kybStatus) {
      case KybStatus.Verified:
        return { state: "done", actor: "manci", offChain, link: you ? statusLink : dossier,
          explanation: you ? "Your company's verification is approved and recorded on-chain." : "The issuer's KYB is verified and recorded on-chain." };
      case KybStatus.Rejected:
        return { state: "waiting_on_you", actor: "issuer", offChain, link: you ? statusLink : dossier,
          explanation: you ? "Company verification was rejected; contact the team with your legal entity ID." : "The issuer's KYB was rejected on-chain; the issuer has to contact the team." };
      case KybStatus.Suspended:
        return you
          ? { state: "waiting_on_you", actor: "issuer", offChain, link: statusLink,
              explanation: "Issuer access is suspended; contact the team to resolve it." }
          : { state: "waiting_on_manci", actor: "manci", offChain, link: dossier,
              explanation: "Issuer access is suspended on-chain until compliance restores it." };
      case KybStatus.Pending:
        break;
      default:
        return { state: "not_started", actor: "manci", offChain, link: you ? statusLink : dossier, unknown: true,
          explanation: "The on-chain verification status could not be read; refresh to update it." };
    }
    if (!you) {
      return { state: "waiting_on_manci", actor: "manci", offChain, link: dossier,
        explanation: "KYB review is pending: check the dossier, then record the decision on-chain." };
    }
  }
  const v = input.verification;
  if (!you) {
    // The admin panel is opened from a registered issuer; without one there is nothing to review.
    return issuer === undefined
      ? { state: "not_started", actor: "manci", offChain, link: null, unknown: true,
          explanation: "The on-chain issuer could not be read; refresh to update it." }
      : { state: "not_started", actor: "issuer", offChain, link: null, explanation: "No issuer is registered yet." };
  }
  if (v === undefined) {
    return { state: "not_started", actor: "issuer", offChain, link: statusLink, unknown: true,
      explanation: "Your verification status is not loaded yet." };
  }
  if (v === null) {
    return { state: "waiting_on_you", actor: "issuer", offChain, link: ["/issuer/verification", "Start verification"],
      explanation: "Sign in and submit your company's documents (KYB), or verify your identity (KYC) if you do not have a company yet." };
  }
  if (v.kyb === "verified") {
    if (issuer) {
      return { state: "waiting_on_manci", actor: "manci", offChain, link: statusLink,
        explanation: "Your company documents are approved; Manci records the verification on-chain." };
    }
    // What comes next depends on data that is not loaded: never guess "register your wallet".
    if (issuer === undefined) {
      return { state: "not_started", actor: "issuer", offChain, link: statusLink, unknown: true,
        explanation: "Your company documents are approved; your on-chain issuer status is not loaded yet." };
    }
    const app = input.application;
    if (app === undefined) {
      return { state: "not_started", actor: "issuer", offChain, link: statusLink, unknown: true,
        explanation: "Your company documents are approved; the next step depends on your application, which is not loaded yet." };
    }
    // Through an SPV, the issuer is the SPV Manci incorporates, not the applicant's own company.
    if (app && (app.companyFormationRequested || app.applicantKind === "individual")) {
      return app.status === "approved"
        ? { state: "waiting_on_manci", actor: "manci", offChain, link: statusLink,
            explanation: "Your company documents are approved; the SPV Manci incorporates is registered and verified as the issuer once it exists." }
        : { state: "in_progress", actor: "manci", offChain, link: statusLink,
            explanation: "Your company documents are approved; the issuer will be the SPV Manci incorporates, verified once it exists." };
    }
    const onboarding = ["/issuer/onboarding", "Issuer onboarding"] as const;
    return app?.status === "approved"
      ? { state: "waiting_on_you", actor: "issuer", offChain, link: onboarding,
          explanation: "Your company documents are approved; register your issuer wallet in Issuer onboarding so Manci can record the verification on-chain." }
      : { state: "in_progress", actor: "issuer", offChain, link: onboarding,
          explanation: "Your company documents are approved; once the application is approved, register your issuer wallet so Manci can record the verification on-chain." };
  }
  // A decision beats an open document request (as lib/issuer-workflow.ts puts "blocked" first).
  if (v.kyb === "rejected" || v.kyb === "suspended" || v.kyb === "expired") {
    return { state: "waiting_on_you", actor: "issuer", offChain, link: statusLink,
      explanation: v.kyb === "expired"
        ? "Your company verification has expired; renew it to continue."
        : `Company verification is ${v.kyb === "rejected" ? "not approved" : "suspended"}; contact the compliance team.` };
  }
  if (v.kyb === "more_info" || (v.kyb === "pending" && v.documentsRequested > 0)) {
    return { state: "waiting_on_you", actor: "issuer", offChain, link: docsLink,
      explanation: "Manci asked for more company documents; supply them to continue." };
  }
  if (v.kyb === "pending") {
    return { state: "waiting_on_manci", actor: "manci", offChain, link: statusLink, explanation: "Manci is reviewing your company documents." };
  }
  // No company verification: a founder applying as an individual (verified KYC).
  if (v.kyc === "verified") {
    const app = input.application;
    if (app?.applicantKind === "individual" && app.status === "approved") {
      return { state: "waiting_on_manci", actor: "manci", offChain, link: statusLink,
        explanation: "Your identity is verified (KYC); the issuing company is verified once the SPV Manci incorporates for you is registered." };
    }
    return { state: "in_progress", actor: "issuer", offChain, link: docsLink,
      explanation: "Your identity is verified (KYC): apply as an individual and Manci incorporates the company, or verify your existing company (KYB)." };
  }
  if (v.kyc === "pending" || v.kyc === "more_info") {
    return v.kyc === "pending"
      ? { state: "waiting_on_manci", actor: "manci", offChain, link: statusLink, explanation: "Manci is reviewing your identity verification (KYC)." }
      : { state: "waiting_on_you", actor: "issuer", offChain, link: ["/issuer/verification?type=kyc", "Identity documents"],
          explanation: "Manci asked for more identity documents; supply them to continue." };
  }
  return { state: "waiting_on_you", actor: "issuer", offChain, link: ["/issuer/verification", "Start verification"],
    explanation: "Submit your company's documents (KYB), or verify your identity (KYC) if you do not have a company yet." };
}

function applicationStep(input: JourneyInput): Draft {
  const you = input.audience === "issuer";
  const link = you ? (["/apply", "Application"] as const) : (["/admin/applications", "Application queue"] as const);
  const app = input.application;
  const offChain = false;
  if (app === undefined) {
    // Signed out, there is nothing to load yet: the step simply has not started.
    if (you && input.verification === null) {
      return { state: "not_started", actor: "issuer", offChain, link,
        explanation: "After verification, submit the issuance application; a person at Manci reviews it." };
    }
    return { state: "not_started", actor: "issuer", offChain, link, unknown: true,
      explanation: you ? "Your application status is not loaded; sign in with the wallet you applied with to see it." : "The application queue could not be read." };
  }
  if (app === null) {
    if (issuerVerified(input)) {
      return { state: "not_applicable", actor: "manci", offChain, link: null,
        explanation: you
          ? "No application is on record for this wallet, and the issuer is already verified, so this step does not apply."
          : "No application is linked to this issuer, and it is already verified, so this step does not apply." };
    }
    const canApply = input.verification?.kyb === "verified" || input.verification?.kyc === "verified";
    return canApply
      ? { state: "waiting_on_you", actor: "issuer", offChain, link, explanation: "Submit the issuance application: the company, the equity offered and the raise." }
      : { state: "not_started", actor: "issuer", offChain, link: you ? null : link,
          explanation: you ? "After verification, submit the issuance application; a person at Manci reviews it." : "The issuer has not submitted an application." };
  }
  switch (app.status) {
    case "approved":
      return { state: "done", actor: "manci", offChain, link, explanation: you ? "Manci approved your application." : "The application is approved." };
    case "pending":
      return { state: "waiting_on_manci", actor: "manci", offChain, link, explanation: you ? "Manci is reviewing your application." : "The application is waiting for review." };
    case "needs_changes":
      return { state: "waiting_on_you", actor: "issuer", offChain, link,
        explanation: you ? "Manci asked for changes; edit the application and resubmit it." : "Changes were requested; the issuer edits and resubmits the application." };
    case "rejected":
      return { state: "waiting_on_you", actor: "issuer", offChain, link,
        explanation: you ? "The application was not accepted; you can submit a new one." : "The application was rejected; the issuer may submit a new one." };
  }
}

function legalStructureStep(input: JourneyInput): Draft {
  const you = input.audience === "issuer";
  const offChain = true;
  const guide = you ? ([SERBIAN_SPV_GUIDE, "Serbian SPV guide"] as const) : null;
  const registry = ["/admin/spvs", "SPV registry"] as const;
  const spv = input.spv;
  if (spv) {
    const link = you ? guide : registry;
    switch (spv.status) {
      case "active":
        return { state: "done", actor: "manci", offChain, link,
          explanation: `Issued through ${spv.name}, a Serbian SPV that Manci incorporated and administers for the issuance.` };
      case "planned":
        return { state: "waiting_on_manci", actor: "manci", offChain, link, explanation: `Manci is preparing ${spv.name}, the Serbian SPV for this issuance.` };
      case "incorporating":
        return { state: "waiting_on_manci", actor: "manci", offChain, link,
          explanation: `${spv.name} is being incorporated; the notary certification and the Serbian business register (APR) filing happen off-chain.` };
      case "retired":
        return { state: "waiting_on_manci", actor: "manci", offChain, link,
          explanation: `${spv.name}, the SPV of this issuer, is retired; Manci decides how any new issuance is structured.` };
    }
  }
  const issuer = input.issuer;
  if (issuer?.jurisdiction === SERBIA_ISO_NUMERIC) {
    return { state: "done", actor: "issuer", offChain, link: you ? null : registry,
      // An SPV is a Serbian company too: without the registry read, say only what the chain says.
      explanation: spv === null ? "The issuer is a Serbian company, so it issues directly, without an SPV." : "The issuer is registered in Serbia." };
  }
  // The applicant asked for an SPV (an individual always does) and none is linked yet.
  const app = input.application;
  if (app && (app.companyFormationRequested || app.applicantKind === "individual")) {
    if (app.status === "approved") {
      return { state: "waiting_on_manci", actor: "manci", offChain, link: you ? guide : registry,
        explanation: "Manci incorporates a Serbian SPV for the issuance and administers it; the notary certification and the business register (APR) filing happen off-chain." };
    }
    return { state: "not_started", actor: "manci", offChain, link: you ? guide : registry,
      explanation: app.status === "rejected"
        ? "No SPV is being incorporated: the application was not accepted."
        : `${you ? "You asked" : "The applicant asked"} Manci to incorporate a Serbian SPV; that starts once the application is approved.` };
  }
  if (issuer) {
    if (spv === undefined) {
      return { state: "not_started", actor: "manci", offChain, link: you ? guide : registry, unknown: true,
        explanation: "The issuer is registered outside Serbia, and the SPV registry could not be read." };
    }
    return { state: "waiting_on_you", actor: "issuer", offChain, link: you ? guide : registry,
      explanation: you
        ? "Your issuer is registered outside Serbia; company ownership, debt and revenue share are issued through a Serbian company, so ask Manci about a Serbian SPV."
        : "The issuer is registered outside Serbia and no SPV is linked to it." };
  }
  if (app && (app.incorporation ?? "").trim() === SERBIA_INCORPORATION) {
    return { state: "done", actor: "issuer", offChain, link: null,
      explanation: you ? "Your company is incorporated in Serbia, so it issues directly, without an SPV." : "The applicant's company is incorporated in Serbia and issues directly." };
  }
  if (app) {
    return { state: "waiting_on_you", actor: "issuer", offChain, link: you ? guide : registry,
      explanation: you
        ? "Your company is incorporated outside Serbia; company ownership, debt and revenue share are issued through a Serbian company, so ask Manci to incorporate a Serbian SPV."
        : "The applicant's company is incorporated outside Serbia and no SPV was requested." };
  }
  return { state: "not_started", actor: "issuer", offChain, link: guide,
    explanation: "Company ownership, debt and revenue share are issued by a Serbian company: your own, or an SPV that Manci incorporates and administers for you." };
}

/** The on-chain KYB unlocks issuance (lib/issuer-status.ts: unknown and unsuccessful states never do). */
function issuerVerified(input: JourneyInput): boolean {
  return issuerStatus(input.issuer?.kybStatus).verified;
}

/** The application does not hold the issuance back (approved, or not part of this issuer's path). */
function applicationClear(input: JourneyInput): boolean {
  const app = input.application;
  return app === null ? issuerVerified(input) : app === undefined || app.status === "approved";
}

function documentsStep(input: KnownInput, ready: boolean): Draft {
  const you = input.audience === "issuer";
  const offChain = true;
  const recorded = input.assets.find((a) => a.legalDocHash !== null);
  if (recorded) {
    return { state: "done", actor: "issuer", offChain,
      link: you ? [`/issuer/assets/${recorded.address}`, "Asset documents"] : [`/admin/assets/${recorded.address}`, "Asset"],
      explanation: `${recorded.name} records the SHA-256 hash of its legal document (${shortHash(recorded.legalDocHash as string)}); the shareholders' decision and the documents themselves are kept off-chain.` };
  }
  const first = input.assets[0];
  if (first) {
    return { state: "waiting_on_manci", actor: "manci", offChain,
      link: you ? [`/issuer/assets/${first.address}`, "Open the asset"] : [`/admin/assets/${first.address}`, "Asset"],
      explanation: `No legal document hash is recorded on ${first.name}; the team has to review its documents before anything is issued.` };
  }
  if (ready) {
    return { state: "waiting_on_you", actor: "issuer", offChain,
      link: you ? ["/issuer/assets/tokenize", "Token setup"] : null,
      explanation: you
        ? "Your shareholders approve the issuance off-chain and the issuance documents are prepared; their hash is recorded on the asset when you create it."
        : "The issuer's shareholders approve the issuance off-chain; the documents' hash is recorded on the asset when it is created." };
  }
  return { state: "not_started", actor: "issuer", offChain, link: null,
    explanation: "Before the asset is created, the company's shareholders approve the issuance off-chain and the issuance documents are prepared." };
}

function onChainStep(input: KnownInput, ready: boolean): Draft {
  const you = input.audience === "issuer";
  const offChain = false;
  const assetLink = (a: JourneyAsset) =>
    you ? ([`/issuer/assets/${a.address}`, "Open the asset"] as const) : ([`/admin/assets/${a.address}`, "Asset"] as const);
  const withMint = (a: JourneyAsset) => a.classes.some((c) => c.mintInitialized);
  const active = input.assets.filter((a) => a.status === "active" && withMint(a));
  if (active.length > 0) {
    const a = active[0];
    const classes = a.classes.filter((c) => c.mintInitialized).length;
    return { state: "done", actor: "manci", offChain, link: assetLink(a),
      explanation: active.length > 1
        ? `${active.length} assets are active on-chain, each share class with its own token mint.`
        : classes === 1
          ? `${a.name} is active on-chain with its share class and token mint.`
          : `${a.name} is active on-chain with ${classes} share classes, each with its own token mint.` };
  }
  const frozen = input.assets.find((a) => a.status === "frozen");
  if (frozen) {
    return { state: "waiting_on_manci", actor: "manci", offChain, link: assetLink(frozen),
      explanation: `${frozen.name} is frozen; nothing is issued until Manci unfreezes it.` };
  }
  const minted = input.assets.find((a) => a.status === "draft" && withMint(a));
  if (minted) {
    return { state: "waiting_on_manci", actor: "manci", offChain, link: you ? assetLink(minted) : ["/admin/assets", "Assets"],
      explanation: `${minted.name} and its token mint are created; Manci reviews the asset and activates it.` };
  }
  const draft = input.assets.find((a) => a.status === "draft");
  if (draft) {
    return { state: "waiting_on_you", actor: "issuer", offChain, link: you ? ["/issuer/share-classes", "Share classes"] : assetLink(draft),
      explanation: you ? `${draft.name} is created; finish its share class and token mint.` : `${draft.name} is created without a token mint yet.` };
  }
  const woundDown = input.assets.find((a) => a.status === "wound_down");
  if (woundDown) {
    return { state: "done", actor: "manci", offChain, link: assetLink(woundDown), explanation: `${woundDown.name} was wound down.` };
  }
  // The same gate as the documents step: verified, approved, and the issuing company in place.
  if (ready) {
    return { state: "waiting_on_you", actor: "issuer", offChain, link: you ? ["/issuer/assets/tokenize", "Token setup"] : null,
      explanation: you
        ? "Create the asset and its share class in Token setup; each share class gets its own token mint."
        : "The issuer has not created the asset yet." };
  }
  return { state: "not_started", actor: "issuer", offChain, link: null,
    explanation: "Once the company is verified, the application approved and the legal structure in place, it creates the asset and its share classes on-chain, each class with its own token mint." };
}

function mintedStep(input: KnownInput, f: Facts, onChainDone: boolean): Draft {
  const you = input.audience === "issuer";
  const offChain = false;
  const firstActive = input.assets.find((a) => a.status === "active");
  const link = you
    ? firstActive ? ([`/issuer/assets/${firstActive.address}`, "Distribute"] as const) : null
    : (["/admin/share-classes", "Share classes"] as const);
  if (f.minted > ZERO) {
    if ((f.cap !== null && f.minted >= f.cap) || f.allLocked) {
      return { state: "done", actor: "issuer", offChain, link,
        explanation: f.allLocked && (f.cap === null || f.minted < f.cap)
          ? `${plural(f.minted, "unit is", "units are")} created and the supply is locked, so no more can be created.`
          : `All ${plural(f.minted, "unit", "units")} the share classes allow are created.` };
    }
    // During an open sale, buyers create units by buying.
    return { state: "in_progress", actor: f.openSales > 0 ? "holders" : "issuer", offChain, link,
      explanation: f.cap !== null
        ? `${formatUnits(f.minted)} of ${plural(f.cap, "unit", "units")} are created; the rest are created only when they are sent or sold.`
        : `${plural(f.minted, "unit is", "units are")} created; more are created only when they are sent or sold.` };
  }
  // Nothing created yet: minting follows the placement (a list sent, or a
  // sale's purchases), so this step never claims the turn; placement does.
  if (onChainDone && f.openSales > 0) {
    return { state: "not_started", actor: "holders", offChain, link,
      explanation: "No units exist yet; buyers create them as they purchase in the open sale." };
  }
  if (onChainDone) {
    return { state: "not_started", actor: "issuer", offChain, link,
      explanation: you
        ? "No units exist yet; they are created when you send them to named holders or when buyers purchase in an approved sale."
        : "No units exist yet; they are created when the issuer sends them to named holders or when buyers purchase in an approved sale." };
  }
  return { state: "not_started", actor: "issuer", offChain, link: null,
    explanation: "Units are created only when they are sent or sold, after the asset is active." };
}

function placementStep(input: KnownInput, f: Facts, onChainDone: boolean): Draft {
  const you = input.audience === "issuer";
  const offChain = false;
  const firstActive = input.assets.find((a) => a.status === "active");
  const sales = you ? (["/issuer/launchpad", "Primary sales"] as const) : (["/admin/launchpad", "Launchpad"] as const);
  // Direct issuance happens on the asset's Distribute panel; the admin finds its
  // "Send to wallets" transactions in the audit log.
  const distribute = you
    ? firstActive ? ([`/issuer/assets/${firstActive.address}`, "Distribute"] as const) : sales
    : (["/admin/audit", "Audit log"] as const);
  const direct = f.direct !== null && f.direct > ZERO ? f.direct : null;
  if (f.openSales > 0) {
    return { state: "in_progress", actor: "holders", offChain, link: sales,
      explanation: `A primary sale is open: ${plural(f.sold, "unit", "units")} sold so far${direct ? `, and ${plural(direct, "unit", "units")} sent to named holders` : ""}.` };
  }
  if ((f.liveApprovals ?? 0) > 0 || f.requestApproved) {
    return { state: "waiting_on_you", actor: "issuer", offChain, link: sales,
      explanation: you ? "Manci approved a primary sale; open it from Primary sales." : "A primary sale is approved; the issuer opens it." };
  }
  if (f.requestWaiting) {
    return { state: "waiting_on_manci", actor: "manci", offChain, link: sales,
      explanation: you ? "Your public-sale request is waiting for Manci's approval." : "A public-sale request is waiting for approval." };
  }
  if (f.holders) {
    const parts = [
      f.sold > ZERO ? `${formatUnits(f.sold)} sold in a primary sale` : null,
      direct ? `${formatUnits(direct)} sent directly to named holders` : null,
    ].filter((p): p is string => p !== null);
    const placed = f.placed ?? f.sold;
    return { state: "done", actor: "issuer", offChain, link: f.sold > ZERO ? sales : distribute,
      explanation: `${plural(placed, "unit has", "units have")} been placed with holders${parts.length > 0 ? `: ${parts.join(" and ")}` : ""}.` };
  }
  if (f.requestDeclined) {
    return { state: "waiting_on_you", actor: "issuer", offChain, link: you ? distribute : sales,
      explanation: you ? "Manci declined the public-sale request; see the reason and choose the next step." : "The public-sale request was declined." };
  }
  // Below, the answer would be "nothing placed": only when every read behind it is in.
  if (onChainDone && !f.placementKnown) {
    return { state: "not_started", actor: "issuer", offChain, link: you ? distribute : sales, unknown: true,
      explanation: "Part of the placement status (treasury, sale approvals or sale requests) is not loaded yet." };
  }
  if (onChainDone) {
    return { state: "waiting_on_you", actor: "issuer", offChain, link: you ? distribute : sales,
      explanation: you
        ? "Choose how units reach holders: send them to named holders, or request an approved primary sale."
        : "The issuer has not placed any units yet." };
  }
  return { state: "not_started", actor: "issuer", offChain, link: null,
    explanation: "Units reach holders through an approved primary sale or by direct issuance to named holders." };
}

function holdersStep(input: JourneyInput, f: Facts, env: JourneyEnvironment): Draft {
  const you = input.audience === "issuer";
  const offChain = true;
  const link = you ? (["/solutions/custody", "Conversion guide"] as const) : (["/admin/custody", "Custody"] as const);
  const conversionLine = env.conversionOffered
    ? "a holder who wants registered ownership requests conversion, which requires KYC"
    : "conversion into registered ownership is not offered on this network yet";
  if (!f.holdersKnown && f.minted > ZERO) {
    return { state: "not_started", actor: "holders", offChain, link: null, unknown: true,
      explanation: "Whether units are with holders is not loaded yet (the treasury balance could not be read)." };
  }
  if (!f.holders) {
    return { state: "not_started", actor: "holders", offChain, link: null,
      explanation: `Once units are with holders, they can hold and transfer them; ${conversionLine}.` };
  }
  if (f.minted > ZERO && f.circulating === ZERO) {
    return { state: "done", actor: "holders", offChain, link,
      explanation: `All ${plural(f.minted, "unit", "units")} created have been burned on-chain.` };
  }
  const held = f.placed !== null ? f.placed - f.burned : null;
  const heldText = held !== null && held > ZERO ? `${plural(held, "unit is", "units are")} with holders` : "Units are with holders";
  if (!you) {
    const known = f.classes.every((c) => c.conversions !== undefined);
    if (known) {
      const total = (key: "requested" | "vaultOpened" | "deposited" | "converted") =>
        f.classes.reduce((n, c) => n + (c.conversions?.[key] ?? 0), 0);
      const [requested, vaultOpened, deposited, converted] = [total("requested"), total("vaultOpened"), total("deposited"), total("converted")];
      if (requested > 0 || deposited > 0) {
        const parts = [
          requested > 0 ? `${plural(requested, "request waits", "requests wait")} for Manci to open the conversion escrow` : null,
          deposited > 0 ? `${plural(deposited, "deposit waits", "deposits wait")} for the notary and business register (APR) filing before Manci confirms ${deposited === 1 ? "it" : "them"} on-chain` : null,
        ].filter((p): p is string => p !== null);
        return { state: "waiting_on_manci", actor: "manci", offChain, link, explanation: `${parts.join("; ")}.` };
      }
      if (vaultOpened > 0) {
        return { state: "in_progress", actor: "holders", offChain, link,
          explanation: `${plural(vaultOpened, "holder can", "holders can")} now deposit units into the conversion escrow.` };
      }
      return { state: "in_progress", actor: "holders", offChain, link,
        explanation: `${heldText}; ${plural(converted, "conversion has", "conversions have")} been completed so far.` };
    }
  }
  const burnedText = f.burned > ZERO ? `; ${plural(f.burned, "unit has", "units have")} been burned on-chain (a completed conversion burns the escrowed units)` : "";
  return { state: "in_progress", actor: "holders", offChain, link,
    explanation: `${heldText}${burnedText}; ${conversionLine}.` };
}

// ── the journey ─────────────────────────────────────────────────────────────

const ORDER: readonly JourneyStepId[] = ["kyb", "application", "legal_structure", "documents", "on_chain", "minted", "placement", "holders"];

/** A chain-derived step whose data is not in: never "not started" as a fact, never "done". */
function unreadChainStep(audience: JourneyAudience, actor: JourneyActor, offChain: boolean): Draft {
  return { state: "not_started", actor, offChain, link: null, unknown: true,
    explanation: audience === "issuer"
      ? "The on-chain status is not loaded; connect your issuer wallet or refresh to see it."
      : "The on-chain status could not be read; refresh to update it." };
}

/** Every step of the engagement, with its state, actor, explanation and link. */
export function issuerJourney(input: JourneyInput, env: JourneyEnvironment = defaultJourneyEnvironment()): IssuerJourney {
  const drafts: Record<JourneyStepId, Draft> = {} as Record<JourneyStepId, Draft>;
  drafts.kyb = kybStep(input);
  drafts.application = applicationStep(input);
  drafts.legal_structure = legalStructureStep(input);
  // Steps 4–8 read the issuer's assets: without the chain snapshot they are not known.
  if (input.issuer === undefined || input.assets === undefined) {
    drafts.documents = unreadChainStep(input.audience, "issuer", true);
    drafts.on_chain = unreadChainStep(input.audience, "issuer", false);
    drafts.minted = unreadChainStep(input.audience, "issuer", false);
    drafts.placement = unreadChainStep(input.audience, "issuer", false);
    drafts.holders = unreadChainStep(input.audience, "holders", true);
  } else {
    const known: KnownInput = { ...input, assets: input.assets };
    const f = facts(known.assets);
    const legalDone = drafts.legal_structure.state === "done";
    // Asset creation needs a verified issuer, an approved application and the issuing company in place.
    const ready = issuerVerified(known) && applicationClear(known) && legalDone;
    drafts.documents = documentsStep(known, ready);
    drafts.on_chain = onChainStep(known, ready);
    const onChainDone = drafts.on_chain.state === "done";
    drafts.minted = mintedStep(known, f, onChainDone);
    drafts.placement = placementStep(known, f, onChainDone);
    drafts.holders = holdersStep(known, f, env);
  }
  const steps = ORDER.map((id, index): JourneyStep => {
    const { link, unknown, ...rest } = drafts[id];
    const visible = link && env.linkVisible(link[0]) ? link : null;
    return {
      id,
      number: index + 1,
      title: JOURNEY_STEP_TITLES[id],
      ...rest,
      href: visible ? visible[0] : null,
      linkLabel: visible ? visible[1] : null,
      unknown: unknown ?? false,
    };
  });
  const next =
    steps.find((s) => s.state === "waiting_on_you" || s.state === "waiting_on_manci") ??
    steps.find((s) => s.state === "in_progress") ??
    null;
  return { steps, next, paused: !env.issuanceOpen };
}
