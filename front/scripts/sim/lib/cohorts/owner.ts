/**
 * The owner actor (SIM_OWNER=1, docs/mainnet-readiness/sim/design-owner-actor.md):
 * the admin decisions owner-queue.txt asks the owner for, made by the CLI
 * Admin CekAgg… through exactly the signed admin routes and the on-chain
 * instruction the admin UI uses, in the UI's order — its refresh reads
 * included, which double as the re-read before every decision — and only as
 * each user's plan says:
 *
 *   KYC / KYB dossier  /admin/clients/<id>: clients.adminDetail → clients.doc-url
 *                      → clients.review-requirement per document (the detail
 *                      read after each) → clients.status / clients.kybDecision
 *                      → clients.adminDetail → admin.badges
 *   reject             the verdict first (a hand-back mid-chain then cannot
 *                      trigger PLEASE REJECT replacements), then each document
 *   more_info          the passport rejected, or one more document requested
 *                      (clients.request-docs); the replacement is approved
 *                      only once the user sent it — never on a timer
 *   application        /admin/applications: adminList → adminEvents →
 *                      applications.review → /api/audit → adminList → adminEvents
 *   OTC escrow         /admin/otc: otc.list → payment mint → otc.adminScreen →
 *                      buyer eligibility → the class's deals on chain → otc.list
 *                      → create_otc_deal (CekAgg) → the deal read → otc.list →
 *                      otc.adminUpdate created → /api/audit → otc.list
 *   passport triage    /admin/kyc: passport.list → passport.update in_review
 *
 * CekAgg is an Admin, not the super admin and not the KYC provider: passports
 * (approve_holder) and verify_issuer_kyb become owner-queue lines instead.
 *
 * It runs in the target user's own scheduler slot (first in MACHINES), one
 * request or transaction per call and one task at a time (the focus lane: the
 * scheduler picks the focus user first). Users queued for it pause their
 * polls; users that only wait for a manual decision poll every 10 min while
 * it works. Every request and check is journalled as user "owner" with the
 * user as `target`, so a broken admin flow is a report finding. Edge,
 * transfer and "leave" users are never named in any request.
 */
import { createHash } from "node:crypto";
import type { Address, KeyPairSigner } from "@solana/kit";
import { clientReviewReasons, type AdminBadgeHref } from "@/lib/admin-badge-rules";
import { KYC_DOC_KINDS } from "@/lib/clients";
import { OtcDealStatus } from "@/lib/generated/asset_registry";
import { newDealId, resolveDealExpiry, type OtcDealRequestFields } from "@/lib/otc-deal";
import { ChainAbortError, ChainGateError, ChainRpcError } from "@/scripts/chain/lib/safety";
import { SimRetryLater, SimTxError, type OwnerChainView } from "../chain";
import { CLI_ADMIN, DEVNET_PLATFORM_KYC_REGISTRY, LAMPORTS_PER_SOL, PACE, SITE_ORIGIN } from "../constants";
import { simDocument } from "../docs";
import type { Actor, HttpResult } from "../http";
import { buildRoster, hasDossier, person, simLegalId, type UserPlan } from "../identity";
import type { JournalEntry, Outcome } from "../journal";
import { SimGateError, SimStopError, type OwnerOptions } from "../safety";
import type { OwnerApp, OwnerDossier, OwnerOtc, OwnerRecord, SimState, UserState } from "../state";
import { CONSISTENCY_MS, MAX_ATTEMPTS, RETRY_MS, transientStatus, type SimCtx } from "./common";
import { DEAL_PRICE, DEAL_UNITS } from "./trader";

export const OWNER_LABEL = "owner";
/** Below this the CLI Admin opens no escrow (the deal's rent): the two OTC tasks are handed back. */
export const MIN_ESCROW_LAMPORTS = LAMPORTS_PER_SOL / BigInt(20);
/** While the actor works, users that only wait for a manual decision poll this often (design critique S3). */
export const MANUAL_POLL_MS = 5 * PACE.watchIntervalMs;

/**
 * Every write the actor may send, with the values it may send (a unit test
 * pins it). `passport.update` never carries `approved`: that would release an
 * investor without an on-chain passport (gap G1).
 */
export const OWNER_ACTIONS: Readonly<Record<string, readonly string[]>> = {
  "clients.review-requirement": ["approved", "rejected"],
  "clients.status": ["verified", "rejected"],
  "clients.kybDecision": ["verified", "rejected"],
  "clients.request-docs": ["source_of_funds", "bank_statement"],
  "applications.review": ["approved", "rejected", "needs_changes"],
  "otc.adminUpdate": ["created"],
  "create_otc_deal": ["open"],
  "passport.update": ["in_review", "rejected"],
};

// ── The decision table (design §3 with critique M4) ────────────────────────

export type DossierVerdict = "approve" | "reject" | "more_info";

function planKind(plan: Pick<UserPlan, "variant">): "kyc" | "kyb" {
  return plan.variant.startsWith("company") ? "kyb" : "kyc";
}

/**
 * The hard deny: edge and transfer users, and dossiers the plan leaves
 * untouched, are never named in a request, whatever else says so.
 */
export function ownerDenied(plan: UserPlan): boolean {
  return plan.cohort === "E" || plan.cohort === "X" || (hasDossier(plan) && (plan.review === "leave" || plan.review === "none"));
}

/** The dossier verdict of the plan (UserPlan.review), or null: the actor then never touches that dossier. */
export function dossierVerdict(plan: UserPlan): DossierVerdict | null {
  if (ownerDenied(plan) || plan.cohort === "T" || !hasDossier(plan)) return null;
  return plan.review === "approve" || plan.review === "reject" || plan.review === "more_info" ? plan.review : null;
}

const ROSTER = buildRoster();
const MORE_INFO = ROSTER.filter((p) => dossierVerdict(p) === "more_info").map((p) => p.label);
/** The one application SIM_OWNER_APP_REJECT=1 rejects (open question Q1): the last plain company approved (u090). */
export const APP_REJECT_LABEL = [...ROSTER].reverse().find((p) => p.cohort === "B" && p.variant === "company" && p.review === "approve")?.label ?? null;

/** more_info users alternate by n: even index rejects the passport, odd index requests one more document. */
export function morePick(plan: UserPlan): "reject-doc" | "request-doc" | null {
  const i = MORE_INFO.indexOf(plan.label);
  return i < 0 ? null : i % 2 === 0 ? "reject-doc" : "request-doc";
}

/** The extra document of a request-doc round, with the admin page's label (lib/clients.ts KYC_DOC_KINDS). */
export function requestKind(plan: UserPlan): { doc_kind: string; label: string } {
  const kind = planKind(plan) === "kyb" ? "bank_statement" : "source_of_funds";
  return { doc_kind: kind, label: KYC_DOC_KINDS.find((k) => k.kind === kind)!.label };
}

/**
 * The planned application decision: a needs_changes round first for the
 * needs-changes companies, then approve (or, with SIM_OWNER_APP_REJECT=1,
 * reject the one planned rejection). Null for anyone else — an application of
 * a user whose dossier the plan does not verify is handed back, never approved.
 */
export function appPlan(plan: UserPlan, options: Pick<OwnerOptions, "appReject">): { first: "needs_changes" | null; final: "approved" | "rejected" } | null {
  if (plan.cohort !== "B" || (plan.review !== "approve" && plan.review !== "more_info")) return null;
  return {
    first: plan.variant === "company-needs-changes" ? "needs_changes" : null,
    final: options.appReject && plan.label === APP_REJECT_LABEL ? "rejected" : "approved",
  };
}

/** The pair's escrow requester (pair 3: the seller, pair 4: the buyer; trader.ts dealRole). */
export function otcRequester(plan: UserPlan): boolean {
  return plan.cohort === "T" && ((plan.pair === 3 && plan.variant === "maker") || (plan.pair === 4 && plan.variant === "taker"));
}

/** Buyers whose verified dossier leads to a passport: the actor marks the request in review, the KYC provider issues it. */
export function passportTriage(plan: UserPlan): boolean {
  return plan.variant === "buyer-kyc" && (plan.review === "approve" || plan.review === "more_info");
}

/** SIM_OWNER_PASSPORT_REJECT=1 (open question Q3): a rejected KYC dossier's open passport request is rejected too. */
export function passportRejectPlanned(plan: UserPlan, options: Pick<OwnerOptions, "passportReject">): boolean {
  return options.passportReject && dossierVerdict(plan) === "reject" && planKind(plan) === "kyc";
}

const VERDICT_ORDER: Record<DossierVerdict, number> = { approve: 0, more_info: 1, reject: 2 };
const byVerdict = (kind: "kyc" | "kyb") =>
  ROSTER.filter((p) => dossierVerdict(p) !== null && planKind(p) === kind)
    .sort((a, b) => VERDICT_ORDER[dossierVerdict(a)!] - VERDICT_ORDER[dossierVerdict(b)!] || a.n - b.n)
    .map((p) => p.label);
const KYB_ORDER = byVerdict("kyb");
const KYC_ORDER = byVerdict("kyc");

/**
 * Task order (critique M5, S3): KYB and KYC dossiers interleaved, approvals
 * first — so a SIM_OWNER_MAX=3 gate decides a KYB and a KYC dossier — then
 * applications, the escrows, and passport triage last.
 */
export function taskRank(plan: UserPlan, kind: TaskKind): number {
  if (kind === "dossier") {
    const kyb = KYB_ORDER.indexOf(plan.label);
    return kyb >= 0 ? 2 * kyb : 2 * KYC_ORDER.indexOf(plan.label) + 1;
  }
  return { app: 1_000, otc: 2_000, passport: 3_000 }[kind] + plan.n;
}

// ── The actor's context ──────────────────────────────────────────────────────

export type TaskKind = "dossier" | "app" | "otc" | "passport";

type Req = { id: number; doc_kind: string; label?: string | null; status: string; document_id: number | null; requested_by: string | null };
type Detail = {
  client: { id: string; wallet: string | null; email: string | null; kyc_status: string; kyc_verified_at: string | null; kyc_expires_at: string | null };
  requirements: Req[];
  documents: { id: number; kind: string; sha256: string | null }[];
  verification: { kind: string; status: string }[];
};
type AppRow = { id: string; status: string; applicant_wallet?: string; company_name?: string };
type AppEvent = { actor?: string; action?: string; created_at?: string };
type OtcRow = OtcDealRequestFields & { id: string; status: string; deal_pda: string | null; asset_label?: string | null; expires_at: string | null };
type PassportRow = { id: string; wallet: string; status: string; created_at?: string };

type Expectation =
  | { kind: "review"; reqId: number; status: string }
  | { kind: "status"; value: string }
  | { kind: "kyb"; value: string }
  | { kind: "request"; doc_kind: string };

/** One task's in-memory progress. It is dropped whenever the focus moves or the process restarts: the next step re-reads. */
type Session = {
  label: string;
  kind: TaskKind;
  detail?: Detail;
  fresh?: boolean;
  viewed?: boolean;
  checked?: boolean;
  post?: boolean;
  expect?: Expectation;
  /** /admin/clients counted this dossier just before its verdict (C-O11). */
  countedBefore?: boolean;
  drops?: Partial<Record<AdminBadgeHref, number>>;
  badgesDone?: boolean;
  /** The act planned from the last fresh read. */
  next?: DossierAct;
  /** more_info reject-doc, pass 1: the requirement this round rejects (never approved before it). */
  rejectTarget?: number;
  passportStep?: "list" | "update" | "audit" | "relist";
  passportRow?: PassportRow;
  app?: { row?: AppRow; events?: AppEvent[]; decision?: string };
  otc?: { row?: OtcRow; offset: number };
  triage?: { step: "list" | "update" | "relist"; row?: PassportRow };
};

