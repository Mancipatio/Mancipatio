import type { NextConfig } from "next";
// The runtime imports: the operator and legal slots, the modules the mainnet
// Terms offer, and (8.5) the geoblock list's parser, by relative path.
// lib/legal/* is directive-free and imports nothing but its siblings,
// lib/geoblock.ts only lib/countries.ts (which imports nothing), so Next's
// next.config.ts loader (SWC with its require hook) compiles them like this
// file; no package and no `@/` alias is loaded here.
import {
  MAINNET_LEGAL_SLOTS,
  MAINNET_LICENSE_WAIVER,
  mainnetLegalProblems,
  type MainnetLegalSlots,
} from "./lib/legal/readiness";
import type { TermsDocument, TermsModule } from "./lib/legal/document";
import { MAINNET_TERMS } from "./lib/legal/mainnet-copy";
import { GEOBLOCK_ENV, parseGeoblockList } from "./lib/geoblock";

// `next build`'s phase (next/constants PHASE_PRODUCTION_BUILD). Spelled out
// rather than imported so this file loads no package at config time.
const PHASE_PRODUCTION_BUILD = "phase-production-build";

const NETWORKS = ["mainnet", "devnet", "testnet", "localnet"];

/**
 * The devnet Terms of Service and Privacy Policy
 * (app/(marketing)/legal/{terms,privacy}/devnet-*.tsx) carry the devnet-pilot
 * wording ("The current release runs on Solana devnet. No real assets are
 * tokenized…"). A mainnet build renders counsel's mainnet texts from
 * lib/legal/mainnet-copy.ts instead, and assertBuildMainnetLegal refuses it
 * while those slots, the operator record or the licence are incomplete. On
 * top of that a mainnet build needs MAINNET_LEGAL_COPY_APPROVED=true: a
 * person's assertion that counsel reviewed the pages as rendered (Terms,
 * Privacy, /legal/company, the risk warning). Build-time only (not
 * NEXT_PUBLIC_): nothing at runtime reads it.
 */
const MAINNET_LEGAL_ACK = "MAINNET_LEGAL_COPY_APPROVED";

/**
 * The network a build with `env` runs as: lib/network.ts detectNetwork()'s
 * rule, spelled out because this file takes no `@/` imports (a test keeps the
 * two equal). An explicit NEXT_PUBLIC_NETWORK wins (returned as given, even
 * when invalid: assertBuildNetwork refuses that); otherwise the RPC URL
 * decides, and devnet is the fallback.
 */
export function buildNetwork(env: Record<string, string | undefined>): string {
  const explicit = env.NEXT_PUBLIC_NETWORK?.trim().toLowerCase() ?? "";
  if (explicit) return explicit;
  const rpc = env.NEXT_PUBLIC_SOLANA_RPC_URL ?? "";
  if (rpc.includes("devnet")) return "devnet";
  if (rpc.includes("testnet")) return "testnet";
  if (rpc.includes("mainnet")) return "mainnet";
  if (rpc.includes("localhost") || rpc.includes("127.0.0.1")) return "localnet";
  return "devnet";
}

/**
 * NEXT_PUBLIC_NETWORK must be explicit in a deployed build. lib/network.ts
 * falls back to sniffing NEXT_PUBLIC_SOLANA_RPC_URL (and then to devnet) when
 * it is unset — convenient locally, but on Vercel it would silently ship a
 * build that points at the wrong cluster and says "devnet" or "mainnet" on the
 * strength of a URL substring. So:
 *   - any production build with a set-but-invalid value fails (the app would
 *     throw at runtime anyway);
 *   - a production build ON VERCEL (VERCEL=1 or VERCEL_ENV set — Production
 *     and Preview alike) also fails when the variable is unset.
 *   - a production build ANYWHERE fails when the variable is unset but the
 *     RPC URL would make it run as mainnet (buildNetwork): every mainnet
 *     guard here keys on NEXT_PUBLIC_NETWORK=mainnet, so a mainnet build must
 *     say so;
 *   - a MAINNET production build (anywhere) also fails unless
 *     MAINNET_LEGAL_COPY_APPROVED=true — see MAINNET_LEGAL_ACK below.
 * Local devnet/testnet/localnet builds, CI (which sets
 * NEXT_PUBLIC_NETWORK=devnet), `next dev` and tests are unaffected.
 */
