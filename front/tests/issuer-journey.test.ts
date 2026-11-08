// The issuer journey (lib/issuer-journey.ts): eight steps derived from what
// the app already reads, each with a state, an actor, one sentence and a
// link, and the one step that tells the company who acts next. Off-chain
// work is explained and never marked done without evidence, unread data is
// never progress, the admin view links into the admin console, and KYC-only
// mode hides every entry action while the tracker still renders. The input
// mappers (lib/issuer-journey-input.ts), the panel
// (components/issuer-journey.tsx) and the page wiring are covered here too.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getAddressDecoder, none, some, type Address } from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  issuerJourney,
  JOURNEY_STEP_TITLES,
  SERBIA_ISO_NUMERIC,
  formatUnits,
  type IssuerJourney,
  type JourneyAsset,
  type JourneyClass,
  type JourneyEnvironment,
  type JourneyInput,
  type JourneyStepId,
} from "@/lib/issuer-journey";
import {
  conversionCounts,
  hashHexOrNull,
  journeyAssets,
  latestApplication,
  pickIssuerSpv,
  saleRequestOf,
} from "@/lib/issuer-journey-input";
import { IssuerJourneyTracker, journeyStateLabel } from "@/components/issuer-journey";
import { KYC_ONLY_ENV, PILOT_MODULE_ENV } from "@/lib/features";
import { AssetStatus, KybStatus, SaleStatus, type Asset, type Sale, type ShareClass } from "@/lib/generated/asset_registry";
import type { LaunchApplication } from "@/lib/launchpad";
import type { SaleRequestRow } from "@/lib/sale-requests";

const AUTHORITY = getAddressDecoder().decode(new Uint8Array(32).fill(21)).toString();
const HASH = "ab".repeat(32);
const OPEN: JourneyEnvironment = { linkVisible: () => true, issuanceOpen: true, conversionOffered: true };

beforeEach(() => vi.stubEnv(KYC_ONLY_ENV, "off"));
afterEach(() => vi.unstubAllEnvs());

function cls(overrides: Partial<JourneyClass> = {}): JourneyClass {
  return {
    mintInitialized: true, maxSupply: BigInt(10_000), lifetimeMinted: BigInt(0), circulatingSupply: BigInt(0), supplyLocked: false,
    treasury: BigInt(0), sold: BigInt(0), openSales: 0, liveApprovals: 0, saleRequest: null, ...overrides,
  };
}
function asset(overrides: Partial<JourneyAsset> = {}, classes: JourneyClass[] = [cls()]): JourneyAsset {
  return { address: "Asset1", name: "ACME-2027", status: "active", legalDocHash: HASH, classes, ...overrides };
}
const verified = { kyc: "none", kyb: "verified", documentsRequested: 0 } as const;
const issuerVerified = { kybStatus: KybStatus.Verified, jurisdiction: SERBIA_ISO_NUMERIC, authority: AUTHORITY };
const approvedSerbian = { status: "approved", applicantKind: "company", incorporation: "Serbia", companyFormationRequested: false } as const;

function input(overrides: Partial<JourneyInput> = {}): JourneyInput {
  return { audience: "issuer", verification: verified, issuer: issuerVerified, application: approvedSerbian, spv: null, assets: [], ...overrides };
}
function journey(overrides: Partial<JourneyInput> = {}, env: JourneyEnvironment = OPEN): IssuerJourney {
  return issuerJourney(input(overrides), env);
}
function step(j: IssuerJourney, id: JourneyStepId) {
  const found = j.steps.find((s) => s.id === id);
  if (!found) throw new Error(`no step ${id}`);
  return found;
}
const states = (j: IssuerJourney) => Object.fromEntries(j.steps.map((s) => [s.id, s.state]));

