// The holder's portfolio export (/portfolio/history, "Export CSV"): one row
// per event and a per-share-class FIFO cost-basis summary, for the holder's
// own bookkeeping. Not tax advice: the file says so on its first line, and it
// flags every number it cannot know instead of guessing one. Pure and
// isomorphic (tests/portfolio-export.test.ts); the page brings the inputs:
//   records  POST /api/portfolio/export: the wallet's verified primary-sale
//            purchases (commitments), its OTC deals, its conversion requests
//            and the platform's daily USDC/EUR rates (signed, own rows only);
//   chain    lib/portfolio-chain.ts: every transaction that changed the
//            wallet's balance of a share-class mint, read from the chain,
//            and the current balances;
//   labels   asset and share-class names per mint (the network data).
//
// Events. The chain is the ledger of unit movements; the records give them a
// price and a meaning. A movement is, in this order: a purchase (its
// signature is a verified purchase of the mint), a conversion escrow deposit
// or return (the request's deposit_tx / outcome_tx, or the vault as the
// counter-account's owner), an OTC sale, purchase, escrow deposit or refund
// (the deal PDA owns the counter-account), else a transfer in or out with an
// unknown price. An escrow the records do not name (an on-chain OTC offer, a
// delivery vault: both modules are off on mainnet) therefore reads as a
// transfer, flagged as unknown, never as custody. Three kinds of record have
// no movement of their own and are
// added from the record: a conversion's burn (the units leave the escrow,
// not the wallet), and a verified purchase or a completed OTC deal the chain
// history did not show (dated by the record and flagged).
//
// FIFO per share-class mint: acquisitions (purchases, OTC purchases,
// transfers in) open lots; disposals (OTC sales, transfers out, conversion
// burns) consume the oldest lots first. A transfer in has an unknown cost
// and a transfer out unknown proceeds; a conversion burn is a disposal with
// zero proceeds (the registered stake replaces the units; its value is for
// the holder's adviser). Escrow deposits and returns are custody: the units
// stay the holder's and the lots do not move. Units in escrow are counted
// per escrow, and a burn or return releases at most what was seen going in
// (never a negative escrow). The summary reconciles the lots with the
// wallet's balance plus its units in escrow and flags any difference (a
// history that could not be read in full).
//
// Money: USDC amounts are integers of micro-USDC (6 decimals, bigint), never
// floats. A per-unit price is the total divided by the units, rounded half
// up to 6 decimals; a partly disposed lot gives up cost in proportion
// (rounded half up) and keeps the rest, so a lot's cost is always allocated
// in full. EUR is the USDC total times the platform's EUR-per-USDC rate of
// the event's UTC day, rounded half up to cents; with no rate for that day
// the EUR cells stay empty.
//
// CSV: RFC 4180 (CRLF, a cell quoted when it holds a comma, quote or line
// break), UTF-8 with a byte-order mark for spreadsheet apps. A text cell
// that starts with = + - @, a tab or a CR is prefixed with ' so no
// spreadsheet runs it as a formula; plain numbers ("-12.500000") are left
// as numbers.

import type { Network } from "@/lib/network";
import { KNOWN_MINT_LAYOUT, USDC } from "@/lib/payment-mints";

const ZERO = BigInt(0);
const TWO = BigInt(2);
const MICRO = BigInt(1_000_000);
/** micro-USDC × (EUR per USDC × 10^10) / 10^14 = EUR cents. */
const EUR_RATE_SCALE_DIGITS = 10;
const MICRO_RATE_TO_CENTS = BigInt(10) ** BigInt(14);

/** The days of daily rates the route returns: today and the 30 before (fx_rate_observations keeps 30 days). */
export const PORTFOLIO_EXPORT_FX_WINDOW_DAYS = 31;

// ── Inputs ─────────────────────────────────────────────────────────────────

/** A verified primary-sale purchase (commitments, evidence_verified). Amounts are digit strings. */
export type ExportPurchaseRecord = {
  id: string;
  created_at: string;
  sale: string;
  share_class_pda: string | null;
  mint: string | null;
  units: string;
  amount_atomic: string;
  payment_mint: string;
  payment_decimals: number;
  signature: string;
};

/** One OTC deal of the wallet, from its side; never the counterparty. `price` is the total in payment base units. */
export type ExportOtcRecord = {
  id: string;
  created_at: string;
  updated_at: string;
  share_class_pda: string;
  mint: string;
  asset_label: string;
  side: "seller" | "buyer";
  amount: string;
  price: string;
  payment_mint: string;
  status: string;
  deal_pda: string | null;
};

/** One conversion request of the wallet, without contact or note. */
export type ExportConversionRecord = {
  id: string;
  created_at: string;
  updated_at: string;
  share_class_pda: string;
  mint: string;
  asset_label: string;
  amount: string;
  status: string;
  vault_pda: string | null;
  deposit_tx: string | null;
  outcome_tx: string | null;
};

/** The platform's EUR rate of one UTC day for the network's USDC. */
export type ExportFxRate = { day: string; eur_per_token: string; source: "auto" | "manual" };