export function assertBuildNetwork(
  phase: string,
  env: Record<string, string | undefined> = process.env,
): void {
  if (phase !== PHASE_PRODUCTION_BUILD) return;
  const raw = env.NEXT_PUBLIC_NETWORK;
  const value = raw?.trim().toLowerCase() ?? "";
  if (value && !NETWORKS.includes(value)) {
    throw new Error(
      `NEXT_PUBLIC_NETWORK="${raw}" is invalid. Use one of: ${NETWORKS.join(", ")}.`,
    );
  }
  const onVercel = env.VERCEL === "1" || Boolean(env.VERCEL_ENV);
  if (onVercel && !value) {
    throw new Error(
      `NEXT_PUBLIC_NETWORK is not set for this Vercel build (VERCEL_ENV=${env.VERCEL_ENV ?? "unset"}). ` +
        `Set it explicitly (${NETWORKS.join(" | ")}) in the Vercel project's Environment Variables ` +
        "for this environment — the build refuses to guess the network from the RPC URL.",
    );
  }
  if (!value && buildNetwork(env) === "mainnet") {
    throw new Error(
      "Refusing a production build that would run as mainnet (NEXT_PUBLIC_SOLANA_RPC_URL) without " +
        "NEXT_PUBLIC_NETWORK=mainnet: set it explicitly, so the mainnet build checks run.",
    );
  }
  if (value === "mainnet" && env[MAINNET_LEGAL_ACK]?.trim() !== "true") {
    throw new Error(
      `Refusing a mainnet build: set ${MAINNET_LEGAL_ACK}=true only after counsel has reviewed the ` +
        "rendered mainnet pages (Terms of Service, Privacy Policy, /legal/company, the purchase risk " +
        "warning; their texts are in lib/legal/). See ops/runbook-mainnet.md §17.",
    );
  }
}

/**
 * A MAINNET production build also needs the operator and legal slots complete
 * (lib/legal/readiness.ts): the operator record with its registration details,
 * governing law and forum; the licence, or MAINNET_LICENSE_NOT_REQUIRED=true
 * on counsel's written opinion; counsel's mainnet Terms, Privacy Policy and
 * acceptance-dialog summary with no devnet wording; and counsel's purchase
 * risk warning. The error lists every missing item. Other networks, `next
 * dev` and tests are unaffected.
 */
export function assertBuildMainnetLegal(
  phase: string,
  env: Record<string, string | undefined> = process.env,
  slots: MainnetLegalSlots = MAINNET_LEGAL_SLOTS,
): void {
  if (phase !== PHASE_PRODUCTION_BUILD) return;
  // The runtime's rule (buildNetwork), not only the explicit variable: a
  // build that would run as mainnet is checked even if assertBuildNetwork
  // were bypassed.
  if (buildNetwork(env) !== "mainnet") return;
  const problems = mainnetLegalProblems(env, slots);
  if (problems.length === 0) return;
  throw new Error(
    `Refusing a mainnet build: the operator and legal slots are not complete (lib/legal/, ${MAINNET_LICENSE_WAIVER}):\n` +
      problems.map((problem) => `  - ${problem}`).join("\n"),
  );
}

/**
 * The Supabase project each network's deployments use. Embedded (this file
 * takes no runtime imports) and kept equal to the projectRef fields of
 * scripts/ops/targets.json by tests/build-network-guard.test.ts. Mainnet is
 * null until its project exists (Talas 7).
 */
export const SUPABASE_PROJECT_REFS: Readonly<Record<"devnet" | "mainnet", string | null>> = {
  devnet: "gvnckuzmuwozlcohtuhx",
  mainnet: "nyltnheatubqmtdanlrr",
};

/**
 * A production build must point at its own network's Supabase project
 * (NEXT_PUBLIC_SUPABASE_URL = https://<ref>.supabase.co):
 *   - a MAINNET build fails unless the mainnet ref is recorded, the URL is that
 *     project's, and NEXT_PUBLIC_SUPABASE_ANON_KEY is a publishable key
 *     (sb_publishable_…; D13 keeps the variable name);
 *   - a devnet build that sets the URL must use the recorded devnet project;
 *   - no other build may use the mainnet project. A testnet or localnet build
 *     may share the devnet project (D8).
 * Non-mainnet builds without the URL (local, CI), `next dev` and tests are
 * unaffected.
 */
export function assertBuildSupabase(
  phase: string,
  env: Record<string, string | undefined> = process.env,
  refs: Readonly<Record<"devnet" | "mainnet", string | null>> = SUPABASE_PROJECT_REFS,
): void {
  if (phase !== PHASE_PRODUCTION_BUILD) return;
  const network = env.NEXT_PUBLIC_NETWORK?.trim().toLowerCase() ?? "";
  const raw = env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const ref = /^https:\/\/([a-z0-9]{20})\.supabase\.co\/?$/.exec(raw)?.[1] ?? null;
  const { mainnet: mainnetRef, devnet: devnetRef } = refs;
  if (network === "mainnet") {
    if (!mainnetRef) {
      throw new Error(
        "Refusing a mainnet build: no mainnet Supabase project is recorded (SUPABASE_PROJECT_REFS in " +
          "next.config.ts and scripts/ops/targets.json).",
      );
    }
    if (ref !== mainnetRef) {
      throw new Error(
        `Refusing a mainnet build: NEXT_PUBLIC_SUPABASE_URL must be https://${mainnetRef}.supabase.co.`,
      );
    }
    if (!env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim().startsWith("sb_publishable_")) {
      throw new Error(
        "Refusing a mainnet build: NEXT_PUBLIC_SUPABASE_ANON_KEY must be a publishable key (sb_publishable_…).",
      );
    }
    return;
  }
  if (ref && mainnetRef && ref === mainnetRef) {
    throw new Error(
      `Refusing a ${network || "non-mainnet"} build that points at the mainnet Supabase project.`,
    );
  }
  if (network === "devnet" && devnetRef && raw && ref !== devnetRef) {
    throw new Error(
      `Refusing a devnet build: NEXT_PUBLIC_SUPABASE_URL must be https://${devnetRef}.supabase.co.`,
    );
  }
}

