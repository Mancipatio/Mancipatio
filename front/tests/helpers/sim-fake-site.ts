/**
 * An in-memory stand-in for devnet manci.io and the chain, for the
 * simulator's cohort tests (tests/sim-cohorts.test.ts). The routes follow
 * the real handlers' contracts (docs/mainnet-readiness/sim flow maps): SIWS
 * signatures are verified for real, nonces are single-use, the session
 * cookie only serves read actions, and the owner's decisions are methods the
 * test calls. Nothing here touches the network.
 */
import { randomUUID } from "node:crypto";
import { getPublicKeyFromAddress, getUtf8Encoder, verifySignature, type Address, type KeyPairSigner } from "@solana/kit";
import type { SaleDocumentTerms } from "@/lib/document-terms";
import { OfferStatus, OtcDealStatus } from "@/lib/generated/asset_registry";
import { isDefaultApprovedJurisdiction, type ReceiverEligibility } from "@/lib/passport";
import { siwsMessage, type SiwsPayload } from "@/lib/siws-client";
import { isSessionReadAction } from "@/lib/siws-session";
import { TOS_VERSION } from "@/lib/tos-version";
import { TOKEN_2022 } from "@/lib/transaction-builders";
import { ChainRpcError } from "@/scripts/chain/lib/safety";
import { SimRetryLater, SimTxError, type ChainOps, type DealView, type OfferView, type TokenAccountView } from "@/scripts/sim/lib/chain";
import { SITE_ORIGIN } from "@/scripts/sim/lib/constants";
import type { JournalSink } from "@/scripts/sim/lib/journal";
import type { Limiter } from "@/scripts/sim/lib/pacing";
import { SimStopError } from "@/scripts/sim/lib/safety";
import type { OfferRecord, UserState, XferSnapshot } from "@/scripts/sim/lib/state";
import { describeExpect, describeResult, matchProbe, transferLanded, type ProbeExpect, type ProbeOutcome, type ProbeResult, type TransferSpec } from "@/scripts/sim/lib/transfers";

export const ASSET = "8YnEMkoDmMknKqJuxdyeChV9GuafyMudYxdHcMYbFVVn" as Address;
export const SALES = ["75CuSX8gJqtjNkPjz3jR7P9eFxGP9bR1wJ2ugoRw4Haf", "AvQjGoQDreVZgsA4GJXndViY4qCBEYBBa1cJf9NJLAqg"];
/** e2e buyer3 in the cohort-X tests (a valid address nobody holds) and the class A mint the world uses. */
export const DONOR = "6uNWmFjnXJqrHMSPNjmhmHLPgd4GRfJtAjjKUKwVcyB3" as Address;
export const FAKE_MINT_A = SALES[0] as Address;
export const FAKE_MINT_B = "EVAiScjWTEhT9fweDht22jR3VK9M6KVpeMdrVu3dkGaK" as Address;

type Requirement = { id: number; doc_kind: string; status: string };
type Dossier = {
  id: string;
  wallet: string;
  kind: "kyc" | "kyb";
  token: string;
  kyc_status: string;
  kyb_status: string;
  requirements: Requirement[];
  uploads: { kind: string; type: string; size: number; name: string }[];
};
type Application = { id: string; wallet: string; status: string; company_name: string; raise_amount: number };
type OtcRow = { id: string; seller_wallet: string; buyer_wallet: string; status: string; deal_pda: string | null; requested_by: string };

