// lib/form-validation.ts — validator semantics, composition, edge inputs.
import { describe, expect, it } from "vitest";
import {
  base58Pubkey,
  combine,
  hex64,
  isoDate,
  maxLength,
  minLength,
  nonNegativeNumber,
  positiveBigIntString,
  positiveNumber,
  required,
  slugCase,
  validateAll,
} from "@/lib/form-validation";

describe("required / length", () => {
  it("rejects empty and whitespace-only strings with the label", () => {
    expect(required("Name")("")).toBe("Name is required");
    expect(required("Name")("   ")).toBe("Name is required");
    expect(required()("")).toBe("This field is required");
  });

  it("accepts non-empty strings", () => {
    expect(required("Name")("Alice")).toBeNull();
  });

  it("minLength trims before counting; maxLength does not", () => {
    expect(minLength(3)("  ab  ")).toContain("at least 3");
    expect(minLength(3)("abc")).toBeNull();
    expect(maxLength(3)("abcd")).toContain("at most 3");
    expect(maxLength(4)("abcd")).toBeNull();
  });
});

describe("base58Pubkey", () => {
  it("accepts real base58 addresses (32 and 43/44 chars)", () => {
    expect(base58Pubkey("11111111111111111111111111111111")).toBeNull();
    expect(base58Pubkey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb")).toBeNull();
    expect(base58Pubkey("  11111111111111111111111111111111  ")).toBeNull(); // trimmed
  });

  it("rejects forbidden alphabet chars (0, O, I, l) and bad lengths", () => {
    expect(base58Pubkey("0" + "1".repeat(31))).not.toBeNull();
    expect(base58Pubkey("O" + "1".repeat(31))).not.toBeNull();
    expect(base58Pubkey("1".repeat(31))).not.toBeNull(); // too short
    expect(base58Pubkey("1".repeat(45))).not.toBeNull(); // too long
    expect(base58Pubkey("")).not.toBeNull();
  });
});

describe("numeric validators", () => {
  it("positiveNumber requires a finite number > 0", () => {
    expect(positiveNumber("Amount")("5")).toBeNull();
    expect(positiveNumber("Amount")("0")).toBe("Amount must be greater than zero");
    expect(positiveNumber("Amount")("-1")).not.toBeNull();
    expect(positiveNumber("Amount")("abc")).toBe("Amount must be a number");
    expect(positiveNumber("Amount")("Infinity")).toBe("Amount must be a number");
  });

  it("nonNegativeNumber allows exactly zero", () => {
    expect(nonNegativeNumber()("0")).toBeNull();
    expect(nonNegativeNumber("Fee")("-0.01")).toBe("Fee cannot be negative");
  });

  it("positiveBigIntString handles values beyond Number precision", () => {
    // 2^64 — larger than Number.MAX_SAFE_INTEGER, must still validate.
    expect(positiveBigIntString()("18446744073709551616")).toBeNull();
    expect(positiveBigIntString()("0")).toContain("greater than zero");
    expect(positiveBigIntString()("")).toContain("positive integer");
    // Non-digits are stripped: "1,000" reads as 1000.
    expect(positiveBigIntString()("1,000")).toBeNull();
    expect(positiveBigIntString()("abc")).toContain("positive integer");
  });
});

describe("format validators", () => {
  it("hex64 accepts exactly 64 hex chars, case-insensitive, trimmed", () => {
    expect(hex64("a".repeat(64))).toBeNull();
    expect(hex64("A".repeat(64))).toBeNull();
    expect(hex64(" " + "0".repeat(64) + " ")).toBeNull();
    expect(hex64("g".repeat(64))).not.toBeNull();
    expect(hex64("a".repeat(63))).not.toBeNull();
  });

  it("slugCase enforces lowercase kebab shape", () => {
    expect(slugCase("my-asset-2")).toBeNull();
    expect(slugCase("2fast")).toBeNull();
    expect(slugCase("-leading")).not.toBeNull();
    expect(slugCase("Upper")).not.toBeNull();
    expect(slugCase("with space")).not.toBeNull();
  });

  it("isoDate requires YYYY-MM-DD that actually parses", () => {
    expect(isoDate("2026-07-20")).toBeNull();
    expect(isoDate("2026-13-01")).not.toBeNull(); // month 13
    expect(isoDate("20-07-2026")).not.toBeNull(); // wrong shape
    expect(isoDate("2026-07-20T00:00:00Z")).not.toBeNull(); // not a bare date
  });
});

describe("combine / validateAll", () => {
  it("combine returns the FIRST failure and null when all pass", () => {
    const v = combine(required("X"), minLength(3, "X"));
    expect(v("")).toBe("X is required");
    expect(v("ab")).toBe("X must be at least 3 characters");
    expect(v("abc")).toBeNull();
  });

  it("validateAll collects per-field errors and computes isValid", () => {
    const { errors, isValid } = validateAll(
      { name: "", wallet: "11111111111111111111111111111111" },
      { name: required("Name"), wallet: base58Pubkey },
    );
    expect(isValid).toBe(false);
    expect(errors.name).toBe("Name is required");
    expect(errors.wallet).toBeUndefined();
  });

  it("validateAll skips non-string values and passes clean input", () => {
    const res = validateAll(
      { name: "ok", count: 5 },
      { name: required("Name"), count: required("Count") },
    );
    expect(res.isValid).toBe(true);
    expect(res.errors).toEqual({});
  });
});