/**
 * Cloudflare Turnstile is on for a deployment only when both keys are set:
 * the server checks tokens when TURNSTILE_SECRET_KEY is set (read at
 * runtime), and pages render the widget only when NEXT_PUBLIC_TURNSTILE_SITE_KEY
 * was set at build time. The secret without the site key would refuse every
 * email sign-in and contact submission (the server fails closed and no page
 * can produce a token), so a production build with that combination fails.
 * The site key without the secret only warns: the widget shows, but tokens
 * are not checked.
 */
export function assertBuildTurnstile(
  phase: string,
  env: Record<string, string | undefined> = process.env,
  warn: (message: string) => void = console.warn,
): void {
  if (phase !== PHASE_PRODUCTION_BUILD) return;
  const secret = Boolean(env.TURNSTILE_SECRET_KEY?.trim());
  const siteKey = Boolean(env.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim());
  if (secret && !siteKey) {
    throw new Error(
      "TURNSTILE_SECRET_KEY is set but NEXT_PUBLIC_TURNSTILE_SITE_KEY is not: every email sign-in and contact " +
        "submission would be refused, because no page would show the challenge. Set both for this environment " +
        "(the site key is read at build time), or unset the secret.",
    );
  }
  if (siteKey && !secret) {
    warn(
      "NEXT_PUBLIC_TURNSTILE_SITE_KEY is set without TURNSTILE_SECRET_KEY: the Turnstile widget shows, but the " +
        "server does not check its tokens.",
    );
  }
}

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/**
 * True when `value` is base58 that decodes to exactly 32 bytes — the same
 * test @solana/kit's isAddress applies (lib/kyc-registry-pin.ts), spelled out
 * here because this file takes no runtime imports.
 */
export function isBase58Address(value: string): boolean {
  if (value.length < 32 || value.length > 44) return false;
  let n = BigInt(0);
  for (const ch of value) {
    const digit = BASE58_ALPHABET.indexOf(ch);
    if (digit < 0) return false;
    n = n * BigInt(58) + BigInt(digit);
  }
  let leadingZeros = 0;
  while (leadingZeros < value.length && value[leadingZeros] === "1") leadingZeros++;
  const bodyBytes = n === BigInt(0) ? 0 : Math.ceil(n.toString(16).length / 2);
  return leadingZeros + bodyBytes === 32;
}

/**
 * NEXT_PUBLIC_KYC_REGISTRY pins the platform KYC registry BY ADDRESS
 * (lib/kyc-registry-pin.ts). It is inlined at build time, and at runtime a
 * malformed value fails closed across every KYC surface (/admin/kyc errors,
 * the passport-sync gate answers 503, portfolio passports and share-class
 * gating are hidden), while an unset one falls back to the scan heuristic,
 * which cannot tell a rotated platform registry from a second registry. So in
 * a production build:
 *   - a set-but-malformed value fails (any environment);
 *   - an unset value fails a MAINNET build and a Vercel PRODUCTION build
 *     (VERCEL_ENV=production), and only warns on other Vercel builds
 *     (Preview). Local builds, CI, `next dev` and tests are unaffected.
 */
export function assertBuildKycRegistry(
  phase: string,
  env: Record<string, string | undefined> = process.env,
  warn: (message: string) => void = console.warn,
): void {
  if (phase !== PHASE_PRODUCTION_BUILD) return;
  const pin = env.NEXT_PUBLIC_KYC_REGISTRY?.trim() ?? "";
  if (pin) {
    if (!isBase58Address(pin)) {
      throw new Error(
        `NEXT_PUBLIC_KYC_REGISTRY="${pin}" is not a valid address. Set it to the platform KYC registry's ` +
          "address for this network (never a derived PDA), or leave it unset for a local build.",
      );
    }
    return;
  }
  const network = env.NEXT_PUBLIC_NETWORK?.trim().toLowerCase() ?? "";
  const onVercel = env.VERCEL === "1" || Boolean(env.VERCEL_ENV);
  const why =
    "is not set: KYC surfaces would fall back to scanning for a registry, which cannot tell the " +
    "platform registry from any other after a rotation. Set it to the registry address for this network.";
  if (network === "mainnet" || env.VERCEL_ENV === "production") {
    throw new Error(
      `NEXT_PUBLIC_KYC_REGISTRY ${why} (NEXT_PUBLIC_NETWORK=${network || "unset"}, VERCEL_ENV=${env.VERCEL_ENV ?? "unset"})`,
    );
  }
  if (onVercel) warn(`NEXT_PUBLIC_KYC_REGISTRY ${why}`);
}

// ── Mainnet readiness guards (8.4: RPC, operations, feature flags) ─────────

const PUBLIC_CLUSTER_HOSTS = ["api.mainnet-beta.solana.com", "api.devnet.solana.com", "api.testnet.solana.com"];

/**
 * The credential-bearing parts of an RPC URL: the values of query parameters
 * named like a key or token (Helius `api-key`), user info, and long path
 * segments (a "secure URL" token such as QuickNode's).
 */
