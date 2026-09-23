import { describe, expect, it } from "vitest";
import { DEFAULT_ADDRESS, protocolTreasuryError } from "@/lib/protocol-treasury";

const CURRENT = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const NEXT = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";

describe("protocol treasury rotation input", () => {
  it("accepts a new valid address and ignores an empty input", () => {
    expect(protocolTreasuryError(NEXT, CURRENT)).toBeNull();
    expect(protocolTreasuryError(`  ${NEXT} `, CURRENT)).toBeNull();
    expect(protocolTreasuryError("", CURRENT)).toBeNull();
    expect(protocolTreasuryError("   ", CURRENT)).toBeNull();
  });

  it("rejects what set_protocol_treasury would reject or ignore", () => {
    expect(protocolTreasuryError("not-an-address", CURRENT)).toMatch(/valid Solana address/);
    expect(protocolTreasuryError(DEFAULT_ADDRESS, CURRENT)).toMatch(/default 1111/);
    expect(DEFAULT_ADDRESS).toBe("11111111111111111111111111111111");
    expect(protocolTreasuryError(CURRENT, CURRENT)).toMatch(/already the treasury/);
    // Without a loaded Platform only the address rules apply.
    expect(protocolTreasuryError(CURRENT, undefined)).toBeNull();
  });
});
