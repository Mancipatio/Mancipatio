// The owner actor (SIM_OWNER=1, scripts/sim/lib/cohorts/owner.ts) over the
// fake site and chain: the exact admin request sequences the UI sends, every
// planned review path (approve, reject, both more_info variants, leave, edge),
// applications with a needs_changes round, the two OTC escrows, passport
// triage, decisions made by hand, resume after a process death, forced
// failures, the focus lane, the SIM_OWNER_MAX cap and the never-approve
// guards. Offline.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Address } from "@solana/kit";
import { OtcDealStatus } from "@/lib/generated/asset_registry";
import {
  APP_REJECT_LABEL,
  MANUAL_POLL_MS,
  OWNER_ACTIONS,
  OWNER_READS,
  appPlan,
  dossierVerdict,
  morePick,
  ownerDenied,
  ownerQueueView,
  requestKind,
  taskRank,
  type OwnerCtx,
} from "@/scripts/sim/lib/cohorts/owner";
import { DEAL_PRICE, DEAL_UNITS } from "@/scripts/sim/lib/cohorts/trader";
import { simDocument } from "@/scripts/sim/lib/docs";
import type { JournalEntry } from "@/scripts/sim/lib/journal";
import { renderOwnerQueue } from "@/scripts/sim/lib/report";
import type { UserState } from "@/scripts/sim/lib/state";
import { ASSET, SALES } from "./helpers/sim-fake-site";
import { OWNER_DEFAULTS, RUN, findings, plan, reload, restartOwner, roster, runFor, runUntilBlocked, startOwner, world, type World } from "./helpers/sim-world";

const byLabel = (label: string) => plan((p) => p.label === label);

/** The owner actor's HTTP requests (session sign-ins left out), as `action` or `route`. */
function ownerRequests(w: World, target?: string): string[] {
  return w.journal.entries
    .filter((e) => e.kind === "http" && e.user === "owner" && !e.step.endsWith(".session") && (!target || e.target === target))
    .map((e) => e.action ?? e.route!.replace(/^POST /, ""));
}

/** The owner actor's signed envelopes (writes, and reads signed without a session), with their params. */
const ownerSigned = (w: World) => w.site.signedLog.filter((x) => x.wallet === w.admin!.address);
const ownerWrites = (w: World, action: string) => ownerSigned(w).filter((x) => x.action === action);
const ownerLines = (w: World, target: string): JournalEntry[] => w.journal.entries.filter((e) => e.user === "owner" && e.target === target);
const checks = (w: World, id: string) => w.journal.entries.filter((e) => e.kind === "check" && e.step === `owner.${id}`);
const notes = (w: World, step: string) => w.journal.entries.filter((e) => e.kind === "note" && e.step === `owner.${step}`);
const owner = (w: World): OwnerCtx => w.ctx.owner!;
const rec = (u: UserState) => u.data.owner!;

/**
 * The never-approve guards over a whole run: every signed envelope is a
 * sign-in, a read the admin pages make, or a listed write with an allowed
 * value; nothing about users the plan leaves alone.
 */
function expectOnlyPlannedWrites(w: World): void {
  for (const x of ownerSigned(w)) {
    if (x.action === "auth.session" || OWNER_READS.includes(x.action)) continue;
    const allowed = OWNER_ACTIONS[x.action];
    expect(allowed, `an owner write outside OWNER_ACTIONS: ${x.action}`).toBeDefined();
    const value = String(
      x.action === "clients.review-requirement"
        ? x.params.status
        : x.action === "clients.status"
          ? x.params.kyc_status
          : x.action === "clients.kybDecision"
            ? x.params.decision
            : x.action === "clients.request-docs"
              ? (x.params.items as { doc_kind: string }[])[0].doc_kind
              : x.action === "applications.review"
                ? x.params.decision
                : x.action === "otc.adminUpdate"
                  ? x.params.status
                  : (x.params.patch as { status: string }).status,
    );
    expect(allowed, `${x.action} ${value}`).toContain(value);
  }
  expect(ownerWrites(w, "passport.update").some((x) => (x.params.patch as { status?: string }).status === "approved")).toBe(false);
  const targets = new Set(w.journal.entries.filter((e) => e.user === "owner" && e.target).map((e) => e.target!));
  for (const label of targets) expect(ownerDenied(byLabel(label)), `the owner actor named ${label}`).toBe(false);
}

/** Runs the users to their owner wait without the actor, then starts it (a hand decision can be made in between). */
async function blockedThenOwner(w: World, between?: () => void | Promise<void>): Promise<void> {
  const o = w.ctx.owner;
  w.ctx.owner = undefined;
  await runUntilBlocked(w);
  await between?.();
  w.ctx.owner = o;
  await startOwner(w);
}

