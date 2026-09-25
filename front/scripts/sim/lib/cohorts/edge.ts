/**
 * E: deliberately bad requests, each with the status the site must answer
 * (design-sim §1 "Edge cases"). Any 5xx here is a bug; any 2xx is a hole.
 * Eight users split the cases into groups; each advance runs one case.
 * Groups 5 and 6 first open a KYC dossier (left untouched by the owner) so
 * their uploads carry a real onboarding token.
 */
import { signBytes } from "@solana/kit";
import { TOS_VERSION } from "@/lib/tos-version";
import { SITE_ORIGIN } from "../constants";
import { edgeFile } from "../docs";
import { buildPayload, parseOnboardingPath, signEnvelope, type Expect } from "../http";
import { kycParams } from "../identity";
import type { UserState } from "../state";
import { actor, finish, later, note, retry, who, type SimCtx } from "./common";

type EdgeCase = { id: string; expect: string; needsDossier?: boolean; run: (ctx: SimCtx, u: UserState) => Promise<boolean> };

const ME = { route: "/api/clients/me", action: "clients.me" } as const;

function yearsAgo(years: number): string {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - years);
  d.setUTCDate(d.getUTCDate() + 7); // a week short of the birthday
  return d.toISOString().slice(0, 10);
}

/** Sends an already signed body verbatim (replays, tampering). */
async function sendBody(ctx: SimCtx, u: UserState, step: string, route: string, action: string, body: unknown, expect: Expect, headers?: Record<string, string>) {
  return ctx.http.request(actor(ctx, u), { step, route, action, method: "POST", body: JSON.stringify(body), headers, classes: ["write"], expect });
}