function rpcCredentials(url: URL): string[] {
  const out: string[] = [];
  for (const [name, value] of url.searchParams) if (/key|token|secret|auth/i.test(name) && value) out.push(value);
  for (const segment of url.pathname.split("/")) if (segment.length >= 16) out.push(segment);
  if (url.username) out.push(url.username);
  if (url.password) out.push(url.password);
  return out;
}

/** host + path + query, whatever the scheme (https and wss of one endpoint compare equal). */
const endpointOf = (url: URL) => `${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, "")}${url.search}`;

function parsedUrl(value: string | undefined): URL | null {
  try {
    return value?.trim() ? new URL(value.trim()) : null;
  } catch {
    return null;
  }
}

/**
 * The browser reads the chain directly (getProgramAccounts, account and
 * signature reads, subscriptions), and falls back to it whenever the indexer
 * is stale. Without NEXT_PUBLIC_SOLANA_RPC_URL a mainnet build would point
 * every browser at the public api.mainnet-beta endpoint (lib/network.ts),
 * whose per-IP limits and blocked methods would break the site under load
 * (front-app-5, podaci-infra-2). So a MAINNET production build requires:
 *   - NEXT_PUBLIC_SOLANA_RPC_URL (https) and NEXT_PUBLIC_SOLANA_WS_URL (wss),
 *     neither a public cluster endpoint. Both are inlined into the browser
 *     bundle: use a browser key restricted to the site's origin (Helius
 *     "allowed domains" or a secure RPC URL), never the server key;
 *   - HELIUS_MAINNET_RPC or SOLANA_MAINNET_RPC (https, not public): the
 *     server resolver (lib/server/rpc.ts) already fails closed without it at
 *     runtime; the build says so first;
 *   - neither browser URL may carry a server URL's credential (the api-key
 *     value, a path token, user info) or be the same endpoint (host, path and
 *     query): Helius hands out one URL, and pasting it into both would ship
 *     the unrestricted server key in the public bundle, where anyone can
 *     spend its credits and rate limit until the server's fail-closed RPC
 *     stops authorizing.
 * A browser URL carrying an api-key parameter still warns: it must be the
 * domain-restricted browser key.
 */
export function assertBuildRpc(
  phase: string,
  env: Record<string, string | undefined> = process.env,
  warn: (message: string) => void = console.warn,
): void {
  if (phase !== PHASE_PRODUCTION_BUILD) return;
  if (buildNetwork(env) !== "mainnet") return;
  const check = (name: string, protocol: string, value: string | undefined) => {
    const url = parsedUrl(value);
    if (!url) {
      throw new Error(`Refusing a mainnet build: ${name} is not set. Set the paid RPC provider's ${protocol}// endpoint ` +
        "(ops/env-vars.md) — without it the site would fall back to the public api.mainnet-beta endpoint.");
    }
    if (url.protocol !== protocol || PUBLIC_CLUSTER_HOSTS.includes(url.hostname.toLowerCase())) {
      throw new Error(`Refusing a mainnet build: ${name} must be a ${protocol}// URL of a paid RPC provider, not ${url.protocol}//${url.hostname}.`);
    }
    return url;
  };
  const browser = check("NEXT_PUBLIC_SOLANA_RPC_URL", "https:", env.NEXT_PUBLIC_SOLANA_RPC_URL);
  const ws = check("NEXT_PUBLIC_SOLANA_WS_URL", "wss:", env.NEXT_PUBLIC_SOLANA_WS_URL);
  const server = env.HELIUS_MAINNET_RPC?.trim() ? "HELIUS_MAINNET_RPC" : "SOLANA_MAINNET_RPC";
  check(server, "https:", env[server]);
  // Every server URL that is set (the resolver falls back from one to the other).
  const servers = ["HELIUS_MAINNET_RPC", "SOLANA_MAINNET_RPC"]
    .map((name) => ({ name, url: parsedUrl(env[name]) })).filter((s): s is { name: string; url: URL } => s.url !== null);
  for (const [name, url] of [["NEXT_PUBLIC_SOLANA_RPC_URL", browser], ["NEXT_PUBLIC_SOLANA_WS_URL", ws]] as const) {
    const exposed = new Set(rpcCredentials(url));
    for (const s of servers) {
      if (endpointOf(url) === endpointOf(s.url) || rpcCredentials(s.url).some((c) => exposed.has(c))) {
        throw new Error(`Refusing a mainnet build: ${name} carries the server RPC credential (${s.name}). It is inlined into ` +
          "the public bundle: use a separate browser key restricted to this site's origin (ops/env-vars.md).");
      }
    }
    if (/api[-_]?key=/i.test(url.search)) {
      warn(`${name} carries an api-key and is inlined into the browser bundle: it must be a key ` +
        "restricted to this site's origin, never the server key (HELIUS_MAINNET_RPC).");
    }
  }
}

/**
 * lib/request-error-report.ts parseSentryDsn's rules, spelled out (no runtime
 * imports here; tests/build-mainnet-guards.test.ts runs both over the same
 * DSNs): https, a public key of 1–64 letters and digits, a numeric project id
 * as the last path segment, an EU-region (*.de.sentry.io) host. A DSN the
 * runtime would drop must not satisfy the guard.
 */