export type OwnerCtx = {
  admin: KeyPairSigner;
  options: OwnerOptions;
  /** The user whose task the actor works now; the scheduler runs it first. */
  focus: string | null;
  /** SimRetryLater (e.g. an unresolved deal signature): the focus waits until then. */
  focusNotBefore: number;
  /** Set once the actor takes no more tasks (SIM_OWNER_MAX, a 403, a failed preflight). */
  stopped: string | null;
  /** Start-up reads (Platform.admin, the pinned registry's authority, the admin's SOL). */
  view: (OwnerChainView & { registry: string }) | null;
  /** The last admin.badges counts and the user requests since that could add to them (C-O11). */
  badges: { counts: Partial<Record<AdminBadgeHref, number | null>>; activity: Partial<Record<AdminBadgeHref, number>> } | null;
  session: Session | null;
  manualPolls: Map<string, number>;
  /** The users this command schedules (the runner's scope); a task of anyone else is never taken. */
  scope?: ReadonlySet<string>;
};

export function createOwnerCtx(admin: KeyPairSigner, options: OwnerOptions): OwnerCtx {
  return { admin, options, focus: null, focusNotBefore: 0, stopped: null, view: null, badges: null, session: null, manualPolls: new Map() };
}

/** The user the scheduler should advance first (the focus lane), or null. */
export function ownerFocus(ctx: SimCtx, now: number): string | null {
  const o = ctx.owner;
  return o && o.focus && !o.stopped && o.focusNotBefore <= now ? o.focus : null;
}

/** User requests whose success can add a row to an admin queue (the C-O11 upper bound). */
const QUEUE_ROUTES: Record<string, AdminBadgeHref[]> = {
  "POST /api/clients/upload": ["/admin/clients"],
  "POST /api/verification/submit": ["/admin/clients", "/admin/kyc"],
  "POST /api/applications/submit": ["/admin/applications"],
  "POST /api/applications/resubmit": ["/admin/applications"],
  "POST /api/otc/create": ["/admin/otc"],
};

/** Journal tee: counts the users' requests that may grow an admin queue since the last admin.badges read. */
export function observeOwnerActivity(o: OwnerCtx | undefined, entry: Omit<JournalEntry, "ts">): void {
  if (!o?.badges || entry.kind !== "http" || entry.user === OWNER_LABEL || !entry.route) return;
  for (const href of QUEUE_ROUTES[entry.route] ?? []) o.badges.activity[href] = (o.badges.activity[href] ?? 0) + 1;
}

// ── Journal helpers ──────────────────────────────────────────────────────────

function ownerActor(o: OwnerCtx, u: UserState | null): Actor {
  return { label: OWNER_LABEL, cohort: "owner", wave: u?.plan.wave ?? null, signer: o.admin, ...(u ? { target: u.plan.label } : {}) };
}

function reason(ctx: SimCtx, text: string): string {
  return `SIM owner actor (run ${ctx.runId}): ${text}`;
}

/** A C-O check (design §9): journalled as the owner, about `u`. */
export function ownerCheck(ctx: SimCtx, u: UserState, id: string, ok: boolean, detail: string, outcome: Outcome = "consistency"): void {
  ctx.journal.append({
    wave: u.plan.wave,
    user: OWNER_LABEL,
    cohort: "owner",
    target: u.plan.label,
    step: `owner.${id}`,
    kind: "check",
    outcome: ok ? "ok" : outcome,
    err: ok || outcome === "info" ? undefined : `${id}: ${detail}`,
    body: ok || outcome === "info" ? `${id}: ${detail}` : undefined,
  });
}

function ownerNote(ctx: SimCtx, u: UserState | null, step: string, body: string): void {
  ctx.journal.append({ wave: u?.plan.wave ?? null, user: OWNER_LABEL, cohort: "owner", ...(u ? { target: u.plan.label } : {}), step: `owner.${step}`, kind: "note", outcome: "info", body });
}

function logDecision(ctx: SimCtx, r: OwnerRecord, text: string): void {
  (r.log ??= []).push(`${new Date(ctx.now()).toISOString().slice(0, 19)}Z ${text}`);
  if (r.log.length > 30) r.log.splice(0, r.log.length - 30);
}

// ── Control flow of one owner step ───────────────────────────────────────────

/** The step ends: the task goes back to the owner (owner-queue.txt). */
class OwnerHandBack extends Error {}
/** A transient failure (no response, 429, 5xx, an RPC read): back off, release the focus, hand back after 3. */
class OwnerTransient extends Error {}
/** The actor stops taking tasks (a 403: the CLI Admin is no Admin). */
class OwnerStop extends Error {}
/** The actor was about to send a write its plan forbids: a bug, never sent. */
class OwnerGuardError extends Error {}

/** Fails the step unless the request answered 2xx (the journal line already holds the finding). */
function expectOk(r: HttpResult, what: string): void {
  if (r.outcome === "ok") return;
  const message = r.json?.error ?? r.json?.message ?? "";
  if (r.status === 403) throw new OwnerStop(`${what} answered 403${message ? ` (${message})` : ""}: the CLI Admin is not an Admin on devnet ${SITE_ORIGIN}`);
  if (transientStatus(r.status)) throw new OwnerTransient(`${what} ${r.status || "no response"}`);
  throw new OwnerHandBack(`${what} answered ${r.status}${message ? `: ${message}` : ""}`);
}

/** The per-write guard (M4): per-document approvals and final verdicts are asserted separately. */
function guardWrite(u: UserState, action: string, value: string, allowed: boolean): void {
  if (!(OWNER_ACTIONS[action] ?? []).includes(value) || ownerDenied(u.plan) || !allowed) {
    throw new OwnerGuardError(`refused to send ${action} ${value} for ${u.plan.label} (${u.plan.cohort}/${u.plan.variant}, review ${u.plan.review}): not in its plan`);
  }
}

async function adminRead<T>(ctx: SimCtx, o: OwnerCtx, u: UserState, action: string, route: string, params: Record<string, unknown>): Promise<T> {
  const r = await ctx.http.read<T>(ownerActor(o, u), { step: `owner.${action}`, route, action, params });
  expectOk(r, action);
  return r.data as T;
}

async function adminWrite<T>(ctx: SimCtx, o: OwnerCtx, u: UserState, action: string, route: string, params: Record<string, unknown>): Promise<T> {
  const r = await ctx.http.signed<T>(ownerActor(o, u), { step: `owner.${action}`, route, action, params });
  expectOk(r, action);
  return r.data as T;
}

/** The UI's recordAudit: an unsigned breadcrumb that never fails the action (a failure is still a journal finding). */
async function auditPost(ctx: SimCtx, o: OwnerCtx, u: UserState, body: Record<string, unknown>): Promise<void> {
  await ctx.http.post(ownerActor(o, u), {
    step: "owner.audit",
    route: "/api/audit",
    body: { actor_wallet: o.admin.address, target_label: null, tx_signature: null, status: "success", metadata: {}, ...body },
    classes: ["write"],
  });
}

function record(u: UserState): OwnerRecord {
  return (u.data.owner ??= { attempts: 0 });
}

function session(o: OwnerCtx, u: UserState, kind: TaskKind): Session {
  if (!o.session || o.session.label !== u.plan.label || o.session.kind !== kind) o.session = { label: u.plan.label, kind };
  return o.session;
}

/** The user's uploads as it recorded them: an await-user task is actionable again once this changes. */
export function uploadSignature(u: UserState): string {
  const reqs = (u.data.requirements ?? []).map((r) => `${r.id}:${r.uploadedRound}`).sort();
  return `${u.data.round ?? 0}|${reqs.join(",")}`;
}

/** The user's actionable owner task now, or null (not planned, not reached, waiting on the user, decided). */
export function currentTask(ctx: SimCtx, o: OwnerCtx, u: UserState): { kind: TaskKind; rank: number } | null {
  const plan = u.plan;
  const r = u.data.owner;
  if (u.terminal || o.stopped || ownerDenied(plan) || r?.handedBack) return null;
  if ((o.options.only && !o.options.only.includes(plan.label)) || (o.scope && !o.scope.has(plan.label))) return null;
  if (r?.retryAt && r.retryAt > ctx.now()) return null;
  const task = (kind: TaskKind) => ({ kind, rank: taskRank(plan, kind) });
  switch (u.stage) {
    case "await.dossier": {
      if (!dossierVerdict(plan) || !u.data.clientId) return null;
      const d = r?.dossier;
      if (!d || d.phase === "open" || (d.phase === "await-user" && d.awaitSig !== uploadSignature(u))) return task("dossier");
      return null;
    }
    case "await.app": {
      if (!u.data.applicationId || !appPlan(plan, o.options)) return null;
      const a = r?.app;
      if (!a || a.phase === "open" || (a.phase === "await-user" && (u.data.resubmits ?? 0) > (a.awaitResubmits ?? 0))) return task("app");
      return null;
    }
    case "await.deal": {
      if (!otcRequester(plan) || !u.data.dealRequestId) return null;
      return !r?.otc || r.otc.phase === "open" ? task("otc") : null;
    }
    case "await.passport": {
      if (!passportTriage(plan)) return null;
      return !r?.passport || r.passport.phase === "open" ? task("passport") : null;
    }
    default:
      return null;
  }
}

/** A task the actor started and has not finished (its user must keep its normal polls). */
function hasActorWork(u: UserState): boolean {
  const r = u.data.owner;
  if (!r || r.handedBack) return false;
  const live = (t: { phase: string; lagChecked?: boolean } | undefined) =>
    Boolean(t && (t.phase === "open" || t.phase === "await-user" || (t.phase === "decided" && !t.lagChecked)));
  return live(r.dossier) || live(r.app) || r.otc?.phase === "open";
}

function actorBusy(ctx: SimCtx, o: OwnerCtx): boolean {
  if (o.stopped) return false;
  return Object.values(ctx.state.users).some((x) => !x.terminal && (hasActorWork(x) || currentTask(ctx, o, x) !== null));
}

/** The next task to work: the lowest rank among actionable tasks (null when none, or once SIM_OWNER_MAX is reached). */
function chooseFocus(ctx: SimCtx, o: OwnerCtx): string | null {
  let best: { label: string; rank: number } | null = null;
  for (const x of Object.values(ctx.state.users)) {
    const t = currentTask(ctx, o, x);
    if (t && (!best || t.rank < best.rank)) best = { label: x.plan.label, rank: t.rank };
  }
  if (!best) return null;
  const made = ctx.state.owner?.decisions ?? 0;
  if (o.options.max !== null && made >= o.options.max) {
    stopActor(ctx, o, `SIM_OWNER_MAX=${o.options.max} reached (${made} decisions made by the owner actor in this run); every user polls as before`);
    return null;
  }
  return best.label;
}

function stopActor(ctx: SimCtx, o: OwnerCtx, why: string): void {
  if (o.stopped) return;
  o.stopped = why;
  o.focus = null;
  o.session = null;
  ownerNote(ctx, null, "stopped", why);
  ctx.log(`owner actor: ${why}`);
}

