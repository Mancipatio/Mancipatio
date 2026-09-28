// describeRoleRecovery: what /account/roles shows about a pending recovery of
// the Super Admin / blocklist-authority key (D4): the 7-day window, the
// rotation block, and who may cancel.
import { describe, expect, it } from "vitest";
import type { Address } from "@solana/kit";
import { describeRoleRecovery, type RoleRecoveryState } from "@/lib/role-recovery";
import { RECOVERY_DELAY_SECONDS, PROPOSAL_WINDOW_SECONDS } from "@/lib/proposal-window";

const CURRENT = "CurrentSuperAdmin1111111111111111111111111" as Address;
const NEW_KEY = "NewSuperAdmin111111111111111111111111111111" as Address;
const UA = "UpgradeAuthority11111111111111111111111111" as Address;
const OTHER = "SomeoneElse11111111111111111111111111111111" as Address;
const T0 = 1_700_000_000;

function platformState(stale = false): RoleRecoveryState {
  return {
    kind: "platform",
    target: OTHER,
    current: CURRENT,
    recoveryPda: OTHER,
    stale,
    recovery: {
      discriminator: new Uint8Array(8),
      platform: OTHER,
      currentAdmin: CURRENT,
      newAdmin: NEW_KEY,
      proposedBy: UA,
      proposedAt: BigInt(T0),
      eta: BigInt(T0 + RECOVERY_DELAY_SECONDS),
      expiresAt: BigInt(T0 + RECOVERY_DELAY_SECONDS + PROPOSAL_WINDOW_SECONDS),
      version: 1,
      bump: 255,
    },
  };
}

describe("describeRoleRecovery", () => {
  it("is null without a staged recovery", () => {
    expect(describeRoleRecovery(null, CURRENT, T0)).toBeNull();
    expect(describeRoleRecovery({ ...platformState(), recovery: null }, CURRENT, T0)).toBeNull();
  });

  it("waits 7 days, blocks rotation, and lets the holder or the proposer cancel", () => {
    const n = describeRoleRecovery(platformState(), CURRENT, T0 + 60)!;
    expect(n.title).toMatch(/Super Admin/);
    expect(n.window.kind).toBe("waiting");
    expect(n.blocked).toMatch(/cannot be rotated/);
    expect(n.cancelers).toContain(CURRENT);
    expect(n.cancelers).toContain(UA);
    expect(n.canCancel).toBe(true);
    expect(n.isNewKey).toBe(false);
    expect(describeRoleRecovery(platformState(), UA, T0)!.canCancel).toBe(true);
    expect(describeRoleRecovery(platformState(), OTHER, T0)!.canCancel).toBe(false);
    expect(describeRoleRecovery(platformState(), null, T0)!.canCancel).toBe(false);
  });

  it("opens at eta for the recovered key and expires 14 days later", () => {
    const open = describeRoleRecovery(platformState(), NEW_KEY, T0 + RECOVERY_DELAY_SECONDS)!;
    expect(open.window.kind).toBe("open");
    expect(open.isNewKey).toBe(true);
    expect(open.canCancel).toBe(false);
    const late = describeRoleRecovery(platformState(), NEW_KEY, T0 + RECOVERY_DELAY_SECONDS + PROPOSAL_WINDOW_SECONDS)!;
    expect(late.window.kind).toBe("expired");
  });

  it("says a stale recovery can only be cancelled", () => {
    expect(describeRoleRecovery(platformState(true), CURRENT, T0)!.blocked).toMatch(/can no longer be executed/);
  });

  it("names the blocklist authority for the hook's recovery", () => {
    const state: RoleRecoveryState = {
      kind: "blocklist",
      target: OTHER,
      current: CURRENT,
      recoveryPda: OTHER,
      stale: false,
      recovery: {
        discriminator: new Uint8Array(8),
        currentAuthority: CURRENT,
        newAuthority: NEW_KEY,
        proposedBy: UA,
        proposedAt: BigInt(T0),
        eta: BigInt(T0 + RECOVERY_DELAY_SECONDS),
        expiresAt: BigInt(T0 + RECOVERY_DELAY_SECONDS + PROPOSAL_WINDOW_SECONDS),
        bump: 254,
      },
    };
    const n = describeRoleRecovery(state, NEW_KEY, T0)!;
    expect(n.title).toMatch(/blocklist authority/);
    expect(n.newKey).toBe(NEW_KEY);
  });
});