export const EDGE_CASES: Record<string, EdgeCase> = {
  "nonce-replay": {
    id: "nonce-replay",
    expect: "200 then 401",
    run: async (ctx, u) => {
      const a = actor(ctx, u);
      const body = await signEnvelope(a.signer, buildPayload({ action: ME.action, wallet: u.wallet, params: {} }));
      await sendBody(ctx, u, "edge.nonce-replay.first", ME.route, ME.action, body, 200);
      await sendBody(ctx, u, "edge.nonce-replay.replay", ME.route, ME.action, body, 401);
      return true;
    },
  },
  "nonce-replay-write": {
    id: "nonce-replay-write",
    expect: "200 then 401",
    run: async (ctx, u) => {
      const a = actor(ctx, u);
      const body = await signEnvelope(a.signer, buildPayload({ action: "tos.accept", wallet: u.wallet, params: { version: TOS_VERSION } }));
      await sendBody(ctx, u, "edge.nonce-replay-write.first", "/api/tos/accept", "tos.accept", body, 200);
      await sendBody(ctx, u, "edge.nonce-replay-write.replay", "/api/tos/accept", "tos.accept", body, 401);
      return true;
    },
  },
  "stale-ts": {
    id: "stale-ts",
    expect: "401",
    run: async (ctx, u) => {
      const ts = new Date(ctx.now() - 400_000).toISOString();
      await ctx.http.signed(actor(ctx, u), { step: "edge.stale-ts", ...ME, params: {}, payload: { ts }, expect: 401, classes: ["write"] });
      return true;
    },
  },
  "wrong-origin": {
    id: "wrong-origin",
    expect: "401",
    run: async (ctx, u) => {
      await ctx.http.signed(actor(ctx, u), { step: "edge.wrong-origin", ...ME, params: {}, payload: { origin: "https://manci.io" }, expect: 401, classes: ["write"] });
      return true;
    },
  },
  "wrong-origin-write": {
    id: "wrong-origin-write",
    expect: "401",
    run: async (ctx, u) => {
      await ctx.http.signed(actor(ctx, u), {
        step: "edge.wrong-origin-write",
        route: "/api/account/update",
        action: "account.update",
        params: { display_name: who(ctx, u).displayName, account_id: u.data.accountId },
        payload: { origin: "https://preview.manci.io" },
        expect: 401,
      });
      return true;
    },
  },
  "origin-header": {
    id: "origin-header",
    expect: "401",
    run: async (ctx, u) => {
      await ctx.http.signed(actor(ctx, u), { step: "edge.origin-header", ...ME, params: {}, headers: { Origin: "https://evil.example" }, expect: 401, classes: ["write"] });
      return true;
    },
  },
  "wrong-network": {
    id: "wrong-network",
    expect: "401",
    run: async (ctx, u) => {
      await ctx.http.signed(actor(ctx, u), { step: "edge.wrong-network", ...ME, params: {}, payload: { network: "mainnet" }, expect: 401, classes: ["write"] });
      return true;
    },
  },
  "bad-signature": {
    id: "bad-signature",
    expect: "401",
    run: async (ctx, u) => {
      const a = actor(ctx, u);
      // A real signature, but over different bytes than the payload's message.
      const wrong = await signBytes(a.signer.keyPair.privateKey, new TextEncoder().encode("mancipatio:v2:{}"));
      await ctx.http.signed(a, {
        step: "edge.bad-signature",
        ...ME,
        params: {},
        mutate: (body) => ({ ...body, signature: Buffer.from(wrong).toString("base64") }),
        expect: 401,
        classes: ["write"],
      });
      return true;
    },
  },
  "unsigned-reader": {
    id: "unsigned-reader",
    expect: "400",
    run: async (ctx, u) => {
      await ctx.http.post(actor(ctx, u), { step: "edge.unsigned-reader", route: ME.route, body: {}, expect: 400, classes: ["write"] });
      return true;
    },
  },
  "oversize-4k": {
    id: "oversize-4k",
    expect: "413",
    run: async (ctx, u) => {
      await ctx.http.signed(actor(ctx, u), {
        step: "edge.oversize-4k",
        route: "/api/account/update",
        action: "account.update",
        params: { display_name: "SIM-".padEnd(5_000, "x"), account_id: u.data.accountId },
        expect: 413,
      });
      return true;
    },
  },
  "oversize-8k": {
    id: "oversize-8k",
    expect: "413",
    run: async (ctx, u) => {
      await ctx.http.signed(actor(ctx, u), {
        step: "edge.oversize-8k",
        route: "/api/verification/submit",
        action: "verification.submit",
        params: { ...kycParams(who(ctx, u)), address_line: "Test ulica ".padEnd(9_000, "x") },
        expect: 413,
      });
      return true;
    },
  },
  "account-me-param": {
    id: "account-me-param",
    expect: "400",
    run: async (ctx, u) => {
      await ctx.http.signed(actor(ctx, u), { step: "edge.account-me-param", route: "/api/account/me", action: "account.me", params: { foo: 1 }, expect: 400, classes: ["write"] });
      return true;
    },
  },
  "age-17": {
    id: "age-17",
    expect: "400",
    run: async (ctx, u) => {
      await ctx.http.signed(actor(ctx, u), {
        step: "edge.age-17",
        route: "/api/verification/submit",
        action: "verification.submit",
        params: { ...kycParams(who(ctx, u)), date_of_birth: yearsAgo(17) },
        expect: 400,
      });
      return true;
    },
  },
  "country-outside": {
    id: "country-outside",
    expect: "400",
    run: async (ctx, u) => {
      // 840 (United States) is not in the default approved set.
      await ctx.http.signed(actor(ctx, u), {
        step: "edge.country-outside",
        route: "/api/verification/submit",
        action: "verification.submit",
        params: { ...kycParams(who(ctx, u)), residence_country: 840 },
        expect: 400,
      });
      return true;
    },
  },
  "unknown-field": {
    id: "unknown-field",
    expect: "400",
    run: async (ctx, u) => {
      await ctx.http.signed(actor(ctx, u), {
        step: "edge.unknown-field",
        route: "/api/verification/submit",
        action: "verification.submit",
        params: { ...kycParams(who(ctx, u)), ssn: "000-00-0000" },
        expect: 400,
      });
      return true;
    },
  },
  "session-write": {
    id: "session-write",
    expect: "401",
    run: async (ctx, u) => {
      const a = actor(ctx, u);
      if (!ctx.http.hasSession(u.plan.label)) await ctx.http.startSession(a, "edge.session-write.session");
      if (!ctx.http.sessionsEnabled) return true;
      // A write on the read-only session cookie must be refused.
      await ctx.http.sessionOnly(a, { step: "edge.session-write", route: "/api/tos/accept", action: "tos.accept", params: { version: TOS_VERSION }, expect: 401 });
      return true;
    },
  },
  "wrong-action": {
    id: "wrong-action",
    expect: "401",
    run: async (ctx, u) => {
      await ctx.http.signed(actor(ctx, u), { step: "edge.wrong-action", route: "/api/account/update", action: "account.me", params: {}, expect: 401, classes: ["write"] });
      return true;
    },
  },
  "tos-wrong-version": {
    id: "tos-wrong-version",
    expect: "400",
    run: async (ctx, u) => {
      await ctx.http.signed(actor(ctx, u), { step: "edge.tos-wrong-version", route: "/api/tos/accept", action: "tos.accept", params: { version: "1999-01-01" }, expect: 400 });
      return true;
    },
  },
  "upload-txt": { id: "upload-txt", expect: "400", needsDossier: true, run: (ctx, u) => badUpload(ctx, u, "upload-txt", "txt", 400) },
  "upload-heic": { id: "upload-heic", expect: "400", needsDossier: true, run: (ctx, u) => badUpload(ctx, u, "upload-heic", "heic", 400) },
  "upload-empty": { id: "upload-empty", expect: "400", needsDossier: true, run: (ctx, u) => badUpload(ctx, u, "upload-empty", "empty", 400) },
  // Vercel refuses bodies above 4.5 MB before the route's own 15 MB check.
  "upload-5mb": { id: "upload-5mb", expect: "413", needsDossier: true, run: (ctx, u) => badUpload(ctx, u, "upload-5mb", "oversize", 413) },
  "upload-bad-token": {
    id: "upload-bad-token",
    expect: "401",
    needsDossier: true,
    run: async (ctx, u) => {
      const file = edgeFile("txt", ctx.runId, u.plan.n);
      await ctx.http.upload(actor(ctx, u), {
        step: "edge.upload-bad-token",
        fields: { client_id: u.data.clientId ?? "", token: "not-the-token", kind: "passport" },
        file: { ...file, type: "application/pdf", name: "sim-bad-token.pdf" },
        expect: 401,
      });
      return true;
    },
  },
  "record-foreign-tx": {
    id: "record-foreign-tx",
    expect: "4xx",
    run: async (ctx, u) => {
      // Someone else's settled purchase, claimed as this wallet's.
      const other = Object.values(ctx.state.users).find((o) => o.plan.label !== u.plan.label && o.data.buySig && o.data.sale);
      if (!other) {
        u.data.pollCount = (u.data.pollCount ?? 0) + 1;
        if (u.data.pollCount > 60) {
          note(ctx, u, "edge.record-foreign-tx", "skipped: no other user's purchase within an hour");
          return true;
        }
        later(ctx, u, 60_000);
        return false;
      }
      await ctx.http.signed(actor(ctx, u), {
        step: "edge.record-foreign-tx",
        route: "/api/launchpad/record-purchase",
        action: "launchpad.recordPurchase",
        params: { sale_pubkey: other.data.sale, investor_wallet: u.wallet, settled_tx: other.data.buySig },
        expect: "4xx",
      });
      return true;
    },
  },
  "otc-self": { id: "otc-self", expect: "400", run: (ctx, u) => otcBad(ctx, u, "otc-self", { buyer_wallet: u.wallet }) },
  "otc-zero": { id: "otc-zero", expect: "400", run: (ctx, u) => otcBad(ctx, u, "otc-zero", { amount: 0 }) },
};

