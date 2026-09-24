// lib/role-resolution (Talas 3.1 §1.1, §2.3): the batched role read, the pure
// role derivation (mirrors the server gates) and the default-deny admin path
// table. Fixtures are real account bytes built with the generated encoders;
// the RPC is a local mock — no network.
import { describe, expect, it, vi } from "vitest";
import { address, getBase64Decoder, type Address } from "@solana/kit";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  findAcceptPlatformAdminTransferPda,
  findAdminRecordPda,
  findKycRegistryPda,
  findPlatformPda,
  getAdminEncoder,
  getAuthorityTransferEncoder,
  getKycRegistryDiscriminatorBytes,
  getKycRegistryEncoder,
  getPlatformEncoder,
  type AuthorityTransfer,
  type KycRegistry,
} from "@/lib/generated/asset_registry";
import {
  TRANSFER_HOOK_PROGRAM_ADDRESS,
  findBlocklistAuthorityPda,
  findTransferPda as findBlocklistTransferPda,
  getBlocklistAuthorityEncoder,
  getBlocklistAuthorityTransferEncoder,
} from "@/lib/generated/transfer_hook";
import { findAuthorityTransferPda } from "@/lib/pdas";
import { findKycRegistryTransferPda } from "@/lib/passport";
import {
  ADMIN_ROUTE_ACCESS,
  adminRouteAllows,
  adminRouteRequirement,
  capabilitiesOf,
  deriveRoles,
  explainRoleRefusal,
  readRoleSnapshot,
  type AdminRouteRule,
  type Capability,
  type OwnedAccount,
  type RoleSnapshot,
  type Rpc,
} from "@/lib/role-resolution";

const WALLET = address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const OTHER = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const THIRD = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const FOREIGN = address("Stake11111111111111111111111111111111111111");
const TREASURY = address("Vote111111111111111111111111111111111111111");

const b64 = getBase64Decoder();

// ── Account bytes ────────────────────────────────────────────────────────────

const platformBytes = (admin: Address) =>
  getPlatformEncoder().encode({
    admin,
    protocolTreasury: TREASURY,
    protocolFeeBps: 50,
    pauseFlags: 0,
    issuersCount: 0,
    version: 1,
    bump: 255,
  });
const adminBytes = (admin: Address) =>
  getAdminEncoder().encode({ admin, addedBy: OTHER, bump: 254 });
const baBytes = (authority: Address) =>
  getBlocklistAuthorityEncoder().encode({ authority, bump: 253 });
const blocklistTransferBytes = (currentAuthority: Address, newAuthority: Address) =>
  getBlocklistAuthorityTransferEncoder().encode({ currentAuthority, newAuthority, bump: 252 });
const transferBytes = (t: Omit<AuthorityTransfer, "discriminator">) =>
  getAuthorityTransferEncoder().encode(t);
const registryBytes = (authority: Address) =>
  getKycRegistryEncoder().encode({
    authority,
    approvedJurisdictions: new Uint8Array(128),
    blockedJurisdictions: new Uint8Array(128),
    entriesCount: 0,
    version: 1,
    bump: 251,
  });

type Stored = { owner: Address; data: Uint8Array };

function rpcAccount(a: Stored) {
  return {
    data: [b64.decode(a.data), "base64"] as const,
    executable: false,
    lamports: BigInt(1_000_000),
    owner: a.owner,
    space: BigInt(a.data.length),
    rentEpoch: BigInt(0),
  };
}

/** A mock RPC over an in-memory account map; records every call in order. */
function mockRpc(accounts: Map<string, Stored>, calls: string[] = []) {
  const rpc = {
    getMultipleAccounts: (addresses: Address[], config?: { commitment?: string }) => ({
      send: async () => {
        calls.push(`getMultipleAccounts:${addresses.length}:${config?.commitment ?? ""}`);
        return { value: addresses.map((a) => (accounts.has(a) ? rpcAccount(accounts.get(a)!) : null)) };
      },
    }),
    getAccountInfo: (a: Address) => ({
      send: async () => {
        calls.push("getAccountInfo");
        return { value: accounts.has(a) ? rpcAccount(accounts.get(a)!) : null };
      },
    }),
    getProgramAccounts: (program: Address) => ({
      send: async () => {
        calls.push("getProgramAccounts");
        const disc = getKycRegistryDiscriminatorBytes();
        return [...accounts.entries()]
          .filter(([, v]) => v.owner === program && disc.every((b, i) => v.data[i] === b))
          .map(([pubkey, v]) => ({ pubkey, account: rpcAccount(v) }));
      },
    }),
  };
  return rpc as unknown as Rpc;
}

