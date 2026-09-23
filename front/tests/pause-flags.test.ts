import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  describePausedAreas,
  formatPauseFlags,
  isPaused,
  nextPauseFlags,
  PAUSE_CUSTODY_ENTRY,
  PAUSE_DISTRIBUTIONS,
  PAUSE_FLAGS,
  PAUSE_FLAGS_ALL,
  PAUSE_ISSUER_PROCEEDS,
  PAUSE_ONBOARDING,
  PAUSE_PRIMARY,
  PAUSE_SECONDARY,
  pauseAuditMetadata,
  pauseControls,
  pausedFlags,
  pauseMasks,
  pauseRole,
  pauseStatus,
  unknownPauseBits,
} from "@/lib/pause-flags";
import {
  explainSendError,
  NO_SALE_APPROVAL_HINT,
  PLATFORM_PAUSED_HINT,
  SALE_APPROVAL_OTHER_ID_HINT,
} from "@/lib/tx-error";
import { getPlatformDecoder, getPlatformEncoder } from "@/lib/generated/asset_registry";
import { address } from "@solana/kit";

// The IDL carries no constants: pin the TypeScript bits to the Rust source.
const RUST = readFileSync(
  join(process.cwd(), "../program/programs/asset_registry/src/constants.rs"),
  "utf8",
);
function rustBit(name: string): number {
  const match = new RegExp(`pub const ${name}: u8 = 1 << (\\d+);`).exec(RUST);
  if (!match) throw new Error(`${name} not found in constants.rs`);
  return 1 << Number(match[1]);
}

describe("emergency pause flags", () => {
  it("match PAUSE_* in program constants.rs", () => {
    expect(PAUSE_ONBOARDING).toBe(rustBit("PAUSE_ONBOARDING"));
    expect(PAUSE_PRIMARY).toBe(rustBit("PAUSE_PRIMARY"));
    expect(PAUSE_SECONDARY).toBe(rustBit("PAUSE_SECONDARY"));
    expect(PAUSE_CUSTODY_ENTRY).toBe(rustBit("PAUSE_CUSTODY_ENTRY"));
    expect(PAUSE_DISTRIBUTIONS).toBe(rustBit("PAUSE_DISTRIBUTIONS"));
    expect(PAUSE_ISSUER_PROCEEDS).toBe(rustBit("PAUSE_ISSUER_PROCEEDS"));
    expect(RUST).toMatch(/pub const PAUSE_FLAGS_ALL: u8 = PAUSE_ONBOARDING\s*\|\s*PAUSE_PRIMARY\s*\|\s*PAUSE_SECONDARY\s*\|\s*PAUSE_CUSTODY_ENTRY\s*\|\s*PAUSE_DISTRIBUTIONS\s*\|\s*PAUSE_ISSUER_PROCEEDS;/);
    expect(PAUSE_FLAGS_ALL).toBe(0x3f);
    expect(PAUSE_FLAGS.map((f) => f.bit)).toEqual([1, 2, 4, 8, 16, 32]);
    expect(PAUSE_FLAGS.reduce((all, f) => all | f.bit, 0)).toBe(PAUSE_FLAGS_ALL);
  });

  it("keeps the legacy byte meaning (1 = onboarding only)", () => {
    expect(pausedFlags(1).map((f) => f.bit)).toEqual([PAUSE_ONBOARDING]);
    expect(pausedFlags(0)).toEqual([]);
    expect(describePausedAreas(0)).toBe("");
    expect(describePausedAreas(0x06)).toBe(
      "Primary issuance, Trading through Manci",
    );
    expect(isPaused(0x3f, PAUSE_ISSUER_PROCEEDS)).toBe(true);
  });

  it("treats undefined bits as gating nothing", () => {
    expect(unknownPauseBits(0xc4)).toBe(0xc0);
    expect(unknownPauseBits(0x3f)).toBe(0);
    expect(pausedFlags(0xc0)).toEqual([]);
    expect(formatPauseFlags(0x0c)).toBe("0x0c");
  });

  it("builds masks that combine instead of overwriting", () => {
    // Admin pauses secondary, another pauses custody entry: nothing is wiped.
    const a = pauseMasks("pause", PAUSE_SECONDARY);
    const b = pauseMasks("pause", PAUSE_CUSTODY_ENTRY);
    expect(a).toEqual({ setMask: 0x04, clearMask: 0 });
    const afterA = nextPauseFlags(0, a.setMask, a.clearMask);
    expect(nextPauseFlags(afterA, b.setMask, b.clearMask)).toBe(0x0c);
    // Resume (super admin only) clears exactly the requested bits.
    const r = pauseMasks("resume", PAUSE_SECONDARY);
    expect(r).toEqual({ setMask: 0, clearMask: 0x04 });
    expect(nextPauseFlags(0x0c, r.setMask, r.clearMask)).toBe(0x08);
    // Pause never sets undefined bits; resume may clear them.
    expect(pauseMasks("pause", 0xff).setMask).toBe(0x3f);
    expect(pauseMasks("resume", 0xcc).clearMask).toBe(0xcc);
  });

  it("decodes byte 74 of the 85-byte Platform account as a u8", () => {
    const key = address("11111111111111111111111111111111");
    const bytes = new Uint8Array(
      getPlatformEncoder().encode({
        admin: key,
        protocolTreasury: key,
        protocolFeeBps: 0,
        pauseFlags: 0x3f,
        issuersCount: BigInt(1),
        version: 1,
        bump: 255,
      }),
    );
    expect(bytes).toHaveLength(85);
    expect(bytes[74]).toBe(0x3f);
    expect(getPlatformDecoder().decode(bytes).pauseFlags).toBe(0x3f);
  });
});