/** What POST /api/portfolio/export answers. */
export type PortfolioExportRecords = {
  network: Network;
  wallet: string;
  purchases: ExportPurchaseRecord[];
  otc: ExportOtcRecord[];
  conversions: ExportConversionRecord[];
  fx: { payment_mint: string | null; rates: ExportFxRate[]; available: boolean };
  /** True when a record list reached its row cap (the export says the records may be incomplete). */
  truncated: boolean;
};

const NETWORKS: readonly string[] = ["mainnet", "devnet", "testnet", "localnet"];
const isText = (value: unknown): value is string => typeof value === "string";
const isOptionalText = (value: unknown): value is string | null => value === null || typeof value === "string";
const isDigits = (value: unknown): value is string => typeof value === "string" && /^\d{1,30}$/.test(value);

function everyRow(value: unknown, valid: (row: Record<string, unknown>) => boolean): boolean {
  return Array.isArray(value) && value.every((row) => !!row && typeof row === "object" && valid(row as Record<string, unknown>));
}

/**
 * The route's answer narrowed to PortfolioExportRecords, or null. One row of
 * an unexpected shape fails the whole answer: an export that silently drops
 * a purchase would be wrong.
 */
export function parsePortfolioExportRecords(value: unknown): PortfolioExportRecords | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const fx = v.fx as Record<string, unknown> | null | undefined;
  const ok =
    isText(v.network) && NETWORKS.includes(v.network) && isText(v.wallet) && typeof v.truncated === "boolean" &&
    everyRow(v.purchases, (r) =>
      isText(r.id) && isText(r.created_at) && isText(r.sale) && isOptionalText(r.share_class_pda) && isOptionalText(r.mint) &&
      isDigits(r.units) && isDigits(r.amount_atomic) && isText(r.payment_mint) && Number.isInteger(r.payment_decimals) && isText(r.signature)) &&
    everyRow(v.otc, (r) =>
      isText(r.id) && isText(r.created_at) && isText(r.updated_at) && isText(r.share_class_pda) && isText(r.mint) &&
      isText(r.asset_label) && (r.side === "seller" || r.side === "buyer") && isDigits(r.amount) && isDigits(r.price) &&
      isText(r.payment_mint) && isText(r.status) && isOptionalText(r.deal_pda)) &&
    everyRow(v.conversions, (r) =>
      isText(r.id) && isText(r.created_at) && isText(r.updated_at) && isText(r.share_class_pda) && isText(r.mint) &&
      isText(r.asset_label) && isDigits(r.amount) && isText(r.status) && isOptionalText(r.vault_pda) &&
      isOptionalText(r.deposit_tx) && isOptionalText(r.outcome_tx)) &&
    !!fx && typeof fx === "object" && isOptionalText(fx.payment_mint) && typeof fx.available === "boolean" &&
    everyRow(fx.rates, (r) => isText(r.day) && isText(r.eur_per_token) && (r.source === "auto" || r.source === "manual"));
  return ok ? (value as PortfolioExportRecords) : null;
}

/** A change of the wallet's balance of one share-class mint in one transaction. */
export type ChainMovement = {
  signature: string;
  /** Unix seconds; null when the node did not say. */
  blockTime: number | null;
  mint: string;
  /** The wallet's balance change, in units (share-class mints have 0 decimals). Never zero. */
  delta: bigint;
  /** The owners of every token account of this mint in the transaction (an escrow's PDA among them). */
  owners: readonly string[];
};

export type ChainHistory = {
  movements: readonly ChainMovement[];
  /** The block time of every transaction read, movement or not (a record's signature among them). */
  blockTimes: ReadonlyMap<string, number>;
  /** The wallet's current balance per share-class mint; null when not read. */
  balances: ReadonlyMap<string, bigint> | null;
  /** False when the history was cut short or a read failed. */
  complete: boolean;
  /** Why it is incomplete, in plain words; null when complete. */
  problem: string | null;
};

export type ShareClassLabel = { asset: string; shareClass: string };

// ── Events ─────────────────────────────────────────────────────────────────

export type ExportEventType =
  | "purchase"
  | "otc_buy"
  | "otc_sell"
  | "transfer_in"
  | "transfer_out"
  | "conversion_burn"
  | "escrow_deposit_conversion"
  | "escrow_return_conversion"
  | "escrow_deposit_otc"
  | "escrow_refund_otc";

export type ExportEffect = "acquisition" | "disposal" | "custody";

export const EXPORT_EVENT_LABEL: Record<ExportEventType, string> = {
  purchase: "Purchase (primary sale)",
  otc_buy: "OTC purchase",
  otc_sell: "OTC sale",
  transfer_in: "Transfer in",
  transfer_out: "Transfer out",
  conversion_burn: "Conversion burn",
  escrow_deposit_conversion: "Escrow deposit (conversion)",
  escrow_return_conversion: "Escrow return (conversion)",
  escrow_deposit_otc: "Escrow deposit (OTC)",
  escrow_refund_otc: "Escrow refund (OTC)",
};

