/**
 * B: issuers (design-sim §1). Ten companies go through KYB (4 documents,
 * kyc.ts), register an issuer on-chain as /issuer/onboarding does
 * (register_issuer with a zero kybDocHash, legal id MANCI-SIM-<run>-<nnn>)
 * and save its profile (issuer-profiles.upsert). Five founders go through
 * individual KYC. Once the owner verified them, both file a launch
 * application and wait for its review:
 *
 *   issuer.register  account.wallets.transaction + register_issuer
 *   issuer.profile   issuer-profiles.upsert {profile:{issuer_pda, legal_entity_id, …}}
 *   app.submit       read-then-write (applications.mine) → applications.submit
 *                    (over-cap variant: first > €3M, expected 4xx)
 *   await.app        applications.mine every 2 min; needs_changes → app.resubmit
 */
import { SITE_ORIGIN } from "../constants";
import { applicationContent, simLegalId } from "../identity";
import type { UserState } from "../state";
import { actor, awaitOwner, finish, go, retry, walletPolicy, who, type SimCtx } from "./common";

type Application = { id?: string; status?: string; company_name?: string };
type Mine = { applications?: Application[] };

function appTask(u: UserState): string {
  const decision =
    u.plan.variant === "company-needs-changes"
      ? "needs_changes first; approve (or reject) after the resubmission"
      : "approve or reject (your call)";
  return `application ${u.data.applicationId ?? "?"} of ${u.plan.label}: ${SITE_ORIGIN}/admin/applications → ${decision}`;
}

async function readMine(ctx: SimCtx, u: UserState, step: string): Promise<Application[] | null> {
  const r = await ctx.http.read<Mine>(actor(ctx, u), { step, route: "/api/applications/mine", action: "applications.mine", params: {} });
  if (r.outcome !== "ok") {
    retry(ctx, u, `applications.mine ${r.status}`);
    return null;
  }
  return r.data?.applications ?? [];
}

export async function issuerStep(ctx: SimCtx, u: UserState): Promise<boolean> {
  const a = actor(ctx, u);
  const p = who(ctx, u);
  const flags = (u.data.flags ??= {});
  switch (u.stage) {
    case "issuer.register": {
      if (!u.tx["issuer.register"] && !(await walletPolicy(ctx, u, "issuer.register"))) return true;
      u.data.issuerPda = await ctx.chain.registerIssuer(u, a.signer, simLegalId(ctx.runId, u.plan.n), p.company.country);
      go(u, "issuer.profile");
      return true;
    }
    case "issuer.profile": {
      const r = await ctx.http.signed(a, {
        step: "issuer-profiles.upsert",
        route: "/api/issuer-profiles/upsert",
        action: "issuer-profiles.upsert",
        params: {
          profile: {
            issuer_pda: u.data.issuerPda,
            legal_entity_id: simLegalId(ctx.runId, u.plan.n),
            company_name: p.company.name,
            contact_email: p.email,
            website: p.company.website,
          },
        },
      });
      if (r.outcome !== "ok") return (retry(ctx, u, `issuer-profiles.upsert ${r.status}`), true);
      flags.profileSaved = true;
      go(u, "dossier.upload");
      return true;
    }
    case "app.submit": {
      const mine = await readMine(ctx, u, "applications.mine.before");
      if (!mine) return true;
      const live = mine.find((x) => x.status !== "rejected" && x.company_name === p.company.name);
      if (live?.id) {
        u.data.applicationId = live.id;
        u.data.applicationStatus = live.status;
        awaitOwner(ctx, u, "await.app", appTask(u));
        return true;
      }
      const founder = u.plan.variant === "founder";
      if (u.plan.variant === "company-over-cap" && !flags.overCapSent) {
        // Above the €3M yearly cap: narrowApplication / raise_capacity must refuse it (4xx).
        const r = await ctx.http.signed(a, {
          step: "applications.submit.over-cap",
          route: "/api/applications/submit",
          action: "applications.submit",
          params: { application: applicationContent(ctx.runId, p, 3_500_000) },
          expect: "4xx",
        });
        if (r.status !== 0 && r.status < 500) flags.overCapSent = true;
        return true;
      }
      const r = await ctx.http.signed<{ id?: string }>(a, {
        step: "applications.submit",
        route: "/api/applications/submit",
        action: "applications.submit",
        params: { application: applicationContent(ctx.runId, p), ...(founder ? { company_formation_requested: true } : {}) },
      });
      if (r.outcome !== "ok" || !r.data?.id) return (retry(ctx, u, `applications.submit ${r.status}`), true);
      u.data.applicationId = r.data.id;
      u.data.applicationStatus = "pending";
      awaitOwner(ctx, u, "await.app", appTask(u));
      return true;
    }
    case "await.app": {
      const mine = await readMine(ctx, u, "poll.applications.mine");
      if (!mine) return true;
      const row = mine.find((x) => x.id === u.data.applicationId);
      u.data.applicationStatus = row?.status;
      if (row?.status === "needs_changes") return (go(u, "app.resubmit"), true);
      if (row?.status === "approved" || row?.status === "rejected") return (finish(u, "done", `application ${row.status}`), true);
      awaitOwner(ctx, u, "await.app", appTask(u));
      return true;
    }
    case "app.resubmit": {
      const content = { ...applicationContent(ctx.runId, p), one_liner: `SIM-${String(u.plan.n).padStart(3, "0")} resubmitted after review — not a real offering` };
      const r = await ctx.http.signed(a, {
        step: "applications.resubmit",
        route: "/api/applications/resubmit",
        action: "applications.resubmit",
        params: { id: u.data.applicationId, application: content, ...(u.plan.variant === "founder" ? { company_formation_requested: true } : {}) },
      });
      if (r.outcome !== "ok") return (retry(ctx, u, `applications.resubmit ${r.status}`), true);
      awaitOwner(ctx, u, "await.app", appTask(u));
      return true;
    }
    default:
      return false;
  }
}
