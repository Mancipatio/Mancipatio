// Regression tests for e2e §7 / F03 (amount units) and F06 (schedule time).
import { describe, expect, it } from "vitest";
import { U64_MAX } from "@/lib/vesting-terms";
import {
  describeAmount,
  fetchMintDecimals,
  formatAmountWithUnits,
  formatTokenAmount,
  formatUtc,
  groupDigits,
  localDateTimeToUnix,
  localZoneLabel,
  parseAmountInUnit,
  parseBaseUnits,
  parseLocalDateTime,
  parseTokenAmount,
  unixToLocalDateTime,
} from "@/lib/vesting-amounts";

describe("parseTokenAmount (F03)", () => {
  it("converts a decimal token amount to exact base units", () => {
    expect(parseTokenAmount("1.5", 6)).toEqual({
      ok: true,
      baseUnits: BigInt(1_500_000),
    });
    expect(parseTokenAmount("100", 6)).toEqual({
      ok: true,
      baseUnits: BigInt(100_000_000),
    });
    expect(parseTokenAmount(".5", 2)).toEqual({ ok: true, baseUnits: BigInt(50) });
    expect(parseTokenAmount("0.000001", 6)).toEqual({
      ok: true,
      baseUnits: BigInt(1),
    });
  });

  it("accepts trailing fractional zeros that do not exceed the mint precision", () => {
    // "1.50" is exactly 1.5 — refusing it with "cannot be represented" was
    // a false message; only value-carrying digits count towards precision.
    expect(parseTokenAmount("1.50", 1)).toEqual({
      ok: true,
      baseUnits: BigInt(15),
    });
    expect(parseTokenAmount("2.000", 0)).toEqual({
      ok: true,
      baseUnits: BigInt(2),
    });
    expect(parseTokenAmount("1.500000000", 6)).toEqual({
      ok: true,
      baseUnits: BigInt(1_500_000),
    });
    // A value-carrying digit beyond the precision is still refused.
    const r = parseTokenAmount("1.501", 2);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/cannot be represented exactly/);
    // "0.0" is zero, not a precision error.
    const z = parseTokenAmount("0.0", 0);
    expect(!z.ok && z.error).toMatch(/greater than zero/);
  });

  it('never strips the separator: "1.5" is not "15"', () => {
    const r = parseTokenAmount("1.5", 6);
    expect(r.ok && r.baseUnits).toBe(BigInt(1_500_000));
    expect(r.ok && r.baseUnits).not.toBe(BigInt(15));
  });

  it("refuses more fractional digits than the mint supports (no rounding)", () => {
    const r = parseTokenAmount("1.1234567", 6);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/6 decimals/);
    expect(!r.ok && r.error).toMatch(/cannot be represented exactly/);
    const zero = parseTokenAmount("1.5", 0);
    expect(zero.ok).toBe(false);
    expect(!zero.ok && zero.error).toMatch(/0 decimals/);
  });

  it("refuses ambiguous separators and malformed input", () => {
    for (const bad of ["1,5", "1,000", "1 000", "1e6", "abc", "-1", "1.", "", "  "]) {
      const r = parseTokenAmount(bad, 6);
      expect(r.ok, bad).toBe(false);
    }
    const comma = parseTokenAmount("1,5", 6);
    expect(!comma.ok && comma.error).toMatch(/decimal separator/);
  });

  it("refuses zero and values above u64::MAX", () => {
    expect(parseTokenAmount("0", 6).ok).toBe(false);
    expect(parseTokenAmount("0.0", 6).ok).toBe(false);
    const max = parseTokenAmount(U64_MAX.toString(), 0);
    expect(max).toEqual({ ok: true, baseUnits: U64_MAX });
    expect(parseTokenAmount((U64_MAX + BigInt(1)).toString(), 0).ok).toBe(false);
  });

  it("rejects unsupported decimals", () => {
    expect(parseTokenAmount("1", -1).ok).toBe(false);
    expect(parseTokenAmount("1", 19).ok).toBe(false);
    expect(parseTokenAmount("1", 1.5).ok).toBe(false);
  });
});

describe("parseBaseUnits / parseAmountInUnit", () => {
  it("accepts only digit strings in base mode", () => {
    expect(parseBaseUnits("100")).toEqual({ ok: true, baseUnits: BigInt(100) });
    expect(parseBaseUnits("1.5").ok).toBe(false);
    expect(parseBaseUnits("0").ok).toBe(false);
    expect(parseBaseUnits("").ok).toBe(false);
  });

  it("refuses token mode while decimals are unknown (never assumes 0)", () => {
    const r = parseAmountInUnit("100", "token", null);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/decimals are not known/);
    expect(parseAmountInUnit("100", "base", null)).toEqual({
      ok: true,
      baseUnits: BigInt(100),
    });
    expect(parseAmountInUnit("100", "token", 6)).toEqual({
      ok: true,
      baseUnits: BigInt(100_000_000),
    });
  });
});

