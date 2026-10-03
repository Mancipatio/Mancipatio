// Distribute → "Public sale" (design §4): the issuer offers the tokens not
// created yet at one price, for 30, 90 or 365 days, buyers pay USDC on the
// existing sale page, and the proceeds go to the issuer's USDC account.
//
// As few inputs as possible: price per token (USDC, prefilled from the
// tokenize price), tokens offered (default: the room left) and the duration
// (30 by default). Everything else is fixed here:
//   price in base units      = price × 10^6 (USDC)
//   max_gross_raise          = tokens × price
//   approval                 = Mature, no cliff or vesting (0/0),
//                              min = max = price, valid 30 days, USDC only
//   end_ts at open           = now + duration (365 days kept clear of the
//                              program's cap by the chain-clock margin)
//
// The flow, by actor:
//   issuer   "Request public sale" (one signed call: the request and the
//            buyer document published, lib/server/sale-requests);
//   operator "Approve sale" (the approval modal prefilled from the request:
//            reserve → approve_sale → confirm), then the pre-clear check and
//            "Reopen primary issuance" (clears 0x02, super admin);
//   issuer   "Open sale" (open_sale now → the listing is published);
//   buyers   the sale page;
//   end      super admin clears 0x20 → issuer "End and collect" (close_sale
//            to the issuer's USDC account; an Admin issuer key sets 0x20 and,
//            unless another Open sale can still take a buy, 0x02 again in
//            the same transaction) → otherwise any Admin re-pauses.
//
// Pure and node-safe: tests/public-sale.test.ts.
import type { Address, ReadonlyUint8Array } from "@solana/kit";
import { CHAIN_CLOCK_MARGIN_SECONDS, MAX_SALE_DURATION_SECONDS } from "@/lib/deadline-bounds";
import { PAUSE_ISSUER_PROCEEDS, PAUSE_PRIMARY } from "@/lib/pause-flags";
import { freezeUnread, isLiveSale, liveSales, saleBuyState, type SaleBuyState, type SaleWithFreeze } from "@/lib/sale-liveness";
import { fromBaseUnits, toBaseUnits } from "@/lib/sale-approvals";
import { companyFiguresFrom } from "@/lib/distribution-rows";
import { parsePrice, perTokenPriceE6 } from "@/lib/tokenize-shares";

// ── Durations and the end of a sale ─────────────────────────────────────────

/** The durations an issuer chooses from (owner decision): 30 days by default. */
export const SALE_DURATION_DAYS = [30, 90, 365] as const;
export type SaleDurationDays = (typeof SALE_DURATION_DAYS)[number];
export const DEFAULT_SALE_DURATION_DAYS: SaleDurationDays = 30;
/** How long the operator's approval may wait to be opened (≤ 90 days on chain). */
export const PUBLIC_SALE_APPROVAL_DAYS = 30;
/** USDC has 6 decimals; the only payment token of a public sale. */
export const USDC_DECIMALS = 6;
const DAY_SECONDS = 86_400;
/** Below the chain-clock margin: the transaction lands a little after it is signed. */
const END_SLACK_SECONDS = 60;

export function isSaleDuration(value: unknown): value is SaleDurationDays {
  return typeof value === "number" && (SALE_DURATION_DAYS as readonly number[]).includes(value);
}

/**
 * `end_ts` of a sale opened at `nowSec` that runs `days`: now + days, but
 * never past what open_sale accepts (365 days after max(start, ITS now),
 * judged with the chain-clock margin — lib/deadline-bounds saleEndError).
 */
export function saleEndTs(days: SaleDurationDays, nowSec: number | bigint): bigint {
  const now = BigInt(nowSec);
  const wanted = now + BigInt(days * DAY_SECONDS);
  const latest = now + BigInt(MAX_SALE_DURATION_SECONDS - CHAIN_CLOCK_MARGIN_SECONDS - END_SLACK_SECONDS);
  return wanted < latest ? wanted : latest;
}