const DETAIL_KEYS = new Set([
  "kind", "legal_name", "date_of_birth", "nationality", "residence_country", "address_line", "city",
  "postal_code", "phone", "email", "company_name", "company_reg_number", "company_country",
  "company_address", "company_website", "representative_role",
]);
const UPLOAD_TYPES = new Set(["application/pdf", "image/png", "image/jpeg", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"]);

class Refused extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export class FakeSite {
  nonces = new Set<string>();
  sessions = new Map<string, string>();
  dossiers = new Map<string, Dossier>();
  applications: Application[] = [];
  otc: OtcRow[] = [];
  termsPublished = true;
  /** Settled purchases the chain knows: signature → buyer. */
  purchases = new Map<string, { buyer: string; sale: string; amount: number }>();
  recordCalls = new Map<string, number>();
  /** Wallets with an undecided passport request (a wallet KYC submit files one). */
  openPassportRequests = new Set<string>();
  requests: { route: string; status: number }[] = [];
  /** Route → forced status (failure injection). */
  fail = new Map<string, { status: number; code?: string }>();
  /** Route → a forced status for the next `times` requests only. */
  failNext = new Map<string, { status: number; times: number }>();
  private reqId = 1;

  // ── The owner's decisions ─────────────────────────────────────────────
  dossierOf(wallet: string): Dossier {
    const d = this.dossiers.get(wallet);
    if (!d) throw new Error(`no dossier for ${wallet}`);
    return d;
  }
  verify(wallet: string) {
    const d = this.dossierOf(wallet);
    for (const r of d.requirements) r.status = "approved";
    d.kyc_status = "verified";
  }
  reject(wallet: string) {
    this.dossierOf(wallet).kyc_status = "rejected";
  }
  rejectDocument(wallet: string, kind: string) {
    const d = this.dossierOf(wallet);
    // As review-requirement: the dossier status does not move on a rejection.
    d.requirements.find((r) => r.doc_kind === kind)!.status = "rejected";
  }
  issuePassport(wallet: string) {
    this.openPassportRequests.delete(wallet);
  }
  kybVerify(wallet: string) {
    this.dossierOf(wallet).kyb_status = "verified";
  }
  review(wallet: string, status: "approved" | "rejected" | "needs_changes") {
    this.applications.filter((a) => a.wallet === wallet).forEach((a) => (a.status = status));
  }
  openDeal(id: string, dealPda: string) {
    const row = this.otc.find((r) => r.id === id)!;
    row.status = "created";
    row.deal_pda = dealPda;
  }

  // ── Transport ──────────────────────────────────────────────────────────
  fetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const route = url.pathname;
    const headers = new Headers(init?.headers);
    let status = 200;
    let payload: unknown;
    const extra: Record<string, string> = {};
    try {
      if (url.origin !== SITE_ORIGIN) throw new Refused(421, "wrong host");
      let forced: { status: number; code?: string } | undefined = this.fail.get(route);
      const once = this.failNext.get(route);
      if (once && once.times > 0) {
        once.times -= 1;
        forced = { status: once.status };
      }
      if (forced) {
        status = forced.status;
        payload = { ok: false, error: "forced", code: forced.code };
      } else {
        const result = await this.handle(route, url, init?.body ?? null, headers, extra);
        status = result.status ?? 200;
        payload = { ok: true, data: result.data };
      }
    } catch (error) {
      if (!(error instanceof Refused)) throw error;
      status = error.status;
      payload = { ok: false, error: error.message };
    }
    this.requests.push({ route, status });
    return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json", ...extra } });
  }) as typeof fetch;

  private async verifyEnvelope(route: string, body: Record<string, unknown>, headers: Headers, action: string): Promise<{ wallet: string; params: Record<string, unknown> }> {
    const payload = body.payload as SiwsPayload | undefined;
    if (!payload || typeof payload !== "object") throw new Refused(400, "Missing payload");
    if (payload.origin !== SITE_ORIGIN) throw new Refused(401, "Signature is for a different app origin");
    const browser = headers.get("origin");
    if (browser !== null && browser !== payload.origin) throw new Refused(401, "Request origin does not match the signed origin");
    if (payload.network !== "devnet") throw new Refused(401, "Signature is for a different Solana network");
    if (payload.action !== action) throw new Refused(401, "Signed action does not match this endpoint");
    if (Math.abs(Date.now() - Date.parse(payload.ts)) > 300_000) throw new Refused(401, "Signature expired or timestamp invalid");
    if (body.session === true) {
      if (!isSessionReadAction(action)) throw new Refused(401, "This action requires a wallet signature");
      const cookie = headers.get("cookie") ?? "";
      if (!cookie || this.sessions.get(cookie) !== payload.wallet) throw new Refused(401, "Wallet session expired — sign in again");
    } else {
      if (body.publicKey !== payload.wallet) throw new Refused(401, "publicKey does not match payload wallet");
      const key = await getPublicKeyFromAddress(payload.wallet as Address);
      const sig = new Uint8Array(Buffer.from(String(body.signature), "base64"));
      if (sig.length !== 64 || !(await verifySignature(key, sig as never, getUtf8Encoder().encode(siwsMessage(payload))))) {
        throw new Refused(401, "Signature verification failed");
      }
    }
    if (this.nonces.has(payload.nonce)) throw new Refused(401, "Nonce already used or expired");
    this.nonces.add(payload.nonce);
    void route;
    return { wallet: payload.wallet, params: payload.params };
  }

  private async handle(route: string, url: URL, raw: unknown, headers: Headers, extra: Record<string, string>): Promise<{ status?: number; data?: unknown }> {
    if (raw instanceof FormData) return this.upload(raw);
    const text = typeof raw === "string" ? raw : "";
    const cap = route.startsWith("/api/account") || route === "/api/auth/session" ? 4_096 : route === "/api/verification/submit" ? 8_192 : 1_000_000;
    if (text.length > cap) throw new Refused(413, "Request is too large");
    const body = (text ? JSON.parse(text) : {}) as Record<string, unknown>;
    const signed = (action: string) => this.verifyEnvelope(route, body, headers, action);
    switch (route) {
      case "/": return { data: "home" };
      case "/api/auth/session": {
        const { wallet } = await signed("auth.session");
        const cookie = `manci_session=tok-${randomUUID()}`;
        this.sessions.set(cookie, wallet);
        extra["set-cookie"] = `${cookie}; Path=/api; HttpOnly; SameSite=Strict; Secure`;
        return { data: { wallet } };
      }
      case "/api/account/me": {
        const { wallet, params } = await signed("account.me");
        if (Object.keys(params).length) throw new Refused(400, "Unsupported account field");
        return { data: { profile: { id: `acct-${wallet.slice(0, 8)}`, primary_wallet: wallet } } };
      }
      case "/api/account/update": {
        const { params } = await signed("account.update");
        if (typeof params.display_name !== "string" || params.display_name.length > 100) throw new Refused(400, "Display name must be at most 100 characters");
        return { data: {} };
      }
      case "/api/tos/accept": {
        const { params } = await signed("tos.accept");
        if (params.version !== TOS_VERSION) throw new Refused(400, "version must be the current Terms of Service version");
        return { data: { accepted: true } };
      }
      case "/api/account/wallets/transaction": {
        const { wallet } = await signed("account.wallets.transaction");
        return { data: { wallet, network: "devnet", account_id: `acct-${wallet.slice(0, 8)}`, primary_wallet: wallet } };
      }
      case "/api/verification/submit": {
        const { wallet, params } = await signed("verification.submit");
        return { data: this.submit(wallet, params) };
      }
      case "/api/clients/onboarding-requirements": {
        const d = this.byToken(String(body.client_id), body.token);
        return { data: { requirements: d.requirements } };
      }
      case "/api/clients/me": {
        const { wallet } = await signed("clients.me");
        const d = this.dossiers.get(wallet);
        const open = d && (d.kyc_status === "pending" || d.kyc_status === "more_info");
        return { data: { client: d ? { id: d.id, kyc_status: d.kyc_status } : null, onboarding_path: open ? `/onboarding/${d!.id}?t=${d!.token}` : null } };
      }
      case "/api/applications/eligibility": {
        const d = this.dossiers.get(String(body.wallet));
        const company = d?.kind === "kyb" && d.kyb_status === "verified";
        const individual = d?.kind === "kyc" && d.kyc_status === "verified";
        return { data: { eligible: company || individual, applicantKind: company ? "company" : individual ? "individual" : null, kybStatus: d?.kind === "kyb" ? d.kyb_status : "none" } };
      }
      case "/api/applications/mine": {
        const { wallet } = await signed("applications.mine");
        return { data: { applications: this.applications.filter((a) => a.wallet === wallet), events: [] } };
      }
      case "/api/applications/submit": {
        const { wallet, params } = await signed("applications.submit");
        const d = this.dossiers.get(wallet);
        if (!d || !((d.kind === "kyb" && d.kyb_status === "verified") || (d.kind === "kyc" && d.kyc_status === "verified"))) throw new Refused(403, "Verification required to apply");
        const app = params.application as { raise_amount: number; company_name: string };
        if (app.raise_amount > 3_000_000) throw new Refused(400, "raise_amount must be at most 3000000");
        const row = { id: randomUUID(), wallet, status: "pending", company_name: app.company_name, raise_amount: app.raise_amount };
        this.applications.push(row);
        return { data: { id: row.id } };
      }
      case "/api/applications/resubmit": {
        const { wallet, params } = await signed("applications.resubmit");
        const row = this.applications.find((a) => a.id === params.id && a.wallet === wallet);
        if (!row) throw new Refused(404, "Application not found");
        if (row.status !== "needs_changes") throw new Refused(409, "Only an application marked needs_changes can be resubmitted");
        row.status = "pending";
        return { data: { id: row.id } };
      }
      case "/api/issuer-profiles/upsert": {
        const { params } = await signed("issuer-profiles.upsert");
        if (!params.profile || typeof (params.profile as { issuer_pda?: unknown }).issuer_pda !== "string") throw new Refused(400, "Missing profile");
        return { data: {} };
      }
      case "/api/launchpad/terms": {
        const sale = url.searchParams.get("sale") ?? "";
        if (!SALES.includes(sale)) throw new Refused(400, "Valid sale address required");
        if (!this.termsPublished) throw new Refused(409, "The issuer must publish a verified document version before accepting investments in the app");
        const terms: SaleDocumentTerms = { sale, asset: ASSET, versionId: "10000000-0000-4000-8000-000000000001", sha256: "ab".repeat(32), url: "https://example.com/wp.pdf", verifiedAt: new Date(0).toISOString() };
        return { data: terms };
      }
      case "/api/launchpad/record-purchase": {
        const { wallet, params } = await signed("launchpad.recordPurchase");
        if (params.investor_wallet !== wallet) throw new Refused(403, "Only the buyer may record their purchase");
        const known = this.purchases.get(String(params.settled_tx));
        if (!known || known.buyer !== wallet || known.sale !== params.sale_pubkey) throw new Refused(400, "The transaction is not this wallet's purchase on this sale");
        const calls = (this.recordCalls.get(String(params.settled_tx)) ?? 0) + 1;
        this.recordCalls.set(String(params.settled_tx), calls);
        return calls === 1 ? { status: 202, data: { id: null, jobId: "j", status: "pending" } } : { data: { id: "c1", jobId: "j", status: "complete" } };
      }
      case "/api/launchpad/commitment-aggregate": {
        const sale = String(body.sale_pubkey);
        const rows = [...this.purchases.entries()].filter(([sig, p]) => p.sale === sale && this.recordCalls.has(sig)).map(([, p]) => p);
        return { data: { pledged: "0", settled: String(rows.reduce((s, r) => s + r.amount, 0)), backers: new Set(rows.map((r) => r.buyer)).size } };
      }
      case "/api/otc/create": {
        const { wallet, params } = await signed("otc.create");
        if (params.seller_wallet === params.buyer_wallet) throw new Refused(400, "Buyer and seller must be different wallets");
        if (typeof params.amount !== "number" || params.amount <= 0) throw new Refused(400, "amount must be a positive integer");
        if (wallet !== params.seller_wallet && wallet !== params.buyer_wallet) throw new Refused(403, "You must be a party");
        const row = { id: randomUUID(), seller_wallet: String(params.seller_wallet), buyer_wallet: String(params.buyer_wallet), status: "requested", deal_pda: null, requested_by: wallet };
        this.otc.push(row);
        return { data: { id: row.id } };
      }
      case "/api/otc/list": {
        const { wallet } = await signed("otc.list");
        return { data: this.otc.filter((r) => r.seller_wallet === wallet || r.buyer_wallet === wallet) };
      }
      case "/api/passport/status":
        return { data: { open: this.openPassportRequests.has(String(body.wallet)) ? { id: 1, status: "new" } : null } };
      default:
        throw new Refused(404, "Not found");
    }
  }

  private submit(wallet: string, params: Record<string, unknown>) {
    for (const key of Object.keys(params)) if (!DETAIL_KEYS.has(key)) throw new Refused(400, `Unknown field: ${key}`);
    const kind = params.kind as "kyc" | "kyb";
    if (kind === "kyc") {
      const dob = String(params.date_of_birth ?? "");
      const age = (Date.now() - Date.parse(`${dob}T00:00:00Z`)) / (365.25 * 86_400_000);
      if (!(age >= 18)) throw new Refused(400, "You must be at least 18 years old");
      if (!isDefaultApprovedJurisdiction(Number(params.residence_country))) throw new Refused(400, "This country is not supported for verification yet");
    }
    if (!params.postal_code) throw new Refused(400, "postal code is required");
    if (typeof params.phone === "string" && params.phone.length < 5) throw new Refused(400, "phone must be 5–32 characters");
    const existing = this.dossiers.get(wallet);
    if (existing && (existing.kyc_status === "rejected" || existing.kyc_status === "suspended")) throw new Refused(403, "Your KYC dossier is rejected");
    const kinds = kind === "kyb" ? ["incorporation", "board_resolution", "passport", "proof_of_address"] : ["passport", "proof_of_address", "selfie"];
    const d: Dossier = existing ?? {
      id: randomUUID(),
      wallet,
      kind,
      token: randomUUID().replace(/-/g, ""),
      kyc_status: "more_info",
      kyb_status: kind === "kyb" ? "pending" : "none",
      requirements: kinds.map((doc_kind) => ({ id: this.reqId++, doc_kind, status: "requested" })),
      uploads: [],
    };
    this.dossiers.set(wallet, d);
    if (kind === "kyc") this.openPassportRequests.add(wallet);
    return { client_id: d.id, kyc_status: d.kyc_status, onboarding_path: `/onboarding/${d.id}?t=${d.token}` };
  }

  private byToken(clientId: string, token: unknown): Dossier {
    const d = [...this.dossiers.values()].find((x) => x.id === clientId);
    if (!d || typeof token !== "string" || d.token !== token) throw new Refused(401, "Invalid onboarding token");
    return d;
  }

  private async upload(form: FormData): Promise<{ data: unknown }> {
    const file = form.get("file");
    if (!(file instanceof File)) throw new Refused(400, "Missing file");
    if (file.size > 4.5 * 1024 * 1024) throw new Refused(413, "FUNCTION_PAYLOAD_TOO_LARGE");
    if (file.size === 0) throw new Refused(400, "Empty file");
    const d = this.byToken(String(form.get("client_id")), form.get("token"));
    if (!UPLOAD_TYPES.has(file.type)) throw new Refused(400, "Unsupported file type — upload a PDF, PNG, JPG or DOCX");
    const reqId = form.get("requirement_id");
    if (reqId) {
      const r = d.requirements.find((x) => x.id === Number(reqId));
      if (!r) throw new Refused(404, "Requirement not found for this client");
      r.status = "submitted";
    }
    d.uploads.push({ kind: String(form.get("kind")), type: file.type, size: file.size, name: file.name });
    if (d.kyc_status === "more_info" && d.requirements.every((r) => r.status !== "requested" && r.status !== "rejected")) d.kyc_status = "pending";
    return { data: { document_id: d.uploads.length, recomputed: d.kyc_status } };
  }
}