describe("the eight steps", () => {
  it("are always the same eight, in engagement order, numbered 1–8, with a one-sentence explanation", () => {
    for (const j of [journey(), journey({ verification: null, issuer: null, application: null }), journey({ audience: "admin" })]) {
      expect(j.steps.map((s) => s.id)).toEqual(["kyb", "application", "legal_structure", "documents", "on_chain", "minted", "placement", "holders"]);
      expect(j.steps.map((s) => s.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      for (const s of j.steps) {
        expect(s.title).toBe(JOURNEY_STEP_TITLES[s.id]);
        expect(s.explanation, s.id).toMatch(/^[A-Z0-9].*\.$/);
        expect(s.explanation, s.id).not.toMatch(/\.\s+[A-Z]/);
      }
    }
  });
});

describe("issuer audience: from a first visit to holders", () => {
  it("signed out: start with verification, nothing else has started", () => {
    const j = journey({ verification: null, issuer: null, application: undefined, spv: null });
    expect(step(j, "kyb")).toMatchObject({ state: "waiting_on_you", actor: "issuer", href: "/issuer/verification", offChain: true });
    expect(j.next?.id).toBe("kyb");
    for (const id of ["documents", "on_chain", "minted", "placement", "holders"] as const) expect(step(j, id).state).toBe("not_started");
    // Signed out there is nothing to load: the application has simply not started.
    expect(step(j, "application")).toMatchObject({ state: "not_started", unknown: false });
  });

  it("signed in but the application unread: not loaded, never 'none'", () => {
    const j = journey({ issuer: null, application: undefined });
    expect(step(j, "application")).toMatchObject({ state: "not_started", unknown: true });
    expect(step(j, "application").explanation).toContain("sign in with the wallet you applied with");
    // A verification still loading is not loaded either.
    expect(step(journey({ verification: undefined, issuer: null, application: undefined }), "kyb")).toMatchObject({ unknown: true, state: "not_started" });
  });

  it("documents under review, then more requested", () => {
    const pending = journey({ verification: { kyc: "none", kyb: "pending", documentsRequested: 0 }, issuer: null, application: null });
    expect(step(pending, "kyb")).toMatchObject({ state: "waiting_on_manci", actor: "manci" });
    expect(pending.next?.id).toBe("kyb");
    const more = journey({ verification: { kyc: "none", kyb: "more_info", documentsRequested: 2 }, issuer: null, application: null });
    expect(step(more, "kyb")).toMatchObject({ state: "waiting_on_you", href: "/issuer/verification?type=kyb" });
    // A decision beats an open document request.
    const rejected = journey({ verification: { kyc: "none", kyb: "rejected", documentsRequested: 1 }, issuer: null, application: null });
    expect(step(rejected, "kyb")).toMatchObject({ state: "waiting_on_you", explanation: "Company verification is not approved; contact the compliance team." });
  });

  it("an issuer that is not known (snapshot failed, no wallet, foreign wallet) never reads as 'no issuer'", () => {
    const j = journey({ issuer: undefined, spv: undefined, assets: undefined });
    // KYB approved, but the next step depends on the chain: no onboarding prompt.
    expect(step(j, "kyb")).toMatchObject({ state: "not_started", unknown: true, href: "/issuer/status" });
    for (const id of ["documents", "on_chain", "minted", "placement", "holders"] as const) {
      expect(step(j, id), id).toMatchObject({ state: "not_started", unknown: true, href: null });
    }
    expect(step(j, "documents").explanation).toBe("The on-chain status is not loaded; connect your issuer wallet or refresh to see it.");
    // Account-level facts still show: the application is approved.
    expect(step(j, "application").state).toBe("done");
    // Assets not read for a known issuer: the same.
    expect(step(journey({ assets: undefined }), "on_chain")).toMatchObject({ unknown: true });
    expect(step(journey({ audience: "admin", verification: null, assets: undefined }), "placement").explanation).toBe(
      "The on-chain status could not be read; refresh to update it.",
    );
  });

  it("approved documents with the application unread: no guess about onboarding", () => {
    const j = journey({ issuer: null, application: undefined });
    expect(step(j, "kyb")).toMatchObject({ state: "not_started", unknown: true, href: "/issuer/status" });
  });

  it("an unknown on-chain status never counts as verified", () => {
    const j = journey({ issuer: { ...issuerVerified, kybStatus: 9 } });
    expect(step(j, "kyb")).toMatchObject({ state: "not_started", unknown: true });
    expect(step(j, "on_chain").state).toBe("not_started");
    expect(step(j, "application").state).toBe("done");
  });

  it("documents approved, no issuer yet: apply first, then register the issuer wallet", () => {
    const j = journey({ issuer: null, application: null });
    expect(step(j, "kyb")).toMatchObject({ state: "in_progress", href: "/issuer/onboarding" });
    expect(step(j, "application")).toMatchObject({ state: "waiting_on_you", href: "/apply" });
    expect(j.next?.id).toBe("application");
    expect(step(j, "legal_structure").state).toBe("not_started");
    expect(step(j, "legal_structure").href).toBe("/solutions/serbian-spv");
    // Approved, a Serbian company registers its own issuer wallet.
    const approved = journey({ issuer: null });
    expect(step(approved, "kyb")).toMatchObject({ state: "waiting_on_you", href: "/issuer/onboarding" });
    expect(approved.next?.id).toBe("kyb");
  });

  it("through an SPV the issuer is the SPV: the applicant is never told to register its own company", () => {
    const asked = { status: "approved", applicantKind: "company", incorporation: "BVI", companyFormationRequested: true } as const;
    const approved = journey({ issuer: null, application: asked });
    expect(step(approved, "kyb")).toMatchObject({ state: "waiting_on_manci", actor: "manci", href: "/issuer/status" });
    expect(step(approved, "kyb").explanation).toContain("the SPV Manci incorporates is registered and verified as the issuer");
    const pending = journey({ issuer: null, application: { ...asked, status: "pending" } });
    expect(step(pending, "kyb")).toMatchObject({ state: "in_progress", href: "/issuer/status" });
    expect(pending.next?.id).toBe("application");
  });

  it("a company outside Serbia that asked for an SPV: Manci reviews, then incorporates off-chain", () => {
    const asked = { status: "pending", applicantKind: "company", incorporation: "BVI", companyFormationRequested: true } as const;
    const pending = journey({ issuer: null, application: asked });
    expect(step(pending, "application")).toMatchObject({ state: "waiting_on_manci", actor: "manci" });
    expect(step(pending, "legal_structure")).toMatchObject({ state: "not_started" });
    expect(step(pending, "legal_structure").explanation).toBe("You asked Manci to incorporate a Serbian SPV; that starts once the application is approved.");
    const approved = journey({ issuer: null, application: { ...asked, status: "approved" } });
    expect(step(approved, "application").state).toBe("done");
    expect(step(approved, "legal_structure")).toMatchObject({ state: "waiting_on_manci", actor: "manci", offChain: true });
    expect(step(approved, "legal_structure").explanation).toContain("notary certification and the business register (APR) filing happen off-chain");
  });

  it("a company outside Serbia that did not ask: its turn, with the SPV guide", () => {
    const j = journey({ issuer: null, application: { status: "approved", applicantKind: "company", incorporation: "US (Delaware)", companyFormationRequested: false } });
    expect(step(j, "legal_structure")).toMatchObject({ state: "waiting_on_you", href: "/solutions/serbian-spv" });
  });

  it("an individual founder (KYC): the company is verified once the SPV Manci incorporates is registered", () => {
    const j = journey({
      verification: { kyc: "verified", kyb: "none", documentsRequested: 0 }, issuer: null,
      application: { status: "approved", applicantKind: "individual", incorporation: "Not yet", companyFormationRequested: true },
    });
    expect(step(j, "kyb")).toMatchObject({ state: "waiting_on_manci", actor: "manci" });
    expect(step(j, "legal_structure").state).toBe("waiting_on_manci");
    // Before applying, a verified individual may apply or verify a company.
    const before = journey({ verification: { kyc: "verified", kyb: "none", documentsRequested: 0 }, issuer: null, application: null });
    expect(step(before, "kyb").state).toBe("in_progress");
    expect(step(before, "application").state).toBe("waiting_on_you");
    expect(before.next?.id).toBe("application");
  });

  it("a registered issuer pending on-chain with approved documents: Manci records the decision", () => {
    const j = journey({ issuer: { ...issuerVerified, kybStatus: KybStatus.Pending } });
    expect(step(j, "kyb")).toMatchObject({ state: "waiting_on_manci", href: "/issuer/status" });
    // Asset creation needs a verified issuer on-chain.
    expect(step(j, "on_chain").state).toBe("not_started");
  });

  it("verified Serbian issuer with no asset: the shareholders' decision and Token setup are the company's turn", () => {
    const j = journey();
    expect(states(j)).toMatchObject({ kyb: "done", application: "done", legal_structure: "done", documents: "waiting_on_you", on_chain: "waiting_on_you" });
    expect(step(j, "documents")).toMatchObject({ offChain: true, href: "/issuer/assets/tokenize" });
    expect(step(j, "documents").explanation).toContain("approve the issuance off-chain");
    expect(step(j, "on_chain").href).toBe("/issuer/assets/tokenize");
    expect(j.next?.id).toBe("documents");
  });

  it("an asset and its mint in Draft: the hash is recorded, Manci activates", () => {
    const j = journey({ assets: [asset({ status: "draft" })] });
    expect(step(j, "documents")).toMatchObject({ state: "done", href: "/issuer/assets/Asset1" });
    expect(step(j, "documents").explanation).toBe(
      "ACME-2027 records the SHA-256 hash of its legal document (abababab…abababab); the shareholders' decision and the documents themselves are kept off-chain.",
    );
    expect(step(j, "on_chain")).toMatchObject({ state: "waiting_on_manci", actor: "manci" });
    expect(step(j, "minted").state).toBe("not_started");
    expect(j.next?.id).toBe("on_chain");
  });

  it("a draft asset without its mint is the company's to finish; a frozen asset waits on Manci", () => {
    expect(step(journey({ assets: [asset({ status: "draft" }, [cls({ mintInitialized: false, treasury: null })])] }), "on_chain"))
      .toMatchObject({ state: "waiting_on_you", href: "/issuer/share-classes" });
    expect(step(journey({ assets: [asset({ status: "frozen" })] }), "on_chain").state).toBe("waiting_on_manci");
  });

  it("an asset without a document hash: Manci corrects the record (never 'done')", () => {
    expect(step(journey({ assets: [asset({ legalDocHash: null })] }), "documents")).toMatchObject({ state: "waiting_on_manci", actor: "manci" });
  });

  it("active, nothing minted: choose how units reach holders (placement has the turn, minting follows it)", () => {
    const j = journey({ assets: [asset()] });
    expect(states(j)).toMatchObject({ on_chain: "done", minted: "not_started", placement: "waiting_on_you", holders: "not_started" });
    expect(j.next?.id).toBe("placement");
    expect(step(j, "minted").href).toBe("/issuer/assets/Asset1");
    expect(step(j, "placement").explanation).toBe("Choose how units reach holders: send them to named holders, or request an approved primary sale.");
    expect(step(j, "holders").explanation).toContain("requires KYC");
  });

  it("nothing minted while a sale is open, requested or approved: placement drives the next step", () => {
    const open = journey({ assets: [asset({}, [cls({ openSales: 1 })])] });
    expect(step(open, "minted")).toMatchObject({ state: "not_started", actor: "holders" });
    expect(open.next).toMatchObject({ id: "placement", state: "in_progress" });
    const requested = journey({ assets: [asset({}, [cls({ saleRequest: { status: "requested", outcome: null } })])] });
    expect(requested.next).toMatchObject({ id: "placement", state: "waiting_on_manci" });
    const approved = journey({ assets: [asset({}, [cls({ liveApprovals: 1 })])] });
    expect(approved.next).toMatchObject({ id: "placement", state: "waiting_on_you" });
  });

  it("a public-sale request waits on Manci; an approval waits on the company", () => {
    const requested = journey({ assets: [asset({}, [cls({ saleRequest: { status: "requested", outcome: null } })])] });
    expect(step(requested, "placement")).toMatchObject({ state: "waiting_on_manci", href: "/issuer/launchpad" });
    const approved = journey({ assets: [asset({}, [cls({ liveApprovals: 1 })])] });
    expect(step(approved, "placement")).toMatchObject({ state: "waiting_on_you", explanation: "Manci approved a primary sale; open it from Primary sales." });
    const viaLedger = journey({ assets: [asset({}, [cls({ saleRequest: { status: "requested", outcome: "approved" } })])] });
    expect(step(viaLedger, "placement").state).toBe("waiting_on_you");
    const declined = journey({ assets: [asset({}, [cls({ saleRequest: { status: "declined", outcome: null } })])] });
    expect(step(declined, "placement").state).toBe("waiting_on_you");
  });

  it("an open sale: units being created and placed, holders arriving", () => {
    const j = journey({ assets: [asset({}, [cls({ openSales: 1, sold: BigInt(1_500), lifetimeMinted: BigInt(1_500), circulatingSupply: BigInt(1_500) })])] });
    // Buyers create units by buying while the sale is open.
    expect(step(j, "minted")).toMatchObject({ state: "in_progress", actor: "holders", explanation: "1,500 of 10,000 units are created; the rest are created only when they are sent or sold." });
    expect(step(j, "on_chain").explanation).toBe("ACME-2027 is active on-chain with its share class and token mint.");
    expect(step(j, "placement")).toMatchObject({ state: "in_progress", actor: "holders", explanation: "A primary sale is open: 1,500 units sold so far." });
    expect(step(j, "holders").state).toBe("in_progress");
  });

  it("direct issuance to named holders is counted from what left the treasury", () => {
    const j = journey({ assets: [asset({}, [cls({ lifetimeMinted: BigInt(400), circulatingSupply: BigInt(400), treasury: BigInt(100) })])] });
    expect(step(j, "placement")).toMatchObject({
      state: "done", explanation: "300 units have been placed with holders: 300 sent directly to named holders.", href: "/issuer/assets/Asset1",
    });
    const both = journey({ assets: [asset({}, [cls({ lifetimeMinted: BigInt(1_000), circulatingSupply: BigInt(1_000), treasury: BigInt(0), sold: BigInt(600) })])] });
    expect(step(both, "placement").explanation).toBe("1,000 units have been placed with holders: 600 sold in a primary sale and 400 sent directly to named holders.");
  });

  it("all units created, or the supply locked: minting is done", () => {
    expect(step(journey({ assets: [asset({}, [cls({ lifetimeMinted: BigInt(10_000), circulatingSupply: BigInt(10_000) })])] }), "minted"))
      .toMatchObject({ state: "done", explanation: "All 10,000 units the share classes allow are created." });
    expect(step(journey({ assets: [asset({}, [cls({ lifetimeMinted: BigInt(5), circulatingSupply: BigInt(5), supplyLocked: true })])] }), "minted").explanation)
      .toBe("5 units are created and the supply is locked, so no more can be created.");
  });

  it("holders and conversions from the chain: burned units are named, never called registered", () => {
    const j = journey({ assets: [asset({}, [cls({ lifetimeMinted: BigInt(10_000), circulatingSupply: BigInt(9_750), treasury: BigInt(0) })])] });
    expect(step(j, "holders")).toMatchObject({ state: "in_progress", actor: "holders", offChain: true });
    expect(step(j, "holders").explanation).toBe(
      "9,750 units are with holders; 250 units have been burned on-chain (a completed conversion burns the escrowed units); a holder who wants registered ownership requests conversion, which requires KYC.",
    );
    const off = issuerJourney(input({ assets: [asset({}, [cls({ lifetimeMinted: BigInt(10), circulatingSupply: BigInt(10), treasury: BigInt(0) })])] }), { ...OPEN, conversionOffered: false });
    expect(step(off, "holders").explanation).toContain("conversion into registered ownership is not offered on this network yet");
    const allBurned = journey({ assets: [asset({}, [cls({ lifetimeMinted: BigInt(10), circulatingSupply: BigInt(0), treasury: BigInt(0) })])] });
    expect(step(allBurned, "holders").state).toBe("done");
  });

  it("a rejected or suspended issuer: the company has to contact the team", () => {
    for (const kybStatus of [KybStatus.Rejected, KybStatus.Suspended]) {
      const j = journey({ issuer: { ...issuerVerified, kybStatus } });
      expect(step(j, "kyb")).toMatchObject({ state: "waiting_on_you", actor: "issuer" });
      expect(step(j, "on_chain").state).toBe("not_started");
    }
  });

  it("no application on record for an already verified issuer: the step does not apply", () => {
    const j = journey({ application: null });
    expect(step(j, "application")).toMatchObject({ state: "not_applicable", href: null });
    expect(step(j, "on_chain").state).toBe("waiting_on_you");
  });
});

describe("the legal structure", () => {
  it("follows the SPV linked to the issuer", () => {
    const expected = { active: "done", planned: "waiting_on_manci", incorporating: "waiting_on_manci", retired: "waiting_on_manci" } as const;
    for (const status of ["active", "planned", "incorporating", "retired"] as const) {
      const j = journey({ spv: { name: "ACME SPV d.o.o.", status } });
      expect(step(j, "legal_structure").state, status).toBe(expected[status]);
      expect(step(j, "legal_structure").explanation).toContain("ACME SPV d.o.o.");
    }
    expect(step(journey({ spv: { name: "ACME SPV d.o.o.", status: "incorporating" } }), "legal_structure").explanation)
      .toContain("the notary certification and the Serbian business register (APR) filing happen off-chain");
  });

  it("an issuer registered outside Serbia without an SPV: the company's turn; an unread registry is unknown", () => {
    const foreign = { ...issuerVerified, jurisdiction: 840 };
    expect(step(journey({ issuer: foreign, application: null }), "legal_structure")).toMatchObject({ state: "waiting_on_you", href: "/solutions/serbian-spv" });
    expect(step(journey({ issuer: foreign, application: null, spv: undefined }), "legal_structure")).toMatchObject({ state: "not_started", unknown: true });
    // A foreign issuer that asked for an SPV: Manci's turn, not "ask again".
    const asked = { status: "approved", applicantKind: "company", incorporation: "BVI", companyFormationRequested: true } as const;
    const waiting = journey({ issuer: foreign, application: asked });
    expect(step(waiting, "legal_structure").state).toBe("waiting_on_manci");
    // Nor is the asset its turn while the issuing company is not in place.
    expect(step(waiting, "on_chain").state).toBe("not_started");
    expect(step(waiting, "documents").state).toBe("not_started");
  });

  it("a Serbian issuer issues directly; without the registry read only the jurisdiction is claimed", () => {
    expect(step(journey(), "legal_structure").explanation).toBe("The issuer is a Serbian company, so it issues directly, without an SPV.");
    expect(step(journey({ spv: undefined }), "legal_structure")).toMatchObject({ state: "done", explanation: "The issuer is registered in Serbia." });
  });
});

describe("admin audience", () => {
  const admin = (overrides: Partial<JourneyInput> = {}) => journey({ audience: "admin", verification: null, ...overrides });

  it("links every step into the admin console", () => {
    const j = admin({ assets: [asset()] });
    expect(step(j, "kyb").href).toBe(`/admin/clients?q=${AUTHORITY}`);
    expect(step(j, "application").href).toBe("/admin/applications");
    expect(step(j, "legal_structure").href).toBe("/admin/spvs");
    expect(step(j, "documents").href).toBe("/admin/assets/Asset1");
    expect(step(j, "minted").href).toBe("/admin/share-classes");
    expect(step(j, "placement").href).toBe("/admin/launchpad");
    expect(step(j, "holders").href).toBe(null); // no holders yet
    for (const s of j.steps) if (s.href) expect(s.href.startsWith("/admin/"), s.id).toBe(true);
    // Units sent directly: the evidence is the "Send to wallets" rows of the audit log.
    const direct = admin({ assets: [asset({}, [cls({ lifetimeMinted: BigInt(50), circulatingSupply: BigInt(50), treasury: BigInt(0) })])] });
    expect(step(direct, "placement")).toMatchObject({ state: "done", href: "/admin/audit" });
    const sold = admin({ assets: [asset({}, [cls({ lifetimeMinted: BigInt(50), circulatingSupply: BigInt(50), treasury: BigInt(0), sold: BigInt(50) })])] });
    expect(step(sold, "placement").href).toBe("/admin/launchpad");
  });

  it("a suspended issuer is compliance's to restore", () => {
    expect(step(admin({ issuer: { ...issuerVerified, kybStatus: KybStatus.Suspended } }), "kyb")).toMatchObject({
      state: "waiting_on_manci", actor: "manci", explanation: "Issuer access is suspended on-chain until compliance restores it.",
    });
  });

  it("a pending KYB is Manci's to decide, from the dossier", () => {
    const j = admin({ issuer: { ...issuerVerified, kybStatus: KybStatus.Pending }, application: null });
    expect(step(j, "kyb")).toMatchObject({ state: "waiting_on_manci", explanation: "KYB review is pending: check the dossier, then record the decision on-chain." });
    expect(step(j, "application")).toMatchObject({ state: "not_started", href: "/admin/applications" });
  });

  it("conversion requests by stage: Manci opens the escrow, the notary and APR filing come before the confirmation", () => {
    const held = cls({ lifetimeMinted: BigInt(10_000), circulatingSupply: BigInt(10_000), treasury: BigInt(0) });
    const waiting = admin({ assets: [asset({}, [{ ...held, conversions: { requested: 1, vaultOpened: 0, deposited: 2, converted: 1 } }])] });
    expect(step(waiting, "holders")).toMatchObject({ state: "waiting_on_manci", actor: "manci", href: "/admin/custody" });
    expect(step(waiting, "holders").explanation).toBe(
      "1 request waits for Manci to open the conversion escrow; 2 deposits wait for the notary and business register (APR) filing before Manci confirms them on-chain.",
    );
    const depositing = admin({ assets: [asset({}, [{ ...held, conversions: { requested: 0, vaultOpened: 1, deposited: 0, converted: 0 } }])] });
    expect(step(depositing, "holders")).toMatchObject({ state: "in_progress", actor: "holders" });
    const quiet = admin({ assets: [asset({}, [{ ...held, conversions: { requested: 0, vaultOpened: 0, deposited: 0, converted: 3 } }])] });
    expect(step(quiet, "holders").explanation).toBe("10,000 units are with holders; 3 conversions have been completed so far.");
  });

  it("no application linked to a verified issuer: not applicable, said in the admin's words", () => {
    expect(step(admin({ application: null }), "application").explanation).toBe(
      "No application is linked to this issuer, and it is already verified, so this step does not apply.",
    );
  });
});

describe("who acts next", () => {
  it("is the first step waiting on someone, else the first in progress, else nobody", () => {
    expect(journey({ assets: [asset({ status: "draft" })] }).next?.id).toBe("on_chain");
    const selling = journey({ assets: [asset({}, [cls({ openSales: 1, sold: BigInt(5), lifetimeMinted: BigInt(5), circulatingSupply: BigInt(5) })])] });
    expect(selling.next?.id).toBe("minted");
    expect(selling.next?.state).toBe("in_progress");
  });
});

describe("KYC-only mode: read-only, every entry action hidden", () => {
  it("hides /apply, onboarding, Token setup and sales; keeps the review status", () => {
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "mainnet");
    vi.stubEnv(KYC_ONLY_ENV, "");
    for (const v of Object.values(PILOT_MODULE_ENV)) vi.stubEnv(v, "");
    const noIssuer = issuerJourney(input({ issuer: null, application: null }));
    expect(noIssuer.paused).toBe(true);
    expect(step(noIssuer, "kyb").href).toBeNull(); // /issuer/onboarding is an issuance entry
    expect(step(noIssuer, "application").href).toBeNull(); // /apply
    expect(noIssuer.steps.length).toBe(8);
    const pending = issuerJourney(input({ issuer: { ...issuerVerified, kybStatus: KybStatus.Pending } }));
    expect(step(pending, "kyb").href).toBe("/issuer/status");
    const active = issuerJourney(input({ assets: [asset()] }));
    for (const s of active.steps) {
      if (!s.href) continue;
      for (const entry of ["/apply", "/issuer/onboarding", "/issuer/assets", "/issuer/launchpad", "/issuer/share-classes", "/solutions/serbian-spv", "/solutions/custody"]) {
        expect(s.href.startsWith(entry), `${s.id} → ${s.href}`).toBe(false);
      }
    }
    // The states are still there: read-only, not blank.
    expect(step(active, "placement").state).toBe("waiting_on_you");
  });

  it("with the mode off, the same steps link to their pages", () => {
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "mainnet");
    vi.stubEnv(KYC_ONLY_ENV, "off");
    const j = issuerJourney(input({ issuer: null, application: null }));
    expect(j.paused).toBe(false);
    expect(step(j, "kyb").href).toBe("/issuer/onboarding");
    expect(step(j, "application").href).toBe("/apply");
  });
});

