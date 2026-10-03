// "Send to wallets" (Distribute → Send to wallets): the recipient list as the
// issuer types or pastes it — one "wallet amount" per line, or a CSV export.
//
// One box, no columns to map. Each line is split on its own delimiter (tab,
// semicolon, comma or spaces — the first that splits off a wallet address),
// quote-aware: a quoted cell keeps its commas ("1,000"). Extra columns are
// fine: the wallet is the line's valid address (a line with two different
// addresses is refused: which one is the recipient?) and the amount is the
// first number after it (or, in the "amount wallet" order, the number
// before it). A header row ("wallet,amount,name") is skipped; when it names
// the wallet and amount columns ("wallet"/"address"/"recipient",
// "amount"/"tokens"/"quantity"/"shares"), those columns are read. Amounts
// may carry thousands separators — "1,000" quoted or in a tab/semicolon
// line, "1 000" in a comma line, "1'000" — and read as 1000. An unquoted
// "wallet,1,000" is refused, never read as 1: whether "1" and "000" are one
// number or two columns cannot be told (quote it, drop the separator or add
// a header). Blank and "#" lines are skipped. The same wallet twice is
// merged (amounts added) and said so, never sent twice. Each row's share of
// the company comes from the figures the tokenize flow recorded
// (`fields.tokenize`: tokens, token size and percent), never from the public
// `total_shares` column.
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

// ── Cells ───────────────────────────────────────────────────────────────────

type Delimiter = "\t" | ";" | "," | "space";
type Cell = { text: string; quoted: boolean };

const DELIMITERS: readonly Delimiter[] = ["\t", ";", ",", "space"];
/** A cell that starts with one of these runs to the matching closing quote. */
const QUOTES: Record<string, string> = { '"': '"', "'": "'", "“": "”", "”": "”", "‘": "’" };

/**
 * One line split on `delimiter`, quote-aware: a cell that starts with a quote
 * runs to its closing quote ("" inside a double-quoted cell is one quote),
 * so a quoted "1,000" stays one cell. Spaces collapse; the other delimiters
 * keep their empty cells (a header's columns stay aligned).
 */
function splitLine(line: string, delimiter: Delimiter): Cell[] {
  const out: Cell[] = [];
  let text = "";
  let quoted = false;
  let closing: string | null = null;
  const push = () => {
    const t = text.trim();
    if (delimiter !== "space" || t.length > 0 || quoted) out.push({ text: t, quoted });
    text = "";
    quoted = false;
  };
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (closing !== null) {
      if (ch === closing) {
        if (ch === '"' && line[i + 1] === '"') {
          text += '"';
          i++;
          continue;
        }
        closing = null;
        continue;
      }
      text += ch;
      continue;
    }
    if (QUOTES[ch] && !quoted && text.trim() === "") {
      closing = QUOTES[ch];
      quoted = true;
      text = "";
      continue;
    }
    if (delimiter === "space" ? /\s/.test(ch) : ch === delimiter) {
      push();
      continue;
    }
    text += ch;
  }
  push();
  return out;
}

const filledCells = (cells: readonly Cell[]) => cells.filter((c) => c.text.length > 0);

/** The line's delimiter: the first that splits off a wallet address, else the first that splits it at all. */
function splitBest(line: string): { cells: Cell[]; delimiter: Delimiter } {
  let fallback: { cells: Cell[]; delimiter: Delimiter } | null = null;
  for (const delimiter of DELIMITERS) {
    const cells = splitLine(line, delimiter);
    const filled = filledCells(cells);
    if (filled.length < 2) continue;
    if (filled.some((c) => isAddress(c.text))) return { cells, delimiter };
    fallback ??= { cells, delimiter };
  }
  return fallback ?? { cells: splitLine(line, "space"), delimiter: "space" };
}

// ── Amounts ─────────────────────────────────────────────────────────────────

/** "1000" → 1000n; anything but plain digits (no separators, no decimals) → null. */
function wholeTokens(cell: string): bigint | null {
  if (!/^\d+$/.test(cell)) return null;
  const n = BigInt(cell);
  return n > U64_MAX ? null : n;
}

