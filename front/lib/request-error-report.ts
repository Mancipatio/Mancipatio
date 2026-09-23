// Server error reporting without a vendor SDK (instrumentation.ts →
// onRequestError). Every captured error becomes ONE structured log line with
// the route pattern, method, digest and a scrubbed, truncated error name and
// message. When SENTRY_DSN is set, the same fields are also sent as a minimal
// event to Sentry's envelope endpoint with plain fetch.
//
// Never included: the request path or query (tokens, wallet addresses),
// headers (cookies, authorization), bodies, stack traces or thrown objects.
// Messages are scrubbed best-effort: URLs keep only scheme and host (API keys
// live in RPC query strings), and emails, bearer tokens, JWTs, IP addresses,
// IBANs, long hex/base58 strings (hashes, wallets, signatures) and long
// digit runs are replaced by placeholders.
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
export const SENTRY_TIMEOUT_MS = 2_000;

function urlHost(raw: string): string {
  try {
    const url = new URL(raw);
    return url.hostname ? `${url.protocol}//${url.hostname}` : "[url]";
  } catch {
    return "[url]";
  }
}

const SCRUBBERS: ReadonlyArray<readonly [RegExp, string | ((match: string) => string)]> = [
  // URLs first: drops credentials, paths and query strings (RPC API keys).
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>()`]+/gi, urlHost],
  [/\bBearer\s+[^\s"',;]+/gi, "Bearer [redacted]"],
  [/\beyJ[\w-]*\.[\w-]*\.[\w-]*/g, "[jwt]"],
  [/[^\s@"'<>(),;:=[\]]+@[^\s@"'<>(),;:=[\]]+\.[a-z]{2,}\b/gi, "[email]"],
  [/\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g, "[iban]"],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[ip]"],
  [/\b(?:[0-9a-f]{1,4}:){4,7}[0-9a-f]{1,4}\b/gi, "[ip]"],
  [/\b[0-9a-f]{32,}\b/gi, "[hex]"],
  [/\b[1-9A-HJ-NP-Za-km-z]{32,}\b/g, "[base58]"],
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
    if ((url.protocol !== "https:" && url.protocol !== "http:") || !url.username
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

type ReportOptions = {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
  timeoutMs?: number;
};

/** Log the error line and, when configured, forward it to Sentry. Resolves
 * once the send finished or timed out (Next awaits onRequestError, and a
 * serverless instance may freeze un-awaited work); never rejects. */
export function reportRequestError(error: unknown, request: ErrorRequestInfo, context: ErrorContextInfo, options: ReportOptions = {}): Promise<void> {
  try {
    const env = options.env ?? process.env;
    const line = describeRequestError(error, request, context);
    (options.log ?? ((text: string) => console.error(text)))(JSON.stringify(line));
    const target = parseSentryDsn(env.SENTRY_DSN);
    if (!target) return Promise.resolve();
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