// ── Price and amounts ───────────────────────────────────────────────────────

/** "2.5", "$10", "0.000001" (USDC per token, ≤ 6 decimals) → base units; null when invalid or 0. */
export function usdcToBaseUnits(text: string): bigint | null {
  const t = text.trim().replace(/^\$\s*/, "");
  const units = toBaseUnits(t, USDC_DECIMALS);
  return units !== null && units > BigInt(0) ? units : null;
}

/** Base units → "1,234.5" (USDC, thousands separated, no trailing zeros). */
export function formatUsdc(baseUnits: bigint): string {
  const [whole, frac] = fromBaseUnits(baseUnits, USDC_DECIMALS).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return frac ? `${grouped}.${frac}` : grouped;
}

/** The payment's decimals when it is the network's USDC (6), else null (amounts stay in base units). */
export function usdcDecimalsOf(paymentMint: string, usdcMint: string | null | undefined): number | null {
  return usdcMint && paymentMint === usdcMint ? USDC_DECIMALS : null;
}

/** "2.5 USDC" for the network's USDC, else "2500000 base units" (another payment token). */
export function paymentAmountLabel(baseUnits: bigint, paymentMint: string, usdcMint: string | null | undefined): string {
  return usdcDecimalsOf(paymentMint, usdcMint) !== null ? `${formatUsdc(baseUnits)} USDC` : `${baseUnits.toString()} base units`;
}

/** `max_gross_raise` of a sale of `tokens` at `price` (base units). */
export function maxGrossRaise(tokens: bigint, priceBaseUnits: bigint): bigint {
  return tokens * priceBaseUnits;
}

/** The tokens an approval allows at its minimum price (max_gross / min price): what it may still mint. */
export function approvalUnits(a: { maxGrossRaise: bigint; minPricePerUnit: bigint }): bigint {
  return a.minPricePerUnit > BigInt(0) ? a.maxGrossRaise / a.minPricePerUnit : BigInt(0);
}

/**
 * What open_sale offers: the request's tokens, never more than the approval
 * allows at the price nor than the room left (the program does not check
 * the room: buys would fail late with MaxSupplyExceeded).
 */
export function tokensToOffer(input: { requested: bigint; approvalMaxUnits: bigint; room: bigint | null }): bigint {
  let n = input.requested;
  if (input.approvalMaxUnits < n) n = input.approvalMaxUnits;
  if (input.room !== null && input.room < n) n = input.room;
  return n > BigInt(0) ? n : BigInt(0);
}

/**
 * The tokenize flow's price per token (`fields.tokenize.price_total` over its
 * tokens), in millionths of a USD — USDC base units 1:1 — or null without a
 * price or consistent figures. The price input starts from it.
 */
export function tokenizePricePerTokenE6(tokenize: Record<string, unknown> | null): bigint | null {
  const figures = companyFiguresFrom(tokenize);
  const total = typeof tokenize?.price_total === "string" ? parsePrice(tokenize.price_total) : null;
  if (!figures || !total?.ok || total.value === null) return null;
  return perTokenPriceE6(total.value, figures.tokens);
}

/**
 * The treasury mint's value per token (USD e6) never below the class's sale
 * reference price: the ledger refuses a treasury mint valued under the
 * latest sale price, else the latest sale reservation's minimum price
 * (TREASURY_VALUE_BELOW_FLOOR, 0080). `reference` is that price in USDC base
 * units (6 decimals), when known.
 */
export function treasuryValueE6(base: bigint | null, reference: bigint | null): bigint | null {
  if (base === null) return reference;
  if (reference === null) return base;
  return reference > base ? reference : base;
}

/**
 * The class's sale reference price in USD e6 from its raise-cap reservations
 * (the newest "sale" row's minimum price, scaled from its payment decimals) —
 * what the ledger's treasury-mint floor falls back to; a public sale's
 * approval has min = max = its price. null without one.
 */
