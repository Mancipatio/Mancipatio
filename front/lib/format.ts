// Shared formatting helpers for the Manci UI.

export function fmtMoney(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1000)}k`;
  return `$${n}`;
}

/** Returns the URL only when it is a safe http(s) link, otherwise null.
 *  Guards against `javascript:`/`data:` schemes in user/applicant-supplied URLs. */
export function safeHttpUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw.trim());
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

/** Encodes a string into a fixed 32-byte identifier (UTF-8, zero-padded). */
export function toBytes32(s: string): Uint8Array {
  const out = new Uint8Array(32);
  out.set(new TextEncoder().encode(s).slice(0, 32));
  return out;
}

/** Decodes a fixed 32-byte identifier back to a string, dropping zero padding. */
export function fromBytes32(b: ArrayLike<number>): string {
  const arr = new Uint8Array(b);
  const end = arr.indexOf(0);
  return new TextDecoder().decode(end === -1 ? arr : arr.subarray(0, end));
}

export const KYB_LABEL = ["Pending", "Verified", "Rejected", "Suspended"];

export const ASSET_STATUS_LABEL = ["Draft", "Active", "Frozen", "Wound down"];

export const ASSET_TYPE_LABEL = [
  "Equity",
  "Revenue share",
  "Royalty",
  "Real estate",
  "Debt",
  "Commodity",
  "Physical good",
  "Other",
];
