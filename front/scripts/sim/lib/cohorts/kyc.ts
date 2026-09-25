/**
 * The dossier flow shared by K (KYC only), the KYC'd investors, the B
 * founders (individual KYC) and the B companies (KYB):
 *
 *   dossier.submit  verification.submit kind kyc|kyb (→ onboarding link)
 *   dossier.reqs    POST /api/clients/onboarding-requirements {client_id, token}
 *   dossier.upload  multipart POST /api/clients/upload, one requirement per step
 *   await.dossier   the owner reviews; polled every 2 min through the user's
 *                   own reads (clients.me, the requirements; eligibility for KYB)
 *
 * A requirement the owner rejects, or a new one request-docs adds, gets a
 * replacement file (round + 1) automatically. Variants: invalid fields first
 * (a 400, then the valid submit), PLEASE REJECT stamps, stop after one file.
 */
import { SITE_ORIGIN } from "../constants";
import { simDocument } from "../docs";
import { parseOnboardingPath } from "../http";
import { kybParams, kycParams } from "../identity";
import type { Requirement, UserState } from "../state";
import { actor, awaitOwner, finish, go, later, retry, who, type SimCtx } from "./common";

export function dossierKind(u: UserState): "kyc" | "kyb" {
  return u.plan.variant.startsWith("company") ? "kyb" : "kyc";
}

type SubmitData = { client_id?: string; kyc_status?: string; onboarding_path?: string | null };
type MeData = { client?: { id?: string; kyc_status?: string } | null; onboarding_path?: string | null };
type RequirementRow = { id?: number; doc_kind?: string; status?: string };
type Eligibility = { applicantKind?: string | null; kybStatus?: string | null; eligible?: boolean };

const TERMINAL_KYC = new Set(["rejected", "suspended"]);

function ownerTask(ctx: SimCtx, u: UserState): string {
  const base = `${SITE_ORIGIN}/admin/clients/${u.data.clientId ?? "?"}`;
  const kind = dossierKind(u);
  const review = u.plan.review;
  const verdict =
    review === "approve"
      ? kind === "kyb"
        ? "approve every document, then KYB decision = verified"
        : "approve every document, then set the dossier to verified"
      : review === "reject"
        ? "reject (documents are stamped PLEASE REJECT where planned)"
        : review === "more_info"
          ? "reject ONE document or request one more (request-docs); approve after the replacement arrives"
          : "leave it untouched";
  const passport = u.plan.variant === "buyer-kyc" && review !== "reject" ? "; then /admin/kyc → issue the passport" : "";
  return `${kind.toUpperCase()} ${who(ctx, u).displayName}: ${base} → ${verdict}${passport}`;
}

/** Where the flow continues once the owner verified the dossier. */
function afterVerified(ctx: SimCtx, u: UserState): void {
  if (u.plan.variant === "buyer-kyc") return awaitOwner(ctx, u, "await.passport", `KYC passport for ${u.wallet}: ${SITE_ORIGIN}/admin/kyc → issue passport (approve_holder)`);
  if (u.plan.cohort === "B") return go(u, "app.submit");
  finish(u, "done", "KYC verified");
}

function mergeRequirements(u: UserState, rows: RequirementRow[]): void {
  const known = new Map((u.data.requirements ?? []).map((r) => [r.id, r]));
  u.data.requirements = rows
    .filter((r): r is Required<RequirementRow> => typeof r.id === "number" && typeof r.doc_kind === "string" && typeof r.status === "string")
    .map((r) => ({ id: r.id, kind: r.doc_kind, status: r.status, uploadedRound: known.get(r.id)?.uploadedRound ?? 0 }));
}

/** Requirements the user still owes a file for (never uploaded, or sent back). */
export function owedRequirements(requirements: Requirement[] | undefined, round: number): Requirement[] {
  return (requirements ?? []).filter((r) => (r.status === "requested" || r.status === "rejected") && r.uploadedRound < round);
}

async function fetchRequirements(ctx: SimCtx, u: UserState, step: string): Promise<boolean> {
  const r = await ctx.http.post<{ requirements?: RequirementRow[] }>(actor(ctx, u), {
    step,
    route: "/api/clients/onboarding-requirements",
    body: { client_id: u.data.clientId, token: u.data.token },
  });
  if (r.status === 401) {
    // An expired or re-issued link: clients.me hands the owner of the wallet a fresh one.
    go(u, "dossier.link");
    return false;
  }
  if (r.outcome !== "ok" || !Array.isArray(r.data?.requirements)) {
    retry(ctx, u, `onboarding-requirements ${r.status}`);
    return false;
  }
  mergeRequirements(u, r.data.requirements);
  return true;
}

function takeLink(u: UserState, path: unknown): boolean {
  const link = parseOnboardingPath(path);
  if (!link) return false;
  u.data.clientId = link.clientId;
  u.data.token = link.token;
  return true;
}