describe("input mappers (lib/issuer-journey-input.ts)", () => {
  it("a zero hash records nothing", () => {
    expect(hashHexOrNull(new Uint8Array(32))).toBeNull();
    expect(hashHexOrNull(new Uint8Array(32).fill(0xab))).toBe(HASH);
  });

  it("the latest application, matched to the issuer for the admin", () => {
    const row = (id: string, created: string, extra: Partial<LaunchApplication> = {}) =>
      ({ id, created_at: created, status: "pending", applicant_wallet: "W", applicant_kind: "company", incorporation: "BVI", company_formation_requested: true, linked_issuer: null, ...extra }) as LaunchApplication;
    const rows = [row("old", "2026-01-01T00:00:00Z", { status: "rejected" }), row("new", "2026-06-01T00:00:00Z")];
    expect(latestApplication(rows)).toEqual({ status: "pending", applicantKind: "company", incorporation: "BVI", companyFormationRequested: true });
    expect(latestApplication([])).toBeNull();
    const other = row("other", "2026-09-01T00:00:00Z", { applicant_wallet: "X", status: "approved" });
    const linked = row("linked", "2026-03-01T00:00:00Z", { applicant_wallet: "Y", linked_issuer: "IssuerPda", status: "approved" });
    expect(latestApplication([...rows, other], { issuerPda: "IssuerPda", authority: "W" })?.status).toBe("pending");
    expect(latestApplication([other, linked], { issuerPda: "IssuerPda", authority: "W" })?.status).toBe("approved");
    expect(latestApplication([other], { issuerPda: "IssuerPda", authority: "W" })).toBeNull();
  });

  it("the most advanced SPV speaks for the issuer", () => {
    expect(pickIssuerSpv([{ name: "Old", status: "retired" }, { name: "New", status: "incorporating" }])).toEqual({ name: "New", status: "incorporating" });
    expect(pickIssuerSpv([{ name: "Only", status: "retired" }])).toEqual({ name: "Only", status: "retired" });
    expect(pickIssuerSpv([])).toBeNull();
  });

  it("a class's sale request: unread stays unread", () => {
    expect(saleRequestOf(undefined)).toBeUndefined();
    expect(saleRequestOf([])).toBeNull();
    expect(saleRequestOf([{ asset: "A", display_name: null, request: null, outcome: null }])).toBeNull();
    const request = { status: "requested" } as SaleRequestRow["request"];
    expect(saleRequestOf([{ asset: "A", display_name: null, request, outcome: "approved" }])).toEqual({ status: "requested", outcome: "approved" });
  });

  it("conversion requests by stage, for one class", () => {
    const rows = [
      { share_class_pda: "C1", status: "requested" }, { share_class_pda: "C1", status: "vault_opened" },
      { share_class_pda: "C1", status: "deposited" }, { share_class_pda: "C1", status: "converted" },
      { share_class_pda: "C1", status: "cancelled" }, { share_class_pda: "C2", status: "requested" },
    ] as const;
    expect(conversionCounts(rows, "C1")).toEqual({ requested: 1, vaultOpened: 1, deposited: 1, converted: 1 });
  });

  it("assets and classes from the chain, with treasury, approvals, requests and sales per class", () => {
    const a = (address: string) => address as Address;
    const chainAsset = { name: "ACME-2027", status: AssetStatus.Draft, legalDocHash: new Uint8Array(32).fill(1) } as unknown as Asset;
    const sc = (mintInitialized: boolean, lifetime: number) => ({
      asset: a("Asset1"), mintInitialized, maxSupply: some(BigInt(1_000)), lifetimeMinted: BigInt(lifetime), circulatingSupply: BigInt(lifetime), supplyLocked: false,
    }) as unknown as ShareClass;
    const sale = (shareClass: string, sold: number, status: SaleStatus) => ({ shareClass: a(shareClass), sold: BigInt(sold), status }) as unknown as Sale;
    const out = journeyAssets({
      assets: [{ address: "Asset1", asset: chainAsset }],
      classes: [
        { address: "C1", shareClass: sc(true, 300) },
        { address: "C2", shareClass: sc(false, 0) },
        { address: "C3", shareClass: { ...sc(true, 0), maxSupply: none() } as ShareClass },
      ],
      sales: [sale("C1", 100, SaleStatus.Closed), sale("C1", 50, SaleStatus.Open), sale("Other", 999, SaleStatus.Open)],
      treasury: new Map([["C1", BigInt(20)]]),
      liveApprovals: new Map([["C1", 2]]),
      saleRequests: new Map([["C1", { status: "requested", outcome: null }], ["C3", undefined]]),
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ address: "Asset1", name: "ACME-2027", status: "draft", legalDocHash: "01".repeat(32) });
    const [c1, c2, c3] = out[0].classes;
    expect(c1).toMatchObject({ treasury: BigInt(20), sold: BigInt(150), openSales: 1, liveApprovals: 2, saleRequest: { status: "requested", outcome: null }, maxSupply: BigInt(1_000) });
    // No mint: no treasury account, exactly 0; a mint whose balance was not read: unknown.
    expect(c2.treasury).toBe(BigInt(0));
    expect(c3.treasury).toBeNull();
    expect(c3.maxSupply).toBeNull();
    expect(c3.saleRequest).toBeUndefined();
    expect(c1.conversions).toBeUndefined();
    const unread = journeyAssets({ assets: [{ address: "Asset1", asset: chainAsset }], classes: [{ address: "C1", shareClass: sc(true, 0) }], sales: [], treasury: new Map(), liveApprovals: null });
    expect(unread[0].classes[0].liveApprovals).toBeNull();
  });

  it("an unread treasury is never read as units placed, nor as nothing placed", () => {
    const j = journey({ assets: [asset({}, [cls({ lifetimeMinted: BigInt(100), circulatingSupply: BigInt(100), treasury: null })])] });
    // 100 units exist, but whether they left the treasury is unknown.
    expect(step(j, "placement")).toMatchObject({ state: "not_started", unknown: true });
    expect(step(j, "holders")).toMatchObject({ state: "not_started", unknown: true });
    // Units sold are a fact the chain shows even without the treasury.
    const sold = journey({ assets: [asset({}, [cls({ lifetimeMinted: BigInt(100), circulatingSupply: BigInt(100), treasury: null, sold: BigInt(40) })])] });
    expect(step(sold, "placement")).toMatchObject({ state: "done", unknown: false, explanation: "40 units have been placed with holders: 40 sold in a primary sale." });
    expect(formatUnits(BigInt(1234567))).toBe("1,234,567");
  });

  it("unread approvals or sale requests never become 'choose how units reach holders'", () => {
    expect(step(journey({ assets: [asset({}, [cls({ liveApprovals: null })])] }), "placement")).toMatchObject({ state: "not_started", unknown: true });
    expect(step(journey({ assets: [asset({}, [cls({ saleRequest: undefined })])] }), "placement")).toMatchObject({ state: "not_started", unknown: true });
    // A positive signal is still a fact: an open sale shows even with other reads missing.
    expect(step(journey({ assets: [asset({}, [cls({ openSales: 1, saleRequest: undefined, liveApprovals: null })])] }), "placement").state).toBe("in_progress");
  });
});