/** The focus task is over (or waits): the user's own poll runs next, and the next task takes the lane. */
function release(ctx: SimCtx, o: OwnerCtx, u: UserState): void {
  if (o.focus === u.plan.label) {
    o.focus = null;
    o.session = null;
    o.focusNotBefore = 0;
  }
  u.notBefore = ctx.now();
  o.focus = chooseFocus(ctx, o);
}

function countDecision(ctx: SimCtx): void {
  ctx.state.owner ??= { decisions: 0 };
  ctx.state.owner.decisions += 1;
}

function taskName(kind: TaskKind, u: UserState): string {
  if (kind === "dossier") return `${planKind(u.plan).toUpperCase()} dossier ${SITE_ORIGIN}/admin/clients/${u.data.clientId ?? "?"}`;
  if (kind === "app") return `application ${u.data.applicationId ?? "?"} in ${SITE_ORIGIN}/admin/applications`;
  if (kind === "otc") return `OTC escrow request ${u.data.dealRequestId ?? "?"} in ${SITE_ORIGIN}/admin/otc`;
  return `passport request of ${u.wallet} in ${SITE_ORIGIN}/admin/kyc`;
}

function handBack(ctx: SimCtx, o: OwnerCtx, u: UserState, kind: TaskKind, why: string): void {
  const r = record(u);
  r.handedBack = { task: taskName(kind, u), reason: why.slice(0, 400), at: new Date(ctx.now()).toISOString(), attempts: r.attempts };
  const sub = kind === "dossier" ? r.dossier : kind === "app" ? r.app : kind === "otc" ? r.otc : r.passport;
  if (sub) sub.phase = "handed-back";
  ownerNote(ctx, u, "handed-back", `${taskName(kind, u)}: ${why}`);
  release(ctx, o, u);
}

function elsewhere(ctx: SimCtx, o: OwnerCtx, u: UserState, sub: { phase: string }, why: string, againstPlan: boolean): void {
  sub.phase = "elsewhere";
  logDecision(ctx, record(u), `decided elsewhere: ${why}`);
  ownerNote(ctx, u, "elsewhere", `${why}${againstPlan ? " (against the plan)" : ""}`);
  release(ctx, o, u);
}

/** A transient failure: back off (RETRY_MS × attempts) and let another task have the lane; hand back after MAX_ATTEMPTS. */
function failAttempt(ctx: SimCtx, o: OwnerCtx, u: UserState, kind: TaskKind, why: string): void {
  const r = record(u);
  r.attempts += 1;
  if (r.attempts >= MAX_ATTEMPTS) return handBack(ctx, o, u, kind, `${why} (after ${r.attempts} attempts)`);
  r.retryAt = ctx.now() + RETRY_MS * r.attempts;
  release(ctx, o, u);
}

/** Journal-only lag checks (C-O6): the user's own view shows a decision within CONSISTENCY_MS. Never claims the slot. */
function lagChecks(ctx: SimCtx, u: UserState): void {
  const r = u.data.owner;
  const now = ctx.now();
  for (const [name, t] of [["dossier", r?.dossier], ["application", r?.app]] as const) {
    if (!t || t.phase !== "decided" || t.lagChecked || !t.decidedAt || !t.decidedStage) continue;
    const age = now - Date.parse(t.decidedAt);
    if (u.stage !== t.decidedStage) {
      t.lagChecked = true;
      ownerCheck(ctx, u, "C-O6", true, `the user saw the ${name} decision (now ${u.stage})`);
    } else if (age > CONSISTENCY_MS) {
      t.lagChecked = true;
      ownerCheck(ctx, u, "C-O6", false, `${u.plan.label} still sits in ${u.stage} ${Math.round(age / 1000)} s after the ${name} decision (${t.decision ?? "decided"})`);
    }
  }
  if (u.plan.cohort !== "T" || r?.otcLagChecked) return;
  const requester = otcRequester(u.plan) ? u : Object.values(ctx.state.users).find((x) => x.plan.pair === u.plan.pair && x !== u && x.plan.cohort === "T");
  const flipped = requester?.data.owner?.otc?.flippedAt;
  if (!flipped) return;
  const age = now - Date.parse(flipped);
  if (u.stage !== "await.deal") {
    record(u).otcLagChecked = true;
    ownerCheck(ctx, u, "C-O6", true, `the party saw the opened escrow (now ${u.stage})`);
  } else if (age > CONSISTENCY_MS) {
    record(u).otcLagChecked = true;
    ownerCheck(ctx, u, "C-O6", false, `${u.plan.label}'s otc.list mine still shows no created deal ${Math.round(age / 1000)} s after the flip`);
  }
}

const THROTTLE_STAGES = new Set(["await.passport", "await.dossier", "await.app", "await.market"]);

/** S3: a user that only waits for a manual decision polls every MANUAL_POLL_MS while the actor still has work. */
function throttleManual(ctx: SimCtx, o: OwnerCtx, u: UserState): boolean {
  if (!u.awaitingOwner || !THROTTLE_STAGES.has(u.stage) || hasActorWork(u) || !actorBusy(ctx, o)) return false;
  const now = ctx.now();
  const last = o.manualPolls.get(u.plan.label);
  if (last === undefined || now - last >= MANUAL_POLL_MS) {
    o.manualPolls.set(u.plan.label, now);
    return false;
  }
  u.notBefore = Math.max(u.notBefore, last + MANUAL_POLL_MS);
  return true;
}

/** An application of a user the plan does not approve (e.g. a dossier verified by hand): handed back once, no request. */
function handBackUnplanned(ctx: SimCtx, o: OwnerCtx, u: UserState): boolean {
  if (o.stopped || u.stage !== "await.app" || !u.data.applicationId || u.data.owner?.app || appPlan(u.plan, o.options)) return false;
  if (o.options.only && !o.options.only.includes(u.plan.label)) return false;
  const r = record(u);
  r.app = { phase: "handed-back", rounds: [] };
  r.handedBack = { task: taskName("app", u), reason: `not in the plan (review ${u.plan.review}): decide it by hand`, at: new Date(ctx.now()).toISOString(), attempts: 0 };
  ownerNote(ctx, u, "handed-back", `${taskName("app", u)}: the plan does not approve this applicant (review ${u.plan.review})`);
  return true;
}

/**
 * First in MACHINES. Returns true when this call belonged to the owner actor
 * (a request, a transaction, or a paused poll) and false when the user's own
 * machine should run.
 */
export async function ownerStep(ctx: SimCtx, u: UserState): Promise<boolean> {
  const o = ctx.owner;
  if (!o || u.plan.cohort === "E" || u.plan.cohort === "X") return false;
  // A dossier the plan leaves untouched: never a request; its polls only slow down while the actor works.
  if (ownerDenied(u.plan)) return throttleManual(ctx, o, u);
  lagChecks(ctx, u);
  if (handBackUnplanned(ctx, o, u)) return false;
  if (o.focus) {
    const f = ctx.state.users[o.focus];
    if (!f || f.terminal || !currentTask(ctx, o, f)) {
      o.focus = null;
      o.session = null;
    }
  }
  const task = currentTask(ctx, o, u);
  if (!task) return throttleManual(ctx, o, u);
  if (!o.focus) o.focus = chooseFocus(ctx, o);
  if (o.stopped || !o.focus) return false;
  if (o.focus !== u.plan.label) {
    // Queued: its poll pauses (the actor knows when it acts); the focus user runs first.
    u.notBefore = ctx.now() + PACE.watchIntervalMs;
    return true;
  }
  await work(ctx, o, u, task.kind);
  return true;
}

async function work(ctx: SimCtx, o: OwnerCtx, u: UserState, kind: TaskKind): Promise<void> {
  try {
    if (kind === "dossier") await dossierWork(ctx, o, u);
    else if (kind === "app") await appWork(ctx, o, u);
    else if (kind === "otc") await otcWork(ctx, o, u);
    else await passportWork(ctx, o, u);
  } catch (error) {
    if (error instanceof SimStopError || error instanceof ChainAbortError) throw error;
    if (error instanceof SimRetryLater) {
      o.focusNotBefore = ctx.now() + 60_000;
      return;
    }
    if (error instanceof OwnerStop) return stopActor(ctx, o, error.message);
    if (error instanceof OwnerHandBack) return handBack(ctx, o, u, kind, error.message);
    if (error instanceof OwnerTransient) return failAttempt(ctx, o, u, kind, error.message);
    const message = error instanceof ChainGateError || error instanceof Error ? error.message : "unexpected error";
    if (error instanceof OwnerGuardError) {
      ctx.journal.append({ wave: u.plan.wave, user: OWNER_LABEL, cohort: "owner", target: u.plan.label, step: "owner.guard", kind: "check", outcome: "consistency", err: message });
      return handBack(ctx, o, u, kind, message);
    }
    if (!(error instanceof SimTxError)) {
      // A builder or RPC refusal; an RPC read that failed before anything was signed is infrastructure until the last attempt.
      const transient = error instanceof ChainRpcError && record(u).attempts + 1 < MAX_ATTEMPTS;
      ctx.journal.append({ wave: u.plan.wave, user: OWNER_LABEL, cohort: "owner", target: u.plan.label, step: `owner.${kind}`, kind: "note", outcome: transient ? "info" : "tx-error", err: message.slice(0, 500) });
    }
    failAttempt(ctx, o, u, kind, message.slice(0, 200));
  }
}

// ── Dossiers (UI: app/admin/clients/[id]/page.tsx) ───────────────────────────