export async function dossierStep(ctx: SimCtx, u: UserState): Promise<boolean> {
  const a = actor(ctx, u);
  const kind = dossierKind(u);
  const flags = (u.data.flags ??= {});
  switch (u.stage) {
    case "dossier.submit": {
      const p = who(ctx, u);
      const params = kind === "kyb" ? kybParams(p) : kycParams(p);
      if (u.plan.variant === "kyc-invalid-first" && !flags.invalidSent) {
        // A too-short phone and no postal code: the route must answer 400, then accept the fix.
        const r = await ctx.http.signed(a, {
          step: "verification.submit.invalid",
          route: "/api/verification/submit",
          action: "verification.submit",
          params: { ...params, phone: "12", postal_code: "" },
          expect: 400,
        });
        if (r.status !== 0 && r.status < 500) flags.invalidSent = true;
        return true;
      }
      const r = await ctx.http.signed<SubmitData>(a, {
        step: `verification.submit.${kind}`,
        route: "/api/verification/submit",
        action: "verification.submit",
        params,
      });
      if (r.outcome !== "ok") return (retry(ctx, u, `verification.submit ${r.status}`), true);
      u.data.kycStatus = r.data?.kyc_status;
      u.data.round = 1;
      if (takeLink(u, r.data?.onboarding_path)) go(u, "dossier.reqs");
      else go(u, "dossier.link");
      return true;
    }
    case "dossier.link": {
      const r = await ctx.http.read<MeData>(a, { step: "clients.me.link", route: "/api/clients/me", action: "clients.me", params: {} });
      if (r.outcome !== "ok") return (retry(ctx, u, `clients.me ${r.status}`), true);
      const status = r.data?.client?.kyc_status;
      if (status && TERMINAL_KYC.has(status)) return (finish(u, "rejected", `dossier ${status}`), true);
      if (takeLink(u, r.data?.onboarding_path)) go(u, "dossier.reqs");
      else awaitOwner(ctx, u, "await.dossier", ownerTask(ctx, u));
      return true;
    }
    case "dossier.reqs": {
      if (!(await fetchRequirements(ctx, u, "onboarding-requirements"))) return true;
      go(u, "dossier.upload");
      return true;
    }
    case "dossier.upload": {
      const round = u.data.round ?? 1;
      const next = owedRequirements(u.data.requirements, round)[0];
      if (!next) {
        // A company registers its issuer on-chain and saves its profile once, after its files.
        if (kind === "kyb" && !flags.profileSaved) return (go(u, "issuer.register"), true);
        awaitOwner(ctx, u, "await.dossier", ownerTask(ctx, u));
        return true;
      }
      const doc = simDocument({ runId: ctx.runId, n: u.plan.n, kind: next.kind, round, reject: u.plan.review === "reject" });
      const r = await ctx.http.upload(a, {
        step: `upload.${next.kind}`,
        fields: { client_id: u.data.clientId ?? "", token: u.data.token ?? "", kind: next.kind, requirement_id: String(next.id) },
        file: doc,
      });
      if (r.status === 401) return (go(u, "dossier.link"), true);
      if (r.outcome !== "ok") return (retry(ctx, u, `upload ${r.status}`), true);
      next.uploadedRound = round;
      next.status = "submitted";
      u.attempts = 0;
      if (u.plan.variant === "kyc-stop-after-one") return (finish(u, "stopped", "stopped after one document (variant)"), true);
      return true;
    }
    case "await.dossier":
      await pollDossier(ctx, u);
      return true;
    default:
      return false;
  }
}

/** One owner-wait poll: the user's own reads only. */
async function pollDossier(ctx: SimCtx, u: UserState): Promise<void> {
  const a = actor(ctx, u);
  const kind = dossierKind(u);
  u.data.pollCount = (u.data.pollCount ?? 0) + 1;
  const me = await ctx.http.read<MeData>(a, { step: "poll.clients.me", route: "/api/clients/me", action: "clients.me", params: {} });
  if (me.outcome !== "ok") return retry(ctx, u, `clients.me ${me.status}`);
  const status = me.data?.client?.kyc_status ?? null;
  u.data.kycStatus = status ?? undefined;
  takeLink(u, me.data?.onboarding_path);
  if (status && TERMINAL_KYC.has(status)) return finish(u, "rejected", `dossier ${status}`);
  if (kind === "kyc" && status === "verified") return afterVerified(ctx, u);
  if (kind === "kyb") {
    const el = await ctx.http.post<Eligibility>(a, { step: "poll.eligibility", route: "/api/applications/eligibility", body: { wallet: u.wallet } });
    if (el.outcome === "ok") {
      if (el.data?.applicantKind === "company") return go(u, "app.submit");
      if (el.data?.kybStatus === "rejected") return finish(u, "rejected", "KYB rejected");
    }
  }
  // A rejected document leaves the dossier's status as it was (the recompute only
  // moves more_info → pending), so the requirements are read on every poll.
  if (status !== "verified" && u.data.token) {
    if (!(await fetchRequirements(ctx, u, "poll.requirements"))) return;
    const round = u.data.round ?? 1;
    const owed = (u.data.requirements ?? []).filter((r) => r.status === "requested" || r.status === "rejected");
    if (owed.length) {
      // A rejected file or a new request: upload replacements (next round).
      if (owed.every((r) => r.uploadedRound >= round)) u.data.round = round + 1;
      return go(u, "dossier.upload");
    }
  }
  awaitOwner(ctx, u, "await.dossier", ownerTask(ctx, u));
  later(ctx, u, 120_000);
}
