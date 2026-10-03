// SERVER-ONLY — wallet sanctions screening (8.5; pravo-compliance-3,
// ops-qa-4, lansiranje-4). Buying, OTC and resell need no KYC (owner
// decision 2026-09-23), so this is the control that keeps a sanctioned
// wallet out of the platform's own services.
//
// The baseline needs no provider: the US Treasury OFAC SDN list, refreshed
// daily into sanctions_addresses (migration 0078, lib/server/sanctions-
// refresh.ts). The routes call requireSanctionsClear(); it asks every
// provider in SANCTIONS_PROVIDERS, so a paid one (Chainalysis, TRM, …) is
// added by implementing SanctionsProvider and listing it there, without
// touching a route.
//
// Rules:
//   - a hit refuses the request (403) on every network and opens one
//     critical compliance alert per wallet (raise_sanctions_hit, emailed
//     through the 0072 outbox; an open alert also blocks passport issuance);
//   - a provider that cannot answer (the list is older than 3 days, was
//     never loaded or loaded no address, or the database cannot be read)
//     refuses with 503 on MAINNET (fail closed) and only logs a warning
//     elsewhere; SANCTIONS_SCREENING=enforce rehearses the mainnet rule on
//     devnet. The alarm worker reports a stale list as an incident
//     (sanctions-list, lib/server/alarm-checks.ts).
// The on-chain buy of an Open class cannot be stopped from here (a primary
// sale mints without the transfer hook). Three lines catch it after the
// fact, none of them depending on the buyer's client: the sale page's
// pre-check (/api/compliance/screen-wallet) for a buyer who uses the UI; the
// purchase record, which records the buy and reports a hit
// (reportSanctionsHits: never a refusal, the buy already landed); and the
// alarm worker, which screens the signer of every finalized buy, offer and
// take the indexer sees (lib/server/onchain-screening.ts, also for a script
// that never touches the site). Compliance then blocklists and claws back
// (runbook). A wallet on the OFAC list but not yet on the on-chain
// blocklist passes the program even after 8.3, so the after-the-fact
// screen stays.
import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { isAddress } from "@solana/kit";
import { detectNetwork, type Network } from "@/lib/network";
import { OFAC_SDN_HIT_LIST, OFAC_SDN_SOURCE } from "@/lib/ofac-sdn";
import { SiwsError } from "@/lib/server/siws-error";

/** The newest a list may be before the routes stop trusting it. */
export const SANCTIONS_MAX_LIST_AGE_MS = 3 * 24 * 3600 * 1000;
/** How long one read of a list is reused by the routes. */
export const SANCTIONS_CACHE_MS = 60_000;

export type SanctionsMatch = {
  provider: string;
  source: string;
  hitList: string;
  currency?: string;
  entryUid?: string;
  entryName?: string;
  programs?: string[];
};

export type UnavailableCode = "LIST_NEVER_LOADED" | "LIST_EMPTY" | "LIST_STALE" | "LIST_UNREADABLE" | "PROVIDER_ERROR";

/** A provider that cannot answer now (never "clear"). */
export class SanctionsUnavailableError extends Error {
  readonly code: UnavailableCode;
  constructor(code: UnavailableCode, message: string) {
    super(message);
    this.name = "SanctionsUnavailableError";
    this.code = code;
  }
}

export type ScreeningContext = { sb: SupabaseClient; now: number };

/**
 * One screening source. `screen` returns the matches of every listed wallet
 * (a wallet absent from the map is clear) and THROWS SanctionsUnavailableError
 * when it cannot vouch for the answer.
 */
export interface SanctionsProvider {
  readonly name: string;
  screen(wallets: readonly string[], ctx: ScreeningContext): Promise<Map<string, SanctionsMatch[]>>;
  status(ctx: ScreeningContext): Promise<ProviderStatus>;
}

export type ProviderStatus = {
  provider: string;
  source: string;
  state: "fresh" | "stale" | "empty" | "never-loaded" | "unreadable";
  publishedOn: string | null;
  refreshedAt: string | null;
  addressCount: number | null;
  lastAttemptAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
};

// ── The baseline provider: a list loaded into the database ────────────────

type ListState = {
  published_on: string | null;
  refreshed_at: string | null;
  address_count: number | null;
  last_attempt_at: string | null;
  last_status: string | null;
  last_error: string | null;
};
type ListRow = { address: string; currency: string; entry_uid: string | null; entry_name: string | null; programs: string[] | null };
type Snapshot = { at: number; state: ListState | null; rows: Map<string, ListRow> };

