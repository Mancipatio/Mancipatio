// lib/certificates/canonical.ts: the one encoding of a certificate payload
// whose SHA-256 is signed and anchored. Key order never matters, the output
// has no whitespace, strings are NFC and unescaped beyond \" and \\, u64
// amounts are decimal strings, and anything that could encode two ways (a
// float, a non-NFC string, a control character, undefined) is refused rather
// than repaired. The fixture's bytes and hash were produced by Python's
// json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=False),
// the check ops/runbook-mainnet.md §25 gives authorities.
import { describe, expect, it } from "vitest";
import {
  CanonicalJsonError,
  canonicalDigest,
  canonicalJson,
  canonicalStringProblem,
  isCanonicalJson,
  sha256HexOfBytes,
  sha256HexOfText,
} from "@/lib/certificates/canonical";

// Python 3: json.dumps(PAYLOAD, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
const PYTHON_FIXTURE = {
  value: {
    b: "Rakić \"quoted\" back\\slash",
    a: [1, null, true, false, "ž"],
    c: { z: "1750", y: "\u{1F600}", x_1: 0 },
    d: "U+2028:\u2028 slash/ ok",
  },
  text: '{"a":[1,null,true,false,"ž"],"b":"Rakić \\"quoted\\" back\\\\slash","c":{"x_1":0,"y":"\u{1F600}","z":"1750"},"d":"U+2028:\u2028 slash/ ok"}',
  sha256: "1f54f6362a4084d45b3d4b3b0a6764ea7d31dbe00d1382424ff7790c3b9298ee",
};

describe("canonical JSON", () => {
  it("matches Python's sorted, compact, UTF-8 encoding byte for byte", async () => {
    expect(canonicalJson(PYTHON_FIXTURE.value)).toBe(PYTHON_FIXTURE.text);
    expect(await sha256HexOfText(canonicalJson(PYTHON_FIXTURE.value))).toBe(PYTHON_FIXTURE.sha256);
    const digest = await canonicalDigest(PYTHON_FIXTURE.value);
    expect(digest).toEqual({ canonical: PYTHON_FIXTURE.text, sha256: PYTHON_FIXTURE.sha256 });
  });

  it("does not depend on the order keys were written in, at any depth", () => {
    const a = { kind: "holding", asset: { name: "MANCI 17.5%", asset_id: "MANCI-2026" }, units: "250" };
    const b = { units: "250", asset: { asset_id: "MANCI-2026", name: "MANCI 17.5%" }, kind: "holding" };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"asset":{"asset_id":"MANCI-2026","name":"MANCI 17.5%"},"kind":"holding","units":"250"}');
  });

  it("keeps array order and sorts keys by code unit (digits and _ before letters)", () => {
    expect(canonicalJson({ b: [3, 1, 2], a_2: 1, a1: 2, a: 0 })).toBe('{"a":0,"a1":2,"a_2":1,"b":[3,1,2]}');
  });

  it("writes bigints (u64 amounts and slots) as decimal strings, beyond 2^53 too", () => {
    expect(canonicalJson({ units: BigInt(250), slot: BigInt("18446744073709551615") })).toBe(
      '{"slot":"18446744073709551615","units":"250"}',
    );
    // A bigint and the same decimal string encode identically.
    expect(canonicalJson({ units: BigInt(250) })).toBe(canonicalJson({ units: "250" }));
  });

  it("refuses numbers that are not safe integers", () => {
    for (const bad of [1.5, Number.NaN, Number.POSITIVE_INFINITY, -0, 2 ** 53, 1e21]) {
      expect(() => canonicalJson({ n: bad }), String(bad)).toThrow(CanonicalJsonError);
    }
    expect(canonicalJson({ n: -5, m: Number.MAX_SAFE_INTEGER })).toBe(`{"m":${Number.MAX_SAFE_INTEGER},"n":-5}`);
  });

  it("writes non-ASCII text as itself (no \\u escapes) and refuses text that could encode two ways", () => {
    expect(canonicalJson({ name: "Strahinjića Bana 73, Beograd" })).toBe('{"name":"Strahinjića Bana 73, Beograd"}');
    // "ć" as c + combining acute (NFD) is the same text to a reader, other bytes to a hash.
    expect(() => canonicalJson({ name: "Strahinjic\u0301a" })).toThrow(/normalization form C/);
    expect(canonicalStringProblem("Strahinjic\u0301a")).toMatch(/NFC/);
    expect(canonicalStringProblem("Strahinjića")).toBeNull();
  });

  it("refuses control characters and lone surrogates, keeps a valid surrogate pair", () => {
    for (const bad of ["line\nbreak", "tab\there", "nul\u0000", "del\u007f", "c1\u0085", "lone \ud800", "lone \udfff", "\udc00 first"]) {
      expect(() => canonicalJson({ s: bad }), JSON.stringify(bad)).toThrow(CanonicalJsonError);
    }
    expect(canonicalJson({ s: "😀" })).toBe('{"s":"\u{1F600}"}');
  });

  it("refuses undefined, functions, symbols, class instances, sparse arrays and non-snake_case keys", () => {
    const sparse: unknown[] = [1];
    sparse[2] = 3;
    const bads: unknown[] = [
      { a: undefined },
      [undefined],
      sparse,
      { f: () => 1 },
      { s: Symbol("x") },
      { d: new Date(0) },
      { m: new Map() },
      { ["Upper"]: 1 },
      { ["with space"]: 1 },
      { ["1digit"]: 1 },
      { ["dash-key"]: 1 },
      { [Symbol("hidden")]: 1, a: 1 },
      undefined,
    ];
    for (const bad of bads) expect(() => canonicalJson(bad)).toThrow(CanonicalJsonError);
  });

  it("names the path of the first offending value", () => {
    expect(() => canonicalJson({ holding: { units: 1.5 } })).toThrow(/^\$\.holding\.units: /);
    expect(() => canonicalJson({ list: [1, "a\nb"] })).toThrow(/^\$\.list\[1\]: /);
  });

  it("recognizes canonical text, and refuses whitespace, other orders, duplicates and unsafe numbers", () => {
    expect(isCanonicalJson(PYTHON_FIXTURE.text)).toBe(true);
    expect(isCanonicalJson('{"a":1,"b":2}')).toBe(true);
    expect(isCanonicalJson('{"b":2,"a":1}')).toBe(false);
    expect(isCanonicalJson('{"a": 1}')).toBe(false);
    expect(isCanonicalJson('{"a":1,"a":1}')).toBe(false);
    expect(isCanonicalJson('{"a":9007199254740993}')).toBe(false);
    expect(isCanonicalJson('{"a":"\\u0107"}')).toBe(false);
    expect(isCanonicalJson("not json")).toBe(false);
  });

  it("hashes with SHA-256 (FIPS 180-2 test vector) in lowercase hex", async () => {
    expect(await sha256HexOfText("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(await sha256HexOfBytes(new Uint8Array([0x61, 0x62, 0x63]))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