describe("the decision table", () => {
  it("matches the roster: 45 approve · 7 reject · 7 more_info (alternating) · 6 leave; edge, transfer and leave users are denied", () => {
    const dossiers = roster.filter((p) => dossierVerdict(p));
    const count = (v: string) => dossiers.filter((p) => dossierVerdict(p) === v).length;
    expect([count("approve"), count("reject"), count("more_info")]).toEqual([45, 7, 7]);
    expect(roster.filter((p) => p.review === "leave").map((p) => p.label)).toEqual(["u020", "u037", "u039", "u041", "u065", "u083"]);
    const more = roster.filter((p) => dossierVerdict(p) === "more_info");
    expect(more.filter((p) => morePick(p) === "reject-doc").map((p) => p.label)).toEqual(["u012", "u016", "u022", "u032"]);
    expect(more.filter((p) => morePick(p) === "request-doc").map((p) => p.label)).toEqual(["u013", "u017", "u024"]);
    expect(requestKind(byLabel("u013"))).toEqual({ doc_kind: "bank_statement", label: "Bank statement" });
    expect(requestKind(byLabel("u024"))).toEqual({ doc_kind: "source_of_funds", label: "Source of funds" });
    for (const p of roster.filter((x) => x.cohort === "E" || x.cohort === "X" || x.review === "leave")) {
      expect(ownerDenied(p), p.label).toBe(true);
      expect(dossierVerdict(p), p.label).toBeNull();
    }
    // Applications: B users whose dossier the plan verifies; the one planned rejection only with SIM_OWNER_APP_REJECT=1.
    const apps = roster.filter((p) => appPlan(p, OWNER_DEFAULTS));
    expect(apps).toHaveLength(14);
    expect(apps.filter((p) => appPlan(p, OWNER_DEFAULTS)!.first).map((p) => p.label)).toEqual(["u048", "u067"]);
    expect(APP_REJECT_LABEL).toBe("u090");
    expect(appPlan(byLabel("u090"), OWNER_DEFAULTS)!.final).toBe("approved");
    expect(appPlan(byLabel("u090"), { appReject: true })!.final).toBe("rejected");
    expect(appPlan(byLabel("u008"), OWNER_DEFAULTS)).toBeNull();
  });

  it("orders KYB and KYC dossiers interleaved (approvals first), then applications, escrows and passports last", () => {
    const u029 = byLabel("u029");
    const u011 = byLabel("u011");
    expect(taskRank(byLabel("u004"), "dossier")).toBe(0);
    expect(taskRank(byLabel("u001"), "dossier")).toBe(1);
    expect(taskRank(u029, "dossier")).toBe(2);
    expect(taskRank(u011, "dossier")).toBe(5);
    expect(taskRank(byLabel("u008"), "dossier")).toBeGreaterThan(taskRank(byLabel("u013"), "dossier"));
    expect(taskRank(u029, "app")).toBeGreaterThan(taskRank(byLabel("u097"), "dossier"));
    expect(taskRank(byLabel("u049"), "otc")).toBeGreaterThan(taskRank(u029, "app"));
    expect(taskRank(byLabel("u002"), "passport")).toBeGreaterThan(taskRank(byLabel("u073"), "otc"));
  });

  it("pins the writes the actor may send; passport.update never carries approved", () => {
    expect(OWNER_ACTIONS).toEqual({
      "clients.review-requirement": ["approved", "rejected"],
      "clients.status": ["verified", "rejected"],
      "clients.kybDecision": ["verified", "rejected"],
      "clients.request-docs": ["source_of_funds", "bank_statement"],
      "applications.review": ["approved", "rejected", "needs_changes"],
      "otc.adminUpdate": ["created"],
      "create_otc_deal": ["open"],
      "passport.update": ["in_review", "rejected"],
    });
    expect(OWNER_READS).toEqual(["clients.adminDetail", "clients.doc-url", "applications.adminList", "applications.adminEvents", "otc.list", "otc.adminScreen", "passport.list", "admin.badges"]);
  });
});