/** Looks like a number (an amount column), valid or not: "100", "1,000", "1.5", "-3". */
function numberLike(text: string): boolean {
  return /^[-+]?\d[\d.,'’   ]*$/.test(text);
}

/** Thousands separators dropped: "1,000", "1 000", "1'000", "1’000" → "1000"; anything else unchanged. */
function withoutThousands(text: string): string {
  return /^\d{1,3}([,'’   ]\d{3})+$/.test(text) ? text.replace(/[,'’   ]/g, "") : text;
}

function readAmount(text: string): { amount: bigint } | { error: string } {
  const t = withoutThousands(text.trim());
  if (/^\d+[.,]\d+$/.test(t)) return { error: "Share tokens are whole: use a whole number of tokens." };
  const amount = wholeTokens(t);
  if (amount === null) return { error: "The amount must be a whole number of tokens (digits only)." };
  if (amount < BigInt(1)) return { error: "Send at least 1 token, or remove the line." };
  return { amount };
}

/** An unquoted "wallet,1,000": one number with a separator, or two columns? */
export const AMBIGUOUS_AMOUNT =
  'Is this one number with a thousands separator, or two columns? Write it without the separator (1000), in quotes ("1,000"), or add a header row naming the columns.';

// ── Header ──────────────────────────────────────────────────────────────────

const WALLET_HEADER = /^(wallets?|address|wallet address|solana address|recipient|recipient wallet|recipient address|holder|owner|pubkey|public key|account)$/i;
const AMOUNT_HEADER = /^(amounts?|tokens|token amount|number of tokens|quantity|qty|shares|units|count)$/i;

type Columns = { wallet: number; amount: number; width: number; delimiter: Delimiter };

/** A line with letters but no address and no number: "wallet,amount", "Address;Tokens;Name". */
function looksLikeHeader(cells: readonly Cell[]): boolean {
  const filled = filledCells(cells);
  return (
    filled.length > 0 &&
    filled.every((c) => !isAddress(c.text) && !numberLike(c.text)) &&
    filled.some((c) => /[a-z]/i.test(c.text))
  );
}

/** The wallet and amount columns a header names, or null unless it names both. */
function headerColumns(cells: readonly Cell[], delimiter: Delimiter): Columns | null {
  const wallet = cells.findIndex((c) => WALLET_HEADER.test(c.text));
  const amount = cells.findIndex((c) => AMOUNT_HEADER.test(c.text));
  return wallet >= 0 && amount >= 0 && wallet !== amount ? { wallet, amount, width: cells.length, delimiter } : null;
}

// ── One line ────────────────────────────────────────────────────────────────

type LineResult = { wallet: Address; amount: bigint } | { error: string };

const ON_ONE_LINE = "Write the wallet address and the number of tokens on the same line.";

/** A line under a header that names its columns: those two cells (by position when the line is not split like the header). */
function readMapped(line: string, columns: Columns): LineResult {
  const cells = splitLine(line, columns.delimiter);
  if (filledCells(cells).length < 2) return readPositional(line);
  if (columns.delimiter === "," && cells.length > columns.width) {
    return { error: 'This line has more columns than the header row: put an amount with a thousands separator in quotes ("1,000").' };
  }
  const walletText = cells[columns.wallet]?.text ?? "";
  const amountText = cells[columns.amount]?.text ?? "";
  if (!walletText || !amountText) return { error: ON_ONE_LINE };
  if (!isAddress(walletText)) return { error: "Not a valid Solana wallet address." };
  const read = readAmount(amountText);
  return "error" in read ? read : { wallet: walletText as Address, amount: read.amount };
}

/** A line without a column header: its one wallet address and the number after (or before) it. */
function readPositional(line: string): LineResult {
  const { cells, delimiter } = splitBest(line);
  const filled = filledCells(cells);
  const at = filled.findIndex((c) => isAddress(c.text));
  if (at < 0) return { error: filled.length < 2 ? ON_ONE_LINE : "Not a valid Solana wallet address." };
  if (filled.some((c) => isAddress(c.text) && c.text !== filled[at].text)) {
    return { error: 'Two different wallet addresses on one line: keep only the recipient\'s column, or add a header row naming it "wallet".' };
  }
  // The first number after the wallet; else (the "amount wallet" order) the last one before it.
  let k = filled.findIndex((c, i) => i > at && numberLike(c.text));
  if (k < 0) {
    for (let i = at - 1; i >= 0 && k < 0; i--) if (numberLike(filled[i].text)) k = i;
  }
  if (k < 0) return { error: ON_ONE_LINE };
  const amount = filled[k];
  const next = filled[k + 1];
  // "wallet,1,000" or "wallet 1 000": never guessed.
  if (
    (delimiter === "," || delimiter === "space") &&
    !amount.quoted &&
    /^\d+$/.test(amount.text) &&
    next !== undefined &&
    !next.quoted &&
    /^\d+$/.test(next.text)
  ) {
    return { error: AMBIGUOUS_AMOUNT };
  }
  const read = readAmount(amount.text);
  return "error" in read ? read : { wallet: filled[at].text as Address, amount: read.amount };
}

export function parseRecipients(text: string): ParsedRecipients {
  const errors: ParseIssue[] = [];
  const byWallet = new Map<string, RecipientRow>();
  let header = false;
  let columns: Columns | null = null;
  let seenContent = false;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const raw = lines[i].trim();
    if (!raw || raw.startsWith("#")) continue;
    if (!seenContent) {
      // Only the first content line can be a header.
      seenContent = true;
      const { cells, delimiter } = splitBest(raw);
      if (looksLikeHeader(cells)) {
        header = true;
        columns = headerColumns(cells, delimiter);
        continue;
      }
    }
    const result = columns ? readMapped(raw, columns) : readPositional(raw);
    if ("error" in result) {
      errors.push({ line: lineNo, text: result.error });
      continue;
    }
    const { wallet, amount } = result;
    const existing = byWallet.get(wallet);
    if (existing) {
      existing.amount += amount;
      existing.lines.push(lineNo);
      if (existing.amount > U64_MAX) errors.push({ line: lineNo, text: "The merged amount is too large." });
    } else {
      byWallet.set(wallet, { wallet, amount, lines: [lineNo] });
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