export function sentryDsnUsable(value: string | undefined): boolean {
  const url = parsedUrl(value);
  if (!url) return false;
  const project = url.pathname.split("/").filter(Boolean).pop();
  return url.protocol === "https:" && /^[A-Za-z0-9]{1,64}$/.test(url.username) && !!project && /^\d{1,20}$/.test(project)
    && /\.de\.sentry\.io$/i.test(url.hostname);
}

/**
 * Cloudflare's published Turnstile test keys (site keys 1x…AA, 2x…AB,
 * 1x/2x…BB, 3x…FF; secrets 1x/2x/3x…AA): they pass the build but the server
 * refuses a test secret in production (lib/server/turnstile.ts: 503 on every
 * email sign-in and contact submission).
 */
export const isTurnstileTestKey = (value: string | undefined) => /^[0-9]x0+[A-F]{2}$/i.test(value?.trim() ?? "");

/**
 * What a mainnet deployment needs to be operated (front-app-8, front-app-12,
 * ops-qa-2, ops-qa-9, ops-qa-18), by name. Each one silently degrades when
 * missing, so a MAINNET production build requires all of them unless
 * MAINNET_OPS_WAIVERS names it (comma-separated; an unknown name fails, so a
 * typo cannot waive anything). A waiver is a conscious, logged decision.
 */
export const MAINNET_OPS_REQUIREMENTS: Readonly<Record<string, { why: string; ok: (env: Record<string, string | undefined>) => boolean }>> = {
  // Server errors go to Sentry only with an https EU (*.de.sentry.io) DSN (lib/request-error-report.ts).
  sentry: {
    why: "SENTRY_DSN must be the https DSN of an EU-region Sentry project (https://<key>@<org>.ingest.de.sentry.io/<project id>): " +
      "without it server errors are only in short-lived logs",
    ok: (env) => sentryDsnUsable(env.SENTRY_DSN),
  },
  // /api/health details (commit, failing check) need a bearer of at least 32 characters (lib/server/health.ts).
  "health-token": {
    why: "HEALTH_TOKEN must be at least 32 characters without whitespace: the uptime monitor cannot see which check fails without it",
    ok: (env) => {
      const token = env.HEALTH_TOKEN?.trim() ?? "";
      return token.length >= 32 && !/\s/.test(token);
    },
  },
  // Email sign-in and the contact form have no bot protection without both keys (lib/server/turnstile.ts).
  turnstile: {
    why: "TURNSTILE_SECRET_KEY and NEXT_PUBLIC_TURNSTILE_SITE_KEY must both be set, and neither may be a Cloudflare test key: " +
      "email sign-in and the contact form are otherwise unprotected (or, with a test secret, refused in production)",
    ok: (env) => Boolean(env.TURNSTILE_SECRET_KEY?.trim() && env.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim())
      && !isTurnstileTestKey(env.TURNSTILE_SECRET_KEY) && !isTurnstileTestKey(env.NEXT_PUBLIC_TURNSTILE_SITE_KEY),
  },
  // The second alert channel (lib/server/system-alerts.ts): email alone is one mailbox on one server.
  "alert-webhook": {
    why: "ALERT_WEBHOOK_URL must be an https URL: alerts would otherwise reach one mailbox only",
    ok: (env) => parsedUrl(env.ALERT_WEBHOOK_URL)?.protocol === "https:",
  },
  // Wallet and account sessions are HMAC-signed with it (lib/server/siws-session.ts).
  "session-secret": {
    why: "SESSION_SECRET must be at least 32 characters, new for mainnet (never the devnet value)",
    ok: (env) => (env.SESSION_SECRET?.trim().length ?? 0) >= 32,
  },
  // Emails, alert links and the account origin are built from it (lib/server/account-origin.ts).
  "site-url": {
    why: "NEXT_PUBLIC_SITE_URL must be the https origin of the mainnet site",
    ok: (env) => {
      const url = parsedUrl(env.NEXT_PUBLIC_SITE_URL);
      return !!url && url.protocol === "https:" && url.pathname === "/" && !url.search && !url.hash;
    },
  },
};

export function assertBuildMainnetOps(
  phase: string,
  env: Record<string, string | undefined> = process.env,
  warn: (message: string) => void = console.warn,
): void {
  if (phase !== PHASE_PRODUCTION_BUILD) return;
  if (buildNetwork(env) !== "mainnet") return;
  const waivers = (env.MAINNET_OPS_WAIVERS ?? "").split(",").map((w) => w.trim().toLowerCase()).filter(Boolean);
  const unknown = waivers.filter((w) => !(w in MAINNET_OPS_REQUIREMENTS));
  if (unknown.length) {
    throw new Error(`MAINNET_OPS_WAIVERS names unknown requirement(s): ${unknown.join(", ")}. ` +
      `Known: ${Object.keys(MAINNET_OPS_REQUIREMENTS).join(", ")}.`);
  }
  const missing = Object.entries(MAINNET_OPS_REQUIREMENTS).filter(([name, r]) => !waivers.includes(name) && !r.ok(env));
  if (missing.length) {
    throw new Error("Refusing a mainnet build: " + missing.map(([name, r]) => `[${name}] ${r.why}`).join("; ") +
      ". Set them (ops/env-vars.md), or waive one knowingly with MAINNET_OPS_WAIVERS=<name>.");
  }
  if (waivers.length) warn(`Mainnet build with waived operations requirement(s): ${waivers.join(", ")} (MAINNET_OPS_WAIVERS).`);
}