describe("KYC and KYB dossiers", () => {
  it("KYC approve (u001): detail, a document view, each document with its detail read, verified, detail, badges; the user finishes", async () => {
    const w = await world([byLabel("u001")], { owner: {} });
    await startOwner(w);
    const [u] = w.users;
    expect(await runFor(w, 40)).toBe("finished");
    expect(u.terminal).toBe("done");
    expect(ownerRequests(w, "u001")).toEqual([
      "clients.adminDetail",
      "clients.doc-url",
      "clients.review-requirement",
      "clients.adminDetail",
      "clients.review-requirement",
      "clients.adminDetail",
      "clients.review-requirement",
      "clients.adminDetail",
      "clients.status",
      "clients.adminDetail",
      "admin.badges",
    ]);
    const d = w.site.dossierOf(u.wallet);
    expect(d.kyc_status).toBe("verified");
    expect(d.requirements.every((r) => r.status === "approved")).toBe(true);
    expect(ownerWrites(w, "clients.status")[0].params).toMatchObject({ id: d.id, kyc_status: "verified", onboarding_status: "verified", reason: expect.stringMatching(/^SIM owner actor \(run t3st01\): all documents approved/) });
    expect(rec(u).dossier).toMatchObject({ verdict: "approve", phase: "decided", decision: "verified" });
    expect(w.state.owner?.decisions).toBe(1);
    // C-O2/C-O3 (the files are the simulator's), C-O4 after every write, C-O5 and C-O11 after the verdict.
    // (No C-O6 line: the user finished in its next poll, and a finished user is never looked at again.)
    for (const id of ["C-O2", "C-O3", "C-O4", "C-O5", "C-O11"]) expect(checks(w, id).length, id).toBeGreaterThan(0);
    expect(findings(w)).toEqual([]);
    expectOnlyPlannedWrites(w);
  });

  it("never lets a working document link into the journal (the doc-url token is redacted)", async () => {
    const w = await world([byLabel("u001")], { owner: {} });
    await startOwner(w);
    await runFor(w, 40);
    const view = w.journal.entries.find((e) => e.user === "owner" && e.action === "clients.doc-url")!;
    expect(view.body).toContain("token=[redacted]");
    expect(view.body).not.toContain("secret-");
  });

  it("KYB approve (u004): four documents, the KYB decision (C-O5 as info), the application approved; a verify_issuer_kyb line", async () => {
    const w = await world([byLabel("u004")], { owner: {} });
    await startOwner(w);
    const [u] = w.users;
    expect(await runFor(w, 60)).toBe("finished");
    expect(u.terminal).toBe("done");
    expect(ownerRequests(w, "u004")).toEqual([
      "clients.adminDetail",
      "clients.doc-url",
      ...Array.from({ length: 4 }, () => ["clients.review-requirement", "clients.adminDetail"]).flat(),
      "clients.kybDecision",
      "clients.adminDetail",
      "admin.badges",
      "applications.adminList",
      "applications.adminEvents",
      "applications.review",
      "/api/audit",
      "applications.adminList",
      "applications.adminEvents",
      "admin.badges",
    ]);
    expect(ownerWrites(w, "clients.status")).toHaveLength(0);
    expect(ownerWrites(w, "clients.kybDecision")[0].params).toMatchObject({ decision: "verified" });
    expect(w.site.audits).toEqual([expect.objectContaining({ ix_name: "review_application:approved", category: "issuers", target_label: "SIM Test d.o.o. 004", actor_wallet: w.admin!.address })]);
    const co5 = checks(w, "C-O5");
    expect(co5.map((e) => e.outcome)).toEqual(["info"]);
    expect(co5[0].body).toMatch(/Q2/);
    expect(rec(u).manual?.map((m) => m.kind)).toEqual(["verify_issuer_kyb"]);
    expect(rec(u).manual![0].line).toMatch(/Verify KYB \(verify_issuer_kyb, signed by the super admin 6AnF/);
    expect(w.state.owner?.decisions).toBe(2);
    expect(findings(w)).toEqual([]);
    expectOnlyPlannedWrites(w);
  });

  it("reject KYC (u006): the verdict first, then each document; no replacement is uploaded; the passport request stays", async () => {
    const w = await world([byLabel("u006")], { owner: {} });
    await startOwner(w);
    const [u] = w.users;
    await runFor(w, 40);
    expect(u.terminal).toBe("rejected");
    expect(ownerRequests(w, "u006")).toEqual([
      "clients.adminDetail",
      "clients.doc-url",
      "clients.status",
      "clients.adminDetail",
      ...Array.from({ length: 3 }, () => ["clients.review-requirement", "clients.adminDetail"]).flat(),
      "admin.badges",
    ]);
    expect(ownerWrites(w, "clients.status")[0].params).toMatchObject({ kyc_status: "rejected", onboarding_status: "rejected" });
    expect(ownerWrites(w, "clients.review-requirement").every((x) => x.params.status === "rejected")).toBe(true);
    const d = w.site.dossierOf(u.wallet);
    expect(d.uploads).toHaveLength(3);
    expect(d.requirements.every((r) => r.status === "rejected")).toBe(true);
    expect(ownerWrites(w, "passport.update")).toHaveLength(0);
    expect(w.site.passportRequests.find((r) => r.wallet === u.wallet)?.status).toBe("new");
    expect(findings(w)).toEqual([]);
    expectOnlyPlannedWrites(w);
  });

  it("reject KYC with SIM_OWNER_PASSPORT_REJECT=1: the open passport request is rejected too, with its audit row", async () => {
    const w = await world([byLabel("u006")], { owner: { passportReject: true } });
    await startOwner(w);
    const [u] = w.users;
    await runFor(w, 40);
    expect(u.terminal).toBe("rejected");
    expect(ownerRequests(w, "u006").slice(-5)).toEqual(["passport.list", "passport.update", "/api/audit", "passport.list", "admin.badges"]);
    expect(ownerWrites(w, "passport.update")[0].params).toMatchObject({ patch: { status: "rejected", handled_by: w.admin!.address }, reason: expect.stringMatching(/dossier rejected/) });
    expect(w.site.passportRequests.find((r) => r.wallet === u.wallet)?.status).toBe("rejected");
    expect(w.site.audits.map((a) => a.ix_name)).toEqual(["passport_request_rejected"]);
    expect(findings(w)).toEqual([]);
  });

  it("reject KYB (u008): KYB rejected, each document rejected, no clients.status; the company ends rejected", async () => {
    const w = await world([byLabel("u008")], { owner: {} });
    await startOwner(w);
    const [u] = w.users;
    await runFor(w, 40);
    expect(u.terminal).toBe("rejected");
    expect(u.reason).toBe("KYB rejected");
    expect(ownerWrites(w, "clients.status")).toHaveLength(0);
    expect(ownerWrites(w, "clients.kybDecision").map((x) => x.params.decision)).toEqual(["rejected"]);
    expect(ownerWrites(w, "clients.review-requirement")).toHaveLength(4);
    expect(w.site.dossierOf(u.wallet).uploads).toHaveLength(4);
    expect(findings(w)).toEqual([]);
  });

  it("more_info reject-doc (u022): the other files approved, the passport rejected once; the replacement approved only after it arrived", async () => {
    const w = await world([byLabel("u022")], { owner: {} });
    await startOwner(w);
    const [u] = w.users;
    await runFor(w, 60);
    expect(u.terminal).toBe("done");
    const d = w.site.dossierOf(u.wallet);
    const passport = d.requirements.find((r) => r.doc_kind === "passport")!;
    const reviews = ownerWrites(w, "clients.review-requirement");
    expect(reviews.filter((x) => x.params.status === "rejected").map((x) => x.params.id)).toEqual([passport.id]);
    expect(reviews.map((x) => x.params.status)).toEqual(["approved", "approved", "rejected", "approved"]);
    // Order: the round-2 passport upload lands before the owner approves the passport requirement.
    const seq = w.journal.entries.filter((e) => e.kind === "http");
    const upload2 = seq.findIndex((e) => e.user === "u022" && e.step === "upload.passport" && seq.slice(0, seq.indexOf(e)).some((x) => x.user === "u022" && x.step === "upload.passport"));
    const approvals = w.site.signedLog.filter((x) => x.action === "clients.review-requirement" && x.params.id === passport.id && x.params.status === "approved");
    expect(upload2).toBeGreaterThan(0);
    expect(approvals).toHaveLength(1);
    expect(d.uploads.map((x) => x.name).filter((n) => n.includes("passport"))).toEqual([expect.stringMatching(/passport-v1/), expect.stringMatching(/passport-v2/)]);
    expect(d.kyc_status).toBe("verified");
    expect(rec(u).dossier).toMatchObject({ pick: "reject-doc", roundDone: true, phase: "decided" });
    expect(notes(w, "await-user")).toHaveLength(1);
    expect(findings(w)).toEqual([]);
    expectOnlyPlannedWrites(w);
  });

  it("more_info request-doc (u024): one more document requested, uploaded once, approved, verified (C-O10: pending again)", async () => {
    const w = await world([byLabel("u024")], { owner: {} });
    await startOwner(w);
    const [u] = w.users;
    await runFor(w, 60);
    expect(u.terminal).toBe("done");
    expect(ownerWrites(w, "clients.request-docs").map((x) => x.params.items)).toEqual([[{ doc_kind: "source_of_funds", label: "Source of funds", note: expect.stringMatching(/one more document requested/) }]]);
    const d = w.site.dossierOf(u.wallet);
    expect(d.uploads.filter((x) => x.kind === "source_of_funds")).toHaveLength(1);
    expect(d.requirements.find((r) => r.doc_kind === "source_of_funds")).toMatchObject({ status: "approved", requested_by: w.admin!.address });
    expect(checks(w, "C-O10").map((e) => e.outcome)).toEqual(["ok"]);
    expect(findings(w)).toEqual([]);
    expectOnlyPlannedWrites(w);
  });

  it("more_info request-doc on a company (u013): a bank statement, then KYB verified and the application approved", async () => {
    const w = await world([byLabel("u013")], { owner: {} });
    await startOwner(w);
    const [u] = w.users;
    await runFor(w, 80);
    expect(u.terminal).toBe("done");
    expect(ownerWrites(w, "clients.request-docs")[0].params.items).toEqual([expect.objectContaining({ doc_kind: "bank_statement" })]);
    expect(ownerWrites(w, "clients.kybDecision").map((x) => x.params.decision)).toEqual(["verified"]);
    expect(ownerWrites(w, "applications.review").map((x) => x.params.decision)).toEqual(["approved"]);
    expect(findings(w)).toEqual([]);
  });

  it("C-O3: a PLEASE REJECT file on an approve dossier (u001) is never approved; the dossier is handed back, the user still waits", async () => {
    const w = await world([byLabel("u001")], { owner: {} });
    const [u] = w.users;
    const stamped = createHash("sha256").update(simDocument({ runId: RUN, n: u.plan.n, kind: "passport", round: 1, reject: true }).bytes).digest("hex");
    await blockedThenOwner(w, () => {
      w.site.dossierOf(u.wallet).documents.find((x) => x.kind === "passport")!.sha256 = stamped;
    });
    await runFor(w, 30);
    expect(ownerWrites(w, "clients.review-requirement")).toHaveLength(0);
    expect(ownerWrites(w, "clients.status")).toHaveLength(0);
    expect(checks(w, "C-O3").map((e) => e.outcome)).toEqual(["consistency"]);
    expect(rec(u).handedBack).toMatchObject({ kind: "dossier", reason: expect.stringMatching(/^C-O3: .*passport .*the PLEASE REJECT stamp is present.*decide the dossier by hand/) });
    expect(u.terminal).toBeUndefined();
    expect(u.stage).toBe("await.dossier");
    expect(w.site.dossierOf(u.wallet).kyc_status).toBe("pending");
    expectOnlyPlannedWrites(w);
  });

  it("companies whose KYB was verified by hand before the actor started (u004 done, u029 at its application) still get the verify_issuer_kyb line", async () => {
    const w = await world([byLabel("u004"), byLabel("u029")], { owner: {} });
    const [u004, u029] = w.users;
    const o = w.ctx.owner;
    w.ctx.owner = undefined;
    await runUntilBlocked(w);
    w.site.kybVerify(u004.wallet);
    w.site.kybVerify(u029.wallet);
    await runFor(w, 10);
    w.site.review(u004.wallet, "approved");
    await runFor(w, 10);
    expect(u004.terminal).toBe("done");
    expect(u029.stage).toBe("await.app");
    w.ctx.owner = o;
    await startOwner(w);
    for (const u of [u004, u029]) expect(rec(u).manual?.map((m) => m.kind), u.plan.label).toEqual(["verify_issuer_kyb"]);
    await runFor(w, 60);
    expect(u029.terminal).toBe("done");
    expect(ownerWrites(w, "clients.kybDecision")).toHaveLength(0);
    expect(ownerWrites(w, "applications.review").map((x) => x.params.decision)).toEqual(["approved"]);
    expect(rec(u029).manual).toHaveLength(1);
    const queue = renderOwnerQueue(w.state, [], { owner: ownerQueueView(w.ctx) });
    expect(queue).toMatch(new RegExp(`issuer KYB u004 SIM Test d.o.o. 004 issuer ${u004.data.issuerPda}`));
    expect(queue).toMatch(new RegExp(`issuer KYB u029 SIM Test d.o.o. 029 issuer ${u029.data.issuerPda}`));
    expect(findings(w)).toEqual([]);
  });

  it("leave (u037), stop-after-one (u065) and edge (u005) dossiers: not one owner request names them", async () => {
    const w = await world([byLabel("u037"), byLabel("u065"), byLabel("u005")], { owner: {} });
    await startOwner(w);
    await runFor(w, 40);
    for (const label of ["u037", "u065", "u005"]) expect(ownerLines(w, label), label).toEqual([]);
    expect(w.site.dossierOf(w.users[0].wallet).kyc_status).toBe("pending");
    expect(ownerSigned(w).filter((x) => x.action !== "admin.badges" && x.action !== "auth.session")).toEqual([]);
  });
});

describe("applications", () => {
  it("needs-changes company (u048): needs_changes, the resubmission, then approved", async () => {
    const w = await world([byLabel("u048")], { owner: {} });
    await startOwner(w);
    const [u] = w.users;
    await runFor(w, 90);
    expect(u.terminal).toBe("done");
    expect(ownerWrites(w, "applications.review").map((x) => x.params.decision)).toEqual(["needs_changes", "approved"]);
    expect(w.site.events.map((e) => `${e.actor}:${e.action}`)).toEqual(["applicant:submitted", "admin:needs_changes", "applicant:resubmitted", "admin:approved"]);
    expect(rec(u).app).toMatchObject({ phase: "decided", rounds: [{ decision: "needs_changes" }, { decision: "approved" }] });
    expect(w.state.owner?.decisions).toBe(3);
    expect(findings(w)).toEqual([]);
  });

  it("u090 is approved by default and rejected with SIM_OWNER_APP_REJECT=1 (the reject path)", async () => {
    for (const appReject of [false, true]) {
      const w = await world([byLabel("u090")], { owner: { appReject } });
      await startOwner(w);
      const [u] = w.users;
      await runFor(w, 60);
      expect(u.terminal).toBe("done");
      expect(u.reason).toBe(`application ${appReject ? "rejected" : "approved"}`);
      expect(ownerWrites(w, "applications.review")[0].params).toMatchObject({
        decision: appReject ? "rejected" : "approved",
        reason: appReject ? expect.stringMatching(/planned rejection/) : expect.stringMatching(/approved as planned/),
      });
      expect(findings(w)).toEqual([]);
    }
  });

  it("an application of a user the plan does not verify (u008 verified by hand) is handed back, never approved", async () => {
    const w = await world([byLabel("u008")], { owner: {} });
    const [u] = w.users;
    await blockedThenOwner(w, () => w.site.kybVerify(u.wallet));
    await runFor(w, 40);
    expect(u.stage).toBe("await.app");
    expect(ownerWrites(w, "applications.review")).toHaveLength(0);
    expect(rec(u).handedBack?.reason).toMatch(/not in the plan/);
    expect(notes(w, "elsewhere").map((e) => e.body)).toEqual([expect.stringMatching(/KYB is already verified.*against the plan/)]);
  });
});

describe("OTC escrows", () => {
  for (const pair of [3, 4] as const) {
    it(`pair ${pair}: list, mint, screen, eligibility, the class's deals, a re-read, create_otc_deal, the deal, a re-read, the flip, audit, list; both deposit`, async () => {
      const w = await world(roster.filter((p) => p.pair === pair), { owner: {} });
      await startOwner(w);
      const requester = w.users.find((u) => (pair === 3 ? u.plan.variant === "maker" : u.plan.variant === "taker"))!;
      const partner = w.users.find((u) => u !== requester)!;
      expect(await runFor(w, 120)).toBe("finished");
      expect(requester.terminal).toBe("done");
      expect(partner.terminal).toBe("done");
      expect(ownerRequests(w, requester.plan.label)).toEqual(["otc.list", "otc.adminScreen", "otc.list", "otc.list", "otc.adminUpdate", "/api/audit", "otc.list", "admin.badges"]);
      expect(ownerLines(w, partner.plan.label).filter((e) => e.kind === "http")).toEqual([]);
      const ops = w.chain.calls.filter((c) => ["paymentMintProgram", "otcDeals", "owner.otc.create"].includes(c.op)).map((c) => c.op);
      expect(ops).toEqual(["paymentMintProgram", "otcDeals", "owner.otc.create"]);
      const t = rec(requester).otc!;
      expect(t).toMatchObject({ phase: "decided", requestId: requester.data.dealRequestId });
      const deal = w.chain.deals.get(t.dealPda!)!;
      expect(deal).toMatchObject({ status: OtcDealStatus.Completed, admin: w.admin!.address, amount: BigInt(DEAL_UNITS), price: BigInt(DEAL_PRICE), shareClass: SALES[1], paymentMint: ASSET });
      expect(w.chain.deals.size).toBe(1);
      expect(ownerWrites(w, "otc.adminUpdate")[0].params).toEqual({ id: t.requestId, status: "created", deal_pda: t.dealPda, deal_id: Number(t.dealId), decide: true });
      expect(w.site.audits).toEqual([expect.objectContaining({ ix_name: "create_otc_deal", category: "otc", tx_signature: `sig-${requester.plan.label}-owner.otc.create`, metadata: expect.objectContaining({ deal_pda: t.dealPda, deal_id: t.dealId }) })]);
      expect(checks(w, "C-O7").map((e) => e.outcome)).toEqual(["ok"]);
      expect(checks(w, "C-O6").every((e) => e.outcome === "ok")).toBe(true);
      expect(findings(w)).toEqual([]);
      expectOnlyPlannedWrites(w);
    });
  }

  it("M2: an Open deal of the pair already on chain (opened by hand, row not flipped): no second deal, no flip, handed back", async () => {
    const w = await world(roster.filter((p) => p.pair === 3), { owner: {} });
    const maker = w.users.find((u) => u.plan.variant === "maker")!;
    const taker = w.users.find((u) => u.plan.variant === "taker")!;
    const hand = (await w.chain.dealPda(SALES[1] as Address, BigInt(42))) as string;
    await blockedThenOwner(w, () => {
      w.chain.deals.set(hand, { status: OtcDealStatus.Open, assetDeposited: false, paymentDeposited: false, seller: maker.wallet, buyer: taker.wallet, amount: BigInt(DEAL_UNITS), price: BigInt(DEAL_PRICE), shareClass: SALES[1], paymentMint: ASSET });
    });
    await runFor(w, 30);
    expect(w.chain.deals.size).toBe(1);
    expect(w.chain.calls.some((c) => c.op === "owner.otc.create")).toBe(false);
    expect(ownerWrites(w, "otc.adminUpdate")).toHaveLength(0);
    expect(rec(maker).handedBack?.reason).toMatch(new RegExp(`Open deal ${hand} .* already exists`));
  });

  it("M2: a request declined by hand after the actor opened its deal is not flipped back; the deal is handed back to cancel", async () => {
    const w = await world(roster.filter((p) => p.pair === 4), { owner: {} });
    await startOwner(w);
    const taker = w.users.find((u) => u.plan.variant === "taker")!;
    w.chain.onLand = (u, label) => {
      if (label === "owner.otc.create") w.site.otc.find((r) => r.id === u.data.dealRequestId)!.status = "cancelled";
    };
    await runFor(w, 60);
    expect(w.site.otc[0].status).toBe("cancelled");
    expect(ownerWrites(w, "otc.adminUpdate")).toHaveLength(0);
    expect(rec(taker).handedBack?.reason).toMatch(/cancel that deal/);
    expect(checks(w, "C-O7").map((e) => e.outcome)).toEqual(["ok", "consistency"]);
  });

  it("an unresolved create_otc_deal signature: the focus waits a minute between status checks, then one deal and one flip", async () => {
    const w = await world(roster.filter((p) => p.pair === 3), { owner: {} });
    await startOwner(w);
    w.chain.faults.set("owner.otc.create", "unresolved");
    w.chain.inflightAnswers.set("owner.otc.create", ["pending", "pending"]);
    const calls: number[] = [];
    const open = w.chain.openOtcDeal.bind(w.chain);
    w.chain.openOtcDeal = async (...args: Parameters<typeof open>) => {
      calls.push(w.clock.t);
      return open(...args);
    };
    expect(await runFor(w, 120)).toBe("finished");
    // The send, two unresolved checks, the landed one: never back to back.
    expect(calls).toHaveLength(4);
    for (let i = 1; i < calls.length; i++) expect(calls[i] - calls[i - 1]).toBeGreaterThanOrEqual(60_000);
    expect(w.chain.sentWires.filter((x) => x.endsWith("owner.otc.create"))).toHaveLength(1);
    expect(w.chain.deals.size).toBe(1);
    expect(ownerWrites(w, "otc.adminUpdate")).toHaveLength(1);
    expect(w.users.every((u) => u.terminal === "done")).toBe(true);
    expect(findings(w)).toEqual([]);
  });

  it("a process death with create_otc_deal inflight resumes into one deal and one flip", async () => {
    const w = await world(roster.filter((p) => p.pair === 3), { owner: {}, persist: true });
    await startOwner(w);
    w.chain.faults.set("owner.otc.create", "process-death");
    await expect(runFor(w, 120)).rejects.toThrow(/fake process death/);
    reload(w);
    await restartOwner(w);
    expect(await runFor(w, 120)).toBe("finished");
    expect(w.chain.sentWires.filter((x) => x.endsWith("owner.otc.create"))).toHaveLength(1);
    expect(w.chain.deals.size).toBe(1);
    expect(ownerWrites(w, "otc.adminUpdate")).toHaveLength(1);
    expect(w.users.every((u) => u.terminal === "done")).toBe(true);
  });
});

describe("passport triage", () => {
  it("a verified buyer's request is marked in review and left for the KYC provider (a queue line); the hand issuance lets it buy", async () => {
    const w = await world([byLabel("u002")], { owner: {} });
    await startOwner(w);
    const [u] = w.users;
    await runFor(w, 40);
    expect(u.stage).toBe("await.passport");
    expect(ownerRequests(w, "u002").slice(-3)).toEqual(["passport.list", "passport.update", "passport.list"]);
    expect(ownerWrites(w, "passport.update")[0].params).toEqual({ id: rec(u).passport!.requestId, patch: { status: "in_review" }, reason: null });
    const request = w.site.passportRequests.find((r) => r.wallet === u.wallet)!;
    expect(request.status).toBe("in_review");
    expect(rec(u).manual).toEqual([expect.objectContaining({ kind: "passport", line: expect.stringContaining(`request ${request.id} (in review) → Issue passport (approve_holder on registry 5MofiJNCoCRkNg1f2Yd7368WkjiNxkZZmUTaQo7xLhku, signed by the KYC provider KYCprovider`) })]);
    const queue = renderOwnerQueue(w.state, [], { owner: ownerQueueView(w.ctx) });
    expect(queue).toContain("## Needs the super admin / KYC provider wallet (CekAgg cannot sign these)");
    expect(queue).toContain(`request ${request.id} (in review)`);
    expect(queue).toMatch(/u002 \[I\/buyer-kyc, pilot, review=approve\] \[manual\] wallet/);
    // The KYC provider issues it by hand: the buyer goes on.
    w.chain.issued.add(u.wallet);
    w.site.issuePassport(u.wallet);
    await runFor(w, 30);
    expect(u.terminal).toBe("done");
    expect(findings(w)).toEqual([]);
    expectOnlyPlannedWrites(w);
  });
});

describe("decisions made by hand", () => {
  it("a dossier verified by hand before the actor gets there: no write, an elsewhere note, the user continues", async () => {
    const w = await world([byLabel("u001")], { owner: {} });
    const [u] = w.users;
    await blockedThenOwner(w, () => w.site.verify(u.wallet));
    await runFor(w, 20);
    expect(u.terminal).toBe("done");
    expect(ownerRequests(w, "u001")).toEqual(["clients.adminDetail"]);
    expect(notes(w, "elsewhere").map((e) => e.body)).toEqual([expect.stringMatching(/KYC is already verified/)]);
    expect(w.state.owner?.decisions).toBe(0);
    expect(findings(w)).toEqual([]);
  });

  it("M1: a document rejected by hand on an approve dossier: the actor waits for the user's replacement (no deadlock), then verifies", async () => {
    const w = await world([byLabel("u001")], { owner: {} });
    const [u] = w.users;
    await blockedThenOwner(w, () => w.site.rejectDocument(u.wallet, "selfie"));
    await runFor(w, 60);
    expect(u.terminal).toBe("done");
    expect(notes(w, "await-user")).toHaveLength(1);
    expect(w.site.dossierOf(u.wallet).uploads.map((x) => x.name).filter((n) => n.includes("selfie"))).toEqual([expect.stringMatching(/-v1/), expect.stringMatching(/-v2/)]);
    expect(ownerWrites(w, "clients.review-requirement").every((x) => x.params.status === "approved")).toBe(true);
    expect(findings(w)).toEqual([]);
  });

  it("S11: a more_info round started by hand (Request more info) is the round: the actor sends no request-docs of its own", async () => {
    const w = await world([byLabel("u024")], { owner: {} });
    const [u] = w.users;
    await blockedThenOwner(w, () => w.site.requestDocument(u.wallet, "national_id", "HandAdminWallet111111111111111111111111111"));
    await runFor(w, 60);
    expect(u.terminal).toBe("done");
    expect(ownerWrites(w, "clients.request-docs")).toHaveLength(0);
    expect(rec(u).dossier).toMatchObject({ roundDone: true, target: { byHand: true } });
    expect(findings(w)).toEqual([]);
  });
});

describe("resume after a process death", () => {
  /** Kills the process once the site answered `route` (the write applied, the step not persisted). */
  function dieAfter(w: World, route: string): void {
    const original = w.site.fetch;
    let armed = true;
    w.site.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await original(input, init);
      if (armed && new URL(String(input)).pathname === route) {
        armed = false;
        w.chain.onDeath?.();
        w.limiter.stop("fake process death");
      }
      return response;
    }) as typeof fetch;
    (w.ctx.http as unknown as { deps: { fetch: typeof fetch } }).deps.fetch = w.site.fetch;
  }
  async function revive(w: World): Promise<void> {
    reload(w);
    (w.limiter as unknown as { stopped: string | null }).stopped = null;
    await restartOwner(w);
  }

  it("a death right after clients.status verified reached the site: the re-read shows it, nothing is re-sent, one decision", async () => {
    const w = await world([byLabel("u001")], { owner: {}, persist: true });
    await startOwner(w);
    dieAfter(w, "/api/clients/status");
    expect(await runFor(w, 40)).toBe("stopped");
    await revive(w);
    expect(await runFor(w, 40)).toBe("finished");
    expect(ownerWrites(w, "clients.status")).toHaveLength(1);
    expect(ownerWrites(w, "clients.review-requirement")).toHaveLength(3);
    expect(w.state.owner?.decisions).toBe(1);
    expect(notes(w, "elsewhere")).toEqual([]);
    expect(w.users[0].terminal).toBe("done");
  });

  it("a death after the last document approval: no approval is sent twice, exactly one verdict", async () => {
    const w = await world([byLabel("u001")], { owner: {}, persist: true });
    await startOwner(w);
    let approvals = 0;
    const original = w.site.fetch;
    w.site.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await original(input, init);
      if (new URL(String(input)).pathname === "/api/clients/review-requirement" && ++approvals === 3) {
        w.chain.onDeath?.();
        w.limiter.stop("fake process death");
      }
      return response;
    }) as typeof fetch;
    (w.ctx.http as unknown as { deps: { fetch: typeof fetch } }).deps.fetch = w.site.fetch;
    expect(await runFor(w, 40)).toBe("stopped");
    await revive(w);
    expect(await runFor(w, 40)).toBe("finished");
    expect(ownerWrites(w, "clients.review-requirement")).toHaveLength(3);
    expect(ownerWrites(w, "clients.status")).toHaveLength(1);
  });

  it("a death right after request-docs: no second requested row", async () => {
    const w = await world([byLabel("u024")], { owner: {}, persist: true });
    await startOwner(w);
    dieAfter(w, "/api/clients/request-docs");
    expect(await runFor(w, 60)).toBe("stopped");
    await revive(w);
    expect(await runFor(w, 60)).toBe("finished");
    expect(ownerWrites(w, "clients.request-docs")).toHaveLength(1);
    expect(w.site.dossierOf(w.users[0].wallet).requirements.filter((r) => r.doc_kind === "source_of_funds")).toHaveLength(1);
    expect(w.users[0].terminal).toBe("done");
  });
});

