// lib/role-state (Talas 3.1): what the RoleProvider hands every consumer and
// how a gate decides, driven through the REAL role store. The provider's key
// derivation, the error state, the loading states after an invalidation and
// a wallet switch, the KYC-demand loading on unpinned builds, and the gate's
// "keep the previous decision while stale, never make a new one" rule.
import { describe, expect, it } from "vitest";
import { address, type Address } from "@solana/kit";
import { ASSET_REGISTRY_PROGRAM_ADDRESS, type KycRegistry } from "@/lib/generated/asset_registry";
import { TRANSFER_HOOK_PROGRAM_ADDRESS } from "@/lib/generated/transfer_hook";
import type { OwnedAccount, RoleSnapshot } from "@/lib/role-resolution";
import { createRoleStore, type RoleReadResult } from "@/lib/role-store";
import {
  INITIAL_ROLE_STATE,
  deriveView,
  gateOutcome,
  holdsOperatorRole,
  requirementKey,
  roleKeyFor,
  toRoleState,
  type GateDecision,
  type RoleRequirement,
  type RoleState,
} from "@/lib/role-state";

const A = address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const B = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const SUPER = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const PLATFORM_PDA = address("SysvarRent111111111111111111111111111111111");
const BA_PDA = address("SysvarC1ock11111111111111111111111111111111");
const REGISTRY = address("ComputeBudget111111111111111111111111111111");

function owned<T>(data: T, programAddress: Address, addr: Address): OwnedAccount<T> {
  return { address: addr, programAddress, data };
}

/** A as an Admin (not super admin); `ba` names the blocklist authority. */
function snapshot(opts: { admin?: Address | null; ba?: Address; kyc?: Address | null } = {}): RoleSnapshot {
  const admin = opts.admin === undefined ? A : opts.admin;
  return {
    platform: owned({ admin: SUPER } as never, ASSET_REGISTRY_PROGRAM_ADDRESS, PLATFORM_PDA),
    adminRecord: admin ? owned({ admin } as never, ASSET_REGISTRY_PROGRAM_ADDRESS, B) : null,
    blocklistAuthority: owned({ authority: opts.ba ?? SUPER } as never, TRANSFER_HOOK_PROGRAM_ADDRESS, BA_PDA),
    platformTransfer: null,
    blocklistTransfer: null,
    kycRegistry: opts.kyc ? { address: REGISTRY, registry: { authority: opts.kyc } as KycRegistry } : null,
    kycTransfer: null,
    kycResolved: true,
    kycUnavailable: null,
  };
}

const read = (s: RoleSnapshot): RoleReadResult => ({ snapshot: s, isIssuer: false, isVerifiedIssuer: false });

const refresh = () => {};

/** What useRole returns for `wallet` given the store's current view. */
function stateOf(
  store: ReturnType<typeof createRoleStore<RoleReadResult>>,
  wallet: string | null,
  needKyc = false,
): RoleState {
  const key = roleKeyFor(true, wallet, "devnet");
  const view = key ? store.getView(key) : ({ status: "idle" } as const);
  return toRoleState({ isReady: true, wallet, view, derived: deriveView(view, wallet), refresh }, needKyc);
}

const ADMIN: RoleRequirement = { role: "admin" };
const decided = (wallet: string, requirement: RoleRequirement, outcome: "allowed" | "denied"): GateDecision => ({
  wallet,
  requirement: requirementKey(requirement),
  outcome,
});

describe("provider state (toRoleState)", () => {
  it("keys by network and wallet, and has no key until the wallet is usable", () => {
    expect(roleKeyFor(true, A, "devnet")).toBe(`devnet|${A}`);
    expect(roleKeyFor(true, A, "mainnet")).not.toBe(roleKeyFor(true, A, "devnet"));
    expect(roleKeyFor(false, A, "devnet")).toBeNull();
    expect(roleKeyFor(true, null, "devnet")).toBeNull();
  });

  it("not ready → initial loading; no wallet → disconnected, not loading", () => {
    expect(toRoleState(null, false)).toBe(INITIAL_ROLE_STATE);
    const disconnected = toRoleState(
      { isReady: true, wallet: null, view: { status: "idle" }, derived: null, refresh },
      false,
    );
    expect(disconnected).toMatchObject({ loading: false, role: "disconnected" });
    expect(gateOutcome(disconnected, ADMIN)).toBe("disconnected");
  });

  it("a failed read keeps every gate closed and never looks like a plain public user", async () => {
    const store = createRoleStore<RoleReadResult>();
    await store.request(`devnet|${A}`, false, async () => {
      throw new Error("rpc down");
    });
    const s = stateOf(store, A);
    expect(s).toMatchObject({ loading: false, role: "public", error: "rpc down", isAdmin: false });
    expect(s.capabilities.size).toBe(0);
    expect(gateOutcome(s, ADMIN)).toBe("error");
    expect(gateOutcome(s, { anyOf: ["kycProvider"] })).toBe("error");
  });

  it("a wallet switch never shows the previous wallet's roles, even while A's value is stale", async () => {
    const store = createRoleStore<RoleReadResult>();
    await store.request(`devnet|${A}`, false, async () => read(snapshot()));
    expect(stateOf(store, A)).toMatchObject({ isAdmin: true, walletAddress: A });
    store.invalidate(); // A's value is now stale
    const b = stateOf(store, B);
    expect(b).toMatchObject({ loading: true, walletAddress: B, isAdmin: false, stale: false });
    expect(gateOutcome(b, ADMIN, decided(A, ADMIN, "allowed"))).toBe("loading");
  });

  it("a consumer needing the KYC role keeps loading on a read without the scan", async () => {
    const store = createRoleStore<RoleReadResult>();
    await store.request(`devnet|${A}`, false, async () => read(snapshot({ kyc: A })));
    expect(stateOf(store, A, false).loading).toBe(false);
    expect(stateOf(store, A, true).loading).toBe(true);
    expect(gateOutcome(stateOf(store, A, true), { anyOf: ["kycProvider"] })).toBe("loading");
    await store.request(`devnet|${A}`, true, async () => read(snapshot({ kyc: A })));
    expect(stateOf(store, A, true)).toMatchObject({ loading: false, isKycProvider: true });
  });
});