describe("pause panel and status rules", () => {
  const SUPER = "Super1111111111111111111111111111111111111";
  const ADMIN = "Admin1111111111111111111111111111111111111";

  it("shows one status everywhere, including undefined-only bytes", () => {
    expect(pauseStatus(0)).toEqual({ tone: "active", label: "Active" });
    expect(pauseStatus(0x3f)).toEqual({ tone: "paused", label: "Fully paused" });
    expect(pauseStatus(0xff).label).toBe("Fully paused");
    expect(pauseStatus(0x0c)).toEqual({ tone: "paused", label: "2 of 6 paused" });
    expect(pauseStatus(0xc4).tone).toBe("paused");
    // Only undefined bits: neither "Active" nor "paused".
    expect(pauseStatus(0xc0)).toEqual({
      tone: "undefined",
      label: "Undefined bits 0xc0",
    });
  });

  it("derives Super Admin from Platform.admin and Admin from the record", () => {
    expect(pauseRole(SUPER, SUPER, false)).toEqual({ isAdmin: true, isSuperAdmin: true });
    expect(pauseRole(ADMIN, SUPER, true)).toEqual({ isAdmin: true, isSuperAdmin: false });
    expect(pauseRole(ADMIN, SUPER, false)).toEqual({ isAdmin: false, isSuperAdmin: false });
    expect(pauseRole(undefined, SUPER, true)).toEqual({ isAdmin: false, isSuperAdmin: false });
  });

  it("lets an Admin only pause and the Super Admin also resume", () => {
    const admin = { isAdmin: true, isSuperAdmin: false };
    const superAdmin = { isAdmin: true, isSuperAdmin: true };
    const viewer = { isAdmin: false, isSuperAdmin: false };

    const a = pauseControls(0x04, admin);
    expect(a.pauseEverything).toBe(true);
    expect(a.resumeEverything).toBe(false);
    expect(a.rows.map((r) => r.action)).toEqual([
      "pause", "pause", null, "pause", "pause", "pause",
    ]);

    const s = pauseControls(0x04, superAdmin);
    expect(s.resumeEverything).toBe(true);
    expect(s.rows.map((r) => r.action)).toEqual([
      "pause", "pause", "resume", "pause", "pause", "pause",
    ]);

    const v = pauseControls(0x04, viewer);
    expect(v.pauseEverything || v.resumeEverything).toBe(false);
    expect(v.rows.every((r) => r.action === null)).toBe(true);

    // Fully paused: nothing left to pause; only the Super Admin sees resume.
    expect(pauseControls(0x3f, admin).pauseEverything).toBe(false);
    expect(pauseControls(0x3f, admin).rows.every((r) => r.action === null)).toBe(true);
    // Undefined-only byte: nothing is paused, resume-everything normalizes it.
    expect(pauseControls(0xc0, superAdmin).resumeEverything).toBe(true);
    expect(pauseControls(0, superAdmin).resumeEverything).toBe(false);
  });

  it("sends set-only for a pause and clear-only for a resume", () => {
    expect(pauseMasks("pause", 0x3f)).toEqual({ setMask: 0x3f, clearMask: 0 });
    // Resume everything clears the whole current byte, undefined bits too.
    expect(pauseMasks("resume", 0xcc)).toEqual({ setMask: 0, clearMask: 0xcc });
  });

  it("labels the audit values as expected, with the observed read apart", () => {
    // Panel saw 0x00, but another Admin paused custody entry in between.
    expect(pauseAuditMetadata(0x04, 0, 0x00)).toEqual({
      set: "0x04",
      clear: "0x00",
      expected_old: "0x00",
      expected_new: "0x04",
    });
    expect(pauseAuditMetadata(0x04, 0, 0x00, 0x0c)).toMatchObject({
      expected_new: "0x04",
      observed_after: "0x0c",
    });
    expect(pauseAuditMetadata(0, 0x3f, 0x3f, null).observed_after).toBeNull();
  });
});

