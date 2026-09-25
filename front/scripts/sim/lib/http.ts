/**
 * SIWS client and cookie jar of the simulator (design-sim §0 "Signing").
 *
 * - Envelope: exactly the browser's (lib/siws-client.ts): payload
 *   `{v:2, origin, network, action, wallet, ts, nonce, params}`, message
 *   `siwsMessage(payload)`, ed25519 over its UTF-8 bytes, body
 *   `{payload, signature, publicKey, sigFormat:"raw"}` — the same shape as
 *   scripts/ops/deployment-smoke.test.ts, signed with the user's kit
 *   KeyPairSigner (the same key signs its transactions).
 * - Reads: `{payload, session:true}` plus the saved `manci_session` cookie,
 *   only for SESSION_READ_ACTIONS. Node fetch has no cookie jar, so each
 *   user's cookie lives here (in memory only; a resume signs in again). When
 *   /api/auth/session answers 503 (no SESSION_SECRET) every read is signed.
 * - Every request goes through the pacing limiter and the circuit breakers
 *   and leaves one redacted journal line with its expectation and outcome.
 */
import { randomUUID } from "node:crypto";
import { signBytes, type KeyPairSigner } from "@solana/kit";
import { MAINTENANCE_CODE } from "@/lib/maintenance";
import { siwsMessage, type SiwsPayload, type SiwsRequestBody } from "@/lib/siws-client";
import { SESSION_COOKIE, isSessionReadAction } from "@/lib/siws-session";
import { SIM_NETWORK, SITE_ORIGIN } from "./constants";
import type { JournalSink, Outcome } from "./journal";
import type { Limiter, PaceClass } from "./pacing";
import { journalBody } from "./safety";

export type Expect = "2xx" | "4xx" | number | readonly number[];

export function expectLabel(expect: Expect): string {
  return Array.isArray(expect) ? expect.join("|") : String(expect);
}

/** Compares a status with the step's expectation (status 0 = no response). */
export function classifyStatus(status: number, expect: Expect): Outcome {
  if (status === 0) return "network";
  const matches =
    expect === "2xx"
      ? status >= 200 && status < 300
      : expect === "4xx"
        ? status >= 400 && status < 500
        : Array.isArray(expect)
          ? expect.includes(status)
          : status === expect;
  if (matches) return status >= 200 && status < 300 ? "ok" : "expected-error";
  if (status >= 500) return "5xx";
  if (status >= 200 && status < 300) return "unexpected-2xx";
  return "unexpected-4xx";
}

/** Who sends a request: a simulated user, or the CLI Admin (market setup, the owner actor). */
export type Actor = {
  label: string;
  cohort: string;
  wave: number | null;
  signer: KeyPairSigner;
  /** The owner actor: the user the request is about (journalled; the cookie stays keyed by `label`). */
  target?: string;
};

export type HttpResult<T = unknown> = {
  status: number;
  outcome: Outcome;
  ms: number;
  text: string;
  json: { ok?: boolean; data?: T; error?: string; code?: string; message?: string } | null;
  data: T | undefined;
  headers: Headers | null;
};

export function buildPayload(input: {
  action: string;
  wallet: string;
  params: Record<string, unknown>;
  origin?: string;
  network?: string;
  ts?: string;
  nonce?: string;
}): SiwsPayload {
  return {
    v: 2,
    origin: input.origin ?? SITE_ORIGIN,
    network: (input.network ?? SIM_NETWORK) as SiwsPayload["network"],
    action: input.action,
    wallet: input.wallet,
    ts: input.ts ?? new Date().toISOString(),
    nonce: input.nonce ?? randomUUID(),
    params: input.params,
  };
}

/** Signs `payload` exactly as the browser does ("raw": the UTF-8 SIWS text). */
export async function signEnvelope(signer: KeyPairSigner, payload: SiwsPayload): Promise<SiwsRequestBody> {
  const bytes = new TextEncoder().encode(siwsMessage(payload));
  const signature = await signBytes(signer.keyPair.privateKey, bytes);
  return {
    payload,
    signature: Buffer.from(signature).toString("base64"),
    publicKey: payload.wallet,
    sigFormat: "raw",
  };
}