const snapshots = new Map<string, Snapshot>();

/** Forget cached lists (after a refresh, and in tests). */
export function clearSanctionsCache(): void {
  snapshots.clear();
}

async function loadSnapshot(sb: SupabaseClient, source: string, now: number): Promise<Snapshot> {
  const cached = snapshots.get(source);
  if (cached && now - cached.at < SANCTIONS_CACHE_MS) return cached;
  const [state, rows] = await Promise.all([
    sb.from("sanctions_list_state")
      .select("published_on, refreshed_at, address_count, last_attempt_at, last_status, last_error")
      .eq("source", source)
      .maybeSingle(),
    sb.from("sanctions_addresses").select("address, currency, entry_uid, entry_name, programs").eq("source", source),
  ]);
  if (state.error || rows.error || !Array.isArray(rows.data)) {
    throw new SanctionsUnavailableError("LIST_UNREADABLE", "The sanctions list could not be read");
  }
  const map = new Map<string, ListRow>();
  for (const row of rows.data as ListRow[]) {
    if (row && typeof row.address === "string") map.set(row.address, row);
  }
  const snapshot = { at: now, state: (state.data as ListState | null) ?? null, rows: map };
  snapshots.set(source, snapshot);
  return snapshot;
}

/** Why a loaded list cannot be trusted now, or null. */
export function listProblem(state: ListState | null, loaded: number, now: number): UnavailableCode | null {
  if (!state?.refreshed_at) return "LIST_NEVER_LOADED";
  if (!loaded || !state.address_count) return "LIST_EMPTY";
  const at = Date.parse(state.refreshed_at);
  if (!Number.isFinite(at) || now - at > SANCTIONS_MAX_LIST_AGE_MS) return "LIST_STALE";
  return null;
}

const PROBLEM_STATE: Record<UnavailableCode, ProviderStatus["state"]> = {
  LIST_NEVER_LOADED: "never-loaded",
  LIST_EMPTY: "empty",
  LIST_STALE: "stale",
  LIST_UNREADABLE: "unreadable",
  PROVIDER_ERROR: "unreadable",
};

export function databaseListProvider(name: string, source: string, hitList: string): SanctionsProvider {
  return {
    name,
    async screen(wallets, { sb, now }) {
      const snapshot = await loadSnapshot(sb, source, now);
      const problem = listProblem(snapshot.state, snapshot.rows.size, now);
      if (problem) throw new SanctionsUnavailableError(problem, `The ${hitList} list is not usable (${problem})`);
      const out = new Map<string, SanctionsMatch[]>();
      for (const wallet of wallets) {
        const row = snapshot.rows.get(wallet);
        if (!row) continue;
        out.set(wallet, [{
          provider: name, source, hitList, currency: row.currency,
          entryUid: row.entry_uid ?? undefined, entryName: row.entry_name ?? undefined, programs: row.programs ?? [],
        }]);
      }
      return out;
    },
    async status({ sb, now }) {
      let snapshot: Snapshot;
      try {
        snapshot = await loadSnapshot(sb, source, now);
      } catch {
        return {
          provider: name, source, state: "unreadable", publishedOn: null, refreshedAt: null, addressCount: null,
          lastAttemptAt: null, lastStatus: null, lastError: null,
        };
      }
      const problem = listProblem(snapshot.state, snapshot.rows.size, now);
      const s = snapshot.state;
      return {
        provider: name, source, state: problem ? PROBLEM_STATE[problem] : "fresh",
        publishedOn: s?.published_on ?? null, refreshedAt: s?.refreshed_at ?? null, addressCount: snapshot.rows.size,
        lastAttemptAt: s?.last_attempt_at ?? null, lastStatus: s?.last_status ?? null, lastError: s?.last_error ?? null,
      };
    },
  };
}

/**
 * Every provider the routes ask, in order. A paid provider joins here
 * (implement SanctionsProvider: screen + status; its own credentials in
 * ops/secrets.md); no route changes.
 */
export const SANCTIONS_PROVIDERS: readonly SanctionsProvider[] = [
  databaseListProvider("ofac-sdn-list", OFAC_SDN_SOURCE, OFAC_SDN_HIT_LIST),
];

// ── The gate ──────────────────────────────────────────────────────────────

/** Whether an unavailable screen refuses (mainnet, or SANCTIONS_SCREENING=enforce). */
export function screeningFailsClosed(network: Network = detectNetwork()): boolean {
  return network === "mainnet" || process.env.SANCTIONS_SCREENING?.trim().toLowerCase() === "enforce";
}