export function saleReferencePriceE6(
  rows: readonly { kind: string; created_at: string; min_price_per_unit: string | number | null; payment_decimals: number | null }[],
): bigint | null {
  const newest = rows
    .filter((r) => r.kind === "sale" && r.min_price_per_unit !== null && r.payment_decimals !== null)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
  if (!newest) return null;
  const text = String(newest.min_price_per_unit);
  if (!/^\d+$/.test(text)) return null;
  const units = BigInt(text);
  const decimals = newest.payment_decimals ?? USDC_DECIMALS;
  if (decimals === USDC_DECIMALS) return units;
  // Rounded up: a floor is never undershot.
  if (decimals < USDC_DECIMALS) return units * BigInt(10) ** BigInt(USDC_DECIMALS - decimals);
  const div = BigInt(10) ** BigInt(decimals - USDC_DECIMALS);
  return (units + div - BigInt(1)) / div;
}

/** sha256 hex of a file === the asset's on-chain legal_doc_hash (the document tokenize hashed). */
export function docMatchesLegalHash(sha256Hex: string, legalDocHash: ReadonlyUint8Array | Uint8Array | null | undefined): boolean {
  if (!legalDocHash || legalDocHash.length !== 32 || !/^[0-9a-f]{64}$/i.test(sha256Hex)) return false;
  const hex = Array.from(legalDocHash, (b) => b.toString(16).padStart(2, "0")).join("");
  return hex === sha256Hex.toLowerCase() && !/^0+$/.test(hex);
}

// ── The request (asset_profiles.fields.sale_request) ────────────────────────

export type SaleRequestStatus = "requested" | "withdrawn" | "declined" | "opened";
export const SALE_REQUEST_STATUSES: readonly SaleRequestStatus[] = ["requested", "withdrawn", "declined", "opened"];

export type SaleRequest = {
  v: 1;
  id: string;
  share_class: string;
  /** USDC base units per token. */
  price_per_unit: string;
  payment_mint: string;
  tokens: string;
  duration_days: SaleDurationDays;
  document: { path: string; sha256: string; version_id: string; matches_legal_doc: boolean };
  status: SaleRequestStatus;
  requested_by: string;
  requested_at: string;
  decided_by?: string | null;
  decided_at?: string | null;
  reason?: string | null;
  /** The Sale account once opened (status "opened"). */
  sale?: string | null;
};

const DIGITS = /^[1-9]\d{0,19}$/;

/** A stored request, or null when absent or malformed (never trusted half-read). */
export function parseSaleRequest(raw: unknown): SaleRequest | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const doc = r.document as Record<string, unknown> | null | undefined;
  if (
    r.v !== 1 ||
    typeof r.id !== "string" ||
    typeof r.share_class !== "string" ||
    typeof r.price_per_unit !== "string" ||
    !DIGITS.test(r.price_per_unit) ||
    typeof r.payment_mint !== "string" ||
    typeof r.tokens !== "string" ||
    !DIGITS.test(r.tokens) ||
    !isSaleDuration(r.duration_days) ||
    !doc ||
    typeof doc.path !== "string" ||
    typeof doc.sha256 !== "string" ||
    typeof doc.version_id !== "string" ||
    typeof doc.matches_legal_doc !== "boolean" ||
    typeof r.status !== "string" ||
    !(SALE_REQUEST_STATUSES as readonly string[]).includes(r.status) ||
    typeof r.requested_by !== "string" ||
    typeof r.requested_at !== "string"
  ) {
    return null;
  }
  return raw as SaleRequest;
}

/** The request's words in the approval (committed in its hash) and the audit log. */
export function publicSaleReason(request: Pick<SaleRequest, "id" | "tokens" | "price_per_unit" | "duration_days">): string {
  return `Public sale request ${request.id.slice(0, 8)}: ${BigInt(request.tokens).toLocaleString("en-US")} tokens at ${formatUsdc(BigInt(request.price_per_unit))} USDC each, ${request.duration_days} days (Mature, purchases final)`;
}

