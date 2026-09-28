import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CLOSE_BOOTSTRAP_MASKS,
  describePausedAreas,
  EMERGENCY_PAUSE_BITS,
  formatPauseFlags,
  isBootstrapOpen,
  isPaused,
  nextPauseFlags,
  PAUSE_CUSTODY_ENTRY,
  PAUSE_DISTRIBUTIONS,
  PAUSE_FLAGS,
  PAUSE_FLAGS_ALL,
  PAUSE_ISSUER_PROCEEDS,
  PAUSE_ONBOARDING,
  PAUSE_PAYOUT_MODULES,
  PAUSE_PRIMARY,
  PAUSE_SECONDARY,
  PAYOUT_MODULES_CLEAR_ALONE,
  PLATFORM_BOOTSTRAP_OPEN,
  RESUME_EVERYTHING_MASK,
  pauseAuditMetadata,
  pauseControls,
  pausedFlags,
  pauseMasks,
  pauseRole,
  pauseStatus,
  unknownPauseBits,
} from "@/lib/pause-flags";
import {
  BLOCKLIST_RECOVERY_INVALID_HINT,
  BLOCKLIST_RECOVERY_PENDING_HINT,
  explainSendError,
  ISSUER_PROCEEDS_FROZEN_HINT,
  NO_SALE_APPROVAL_HINT,
  PARTY_BLOCKLISTED_HINT,
  PLATFORM_PAUSED_HINT,
  PLATFORM_RECOVERY_PENDING_HINT,
  PROPOSAL_EXPIRED_HINT,
  SALE_APPROVAL_OTHER_ID_HINT,
  TIMELOCK_ACTIVE_HINT,
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
    expect(PAUSE_PAYOUT_MODULES).toBe(rustBit("PAUSE_PAYOUT_MODULES"));
    expect(PLATFORM_BOOTSTRAP_OPEN).toBe(rustBit("PLATFORM_BOOTSTRAP_OPEN"));
    expect(RUST).toMatch(/pub const PAUSE_FLAGS_ALL: u8 = PAUSE_ONBOARDING\s*\|\s*PAUSE_PRIMARY\s*\|\s*PAUSE_SECONDARY\s*\|\s*PAUSE_CUSTODY_ENTRY\s*\|\s*PAUSE_DISTRIBUTIONS\s*\|\s*PAUSE_ISSUER_PROCEEDS\s*\|\s*PAUSE_PAYOUT_MODULES;/);
    expect(PAUSE_FLAGS_ALL).toBe(0x7f);
    expect(EMERGENCY_PAUSE_BITS).toBe(0x3f);
    expect(RESUME_EVERYTHING_MASK).toBe(0xbf);
    expect(PAUSE_FLAGS.map((f) => f.bit)).toEqual([1, 2, 4, 8, 16, 32, 64]);
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

  it("defines every bit of the byte: 0x40 pauses the payout modules, 0x80 is the bootstrap marker", () => {
    expect(unknownPauseBits(0xff)).toBe(0);
    expect(pausedFlags(0x80)).toEqual([]);
    expect(pausedFlags(0x40).map((f) => f.bit)).toEqual([PAUSE_PAYOUT_MODULES]);
    expect(isBootstrapOpen(0xff)).toBe(true);
    expect(isBootstrapOpen(0x7f)).toBe(false);
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
    // Pause never sets bit 7; resume everything never clears 0x40 (6154).
    expect(pauseMasks("pause", 0xff).setMask).toBe(0x7f);
    expect(pauseMasks("resume", RESUME_EVERYTHING_MASK)).toEqual({ setMask: 0, clearMask: 0xbf });
    expect(() => pauseMasks("resume", 0xcc)).toThrow(PAYOUT_MODULES_CLEAR_ALONE);
    expect(pauseMasks("resume", PAUSE_PAYOUT_MODULES)).toEqual({ setMask: 0, clearMask: 0x40 });
    expect(CLOSE_BOOTSTRAP_MASKS).toEqual({ setMask: 0, clearMask: 0x80 });
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

  it("shows one status everywhere: six emergency areas, then the payout modules and the bootstrap window", () => {
    expect(pauseStatus(0)).toEqual({ tone: "active", label: "Active" });
    expect(pauseStatus(0x3f)).toEqual({ tone: "paused", label: "Fully paused" });
    // A fresh Platform.
    expect(pauseStatus(0xff)).toEqual({ tone: "paused", label: "Fully paused · payout modules off · bootstrap open" });
    expect(pauseStatus(0x0c)).toEqual({ tone: "paused", label: "2 of 6 paused" });
    // The normal mainnet byte: nothing paused, payout modules off (D2).
    expect(pauseStatus(0x40)).toEqual({ tone: "active", label: "Active · payout modules off" });
    // Nothing paused but the bootstrap window still open: worth a look.
    expect(pauseStatus(0xc0)).toEqual({ tone: "notice", label: "Active · payout modules off · bootstrap open" });
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
    expect(a.closeBootstrap).toBe(false);
    expect(a.rows.map((r) => r.action)).toEqual([
      "pause", "pause", null, "pause", "pause", "pause", "pause",
    ]);

    const s = pauseControls(0x04, superAdmin);
    expect(s.resumeEverything).toBe(true);
    expect(s.rows.map((r) => r.action)).toEqual([
      "pause", "pause", "resume", "pause", "pause", "pause", "pause",
    ]);

    const v = pauseControls(0x04, viewer);
    expect(v.pauseEverything || v.resumeEverything).toBe(false);
    expect(v.rows.every((r) => r.action === null)).toBe(true);

    // Fully paused: nothing left to pause; only the Super Admin sees resume.
    expect(pauseControls(0x7f, admin).pauseEverything).toBe(false);
    expect(pauseControls(0x7f, admin).rows.every((r) => r.action === null)).toBe(true);
    // A fresh Platform (0xFF): the Super Admin may resume the emergency areas
    // and close the bootstrap window; the payout modules only off mainnet.
    const fresh = pauseControls(0xff, superAdmin);
    expect(fresh.resumeEverything).toBe(true);
    expect(fresh.closeBootstrap).toBe(true);
    expect(fresh.rows.at(-1)).toEqual({ bit: PAUSE_PAYOUT_MODULES, paused: true, action: null });
    expect(pauseControls(0xff, superAdmin, { allowPayoutModules: true }).rows.at(-1)?.action).toBe("resume");
    // Only 0x40 (the mainnet byte): nothing to resume with "Resume everything".
    expect(pauseControls(0x40, superAdmin).resumeEverything).toBe(false);
    expect(pauseControls(0x80, superAdmin)).toMatchObject({ resumeEverything: false, closeBootstrap: true });
    expect(pauseControls(0, superAdmin).resumeEverything).toBe(false);
  });

  it("sends set-only for a pause and clear-only for a resume", () => {
    expect(pauseMasks("pause", 0x7f)).toEqual({ setMask: 0x7f, clearMask: 0 });
    // Resume everything clears the emergency areas and bit 7, never 0x40.
    expect(pauseMasks("resume", RESUME_EVERYTHING_MASK)).toEqual({ setMask: 0, clearMask: 0xbf });
    expect(nextPauseFlags(0xff, 0, RESUME_EVERYTHING_MASK)).toBe(0x40);
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

describe("v1.0.0-rc (8.3) transaction errors", () => {
  const withLogs = (logs: string[]) =>
    Object.assign(new Error("Transaction simulation failed"), { context: { logs } });
  const hex = (code: number) => explainSendError(withLogs([`Program x failed: custom program error: 0x${code.toString(16)}`]));

  it("explains every registry code 6143–6155 by its generated hex", () => {
    expect(hex(6143)).toBe(ISSUER_PROCEEDS_FROZEN_HINT);
    expect(hex(6144)).toBe(PARTY_BLOCKLISTED_HINT);
    expect(hex(6145)).toMatch(/365 days.*SaleDurationInvalid/);
    expect(hex(6146)).toMatch(/2 years.*KycExpiryTooFar/);
    expect(hex(6147)).toMatch(/7 days.*VotingPeriodTooShort/);
    expect(hex(6148)).toMatch(/24 hours.*365 days.*DeliveryDeadlineOutOfRange/);
    expect(hex(6149)).toMatch(/90 days.*DealExpiryOutOfRange/);
    expect(hex(6150)).toBe(TIMELOCK_ACTIVE_HINT);
    expect(hex(6151)).toBe(PROPOSAL_EXPIRED_HINT);
    expect(hex(6152)).toMatch(/InvalidAdminProposal/);
    expect(hex(6153)).toMatch(/InvalidPlatformRecovery/);
    expect(hex(6154)).toMatch(/call of their own.*PayoutModulesClearNotExplicit/);
    expect(hex(6155)).toBe(PLATFORM_RECOVERY_PENDING_HINT);
    expect(PLATFORM_RECOVERY_PENDING_HINT).toMatch(/Cancel the recovery first/);
    expect(hex(6079)).toMatch(/expired for at least 30 days/);
  });

  it("matches the hook's 6017–6020 by Anchor's name: their numbers are also registry codes", () => {
    const hook = (name: string, code: number) =>
      explainSendError(
        withLogs([
          `Program log: AnchorError occurred. Error Code: ${name}. Error Number: ${code}. Error Message: x.`,
          `Program GBDyesyTr266LqKeFq95r1DeigRyHpfw6ACWdjENHAPy failed: custom program error: 0x${code.toString(16)}`,
        ]),
      );
    expect(hook("ProposalExpired", 6017)).toBe(PROPOSAL_EXPIRED_HINT);
    expect(hook("TimelockActive", 6018)).toBe(TIMELOCK_ACTIVE_HINT);
    expect(hook("InvalidRecovery", 6019)).toBe(BLOCKLIST_RECOVERY_INVALID_HINT);
    expect(hook("RecoveryPending", 6020)).toBe(BLOCKLIST_RECOVERY_PENDING_HINT);
    expect(BLOCKLIST_RECOVERY_PENDING_HINT).toMatch(/Cancel the recovery first/);
  });
});
