// "Send to wallets" (Distribute → Send to wallets): the recipient list as the
// issuer types or pastes it — one "wallet amount" per line, or a CSV export.
//
// One box, no columns to map: a line is a wallet address and a whole number
// of tokens, in either order, separated by a comma, semicolon, tab or spaces
// (quotes around a cell are dropped). A header row ("wallet,amount") and
// blank or "#" lines are skipped. The same wallet twice is merged (amounts
// added) and said so, never sent twice. Each row's share of the company comes
// from the figures the tokenize flow recorded (`fields.tokenize`: tokens,
// token size and percent), never from the public `total_shares` column.
//
// Pure and node-safe (no React, no browser API): covered by
// tests/distribution-rows.test.ts.
import { isAddress, type Address } from "@solana/kit";
import { formatPercent, granularityById, HUNDRED_PERCENT_E4 } from "@/lib/tokenize-shares";

/** The most recipients one run takes (6 account reads and ≤ 25 transactions). */
export const MAX_DISTRIBUTION_ROWS = 200;
const U64_MAX = BigInt("18446744073709551615");

export type RecipientRow = {
  wallet: Address;
  /** Whole tokens (share-class mints have 0 decimals). */
  amount: bigint;
  /** The 1-based lines of the box this row came from (more than one when merged). */
  lines: number[];
};

export type ParseIssue = { line: number; text: string };

export type ParsedRecipients = {
  /** One row per wallet, in the order of first appearance. */
  rows: RecipientRow[];
  /** Lines that could not be read; nothing is sent while there are any. */
  errors: ParseIssue[];
  /** Wallets that appeared on more than one line (their amounts were added). */
  merged: RecipientRow[];
  /** A first line read as a header and skipped. */
  header: boolean;
  total: bigint;
};

const SEPARATORS = /[,;\t ]+/;
const QUOTED = /^["'“”‘’](.*)["'“”‘’]$/;

function cells(line: string): string[] {
  return line
    .split(SEPARATORS)
    .map((c) => c.trim().replace(QUOTED, "$1").trim())
    .filter((c) => c.length > 0);
}

/** "1000" → 1000n; anything but plain digits (no separators, no decimals) → null. */
function wholeTokens(cell: string): bigint | null {
  if (!/^\d+$/.test(cell)) return null;
  const n = BigInt(cell);
  return n > U64_MAX ? null : n;
}

/** A line with letters but no address and no amount: "wallet,amount", "Address;Tokens". */
function looksLikeHeader(parts: string[]): boolean {
  return parts.length > 0 && parts.every((p) => !isAddress(p) && wholeTokens(p) === null) && parts.some((p) => /[a-z]/i.test(p));
}

export function parseRecipients(text: string): ParsedRecipients {
  const errors: ParseIssue[] = [];
  const byWallet = new Map<string, RecipientRow>();
  let header = false;
  let seenContent = false;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const raw = lines[i].trim();
    if (!raw || raw.startsWith("#")) continue;
    const parts = cells(raw);
    if (!seenContent && looksLikeHeader(parts)) {
      seenContent = true;
      header = true;
      continue;
    }
    seenContent = true;
    if (parts.length !== 2) {
      errors.push({
        line: lineNo,
        text:
          parts.length < 2
            ? "Write the wallet address and the number of tokens on the same line."
            : "Use one wallet and one whole number per line (no thousands separators or extra columns).",
      });
      continue;
    }
    const [a, b] = parts;
    const wallet = isAddress(a) ? a : isAddress(b) ? b : null;
    const amountCell = wallet === a ? b : a;
    if (!wallet) {
      errors.push({ line: lineNo, text: "Not a valid Solana wallet address." });
      continue;
    }
    if (/^\d+[.,]\d+$/.test(amountCell)) {
      errors.push({ line: lineNo, text: "Share tokens are whole: use a whole number of tokens." });
      continue;
    }
    const amount = wholeTokens(amountCell);
    if (amount === null) {
      errors.push({ line: lineNo, text: "The amount must be a whole number of tokens (digits only)." });
      continue;
    }
    if (amount < BigInt(1)) {
      errors.push({ line: lineNo, text: "Send at least 1 token, or remove the line." });
      continue;
    }
    const existing = byWallet.get(wallet);
    if (existing) {
      existing.amount += amount;
      existing.lines.push(lineNo);
      if (existing.amount > U64_MAX) errors.push({ line: lineNo, text: "The merged amount is too large." });
    } else {
      byWallet.set(wallet, { wallet: wallet as Address, amount, lines: [lineNo] });
    }
  }
  const rows = [...byWallet.values()];
  if (rows.length > MAX_DISTRIBUTION_ROWS) {
    errors.push({
      line: 0,
      text: `At most ${MAX_DISTRIBUTION_ROWS} wallets per run; split the list (${rows.length} wallets now).`,
    });
  }
  return {
    rows,
    errors,
    merged: rows.filter((r) => r.lines.length > 1),
    header,
    total: rows.reduce((sum, r) => sum + r.amount, BigInt(0)),
  };
}

/** The list in one canonical text: sorted by wallet, "wallet,amount" per line (the run id hashes this). */
export function normalizedRows(rows: readonly Pick<RecipientRow, "wallet" | "amount">[]): string {
  return [...rows]
    .map((r) => `${r.wallet},${r.amount.toString()}`)
    .sort()
    .join("\n");
}

// ── Share of the company ────────────────────────────────────────────────────

/** The tokenize flow's figures (`fields.tokenize`), checked against each other. */
export type CompanyFigures = { tokens: bigint; percentE4: bigint; tokenE4: bigint };

/**
 * `fields.tokenize` → its figures, or null when absent or inconsistent:
 * `percent_e4` must equal `tokens` × the token size, so a hand-edited row
 * never puts a wrong percent next to a recipient.
 */
export function companyFiguresFrom(tokenize: unknown): CompanyFigures | null {
  if (!tokenize || typeof tokenize !== "object" || Array.isArray(tokenize)) return null;
  const t = tokenize as Record<string, unknown>;
  const size = granularityById(typeof t.granularity_percent === "string" ? t.granularity_percent : null);
  if (!size || typeof t.tokens !== "string" || typeof t.percent_e4 !== "string") return null;
  if (!/^\d+$/.test(t.tokens) || !/^\d+$/.test(t.percent_e4)) return null;
  const tokens = BigInt(t.tokens);
  const percentE4 = BigInt(t.percent_e4);
  if (tokens <= BigInt(0) || percentE4 <= BigInt(0) || percentE4 > HUNDRED_PERCENT_E4) return null;
  if (tokens * size.e4 !== percentE4) return null;
  return { tokens, percentE4, tokenE4: size.e4 };
}

/**
 * The share of the company `amount` tokens are ("0.1", "5"), exact (one token
 * is a fixed 0.01 / 0.001 / 0.0001 %), or null without the figures. More than
 * the whole company reads "> 100".
 */
export function percentOfCompany(amount: bigint, figures: CompanyFigures | null): string | null {
  if (!figures || amount < BigInt(0)) return null;
  const p4 = amount * figures.tokenE4;
  if (p4 > HUNDRED_PERCENT_E4) return "> 100";
  return formatPercent(p4);
}