/** What the operator's "Approve sale" modal starts with: everything fixed, nothing to type. */
export type ApprovalPrefill = {
  shareClass: string;
  paymentMint: string;
  /** Decimal USDC (the modal's inputs). */
  maxGross: string;
  minPrice: string;
  maxPrice: string;
  raiseType: "mature";
  cliffMonths: 0;
  vestingMonths: 0;
  days: string;
  reason: string;
  requestId: string;
};

export function approvalPrefill(request: SaleRequest): ApprovalPrefill {
  const price = BigInt(request.price_per_unit);
  const gross = maxGrossRaise(BigInt(request.tokens), price);
  return {
    shareClass: request.share_class,
    paymentMint: request.payment_mint,
    maxGross: fromBaseUnits(gross, USDC_DECIMALS),
    minPrice: fromBaseUnits(price, USDC_DECIMALS),
    maxPrice: fromBaseUnits(price, USDC_DECIMALS),
    raiseType: "mature",
    cliffMonths: 0,
    vestingMonths: 0,
    days: String(PUBLIC_SALE_APPROVAL_DAYS),
    reason: publicSaleReason(request),
    requestId: request.id,
  };
}

// ── Where a class's public sale stands ──────────────────────────────────────

export type PublicSaleStage = "form" | "requested" | "approved" | "open";

/** An Open sale first, then a live approval waiting to be opened, then a request waiting for the operator. */
export function publicSaleStage(input: {
  request: Pick<SaleRequest, "status"> | null;
  liveApprovals: number;
  openSales: number;
}): PublicSaleStage {
  if (input.openSales > 0) return "open";
  if (input.liveApprovals > 0) return "approved";
  if (input.request?.status === "requested") return "requested";
  return "form";
}

// ── Before the operator clears 0x02 (Primary issuance is global) ────────────

type SaleRef = { address: Address | string; shareClass: Address | string };
type ApprovalRef = { address: Address | string; shareClass: Address | string; expiresAt: bigint };
/** An Open sale as the check reads it: its end and supply, and whether its issuer is frozen (null: not read). */
export type PreClearSale = SaleRef & SaleWithFreeze;

export type PreClearResult = {
  /** Open sales that can still take a buy: buys resume in them the moment 0x02 is clear. */
  otherOpenSales: SaleRef[];
  /** Open sales that cannot take a buy (ended, sold out, issuer frozen): listed, never blocking. */
  idleOpenSales: (SaleRef & { state: Exclude<SaleBuyState, "live"> })[];
  /** Live approvals other than this one: each could be opened while 0x02 is clear. */
  strayApprovals: ApprovalRef[];
  /** The approval this clear is for is still live (not expired, not opened). */
  thisApprovalLive: boolean;
  /** Nothing else would open or sell: the clear is safe. */
  clear: boolean;
  /** Why not, in words (empty when clear). */
  problems: string[];
};

/**
 * The pre-clear check (design §4): clearing 0x02 resumes buys in every Open
 * sale that can still take one and lets every live SaleApproval be opened,
 * so before the super admin clears it, such Open sales must be 0 and live
 * approvals 0 except the one this sale uses. An Open sale that ended, sold
 * out or whose issuer is frozen takes no buy (lib/sale-liveness) and does
 * not block — so freezing another issuer is a way through; lifting that
 * freeze while 0x02 is clear resumes its buys. A freeze that could not be
 * read counts as none (the "pre-clear" FreezePolicy): the check never passes
 * on an unknown. Expired approvals cannot be opened (open_sale refuses them)
 * and do not count. Run again right before signing.
 */
