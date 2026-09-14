// lib/format.ts — money formatting, URL safety guard, bytes32 codec.
import { describe, expect, it } from "vitest";
import { fmtMoney, fromBytes32, safeHttpUrl, toBytes32 } from "@/lib/format";

describe("fmtMoney", () => {
  it("passes small amounts through verbatim", () => {
    expect(fmtMoney(0)).toBe("$0");
    expect(fmtMoney(999)).toBe("$999");
  });

  it("rounds thousands to whole k", () => {
    expect(fmtMoney(1_000)).toBe("$1k");
    expect(fmtMoney(1_499)).toBe("$1k");
    expect(fmtMoney(1_500)).toBe("$2k");
    expect(fmtMoney(999_999)).toBe("$1000k");
  });

  it("formats millions with one decimal", () => {
    expect(fmtMoney(1_000_000)).toBe("$1.0M");
    expect(fmtMoney(2_500_000)).toBe("$2.5M");
    expect(fmtMoney(10_000_000)).toBe("$10.0M");
  });
});

describe("safeHttpUrl", () => {
  it("passes http(s) URLs through (trimmed, normalized)", () => {
    expect(safeHttpUrl("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(safeHttpUrl("  http://example.com  ")).toBe("http://example.com/");
  });

  it("rejects dangerous schemes from user-supplied input", () => {
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpUrl("JavaScript:alert(1)")).toBeNull(); // scheme is case-insensitive
    expect(safeHttpUrl("data:text/html,<script>")).toBeNull();
    expect(safeHttpUrl("file:///etc/passwd")).toBeNull();
  });

  it("rejects garbage, empty, null and undefined", () => {
    expect(safeHttpUrl("not a url")).toBeNull();
    expect(safeHttpUrl("")).toBeNull();
    expect(safeHttpUrl(null)).toBeNull();
    expect(safeHttpUrl(undefined)).toBeNull();
  });
});

describe("toBytes32 / fromBytes32", () => {
  it("round-trips a short identifier with zero padding", () => {
    const b = toBytes32("REAL-ESTATE-1");
    expect(b.length).toBe(32);
    expect(fromBytes32(b)).toBe("REAL-ESTATE-1");
    // Padding is zeroes after the content.
    expect(Array.from(b.slice(13)).every((x) => x === 0)).toBe(true);
  });

  it("truncates over-long input at 32 bytes", () => {
    const long = "x".repeat(40);
    const b = toBytes32(long);
    expect(b.length).toBe(32);
    expect(fromBytes32(b)).toBe("x".repeat(32));
  });

  it("round-trips an exactly-32-byte string (no zero terminator)", () => {
    const s = "y".repeat(32);
    expect(fromBytes32(toBytes32(s))).toBe(s);
  });

  it("decodes an empty identifier to an empty string", () => {
    expect(fromBytes32(new Uint8Array(32))).toBe("");
  });
});