export const SCREENING_UNAVAILABLE =
  "Sanctions screening is unavailable right now, so this request cannot be accepted. Nothing was changed; try again later.";
export const SCREENING_SELF_HIT =
  "This wallet cannot be used on Manci: it matched a sanctions list. Nothing was changed. Contact the compliance team if you believe this is a mistake.";
export const SCREENING_COUNTERPARTY_HIT =
  "This request cannot be accepted for the counterparty wallet — contact the compliance team.";

export type ScreenedWallet = { wallet: string; role: "self" | "counterparty" };

export type ScreeningInput = {
  /** The route (or flow) that screens, recorded in the alert: "launchpad/commit". */
  route: string;
  wallets: readonly ScreenedWallet[];
  /** An on-chain transaction the request is about (recorded in the alert). */
  txSignature?: string | null;
};

export type ScreeningResult = {
  /** Wallets with at least one match. */
  hits: Map<string, SanctionsMatch[]>;
  /** Providers that could not answer (only when the screen does not fail closed). */
  unavailable: { provider: string; code: UnavailableCode }[];
};

let lastWarning = 0;

/**
 * Screens `wallets` with every provider. Returns the hits and the providers
 * that could not answer; THROWS SiwsError(503) instead when a provider cannot
 * answer and the screen fails closed. Raises nothing: requireSanctionsClear
 * does, and so does a caller that only reports (api/compliance/open-wallets).
 */
export async function screenWallets(
  sb: SupabaseClient,
  wallets: readonly string[],
  opts: { now?: number; providers?: readonly SanctionsProvider[]; network?: Network } = {},
): Promise<ScreeningResult> {
  const now = opts.now ?? Date.now();
  const network = opts.network ?? detectNetwork();
  const providers = opts.providers ?? SANCTIONS_PROVIDERS;
  const valid = [...new Set(wallets.filter((w) => typeof w === "string" && isAddress(w)))];
  const hits = new Map<string, SanctionsMatch[]>();
  const unavailable: ScreeningResult["unavailable"] = [];
  if (valid.length === 0) return { hits, unavailable };
  for (const provider of providers) {
    let found: Map<string, SanctionsMatch[]>;
    try {
      found = await provider.screen(valid, { sb, now });
    } catch (err) {
      const code: UnavailableCode = err instanceof SanctionsUnavailableError ? err.code : "PROVIDER_ERROR";
      if (screeningFailsClosed(network)) {
        console.error(`[sanctions] ${provider.name} unavailable (${code}): refusing`);
        throw new SiwsError(503, SCREENING_UNAVAILABLE);
      }
      if (now - lastWarning > 60_000) {
        lastWarning = now;
        console.warn(`[sanctions] ${provider.name} unavailable (${code}) on ${network}: not enforced off mainnet`);
      }
      unavailable.push({ provider: provider.name, code });
      continue;
    }
    for (const [wallet, matches] of found) hits.set(wallet, [...(hits.get(wallet) ?? []), ...matches]);
  }
  return { hits, unavailable };
}

export type HitContext = {
  route: string;
  role: ScreenedWallet["role"] | "passport-issue" | "onchain-signer";
  txSignature?: string | null;
  /** The transaction already landed (report-only screens): nothing was refused. */
  landed?: boolean;
};

/** Opens (or finds) the compliance alert of one hit. Never throws. */
export async function raiseSanctionsHit(
  sb: SupabaseClient,
  wallet: string,
  matches: readonly SanctionsMatch[],
  context: HitContext,
  network: Network = detectNetwork(),
): Promise<void> {
  try {
    await recordSanctionsHit(sb, wallet, matches, context, network);
  } catch (err) {
    console.error("[sanctions] the compliance alert was not raised:", err instanceof Error ? err.message : String(err));
  }
}

/**
 * Opens (or finds) the compliance alert of one hit; THROWS when it could not
 * be written (a queue that retries needs to know: the alarm worker's
 * on-chain screen).
 */