async function badUpload(ctx: SimCtx, u: UserState, id: string, kind: "txt" | "heic" | "empty" | "oversize", expect: number): Promise<boolean> {
  const file = edgeFile(kind, ctx.runId, u.plan.n);
  await ctx.http.upload(actor(ctx, u), {
    step: `edge.${id}`,
    fields: { client_id: u.data.clientId ?? "", token: u.data.token ?? "", kind: "passport" },
    file,
    expect,
  });
  return true;
}

async function otcBad(ctx: SimCtx, u: UserState, id: string, override: Record<string, unknown>): Promise<boolean> {
  const counterparty = Object.values(ctx.state.users).find((o) => o.plan.label !== u.plan.label)?.wallet ?? ctx.market.paymentMint;
  await ctx.http.signed(actor(ctx, u), {
    step: `edge.${id}`,
    route: "/api/otc/create",
    action: "otc.create",
    params: {
      share_class_pda: ctx.market.classA,
      mint: ctx.market.mintA,
      asset_label: "SIM edge case",
      seller_wallet: u.wallet,
      buyer_wallet: counterparty,
      amount: 1,
      price: 1,
      payment_mint: ctx.market.paymentMint,
      ...override,
    },
    expect: 400,
  });
  return true;
}

/** Cases per edge group (1 is the pilot's). */
export const EDGE_GROUPS: Record<number, string[]> = {
  1: ["nonce-replay", "stale-ts", "wrong-origin", "unknown-field", "age-17", "otc-self"],
  2: ["origin-header", "wrong-network", "bad-signature", "unsigned-reader"],
  3: ["oversize-4k", "oversize-8k", "account-me-param"],
  4: ["country-outside", "session-write", "wrong-action", "tos-wrong-version"],
  5: ["upload-txt", "upload-heic", "upload-bad-token"],
  6: ["upload-empty", "upload-5mb"],
  7: ["record-foreign-tx", "otc-zero"],
  8: ["nonce-replay-write", "wrong-origin-write"],
};

export async function edgeStep(ctx: SimCtx, u: UserState): Promise<boolean> {
  if (u.stage !== "edge" && u.stage !== "edge.dossier") return false;
  const cases = EDGE_GROUPS[u.plan.edgeGroup ?? 1] ?? [];
  const done = (u.data.edgeDone ??= []);
  const next = cases.find((c) => !done.includes(c));
  if (!next) return (finish(u, "done", `edge cases: ${cases.join(", ")}`), true);
  const spec = EDGE_CASES[next];
  if (spec.needsDossier && !u.data.token) {
    // A real dossier (never reviewed) so the uploads carry a valid onboarding token.
    u.stage = "edge.dossier";
    const r = await ctx.http.signed<{ onboarding_path?: string | null }>(actor(ctx, u), {
      step: "verification.submit.edge",
      route: "/api/verification/submit",
      action: "verification.submit",
      params: kycParams(who(ctx, u)),
    });
    const link = parseOnboardingPath(r.data?.onboarding_path);
    if (r.outcome !== "ok" || !link) return (retry(ctx, u, `verification.submit ${r.status}`), true);
    u.data.clientId = link.clientId;
    u.data.token = link.token;
    u.ownerTask = `edge dossier ${SITE_ORIGIN}/admin/clients/${link.clientId}: leave it untouched (or reject)`;
    return true;
  }
  u.stage = "edge";
  if (await spec.run(ctx, u)) done.push(next);
  return true;
}