async function pdas() {
  const [platform] = await findPlatformPda();
  const [admin] = await findAdminRecordPda({ authority: WALLET });
  const [ba] = await findBlocklistAuthorityPda();
  const [platformTransfer] = await findAcceptPlatformAdminTransferPda({ platform });
  const [blocklistTransfer] = await findBlocklistTransferPda();
  const [registry] = await findKycRegistryPda({ authority: OTHER });
  const registryTransfer = await findAuthorityTransferPda(registry);
  return { platform, admin, ba, platformTransfer, blocklistTransfer, registry, registryTransfer };
}

// ── Snapshot fixtures for the pure derivation ───────────────────────────────

const PLATFORM_PDA = address("SysvarRent111111111111111111111111111111111");
const BA_PDA = address("SysvarC1ock11111111111111111111111111111111");
const REGISTRY = address("ComputeBudget111111111111111111111111111111");

function owned<T>(data: T, programAddress: Address = ASSET_REGISTRY_PROGRAM_ADDRESS, addr: Address = OTHER): OwnedAccount<T> {
  return { address: addr, programAddress, data };
}

function snapshot(over: Partial<RoleSnapshot> = {}): RoleSnapshot {
  return {
    platform: owned({ admin: OTHER } as never, ASSET_REGISTRY_PROGRAM_ADDRESS, PLATFORM_PDA),
    adminRecord: null,
    blocklistAuthority: owned({ authority: OTHER } as never, TRANSFER_HOOK_PROGRAM_ADDRESS, BA_PDA),
    platformTransfer: null,
    blocklistTransfer: null,
    kycRegistry: null,
    kycTransfer: null,
    kycResolved: true,
    kycUnavailable: null,
    ...over,
  };
}

const registry = (authority: Address): { address: Address; registry: KycRegistry } => ({
  address: REGISTRY,
  registry: { authority } as KycRegistry,
});

// ── deriveRoles ──────────────────────────────────────────────────────────────