describe("formatTokenAmount / describeAmount", () => {
  it("formats base units exactly and trims trailing zeros", () => {
    expect(formatTokenAmount(BigInt(1_500_000), 6)).toBe("1.5");
    expect(formatTokenAmount(BigInt(100), 6)).toBe("0.0001");
    expect(formatTokenAmount(BigInt(100_000_000), 6)).toBe("100");
    expect(formatTokenAmount(BigInt(0), 6)).toBe("0");
    expect(formatTokenAmount(BigInt(7), 0)).toBe("7");
    expect(formatTokenAmount(U64_MAX, 9)).toBe("18446744073.709551615");
  });

  it("round-trips through parseTokenAmount", () => {
    for (const [base, dec] of [
      [BigInt(1), 6],
      [BigInt(123_456_789), 6],
      [BigInt(5), 0],
      [U64_MAX, 9],
    ] as const) {
      const text = formatTokenAmount(base, dec);
      expect(parseTokenAmount(text, dec)).toEqual({ ok: true, baseUnits: base });
    }
  });

  it("names both units and the decimals in the description", () => {
    expect(describeAmount(BigInt(100), 6)).toBe(
      "0.0001 tokens = 100 base units (6 decimals)",
    );
    expect(describeAmount(BigInt(1_500_000), 6)).toBe(
      "1.5 tokens = 1 500 000 base units (6 decimals)",
    );
    expect(describeAmount(BigInt(100), null)).toBe(
      "100 base units (token decimals unknown)",
    );
    expect(groupDigits("1234567")).toBe("1 234 567");
    expect(groupDigits(BigInt(999))).toBe("999");
  });
});

describe("formatAmountWithUnits", () => {
  it("always names the unit and adds the token reading once decimals are known", () => {
    expect(formatAmountWithUnits(BigInt(100), null)).toBe("100 base units");
    expect(formatAmountWithUnits(BigInt(100), undefined)).toBe("100 base units");
    expect(formatAmountWithUnits(BigInt(100), 6)).toBe(
      "0.0001 tokens (100 base units)",
    );
    expect(formatAmountWithUnits(BigInt(1_500_000), 6)).toBe(
      "1.5 tokens (1 500 000 base units)",
    );
  });
});

describe("fetchMintDecimals", () => {
  const mint = "So11111111111111111111111111111111111111112" as never;
  /** 82-byte mint layout with `decimals` at byte 44 and isInitialized at 45. */
  function mintData(decimals: number): string {
    const b = new Uint8Array(82);
    b[44] = decimals;
    b[45] = 1;
    return btoa(String.fromCharCode(...b));
  }
  const rpcWith = (owner: string, data: string) =>
    ({
      getAccountInfo: () => ({
        send: async () => ({ value: { owner, data: [data, "base64"] } }),
      }),
    }) as never;

  it("reads decimals from a token-program-owned mint", async () => {
    await expect(
      fetchMintDecimals(
        rpcWith("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", mintData(6)),
        mint,
      ),
    ).resolves.toBe(6);
    await expect(
      fetchMintDecimals(
        rpcWith("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", mintData(9)),
        mint,
      ),
    ).resolves.toBe(9);
  });

  it("refuses a look-alike account that no token program owns", async () => {
    await expect(
      fetchMintDecimals(
        rpcWith("11111111111111111111111111111111", mintData(6)),
        mint,
      ),
    ).rejects.toThrow(/not owned by a token program/);
  });
});

describe("schedule time (F06)", () => {
  it("parses datetime-local in the browser zone and round-trips", () => {
    const expected = Math.floor(
      new Date(2030, 5, 15, 14, 30, 0, 0).getTime() / 1000,
    );
    expect(localDateTimeToUnix("2030-06-15T14:30")).toBe(expected);
    expect(unixToLocalDateTime(expected)).toBe("2030-06-15T14:30");
  });

  it("supports a time of day, not only midnight", () => {
    const midnight = localDateTimeToUnix("2030-06-15T00:00") as number;
    const later = localDateTimeToUnix("2030-06-15T00:05") as number;
    expect(later - midnight).toBe(300);
  });

  it("refuses empty, date-only, and impossible values instead of rolling over", () => {
    expect(localDateTimeToUnix("")).toBeNull();
    expect(localDateTimeToUnix("2030-06-15")).toBeNull();
    expect(localDateTimeToUnix("2030-02-30T10:00")).toBeNull();
    expect(localDateTimeToUnix("2030-13-01T10:00")).toBeNull();
    expect(localDateTimeToUnix("2030-06-15T24:00")).toBeNull();
  });

  it("explains a DST-gap wall time instead of a generic 'pick a date' message", () => {
    // Node honours a runtime TZ change; pin a zone with a spring-forward gap.
    const prev = process.env.TZ;
    process.env.TZ = "Europe/Belgrade";
    try {
      // 2030-03-31 02:30 never occurs in Europe/Belgrade (02:00 → 03:00).
      const gap = parseLocalDateTime("2030-03-31T02:30");
      expect(gap.ok).toBe(false);
      expect(!gap.ok && gap.error).toMatch(/02:30 does not exist/);
      expect(!gap.ok && gap.error).toMatch(/daylight saving/);
      expect(localDateTimeToUnix("2030-03-31T02:30")).toBeNull();
      // The overlap (fall-back) resolves deterministically to the first
      // occurrence, i.e. 00:30 UTC on 2030-10-27.
      expect(parseLocalDateTime("2030-10-27T02:30")).toEqual({
        ok: true,
        ts: 1_919_291_400,
      });
    } finally {
      if (prev === undefined) delete process.env.TZ;
      else process.env.TZ = prev;
    }
    // Reasons for the other refusals are specific, too.
    const feb30 = parseLocalDateTime("2030-02-30T10:00");
    expect(!feb30.ok && feb30.error).toMatch(/calendar date does not exist/);
    const empty = parseLocalDateTime("");
    expect(!empty.ok && empty.error).toBe("pick a date and time.");
    const bad = parseLocalDateTime("2030-06-15T24:00");
    expect(!bad.ok && bad.error).toMatch(/not valid/);
  });

  it("formats the canonical UTC reading and a labelled zone", () => {
    expect(formatUtc(1_900_000_000)).toBe("2030-03-17 17:46 UTC");
    expect(formatUtc(0)).toBe("—");
    expect(localZoneLabel(new Date(2030, 0, 1))).toMatch(
      /^.+ \(UTC[+-]\d{2}:\d{2}\)$/,
    );
  });
});