/** A scripted failure of one cohort-X send (by tx label), consumed once. */
export type XferFault =
  /** The signature was saved inflight, then the process died before the send. */
  | "crash-before-send"
  /** It landed, but the status was lost: the executor saw "dropped". */
  | "landed-status-lost"
  /** It was sent and landed, but did not finalize in time ("unknown"): the record stays inflight. */
  | "unresolved"
  /** The inflight record was persisted and the wire landed, then the process died before the landed record. */
  | "process-death"
  /** The simulation refused it (a SimTxError, as the executor throws). */
  | "sim-error";

/** What the inflight branch answers on one pass (scripted): still unresolved, or the status lookup failed. */
export type InflightAnswer = "pending" | "rpc-error";

/** The process died (fault "process-death"): nothing after it is persisted. */
export class FakeProcessDeath extends SimStopError {
  constructor(label: string) {
    super(`fake process death after sending ${label}`);
  }
}

/**
 * The chain side: records each operation, lands it at once, keeps offers and
 * deals — and, for cohort X, class A token balances per account (ATAs are
 * `ata-<owner>`, an offer escrow `escrow-<offer>`), the donor, escrow markers
 * and scripted probe results. A landed label is never landed twice (as the
 * executor skips it); an optional limiter paces sends like the real one.
 */
