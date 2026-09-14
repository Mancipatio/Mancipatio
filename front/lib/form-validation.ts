// Tiny form-validation toolkit. Intentionally no external dependency —
// we don't need the full Zod surface here, and the rest of the codebase
// already shapes its own input types.
//
// A validator is just `(value) => string | null`. Compose them with
// `combine(...)` to run a sequence and return the first failure.

export type Validator<T = string> = (value: T) => string | null;

export function combine<T>(...validators: Validator<T>[]): Validator<T> {
  return (v) => {
    for (const fn of validators) {
      const err = fn(v);
      if (err) return err;
    }
    return null;
  };
}

export const required =
  (label = "This field"): Validator =>
  (v) => {
    if (typeof v !== "string") return null;
    return v.trim() ? null : `${label} is required`;
  };

export const minLength =
  (n: number, label = "Value"): Validator =>
  (v) => (v.trim().length >= n ? null : `${label} must be at least ${n} characters`);

export const maxLength =
  (n: number, label = "Value"): Validator =>
  (v) => (v.length <= n ? null : `${label} must be at most ${n} characters`);

// Base58 pubkey shape — same regex used elsewhere in the codebase.
export const base58Pubkey: Validator = (v) =>
  /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v.trim())
    ? null
    : "Not a valid base58 pubkey";

export const positiveNumber =
  (label = "Value"): Validator =>
  (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return `${label} must be a number`;
    return n > 0 ? null : `${label} must be greater than zero`;
  };

export const nonNegativeNumber =
  (label = "Value"): Validator =>
  (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return `${label} must be a number`;
    return n >= 0 ? null : `${label} cannot be negative`;
  };

export const positiveBigIntString =
  (label = "Value"): Validator =>
  (v) => {
    const s = v.replace(/[^0-9]/g, "");
    if (!s) return `${label} must be a positive integer`;
    try {
      return BigInt(s) > BigInt(0) ? null : `${label} must be greater than zero`;
    } catch {
      return `${label} is not a valid integer`;
    }
  };

export const hex64: Validator = (v) =>
  /^[0-9a-f]{64}$/.test(v.trim().toLowerCase())
    ? null
    : "Must be 64 hex characters";

export const slugCase: Validator = (v) =>
  /^[a-z0-9][a-z0-9-]*$/.test(v.trim())
    ? null
    : "Lowercase letters, digits and hyphens; must start with a letter or digit";

export const isoDate: Validator = (v) =>
  /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) && !Number.isNaN(Date.parse(v))
    ? null
    : "Must be a YYYY-MM-DD date";

/** Run a record of validators in parallel; returns { errors, isValid }. */
export function validateAll<T extends Record<string, unknown>>(
  values: T,
  rules: { [K in keyof T]?: Validator<string> },
): { errors: { [K in keyof T]?: string }; isValid: boolean } {
  const errors: { [K in keyof T]?: string } = {};
  for (const key of Object.keys(rules) as (keyof T)[]) {
    const fn = rules[key];
    if (!fn) continue;
    const v = values[key];
    if (typeof v !== "string") continue;
    const e = fn(v);
    if (e) errors[key] = e;
  }
  return { errors, isValid: Object.keys(errors).length === 0 };
}