function newDossier(plan: UserPlan): OwnerDossier {
  const verdict = dossierVerdict(plan)!;
  return { verdict, phase: "open", ...(verdict === "more_info" ? { pick: morePick(plan) ?? "reject-doc" } : {}) };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** C-O1 (every read), C-O2 and C-O3 (once per focus). */
function dossierGuards(ctx: SimCtx, u: UserState, s: Session, D: Detail): void {
  const email = person(ctx.runId, u.plan.n).email;
  if (D.client.wallet !== u.wallet || D.client.email !== email) {
    ownerCheck(ctx, u, "C-O1", false, `dossier ${D.client.id} names wallet ${D.client.wallet ?? "-"} / ${D.client.email ?? "-"}, not ${u.wallet} / ${email}`);
    throw new OwnerHandBack(`dossier ${D.client.id} does not belong to ${u.plan.label}`);
  }
  if (s.checked) return;
  s.checked = true;
  // C-O2: what the user believes it uploaded equals the admin view (ids, kinds, uploaded ⇔ a file is on the row).
  const known = new Map((u.data.requirements ?? []).map((r) => [r.id, r]));
  const mismatches: string[] = [];
  for (const r of known.values()) {
    const row = D.requirements.find((x) => x.id === r.id);
    if (!row) mismatches.push(`#${r.id} ${r.kind} is missing`);
    else if (row.doc_kind !== r.kind) mismatches.push(`#${r.id} is ${row.doc_kind}, the user has ${r.kind}`);
    else if ((r.uploadedRound >= 1) !== (row.status === "submitted" || row.status === "approved" || row.status === "rejected")) {
      mismatches.push(`#${r.id} ${r.kind} is ${row.status} but the user uploaded round ${r.uploadedRound}`);
    }
  }
  for (const row of D.requirements) {
    if (!known.has(row.id) && row.status !== "requested") mismatches.push(`#${row.id} ${row.doc_kind} (${row.status}) is unknown to the user`);
  }
  ownerCheck(ctx, u, "C-O2", mismatches.length === 0, mismatches.length ? mismatches.join("; ") : `${D.requirements.length} requirements agree`);
  // C-O3: each linked document's sha256 is the simulator's own file (PLEASE REJECT where planned).
  const reject = u.plan.review === "reject";
  const bad: string[] = [];
  for (const row of D.requirements) {
    const doc = row.document_id === null ? undefined : D.documents.find((x) => x.id === row.document_id);
    const mine = known.get(row.id);
    if (!doc?.sha256 || !mine || mine.uploadedRound < 1) continue;
    const spec = (round: number, stamp: boolean) => sha256(simDocument({ runId: ctx.runId, n: u.plan.n, kind: row.doc_kind, round, reject: stamp }).bytes);
    if (doc.sha256 === spec(mine.uploadedRound, reject)) continue;
    const other = [1, 2, 3, 4].find((round) => doc.sha256 === spec(round, reject));
    if (other !== undefined) ownerNote(ctx, u, "C-O3", `#${row.id} ${row.doc_kind} holds round ${other}, the user recorded round ${mine.uploadedRound}`);
    else bad.push(`#${row.id} ${row.doc_kind} (document ${doc.id}) is not the simulator's round-${mine.uploadedRound} file${[1, 2, 3].some((round) => doc.sha256 === spec(round, !reject)) ? ` (the PLEASE REJECT stamp is ${reject ? "missing" : "present"})` : ""}`);
  }
  ownerCheck(ctx, u, "C-O3", bad.length === 0, bad.length ? bad.join("; ") : "every linked document is the simulator's file");
}

/** C-O4: the refresh read after a write shows it applied. */
function checkExpectation(ctx: SimCtx, u: UserState, s: Session, D: Detail, admin: string): void {
  const e = s.expect;
  if (!e) return;
  s.expect = undefined;
  if (e.kind === "review") {
    const row = D.requirements.find((r) => r.id === e.reqId);
    ownerCheck(ctx, u, "C-O4", row?.status === e.status, `requirement #${e.reqId} shows ${row?.status ?? "nothing"} after review-requirement ${e.status}`);
  } else if (e.kind === "status") {
    const c = D.client;
    const stamped = e.value !== "verified" || Boolean(c.kyc_verified_at && c.kyc_expires_at);
    ownerCheck(ctx, u, "C-O4", c.kyc_status === e.value && stamped, `kyc_status ${c.kyc_status}${e.value === "verified" ? `, kyc_verified_at ${c.kyc_verified_at ?? "-"}, kyc_expires_at ${c.kyc_expires_at ?? "-"}` : ""} after clients.status ${e.value}`);
  } else if (e.kind === "kyb") {
    const kyb = D.verification.find((v) => v.kind === "kyb");
    ownerCheck(ctx, u, "C-O4", kyb?.status === e.value, `the KYB row shows ${kyb?.status ?? "nothing"} after clients.kybDecision ${e.value}`);
  } else {
    const row = D.requirements.find((r) => r.doc_kind === e.doc_kind && r.status === "requested");
    const ok = Boolean(row && row.requested_by === admin) && D.client.kyc_status === "more_info";
    ownerCheck(ctx, u, "C-O4", ok, `after request-docs ${e.doc_kind}: ${row ? `row #${row.id} requested_by ${row.requested_by}` : "no requested row"}, kyc_status ${D.client.kyc_status}`);
  }
}

function linkedDoc(rows: Req[]): number | null {
  return rows.find((r) => r.document_id !== null)?.document_id ?? null;
}

async function dossierWork(ctx: SimCtx, o: OwnerCtx, u: UserState): Promise<void> {
  const r = record(u);
  const d = (r.dossier ??= newDossier(u.plan));
  if (d.phase === "await-user") d.phase = "open";
  const s = session(o, u, "dossier");
  if (!s.detail || !s.fresh) {
    s.detail = await adminRead<Detail>(ctx, o, u, "clients.adminDetail", "/api/clients/admin-detail", { id: u.data.clientId });
    s.fresh = true;
    return planDossier(ctx, o, u, r, d, s, true);
  }
  await actDossier(ctx, o, u, r, d, s);
}

type DossierAct =
  | { op: "view"; docId: number }
  | { op: "review"; req: Req; status: "approved" | "rejected" }
  | { op: "final"; value: "verified" | "rejected" }
  | { op: "request" }
  | { op: "passport" }
  | { op: "badges" };

/**
 * What comes next from the fresh admin detail (no request here): the next
 * act, or the end of this focus (decided, elsewhere, waiting on the user,
 * handed back).
 */
function planDossier(ctx: SimCtx, o: OwnerCtx, u: UserState, r: OwnerRecord, d: OwnerDossier, s: Session, afterRead: boolean): void {
  const D = s.detail!;
  if (afterRead) {
    dossierGuards(ctx, u, s, D);
    checkExpectation(ctx, u, s, D, o.admin.address);
  }
  const act = nextDossierAct(ctx, o, u, r, d, s, D);
  if (act) s.next = act;
}

function nextDossierAct(ctx: SimCtx, o: OwnerCtx, u: UserState, r: OwnerRecord, d: OwnerDossier, s: Session, D: Detail): DossierAct | null {
  const kind = planKind(u.plan);
  const status = D.client.kyc_status;
  const kyb = D.verification.find((v) => v.kind === "kyb");
  if (kind === "kyb" && !kyb) {
    ownerCheck(ctx, u, "C-O1", false, `company dossier ${D.client.id} has no KYB (company details) row`);
    throw new OwnerHandBack("the company dossier has no KYB row");
  }
  const planned = d.verdict === "reject" ? "rejected" : "verified";
  // Writes of an earlier process that landed (the write-ahead intents).
  const intent = d.intent;
  if (intent?.op === "reject-doc" && !d.target) {
    const row = D.requirements.find((x) => x.id === intent.reqId);
    if (row && (row.status === "rejected" || row.document_id !== intent.docId)) d.target = { reqId: intent.reqId, docId: intent.docId ?? null };
  }
  if (intent?.op === "request-doc" && !d.target) {
    const row = D.requirements.find((x) => x.doc_kind === intent.kind && x.requested_by === o.admin.address);
    if (row) d.target = { kind: intent.kind, reqId: row.id };
  }
  if (d.target?.kind && !d.target.reqId) {
    const row = D.requirements.find((x) => x.doc_kind === d.target!.kind && x.requested_by === o.admin.address);
    if (row) d.target.reqId = row.id;
  }
  // The verdict is on the dossier.
  const final = kind === "kyc" ? (status === "verified" || status === "rejected" ? status : null) : kyb!.status === "verified" || kyb!.status === "rejected" ? kyb!.status : null;
  if (final) {
    // Ours: the verdict this actor saved before sending it (possibly in an earlier process).
    const ours = d.finalValue === final || (intent?.op === "final" && intent.value === final);
    if (!ours) {
      elsewhere(ctx, o, u, d, `${kind.toUpperCase()} is already ${final}${kind === "kyb" ? " (KYB)" : ""} on ${SITE_ORIGIN}/admin/clients/${D.client.id}`, final !== planned);
      if (kind === "kyb" && final === "verified") addKybLine(ctx, o, u);
      return null;
    }
    if (!d.finalDone) {
      d.finalDone = true;
      d.finalValue = final;
      d.decision = kind === "kyb" ? `KYB ${final}` : final;
      countDecision(ctx);
      logDecision(ctx, r, `${kind === "kyb" ? "KYB decision" : "dossier"} ${final}`);
      ownerNote(ctx, u, "decision", `${kind.toUpperCase()} ${final} as planned (review ${u.plan.review}${d.pick ? `, ${d.pick}` : ""})`);
    }
    if (d.verdict === "reject") {
      const submitted = D.requirements.find((x) => x.status === "submitted");
      if (submitted) return { op: "review", req: submitted, status: "rejected" };
      if (passportRejectPlanned(u.plan, o.options) && !d.passportDone) return { op: "passport" };
    }
    if (!s.post) {
      s.post = true;
      // C-O5 (once the chain is done): the dossier no longer waits for a reviewer on /admin/clients.
      const reasons = clientReviewReasons({ kyc_status: status, requirements: D.requirements, details: D.verification }, { includeKyb: true });
      const expected = kind === "kyb" && final === "verified" && reasons.length === 1 && reasons[0] === "final";
      ownerCheck(
        ctx,
        u,
        "C-O5",
        reasons.length === 0,
        reasons.length === 0
          ? "the dossier left the /admin/clients review queue"
          : expected
            ? "KYB verified, but the company dossier's KYC status stays pending, so /admin/clients counts it as a final review for good (expected until open question Q2 is decided)"
            : `the dossier still counts on /admin/clients (${reasons.join(", ")}) after the ${final} verdict`,
        expected ? "info" : "consistency",
      );
      s.drops = { ...s.drops, "/admin/clients": s.countedBefore && reasons.length === 0 ? 1 : 0 };
      if (kind === "kyb" && final === "verified") addKybLine(ctx, o, u);
    }
    if (!s.badgesDone) return { op: "badges" };
    finishDossier(ctx, o, u, d);
    return null;
  }
  if (status === "suspended" || status === "expired" || (kind === "kyb" && status === "rejected")) {
    elsewhere(ctx, o, u, d, `the dossier's KYC status is ${status}`, true);
    return null;
  }
  if (status !== "pending" && status !== "more_info") throw new OwnerHandBack(`unexpected kyc_status ${status}`);
  const counted = () => clientReviewReasons({ kyc_status: status, requirements: D.requirements, details: D.verification }, { includeKyb: true }).length > 0;
  const firstDoc = linkedDoc(D.requirements.filter((x) => x.status === "submitted")) ?? linkedDoc(D.requirements);
  if (d.verdict === "reject") {
    // S6: the verdict first, then each document (both orders are legal in the UI).
    if (!s.viewed && firstDoc !== null) return { op: "view", docId: firstDoc };
    s.countedBefore = counted();
    return { op: "final", value: "rejected" };
  }
  const owed = D.requirements.filter((x) => x.status === "requested" || x.status === "rejected");
  if (d.verdict === "more_info" && !d.target) {
    // S11: a round started by hand (an admin request or a rejected file) is this dossier's round.
    const byAdmin = (x: Req) => Boolean(x.requested_by && !x.requested_by.startsWith("system:"));
    const hand = owed[0] ?? (d.pick === "request-doc" && intent?.op !== "request-doc" ? D.requirements.find(byAdmin) : undefined);
    if (hand) {
      d.target = { reqId: hand.id, docId: hand.status === "rejected" ? hand.document_id : null, kind: hand.status === "rejected" ? undefined : hand.doc_kind, byHand: true };
      ownerNote(ctx, u, "more_info", `the more_info round was started by hand (#${hand.id} ${hand.doc_kind} ${hand.status}); the actor waits for it instead of starting its own`);
    }
  }
  if (owed.length) {
    // M1: the client owes a file — the user's own polls must run to send it.
    d.phase = "await-user";
    d.awaitSig = uploadSignature(u);
    ownerNote(ctx, u, "await-user", `the client owes ${owed.map((x) => `#${x.id} ${x.doc_kind} (${x.status})`).join(", ")}: waiting for the user's upload`);
    release(ctx, o, u);
    return null;
  }
  const submitted = D.requirements.filter((x) => x.status === "submitted");
  if (!s.viewed && firstDoc !== null && submitted.length) return { op: "view", docId: firstDoc };
  if (d.verdict === "more_info" && !d.roundDone) {
    if (!d.target) {
      if (d.pick === "reject-doc") {
        const pass = submitted.find((x) => x.doc_kind === "passport") ?? submitted[submitted.length - 1];
        s.rejectTarget = pass?.id;
        const others = submitted.filter((x) => x !== pass);
        if (others.length) return { op: "review", req: others[0], status: "approved" };
        if (pass) return { op: "review", req: pass, status: "rejected" };
        // Every file was approved by hand: the round asks for one more document instead.
        d.pick = "request-doc";
        ownerNote(ctx, u, "more_info", "every document is approved already: this round requests one more document instead");
      }
      if (submitted.length) return { op: "review", req: submitted[0], status: "approved" };
      return { op: "request" };
    }
    const t = D.requirements.find((x) => x.id === d.target!.reqId);
    if (!t) throw new OwnerHandBack(`the more_info round's requirement #${d.target.reqId ?? d.target.kind} is gone`);
    if (t.status === "approved") {
      d.roundDone = true;
    } else if (t.status === "submitted") {
      if (d.target.docId !== undefined && d.target.docId !== null && t.document_id === d.target.docId) {
        throw new OwnerHandBack(`requirement #${t.id} is submitted again with the rejected document ${t.document_id}`);
      }
      if (d.target.kind && !d.target.byHand) {
        // C-O10: the replacement upload's recompute moved the dossier more_info → pending.
        ownerCheck(ctx, u, "C-O10", status === "pending", `kyc_status ${status} after the requested ${t.doc_kind} arrived`);
      }
      return { op: "review", req: t, status: "approved" };
    }
  }
  if (submitted.length) return { op: "review", req: submitted[0], status: "approved" };
  if (d.verdict === "more_info" && !d.roundDone) throw new OwnerHandBack("the more_info round has no document to wait for");
  s.countedBefore = counted();
  if (kind === "kyb" && kyb!.status !== "pending") throw new OwnerHandBack(`the KYB row is ${kyb!.status}`);
  return { op: "final", value: "verified" };
}

function finishDossier(ctx: SimCtx, o: OwnerCtx, u: UserState, d: OwnerDossier): void {
  d.phase = "decided";
  d.decidedAt = new Date(ctx.now()).toISOString();
  d.decidedStage = u.stage;
  record(u).attempts = 0;
  release(ctx, o, u);
}

async function actDossier(ctx: SimCtx, o: OwnerCtx, u: UserState, r: OwnerRecord, d: OwnerDossier, s: Session): Promise<void> {
  const act = s.next;
  s.next = undefined;
  if (!act) {
    s.fresh = false;
    return dossierWork(ctx, o, u);
  }
  const kind = planKind(u.plan);
  const clientId = u.data.clientId!;
  switch (act.op) {
    case "view": {
      // The reviewer opens a document: a logged 2-minute link (never followed; the journal redacts its token).
      await adminRead(ctx, o, u, "clients.doc-url", "/api/clients/doc-url", { document_id: act.docId });
      s.viewed = true;
      return planDossier(ctx, o, u, r, d, s, false);
    }
    case "review": {
      const approve = act.status === "approved";
      // Per-document approvals: approve / more_info only, never the file this round rejects;
      // per-document rejects: a reject verdict, or the one file of a reject-doc round.
      const roundTarget = d.verdict === "more_info" && d.pick === "reject-doc" && !d.target && act.req.id === s.rejectTarget;
      const allowed = approve ? d.verdict !== "reject" && !roundTarget : d.verdict === "reject" || roundTarget;
      guardWrite(u, "clients.review-requirement", act.status, allowed);
      if (!approve && d.verdict === "more_info") {
        d.intent = { op: "reject-doc", reqId: act.req.id, docId: act.req.document_id, at: new Date(ctx.now()).toISOString() };
        ctx.persist();
      }
      await adminWrite(ctx, o, u, "clients.review-requirement", "/api/clients/review-requirement", { id: act.req.id, status: act.status });
      if (!approve && d.verdict === "more_info") {
        d.target = { reqId: act.req.id, docId: act.req.document_id };
        logDecision(ctx, r, `rejected #${act.req.id} ${act.req.doc_kind} (more_info round)`);
      }
      s.expect = { kind: "review", reqId: act.req.id, status: act.status };
      s.fresh = false;
      return;
    }
    case "final": {
      const value = act.value;
      const approveOk = d.verdict === "approve" || (d.verdict === "more_info" && Boolean(d.roundDone));
      d.intent = { op: "final", value, at: new Date(ctx.now()).toISOString() };
      if (kind === "kyc") {
        guardWrite(u, "clients.status", value, value === "verified" ? approveOk : d.verdict === "reject");
        ctx.persist();
        await adminWrite(ctx, o, u, "clients.status", "/api/clients/status", {
          id: clientId,
          kyc_status: value,
          onboarding_status: value,
          reason: reason(ctx, value === "verified" ? "all documents approved; verified as planned" : "documents stamped PLEASE REJECT; rejected as planned"),
        });
        s.expect = { kind: "status", value };
      } else {
        guardWrite(u, "clients.kybDecision", value, value === "verified" ? approveOk : d.verdict === "reject");
        ctx.persist();
        await adminWrite(ctx, o, u, "clients.kybDecision", "/api/clients/kyb-decision", {
          client_id: clientId,
          decision: value,
          note: reason(ctx, value === "verified" ? "company documents approved; KYB verified as planned" : "company documents stamped PLEASE REJECT; KYB rejected as planned"),
        });
        s.expect = { kind: "kyb", value };
      }
      s.fresh = false;
      return;
    }
    case "request": {
      const item = requestKind(u.plan);
      guardWrite(u, "clients.request-docs", item.doc_kind, d.verdict === "more_info" && d.pick === "request-doc" && !d.target);
      d.intent = { op: "request-doc", kind: item.doc_kind, at: new Date(ctx.now()).toISOString() };
      ctx.persist();
      const data = await adminWrite<{ requested?: number; upload_link_warning?: string | null }>(ctx, o, u, "clients.request-docs", "/api/clients/request-docs", {
        client_id: clientId,
        items: [{ ...item, note: reason(ctx, "one more document requested as planned") }],
      });
      ownerCheck(ctx, u, "C-O4", (data?.upload_link_warning ?? null) === null, `request-docs answered upload_link_warning ${JSON.stringify(data?.upload_link_warning ?? null)}`);
      d.target = { kind: item.doc_kind };
      logDecision(ctx, r, `requested ${item.label} (more_info round)`);
      s.expect = { kind: "request", doc_kind: item.doc_kind };
      s.fresh = false;
      return;
    }
    case "passport":
      return passportRejectStep(ctx, o, u, d, s);
    case "badges":
      await badgesCheck(ctx, o, u, s.drops ?? {});
      s.badgesDone = true;
      return planDossier(ctx, o, u, r, d, s, false);
  }
}

/** A rejected KYC dossier's open passport request (SIM_OWNER_PASSPORT_REJECT=1; UI: app/admin/kyc/page.tsx rejectRequest). */
async function passportRejectStep(ctx: SimCtx, o: OwnerCtx, u: UserState, d: OwnerDossier, s: Session): Promise<void> {
  const step = s.passportStep ?? "list";
  const why = reason(ctx, "dossier rejected");
  if (step === "list" || step === "relist") {
    const data = await adminRead<{ requests?: PassportRow[] }>(ctx, o, u, "passport.list", "/api/passport/list", {});
    const rows = (data?.requests ?? []).filter((x) => x.wallet === u.wallet);
    if (step === "relist") {
      const row = rows.find((x) => x.id === s.passportRow?.id);
      ownerCheck(ctx, u, "C-O4", row?.status === "rejected", `passport request ${s.passportRow?.id} shows ${row?.status ?? "nothing"} after passport.update rejected`);
      d.passportDone = true;
      s.drops = { ...s.drops, "/admin/kyc": 1 };
      return planDossier(ctx, o, u, record(u), d, s, false);
    }
    const open = rows.find((x) => x.status === "new" || x.status === "in_review");
    if (!open) {
      const mine = d.passportIntent && rows.some((x) => x.id === d.passportIntent && x.status === "rejected");
      ownerNote(ctx, u, "passport", mine ? `passport request ${d.passportIntent} is rejected (the actor's own write, before a restart)` : "no open passport request for the rejected wallet");
      d.passportDone = true;
      return planDossier(ctx, o, u, record(u), d, s, false);
    }
    s.passportRow = open;
    s.passportStep = "update";
    s.next = { op: "passport" };
    return;
  }
  if (step === "update") {
    guardWrite(u, "passport.update", "rejected", passportRejectPlanned(u.plan, o.options));
    d.passportIntent = s.passportRow!.id;
    ctx.persist();
    await adminWrite(ctx, o, u, "passport.update", "/api/passport/update", {
      id: s.passportRow!.id,
      patch: { status: "rejected", handled_by: o.admin.address, handled_at: new Date(ctx.now()).toISOString() },
      reason: why,
    });
    logDecision(ctx, record(u), `rejected passport request ${s.passportRow!.id}`);
    s.passportStep = "audit";
    s.next = { op: "passport" };
    return;
  }
  await auditPost(ctx, o, u, { ix_name: "passport_request_rejected", category: "other", reason: why, target_label: u.wallet });
  s.passportStep = "relist";
  s.next = { op: "passport" };
}

function addManual(ctx: SimCtx, u: UserState, kind: "passport" | "verify_issuer_kyb", line: string): void {
  const r = record(u);
  const list = (r.manual ??= []);
  const at = new Date(ctx.now()).toISOString();
  const i = list.findIndex((m) => m.kind === kind);
  if (i >= 0) list[i] = { kind, line, at };
  else list.push({ kind, line, at });
  ownerNote(ctx, u, "manual", line);
}

function addKybLine(ctx: SimCtx, o: OwnerCtx, u: UserState): void {
  const p = person(ctx.runId, u.plan.n);
  const admin = o.view?.platformAdmin ?? "(Platform.admin)";
  addManual(
    ctx,
    u,
    "verify_issuer_kyb",
    `issuer KYB ${u.plan.label} ${p.company.name} issuer ${u.data.issuerPda ?? "?"} (legal id ${simLegalId(ctx.runId, u.plan.n)}): ${SITE_ORIGIN}/admin/issuers → Verify KYB (verify_issuer_kyb, signed by the super admin ${admin}). Optional: the simulator does not wait for it (SIM issuers have no asset or share class); skip it if /admin/issuers already shows Verified.`,
  );
}

// ── admin.badges (C-O11, critique S13) ───────────────────────────────────────

type BadgeRead = { badges?: Partial<Record<AdminBadgeHref, { count: number | null }>> };

function countsOf(data: BadgeRead | undefined): Partial<Record<AdminBadgeHref, number | null>> {
  const out: Partial<Record<AdminBadgeHref, number | null>> = {};
  for (const [href, badge] of Object.entries(data?.badges ?? {})) out[href as AdminBadgeHref] = badge?.count ?? null;
  return out;
}

/**
 * The UI refetches the menu counts after every admin write
 * (notifyAdminBadges). After a decision, a queue's count can only have grown
 * by the users' requests since the last read, minus what this decision took
 * out: a larger count means the badges route missed the decision.
 */
async function badgesCheck(ctx: SimCtx, o: OwnerCtx, u: UserState, drops: Partial<Record<AdminBadgeHref, number>>): Promise<void> {
  const data = await adminRead<BadgeRead>(ctx, o, u, "admin.badges", "/api/admin/badges", { fresh: true });
  const after = countsOf(data);
  const before = o.badges;
  for (const [href, drop] of Object.entries(drops) as [AdminBadgeHref, number][]) {
    const was = before?.counts[href];
    const now = after[href];
    if (typeof was !== "number" || typeof now !== "number") {
      ownerCheck(ctx, u, "C-O11", true, `${href}: no count to compare (${String(was)} → ${String(now)})`);
      continue;
    }
    const grown = before?.activity[href] ?? 0;
    const limit = was + grown - drop;
    ownerCheck(ctx, u, "C-O11", now <= limit, `${href} counts ${now} after the decision (was ${was}, at most ${grown} added by users since, ${drop} taken out: ≤ ${limit})`);
  }
  o.badges = { counts: after, activity: {} };
}

// ── Applications (UI: app/admin/applications/page.tsx) ───────────────────────

async function appWork(ctx: SimCtx, o: OwnerCtx, u: UserState): Promise<void> {
  const r = record(u);
  const a: OwnerApp = (r.app ??= { phase: "open", rounds: [] });
  if (a.phase === "await-user") {
    a.phase = "open";
    a.step = "list";
  }
  const s = session(o, u, "app");
  const m = (s.app ??= {});
  const plan = appPlan(u.plan, o.options)!;
  // Reads before the write are redone after a restart; post-write steps continue.
  if (!m.row && (a.step === "events" || a.step === "review")) a.step = "list";
  const step = a.step ?? "list";
  const id = u.data.applicationId!;
  const company = person(ctx.runId, u.plan.n).company.name;
  const guard = (row: AppRow) => {
    if (row.applicant_wallet !== u.wallet || row.company_name !== company) {
      ownerCheck(ctx, u, "C-O1", false, `application ${row.id} names ${row.applicant_wallet ?? "-"} / ${row.company_name ?? "-"}, not ${u.wallet} / ${company}`);
      throw new OwnerHandBack(`application ${row.id} does not belong to ${u.plan.label}`);
    }
  };
  const decision = () => a.intent?.decision ?? m.decision!;
  switch (step) {
    case "list": {
      const data = await adminRead<{ applications?: AppRow[] }>(ctx, o, u, "applications.adminList", "/api/applications/admin-list", { status: "pending" });
      const row = (data?.applications ?? []).find((x) => x.id === id);
      if (!row) {
        a.step = "listAll";
        return;
      }
      guard(row);
      m.row = row;
      a.step = "events";
      return;
    }
    case "listAll": {
      const data = await adminRead<{ applications?: AppRow[] }>(ctx, o, u, "applications.adminList", "/api/applications/admin-list", {});
      const row = (data?.applications ?? []).find((x) => x.id === id);
      if (!row) {
        ownerCheck(ctx, u, "C-O1", false, `application ${id} is not in the admin list`);
        throw new OwnerHandBack(`application ${id} is not in /admin/applications`);
      }
      guard(row);
      if (a.intent && row.status === a.intent.decision && !a.rounds.some((x) => x.at === a.intent!.at)) {
        // Our review landed before a restart: account for it and continue after the write.
        recordAppDecision(ctx, u, r, a, a.intent.decision);
        a.step = "audit";
        return;
      }
      if (row.status === "needs_changes") {
        a.phase = "await-user";
        a.awaitResubmits = u.data.resubmits ?? 0;
        a.step = "list";
        ownerNote(ctx, u, "await-user", `application ${id} is needs_changes: waiting for the resubmission`);
        return release(ctx, o, u);
      }
      if (row.status === "pending") {
        m.row = row;
        a.step = "events";
        return;
      }
      return elsewhere(ctx, o, u, a, `application ${id} is already ${row.status}`, row.status !== plan.final);
    }
    case "events": {
      const data = await adminRead<{ events?: AppEvent[] }>(ctx, o, u, "applications.adminEvents", "/api/applications/admin-events", { application_id: id });
      m.events = data?.events ?? [];
      const asked = m.events.some((e) => e.actor === "admin" && e.action === "needs_changes");
      m.decision = plan.first && !asked ? plan.first : plan.final;
      a.step = "review";
      return;
    }
    case "review": {
      const value = m.decision!;
      const planned = plan.first && !m.events?.some((e) => e.actor === "admin" && e.action === "needs_changes") ? plan.first : plan.final;
      guardWrite(u, "applications.review", value, value === planned);
      a.intent = { decision: value, at: new Date(ctx.now()).toISOString() };
      ctx.persist();
      await adminWrite(ctx, o, u, "applications.review", "/api/applications/review", {
        id,
        decision: value,
        reason: reason(
          ctx,
          value === "needs_changes" ? "please resubmit (planned needs_changes round)" : value === "approved" ? "reviewed; approved as planned" : "planned rejection to exercise the reject path",
        ),
      });
      recordAppDecision(ctx, u, r, a, value);
      a.step = "audit";
      return;
    }
    case "audit": {
      const value = decision();
      await auditPost(ctx, o, u, {
        ix_name: `review_application:${value}`,
        category: "issuers",
        reason: reason(ctx, value === "needs_changes" ? "please resubmit (planned needs_changes round)" : value === "approved" ? "reviewed; approved as planned" : "planned rejection to exercise the reject path"),
        target_label: company,
      });
      a.step = "refresh";
      return;
    }
    case "refresh": {
      const data = await adminRead<{ applications?: AppRow[] }>(ctx, o, u, "applications.adminList", "/api/applications/admin-list", { status: "pending" });
      ownerCheck(ctx, u, "C-O8", !(data?.applications ?? []).some((x) => x.id === id), `application ${id} ${(data?.applications ?? []).some((x) => x.id === id) ? "is still" : "left"} the pending queue after ${decision()}`);
      a.step = "refreshEvents";
      return;
    }
    case "refreshEvents": {
      const data = await adminRead<{ events?: AppEvent[] }>(ctx, o, u, "applications.adminEvents", "/api/applications/admin-events", { application_id: id });
      const value = decision();
      ownerCheck(ctx, u, "C-O4", (data?.events ?? []).some((e) => e.actor === "admin" && e.action === value), `the event timeline ${(data?.events ?? []).some((e) => e.actor === "admin" && e.action === value) ? "shows" : "lacks"} the admin ${value} event`);
      a.step = "badges";
      return;
    }
    case "badges": {
      await badgesCheck(ctx, o, u, { "/admin/applications": 1 });
      const value = decision();
      a.step = "list";
      a.intent = undefined;
      r.attempts = 0;
      if (value === "needs_changes") {
        a.phase = "await-user";
        a.awaitResubmits = u.data.resubmits ?? 0;
      } else {
        a.phase = "decided";
        a.decidedAt = new Date(ctx.now()).toISOString();
        a.decidedStage = u.stage;
      }
      return release(ctx, o, u);
    }
  }
}

function recordAppDecision(ctx: SimCtx, u: UserState, r: OwnerRecord, a: OwnerApp, value: string): void {
  a.rounds.push({ decision: value, at: a.intent?.at ?? new Date(ctx.now()).toISOString() });
  countDecision(ctx);
  logDecision(ctx, r, `application ${value}`);
  ownerNote(ctx, u, "decision", `application ${u.data.applicationId} ${value} as planned`);
}

// ── OTC escrows (UI: app/admin/otc/page.tsx createContract) ──────────────────

async function otcWork(ctx: SimCtx, o: OwnerCtx, u: UserState): Promise<void> {
  const r = record(u);
  const t: OwnerOtc = (r.otc ??= { requestId: u.data.dealRequestId!, phase: "open" });
  const s = session(o, u, "otc");
  const m = (s.otc ??= { offset: 0 });
  if (o.view && o.view.lamports < MIN_ESCROW_LAMPORTS && !t.dealPda) throw new OwnerHandBack("CekAgg needs devnet SOL for the escrow rent (below 0.05 SOL)");
  // Reads before a write are redone after a restart (M2: the row is re-read before signing and before the flip).
  const PRE = ["mint", "screen", "eligibility", "deals", "reread", "tx"];
  if (!m.row && PRE.includes(t.step ?? "list")) t.step = "list";
  if (!m.row && t.step === "flip") t.step = "reflip";
  const other = Object.values(ctx.state.users).find((x) => x.plan.pair === u.plan.pair && x !== u && x.plan.cohort === "T");
  const seller = u.plan.variant === "maker" ? u.wallet : other?.wallet;
  const buyer = u.plan.variant === "taker" ? u.wallet : other?.wallet;
  const guard = (row: OtcRow) => {
    const ok =
      row.seller_wallet === seller &&
      row.buyer_wallet === buyer &&
      row.share_class_pda === ctx.market.classA &&
      row.mint === ctx.market.mintA &&
      row.payment_mint === ctx.market.paymentMint &&
      Number(row.amount) === DEAL_UNITS &&
      Number(row.price) === DEAL_PRICE;
    if (!ok) {
      ownerCheck(ctx, u, "C-O1", false, `OTC request ${row.id}: seller ${row.seller_wallet}, buyer ${row.buyer_wallet}, class ${row.share_class_pda}, mint ${row.mint}, payment ${row.payment_mint}, ${row.amount} for ${row.price} — not pair ${u.plan.pair}'s ${DEAL_UNITS} for ${DEAL_PRICE}`);
      throw new OwnerHandBack(`OTC request ${row.id} does not match pair ${u.plan.pair}`);
    }
  };
  const list = async (status: "requested" | null) =>
    (await adminRead<OtcRow[]>(ctx, o, u, "otc.list", "/api/otc/list", status ? { scope: "admin", status, offset: m.offset } : { scope: "admin", offset: m.offset })) ?? [];
  /** A row that left the requested queue: ours (the flip landed), someone else's decision, or a race with ours. */
  const settledElsewhere = (row: OtcRow): void => {
    if (row.status === "created" && t.dealPda && row.deal_pda === t.dealPda) {
      if (!t.flippedAt) recordFlip(ctx, u, r, t, other);
      t.step = "audit";
      return;
    }
    if (t.dealPda && (t.sig !== undefined || ctx.chain.everSigned(u, "owner.otc.create"))) {
      ownerCheck(ctx, u, "C-O7", false, `request ${row.id} became ${row.status}${row.deal_pda ? ` with deal ${row.deal_pda}` : ""} while the actor opened deal ${t.dealPda}`);
      throw new OwnerHandBack(`request ${row.id} is ${row.status} but the actor's deal ${t.dealPda} is open on chain: cancel that deal in ${SITE_ORIGIN}/admin/otc`);
    }
    elsewhere(ctx, o, u, t, `OTC request ${row.id} is already ${row.status}${row.deal_pda ? ` (deal ${row.deal_pda})` : ""}`, row.status !== "created");
  };
  switch (t.step ?? "list") {
    case "list":
    case "reread":
    case "reflip": {
      const rows = await list("requested");
      const row = rows.find((x) => x.id === t.requestId);
      if (!row) {
        if (rows.length >= 100) {
          m.offset += 100;
          return;
        }
        m.offset = 0;
        t.step = t.step === "reflip" ? "reflipAll" : "listAll";
        return;
      }
      m.offset = 0;
      guard(row);
      m.row = row;
      t.step = t.step === "reflip" ? "flip" : t.step === "reread" ? "tx" : "mint";
      return;
    }
    case "listAll":
    case "reflipAll": {
      const rows = await list(null);
      const row = rows.find((x) => x.id === t.requestId);
      if (!row) {
        if (rows.length >= 100) {
          m.offset += 100;
          return;
        }
        ownerCheck(ctx, u, "C-O1", false, `OTC request ${t.requestId} is not in the admin list`);
        throw new OwnerHandBack(`OTC request ${t.requestId} is not in /admin/otc`);
      }
      m.offset = 0;
      guard(row);
      if (row.status === "requested") {
        m.row = row;
        t.step = t.step === "reflipAll" ? "flip" : "mint";
        return;
      }
      return settledElsewhere(row);
    }
    case "mint": {
      // The entry check before an escrow names the payment mint (a throw is the page's refusal).
      try {
        t.payProgram = await ctx.chain.paymentMintProgram(m.row!.payment_mint as Address);
      } catch (error) {
        if (error instanceof ChainRpcError) throw error;
        throw new OwnerHandBack(`the payment mint was refused: ${error instanceof Error ? error.message : String(error)}`);
      }
      t.step = "screen";
      return;
    }
    case "screen": {
      const screen = await adminRead<{ cleared?: boolean; seller?: string; buyer?: string }>(ctx, o, u, "otc.adminScreen", "/api/otc/admin-screen", { id: t.requestId });
      if (screen?.cleared !== true) {
        ownerCheck(ctx, u, "C-O1", false, `a SIM party is suspended (seller ${screen?.seller ?? "?"}, buyer ${screen?.buyer ?? "?"})`);
        throw new OwnerHandBack(`a party of request ${t.requestId} is suspended: decline it in ${SITE_ORIGIN}/admin/otc`);
      }
      t.step = "eligibility";
      return;
    }
    case "eligibility": {
      const gate = await ctx.chain.eligibility(m.row!.mint as Address, m.row!.buyer_wallet as Address);
      if (!gate.ok) {
        ownerCheck(ctx, u, "C-O1", false, `the buyer cannot receive class A: ${gate.reason}`);
        throw new OwnerHandBack(`the buyer of request ${t.requestId} cannot receive the token (${gate.reason})`);
      }
      t.step = "deals";
      return;
    }
    case "deals": {
      // M2: never a second deal — an Open deal of this pair and terms on chain is someone's escrow already.
      const deals = await ctx.chain.otcDeals(ctx.market.classA);
      const row = m.row!;
      const same = deals.find(
        (x) =>
          x.status === OtcDealStatus.Open &&
          x.seller === row.seller_wallet &&
          x.buyer === row.buyer_wallet &&
          x.amount === BigInt(Math.trunc(row.amount)) &&
          x.price === BigInt(Math.trunc(row.price)) &&
          (x.paymentMint === undefined || x.paymentMint === row.payment_mint),
      );
      if (same && same.pda !== t.dealPda) {
        ownerCheck(ctx, u, "C-O7", true, `an Open deal ${same.pda} of this pair already exists on chain; no second deal`);
        throw new OwnerHandBack(`an Open deal ${same.pda} for request ${t.requestId} already exists on chain (opened by hand?): flip the request row in ${SITE_ORIGIN}/admin/otc instead of opening another`);
      }
      t.step = same ? "check" : "reread";
      return;
    }
    case "tx": {
      const row = m.row!;
      if (!ctx.chain.everSigned(u, "owner.otc.create")) {
        // S8: nothing was signed yet — a fresh deal id and expiry, persisted before signing.
        const dealId = newDealId(ctx.now());
        t.dealId = dealId.toString();
        t.expiresAt = resolveDealExpiry(row.expires_at, ctx.now()).toString();
        t.dealPda = await ctx.chain.dealPda(row.share_class_pda as Address, dealId);
        ctx.persist();
      }
      guardWrite(u, "create_otc_deal", "open", otcRequester(u.plan));
      t.sig = await ctx.chain.openOtcDeal(u, o.admin, {
        dealId: BigInt(t.dealId!),
        expiresAt: BigInt(t.expiresAt!),
        paymentTokenProgram: t.payProgram as Address,
        request: row,
      });
      logDecision(ctx, r, `opened escrow deal ${t.dealPda}${t.sig ? ` (tx ${t.sig.slice(0, 16)}…)` : ""}`);
      t.step = "check";
      return;
    }
    case "check": {
      const view = await ctx.chain.deal(t.dealPda as Address);
      if (!view) throw new OwnerHandBack(`deal ${t.dealPda} is not on chain after create_otc_deal`);
      const row = m.row;
      const wrong: string[] = [];
      const eq = (name: string, got: unknown, want: unknown) => {
        if (String(got) !== String(want)) wrong.push(`${name} ${String(got)} ≠ ${String(want)}`);
      };
      eq("status", view.status, OtcDealStatus.Open);
      eq("seller", view.seller, row?.seller_wallet ?? seller);
      eq("buyer", view.buyer, row?.buyer_wallet ?? buyer);
      eq("amount", view.amount, DEAL_UNITS);
      eq("price", view.price, DEAL_PRICE);
      eq("payment mint", view.paymentMint, ctx.market.paymentMint);
      eq("admin", view.admin, o.admin.address);
      if (t.expiresAt) eq("expires_at", view.expiresAt, t.expiresAt);
      ownerCheck(ctx, u, "C-O7", wrong.length === 0, wrong.length ? `deal ${t.dealPda}: ${wrong.join(", ")}` : `deal ${t.dealPda} matches the request`);
      // M2: no flip for a deal that does not match its request.
      if (wrong.length) throw new OwnerHandBack(`deal ${t.dealPda} does not match request ${t.requestId}: cancel it in ${SITE_ORIGIN}/admin/otc`);
      t.step = "reflip";
      return;
    }
    case "flip": {
      guardWrite(u, "otc.adminUpdate", "created", otcRequester(u.plan));
      t.intent = { op: "flip", value: t.dealPda, at: new Date(ctx.now()).toISOString() };
      ctx.persist();
      await adminWrite(ctx, o, u, "otc.adminUpdate", "/api/otc/admin-update", { id: t.requestId, status: "created", deal_pda: t.dealPda, deal_id: Number(t.dealId), decide: true });
      recordFlip(ctx, u, r, t, other);
      t.step = "audit";
      return;
    }
    case "audit": {
      const row = m.row;
      await auditPost(ctx, o, u, {
        ix_name: "create_otc_deal",
        category: "otc",
        reason: `OTC escrow request ${t.requestId}`,
        target_label: row?.asset_label || (row?.mint ?? ctx.market.mintA).slice(0, 8),
        tx_signature: t.sig ?? null,
        metadata: { request_id: t.requestId, deal_pda: t.dealPda, deal_id: t.dealId, amount: row?.amount ?? DEAL_UNITS, price: row?.price ?? DEAL_PRICE },
      });
      t.step = "refresh";
      return;
    }
    case "refresh": {
      const rows = await list("requested");
      const still = rows.some((x) => x.id === t.requestId);
      ownerCheck(ctx, u, "C-O8", !still, `request ${t.requestId} ${still ? "is still" : "left"} the requested queue after the flip`);
      t.step = "badges";
      return;
    }
    case "badges": {
      await badgesCheck(ctx, o, u, { "/admin/otc": 1 });
      t.phase = "decided";
      t.step = undefined;
      r.attempts = 0;
      return release(ctx, o, u);
    }
  }
}

function recordFlip(ctx: SimCtx, u: UserState, r: OwnerRecord, t: OwnerOtc, other: UserState | undefined): void {
  t.flippedAt = new Date(ctx.now()).toISOString();
  countDecision(ctx);
  logDecision(ctx, r, `request ${t.requestId} → created (deal ${t.dealPda})`);
  ownerNote(ctx, u, "decision", `OTC escrow ${t.dealPda} opened for request ${t.requestId} as planned`);
  // S18: both parties look again now (their deposits follow).
  if (other && !other.terminal) other.notBefore = ctx.now();
}

// ── Passport triage (UI: app/admin/kyc/page.tsx markInReview) ─────────────────

async function passportWork(ctx: SimCtx, o: OwnerCtx, u: UserState): Promise<void> {
  const r = record(u);
  const p = (r.passport ??= { phase: "open" });
  const s = session(o, u, "passport");
  const m = (s.triage ??= { step: "list" });
  const registry = o.view?.registry ?? DEVNET_PLATFORM_KYC_REGISTRY;
  const provider = o.view?.kycAuthority ?? "(registry authority not found)";
  if (m.step === "update") {
    guardWrite(u, "passport.update", "in_review", passportTriage(u.plan));
    await adminWrite(ctx, o, u, "passport.update", "/api/passport/update", { id: m.row!.id, patch: { status: "in_review" }, reason: null });
    m.step = "relist";
    return;
  }
  const data = await adminRead<{ requests?: PassportRow[] }>(ctx, o, u, "passport.list", "/api/passport/list", {});
  const rows = (data?.requests ?? []).filter((x) => x.wallet === u.wallet);
  if (m.step === "relist") {
    const row = rows.find((x) => x.id === m.row!.id);
    ownerCheck(ctx, u, "C-O4", row?.status === "in_review", `passport request ${m.row!.id} shows ${row?.status ?? "nothing"} after passport.update in_review`);
  }
  const open = rows.find((x) => x.status === "new" || x.status === "in_review");
  const who = person(ctx.runId, u.plan.n).displayName;
  if (!open) {
    if (rows.some((x) => x.status === "approved")) {
      p.phase = "elsewhere";
      ownerNote(ctx, u, "elsewhere", "the passport request is approved already (issued by the KYC provider?)");
      return release(ctx, o, u);
    }
    ownerCheck(ctx, u, "C-O9", false, `verified buyer ${u.wallet} has no open passport request in /admin/kyc`);
    addManual(ctx, u, "passport", `passport ${u.plan.label} ${who} wallet ${u.wallet}: no request in ${SITE_ORIGIN}/admin/kyc — issue it from ${SITE_ORIGIN}/admin/clients/${u.data.clientId ?? "?"} (approve_holder on registry ${registry}, signed by the KYC provider ${provider}); the buyer then buys on sale [0].`);
    p.phase = "none";
    return release(ctx, o, u);
  }
  if (open.status === "new" && m.step === "list") {
    m.row = open;
    m.step = "update";
    return;
  }
  p.requestId = open.id;
  p.phase = "in-review";
  logDecision(ctx, r, `passport request ${open.id} marked in review`);
  addManual(ctx, u, "passport", `passport ${u.plan.label} ${who} wallet ${u.wallet}: ${SITE_ORIGIN}/admin/kyc → request ${open.id} (in review) → Issue passport (approve_holder on registry ${registry}, signed by the KYC provider ${provider}); the buyer then buys on sale [0].`);
  release(ctx, o, u);
}

// ── Start and end of a run with the actor ────────────────────────────────────

/**
 * The owner actor's preflight (design §6, critique M3, S14, S17): the Admin
 * record at finalized, the super admin and the KYC provider the queue names,
 * the admin's SOL, the passport registry the investors read, and the first
 * admin.badges read. A CLI Admin without an Admin record ends the command.
 */
export async function startOwnerActor(ctx: SimCtx, o: OwnerCtx): Promise<void> {
  const registry = DEVNET_PLATFORM_KYC_REGISTRY;
  const view = await ctx.chain.ownerView(o.admin.address, registry);
  if (!view.isAdmin) throw new SimGateError(`The CLI Admin ${o.admin.address} has no Admin record on devnet (requireAdmin would refuse every admin route)`);
  o.view = { ...view, registry };
  const state: SimState = ctx.state;
  state.owner ??= { decisions: 0, firstUtc: new Date().toISOString() };
  const reading = ctx.market.kycRegistry ?? null;
  if (state.owner.kycRegistry === undefined) state.owner.kycRegistry = reading;
  else if (state.owner.kycRegistry !== reading) {
    ctx.log(`owner actor: the investors now read passports on ${reading ?? "no registry"}, an earlier owner-actor command read ${state.owner.kycRegistry ?? "none"} (SIM_KYC_REGISTRY changed?)`);
    ownerNote(ctx, null, "registry", `passport registry changed: ${state.owner.kycRegistry ?? "none"} → ${reading ?? "none"}`);
  }
  if (reading !== registry) {
    ctx.log(`owner actor: investors read KycEntry on ${reading ?? "no registry"}, the site issues passports on the pinned ${registry}; they fall back to /api/passport/status (keep SIM_KYC_REGISTRY as the live watch had it)`);
  }
  ownerNote(ctx, null, "preflight", `Admin record ok; super admin ${view.platformAdmin ?? "?"}; KYC provider of ${registry}: ${view.kycAuthority ?? "registry not found"}; CLI Admin SOL ${(Number(view.lamports) / 1e9).toFixed(3)}; investors read ${reading ?? "no registry"}`);
  if (view.lamports < MIN_ESCROW_LAMPORTS) ctx.log("owner actor: CekAgg holds less than 0.05 SOL: the OTC escrows are handed back");
  if (o.options.retry) {
    for (const u of Object.values(state.users)) {
      const r = u.data.owner;
      if (!r?.handedBack) continue;
      ownerNote(ctx, u, "retry", `re-armed: ${r.handedBack.task} (${r.handedBack.reason})`);
      for (const sub of [r.dossier, r.app, r.otc, r.passport]) if (sub?.phase === "handed-back") sub.phase = "open";
      r.handedBack = undefined;
      r.attempts = 0;
      r.retryAt = undefined;
    }
  }
  const r = await ctx.http.read<BadgeRead>(ownerActor(o, null), { step: "owner.admin.badges", route: "/api/admin/badges", action: "admin.badges", params: {} });
  if (r.status === 403) throw new SimGateError(`The CLI Admin is not an Admin on devnet ${SITE_ORIGIN} (admin.badges answered 403)`);
  if (r.outcome !== "ok") throw new SimGateError(`admin.badges answered ${r.status || "no response"}: the owner actor does not start`);
  o.badges = { counts: countsOf(r.data), activity: {} };
  ownerNote(ctx, null, "badges.start", JSON.stringify(o.badges.counts));
  ctx.persist();
}

/** The last admin.badges read (skipped when the run was stopped by a breaker). */
export async function finishOwnerActor(ctx: SimCtx, o: OwnerCtx): Promise<void> {
  try {
    const r = await ctx.http.read<BadgeRead>(ownerActor(o, null), { step: "owner.admin.badges", route: "/api/admin/badges", action: "admin.badges", params: {} });
    if (r.outcome === "ok") ownerNote(ctx, null, "badges.end", JSON.stringify(countsOf(r.data)));
  } catch (error) {
    if (!(error instanceof SimStopError)) throw error;
  }
}

// ── owner-queue.txt and the plan ─────────────────────────────────────────────

export type OwnerQueueView = {
  admin: string;
  stopped: string | null;
  /** label → "[owner actor: next]" | "[owner actor: queued #k]" | "[owner actor: waiting …]" | "[manual]". */
  tags: Map<string, string>;
};

export function ownerQueueView(ctx: SimCtx): OwnerQueueView | undefined {
  const o = ctx.owner;
  if (!o) return undefined;
  const tags = new Map<string, string>();
  const queued = Object.values(ctx.state.users)
    .map((u) => ({ u, t: currentTask(ctx, o, u) }))
    .filter((x) => x.t && x.u.plan.label !== o.focus)
    .sort((a, b) => a.t!.rank - b.t!.rank);
  if (o.focus) tags.set(o.focus, "[owner actor: next]");
  queued.forEach((x, i) => tags.set(x.u.plan.label, `[owner actor: queued #${i + 1}]`));
  for (const u of Object.values(ctx.state.users)) {
    if (tags.has(u.plan.label) || u.terminal || !(u.awaitingOwner || u.ownerTask)) continue;
    const r = u.data.owner;
    const waiting = !o.stopped && (r?.dossier?.phase === "await-user" || r?.app?.phase === "await-user");
    tags.set(u.plan.label, waiting ? (r?.app?.phase === "await-user" ? "[owner actor: waiting for the resubmission]" : "[owner actor: waiting for the user's replacement]") : "[manual]");
  }
  return { admin: o.admin.address, stopped: o.stopped, tags };
}

/** The offline preview (SIM_CMD=plan SIM_OWNER=1): the decision table, the order, the budget and, with a state, each task's status. */
export function renderOwnerPlan(options: OwnerOptions, state: SimState | null, roster: UserPlan[] = ROSTER): string {
  const labels = (list: UserPlan[]) => list.map((p) => p.label).join(" ") || "-";
  const dossiers = roster.filter((p) => hasDossier(p) && p.cohort !== "E");
  const by = (v: string) => dossiers.filter((p) => dossierVerdict(p) === v);
  const approve = by("approve");
  const more = by("more_info");
  const apps = roster.filter((p) => appPlan(p, options));
  const needs = apps.filter((p) => appPlan(p, options)!.first);
  const rejectApp = apps.filter((p) => appPlan(p, options)!.final === "rejected");
  const passports = roster.filter(passportTriage);
  const kybVerified = [...approve, ...more].filter((p) => planKind(p) === "kyb");
  const otc = roster.filter(otcRequester);
  const leave = dossiers.filter((p) => p.review === "leave");
  const edge = roster.filter((p) => p.cohort === "E");
  const docs = (p: UserPlan) => (planKind(p) === "kyb" ? 4 : 3);
  // Estimated requests (design §5 table, with the badges read after each decision).
  let writes = 0;
  let reads = 2; // admin.badges at start and end
  for (const p of approve) {
    writes += docs(p) + 1;
    reads += docs(p) + 4;
  }
  for (const p of by("reject")) {
    writes += docs(p) + 1 + (passportRejectPlanned(p, options) ? 2 : 0);
    reads += docs(p) + 4 + (passportRejectPlanned(p, options) ? 2 : 0);
  }
  for (const p of more) {
    writes += docs(p) + (morePick(p) === "request-doc" ? 3 : 2);
    reads += docs(p) + 7;
  }
  writes += (apps.length + needs.length) * 2 + otc.length * 2 + passports.length;
  reads += (apps.length + needs.length) * 5 + otc.length * 6 + passports.length * 2;
  const status = (p: UserPlan): string => {
    const u = state?.users[p.label];
    if (!u) return "not started";
    if (u.terminal) return u.terminal;
    const r = u.data.owner;
    const phases = [r?.dossier && `dossier ${r.dossier.phase}`, r?.app && `application ${r.app.phase}`, r?.otc && `escrow ${r.otc.phase}`, r?.passport && `passport ${r.passport.phase}`].filter(Boolean);
    return `${u.stage}${phases.length ? ` (${phases.join(", ")})` : ""}${r?.handedBack ? " [handed back]" : ""}`;
  };
  const lines = [
    "",
    `owner actor (SIM_CMD=watch SIM_OWNER=1): the CLI Admin ${CLI_ADMIN.slice(0, 6)}… makes the owner's planned decisions through the admin routes the UI uses (one task at a time; the preview sends nothing)`,
    `  dossiers ${dossiers.length}: approve ${approve.length} (KYB ${approve.filter((p) => planKind(p) === "kyb").length}: ${labels(approve.filter((p) => planKind(p) === "kyb"))}) · reject ${by("reject").length}: ${labels(by("reject"))} · more_info ${more.length}: reject-doc ${labels(more.filter((p) => morePick(p) === "reject-doc"))} / request-doc ${labels(more.filter((p) => morePick(p) === "request-doc"))} · leave ${leave.length} untouched: ${labels(leave)}`,
    `  approve: every document (the detail read after each), then verified / KYB verified · reject: the verdict first, then each document${options.passportReject ? ", then the wallet's passport request" : " (passport requests left; SIM_OWNER_PASSPORT_REJECT=1 rejects them)"} · more_info: the replacement is approved only once the user sent it`,
    `  applications ${apps.length}: needs_changes first, then approved ${labels(needs)} · ${rejectApp.length ? `rejected ${labels(rejectApp)} · ` : ""}approved ${labels(apps.filter((p) => !appPlan(p, options)!.first && appPlan(p, options)!.final === "approved"))}${options.appReject ? "" : ` (SIM_OWNER_APP_REJECT=1 rejects ${APP_REJECT_LABEL ?? "-"} instead)`}; no sale step (SIM issuers have no share class)`,
    `  OTC escrows ${otc.length}: ${otc.map((p) => `pair ${p.pair} ${p.label} (${p.variant === "maker" ? "seller" : "buyer"} requests)`).join(" · ")}: create_otc_deal signed by CekAgg, then the row flipped to created`,
    `  passports ${passports.length}: marked in review, then left for the KYC provider (approve_holder on ${DEVNET_PLATFORM_KYC_REGISTRY}): ${labels(passports)}`,
    `  owner queue (CekAgg cannot sign): ${passports.length} passports (the KYC provider) · ${kybVerified.length} verify_issuer_kyb (the super admin, optional): ${labels(kybVerified)}`,
    `  never touched: edge ${labels(edge)} · transfer pairs (cohort X) · the leave dossiers above`,
    "  order: KYB and KYC dossiers interleaved (approvals first), then applications, escrows, passport triage last; queued users pause their polls, manual waits poll every 10 min",
    `  budget ≈ ${writes} signed writes · ${reads} session reads · ${otc.length} transactions (≥ ${Math.ceil((writes * PACE.writeIntervalMs) / 60_000)} min of writes at 1/8 s)`,
    `  switches: SIM_OWNER_MAX=<n> (final decisions in this run, across restarts${options.max !== null ? `; now ${options.max}` : ""}) · SIM_OWNER_ONLY=<u029,u043> (a gated pass${options.only ? `; now ${options.only.join(",")}` : ""}) · SIM_OWNER_RETRY=1 (retry hand-backs)`,
  ];
  if (state) {
    const tasks = roster.filter((p) => dossierVerdict(p) || appPlan(p, options) || otcRequester(p) || passportTriage(p));
    const made = state.owner?.decisions ?? 0;
    lines.push(`  run ${state.runId}: ${made} decisions by the owner actor so far; per task:`);
    for (const p of tasks) if (state.users[p.label]) lines.push(`    ${p.label} [${p.cohort}/${p.variant}, review=${p.review}]: ${status(p)}`);
  }
  return lines.join("\n");
}