describe("after invalidateRoles (stale, re-reading)", () => {
  it("keeps showing the last value, flagged stale, instead of loading", async () => {
    const store = createRoleStore<RoleReadResult>();
    const key = `devnet|${A}`;
    await store.request(key, false, async () => read(snapshot()));
    store.invalidate();
    const s = stateOf(store, A);
    expect(s).toMatchObject({ loading: false, stale: true, isAdmin: true });
  });

  it("an open gate stays open (its page is not unmounted) until the re-read lands, then re-gates", async () => {
    const store = createRoleStore<RoleReadResult>();
    const key = `devnet|${A}`;
    await store.request(key, false, async () => read(snapshot()));
    const before = stateOf(store, A);
    expect(gateOutcome(before, ADMIN)).toBe("allowed");
    const last = decided(A, ADMIN, "allowed");

    store.invalidate();
    let resolve!: (v: RoleReadResult) => void;
    const reread = store.request(key, false, () => new Promise<RoleReadResult>((r) => (resolve = r)));
    expect(gateOutcome(stateOf(store, A), ADMIN, last)).toBe("allowed");

    // The re-read shows the Admin record was revoked: the gate closes.
    resolve(read(snapshot({ admin: null })));
    await reread;
    const after = stateOf(store, A);
    expect(after.stale).toBe(false);
    expect(gateOutcome(after, ADMIN, last)).toBe("denied");
  });

  it("a stale value never makes a new decision: an unopened gate shows loading", async () => {
    const store = createRoleStore<RoleReadResult>();
    await store.request(`devnet|${A}`, false, async () => read(snapshot()));
    store.invalidate();
    const s = stateOf(store, A);
    // Mounted during the stale window, or for another requirement / wallet.
    expect(gateOutcome(s, ADMIN, null)).toBe("loading");
    expect(gateOutcome(s, ADMIN, decided(A, { role: "superAdmin" }, "allowed"))).toBe("loading");
    expect(gateOutcome(s, ADMIN, decided(B, ADMIN, "allowed"))).toBe("loading");
    // A previous decision the stale value no longer supports is not kept either.
    expect(gateOutcome(s, ADMIN, decided(A, ADMIN, "denied"))).toBe("loading");
  });

  it("a closed gate stays closed while stale (no skeleton flash, no access)", async () => {
    const store = createRoleStore<RoleReadResult>();
    await store.request(`devnet|${A}`, false, async () => read(snapshot({ admin: null })));
    const last = decided(A, ADMIN, "denied");
    expect(gateOutcome(stateOf(store, A), ADMIN)).toBe("denied");
    store.invalidate();
    expect(gateOutcome(stateOf(store, A), ADMIN, last)).toBe("denied");
  });

  it("a failed re-read replaces the stale value with the error", async () => {
    const store = createRoleStore<RoleReadResult>();
    const key = `devnet|${A}`;
    await store.request(key, false, async () => read(snapshot()));
    store.invalidate();
    await store.request(key, false, async () => {
      throw new Error("rpc down");
    });
    const s = stateOf(store, A);
    expect(s).toMatchObject({ stale: false, error: "rpc down", isAdmin: false });
    expect(gateOutcome(s, ADMIN, decided(A, ADMIN, "allowed"))).toBe("error");
  });
});

describe("holdsOperatorRole (Access denied → /account/roles)", () => {
  it("is true for the Super Admin, the KYC provider and the blocklist authority only", () => {
    const none = { isSuperAdmin: false, isKycProvider: false, isBlocklistAuthority: false };
    expect(holdsOperatorRole(none)).toBe(false);
    expect(holdsOperatorRole({ ...none, isKycProvider: true })).toBe(true);
    expect(holdsOperatorRole({ ...none, isBlocklistAuthority: true })).toBe(true);
    expect(holdsOperatorRole({ ...none, isSuperAdmin: true })).toBe(true);
  });
});