describe("deriveRoles", () => {
  it("super admin is also admin; nobody else is", () => {
    const sa = deriveRoles(OTHER, snapshot());
    expect(sa.isSuperAdmin).toBe(true);
    expect(sa.isAdmin).toBe(true);
    const stranger = deriveRoles(WALLET, snapshot());
    expect(stranger).toMatchObject({ isSuperAdmin: false, isAdmin: false, isKycProvider: false, isBlocklistAuthority: false });
  });

  it("an Admin record counts only when owned by asset_registry and naming the wallet", () => {
    const valid = snapshot({ adminRecord: owned({ admin: WALLET } as never) });
    expect(deriveRoles(WALLET, valid).isAdmin).toBe(true);
    expect(deriveRoles(WALLET, valid).isSuperAdmin).toBe(false);

    const foreignOwner = snapshot({ adminRecord: owned({ admin: WALLET } as never, FOREIGN) });
    expect(deriveRoles(WALLET, foreignOwner).isAdmin).toBe(false);

    const wrongKey = snapshot({ adminRecord: owned({ admin: THIRD } as never) });
    expect(deriveRoles(WALLET, wrongKey).isAdmin).toBe(false);

    // No platform: mirrors the server gate (no Admin record without a platform).
    const noPlatform = snapshot({ platform: null, adminRecord: owned({ admin: WALLET } as never) });
    expect(deriveRoles(WALLET, noPlatform)).toMatchObject({ isAdmin: false, platformInitialized: false });
  });

  it("a foreign-owned Platform grants nothing", () => {
    const s = snapshot({ platform: owned({ admin: WALLET } as never, FOREIGN, PLATFORM_PDA) });
    expect(deriveRoles(WALLET, s)).toMatchObject({ isSuperAdmin: false, isAdmin: false, platformInitialized: false });
  });

  it("blocklist authority needs the transfer_hook owner", () => {
    const ok = snapshot({ blocklistAuthority: owned({ authority: WALLET } as never, TRANSFER_HOOK_PROGRAM_ADDRESS, BA_PDA) });
    expect(deriveRoles(WALLET, ok).isBlocklistAuthority).toBe(true);
    expect(deriveRoles(WALLET, ok).isAdmin).toBe(false);
    const foreign = snapshot({ blocklistAuthority: owned({ authority: WALLET } as never, FOREIGN, BA_PDA) });
    expect(deriveRoles(WALLET, foreign).isBlocklistAuthority).toBe(false);
  });

  it("KYC provider only for a resolved registry naming the wallet", () => {
    expect(deriveRoles(WALLET, snapshot({ kycRegistry: registry(WALLET) })).isKycProvider).toBe(true);
    // Never implied by super admin.
    expect(deriveRoles(OTHER, snapshot({ kycRegistry: registry(WALLET) })).isKycProvider).toBe(false);
    // Unpinned, not scanned yet.
    expect(
      deriveRoles(WALLET, snapshot({ kycRegistry: null, kycResolved: false })).isKycProvider,
    ).toBe(false);
    // Ambiguous scan / missing pin: no registry, a reason instead.
    for (const reason of ["2 KYC registries exist and none could be selected", "Pinned KYC registry X not found"]) {
      expect(
        deriveRoles(WALLET, snapshot({ kycRegistry: null, kycUnavailable: reason })).isKycProvider,
      ).toBe(false);
    }
  });

  it("platform pending: live only when current = proposed_by = Platform.admin", () => {
    const transfer = (over: Partial<AuthorityTransfer>) =>
      owned({ target: PLATFORM_PDA, currentAuthority: OTHER, newAuthority: WALLET, proposedBy: OTHER, ...over } as AuthorityTransfer);
    const live = deriveRoles(WALLET, snapshot({ platformTransfer: transfer({}) }));
    expect(live.pending).toEqual([{ kind: "platform", target: PLATFORM_PDA, currentAuthority: OTHER }]);
    expect(deriveRoles(OTHER, snapshot({ platformTransfer: transfer({}) })).outgoing).toEqual([
      { kind: "platform", target: PLATFORM_PDA, newAuthority: WALLET, live: true },
    ]);
    // Stale: proposed by a former admin, or aimed at another target.
    expect(deriveRoles(WALLET, snapshot({ platformTransfer: transfer({ proposedBy: THIRD }) })).pending).toEqual([]);
    expect(deriveRoles(WALLET, snapshot({ platformTransfer: transfer({ currentAuthority: THIRD }) })).pending).toEqual([]);
    expect(deriveRoles(WALLET, snapshot({ platformTransfer: transfer({ target: REGISTRY }) })).pending).toEqual([]);
    // Foreign owner ignored.
    const foreign = snapshot({ platformTransfer: { ...transfer({}), programAddress: FOREIGN } });
    expect(deriveRoles(WALLET, foreign).pending).toEqual([]);
  });

  it("blocklist pending: live only when current_authority is the live BA", () => {
    const t = (current: Address) =>
      owned({ currentAuthority: current, newAuthority: WALLET } as never, TRANSFER_HOOK_PROGRAM_ADDRESS);
    expect(deriveRoles(WALLET, snapshot({ blocklistTransfer: t(OTHER) })).pending).toEqual([
      { kind: "blocklist", target: BA_PDA, currentAuthority: OTHER },
    ]);
    expect(deriveRoles(WALLET, snapshot({ blocklistTransfer: t(THIRD) })).pending).toEqual([]);
    expect(deriveRoles(OTHER, snapshot({ blocklistTransfer: t(OTHER) })).outgoing).toEqual([
      { kind: "blocklist", target: BA_PDA, newAuthority: WALLET, live: true },
    ]);
  });

  it("KYC pending: the accept check of kyc-registry-rotation", () => {
    const t = (over: Partial<AuthorityTransfer>) =>
      owned({ target: REGISTRY, currentAuthority: THIRD, newAuthority: WALLET, proposedBy: THIRD, ...over } as AuthorityTransfer);
    const base = { kycRegistry: registry(THIRD) };
    expect(deriveRoles(WALLET, snapshot({ ...base, kycTransfer: t({}) })).pending).toEqual([
      { kind: "kyc", target: REGISTRY, currentAuthority: THIRD },
    ]);
    // Stale (the authority moved since): no pending; the proposer sees it as not live.
    const stale = snapshot({ ...base, kycTransfer: t({ currentAuthority: OTHER, proposedBy: OTHER }) });
    expect(deriveRoles(WALLET, stale).pending).toEqual([]);
    expect(deriveRoles(THIRD, stale).outgoing).toEqual([
      { kind: "kyc", target: REGISTRY, newAuthority: WALLET, live: false },
    ]);
    // Another registry's transfer.
    expect(deriveRoles(WALLET, snapshot({ ...base, kycTransfer: t({ target: PLATFORM_PDA }) })).pending).toEqual([]);
  });
});

