/**
 * What every cohort machine shares (design-sim §1): the run context, the
 * stage helpers, and the account setup every user goes through first:
 *
 *   auth.session → account.me (keeps profile.id) → account.update
 *   ("SIM-017 …", account_id) → tos.accept (TOS_VERSION)
 *
 * A machine advances one user by ONE step per call (one request or one
 * transaction) and leaves the next stage, a backoff (`notBefore`) or an
 * owner wait in the user's state. The scheduler persists after every call.
 */
import type { Address, KeyPairSigner } from "@solana/kit";
import { TOS_VERSION } from "@/lib/tos-version";
import { PACE } from "../constants";
import type { ChainOps } from "../chain";
import type { Actor, SimHttp } from "../http";
import { person, type Person } from "../identity";
import type { JournalSink } from "../journal";
import type { SimState, Terminal, UserState } from "../state";

export type MarketView = {
  /** [0]: the sale for KYC'd investors; [1]: no-KYC buyers and traders. */
  sales: string[];
  asset: Address;
  classA: Address;
  mintA: Address;
  paymentMint: Address;
  /** False while /api/launchpad/terms answers 409 (no published whitepaper). */
  termsOk: boolean;
};

export type SimCtx = {
  runId: string;
  state: SimState;
  http: SimHttp;
  chain: ChainOps;
  journal: JournalSink;
  market: MarketView;
  signer: (label: string) => KeyPairSigner;
  now: () => number;
  persist: () => void;
  log: (line: string) => void;
  /** Passport lookup for a waiting investor (batched chain read, cached per watch cycle). */
  passport: (wallet: string) => Promise<boolean | null>;
};

export const RETRY_MS = 60_000;
export const MAX_ATTEMPTS = 3;
/** Consistency window: the UI/DB must reflect a write within 3 minutes. */
export const CONSISTENCY_MS = 180_000;

export function actor(ctx: SimCtx, u: UserState): Actor {
  return { label: u.plan.label, cohort: u.plan.cohort, wave: u.plan.wave, signer: ctx.signer(u.plan.label) };
}

export function who(ctx: SimCtx, u: UserState): Person {
  return person(ctx.runId, u.plan.n);
}

/** Moves to the next stage now. */
export function go(u: UserState, stage: string): void {
  u.stage = stage;
  u.attempts = 0;
  u.awaitingOwner = false;
  u.ownerTask = undefined;
  u.notBefore = 0;
}

export function later(ctx: SimCtx, u: UserState, ms: number): void {
  u.notBefore = ctx.now() + ms;
}

/** Parks the user until the owner acts; polled every watch interval (2 min). */
export function awaitOwner(ctx: SimCtx, u: UserState, stage: string, task: string): void {
  if (u.stage !== stage) u.attempts = 0;
  u.stage = stage;
  u.awaitingOwner = true;
  u.ownerTask = task;
  u.notBefore = ctx.now() + PACE.watchIntervalMs;
}

export function finish(u: UserState, terminal: Terminal, reason?: string): void {
  u.stage = terminal;
  u.terminal = terminal;
  u.awaitingOwner = false;
  u.ownerTask = undefined;
  u.reason = reason;
}

/** An unexpected result: back off and retry, or give up after MAX_ATTEMPTS. */
export function retry(ctx: SimCtx, u: UserState, reason: string): void {
  u.attempts += 1;
  if (u.attempts >= MAX_ATTEMPTS) {
    finish(u, "failed", `${u.stage}: ${reason}`);
    return;
  }
  later(ctx, u, RETRY_MS * u.attempts);
}

/** A consistency or lag finding (design-sim §6), or a passed check with `ok`. */
export function check(ctx: SimCtx, u: UserState, step: string, ok: boolean, detail: string): void {
  ctx.journal.append({
    wave: u.plan.wave,
    user: u.plan.label,
    cohort: u.plan.cohort,
    step,
    kind: "check",
    outcome: ok ? "ok" : "consistency",
    err: ok ? undefined : detail,
    body: ok ? detail : undefined,
  });
}

export function note(ctx: SimCtx, u: UserState, step: string, detail: string): void {
  ctx.journal.append({ wave: u.plan.wave, user: u.plan.label, cohort: u.plan.cohort, step, kind: "note", outcome: "info", body: detail });
}

/** The entry stage after the account setup. */
export function entryStage(u: UserState): string {
  const v = u.plan.variant;
  if (u.plan.cohort === "E") return "edge";
  if (v === "buyer-nokyc" || u.plan.cohort === "T") return "buy.terms";
  return "dossier.submit";
}

type AccountData = { profile?: { id?: string; primary_wallet?: string } };

/** The four account-setup stages. Returns false when the stage is not one of them. */
export async function setupStep(ctx: SimCtx, u: UserState): Promise<boolean> {
  const a = actor(ctx, u);
  switch (u.stage) {
    case "session": {
      const r = await ctx.http.startSession(a);
      if (r.outcome === "ok" || r.status === 503) go(u, "me");
      else retry(ctx, u, `auth.session ${r.status}`);
      return true;
    }
    case "me": {
      const r = await ctx.http.read<AccountData>(a, { step: "account.me", route: "/api/account/me", action: "account.me", params: {} });
      const id = r.data?.profile?.id;
      if (r.outcome !== "ok" || typeof id !== "string") return (retry(ctx, u, `account.me ${r.status}`), true);
      u.data.accountId = id;
      // Every simulated wallet becomes the primary wallet of its own account.
      check(ctx, u, "account.me.primary", r.data?.profile?.primary_wallet === u.wallet, "profile.primary_wallet is not the signing wallet");
      go(u, "name");
      return true;
    }
    case "name": {
      const r = await ctx.http.signed(a, {
        step: "account.update",
        route: "/api/account/update",
        action: "account.update",
        params: { display_name: who(ctx, u).displayName, account_id: u.data.accountId },
      });
      if (r.outcome === "ok") go(u, "tos");
      else retry(ctx, u, `account.update ${r.status}`);
      return true;
    }
    case "tos": {
      const r = await ctx.http.signed(a, { step: "tos.accept", route: "/api/tos/accept", action: "tos.accept", params: { version: TOS_VERSION } });
      if (r.outcome === "ok") go(u, entryStage(u));
      else retry(ctx, u, `tos.accept ${r.status}`);
      return true;
    }
    default:
      return false;
  }
}

type WalletPolicy = { wallet?: string; network?: string; account_id?: string; primary_wallet?: string };

/**
 * The pre-send policy read the UI runs before every on-chain send
 * (lib/transaction-wallet-policy.ts). False when the site refuses the send.
 */
export async function walletPolicy(ctx: SimCtx, u: UserState, step: string): Promise<boolean> {
  const r = await ctx.http.read<WalletPolicy>(actor(ctx, u), {
    step: `${step}.policy`,
    route: "/api/account/wallets/transaction",
    action: "account.wallets.transaction",
    params: {},
  });
  if (r.outcome !== "ok") {
    retry(ctx, u, `account.wallets.transaction ${r.status}`);
    return false;
  }
  const ok = r.data?.wallet === u.wallet && r.data?.primary_wallet === u.wallet && r.data?.network === "devnet";
  check(ctx, u, `${step}.policy`, ok, "wallet policy does not name this wallet as the primary devnet wallet");
  if (!ok) retry(ctx, u, "the wallet policy refused this wallet");
  return ok;
}