export const EXPORT_EVENT_EFFECT: Record<ExportEventType, ExportEffect> = {
  purchase: "acquisition",
  otc_buy: "acquisition",
  transfer_in: "acquisition",
  otc_sell: "disposal",
  transfer_out: "disposal",
  conversion_burn: "disposal",
  escrow_deposit_conversion: "custody",
  escrow_return_conversion: "custody",
  escrow_deposit_otc: "custody",
  escrow_refund_otc: "custody",
};

export type ExportEvent = {
  /** Unix seconds; null when unknown. */
  atSec: number | null;
  mint: string;
  type: ExportEventType;
  unitsIn: bigint;
  unitsOut: bigint;
  /** The total price in micro-USDC: the cost of an acquisition, the proceeds of a disposal (0 for a burn); null when unknown. */
  totalMicro: bigint | null;
  signature: string | null;
  source: "chain" | "record";
  notes: string[];
  /** Escrow legs and burns: the escrow ("conversion:<id>", "otc:<id>") the units go into or leave. */
  escrowRef: string | null;
  /** Disposals: the FIFO cost of the units given up; null when any of it is unknown. */
  fifoCostMicro: bigint | null;
  /** Disposals: proceeds minus FIFO cost; null when either is unknown. */
  resultMicro: bigint | null;
};

export type AssetSummary = {
  mint: string;
  asset: string;
  shareClass: string;
  unitsHeld: bigint;
  unitsKnownCost: bigint;
  /** The cost of the units held whose cost is known. */
  costBasisMicro: bigint;
  /** costBasisMicro / unitsKnownCost, rounded half up; null without such units. */
  averageCostMicro: bigint | null;
  unitsUnknownCost: bigint;
  unitsDisposed: bigint;
  /** Known proceeds; units disposed without a known price are counted in proceedsUnknownUnits. */
  proceedsMicro: bigint;
  proceedsUnknownUnits: bigint;
  disposedCostMicro: bigint;
  disposedCostUnknownUnits: bigint;
  /** Sum of the disposals' results; null when any disposal's result is unknown. */
  realizedMicro: bigint | null;
  walletBalance: bigint | null;
  escrowUnits: bigint;
  /** unitsHeld − (walletBalance + escrowUnits); null when the balance was not read. */
  difference: bigint | null;
  flags: string[];
};

export type PortfolioExport = {
  events: ExportEvent[];
  summary: AssetSummary[];
  /** File-level notes (an incomplete history, capped records, no EUR rates). */
  notes: string[];
};

// ── Helpers ────────────────────────────────────────────────────────────────

const DIGITS_RE = /^\d{1,30}$/;

function units(value: string | null | undefined): bigint | null {
  return typeof value === "string" && DIGITS_RE.test(value) ? BigInt(value) : null;
}

function short(value: string): string {
  return value.length > 10 ? `${value.slice(0, 4)}…${value.slice(-4)}` : value;
}

/** a / b rounded half up (a ≥ 0, b > 0). */
export function divRoundHalfUp(a: bigint, b: bigint): bigint {
  return (a * TWO + b) / (b * TWO);
}

/** a / b rounded half away from zero, for a signed a (b > 0). */
function divRoundSigned(a: bigint, b: bigint): bigint {
  return a < ZERO ? -divRoundHalfUp(-a, b) : divRoundHalfUp(a, b);
}

/** micro-USDC as "1234.500000" (always 6 decimals; negative with a leading -). */
export function formatMicroUsdc(micro: bigint): string {
  const negative = micro < ZERO;
  const abs = negative ? -micro : micro;
  const whole = abs / MICRO;
  const fraction = (abs % MICRO).toString().padStart(6, "0");
  return `${negative ? "-" : ""}${whole.toString()}.${fraction}`;
}

/** EUR cents as "12.34". */
export function formatEurCents(cents: bigint): string {
  const negative = cents < ZERO;
  const abs = negative ? -cents : cents;
  const hundred = BigInt(100);
  return `${negative ? "-" : ""}${(abs / hundred).toString()}.${(abs % hundred).toString().padStart(2, "0")}`;
}

/** "0.8612000000" → 8612000000n (EUR per token × 10^10); null for anything else. */
export function parseEurRate(value: string): bigint | null {
  const match = /^(\d{1,9})(?:\.(\d{1,18}))?$/.exec(value.trim());
  if (!match) return null;
  const fraction = (match[2] ?? "").slice(0, EUR_RATE_SCALE_DIGITS).padEnd(EUR_RATE_SCALE_DIGITS, "0");
  const scaled = BigInt(match[1] + fraction);
  return scaled > ZERO ? scaled : null;
}

/** The EUR equivalent in cents of a micro-USDC amount at a scaled rate, rounded half up. */
export function eurCentsOf(totalMicro: bigint, rateScaled: bigint): bigint {
  return divRoundSigned(totalMicro * rateScaled, MICRO_RATE_TO_CENTS);
}

/** The UTC day of unix seconds ("2026-10-10"). */
export function utcDay(atSec: number): string {
  return new Date(atSec * 1000).toISOString().slice(0, 10);
}

function utcStamp(atSec: number | null): string {
  return atSec === null ? "unknown" : new Date(atSec * 1000).toISOString().slice(0, 19).replace("T", " ");
}