export async function recordSanctionsHit(
  sb: SupabaseClient,
  wallet: string,
  matches: readonly SanctionsMatch[],
  context: HitContext,
  network: Network = detectNetwork(),
): Promise<void> {
  const first = matches[0];
  const hitList = [...new Set(matches.map((m) => m.hitList))].join("; ").slice(0, 200) || "Sanctions list";
  const summary = `Sanctions screening hit (${hitList}) on ${context.route}: wallet ${wallet.slice(0, 4)}…${wallet.slice(-4)}. ` +
    (context.landed
      ? "The transaction already landed: review in /admin/compliance, blocklist, then claw back (runbook)."
      : "Refused; review in /admin/compliance and prepare the blocklist entry.");
  const { error } = await sb.rpc("raise_sanctions_hit", {
    p_network: network,
    p_wallet: wallet,
    p_source: first?.source ?? "sanctions",
    p_hit_list: hitList,
    p_summary: summary.slice(0, 500),
    p_tx_signature: context.txSignature ?? null,
    p_evidence: {
      screening: "wallet-address",
      route: context.route,
      role: context.role,
      tx_signature: context.txSignature ?? null,
      matches: matches.map((m) => ({
        provider: m.provider, list: m.hitList, currency: m.currency ?? null,
        entry_uid: m.entryUid ?? null, entry_name: m.entryName ?? null, programs: m.programs ?? [],
      })),
    },
  });
  if (error) throw new Error(`raise_sanctions_hit failed (${error.code ?? "no code"})`);
}

/**
 * Screens the wallets and raises the compliance alert of every hit (once per
 * wallet); returns the wallets that matched. THROWS SiwsError(503) on
 * mainnet when a provider cannot answer (screenWallets). The gate below
 * refuses on any hit; "Send to wallets" (/api/compliance/screen-recipients)
 * blocks only the rows that matched.
 */
export async function screenAndRaiseHits(sb: SupabaseClient, input: ScreeningInput): Promise<Set<string>> {
  const network = detectNetwork();
  const { hits } = await screenWallets(sb, input.wallets.map((w) => w.wallet), { network });
  const raised = new Set<string>();
  for (const { wallet, role } of input.wallets) {
    const matches = hits.get(wallet);
    if (!matches || raised.has(wallet)) continue;
    raised.add(wallet);
    await raiseSanctionsHit(sb, wallet, matches, { route: input.route, role, txSignature: input.txSignature }, network);
  }
  return raised;
}

/**
 * The route gate: refuses (403) when any screened wallet is on a sanctions
 * list, after raising its compliance alert; refuses (503) on mainnet when a
 * provider cannot answer. The signer's own hit says so; a counterparty's
 * gets the generic copy, which does not reveal their status.
 */
export async function requireSanctionsClear(sb: SupabaseClient, input: ScreeningInput): Promise<void> {
  const hits = await screenAndRaiseHits(sb, input);
  if (hits.size === 0) return;
  const selfHit = input.wallets.some((w) => w.role === "self" && hits.has(w.wallet));
  throw new SiwsError(403, selfHit ? SCREENING_SELF_HIT : SCREENING_COUNTERPARTY_HIT);
}

/**
 * Report-only screening of something that ALREADY happened (a buy that
 * landed on-chain): the alert of every hit is raised (with the
 * transaction), nothing is refused. `retryLater` is true when a provider
 * could not answer where the screen fails closed (mainnet): the caller must
 * screen again later (the alarm worker's job retries; the purchase record
 * leaves it to that job). `strict` makes a failed alert write throw
 * (recordSanctionsHit) instead of only logging it.
 */
export async function reportSanctionsHits(
  sb: SupabaseClient,
  input: { route: string; wallets: readonly { wallet: string; role: HitContext["role"] }[]; txSignature?: string | null },
  opts: { strict?: boolean } = {},
): Promise<{ hits: string[]; retryLater: boolean }> {
  const network = detectNetwork();
  let result: ScreeningResult;
  try {
    result = await screenWallets(sb, input.wallets.map((w) => w.wallet), { network });
  } catch (err) {
    if (err instanceof SiwsError && err.status === 503) return { hits: [], retryLater: true };
    throw err;
  }
  const raised = new Set<string>();
  for (const { wallet, role } of input.wallets) {
    const matches = result.hits.get(wallet);
    if (!matches || raised.has(wallet)) continue;
    raised.add(wallet);
    const context: HitContext = { route: input.route, role, txSignature: input.txSignature, landed: true };
    if (opts.strict) await recordSanctionsHit(sb, wallet, matches, context, network);
    else await raiseSanctionsHit(sb, wallet, matches, context, network);
  }
  return { hits: [...raised], retryLater: false };
}

/** Every provider's state, for /admin/compliance and the alarm check. */
export async function sanctionsStatus(sb: SupabaseClient, now: number = Date.now()): Promise<ProviderStatus[]> {
  return Promise.all(SANCTIONS_PROVIDERS.map((p) => p.status({ sb, now })));
}