export class FakeChainOps implements ChainOps {
  calls: { op: string; user: string; detail?: unknown }[] = [];
  offers = new Map<string, OfferView>();
  deals = new Map<string, DealView>();
  issued = new Set<string>();
  chainTime = BigInt(1_790_000_000);
  // ── cohort X ──
  donor: Address | null = DONOR;
  tokens = new Map<string, { owner: string; amount: bigint; immutableOwner: boolean }>();
  markers = new Set<string>();
  supplyUnits = BigInt(1_000);
  eligible: ReceiverEligibility = { gated: false, ok: true, reason: "" };
  /** Probe id → the simulated result (default: exactly the expected one). */
  probeResults = new Map<string, ProbeResult>();
  faults = new Map<string, XferFault>();
  /** Labels whose simulation always refuses (until removed). */
  failAlways = new Set<string>();
  /** Called when a scripted fault fires (a test moves balances "outside the simulator" here). */
  onFault?: (label: string, fault: XferFault) => void;
  /** Called after every landing (a test injects a failure at a point of the flow here). */
  onLand?: (u: UserState, label: string) => void;
  /** Label → answers of the inflight branch, one per pass, before the chain's truth (TxExecutor.run). */
  inflightAnswers = new Map<string, InflightAnswer[]>();
  /** Probe id → how many times its RPC fails (a ChainRpcError, as the guarded client throws after 3 tries). */
  probeFaults = new Map<string, number>();
  /** Label → how many times the send's done() balance read fails (a ChainRpcError) before anything is sent. */
  doneFaults = new Map<string, number>();
  /** User → how many times buy()'s builder read fails (a ChainRpcError) before anything is signed. */
  buyFaults = new Map<string, number>();
  /** Every wire that reached the chain, as `user:label` — a double send shows here, not only in balances. */
  sentWires: string[] = [];
  /** Signatures whose wire reached the chain: an inflight record of one resolves as landed, of another as dropped. */
  private wires = new Set<string>();
  /** The executor's settle() persists the inflight record before the send (the world's ctx.persist). */
  persist?: () => void;
  /** A fake process death: the world stops persisting (onDeath) until the test reloads it (onRevive). */
  onDeath?: () => void;
  onRevive?: () => void;
  /** Account → values the next reads return instead of the real one (installed after a label lands). */
  staleAfter = new Map<string, { account: string; values: (bigint | null)[] }>();
  private stale = new Map<string, (bigint | null)[]>();
  signedSteps = new Set<string>();
  journal?: JournalSink;
  limiter?: Limiter;
  txInFlight = 0;
  txPeak = 0;
  txTimes: number[] = [];
  /** The world's clock: the tx records' `at` (as TxExecutor's, on the run's clock) and txTimes. */
  now_?: () => number;