export function preClearCheck(input: {
  openSales: readonly PreClearSale[];
  approvals: readonly ApprovalRef[];
  thisApproval: Address | string | null;
  nowSec: number | bigint;
}): PreClearResult {
  const now = BigInt(input.nowSec);
  const live = input.approvals.filter((a) => a.expiresAt >= now);
  const otherOpenSales: SaleRef[] = [];
  const idleOpenSales: PreClearResult["idleOpenSales"] = [];
  for (const s of input.openSales) {
    if (isLiveSale(s, now, "pre-clear")) {
      otherOpenSales.push({ address: s.address, shareClass: s.shareClass });
      continue;
    }
    const state = saleBuyState(s, now, s.frozen);
    if (state !== "live") idleOpenSales.push({ address: s.address, shareClass: s.shareClass, state });
  }
  const strayApprovals = live.filter((a) => a.address !== input.thisApproval);
  const thisApprovalLive = input.thisApproval !== null && live.some((a) => a.address === input.thisApproval);
  const problems: string[] = [];
  if (!thisApprovalLive) problems.push("The approval of this sale is not live (expired, opened or revoked).");
  if (otherOpenSales.length > 0) {
    const one = otherOpenSales.length === 1;
    problems.push(
      `${otherOpenSales.length} other ${one ? "sale is" : "sales are"} Open and can still take buys: buys in ${one ? "it" : "them"} resume while Primary issuance is open. Freeze ${one ? "its issuer" : "their issuers"} (any Admin; only the super admin lifts a freeze) or wait until ${one ? "it ends or closes" : "they end or close"}.`,
    );
  }
  if (strayApprovals.length > 0) {
    problems.push(
      `${strayApprovals.length} other live sale ${strayApprovals.length === 1 ? "approval" : "approvals"} could be opened while Primary issuance is open: revoke ${strayApprovals.length === 1 ? "it" : "them"} first.`,
    );
  }
  return { otherOpenSales, idleOpenSales, strayApprovals, thisApprovalLive, clear: problems.length === 0, problems };
}

// ── Ending a sale ───────────────────────────────────────────────────────────
//
// Every rule below that sets 0x02 again counts the Open sales that can still
// take a buy with the "re-pause" FreezePolicy (lib/sale-liveness): a frozen
// issuer's sale takes none, and a freeze that could not be read never hides
// the offer (closing Primary issuance is always safe). Its callers pass every
// Open sale with its issuer's freeze (lib/open-sales-chain).

/**
 * The bits to set again once the sale closed: 0x20 (issuer proceeds) when
 * clear, and 0x02 (Primary issuance) when clear and no other sale can still
 * take a buy (`otherOpenSales`: how many Open sales are live). 0 when nothing
 * is left to set.
 */
export function repauseMask(flags: number, otherOpenSales: number): number {
  let mask = 0;
  if ((flags & PAUSE_ISSUER_PROCEEDS) === 0) mask |= PAUSE_ISSUER_PROCEEDS;
  if (otherOpenSales === 0 && (flags & PAUSE_PRIMARY) === 0) mask |= PAUSE_PRIMARY;
  return mask;
}

export type CloseStep =
  /** The sale is Open and 0x20 is set: the super admin clears 0x20 first. */
  | { step: "clear-proceeds" }
  /** The issuer runs close_sale; an Admin issuer key appends set_pause_flags(set `repause`). */
  | { step: "close"; repause: number }
  /** The sale closed; an Admin sets these bits again. */
  | { step: "repause"; repause: number }
  | { step: "done" };

/**
 * "End and collect", in order: 0x20 cleared (super admin) → close_sale
 * (issuer) → 0x20 and 0x02 set again (any Admin; the issuer's own close
 * transaction when its key is an Admin). `otherSales`: the Open sales other
 * than this one, of every issuer, with their issuers' freezes; 0x02 is set
 * again unless one of them can still take a buy.
 */
export function closeFlowStep(input: {
  flags: number;
  saleOpen: boolean;
  otherSales: readonly SaleWithFreeze[];
  nowSec: number | bigint;
}): CloseStep {
  const otherLive = liveSales(input.otherSales, input.nowSec, "re-pause").length;
  if (input.saleOpen) {
    if ((input.flags & PAUSE_ISSUER_PROCEEDS) !== 0) return { step: "clear-proceeds" };
    return { step: "close", repause: PAUSE_ISSUER_PROCEEDS | (otherLive === 0 ? PAUSE_PRIMARY : 0) };
  }
  const repause = repauseMask(input.flags, otherLive);
  return repause !== 0 ? { step: "repause", repause } : { step: "done" };
}