/** The values lib/features.ts reads as on or off (case-insensitive); anything else is a typo. */
export const FEATURE_FLAG_VALUES = ["true", "false", "1", "0", "yes", "no", "on", "off"];
export const FEATURE_FLAG_NAMES = [
  "NEXT_PUBLIC_FEATURE_PAYOUT_AIRDROP", "NEXT_PUBLIC_FEATURE_STARTUP_RAISES",
  "NEXT_PUBLIC_FEATURE_ISSUER_ROTATION", "NEXT_PUBLIC_FEATURE_PASSPORT_CLOSE",
  // 8.5: the pilot-scope module switches (lib/features.ts PILOT_MODULE_ENV;
  // tests/pilot-modules.test.ts keeps the two lists equal).
  "NEXT_PUBLIC_FEATURE_SECONDARY_TRADING", "NEXT_PUBLIC_FEATURE_GOVERNANCE",
  "NEXT_PUBLIC_FEATURE_VESTING", "NEXT_PUBLIC_FEATURE_RIGHTS",
  "NEXT_PUBLIC_FEATURE_DISTRIBUTIONS", "NEXT_PUBLIC_FEATURE_CUSTODY_CONVERSION",
  "NEXT_PUBLIC_FEATURE_CUSTODY_DELIVERY",
];

/**
 * A NEXT_PUBLIC_FEATURE_* value lib/features.ts cannot read (front-app-8):
 * "ture" would silently keep a mainnet feature off (or, as a kill switch,
 * on). Any production build fails on one.
 */
export function assertBuildFeatureFlags(phase: string, env: Record<string, string | undefined> = process.env): void {
  if (phase !== PHASE_PRODUCTION_BUILD) return;
  for (const name of FEATURE_FLAG_NAMES) {
    const value = env[name]?.trim().toLowerCase();
    if (value && !FEATURE_FLAG_VALUES.includes(value)) {
      throw new Error(`${name}="${env[name]}" is not a flag value. Use one of: ${FEATURE_FLAG_VALUES.join(", ")} (or leave it unset).`);
    }
  }
}

/** The FEATURE_FLAG_VALUES that read as on (lib/features.ts parseFeatureFlag; a test keeps the two equal). */
const FEATURE_FLAG_ON_VALUES = ["true", "1", "yes", "on"];

/** True when a NEXT_PUBLIC_FEATURE_* value reads as on: how a mainnet build switches a feature on. */
export function featureFlagOn(value: string | undefined): boolean {
  return FEATURE_FLAG_ON_VALUES.includes(value?.trim().toLowerCase() ?? "");
}

/**
 * The flag behind each module the Terms can offer (TERMS_MODULES,
 * lib/legal/document.ts): lib/features.ts PILOT_MODULE_ENV for the pilot
 * modules, and the payout-airdrop and Startup-raise flags. The issuer
 * rotation and passport close flags are operational and not listed.
 * tests/terms-modules.test.ts keeps this map, FEATURE_FLAG_NAMES and
 * lib/features.ts equal.
 */
export const TERMS_MODULE_FLAGS: Readonly<Record<TermsModule, string>> = {
  secondaryTrading: "NEXT_PUBLIC_FEATURE_SECONDARY_TRADING",
  governance: "NEXT_PUBLIC_FEATURE_GOVERNANCE",
  vesting: "NEXT_PUBLIC_FEATURE_VESTING",
  rights: "NEXT_PUBLIC_FEATURE_RIGHTS",
  distributions: "NEXT_PUBLIC_FEATURE_DISTRIBUTIONS",
  custodyConversion: "NEXT_PUBLIC_FEATURE_CUSTODY_CONVERSION",
  custodyDelivery: "NEXT_PUBLIC_FEATURE_CUSTODY_DELIVERY",
  payoutAirdrop: "NEXT_PUBLIC_FEATURE_PAYOUT_AIRDROP",
  startupRaises: "NEXT_PUBLIC_FEATURE_STARTUP_RAISES",
};

/**
 * The module flags follow the Terms. On mainnet a module flag that reads as
 * on switches the module on for users, so the Terms in the same build must
 * offer it: a MAINNET production build refuses a flag of TERMS_MODULE_FLAGS
 * that is on while its module is not in MAINNET_TERMS.offeredModules
 * (lib/legal/mainnet-copy.ts), and an offeredModules entry that is no module.
 * One-way on purpose: a module the Terms offer may have its flag off, so a
 * rollback that switches a module off builds without a new Terms version.
 * Spellings are assertBuildFeatureFlags' check, which runs first. Other
 * networks (they render the devnet Terms and switch every module on unless
 * its flag is off), `next dev` and tests are unaffected.
 */