  constructor(private readonly site: FakeSite) {
    this.tokens.set(this.ataKey(DONOR), { owner: DONOR, amount: BigInt(5), immutableOwner: true });
  }

  private stamp(): string {
    return new Date((this.now_ ?? Date.now)()).toISOString();
  }

  private land(u: UserState, label: string, detail?: unknown): string {
    const sig = `sig-${u.plan.label}-${label}`;
    u.tx[label] = { status: "landed", sig, at: this.stamp() };
    this.calls.push({ op: label, user: u.plan.label, detail });
    this.signedSteps.add(`${u.plan.label}:${label}`);
    this.wires.add(sig);
    this.sentWires.push(`${u.plan.label}:${label}`);
    const stale = this.staleAfter.get(label);
    if (stale) {
      this.stale.set(stale.account, [...stale.values]);
      this.staleAfter.delete(label);
    }
    this.onLand?.(u, label);
    return sig;
  }

  /** One transaction in flight, ≤ 3/min — when the test gives a limiter. */
  private async paced<T>(send: () => Promise<T> | T): Promise<T> {
    if (!this.limiter) return send();
    const unlock = await this.limiter.lockTx();
    try {
      await this.limiter.acquire(["tx"], { http: false });
      this.txInFlight += 1;
      this.txPeak = Math.max(this.txPeak, this.txInFlight);
      if (this.now_) this.txTimes.push(this.now_());
      return await send();
    } finally {
      this.txInFlight -= 1;
      unlock();
    }
  }