export type RepausePlan = {
  /** The bits any Admin may set again now (0: none). */
  mask: number;
  /** Said next to the button: what setting 0x02 again means for approvals waiting and for sales whose freeze is unread. */
  warning: string | null;
};

/** Said wherever 0x02 is offered to be set again although some issuers' freezes could not be read (null: none). */
export function freezeUnreadWarning(unread: number): string | null {
  if (unread === 0) return null;
  const one = unread === 1;
  return `The freeze of ${one ? "the issuer of 1 Open sale" : `the issuers of ${unread} Open sales`} could not be read: ${one ? "it" : "they"} may still take buys, and closing Primary issuance stops ${one ? "it" : "them"} until the super admin reopens it.`;
}

/**
 * What /admin/launchpad offers to set again (`sales`: every Open sale with
 * its issuer's freeze). 0x02 whenever no Open sale can still take a buy — the
 * safe default is closed, and a live approval waiting to be opened is no
 * reason to keep it open (the super admin reopens it after the pre-clear
 * check; a window left open from an earlier sale would let it be opened
 * unchecked). 0x20 only when no sale is Open at all: an Open sale that ended,
 * sold out or whose issuer is frozen still needs 0x20 clear to be closed.
 */
export function repausePlan(input: {
  flags: number;
  sales: readonly SaleWithFreeze[];
  nowSec: number | bigint;
  liveApprovals: number;
}): RepausePlan {
  if (liveSales(input.sales, input.nowSec, "re-pause").length > 0) return { mask: 0, warning: null };
  const all = repauseMask(input.flags, 0);
  const mask = input.sales.length > 0 ? all & PAUSE_PRIMARY : all;
  if ((mask & PAUSE_PRIMARY) === 0) return { mask, warning: null };
  const n = input.liveApprovals;
  const approvals =
    n > 0
      ? `${n} live ${n === 1 ? "approval waits" : "approvals wait"} to be opened: with Primary issuance closed, the super admin reopens it after the pre-clear check before ${n === 1 ? "it" : "any of them"} can be opened.`
      : null;
  const unread = freezeUnreadWarning(freezeUnread(input.sales, input.nowSec).length);
  const warning = [approvals, unread].filter((w): w is string => w !== null).join(" ");
  return { mask, warning: warning || null };
}

/**
 * Why setting 0x02 again right now is refused (null: it is not): an Open sale
 * that can still take a buy needs it until it ends or closes, or its issuer
 * is frozen. The guard of /admin/launchpad's re-pause and of the pre-clear
 * panel's "Close Primary issuance again", read again right before signing.
 */
export function primaryCloseRefusal(sales: readonly SaleWithFreeze[], nowSec: number | bigint): string | null {
  const live = liveSales(sales, nowSec, "re-pause").length;
  if (live === 0) return null;
  const one = live === 1;
  return `${live} Open ${one ? "sale" : "sales"} can still take buys and ${one ? "needs" : "need"} Primary issuance until ${one ? "it ends or closes" : "they end or close"} (or ${one ? "its issuer is" : "their issuers are"} frozen); pause from /admin/platform if this is an emergency.`;
}

/**
 * "Send to wallets": whether the treasury mint closes Primary issuance again
 * in its own transaction — yes unless an Open sale of any issuer can still
 * take a buy, or this class has an approved sale waiting to be opened
 * ("Both": the sale opens after the sends).
 */
export function mintRepausesPrimary(input: { sales: readonly SaleWithFreeze[]; nowSec: number | bigint; classLiveApprovals: number }): boolean {
  return liveSales(input.sales, input.nowSec, "re-pause").length === 0 && input.classLiveApprovals === 0;
}