describe("pause-related transaction errors", () => {
  const withLogs = (logs: string[]) =>
    Object.assign(new Error("Transaction simulation failed"), {
      context: { logs },
    });

  it("explains the registry's PlatformPaused by name", () => {
    expect(
      explainSendError(
        withLogs([
          "Program log: AnchorError caused by account: platform. Error Code: PlatformPaused. Error Number: 6000. Error Message: Platform is paused.",
          "Program FJs1EM1ND89L9sUXaS8VBKYXjmoXCkkVSJKRE19hmYxS failed: custom program error: 0x1770",
        ]),
      ),
    ).toBe(PLATFORM_PAUSED_HINT);
  });

  it("does not mistake the hook's own 6000 for a pause", () => {
    const message = explainSendError(
      withLogs([
        "Program log: AnchorError occurred. Error Code: KycRegistryRequired. Error Number: 6000. Error Message: KycGated restriction mode requires a kyc_registry.",
        "Program GBDyesyTr266LqKeFq95r1DeigRyHpfw6ACWdjENHAPy failed: custom program error: 0x1770",
      ]),
    );
    expect(message).not.toBe(PLATFORM_PAUSED_HINT);
  });

  it("explains the new pause, treasury and price errors", () => {
    expect(
      explainSendError(withLogs(["Program x failed: custom program error: 0x17e7"])),
    ).toMatch(/Only the Super Admin can resume/);
    expect(
      explainSendError(withLogs(["Program x failed: custom program error: 0x17e6"])),
    ).toMatch(/InvalidPauseFlags/);
    expect(
      explainSendError(withLogs(["Program x failed: custom program error: 0x17e8"])),
    ).toMatch(/InvalidProtocolTreasury/);
    expect(
      explainSendError(withLogs(["Program x failed: custom program error: 0x17e9"])),
    ).toMatch(/greater than zero/);
  });

  it("explains the sale-approval and treasury-mint errors (6122-6128)", () => {
    const hint = (code: number) =>
      explainSendError(withLogs([`Program x failed: custom program error: 0x${code.toString(16)}`]));
    expect(hint(6122)).toMatch(/SaleApprovalExpired/);
    expect(hint(6123)).toMatch(/SaleApprovalMismatch/);
    expect(hint(6124)).toMatch(/SalePriceOutsideApproval/);
    expect(hint(6125)).toMatch(/SaleExceedsApprovedRaise/);
    expect(hint(6126)).toMatch(/InvalidSaleApproval/);
    expect(hint(6127)).toMatch(/SaleIdAlreadyUsed/);
    expect(hint(6128)).toMatch(/TreasuryMintRequiresAdmin/);
  });

  it("names a missing or foreign sale approval, not a generic 3012 / 2006", () => {
    expect(
      explainSendError(
        withLogs([
          "Program log: AnchorError caused by account: sale_approval. Error Code: AccountNotInitialized. Error Number: 3012. Error Message: The program expected this account to be already initialized.",
          "Program FJs1EM1ND89L9sUXaS8VBKYXjmoXCkkVSJKRE19hmYxS failed: custom program error: 0xbc4",
        ]),
      ),
    ).toBe(NO_SALE_APPROVAL_HINT);
    expect(
      explainSendError(
        withLogs([
          "Program log: AnchorError caused by account: sale_approval. Error Code: ConstraintSeeds. Error Number: 2006. Error Message: A seeds constraint was violated.",
        ]),
      ),
    ).toBe(SALE_APPROVAL_OTHER_ID_HINT);
    // Another account's 3012 keeps its own explanation.
    expect(
      explainSendError(
        withLogs([
          "Program log: AnchorError caused by account: admin_record. Error Code: AccountNotInitialized. Error Number: 3012. Error Message: The program expected this account to be already initialized.",
        ]),
      ),
    ).not.toBe(NO_SALE_APPROVAL_HINT);
  });
});