  /** A refused simulation, journalled as the executor does (tx-error) and thrown as its SimTxError. */
  private refuse(u: UserState, label: string): never {
    const err = `${label}: signed simulation failed: asset_registry: PlatformPaused (6001)`;
    this.journal?.append({ wave: u.plan.wave, user: u.plan.label, cohort: u.plan.cohort, step: label, kind: "tx", ix: label, outcome: "tx-error", err });
    throw new SimTxError(label, { program: "asset_registry", code: 6001, name: "PlatformPaused" }, [], err);
  }
  private takeFault(label: string): XferFault | undefined {
    if (this.failAlways.has(label)) return "sim-error";
    const fault = this.faults.get(label);
    this.faults.delete(label);
    return fault;
  }

  ataKey(owner: string): string {
    return `ata-${owner}`;
  }
  balanceOf(owner: string): bigint {
    return this.tokens.get(this.ataKey(owner))?.amount ?? BigInt(0);
  }
  private move(from: string, to: string, amount: bigint, toOwner: string) {
    const src = this.tokens.get(from);
    if (!src || src.amount < amount) throw new Error(`fake: ${from} holds too little`);
    src.amount -= amount;
    const dst = this.tokens.get(to) ?? { owner: toOwner, amount: BigInt(0), immutableOwner: true };
    dst.amount += amount;
    this.tokens.set(to, dst);
  }

