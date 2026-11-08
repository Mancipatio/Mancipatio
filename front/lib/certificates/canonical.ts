// Canonical JSON of a certificate payload (schema manci.certificate.v1).
//
// The SHA-256 a certificate carries is printed on it, signed by the admin's
// wallet and anchored on chain in a memo, and it is the hash of the bytes
// this module produces. So a payload must have exactly one encoding, and an
// authority must be able to reproduce it with its own tools. The rules:
//   * objects: keys sorted by UTF-16 code unit, no whitespace anywhere. Keys
//     are lowercase ASCII snake_case (a letter, then letters, digits or _),
//     so the order is the same in every language;
//   * strings: well-formed Unicode (no lone surrogate), in NFC, and without
//     control characters (U+0000-U+001F, U+007F-U+009F). The only escapes
//     left are \" and \\; every other character is written as itself, and
//     the whole text is encoded as UTF-8. A string that breaks a rule is
//     refused, never repaired: the payload builder normalizes its inputs
//     first, so a refusal here is a bug, not a user error;
//   * numbers: safe integers only (no fraction, exponent, NaN, Infinity or
//     -0). A bigint, i.e. a u64 amount or slot, is written as its decimal
//     string, as are all amounts in the payload;
//   * true, false and null; arrays keep their order;
//   * nothing else: undefined (also inside an array), functions, symbols,
//     Dates, Maps and class instances are refused rather than dropped.
//     (canonicalJson in lib/siws-client.ts drops undefined, which suits
//     signed request params and would hide a missing field here.)
// With these rules Python's
//   json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
// gives the same bytes (ops/runbook-mainnet.md §25 shows the whole check).
//
// Pure, directive-free and dependency-free: the server builds and hashes
// with it, the admin page and the public verification page re-check with it
// (tests/certificate-canonical.test.ts).

export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalJsonError";
  }
}

/** A key: a lowercase ASCII letter, then up to 63 lowercase letters, digits or underscores. */
export const CANONICAL_KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
/** C0 and C1 control characters and DEL. */
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;
/** A high surrogate not followed by a low one, or a low one not preceded by a high one. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?:^|[^\ud800-\udbff])[\udc00-\udfff]/;
const MAX_DEPTH = 16;

function fail(path: string, problem: string): never {
  throw new CanonicalJsonError(`${path}: ${problem}`);
}

/** Why `value` cannot be a canonical string, or null when it can. */
export function canonicalStringProblem(value: string): string | null {
  if (LONE_SURROGATE.test(value)) return "contains a lone surrogate (not valid Unicode)";
  if (CONTROL_CHARACTER.test(value)) return "contains a control character";
  if (value.normalize("NFC") !== value) return "is not in Unicode normalization form C (NFC)";
  return null;
}

function encodeString(value: string, path: string): string {
  const problem = canonicalStringProblem(value);
  if (problem) fail(path, `the string ${problem}`);
  // With no control character and no lone surrogate, JSON.stringify escapes
  // only the quote and the backslash.
  return JSON.stringify(value);
}

function encode(value: unknown, path: string, depth: number): string {
  if (depth > MAX_DEPTH) fail(path, "nested too deeply");
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return encodeString(value, path);
    case "bigint":
      return JSON.stringify(value.toString());
    case "number":
      if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
        fail(path, `the number ${String(value)} is not a safe integer (write amounts as decimal strings)`);
      }
      return String(value);
    case "object": {
      if (Array.isArray(value)) {
        const items: string[] = [];
        for (let i = 0; i < value.length; i++) items.push(encode(value[i], `${path}[${i}]`, depth + 1));
        return `[${items.join(",")}]`;
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) fail(path, "only plain objects are allowed");
      if (Object.getOwnPropertySymbols(value).length > 0) fail(path, "symbol keys are not allowed");
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      const members = keys.map((key) => {
        if (!CANONICAL_KEY_PATTERN.test(key)) fail(path, `the key ${JSON.stringify(key)} is not lowercase ASCII snake_case`);
        return `${JSON.stringify(key)}:${encode(record[key], `${path}.${key}`, depth + 1)}`;
      });
      return `{${members.join(",")}}`;
    }
    default:
      return fail(path, `${typeof value} is not a JSON value`);
  }
}

/** The canonical JSON text of `value`. Throws CanonicalJsonError naming the first offending path. */
export function canonicalJson(value: unknown): string {
  return encode(value, "$", 0);
}

/**
 * Whether `text` is already canonical: it parses, and encoding what it
 * parses to gives `text` back byte for byte (so no whitespace, no other key
 * order, no duplicate key, no number outside the safe range).
 */
export function isCanonicalJson(text: string): boolean {
  try {
    return canonicalJson(JSON.parse(text)) === text;
  } catch {
    return false;
  }
}

/** Lowercase hex of SHA-256 over the UTF-8 bytes of `text` (WebCrypto: browsers and Node alike). */
export async function sha256HexOfText(text: string): Promise<string> {
  return sha256HexOfBytes(new TextEncoder().encode(text));
}

/** Lowercase hex of SHA-256 over `bytes`. */
export async function sha256HexOfBytes(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice()));
  let out = "";
  for (const byte of digest) out += byte.toString(16).padStart(2, "0");
  return out;
}

/** The canonical text of `value` and its SHA-256. */
export async function canonicalDigest(value: unknown): Promise<{ canonical: string; sha256: string }> {
  const canonical = canonicalJson(value);
  return { canonical, sha256: await sha256HexOfText(canonical) };
}