export function assertBuildMainnetModules(
  phase: string,
  env: Record<string, string | undefined> = process.env,
  terms: Pick<TermsDocument, "offeredModules"> | null = MAINNET_TERMS,
): void {
  if (phase !== PHASE_PRODUCTION_BUILD) return;
  if (buildNetwork(env) !== "mainnet") return;
  // An empty Terms slot offers nothing (assertBuildMainnetLegal refuses that build anyway).
  const offered: readonly string[] = terms?.offeredModules ?? [];
  const modules = Object.keys(TERMS_MODULE_FLAGS);
  const unknown = offered.filter((name) => !modules.includes(name));
  if (unknown.length) {
    throw new Error(
      `Refusing a mainnet build: MAINNET_TERMS.offeredModules (lib/legal/mainnet-copy.ts) names no module: ${unknown.join(", ")}. ` +
        `Modules: ${modules.join(", ")}.`,
    );
  }
  const refused = Object.entries(TERMS_MODULE_FLAGS).filter(
    ([name, flag]) => featureFlagOn(env[flag]) && !offered.includes(name),
  );
  if (refused.length === 0) return;
  throw new Error(
    "Refusing a mainnet build: a module flag is on that the mainnet Terms do not offer " +
      "(MAINNET_TERMS.offeredModules, lib/legal/mainnet-copy.ts):\n" +
      refused.map(([name, flag]) => `  - ${flag}="${env[flag]}" switches on ${name}, which the mainnet Terms do not offer`).join("\n") +
      `\nThe Terms offer: ${offered.length ? offered.join(", ") : "no module"}. Unset the flag (or set it to false), ` +
      "or ship the version of the Terms that offers the module, with counsel's confirmed wording, in the same build.",
  );
}

/**
 * Geoblocking (8.5, lib/geoblock.ts, proxy.ts): the countries the platform
 * does not serve are counsel's decision, so a MAINNET production build
 * refuses without GEOBLOCK_COUNTRIES — a list of ISO 3166 codes, or `none`
 * written down on purpose. Any production build refuses a malformed list
 * and a code that is no country (a typo, or "UK" for GB, would silently
 * block nothing).
 */
export function assertBuildGeoblock(phase: string, env: Record<string, string | undefined> = process.env): void {
  if (phase !== PHASE_PRODUCTION_BUILD) return;
  const config = parseGeoblockList(env[GEOBLOCK_ENV]);
  if (!config.ok) {
    throw new Error(`${GEOBLOCK_ENV}: ${config.error}. Use comma-separated ISO 3166 codes (KP,IR,UA-43) or "none".`);
  }
  if (buildNetwork(env) === "mainnet" && !config.set) {
    throw new Error(
      `Refusing a mainnet build: ${GEOBLOCK_ENV} is not set. Set it to the countries counsel excludes ` +
        '(comma-separated ISO 3166 codes, e.g. "KP,IR,CU,SY,UA-43,UA-40"), or to "none" when counsel ' +
        "decided to block none (ops/env-vars.md, Geoblocking).",
    );
  }
}

// ── Content-Security-Policy (report-only) ──────────────────────────────────

/** Where browsers send CSP violation reports (app/api/csp-report/route.ts). */
export const CSP_REPORT_PATH = "/api/csp-report";

const PUBLIC_CLUSTER_ORIGINS: Record<string, [string, string]> = {
  mainnet: ["https://api.mainnet-beta.solana.com", "wss://api.mainnet-beta.solana.com"],
  devnet: ["https://api.devnet.solana.com", "wss://api.devnet.solana.com"],
  testnet: ["https://api.testnet.solana.com", "wss://api.testnet.solana.com"],
  localnet: ["http://127.0.0.1:8899", "ws://127.0.0.1:8900"],
};

/**
 * The Content-Security-Policy, sent as Content-Security-Policy-Report-Only
 * (front-app-6): browsers report what it would block and block nothing yet.
 * Origins come from the build's env (inlined like the rest of NEXT_PUBLIC_*):
 * the Supabase project (https + wss), the browser RPC (HTTP + WebSocket, or
 * the network's public endpoints when unset), Cloudflare Turnstile (script +
 * frame), Google sign-in (a top-level redirect: form-action only), and the
 * Vercel toolbar on Preview deployments. Wallet extensions inject through
 * their own content scripts, which a page CSP does not govern.
 * script-src keeps 'unsafe-inline' while report-only: Next's inline bootstrap
 * scripts need a per-request nonce, which ships with enforcement (the path is
 * in ops/env-vars.md, "Content-Security-Policy").
 */