  async now(): Promise<bigint> {
    return this.chainTime;
  }
  async buy(u: UserState, _signer: KeyPairSigner, sale: Address, amount: bigint, terms: SaleDocumentTerms): Promise<string | null> {
    if (u.tx.buy?.status === "landed") return u.tx.buy.sig;
    const faults = this.buyFaults.get(u.plan.label) ?? 0;
    if (faults > 0) {
      // The builder's account read fails before anything is signed, as the guarded client throws after its tries.
      this.buyFaults.set(u.plan.label, faults - 1);
      throw new ChainRpcError("getAccountInfo", 429);
    }
    const sig = await this.paced(() => this.land(u, "buy", { sale, amount, terms: terms.versionId }));
    this.site.purchases.set(sig, { buyer: u.wallet, sale, amount: Number(amount) });
    // The units arrive in the buyer's ATA (cohort X's own-buy route reads them).
    const ata = this.tokens.get(this.ataKey(u.wallet)) ?? { owner: u.wallet, amount: BigInt(0), immutableOwner: true };
    ata.amount += amount;
    this.tokens.set(this.ataKey(u.wallet), ata);
    this.supplyUnits += amount;
    return sig;
  }
  async offerPda(offerId: bigint): Promise<Address> {
    return `offer-${offerId}` as Address;
  }
  async offer(pda: Address): Promise<OfferView | null> {
    return this.offers.get(pda) ?? null;
  }
  async createOffer(u: UserState, _s: KeyPairSigner, key: string, offer: OfferRecord): Promise<void> {
    if (u.tx[`${key}.create`]?.status === "landed") return;
    if (this.takeFault(`${key}.create`) === "sim-error") this.refuse(u, `${key}.create`);
    await this.paced(() => this.land(u, `${key}.create`));
    this.offers.set(offer.pda, { status: OfferStatus.Open, deposited: BigInt(0), expiresAt: BigInt(offer.expiresAt), maker: u.wallet, escrow: `escrow-${offer.pda}` });
    this.tokens.set(`escrow-${offer.pda}`, { owner: offer.pda, amount: BigInt(0), immutableOwner: true });
    this.markers.add(offer.pda);
  }
  async depositOffer(u: UserState, _s: KeyPairSigner, key: string, offer: OfferRecord): Promise<void> {
    if (u.tx[`${key}.deposit`]?.status === "landed") return;
    if (this.takeFault(`${key}.deposit`) === "sim-error") this.refuse(u, `${key}.deposit`);
    await this.paced(() => this.land(u, `${key}.deposit`));
    this.offers.get(offer.pda)!.deposited = BigInt(offer.amount);
    const maker = this.tokens.get(this.ataKey(u.wallet));
    if (maker) this.move(this.ataKey(u.wallet), `escrow-${offer.pda}`, BigInt(offer.amount), offer.pda);
  }
  async cancelOffer(u: UserState, _s: KeyPairSigner, key: string, offer: OfferRecord): Promise<void> {
    if (u.tx[`${key}.cancel`]?.status === "landed") return;
    await this.paced(() => this.land(u, `${key}.cancel`));
    const view = this.offers.get(offer.pda)!;
    view.status = OfferStatus.Cancelled;
    // As cancel_offer: the whole escrow back to the maker, the ledger to 0, the marker closed (the Offer stays).
    const escrow = this.tokens.get(`escrow-${offer.pda}`);
    if (escrow && escrow.amount > BigInt(0)) this.move(`escrow-${offer.pda}`, this.ataKey(u.wallet), escrow.amount, u.wallet);
    view.deposited = BigInt(0);
    this.markers.delete(offer.pda);
  }
  async takeOffer(u: UserState, _s: KeyPairSigner, key: string, pda: Address): Promise<void> {
    this.land(u, `${key}.take`);
    this.offers.get(pda)!.status = OfferStatus.Filled;
  }
  async expireOffer(u: UserState, _s: KeyPairSigner, key: string, pda: Address): Promise<void> {
    const offer = this.offers.get(pda)!;
    if (this.chainTime <= offer.expiresAt) throw new Error("OfferNotExpired");
    this.land(u, `${key}.expire`);
    offer.status = OfferStatus.Expired;
  }
  async registerIssuer(u: UserState, _s: KeyPairSigner, legalId: string): Promise<Address> {
    this.land(u, "issuer.register", legalId);
    return `issuer-${legalId}` as Address;
  }
  async deal(pda: Address): Promise<DealView | null> {
    return this.deals.get(pda) ?? null;
  }
  async depositDealAsset(u: UserState, _s: KeyPairSigner, pda: Address): Promise<void> {
    this.land(u, "deal.depositAsset");
    this.settle(pda, "asset");
  }
  async depositDealPayment(u: UserState, _s: KeyPairSigner, pda: Address): Promise<void> {
    this.land(u, "deal.depositPayment");
    this.settle(pda, "payment");
  }
  private settle(pda: string, side: "asset" | "payment") {
    const d = this.deals.get(pda) ?? { status: OtcDealStatus.Open, assetDeposited: false, paymentDeposited: false, seller: "", buyer: "" };
    if (side === "asset") d.assetDeposited = true;
    else d.paymentDeposited = true;
    if (d.assetDeposited && d.paymentDeposited) d.status = OtcDealStatus.Completed;
    this.deals.set(pda, d);
  }
  async passports(wallets: string[]): Promise<Map<string, boolean>> {
    this.calls.push({ op: "passports", user: "-", detail: wallets.length });
    return new Map(wallets.map((w) => [w, this.issued.has(w)]));
  }

  // ── Cohort X ───────────────────────────────────────────────────────────────

