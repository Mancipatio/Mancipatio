// Vesting amount + schedule-time helpers (e2e §7 / F03, F06).
//
// The vesting program stores allocations and tranche amounts in the mint's
// BASE units (u64) and unlock times as unix seconds (UTC). The issuer form
// lets people type amounts in whole tokens, so the conversion must be exact
// and explicit: no float math, no silent rounding, no silent character
// stripping. Anything ambiguous is refused with a message that names the
// unit and the rule that was violated.

import {
  getMintDecoder,
  TOKEN_2022_PROGRAM_ADDRESS,
} from "@solana-program/token-2022";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import type { Address } from "@solana/kit";
import type { SolanaClient } from "@solana/client";
import { U64_MAX } from "@/lib/vesting-terms";

export type AmountUnit = "token" | "base";

export type ParsedAmount =
  | { ok: true; baseUnits: bigint }
  | { ok: false; error: string };

/** SPL mints allow 0–9 decimals; keep a hard ceiling for string padding. */
export const MAX_MINT_DECIMALS = 18;

function pluralDecimals(decimals: number): string {
  return `${decimals} decimal${decimals === 1 ? "" : "s"}`;
}

/**
 * Parses a human token amount ("1.5") into base units for a mint with
 * `decimals`. Strict on purpose:
 *  - only ASCII digits and at most one "." are accepted (a "," is refused with
 *    a hint, never treated as a decimal or thousands separator);
 *  - more fractional digits than the mint supports is an error — the program
 *    cannot represent the number, and rounding it would change the amount;
 *  - the amount must be > 0 and ≤ u64::MAX.
 */
export function parseTokenAmount(
  input: string,
  decimals: number,
): ParsedAmount {
  if (
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > MAX_MINT_DECIMALS
  ) {
    return { ok: false, error: `Unsupported mint decimals: ${decimals}.` };
  }
  const s = input.trim();
  if (!s) return { ok: false, error: "Enter an amount." };
  if (s.includes(","))
    return {
      ok: false,
      error: 'Use "." as the decimal separator and no thousands separators.',
    };
  const m = /^(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (!m[1] && !m[2]))
    return {
      ok: false,
      error: "Amount must be a plain decimal number, e.g. 1.5.",
    };
  const whole = m[1] || "0";
  if (s.endsWith("."))
    return { ok: false, error: 'Remove the trailing "." or add digits.' };
  // Trailing fractional zeros carry no value ("1.50" is exactly 1.5), so
  // they must not trip the precision check; every other over-precise input
  // is refused because rounding would change the amount.
  const frac = (m[2] ?? "").replace(/0+$/, "");
  if (frac.length > decimals)
    return {
      ok: false,
      error:
        decimals === 0
          ? "This mint has 0 decimals — enter a whole number."
          : `This mint supports ${pluralDecimals(decimals)} — "${s}" has ${frac.length} fractional digits and cannot be represented exactly.`,
    };
  const base = BigInt(whole + frac.padEnd(decimals, "0"));
  if (base <= BigInt(0))
    return { ok: false, error: "Amount must be greater than zero." };
  if (base > U64_MAX)
    return {
      ok: false,
      error: "Amount exceeds the token program limit (u64).",
    };
  return { ok: true, baseUnits: base };
}

/** Parses an amount typed directly in base units (integer string). */
export function parseBaseUnits(input: string): ParsedAmount {
  const s = input.trim();
  if (!s) return { ok: false, error: "Enter an amount." };
  if (!/^\d+$/.test(s))
    return {
      ok: false,
      error: "Base units must be a whole number of digits (no separators).",
    };
  const base = BigInt(s);
  if (base <= BigInt(0))
    return { ok: false, error: "Amount must be greater than zero." };
  if (base > U64_MAX)
    return {
      ok: false,
      error: "Amount exceeds the token program limit (u64).",
    };
  return { ok: true, baseUnits: base };
}

/** Parses in the selected unit; token mode needs known mint decimals. */
export function parseAmountInUnit(
  input: string,
  unit: AmountUnit,
  decimals: number | null,
): ParsedAmount {
  if (unit === "base") return parseBaseUnits(input);
  if (decimals === null)
    return {
      ok: false,
      error:
        "Token decimals are not known yet — wait for the mint to load, fix the mint address or switch to base units.",
    };
  return parseTokenAmount(input, decimals);
}

/**
 * Exact base-units → token string (no float). Trailing fractional zeros are
 * trimmed; a whole amount has no ".". formatTokenAmount(1500000n, 6) = "1.5".
 */
export function formatTokenAmount(baseUnits: bigint, decimals: number): string {
  if (
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > MAX_MINT_DECIMALS
  )
    throw new Error(`Unsupported mint decimals: ${decimals}`);
  if (baseUnits < BigInt(0)) throw new Error("Negative amount");
  if (decimals === 0) return baseUnits.toString();
  const padded = baseUnits.toString().padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals);
  const frac = padded.slice(-decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

/** Groups digits for display only ("1500000" → "1 500 000"); never for input. */
export function groupDigits(n: bigint | string): string {
  const s = n.toString();
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, "\u0020");
}

/**
 * Compact dual-unit reading for tables and cards: "1.5 tokens (1 500 000
 * base units)", or just "1 500 000 base units" while decimals are unknown.
 * Never prints a bare number — the unit is always spelled out (F03).
 */
export function formatAmountWithUnits(
  baseUnits: bigint,
  decimals: number | null | undefined,
): string {
  const raw = `${groupDigits(baseUnits)} base units`;
  if (decimals === null || decimals === undefined) return raw;
  return `${formatTokenAmount(baseUnits, decimals)} tokens (${raw})`;
}