describe("failures", () => {
  it("a 500 on clients.status: a 5xx finding, the user keeps waiting (never failed), the retry succeeds", async () => {
    const w = await world([byLabel("u001")], { owner: {} });
    await startOwner(w);
    w.site.failNext.set("/api/clients/status", { status: 500, times: 1 });
    await runFor(w, 60);
    expect(w.users[0].terminal).toBe("done");
    expect(findings(w).map((e) => [e.user, e.target, e.route, e.outcome])).toEqual([["owner", "u001", "POST /api/clients/status", "5xx"]]);
    expect(w.journal.entries.filter((e) => e.user === "owner" && e.route === "POST /api/clients/status").map((e) => e.httpStatus)).toEqual([500, 200]);
    expect(w.users[0].attempts).toBe(0);
  });

  it("a 409 on clients.status: a finding, handed back at once (an owner-queue line), the user still waits; SIM_OWNER_RETRY=1 tries again", async () => {
    const w = await world([byLabel("u001")], { owner: {} });
    await startOwner(w);
    const [u] = w.users;
    w.site.failNext.set("/api/clients/status", { status: 409, times: 1 });
    await runFor(w, 20);
    expect(u.terminal).toBeUndefined();
    expect(u.stage).toBe("await.dossier");
    expect(findings(w).map((e) => [e.route, e.httpStatus, e.outcome])).toEqual([["POST /api/clients/status", 409, "unexpected-4xx"]]);
    expect(rec(u).handedBack).toMatchObject({ task: expect.stringMatching(/^KYC dossier/), reason: expect.stringMatching(/clients.status answered 409/) });
    const queue = renderOwnerQueue(w.state, [], { owner: ownerQueueView(w.ctx) });
    expect(queue).toMatch(/## Handed back by the owner actor \(decide by hand\)\nu001 \[K\/kyc\] KYC dossier .*clients.status answered 409/);
    await restartOwner(w, { retry: true });
    await runFor(w, 30);
    expect(u.terminal).toBe("done");
    expect(notes(w, "retry")).toHaveLength(1);
  });

  it("a KYB verdict applied but answered 504 (u004): the user waits for the actor's re-read, the decision is counted once and checked, nothing is re-sent", async () => {
    const w = await world([byLabel("u004")], { owner: {} });
    await startOwner(w);
    const [u] = w.users;
    w.site.failAfter.set("/api/clients/kyb-decision", { status: 504, times: 1 });
    expect(await runFor(w, 60)).toBe("finished");
    expect(u.terminal).toBe("done");
    expect(ownerWrites(w, "clients.kybDecision")).toHaveLength(1);
    expect(rec(u).dossier).toMatchObject({ phase: "decided", decision: "KYB verified", finalDone: true });
    expect(w.state.owner?.decisions).toBe(2);
    // Between the write and the actor's re-read the user sent nothing (its poll would have moved it on).
    const http = w.journal.entries.filter((e) => e.kind === "http" && !e.step.endsWith(".session"));
    const write = http.findIndex((e) => e.user === "owner" && e.action === "clients.kybDecision");
    const reread = http.findIndex((e, i) => i > write && e.user === "owner" && e.action === "clients.adminDetail");
    expect(reread).toBeGreaterThan(write);
    expect(http.slice(write + 1, reread).some((e) => e.user === "u004")).toBe(false);
    expect(checks(w, "C-O5").map((e) => e.outcome)).toEqual(["info"]);
    expect(findings(w).map((e) => [e.route, e.httpStatus])).toEqual([["POST /api/clients/kyb-decision", 504]]);
  });

  it("a KYB rejection applied but answered 500 (u008): every document is still rejected before the company learns it", async () => {
    const w = await world([byLabel("u008")], { owner: {} });
    await startOwner(w);
    const [u] = w.users;
    w.site.failAfter.set("/api/clients/kyb-decision", { status: 500, times: 1 });
    await runFor(w, 60);
    expect(u.terminal).toBe("rejected");
    expect(ownerWrites(w, "clients.kybDecision").map((x) => x.params.decision)).toEqual(["rejected"]);
    expect(ownerWrites(w, "clients.review-requirement").map((x) => x.params.status)).toEqual(["rejected", "rejected", "rejected", "rejected"]);
    expect(w.site.dossierOf(u.wallet).requirements.every((r) => r.status === "rejected")).toBe(true);
    expect(rec(u).dossier).toMatchObject({ phase: "decided" });
    expect(w.state.owner?.decisions).toBe(1);
  });

  it("an application approval applied but answered 502 (u090): one review, one round, one audit row", async () => {
    const w = await world([byLabel("u090")], { owner: {} });
    await startOwner(w);
    const [u] = w.users;
    w.site.failAfter.set("/api/applications/review", { status: 502, times: 1 });
    await runFor(w, 60);
    expect(u.terminal).toBe("done");
    expect(ownerWrites(w, "applications.review")).toHaveLength(1);
    expect(rec(u).app).toMatchObject({ phase: "decided", rounds: [{ decision: "approved" }] });
    expect(w.site.audits.filter((a) => a.ix_name === "review_application:approved")).toHaveLength(1);
    expect(w.state.owner?.decisions).toBe(2);
  });

  it("a hand-back ends that task only: u002's dossier handed back, verified by hand, then its passport request is still triaged", async () => {
    const w = await world([byLabel("u002")], { owner: {} });
    await startOwner(w);
    const [u] = w.users;
    w.site.failNext.set("/api/clients/status", { status: 409, times: 1 });
    await runFor(w, 20);
    expect(rec(u).dossier?.phase).toBe("handed-back");
    expect(renderOwnerQueue(w.state, [], { owner: ownerQueueView(w.ctx) })).toMatch(/## Handed back by the owner actor \(decide by hand\)\nu002 /);
    w.site.verify(u.wallet);
    await runFor(w, 30);
    expect(u.stage).toBe("await.passport");
    expect(ownerWrites(w, "passport.update").map((x) => x.params.patch)).toEqual([{ status: "in_review" }]);
    expect(rec(u).passport?.phase).toBe("in-review");
    expect(rec(u).manual?.map((m) => m.kind)).toEqual(["passport"]);
    const queue = renderOwnerQueue(w.state, [], { owner: ownerQueueView(w.ctx) });
    expect(queue).toMatch(/## Handed back by the owner actor \(decide by hand\)\n\(none\)/);
    expectOnlyPlannedWrites(w);
  });

  it("transient failures count per task: two on u004's dossier (then decided by hand) do not hand back its application at the first failure", async () => {
    const w = await world([byLabel("u004")], { owner: {} });
    const [u] = w.users;
    await blockedThenOwner(w, () => {
      w.site.kybVerify(u.wallet);
      w.site.failNext.set("/api/clients/admin-detail", { status: 500, times: 2 });
      w.site.failNext.set("/api/applications/admin-list", { status: 500, times: 1 });
    });
    await runFor(w, 60);
    expect(notes(w, "elsewhere").map((e) => e.body)).toEqual([expect.stringMatching(/KYB is already verified/)]);
    expect(u.terminal).toBe("done");
    expect(rec(u).handedBack).toBeUndefined();
    expect(ownerWrites(w, "applications.review").map((x) => x.params.decision)).toEqual(["approved"]);
  });

  it("S14: a CLI Admin without an Admin record never starts; a 403 mid-run stops the actor and every user polls on", async () => {
    const w = await world([byLabel("u001")], { owner: {} });
    w.chain.admins.clear();
    await expect(startOwner(w)).rejects.toThrow(/has no Admin record/);
    w.chain.admins.add(w.admin!.address);
    await startOwner(w);
    w.site.admins.clear();
    await runFor(w, 20);
    expect(owner(w).stopped).toMatch(/403/);
    expect(w.users[0].terminal).toBeUndefined();
    const polls = w.journal.entries.filter((e) => e.user === "u001" && e.step === "poll.clients.me");
    expect(polls.length).toBeGreaterThan(2);
  });

  it("C-O11: a badges route that still counts a decided dossier is a finding", async () => {
    const w = await world([byLabel("u001")], { owner: {} });
    await blockedThenOwner(w);
    w.site.badgesCountClosed = true;
    await runFor(w, 30);
    expect(checks(w, "C-O11").map((e) => e.outcome)).toEqual(["consistency"]);
  });
});

describe("the focus lane and the cap", () => {
  const approvers = roster.filter((p) => p.cohort === "K" && p.variant === "kyc" && p.review === "approve" && p.wave > 0).slice(0, 6);

  it("one task at a time, never interleaved with the user's own requests; writes ≥ 8 s apart, ≤ 2 requests in flight", async () => {
    const w = await world(approvers, { owner: {} });
    await startOwner(w);
    const times: number[] = [];
    let inFlight = 0;
    let peak = 0;
    const original = w.site.fetch;
    w.site.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        return await original(input, init);
      } finally {
        inFlight -= 1;
      }
    }) as typeof fetch;
    (w.ctx.http as unknown as { deps: { fetch: typeof fetch } }).deps.fetch = w.site.fetch;
    const acquire = w.limiter.acquire.bind(w.limiter);
    w.limiter.acquire = async (classes, options) => {
      const release = await acquire(classes, options);
      if (classes.includes("write")) times.push(w.clock.t);
      return release;
    };
    expect(await runFor(w, 120)).toBe("finished");
    expect(peak).toBeLessThanOrEqual(2);
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(8_000);
    const http = w.journal.entries.filter((e) => e.kind === "http" && !e.step.endsWith(".session"));
    const targets = http.filter((e) => e.user === "owner" && e.target).map((e) => e.target!);
    const runs = targets.filter((t, i) => i === 0 || targets[i - 1] !== t);
    expect(new Set(runs).size).toBe(runs.length); // each user's task is one contiguous run
    for (const p of approvers) {
      const first = http.findIndex((e) => e.target === p.label);
      const last = http.map((e) => e.target).lastIndexOf(p.label);
      expect(http.slice(first, last).some((e) => e.user === p.label), p.label).toBe(false);
    }
    expect(w.state.owner?.decisions).toBe(approvers.length);
    expect(findings(w)).toEqual([]);
  });

  it("SIM_OWNER_MAX=1: exactly one final decision; then everyone polls as before, the cap persists across a restart", async () => {
    const w = await world(approvers.slice(0, 3), { owner: { max: 1 } });
    await startOwner(w);
    await runFor(w, 40);
    expect(ownerWrites(w, "clients.status")).toHaveLength(1);
    expect(w.state.owner?.decisions).toBe(1);
    expect(owner(w).stopped).toMatch(/SIM_OWNER_MAX=1 reached/);
    const waiting = w.users.filter((u) => !u.terminal);
    expect(waiting).toHaveLength(2);
    for (const u of waiting) expect(w.journal.entries.filter((e) => e.user === u.plan.label && e.step === "poll.clients.me").length).toBeGreaterThan(2);
    await restartOwner(w, { max: 1 });
    await runFor(w, 10);
    expect(ownerWrites(w, "clients.status")).toHaveLength(1);
    await restartOwner(w, { max: 3 });
    await runFor(w, 40);
    expect(ownerWrites(w, "clients.status")).toHaveLength(3);
  });

  it("SIM_OWNER_MAX=1 with the first verdict applied but answered 500: it counts, its re-read comes first, and no second verdict is sent", async () => {
    const w = await world(approvers.slice(0, 2), { owner: { max: 1 } });
    await startOwner(w);
    w.site.failAfter.set("/api/clients/status", { status: 500, times: 1 });
    await runFor(w, 40);
    expect(ownerWrites(w, "clients.status")).toHaveLength(1);
    expect(w.users.filter((u) => w.site.dossierOf(u.wallet).kyc_status === "verified")).toHaveLength(1);
    expect(w.state.owner?.decisions).toBe(1);
    expect(rec(w.users[0]).dossier).toMatchObject({ phase: "decided", finalDone: true });
    expect(owner(w).stopped).toMatch(/SIM_OWNER_MAX=1 reached \(1 decisions/);
    expect(w.users[0].terminal).toBe("done");
    expect(w.users[1].terminal).toBeUndefined();
  });

  it("SIM_OWNER_ONLY: only the listed users are decided", async () => {
    const w = await world(approvers.slice(0, 3), { owner: { only: [approvers[1].label] } });
    await startOwner(w);
    await runFor(w, 40);
    expect([...new Set(ownerSigned(w).filter((x) => x.action === "clients.status").map((x) => x.params.id))]).toEqual([w.site.dossierOf(w.users[1].wallet).id]);
  });

  it("S3: a user that only waits for a manual decision (leave) polls at most every 10 min while the actor works", async () => {
    const w = await world([byLabel("u037"), ...approvers.slice(0, 4)], { owner: {} });
    await startOwner(w);
    const leave = w.users[0];
    const times: { t: number; owner: boolean }[] = [];
    const original = w.site.fetch;
    w.site.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      try {
        const payload = (JSON.parse(String(init?.body ?? "{}")) as { payload?: { wallet?: string; action?: string } }).payload;
        if (payload?.action === "clients.me" && payload.wallet === leave.wallet) times.push({ t: w.clock.t, owner: false });
        if (payload?.wallet === w.admin!.address) times.push({ t: w.clock.t, owner: true });
      } catch {
        // multipart uploads
      }
      return original(input, init);
    }) as typeof fetch;
    (w.ctx.http as unknown as { deps: { fetch: typeof fetch } }).deps.fetch = w.site.fetch;
    await runFor(w, 90);
    const ownerTimes = times.filter((x) => x.owner).map((x) => x.t);
    const done = ownerTimes[ownerTimes.length - 1];
    const polls = times.filter((x) => !x.owner).map((x) => x.t);
    // The first poll while the actor works starts the 10-min cadence; once it is done, 2 min again.
    const first = polls.findIndex((t) => t >= ownerTimes[0] && t <= done);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(polls[first + 1] - polls[first]).toBeGreaterThanOrEqual(MANUAL_POLL_MS);
    const after = polls.filter((t) => t > polls[first + 1]);
    expect(after.length).toBeGreaterThan(3);
    expect(after[1] - after[0]).toBeLessThan(MANUAL_POLL_MS);
    expect(ownerLines(w, "u037")).toEqual([]);
  });
});