describe("the panel (components/issuer-journey.tsx)", () => {
  const render = (j: IssuerJourney, audience: "issuer" | "admin", extra: Record<string, unknown> = {}) =>
    renderToStaticMarkup(createElement(IssuerJourneyTracker, { journey: j, audience, ...extra }));

  it("shows every step with its state, who acts, the off-chain tag and the next step", () => {
    const j = journey({ assets: [asset({ status: "draft" })] });
    const html = render(j, "issuer", { companyName: "ACME d.o.o." });
    for (const title of Object.values(JOURNEY_STEP_TITLES)) expect(html).toContain(title.replace(/'/g, "&#x27;"));
    expect(html).toContain("ACME d.o.o.: from verification to holders");
    expect(html).toContain("Next: Manci · Asset and share classes on-chain");
    // The next step's page is offered from the banner too.
    expect(html).toMatch(/data-journey-next="on_chain"[\s\S]*?href="\/issuer\/assets\/Asset1"/);
    expect(html).toContain("Waiting on Manci");
    // Who acts is named where the badge does not say it.
    expect(html).toContain("Who acts: Token holders");
    expect(html).toContain("Off-chain");
    expect(html).toContain('aria-current="step"');
    expect(html).toContain('href="/issuer/assets/Asset1"');
  });

  it("speaks of 'the issuer' to an admin, and says when a step is not loaded", () => {
    const j = journey({ audience: "admin", verification: null, application: undefined, assets: [asset()] });
    const html = render(j, "admin", { unavailable: ["the application"], onRetry: () => {} });
    expect(html).toContain("Issuance journey · read-only");
    expect(html).toContain("Waiting on the issuer");
    expect(html).toContain("Not loaded");
    expect(html).toContain("Could not load the application");
    expect(html).toContain("Try again");
    expect(journeyStateLabel({ state: "waiting_on_you", unknown: false }, "issuer")).toBe("Your turn");
    expect(journeyStateLabel({ state: "waiting_on_you", unknown: false }, "admin")).toBe("Waiting on the issuer");
  });

  it("nothing waiting on anyone: the banner says what is under way", () => {
    const selling = journey({ assets: [asset({}, [cls({ openSales: 1, sold: BigInt(5), lifetimeMinted: BigInt(5), circulatingSupply: BigInt(5) })])] });
    const html = render(selling, "issuer");
    expect(html).toContain("In progress · Units minted");
    expect(html).not.toContain("Next: ");
  });

  it("paused: says the status is for reference and offers no hidden link", () => {
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "mainnet");
    vi.stubEnv(KYC_ONLY_ENV, "");
    const html = render(issuerJourney(input({ issuer: null, application: null })), "issuer");
    expect(html).toContain("Issuance is paused for now");
    for (const href of ["/apply", "/issuer/onboarding", "/issuer/assets/tokenize"]) expect(html).not.toContain(`href="${href}"`);
  });
});

describe("page wiring", () => {
  const src = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

  it("the issuer workspace renders the tracker at the top, in place of the four-step overview", async () => {
    const page = src("app/issuer/page.tsx");
    expect(page).toContain("<IssuerWorkflow workflow={workflow} tracker={tracker} />");
    expect(page).toMatch(/useIssuerJourney\(\{\s*audience: "issuer"/);
    const { IssuerWorkflow } = await import("@/app/issuer/issuer-workflow");
    const workflow = {
      data: null, me: undefined, refresh: async () => {}, failed: false, verification: null, verificationLoading: false, verificationError: null,
      needsSignature: false, refreshVerification: () => {}, signedIn: false, authLoading: false, accountMode: false, walletMatchesAccount: true,
    };
    const tracker = createElement(IssuerJourneyTracker, { journey: journey({ verification: null, issuer: null, application: undefined }), audience: "issuer" });
    const html = renderToStaticMarkup(createElement(IssuerWorkflow, { workflow, tracker }));
    expect(html).toContain("data-issuer-journey=\"issuer\"");
    expect(html).not.toContain('aria-label="Issuer process"');
    // The verification summary below the tracker stays.
    expect(html).toContain("Start your verification");
  });

  it("the admin issuer detail renders it read-only from the directory's snapshot", () => {
    const page = src("app/admin/issuers/page.tsx");
    expect(page).toContain("<IssuerJourneyPanel issuer={issuer} data={network}");
    const panel = src("app/admin/issuers/issuer-journey-panel.tsx");
    expect(panel).toContain('audience: "admin"');
    expect(panel).not.toMatch(/signedFetch|verifySigned|tx\.send/);
  });

  it("the loader never opens a wallet prompt: every signed read is session-only", () => {
    const loader = src("lib/use-issuer-journey.ts");
    expect(loader).toContain("listMyApplications(session, { interactive: false })");
    expect(loader).toContain("listApplications(session, undefined, { interactive: false })");
    expect(loader).toContain("listSaleRequests(session, { share_class: c.address }, { interactive: false })");
    expect(loader).toContain("adminListConversionRequests(session, undefined, { interactive: false })");
  });
});