  async ata(owner: Address): Promise<Address> {
    return this.ataKey(owner) as Address;
  }
  async balances(accounts: Address[]): Promise<(bigint | null)[]> {
    return accounts.map((a) => {
      const forced = this.stale.get(a);
      if (forced?.length) return forced.shift()!;
      return this.tokens.get(a)?.amount ?? null;
    });
  }
  async supply(): Promise<{ supply: bigint; circulating: bigint }> {
    return { supply: this.supplyUnits, circulating: this.supplyUnits };
  }
  async tokenAccount(address: Address): Promise<TokenAccountView | null> {
    const t = this.tokens.get(address);
    return t ? { program: TOKEN_2022, mint: FAKE_MINT_A, owner: t.owner, amount: t.amount, immutableOwner: t.immutableOwner } : null;
  }
  async escrowMarker(owner: Address): Promise<boolean> {
    return this.markers.has(owner);
  }
  async eligibility(): Promise<ReceiverEligibility> {
    return this.eligible;
  }
  /**
   * As TxExecutor.run: a landed label is skipped; an inflight record is never
   * re-signed — the scripted answers first (still unresolved, or the status
   * lookup failing), then the chain's truth (its wire landed: landed; never
   * sent: dropped once expired, and rebuilt).
   */
  private async send(u: UserState, label: string, snap: XferSnapshot): Promise<void> {
    const prior = u.tx[label];
    if (prior?.status === "landed") return;
    if (prior?.status === "inflight") {
      const answer = this.inflightAnswers.get(label)?.shift();
      if (answer === "rpc-error") throw new ChainRpcError("getSignatureStatuses", 429);
      if (answer === "pending") throw new SimRetryLater(`${label}: an earlier signature is still unresolved`);
      if (prior.sig && this.wires.has(prior.sig)) {
        u.tx[label] = { ...prior, status: "landed" };
        return;
      }
      delete u.tx[label];
    }
    const doneFails = this.doneFaults.get(label) ?? 0;
    if (doneFails > 0) {
      this.doneFaults.set(label, doneFails - 1);
      throw new ChainRpcError("getMultipleAccounts", 503);
    }
    const fault = this.takeFault(label);
    // The executor's done(): the snapshot's post-state lands without a send.
    const balances = await this.balances([snap.srcAta as Address, snap.dstAta as Address]);
    if (transferLanded(label, snap, balances)) {
      u.tx[label] = { status: "landed", sig: null, at: this.stamp() };
      return;
    }
    if (fault === "crash-before-send") {
      u.tx[label] = { status: "inflight", sig: `sig-${u.plan.label}-${label}`, lvbh: "0", at: this.stamp() };
      this.signedSteps.add(`${u.plan.label}:${label}`);
      this.onFault?.(label, fault);
      throw new SimRetryLater(`${label}: an earlier signature is still unresolved`);
    }
    if (fault === "sim-error") this.refuse(u, label);
    if (fault === "process-death") {
      // settle(inflight) persists before the send; the wire lands; the process dies before the landed record.
      u.tx[label] = { status: "inflight", sig: `sig-${u.plan.label}-${label}`, lvbh: "0", at: this.stamp() };
      this.persist?.();
    }
    await this.paced(() => {
      this.move(snap.srcAta, snap.dstAta, BigInt(snap.amount), snap.dstOwner);
      this.land(u, label, { from: snap.srcOwner, to: snap.dstOwner, amount: snap.amount });
    });
    if (fault === "process-death") {
      this.onDeath?.();
      this.onFault?.(label, fault);
      throw new FakeProcessDeath(label);
    }
    if (fault === "landed-status-lost") {
      delete u.tx[label];
      throw new SimRetryLater(`${label} expired without landing`);
    }
    if (fault === "unresolved") {
      u.tx[label] = { ...u.tx[label], status: "inflight", lvbh: "0" };
      throw new SimRetryLater(`${label} unknown; resolved on the next pass`);
    }
  }
  /** The signers do not matter to the fake: the snapshot names the accounts. */
  transfer(u: UserState, label: string, snap: XferSnapshot): Promise<void> {
    return this.send(u, label, snap);
  }
  async seedFromDonor(u: UserState, label: string, snap: XferSnapshot): Promise<void> {
    if (u.tx[label]?.status === "landed") return; // as SimChainOps: a landed seed needs no signer
    if (!this.donor || snap.srcOwner !== this.donor) throw new SimRetryLater(`${label}: the donor signer is not loaded (SIM_DONOR_KEYPAIR)`);
    return this.send(u, label, snap);
  }
  async probe(u: UserState, id: string, spec: TransferSpec, expect: ProbeExpect): Promise<ProbeOutcome> {
    const rpcFails = this.probeFaults.get(id) ?? 0;
    if (rpcFails > 0) {
      this.probeFaults.set(id, rpcFails - 1);
      throw new ChainRpcError("getLatestBlockhash", 429);
    }
    this.calls.push({ op: `probe ${id}`, user: u.plan.label, detail: spec });
    const expected: ProbeResult = expect.ok
      ? { ok: true, failure: null, hookInvoked: expect.hookInvoked ?? true }
      : { ok: false, failure: { program: expect.program, code: expect.code, name: expect.names[0] }, hookInvoked: false };
    const result = this.probeResults.get(id) ?? expected;
    const outcome = matchProbe(expect, result);
    const finding = outcome === "tx-error" || outcome === "unexpected-accept";
    this.journal?.append({
      wave: u.plan.wave,
      user: u.plan.label,
      cohort: u.plan.cohort,
      step: `xfer.${id}`,
      kind: "probe",
      ix: `probe ${id}`,
      expected: describeExpect(expect),
      outcome,
      body: finding ? undefined : describeResult(result),
      err: finding ? `expected ${describeExpect(expect)}, simulated ${describeResult(result)}` : undefined,
    });
    return outcome;
  }
  everSigned(u: UserState, label: string): boolean {
    return Boolean(u.tx[label]) || this.signedSteps.has(`${u.plan.label}:${label}`);
  }
}
