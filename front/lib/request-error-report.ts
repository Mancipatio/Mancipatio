// Server error reporting without a vendor SDK (instrumentation.ts →
// onRequestError). Every captured error becomes ONE structured log line with
// the route pattern, method, digest and a scrubbed, truncated error name and
// message. When SENTRY_DSN is set, the same fields are also sent as a minimal
// event to Sentry's envelope endpoint with plain fetch.
//
// Scope of the scrubbing: it covers THIS log line and the Sentry event only.
// Next itself still prints the original error (message and stack) with
// console.error before it calls this hook, so the platform's runtime logs
// keep receiving unscrubbed text; treat those logs as sensitive.
//
// Never included here: the request path or query (tokens, wallet addresses),
// headers (cookies, authorization), bodies, stack traces or thrown objects.
// Messages are scrubbed best-effort: URLs keep only scheme and host (API keys
// live in RPC query strings), query values are redacted even without a
// scheme, and emails (also %40-encoded), bearer/Google/Supabase tokens, JWTs,
// IP addresses, IBANs, UUIDs, SolanaError context blobs, long hex/base58
// strings (hashes, wallets, signatures), base64 tokens and long digit runs
// are replaced by placeholders.
//
// Sentry: https DSNs only. Sends are limited per server instance (one per
// distinct error per minute, SENTRY_MAX_PER_MINUTE in total); the rest is
// logged only. Before setting SENTRY_DSN, use an EU-region project (DSN host
// *.de.sentry.io) and list Sentry as a sub-processor in the privacy policy
// (app/(marketing)/legal/privacy), which promises EU-region processing.
//
// Timing: Next awaits this hook for route-handler errors, so a slow Sentry
// adds up to SENTRY_TIMEOUT_MS to that error response. For render errors Next
// calls it from React's onError without awaiting it, so those sends are
// best-effort and can be dropped when a serverless instance freezes.
//
// Runs in both server runtimes (Node.js and Edge): only fetch, crypto and
// AbortSignal are used. Reporting never throws and never retries.

export type ErrorRequestInfo = { method?: string };
export type ErrorContextInfo = {
  routerKind?: string;
  routePath?: string;
  routeType?: string;
  renderSource?: string;
  revalidateReason?: string;
};
export type ErrorReportLine = {
  level: "error";
  event: "request_error";
  route: string;
  routeType: string | null;
  method: string;
  digest: string | null;
  name: string;
  message: string;
};

const MAX_MESSAGE = 300;
const MAX_SCAN = 4_000;
/** Kept short: Next awaits this for route-handler errors, so a slow Sentry
 * delays that error response by up to this long. */
export const SENTRY_TIMEOUT_MS = 1_000;