/** `manci_session=<value>` from a response's Set-Cookie headers, or null. */
export function sessionCookieFrom(headers: Headers): string | null {
  const list =
    typeof (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie === "function"
      ? (headers as Headers & { getSetCookie: () => string[] }).getSetCookie()
      : [headers.get("set-cookie") ?? ""];
  for (const line of list) {
    const first = line.split(";")[0]?.trim() ?? "";
    if (first.startsWith(`${SESSION_COOKIE}=`)) {
      const v = first.slice(SESSION_COOKIE.length + 1);
      return v ? `${SESSION_COOKIE}=${v}` : null;
    }
  }
  return null;
}

/** Default pacing classes for a signed action. */
export function classesFor(action: string): PaceClass[] {
  if (action === "verification.submit") return ["write", "verify"];
  if (isSessionReadAction(action)) return ["read"];
  return ["write"];
}

export type SignedOptions = {
  step: string;
  route: string;
  action: string;
  params: Record<string, unknown>;
  expect?: Expect;
  classes?: PaceClass[];
  /** Tamper with the payload before signing (edge cases). */
  payload?: Partial<SiwsPayload>;
  /** Tamper with the signed body before it is sent (edge cases). */
  mutate?: (body: Record<string, unknown>) => Record<string, unknown>;
  headers?: Record<string, string>;
};

export class SimHttp {
  private readonly cookies = new Map<string, string | null>();
  /** False once /api/auth/session answered 503: every read is then signed. */
  sessionsEnabled = true;

  constructor(
    private readonly deps: {
      fetch: typeof fetch;
      limiter: Limiter;
      journal: JournalSink;
      origin?: string;
      now?: () => number;
      timeoutMs?: number;
    },
  ) {}

  get origin(): string {
    return this.deps.origin ?? SITE_ORIGIN;
  }

  forgetSession(label: string): void {
    this.cookies.delete(label);
  }

  hasSession(label: string): boolean {
    return Boolean(this.cookies.get(label));
  }

  /** One paced, journalled request. Never throws for an HTTP status. */
  async request<T = unknown>(
    actor: Actor,
    input: {
      step: string;
      route: string;
      action?: string;
      method: "GET" | "POST";
      body?: string | FormData;
      headers?: Record<string, string>;
      classes: PaceClass[];
      expect: Expect;
    },
  ): Promise<HttpResult<T>> {
    const release = await this.deps.limiter.acquire(input.classes);
    const now = this.deps.now ?? Date.now;
    const started = now();
    let status = 0;
    let text = "";
    let headers: Headers | null = null;
    let err: string | undefined;
    try {
      const headersInit: Record<string, string> = { Origin: this.origin, ...(input.headers ?? {}) };
      if (typeof input.body === "string") headersInit["Content-Type"] ??= "application/json";
      const response = await this.deps.fetch(this.origin + input.route, {
        method: input.method,
        headers: headersInit,
        body: input.body,
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(this.deps.timeoutMs ?? 65_000),
      });
      status = response.status;
      headers = response.headers;
      text = await response.text();
    } catch (error) {
      err = (error as Error)?.name === "TimeoutError" ? "timeout" : "no response";
    } finally {
      release();
    }
    let json: HttpResult<T>["json"] = null;
    try {
      json = text ? (JSON.parse(text) as HttpResult<T>["json"]) : null;
    } catch {
      json = null;
    }
    const code = json && typeof json.code === "string" ? json.code : null;
    this.deps.limiter.noteHttp(status, code === MAINTENANCE_CODE ? "maintenance" : code);
    const outcome = classifyStatus(status, input.expect);
    this.deps.journal.append({
      wave: actor.wave,
      user: actor.label,
      cohort: actor.cohort,
      step: input.step,
      kind: "http",
      route: `${input.method} ${input.route.split("?")[0]}`,
      action: input.action,
      httpStatus: status,
      ms: now() - started,
      expected: expectLabel(input.expect),
      outcome,
      body: journalBody(text),
      err,
      ...(actor.target ? { target: actor.target } : {}),
    });
    return { status, outcome, ms: now() - started, text, json, data: json?.data as T | undefined, headers };
  }

  /** A freshly signed request (every write, and reads when no session is live). */
  async signed<T = unknown>(actor: Actor, o: SignedOptions): Promise<HttpResult<T>> {
    const payload = buildPayload({ action: o.action, wallet: actor.signer.address, params: o.params, ...o.payload });
    let body: Record<string, unknown> = await signEnvelope(actor.signer, payload);
    if (o.mutate) body = o.mutate(body);
    return this.request<T>(actor, {
      step: o.step,
      route: o.route,
      action: o.action,
      method: "POST",
      body: JSON.stringify(body),
      headers: o.headers,
      classes: o.classes ?? classesFor(o.action),
      expect: o.expect ?? "2xx",
    });
  }

  /** `auth.session`: keeps the cookie for later session reads. */
  async startSession(actor: Actor, step = "auth.session"): Promise<HttpResult> {
    const result = await this.signed(actor, {
      step,
      route: "/api/auth/session",
      action: "auth.session",
      params: {},
      expect: [200, 503],
    });
    if (result.status === 503) this.sessionsEnabled = false;
    const cookie = result.status === 200 && result.headers ? sessionCookieFrom(result.headers) : null;
    this.cookies.set(actor.label, cookie);
    return result;
  }

  /**
   * A read on the wallet session (SESSION_READ_ACTIONS only): signs in first
   * when needed, and signs the read itself when the session is refused.
   */
  async read<T = unknown>(actor: Actor, o: Omit<SignedOptions, "classes">): Promise<HttpResult<T>> {
    if (!isSessionReadAction(o.action) || !this.sessionsEnabled) return this.signed<T>(actor, { ...o, classes: ["read"] });
    if (!this.cookies.get(actor.label)) {
      await this.startSession(actor, `${o.step}.session`);
      if (!this.cookies.get(actor.label)) return this.signed<T>(actor, { ...o, classes: ["read"] });
    }
    const payload = buildPayload({ action: o.action, wallet: actor.signer.address, params: o.params, ...o.payload });
    const result = await this.request<T>(actor, {
      step: o.step,
      route: o.route,
      action: o.action,
      method: "POST",
      body: JSON.stringify({ payload, session: true }),
      headers: { Cookie: this.cookies.get(actor.label)!, ...(o.headers ?? {}) },
      classes: ["read"],
      expect: [...(typeof o.expect === "number" ? [o.expect] : []), 200, 401],
    });
    if (result.status !== 401) return result;
    // Expired or refused session: forget it and sign this one read.
    this.cookies.set(actor.label, null);
    return this.signed<T>(actor, { ...o, classes: ["read"] });
  }

  /**
   * A request on the session cookie for ANY action, with no fallback: the
   * edge cohort uses it to prove a write is refused without a signature.
   */
  async sessionOnly<T = unknown>(actor: Actor, o: { step: string; route: string; action: string; params: Record<string, unknown>; expect: Expect }): Promise<HttpResult<T>> {
    const payload = buildPayload({ action: o.action, wallet: actor.signer.address, params: o.params });
    return this.request<T>(actor, {
      step: o.step,
      route: o.route,
      action: o.action,
      method: "POST",
      body: JSON.stringify({ payload, session: true }),
      headers: { Cookie: this.cookies.get(actor.label) ?? "" },
      classes: ["write"],
      expect: o.expect,
    });
  }

  /** An unsigned JSON POST (token and status reads, public aggregates). */
  async post<T = unknown>(
    actor: Actor,
    o: { step: string; route: string; body: unknown; expect?: Expect; classes?: PaceClass[] },
  ): Promise<HttpResult<T>> {
    return this.request<T>(actor, {
      step: o.step,
      route: o.route,
      method: "POST",
      body: JSON.stringify(o.body),
      classes: o.classes ?? ["read"],
      expect: o.expect ?? "2xx",
    });
  }

  async get<T = unknown>(actor: Actor, o: { step: string; route: string; expect?: Expect }): Promise<HttpResult<T>> {
    return this.request<T>(actor, { step: o.step, route: o.route, method: "GET", classes: ["read"], expect: o.expect ?? "2xx" });
  }

  /** Magic-link multipart upload (POST /api/clients/upload); the MIME type is set on the Blob. */
  async upload<T = unknown>(
    actor: Actor,
    o: {
      step: string;
      fields: Record<string, string>;
      file: { bytes: Uint8Array; name: string; type: string };
      expect?: Expect;
    },
  ): Promise<HttpResult<T>> {
    const form = new FormData();
    for (const [key, v] of Object.entries(o.fields)) form.set(key, v);
    form.set("file", new File([o.file.bytes as BlobPart], o.file.name, { type: o.file.type }));
    return this.request<T>(actor, {
      step: o.step,
      route: "/api/clients/upload",
      method: "POST",
      body: form,
      classes: ["upload"],
      expect: o.expect ?? "2xx",
    });
  }
}

/** The client id and token of an `/onboarding/{id}?t={token}` path. */
export function parseOnboardingPath(value: unknown): { clientId: string; token: string } | null {
  if (typeof value !== "string") return null;
  const match = /^\/onboarding\/([0-9a-f-]{36})\?t=([^&\s]+)$/i.exec(value);
  return match ? { clientId: match[1], token: decodeURIComponent(match[2]) } : null;
}