function recordSec(iso: string): number | null {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/** micro-USDC of a payment in the network's USDC (6 decimals); null in any other token. */
function usdcMicro(network: Network, paymentMint: string, amount: string, decimals: number = KNOWN_MINT_LAYOUT.decimals): bigint | null {
  const usdc = USDC[network];
  const value = units(amount);
  if (!usdc || usdc.mint !== paymentMint || value === null || decimals !== KNOWN_MINT_LAYOUT.decimals) return null;
  return value;
}

// ── Classification ─────────────────────────────────────────────────────────

type Draft = Omit<ExportEvent, "fifoCostMicro" | "resultMicro">;

function draft(over: Partial<Draft> & Pick<Draft, "mint" | "type" | "source">): Draft {
  return { atSec: null, unitsIn: ZERO, unitsOut: ZERO, totalMicro: null, signature: null, notes: [], escrowRef: null, ...over };
}

const OTHER_TOKEN = (mint: string) => `Paid in another token (${short(mint)}): no USDC price.`;

/**
 * One row per event, before FIFO (see the header for the order of the
 * rules), and the purchases no share class could take: an unresolved sale
 * (mint null) that fit no movement of its transaction.
 */
export function classifyPortfolioEvents(
  records: PortfolioExportRecords,
  chain: ChainHistory | null,
): { drafts: Draft[]; unplaced: ExportPurchaseRecord[] } {
  const network = records.network;
  const out: Draft[] = [];
  const purchasesBySig = new Map<string, ExportPurchaseRecord[]>();
  for (const p of records.purchases) {
    const list = purchasesBySig.get(p.signature) ?? [];
    list.push(p);
    purchasesBySig.set(p.signature, list);
  }
  const conversionByDeposit = new Map(records.conversions.filter((c) => c.deposit_tx).map((c) => [c.deposit_tx!, c]));
  const conversionByReturn = new Map(
    records.conversions.filter((c) => c.status === "returned" && c.outcome_tx).map((c) => [c.outcome_tx!, c]),
  );
  const matchedPurchases = new Set<string>();
  const matchedOtc = new Set<string>();

  const purchaseDraft = (p: ExportPurchaseRecord, atSec: number | null, source: "chain" | "record", mint: string): Draft => {
    const total = usdcMicro(network, p.payment_mint, p.amount_atomic, p.payment_decimals);
    const notes: string[] = [];
    if (total === null) notes.push(OTHER_TOKEN(p.payment_mint));
    return draft({
      atSec, mint, type: "purchase", source, unitsIn: units(p.units) ?? ZERO,
      totalMicro: total, signature: p.signature, notes,
    });
  };

  const movements = [...(chain?.movements ?? [])].sort(compareMovements);
  for (const m of movements) {
    const base = { atSec: m.blockTime, mint: m.mint, signature: m.signature, source: "chain" as const };
    const amount = m.delta < ZERO ? -m.delta : m.delta;
    // Each purchase counts once: the ones of this mint first, then one whose
    // sale the mirror did not resolve (mint null), only into units nothing
    // else in the movement explains.
    const unmatched = (purchasesBySig.get(m.signature) ?? []).filter((p) => !matchedPurchases.has(p.id));
    const exact = unmatched.filter((p) => p.mint === m.mint);
    const exactUnits = exact.reduce((sum, p) => sum + (units(p.units) ?? ZERO), ZERO);
    const unresolved: ExportPurchaseRecord[] = [];
    let room = m.delta - exactUnits;
    for (const p of unmatched.filter((q) => q.mint === null)) {
      const n = units(p.units) ?? ZERO;
      if (n > ZERO && n <= room) {
        unresolved.push(p);
        room -= n;
      }
    }
    const purchases = [...exact, ...unresolved];
    if (purchases.length > 0 && m.delta > ZERO) {
      let remaining = m.delta;
      for (const p of purchases) {
        const row = purchaseDraft(p, m.blockTime, "chain", m.mint);
        remaining -= row.unitsIn;
        matchedPurchases.add(p.id);
        out.push(row);
      }
      if (remaining > ZERO) {
        out.push(draft({
          ...base, type: "transfer_in", unitsIn: remaining,
          notes: ["Received in a purchase transaction beyond the recorded purchase: cost unknown."],
        }));
      } else if (remaining < ZERO) {
        out[out.length - 1].notes.push("The purchase record names more units than this wallet received in the transaction.");
      }
      continue;
    }
    const conversion =
      (m.delta < ZERO ? conversionByDeposit.get(m.signature) : conversionByReturn.get(m.signature)) ??
      records.conversions.find((c) => c.vault_pda !== null && m.owners.includes(c.vault_pda));
    if (conversion && conversion.mint === m.mint) {
      const escrowRef = `conversion:${conversion.id}`;
      out.push(m.delta < ZERO
        ? draft({ ...base, type: "escrow_deposit_conversion", unitsOut: amount, escrowRef,
            notes: [`Into the escrow of conversion request ${conversion.id.slice(0, 8)}: still yours until burned or returned.`] })
        : draft({ ...base, type: "escrow_return_conversion", unitsIn: amount, escrowRef,
            notes: [`Back from the escrow of conversion request ${conversion.id.slice(0, 8)}.`] }));
      continue;
    }
    const deal = records.otc.find((o) => o.deal_pda !== null && o.mint === m.mint && m.owners.includes(o.deal_pda));
    if (deal) {
      const completed = deal.status === "completed" && !matchedOtc.has(deal.id);
      const total = usdcMicro(network, deal.payment_mint, deal.price);
      const priceNote = total === null ? [OTHER_TOKEN(deal.payment_mint)] : [];
      if (m.delta < ZERO && deal.side === "seller" && completed) {
        matchedOtc.add(deal.id);
        out.push(draft({ ...base, type: "otc_sell", unitsOut: amount, totalMicro: total, notes: [
          `OTC deal ${deal.id.slice(0, 8)}: the units left this wallet for the deal escrow on this date; the deal settled once both sides had paid in.`,
          ...priceNote,
        ] }));
      } else if (m.delta > ZERO && deal.side === "buyer" && completed) {
        matchedOtc.add(deal.id);
        out.push(draft({ ...base, type: "otc_buy", unitsIn: amount, totalMicro: total, notes: [`OTC deal ${deal.id.slice(0, 8)} settled.`, ...priceNote] }));
      } else if (m.delta < ZERO && deal.side === "seller") {
        out.push(draft({ ...base, type: "escrow_deposit_otc", unitsOut: amount, escrowRef: `otc:${deal.id}`,
          notes: [`Into the escrow of OTC deal ${deal.id.slice(0, 8)} (not completed): still yours until it settles or is refunded.`] }));
      } else if (m.delta > ZERO && deal.side === "seller") {
        out.push(draft({ ...base, type: "escrow_refund_otc", unitsIn: amount, escrowRef: `otc:${deal.id}`,
          notes: [`Refunded from the escrow of OTC deal ${deal.id.slice(0, 8)}.`] }));
      } else {
        out.push(transferDraft(base, m.delta));
      }
      continue;
    }
    out.push(transferDraft(base, m.delta));
  }

  const seen = chain !== null && chain.complete;
  const unplaced: ExportPurchaseRecord[] = [];
  for (const p of records.purchases) {
    if (matchedPurchases.has(p.id)) continue;
    // Without a mint (an unresolved sale) a record-only purchase has no share class to count in.
    if (!p.mint) {
      unplaced.push(p);
      continue;
    }
    const atSec = chain?.blockTimes.get(p.signature) ?? recordSec(p.created_at);
    const row = purchaseDraft(p, atSec, "record", p.mint);
    row.notes.push(seen
      ? "Recorded by Manci but not seen in this wallet's on-chain history; check the transaction."
      : "From Manci's records; this wallet's on-chain history could not be read in full.");
    out.push(row);
  }
  for (const deal of records.otc) {
    if (deal.status !== "completed" || matchedOtc.has(deal.id)) continue;
    const total = usdcMicro(network, deal.payment_mint, deal.price);
    const amount = units(deal.amount) ?? ZERO;
    out.push(draft({
      atSec: recordSec(deal.updated_at), mint: deal.mint, source: "record",
      type: deal.side === "seller" ? "otc_sell" : "otc_buy",
      unitsIn: deal.side === "buyer" ? amount : ZERO, unitsOut: deal.side === "seller" ? amount : ZERO, totalMicro: total,
      notes: [
        `OTC deal ${deal.id.slice(0, 8)} completed; date recorded by Manci, the settlement transaction was not identified.`,
        ...(total === null ? [OTHER_TOKEN(deal.payment_mint)] : []),
      ],
    }));
  }
  for (const c of records.conversions) {
    if (c.status !== "converted") continue;
    const atSec = (c.outcome_tx ? chain?.blockTimes.get(c.outcome_tx) : undefined) ?? recordSec(c.updated_at);
    out.push(draft({
      atSec, mint: c.mint, source: "record", type: "conversion_burn", unitsOut: units(c.amount) ?? ZERO,
      totalMicro: ZERO, signature: c.outcome_tx, escrowRef: `conversion:${c.id}`,
      notes: [
        `Burned when conversion request ${c.id.slice(0, 8)} was registered: no proceeds on-chain; the registered shares replace these units (record them separately). The result shown is zero proceeds minus the FIFO cost.`,
      ],
    }));
  }
  return { drafts: out.sort(compareDrafts), unplaced };
}

function transferDraft(base: { atSec: number | null; mint: string; signature: string; source: "chain" }, delta: bigint): Draft {
  return delta > ZERO
    ? draft({ ...base, type: "transfer_in", unitsIn: delta,
        notes: ["Received outside the platform's records (another wallet, a release or a claim): cost unknown, use your own records."] })
    : draft({ ...base, type: "transfer_out", unitsOut: -delta,
        notes: ["Sent outside the platform's records (to another wallet, possibly your own): proceeds unknown."] });
}

function compareMovements(a: ChainMovement, b: ChainMovement): number {
  return (a.blockTime ?? Number.MAX_SAFE_INTEGER) - (b.blockTime ?? Number.MAX_SAFE_INTEGER) || a.signature.localeCompare(b.signature);
}

/** Oldest first, unknown dates last; within one instant acquisitions before disposals (a lot exists before it is used). */
function compareDrafts(a: Draft, b: Draft): number {
  const rank = (d: Draft) => (EXPORT_EVENT_EFFECT[d.type] === "acquisition" ? 0 : EXPORT_EVENT_EFFECT[d.type] === "custody" ? 1 : 2);
  return (a.atSec ?? Number.MAX_SAFE_INTEGER) - (b.atSec ?? Number.MAX_SAFE_INTEGER) || rank(a) - rank(b) ||
    (a.signature ?? "").localeCompare(b.signature ?? "");
}

// ── FIFO ───────────────────────────────────────────────────────────────────

type Lot = { units: bigint; cost: bigint | null };
type Book = {
  lots: Lot[];
  unitsDisposed: bigint;
  proceeds: bigint;
  proceedsUnknownUnits: bigint;
  disposedCost: bigint;
  disposedCostUnknownUnits: bigint;
  realized: bigint;
  realizedUnknown: boolean;
  /** Units seen going into each escrow and not yet out of it; never below zero. */
  escrow: Map<string, bigint>;
  unmatchedUnits: bigint;
  burns: number;
  otherToken: boolean;
};

function newBook(): Book {
  return {
    lots: [], unitsDisposed: ZERO, proceeds: ZERO, proceedsUnknownUnits: ZERO, disposedCost: ZERO,
    disposedCostUnknownUnits: ZERO, realized: ZERO, realizedUnknown: false, escrow: new Map(), unmatchedUnits: ZERO,
    burns: 0, otherToken: false,
  };
}

/**
 * Moves units into (positive) or out of (negative) one escrow. A release
 * takes at most what was seen going in: a burn or a return whose deposit the
 * history did not show leaves the escrow at zero, and the summary's
 * reconciliation reports the missing deposit instead of a negative escrow.
 */
function moveEscrow(book: Book, ref: string | null, change: bigint): void {
  if (ref === null) return;
  const next = (book.escrow.get(ref) ?? ZERO) + change;
  book.escrow.set(ref, next > ZERO ? next : ZERO);
}

function escrowTotal(book: Book): bigint {
  let total = ZERO;
  for (const held of book.escrow.values()) total += held;
  return total;
}

/** Consumes `amount` units from the oldest lots: the known cost given up and the units whose cost is unknown. */
export function consumeFifo(lots: Lot[], amount: bigint): { cost: bigint; unknownUnits: bigint; unmatched: bigint } {
  let remaining = amount;
  let cost = ZERO;
  let unknownUnits = ZERO;
  while (remaining > ZERO && lots.length > 0) {
    const lot = lots[0];
    const take = lot.units < remaining ? lot.units : remaining;
    if (lot.cost === null) {
      unknownUnits += take;
    } else {
      // The whole lot gives up all its remaining cost: nothing is lost to rounding.
      const part = take === lot.units ? lot.cost : divRoundHalfUp(lot.cost * take, lot.units);
      cost += part;
      lot.cost -= part;
    }
    lot.units -= take;
    remaining -= take;
    if (lot.units === ZERO) lots.shift();
  }
  return { cost, unknownUnits: unknownUnits + remaining, unmatched: remaining };
}

/** Events with their FIFO columns and the per-mint summary (see the header). */
export function buildPortfolioExport(input: {
  records: PortfolioExportRecords;
  chain: ChainHistory | null;
  labels: ReadonlyMap<string, ShareClassLabel>;
}): PortfolioExport {
  const { records, chain } = input;
  const { drafts, unplaced } = classifyPortfolioEvents(records, chain);
  const books = new Map<string, Book>();
  const book = (mint: string) => {
    let b = books.get(mint);
    if (!b) books.set(mint, (b = newBook()));
    return b;
  };
  const events: ExportEvent[] = drafts.map((d) => {
    const b = book(d.mint);
    if (d.notes.some((n) => n.startsWith("Paid in another token"))) b.otherToken = true;
    const event: ExportEvent = { ...d, fifoCostMicro: null, resultMicro: null };
    const effect = EXPORT_EVENT_EFFECT[d.type];
    if (effect === "acquisition") {
      b.lots.push({ units: d.unitsIn, cost: d.totalMicro });
    } else if (effect === "custody") {
      moveEscrow(b, d.escrowRef, d.unitsOut - d.unitsIn);
    } else {
      const amount = d.unitsOut;
      if (d.type === "conversion_burn") {
        b.burns += 1;
        moveEscrow(b, d.escrowRef, -amount);
      }
      const used = consumeFifo(b.lots, amount);
      b.unitsDisposed += amount;
      b.disposedCost += used.cost;
      b.disposedCostUnknownUnits += used.unknownUnits;
      b.unmatchedUnits += used.unmatched;
      if (d.totalMicro === null) b.proceedsUnknownUnits += amount;
      else b.proceeds += d.totalMicro;
      event.fifoCostMicro = used.unknownUnits === ZERO ? used.cost : null;
      event.resultMicro = d.totalMicro !== null && event.fifoCostMicro !== null ? d.totalMicro - event.fifoCostMicro : null;
      if (event.resultMicro === null) b.realizedUnknown = true;
      else b.realized += event.resultMicro;
      if (used.unknownUnits > ZERO) {
        event.notes.push(used.unmatched > ZERO
          ? `Cost unknown for ${used.unknownUnits.toString()} of these units (${used.unmatched.toString()} more than the history shows as acquired).`
          : `Cost unknown for ${used.unknownUnits.toString()} of these units (received without a known price).`);
      }
    }
    return event;
  });

  const mints = new Set<string>([...books.keys(), ...(chain?.balances?.keys() ?? [])]);
  const labelOf = (mint: string): ShareClassLabel =>
    input.labels.get(mint) ??
    (() => {
      const named = records.conversions.find((c) => c.mint === mint)?.asset_label || records.otc.find((o) => o.mint === mint)?.asset_label;
      return { asset: named || mint, shareClass: "" };
    })();
  const summary: AssetSummary[] = [...mints].filter((mint) => mint !== "").map((mint) => {
    const b = book(mint);
    let unitsHeld = ZERO;
    let unitsKnownCost = ZERO;
    let costBasis = ZERO;
    for (const lot of b.lots) {
      unitsHeld += lot.units;
      if (lot.cost !== null) {
        unitsKnownCost += lot.units;
        costBasis += lot.cost;
      }
    }
    const walletBalance = chain?.balances ? chain.balances.get(mint) ?? ZERO : null;
    const escrowUnits = escrowTotal(b);
    const difference = walletBalance === null ? null : unitsHeld - (walletBalance + escrowUnits);
    const flags: string[] = [];
    if (unitsHeld - unitsKnownCost > ZERO) flags.push(`Cost unknown for ${(unitsHeld - unitsKnownCost).toString()} units held`);
    if (b.proceedsUnknownUnits > ZERO) flags.push(`Proceeds unknown for ${b.proceedsUnknownUnits.toString()} units disposed`);
    if (b.disposedCostUnknownUnits > ZERO) flags.push(`FIFO cost unknown for ${b.disposedCostUnknownUnits.toString()} units disposed`);
    if (b.burns > 0) flags.push("Includes units burned on conversion (zero proceeds)");
    if (b.otherToken) flags.push("Some prices are in another token than USDC");
    if (difference !== null && difference !== ZERO) {
      flags.push(`Records differ from the wallet balance plus escrow by ${difference.toString()} units: history incomplete`);
    }
    if (walletBalance === null) flags.push("Wallet balance not read");
    const label = labelOf(mint);
    return {
      mint, asset: label.asset, shareClass: label.shareClass,
      unitsHeld, unitsKnownCost, costBasisMicro: costBasis,
      averageCostMicro: unitsKnownCost > ZERO ? divRoundHalfUp(costBasis, unitsKnownCost) : null,
      unitsUnknownCost: unitsHeld - unitsKnownCost,
      unitsDisposed: b.unitsDisposed, proceedsMicro: b.proceeds, proceedsUnknownUnits: b.proceedsUnknownUnits,
      disposedCostMicro: b.disposedCost, disposedCostUnknownUnits: b.disposedCostUnknownUnits,
      realizedMicro: b.realizedUnknown ? null : b.realized,
      walletBalance, escrowUnits, difference, flags,
    };
  }).sort((a, b) => a.asset.localeCompare(b.asset) || a.shareClass.localeCompare(b.shareClass) || a.mint.localeCompare(b.mint));

  const notes: string[] = [];
  if (!chain) notes.push("The on-chain history of this wallet could not be read: transfers outside Manci are missing.");
  else if (!chain.complete) notes.push(`The on-chain history of this wallet is incomplete: ${chain.problem ?? "some transactions could not be read"}.`);
  if (records.truncated) notes.push("Some record lists reached their row limit: older records may be missing.");
  if (unplaced.length > 0) {
    notes.push(`${unplaced.length} recorded purchase(s) could not be matched to a share class: ${unplaced.map((p) => p.signature).join(" ")}.`);
  }
  if (!records.fx.available) notes.push("The platform's EUR rates could not be read: the EUR columns are empty.");
  return { events, summary, notes };
}

// ── CSV ────────────────────────────────────────────────────────────────────

const PLAIN_NUMBER_RE = /^-?\d+(\.\d+)?$/;
const FORMULA_START_RE = /^[=+\-@\t\r]/;

/** One CSV cell: formula characters neutralized (numbers excepted), quoted when needed. */
export function csvCell(value: string | number | bigint | null | undefined): string {
  let text = value === null || value === undefined ? "" : String(value);
  if (FORMULA_START_RE.test(text) && !PLAIN_NUMBER_RE.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvLine(cells: ReadonlyArray<string | number | bigint | null | undefined>): string {
  return cells.map(csvCell).join(",");
}

export const EVENT_COLUMNS = [
  "Date (UTC)", "Asset", "Share class", "Event", "Effect", "Units in", "Units out",
  "Price per unit (USDC)", "Total (USDC)", "EUR per USDC", "Total (EUR)",
  "FIFO cost of units disposed (USDC)", "Result (USDC)", "Transaction", "Note",
] as const;

export const SUMMARY_COLUMNS = [
  "Asset", "Share class", "Mint", "Units held", "Units with known cost", "Cost basis of those units (USDC)",
  "Average cost per unit (USDC)", "Units with unknown cost", "Units disposed", "Proceeds (USDC)",
  "FIFO cost of units disposed (USDC)", "Realized result (USDC)", "Wallet balance (on-chain)", "Units in escrow", "Flags",
] as const;

/** The first line of the file. */
export const EXPORT_DISCLAIMER =
  "Manci portfolio export: records for your own bookkeeping, not tax advice. Check every flagged row against your own records.";

const optionalMicro = (value: bigint | null) => (value === null ? "" : formatMicroUsdc(value));

/** The whole file (see the header), BOM first. */
export function portfolioExportCsv(
  data: PortfolioExport,
  meta: { wallet: string; network: Network; generatedAt: Date; fx: ReadonlyArray<ExportFxRate>; labels: ReadonlyMap<string, ShareClassLabel> },
): string {
  const rates = new Map<string, { scaled: bigint; text: string }>();
  for (const rate of meta.fx) {
    const scaled = parseEurRate(rate.eur_per_token);
    if (scaled !== null && /^\d{4}-\d{2}-\d{2}$/.test(rate.day)) rates.set(rate.day, { scaled, text: rate.eur_per_token });
  }
  const summaryLabel = new Map(data.summary.map((s) => [s.mint, { asset: s.asset, shareClass: s.shareClass }]));
  const label = (mint: string) => meta.labels.get(mint) ?? summaryLabel.get(mint) ?? { asset: mint, shareClass: "" };
  const lines: string[] = [
    csvLine([EXPORT_DISCLAIMER]),
    csvLine(["Wallet", meta.wallet]),
    csvLine(["Network", meta.network]),
    csvLine(["Generated (UTC)", meta.generatedAt.toISOString().slice(0, 19).replace("T", " ")]),
    csvLine(["Prices", "USDC amounts from Manci's records, 6 decimals. EUR uses Manci's USDC/EUR rate of the event's UTC day where one exists (rates are kept for 30 days); otherwise the EUR cells are empty."]),
    csvLine(["Cost basis", "FIFO per share class. Transfers in have an unknown cost and transfers out unknown proceeds; units burned on conversion are a disposal with zero proceeds; escrow deposits and returns are custody, not disposals."]),
    ...data.notes.map((note) => csvLine(["Note", note])),
    "",
    csvLine(["Events"]),
    csvLine([...EVENT_COLUMNS]),
  ];
  for (const e of data.events) {
    const { asset, shareClass } = label(e.mint);
    const unitCount = e.unitsIn > ZERO ? e.unitsIn : e.unitsOut;
    const price = e.totalMicro !== null && unitCount > ZERO ? formatMicroUsdc(divRoundHalfUp(e.totalMicro, unitCount)) : "";
    const rate = e.atSec !== null && e.totalMicro !== null ? rates.get(utcDay(e.atSec)) : undefined;
    const disposal = EXPORT_EVENT_EFFECT[e.type] === "disposal";
    lines.push(csvLine([
      utcStamp(e.atSec), asset, shareClass, EXPORT_EVENT_LABEL[e.type], EXPORT_EVENT_EFFECT[e.type],
      e.unitsIn > ZERO ? e.unitsIn : "", e.unitsOut > ZERO ? e.unitsOut : "",
      price, optionalMicro(e.totalMicro),
      rate ? rate.text : "", rate && e.totalMicro !== null ? formatEurCents(eurCentsOf(e.totalMicro, rate.scaled)) : "",
      disposal ? optionalMicro(e.fifoCostMicro) : "", disposal ? optionalMicro(e.resultMicro) : "",
      e.signature ?? "", e.notes.join(" "),
    ]));
  }
  lines.push("", csvLine(["Cost basis summary (FIFO)"]), csvLine([...SUMMARY_COLUMNS]));
  for (const s of data.summary) {
    lines.push(csvLine([
      s.asset, s.shareClass, s.mint, s.unitsHeld, s.unitsKnownCost, formatMicroUsdc(s.costBasisMicro),
      optionalMicro(s.averageCostMicro), s.unitsUnknownCost, s.unitsDisposed, formatMicroUsdc(s.proceedsMicro),
      formatMicroUsdc(s.disposedCostMicro), optionalMicro(s.realizedMicro),
      s.walletBalance === null ? "" : s.walletBalance, s.escrowUnits, s.flags.join("; "),
    ]));
  }
  return `﻿${lines.join("\r\n")}\r\n`;
}

/** "manci-portfolio-mainnet-DAWS-2026-11-08.csv" */
export function portfolioExportFileName(network: Network, wallet: string, generatedAt: Date): string {
  const tag = wallet.replace(/[^1-9A-HJ-NP-Za-km-z]/g, "").slice(0, 4) || "wallet";
  return `manci-portfolio-${network}-${tag}-${generatedAt.toISOString().slice(0, 10)}.csv`;
}