describe("explainRoleRefusal", () => {
  it("adds the not-finalized hint to a server role refusal only", () => {
    expect(explainRoleRefusal("Admin or KYC provider privileges required")).toBe(
      "Admin or KYC provider privileges required. Role change not finalized yet — retry in about 30 s.",
    );
    expect(explainRoleRefusal("Client not found")).toBe("Client not found");
  });
});

describe("capabilitiesOf", () => {
  it("maps flags to capabilities; the super admin carries admin", () => {
    const none = { isSuperAdmin: false, isAdmin: false, isKycProvider: false, isBlocklistAuthority: false };
    expect([...capabilitiesOf({ ...none, isSuperAdmin: true })].sort()).toEqual(["admin", "superAdmin"]);
    expect([...capabilitiesOf({ ...none, isKycProvider: true, isIssuer: true })].sort()).toEqual(["issuer", "kycProvider"]);
    expect([...capabilitiesOf({ ...none, isBlocklistAuthority: true })]).toEqual(["blocklistAuthority"]);
    expect(capabilitiesOf(none).size).toBe(0);
  });
});

// ── Admin path table ─────────────────────────────────────────────────────────

const caps = (...c: Capability[]) => new Set<Capability>(c);

describe("adminRouteAllows", () => {
  it("admins open every /admin path", () => {
    for (const path of ["/admin", "/admin/", "/admin/kyc", "/admin/fees", "/admin/clients/abc", "/admin/anything/new"]) {
      expect(adminRouteAllows(path, caps("admin"))).toBe(true);
    }
  });

  it("denies by default: an unlisted path is admin-only", () => {
    expect(adminRouteRequirement("/admin/fees")).toEqual(["admin"]);
    for (const c of ["kycProvider", "blocklistAuthority", "issuer"] as const) {
      expect(adminRouteAllows("/admin/fees", caps(c))).toBe(false);
      expect(adminRouteAllows("/admin/platform", caps(c))).toBe(false);
    }
    expect(adminRouteAllows("/admin", caps())).toBe(false);
  });

  it("matches whole path segments only (a custom table)", () => {
    const table: AdminRouteRule[] = [
      { match: "/admin", exact: true, anyOf: ["admin", "kycProvider"] },
      { match: "/admin/kyc", anyOf: ["admin", "kycProvider"] },
      { match: "/admin/clients", anyOf: ["admin", "kycProvider"] },
      { match: "/admin/blocklist", anyOf: ["admin", "blocklistAuthority"] },
    ];
    const op = caps("kycProvider");
    expect(adminRouteAllows("/admin", op, table)).toBe(true);
    expect(adminRouteAllows("/admin/kyc", op, table)).toBe(true);
    expect(adminRouteAllows("/admin/clients/abc", op, table)).toBe(true);
    expect(adminRouteAllows("/admin/clients/abc/", op, table)).toBe(true);
    expect(adminRouteAllows("/admin/kycx", op, table)).toBe(false);
    expect(adminRouteAllows("/admin/clientsexport", op, table)).toBe(false);
    expect(adminRouteAllows("/admin/fees", op, table)).toBe(false);
    expect(adminRouteAllows("/admin/blocklist-audit", caps("blocklistAuthority"), table)).toBe(false);
    // `exact` keeps /admin from opening its sub-paths.
    expect(adminRouteAllows("/admin/platform", op, table)).toBe(false);
  });

  it("the KYC provider opens the overview, KYC and client pages — nothing else (K6)", () => {
    const kyc = caps("kycProvider");
    for (const path of ["/admin", "/admin/kyc", "/admin/clients", "/admin/clients/abc", "/admin/clients/abc/"]) {
      expect(adminRouteAllows(path, kyc)).toBe(true);
    }
    for (const path of [
      "/admin/kycx",
      "/admin/clientsexport",
      "/admin/fees",
      "/admin/compliance",
      "/admin/admins",
      "/admin/platform",
      "/admin/audit",
    ]) {
      expect(adminRouteAllows(path, kyc)).toBe(false);
    }
  });

  it("every rule names at least one capability and lives under /admin", () => {
    for (const rule of ADMIN_ROUTE_ACCESS) {
      expect(rule.anyOf.length).toBeGreaterThan(0);
      expect(rule.match === "/admin" || rule.match.startsWith("/admin/")).toBe(true);
      expect(rule.match.endsWith("/")).toBe(false);
    }
  });
});