export function contentSecurityPolicy(env: Record<string, string | undefined> = process.env, dev = false): string {
  const network = env.NEXT_PUBLIC_NETWORK?.trim().toLowerCase() || "devnet";
  const origin = (value: string | undefined) => {
    const url = parsedUrl(value);
    return url ? `${url.protocol}//${url.host}` : null;
  };
  const connect = new Set<string>(["'self'", "https://challenges.cloudflare.com"]);
  const supabase = origin(env.NEXT_PUBLIC_SUPABASE_URL);
  if (supabase) {
    connect.add(supabase);
    connect.add(supabase.replace(/^https:/, "wss:"));
  }
  const rpc = origin(env.NEXT_PUBLIC_SOLANA_RPC_URL);
  const ws = origin(env.NEXT_PUBLIC_SOLANA_WS_URL);
  const [publicRpc, publicWs] = PUBLIC_CLUSTER_ORIGINS[network] ?? PUBLIC_CLUSTER_ORIGINS.devnet;
  connect.add(rpc ?? publicRpc);
  connect.add(ws ?? (rpc ? rpc.replace(/^https:/, "wss:").replace(/^http:/, "ws:") : publicWs));
  const preview = env.VERCEL_ENV === "preview";
  const script = ["'self'", "'unsafe-inline'", "https://challenges.cloudflare.com", ...(dev ? ["'unsafe-eval'"] : [])];
  const frame = ["https://challenges.cloudflare.com"];
  if (preview) {
    script.push("https://vercel.live");
    frame.push("https://vercel.live");
    connect.add("https://vercel.live");
    connect.add("wss://ws-us3.pusher.com");
  }
  return [
    "default-src 'self'",
    `script-src ${script.join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src ${[...connect].join(" ")}`,
    `frame-src ${frame.join(" ")}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self' https://accounts.google.com",
    "frame-ancestors 'none'",
    `report-uri ${CSP_REPORT_PATH}`,
    "report-to csp",
  ].join("; ");
}

// Site-wide browser hardening. The Content-Security-Policy is report-only
// for now (contentSecurityPolicy above).
const SECURITY_HEADERS = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  // Denied for every frame. The planned Sumsub WebSDK runs in an iframe and
  // needs camera and microphone for liveness checks: that integration must
  // delegate them, e.g. camera=(self "https://*.sumsub.com"), and test it.
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  // Isolates this window from pages it did not open, but keeps the opener
  // link to popups it opens (wallet adapters that use a popup window). Google
  // sign-in is a full-page redirect and needs no opener.
  { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
];

// Pages whose URL can carry a live credential (/login/email?token=…,
// /onboarding/[id]?t=…), that show personal or KYC data (/account, /admin),
// or that issue sessions: never stored by the browser or back-forward cache,
// never sent as Referer (not even same-origin), never indexed.
const SENSITIVE_SOURCES = [
  "/account/:path*",
  "/api/account/:path*",
  // Pages under /login (/login/email?token=…), not /login itself: see below.
  "/login/:path+",
  "/onboarding/:path*",
  "/admin/:path*",
  "/api/auth/:path*",
];

// The sign-in page carries no credential in its URL (only ?next=<path>) and
// hosts the Cloudflare Turnstile widget, a cross-origin iframe whose domain
// check may rely on the Referer; no-referrer could break it (error 110200),
// and the server fails closed. So it keeps the site-wide
// strict-origin-when-cross-origin, and is still never stored or indexed.
const SIGN_IN_PAGE = "/login";

const nextConfig: NextConfig = {
  // The local preview uses this exact loopback hostname; production is unchanged.
  allowedDevOrigins: ["127.0.0.1"],
  poweredByHeader: false,
  async headers() {
    // Report-only: violations are reported to CSP_REPORT_PATH, nothing is blocked.
    const csp = [
      { key: "Content-Security-Policy-Report-Only", value: contentSecurityPolicy(process.env, process.env.NODE_ENV === "development") },
      { key: "Reporting-Endpoints", value: `csp="${CSP_REPORT_PATH}"` },
    ];
    return [
      { source: "/:path*", headers: [...SECURITY_HEADERS, ...csp] },
      // Later rules win for the same key: these keep no-referrer.
      ...SENSITIVE_SOURCES.map((source) => ({
        source,
        headers: [
          { key: "Cache-Control", value: "no-store" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ],
      })),
      {
        source: SIGN_IN_PAGE,
        headers: [
          { key: "Cache-Control", value: "no-store" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ],
      },
    ];
  },
  async redirects() {
    return [
      // Absorbed into the homepage. Note: redirect destinations can't carry a
      // hash, so this lands on "/".
      { source: "/why-mancipatio", destination: "/", permanent: true },
      // /how-it-works used to redirect here; it is a real page again. The old
      // redirect was permanent (308), so browsers that followed it have it
      // cached — this temporary redirect exists only to unstick them and can
      // be dropped once the cached entries age out.
      { source: "/invest", destination: "/investors", permanent: false },
    ];
  },
};

export default function config(phase: string): NextConfig {
  assertBuildNetwork(phase);
  assertBuildSupabase(phase);
  assertBuildTurnstile(phase);
  assertBuildKycRegistry(phase);
  assertBuildMainnetLegal(phase);
  // 8.4: mainnet RPC, operations and feature-flag guards. A build that would
  // run as mainnet without NEXT_PUBLIC_NETWORK is already refused by
  // assertBuildNetwork, and these guards key on buildNetwork() as well.
  assertBuildRpc(phase);
  assertBuildMainnetOps(phase);
  assertBuildFeatureFlags(phase);
  // A module flag that is on needs the module in the mainnet Terms (one-way).
  assertBuildMainnetModules(phase);
  // 8.5: counsel's geoblock list (or an explicit "none") on mainnet.
  assertBuildGeoblock(phase);
  return nextConfig;
}