/**
 * One-line, unit-explicit description shown next to inputs and in the
 * pre-submit confirmation: "1.5 tokens = 1 500 000 base units (6 decimals)".
 */
export function describeAmount(
  baseUnits: bigint,
  decimals: number | null,
): string {
  const base = `${groupDigits(baseUnits)} base units`;
  if (decimals === null) return `${base} (token decimals unknown)`;
  return `${formatTokenAmount(baseUnits, decimals)} tokens = ${base} (${pluralDecimals(decimals)})`;
}

// ── mint decimals ──────────────────────────────────────────────────────────

type Rpc = SolanaClient["runtime"]["rpc"];

/**
 * Reads `decimals` from a classic or Token-2022 mint (both share the 82-byte
 * base layout). Throws when the account is missing, is not owned by a token
 * program, or is not an initialized mint — callers must treat that as
 * "decimals unknown", never as 0.
 */
export async function fetchMintDecimals(
  rpc: Rpc,
  mint: Address,
): Promise<number> {
  const res = await rpc.getAccountInfo(mint, { encoding: "base64" }).send();
  if (!res.value) throw new Error("Mint account not found on this network.");
  const owner = res.value.owner.toString();
  if (
    owner !== TOKEN_PROGRAM_ADDRESS.toString() &&
    owner !== TOKEN_2022_PROGRAM_ADDRESS.toString()
  )
    throw new Error("Account is not owned by a token program.");
  const data = Uint8Array.from(
    atob((res.value.data as readonly [string, string])[0]),
    (c) => c.charCodeAt(0),
  );
  if (data.length < 82) throw new Error("Account is not a token mint.");
  const decoded = getMintDecoder().decode(data.subarray(0, 82));
  if (!decoded.isInitialized)
    throw new Error("Account is not an initialized token mint.");
  return decoded.decimals;
}

// ── schedule time (F06) ────────────────────────────────────────────────────

/** Two-digit zero pad. */
const p2 = (n: number) => String(n).padStart(2, "0");

export type ParsedLocalDateTime =
  | { ok: true; ts: number }
  | { ok: false; error: string };

/**
 * Parses a `<input type="datetime-local">` value ("YYYY-MM-DDTHH:MM") in the
 * browser's LOCAL zone into unix seconds (UTC) — what the program stores.
 * Seconds are always 0. Refuses (with a reason) empty/partial input,
 * impossible calendar dates that `Date` would roll over (Feb 30), and wall
 * times that do not exist in the browser zone (the DST spring-forward gap).
 * A wall time that occurs twice (DST fall-back) resolves to the first
 * occurrence, as `Date` does.
 */
export function parseLocalDateTime(value: string): ParsedLocalDateTime {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value.trim());
  if (!m) return { ok: false, error: "pick a date and time." };
  const [, y, mo, d, h, mi] = m.map(Number);
  if (mo < 1 || mo > 12 || h > 23 || mi > 59)
    return { ok: false, error: "that date or time is not valid." };
  const dt = new Date(y, mo - 1, d, h, mi, 0, 0);
  const ts = Math.floor(dt.getTime() / 1000);
  if (Number.isNaN(ts))
    return { ok: false, error: "that date or time is not valid." };
  // A day roll-over means the calendar date does not exist (e.g. Feb 30).
  if (
    dt.getFullYear() !== y ||
    dt.getMonth() !== mo - 1 ||
    dt.getDate() !== d
  )
    return { ok: false, error: "that calendar date does not exist." };
  // Same day but a different wall time: the requested time falls into a
  // daylight-saving gap of the browser zone and never occurs on the clock.
  if (dt.getHours() !== h || dt.getMinutes() !== mi)
    return {
      ok: false,
      error: `${p2(h)}:${p2(mi)} does not exist on that date in your zone (${localZoneLabel(dt)}) — clocks skip it for daylight saving. Pick another time.`,
    };
  return { ok: true, ts };
}

/** `parseLocalDateTime` without the reason; null for any refusal. */
export function localDateTimeToUnix(value: string): number | null {
  const r = parseLocalDateTime(value);
  return r.ok ? r.ts : null;
}

/** Inverse of localDateTimeToUnix for pre-filling the input on resubmit. */
export function unixToLocalDateTime(ts: number): string {
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/** "2026-09-10 14:05 UTC" — the canonical on-chain reading. */
export function formatUtc(ts: number | bigint): string {
  const n = Number(ts);
  if (!n) return "—";
  return `${new Date(n * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** Browser zone name (IANA) with a UTC offset, e.g. "Europe/Belgrade (UTC+02:00)". */
export function localZoneLabel(at: Date = new Date()): string {
  let zone = "local time";
  try {
    zone = Intl.DateTimeFormat().resolvedOptions().timeZone || zone;
  } catch {
    // keep fallback
  }
  const off = -at.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  return `${zone} (UTC${sign}${p2(Math.floor(abs / 60))}:${p2(abs % 60)})`;
}

/** "2026-09-10 16:05 local" in the browser zone (zone named separately). */
export function formatLocal(ts: number | bigint): string {
  const n = Number(ts);
  if (!n) return "—";
  return `${unixToLocalDateTime(n).replace("T", " ")} local`;
}

/** Both readings on one line for tables/cards. */
export function formatUtcAndLocal(ts: number | bigint): string {
  const n = Number(ts);
  if (!n) return "—";
  return `${formatUtc(n)} · ${formatLocal(n)}`;
}