function urlHost(raw: string): string {
  try {
    const url = new URL(raw);
    return url.hostname ? `${url.protocol}//${url.hostname}` : "[url]";
  } catch {
    return "[url]";
  }
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
const HEX = /^[0-9a-f]+$/i;

function charClass(char: string): number {
  if (char >= "A" && char <= "Z") return 0;
  if (char >= "a" && char <= "z") return 1;
  if (char >= "0" && char <= "9") return 2;
  return 3;
}

/** A long run of base64/base64url/base58/hex characters. Pure hex and base58
 * runs are named; anything else that switches between upper case, lower case,
 * digits and symbols as often as random data does is a token or encoded blob
 * (base64 signatures, SolanaError contexts, `user_<wallet>`). Identifiers
 * (camelCase, snake_case, SCREAMING_CASE, route paths) switch far less often
 * and are kept. */
function scrubTokenRun(run: string): string {
  if (run.length >= 32 && HEX.test(run)) return "[hex]";
  if (run.length >= 32 && BASE58.test(run)) return "[base58]";
  if (run.endsWith("=")) return "[blob]";
  let switches = 0;
  for (let i = 1; i < run.length; i++) if (charClass(run[i]) !== charClass(run[i - 1])) switches++;
  return switches / (run.length - 1) >= 0.36 ? "[blob]" : run;
}

const SCRUBBERS: ReadonlyArray<readonly [RegExp, string | ((match: string) => string)]> = [
  // URLs with a scheme first: drops credentials, paths and query strings (RPC API keys).
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>()`]+/gi, urlHost],
  // Production SolanaError messages carry their context (addresses,
  // signatures, values) base64-encoded in the decode hint.
  [/(decode -- \d+) '[^']*'/g, "$1 '[context]'"],
  // Query values without a scheme: /login/email?token=…, ?code=…&state=….
  [/([?&][\w.[\]-]{1,40}=)[^&#\s"'`<>]+/g, "$1[redacted]"],
  [/\bBearer\s+[^\s"',;]+/gi, "Bearer [redacted]"],
  [/\beyJ[\w-]*\.[\w-]*\.[\w-]*/g, "[jwt]"],
  // Google OAuth access/refresh tokens and Supabase API keys.
  [/\bya29\.[\w.-]+/g, "[google-token]"],
  [/(?<![\w/])1\/\/[\w-]{8,}/g, "[google-token]"],
  [/\bsb_(?:secret|publishable)_[\w-]+/g, "[supabase-key]"],
  // Emails, also URL-encoded (%40).
  [/[^\s@"'<>(),;:=[\]]+(?:@|%40)[^\s@"'<>(),;:=[\]%]+\.[a-z]{2,}\b/gi, "[email]"],
  [/\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g, "[iban]"],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[ip]"],
  [/\b(?:[0-9a-f]{1,4}:){4,7}[0-9a-f]{1,4}\b/gi, "[ip]"],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "[uuid]"],
  // Bounded by characters outside the token alphabet, not by \b, so a run
  // after "_" or next to 0/O/I/l is still found as a whole.
  [/(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{20,}={0,2}(?![A-Za-z0-9+/_-])/g, scrubTokenRun],
  // Hex/base58 runs inside a run that was kept as an identifier.
  [/(?<![0-9a-f])[0-9a-f]{32,}(?![0-9a-f])/gi, "[hex]"],
  [/(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{32,}(?![1-9A-HJ-NP-Za-km-z])/g, "[base58]"],
  [/\b\d(?:[ -]?\d){12,}\b/g, "[number]"],
];

/** Best-effort removal of personal data and secrets from free text. */
export function scrubText(input: string, max = MAX_MESSAGE): string {
  let text = input.slice(0, MAX_SCAN);
  for (const [pattern, replacement] of SCRUBBERS) {
    text = typeof replacement === "string" ? text.replace(pattern, replacement) : text.replace(pattern, replacement);
  }
  text = text.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function errorName(error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error === "string" ? "Error" : "NonError";
  return /^[A-Za-z0-9_$.]{1,64}$/.test(name) ? name : "Error";
}

function errorMessage(error: unknown): string {
  // Never stringify arbitrary thrown objects: they can be whole records.
  if (error instanceof Error) return scrubText(error.message || "");
  if (typeof error === "string") return scrubText(error);
  return "Non-error value thrown";
}

function errorDigest(error: unknown): string | null {
  const digest = typeof error === "object" && error !== null && "digest" in error
    ? (error as { digest?: unknown }).digest : undefined;
  if (typeof digest !== "string") return null;
  // Control-flow digests (e.g. "NEXT_REDIRECT;replace;/path;307;") carry paths.
  const head = digest.split(";", 1)[0];
  return /^[\w@.:-]{1,80}$/.test(head) ? head : null;
}

/** The structured, PII-scrubbed description of one captured request error. */
export function describeRequestError(error: unknown, request: ErrorRequestInfo, context: ErrorContextInfo): ErrorReportLine {
  const method = typeof request?.method === "string" && /^[A-Z]{1,10}$/.test(request.method) ? request.method : "OTHER";
  // The route FILE pattern (e.g. /api/assets/[id]), never the requested path.
  const route = typeof context?.routePath === "string" ? scrubText(context.routePath, 200) || "unknown" : "unknown";
  const routeType = typeof context?.routeType === "string" && /^[a-z-]{1,20}$/.test(context.routeType) ? context.routeType : null;
  return {
    level: "error", event: "request_error", route, routeType, method,
    digest: errorDigest(error), name: errorName(error), message: errorMessage(error),
  };
}

export type SentryTarget = { envelopeUrl: string; publicKey: string };

/** https://<key>@<host>[/<path>]/<project> → envelope endpoint, or null. */
export function parseSentryDsn(dsn: string | undefined): SentryTarget | null {
  if (!dsn?.trim()) return null;
  try {
    const url = new URL(dsn.trim());
    const segments = url.pathname.split("/").filter(Boolean);
    const project = segments.pop();
    // https only: the event must never cross the network in plaintext.
    if (url.protocol !== "https:" || !url.username
      || !/^[A-Za-z0-9]{1,64}$/.test(url.username) || !project || !/^\d{1,20}$/.test(project)) return null;
    const prefix = segments.length ? `/${segments.join("/")}` : "";
    return { envelopeUrl: `${url.protocol}//${url.host}${prefix}/api/${project}/envelope/`, publicKey: url.username };
  } catch {
    return null;
  }
}

function eventId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

/** A minimal Sentry envelope for one error event (no stack, user or request). */
export function buildSentryEnvelope(line: ErrorReportLine, env: Record<string, string | undefined>, now = Date.now(), id = eventId()): string {
  const release = env.VERCEL_GIT_COMMIT_SHA && /^[0-9a-f]{7,40}$/i.test(env.VERCEL_GIT_COMMIT_SHA) ? env.VERCEL_GIT_COMMIT_SHA : undefined;
  const tags: Record<string, string> = { method: line.method };
  if (line.routeType) tags.route_type = line.routeType;
  if (line.digest) tags.digest = line.digest;
  const network = env.NEXT_PUBLIC_NETWORK?.trim().toLowerCase();
  if (network && /^[a-z]{1,16}$/.test(network)) tags.network = network;
  const event = {
    event_id: id,
    timestamp: now / 1000,
    platform: "node",
    level: "error",
    logger: "next.onRequestError",
    environment: env.VERCEL_ENV || env.NODE_ENV || "production",
    ...(release ? { release } : {}),
    transaction: line.route,
    tags,
    exception: { values: [{ type: line.name, value: line.message, mechanism: { type: "onRequestError", handled: false } }] },
  };
  return `${JSON.stringify({ event_id: id, sent_at: new Date(now).toISOString() })}\n${JSON.stringify({ type: "event" })}\n${JSON.stringify(event)}\n`;
}

export const SENTRY_WINDOW_MS = 60_000;
export const SENTRY_MAX_PER_MINUTE = 20;

/** Per-instance send budget: at most `max` events per window and one per
 * distinct error, so a caller who can trigger an error at will cannot use up
 * the Sentry quota (hiding real errors) or hold many responses open. */
export class SentryRateLimiter {
  private windowStart = -Infinity;
  private readonly seen = new Set<string>();
  private readonly max: number;
  private readonly windowMs: number;

  constructor(max = SENTRY_MAX_PER_MINUTE, windowMs = SENTRY_WINDOW_MS) {
    this.max = max;
    this.windowMs = windowMs;
  }

  allow(fingerprint: string, now = Date.now()): boolean {
    if (now - this.windowStart >= this.windowMs) {
      this.windowStart = now;
      this.seen.clear();
    }
    if (this.seen.has(fingerprint) || this.seen.size >= this.max) return false;
    this.seen.add(fingerprint);
    return true;
  }
}

const defaultLimiter = new SentryRateLimiter();

type ReportOptions = {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
  timeoutMs?: number;
  limiter?: SentryRateLimiter;
};

/** Log the error line and, when configured and within the send budget,
 * forward it to Sentry. Resolves once the send finished or timed out; never
 * rejects. See the header for when Next awaits this. */
export function reportRequestError(error: unknown, request: ErrorRequestInfo, context: ErrorContextInfo, options: ReportOptions = {}): Promise<void> {
  try {
    const env = options.env ?? process.env;
    const line = describeRequestError(error, request, context);
    (options.log ?? ((text: string) => console.error(text)))(JSON.stringify(line));
    const target = parseSentryDsn(env.SENTRY_DSN);
    if (!target) return Promise.resolve();
    const fingerprint = `${line.route}|${line.method}|${line.name}|${line.message}`;
    if (!(options.limiter ?? defaultLimiter).allow(fingerprint)) return Promise.resolve();
    const send = options.fetchImpl ?? fetch;
    return send(target.envelopeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-sentry-envelope",
        "X-Sentry-Auth": `Sentry sentry_version=7, sentry_key=${target.publicKey}, sentry_client=manci-instrumentation/1.0`,
      },
      body: buildSentryEnvelope(line, env),
      signal: AbortSignal.timeout(options.timeoutMs ?? SENTRY_TIMEOUT_MS),
    }).then(() => undefined, () => undefined);
  } catch {
    return Promise.resolve();
  }
}