// ── readRoleSnapshot (batched read) ──────────────────────────────────────────

describe("readRoleSnapshot", () => {
  it("pinned: verifies the network first, then ONE getMultipleAccounts for 7 accounts", async () => {
    const p = await pdas();
    const accounts = new Map<string, Stored>([
      [p.platform, { owner: ASSET_REGISTRY_PROGRAM_ADDRESS, data: platformBytes(OTHER) as Uint8Array }],
      [p.admin, { owner: ASSET_REGISTRY_PROGRAM_ADDRESS, data: adminBytes(WALLET) as Uint8Array }],
      [p.ba, { owner: TRANSFER_HOOK_PROGRAM_ADDRESS, data: baBytes(WALLET) as Uint8Array }],
      [p.blocklistTransfer, { owner: TRANSFER_HOOK_PROGRAM_ADDRESS, data: blocklistTransferBytes(WALLET, THIRD) as Uint8Array }],
      [p.registry, { owner: ASSET_REGISTRY_PROGRAM_ADDRESS, data: registryBytes(WALLET) as Uint8Array }],
      [
        p.registryTransfer,
        {
          owner: ASSET_REGISTRY_PROGRAM_ADDRESS,
          data: transferBytes({ target: p.registry, currentAuthority: WALLET, newAuthority: THIRD, proposedBy: WALLET, bump: 1 }) as Uint8Array,
        },
      ],
    ]);
    const calls: string[] = [];
    const verifyNetwork = vi.fn(async () => {
      calls.push("verifyNetwork");
    });
    const s = await readRoleSnapshot(mockRpc(accounts, calls), WALLET, {
      pinned: p.registry,
      withKycScan: false,
      verifyNetwork,
    });
    expect(calls).toEqual(["verifyNetwork", "getMultipleAccounts:7:confirmed"]);
    expect(s.kycResolved).toBe(true);
    expect(s.kycRegistry?.address).toBe(p.registry);
    const flags = deriveRoles(WALLET, s);
    expect(flags).toMatchObject({ isAdmin: true, isSuperAdmin: false, isKycProvider: true, isBlocklistAuthority: true });
    expect(flags.outgoing).toEqual([
      { kind: "blocklist", target: p.ba, newAuthority: THIRD, live: true },
      { kind: "kyc", target: p.registry, newAuthority: THIRD, live: true },
    ]);
    // The proposed wallet sees both as pending in the same single read.
    const target = deriveRoles(THIRD, s);
    expect(target.pending.map((r) => r.kind)).toEqual(["blocklist", "kyc"]);
  });

  it("the transfer PDA helper is shared with lib/passport and matches the platform seed", async () => {
    const p = await pdas();
    expect(await findKycRegistryTransferPda(p.registry)).toBe(p.registryTransfer);
    expect(await findAuthorityTransferPda(p.platform)).toBe(p.platformTransfer);
  });

  it("decodes only after owner, discriminator and length checks", async () => {
    const p = await pdas();
    const base = new Map<string, Stored>([
      [p.platform, { owner: ASSET_REGISTRY_PROGRAM_ADDRESS, data: platformBytes(OTHER) as Uint8Array }],
    ]);
    const good = adminBytes(WALLET) as Uint8Array;
    const wrongDisc = Uint8Array.from(good);
    wrongDisc[0] ^= 0xff;
    for (const bad of [
      { owner: FOREIGN, data: good },
      { owner: ASSET_REGISTRY_PROGRAM_ADDRESS, data: wrongDisc },
      { owner: ASSET_REGISTRY_PROGRAM_ADDRESS, data: good.slice(0, good.length - 1) },
    ]) {
      const accounts = new Map(base).set(p.admin, bad);
      const s = await readRoleSnapshot(mockRpc(accounts), WALLET, { pinned: null, withKycScan: false });
      expect(s.adminRecord).toBeNull();
      expect(deriveRoles(WALLET, s).isAdmin).toBe(false);
    }
    // A foreign-owned "blocklist authority" and platform are ignored too.
    const forged = new Map<string, Stored>([
      [p.platform, { owner: FOREIGN, data: platformBytes(WALLET) as Uint8Array }],
      [p.ba, { owner: ASSET_REGISTRY_PROGRAM_ADDRESS, data: baBytes(WALLET) as Uint8Array }],
    ]);
    const s = await readRoleSnapshot(mockRpc(forged), WALLET, { pinned: null, withKycScan: false });
    expect(deriveRoles(WALLET, s)).toMatchObject({ isSuperAdmin: false, isBlocklistAuthority: false });
  });

  it("a missing or mistyped pin fails the KYC role closed, not the whole read", async () => {
    const p = await pdas();
    const platformOnly = new Map<string, Stored>([
      [p.platform, { owner: ASSET_REGISTRY_PROGRAM_ADDRESS, data: platformBytes(WALLET) as Uint8Array }],
    ]);
    const missing = await readRoleSnapshot(mockRpc(platformOnly), WALLET, { pinned: p.registry, withKycScan: false, network: "devnet" });
    expect(missing.kycRegistry).toBeNull();
    expect(missing.kycUnavailable).toMatch(/not found on devnet/);
    expect(deriveRoles(WALLET, missing)).toMatchObject({ isSuperAdmin: true, isKycProvider: false });

    const mistyped = new Map(platformOnly).set(p.registry, {
      owner: ASSET_REGISTRY_PROGRAM_ADDRESS,
      data: platformBytes(WALLET) as Uint8Array,
    });
    const bad = await readRoleSnapshot(mockRpc(mistyped), WALLET, { pinned: p.registry, withKycScan: false });
    expect(bad.kycRegistry).toBeNull();
    expect(bad.kycUnavailable).toMatch(/not a KycRegistry/);
  });

  it("unpinned without withKycScan never scans; with it, the registry resolves", async () => {
    const p = await pdas();
    const accounts = new Map<string, Stored>([
      [p.platform, { owner: ASSET_REGISTRY_PROGRAM_ADDRESS, data: platformBytes(OTHER) as Uint8Array }],
      [p.registry, { owner: ASSET_REGISTRY_PROGRAM_ADDRESS, data: registryBytes(WALLET) as Uint8Array }],
    ]);
    const calls: string[] = [];
    const lazy = await readRoleSnapshot(mockRpc(accounts, calls), WALLET, { pinned: null, withKycScan: false });
    expect(calls).toEqual(["getMultipleAccounts:5:confirmed"]);
    expect(lazy).toMatchObject({ kycResolved: false, kycRegistry: null });
    expect(deriveRoles(WALLET, lazy).isKycProvider).toBe(false);

    const scanCalls: string[] = [];
    const scanned = await readRoleSnapshot(mockRpc(accounts, scanCalls), WALLET, { pinned: null, withKycScan: true });
    expect(scanCalls.filter((c) => c === "getProgramAccounts")).toHaveLength(1);
    expect(scanned.kycResolved).toBe(true);
    expect(scanned.kycRegistry?.address).toBe(p.registry);
    expect(deriveRoles(WALLET, scanned).isKycProvider).toBe(true);
  });

  it("an unpinned scan failure fails the KYC role closed with a reason", async () => {
    const p = await pdas();
    const accounts = new Map<string, Stored>([
      [p.platform, { owner: ASSET_REGISTRY_PROGRAM_ADDRESS, data: platformBytes(OTHER) as Uint8Array }],
    ]);
    const rpc = mockRpc(accounts) as unknown as Record<string, unknown>;
    rpc.getProgramAccounts = () => ({
      send: async () => {
        throw new Error("scan throttled");
      },
    });
    const s = await readRoleSnapshot(rpc as unknown as Rpc, WALLET, { pinned: null, withKycScan: true });
    expect(s.kycRegistry).toBeNull();
    expect(s.kycUnavailable).toMatch(/scan throttled/);
  });

  it("throws on a network-verification or RPC failure (never 'public')", async () => {
    const calls: string[] = [];
    await expect(
      readRoleSnapshot(mockRpc(new Map(), calls), WALLET, {
        pinned: null,
        withKycScan: false,
        verifyNetwork: async () => {
          throw new Error("wrong cluster");
        },
      }),
    ).rejects.toThrow("wrong cluster");
    expect(calls).toEqual([]);

    const broken = {
      getMultipleAccounts: () => ({
        send: async () => {
          throw new Error("503");
        },
      }),
    } as unknown as Rpc;
    await expect(readRoleSnapshot(broken, WALLET, { pinned: null, withKycScan: false })).rejects.toThrow("503");
  });
});
