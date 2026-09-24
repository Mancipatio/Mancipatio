// lib/pending-roles (Talas 3.1 §4): every proposal naming a wallet, classified
// by target, with the exact on-chain accept rules. Fixtures are real account
// bytes built with the generated encoders over an in-memory mock RPC — no
// network.
import { describe, expect, it, vi } from "vitest";
import {
  address,
  createNoopSigner,
  getBase58Encoder,
  getBase64Decoder,
  type Address,
} from "@solana/kit";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  KybStatus,
  VaultState,
  findAcceptPlatformAdminTransferPda,
  findAdminRecordPda,
  findPlatformPda,
  getAdminEncoder,
  getAuthorityTransferEncoder,
  getCustodyVaultEncoder,
  getIssuerEncoder,
  getIssuerRecoveryEncoder,
  getKycRegistryEncoder,
  getPlatformEncoder,
  parseAcceptKycRegistryAuthorityInstruction,
  parseCancelKycRegistryAuthorityTransferInstruction,
  type AuthorityTransfer,
} from "@/lib/generated/asset_registry";
import {
  TRANSFER_HOOK_PROGRAM_ADDRESS,
  findBlocklistAuthorityPda,
  findTransferPda as findBlocklistTransferPda,
  getBlocklistAuthorityEncoder,
  getBlocklistAuthorityTransferEncoder,
} from "@/lib/generated/transfer_hook";
import { findAuthorityTransferPda } from "@/lib/pdas";
import { findIssuerRecoveryPda } from "@/lib/issuer-authority";
import { CUSTODY_STALE_PROPOSAL } from "@/lib/custody-authority";
import {
  ISSUER_ADMIN_KEY_RULE,
  RECOVERY_ADMIN_KEY_RULE,
  buildAcceptKycRegistryRole,
  buildAcceptPendingRole,
  buildCancelKycRegistryProposal,
  findPendingRolesForWallet,
  pendingBadgeCount,
  type PendingRoleRow,
} from "@/lib/pending-roles";
import type { Rpc } from "@/lib/role-resolution";

const WALLET = address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const SUPER = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const OPERATOR = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const ISSUER_KEY = address("Stake11111111111111111111111111111111111111");
const TREASURY = address("Vote111111111111111111111111111111111111111");
const BA_KEY = address("Config1111111111111111111111111111111111111");
const PIN = address("SysvarRent111111111111111111111111111111111");
const OTHER_REGISTRY = address("SysvarC1ock11111111111111111111111111111111");
const VAULT = address("SysvarRecentB1ockHashes11111111111111111111");
const ISSUER = address("SysvarS1otHashes111111111111111111111111111");
const ISSUER_2 = address("SysvarStakeHistory1111111111111111111111111");
const KYC_KEY = address("BPFLoaderUpgradeab1e11111111111111111111111");
const FOREIGN = address("AddressLookupTab1e1111111111111111111111111");

type Stored = { owner: Address; data: Uint8Array };
const b64 = getBase64Decoder();
const b58 = getBase58Encoder();

const platformBytes = (admin: Address) =>
  getPlatformEncoder().encode({
    admin,
    protocolTreasury: TREASURY,
    protocolFeeBps: 0,
    pauseFlags: 0,
    issuersCount: 2,
    version: 1,
    bump: 255,
  }) as Uint8Array;
const adminBytes = (admin: Address) =>
  getAdminEncoder().encode({ admin, addedBy: SUPER, bump: 254 }) as Uint8Array;
const transferBytes = (t: Omit<AuthorityTransfer, "discriminator">) =>
  getAuthorityTransferEncoder().encode(t) as Uint8Array;
const registryBytes = (authority: Address) =>
  getKycRegistryEncoder().encode({
    authority,
    approvedJurisdictions: new Uint8Array(128),
    blockedJurisdictions: new Uint8Array(128),
    entriesCount: 0,
    version: 1,
    bump: 251,
  }) as Uint8Array;
const vaultBytes = (authority: Address, state: VaultState = VaultState.Active) =>
  getCustodyVaultEncoder().encode({
    shareClass: FOREIGN,
    mint: FOREIGN,
    escrow: FOREIGN,
    vaultId: 1,
    authority,
    vaultType: 0,
    realizeAction: 0,
    amount: 1,
    state,
    deadline: 0,
    metadataHash: new Uint8Array(32),
    beneficiary: FOREIGN,
    version: 1,
    bump: 250,
    deposited: 0,
    kycRegistry: PIN,
  }) as Uint8Array;
const issuerBytes = (authority: Address, kybStatus = KybStatus.Pending) =>
  getIssuerEncoder().encode({
    authority,
    legalEntityId: new Uint8Array(32),
    jurisdiction: 688,
    kybStatus,
    kybDocHash: new Uint8Array(32),
    assetsCount: 0,
    version: 1,
    bump: 249,
  }) as Uint8Array;
const recoveryBytes = (issuer: Address, currentAuthority: Address, proposedBy: Address) =>
  getIssuerRecoveryEncoder().encode({
    issuer,
    currentAuthority,
    newAuthority: WALLET,
    proposedBy,
    proposedAt: 10,
    eta: 20,
    expiresAt: 30,
    version: 1,
    bump: 248,
  }) as Uint8Array;

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

type Filter = { memcmp: { offset: bigint; bytes: string } };

/**
 * getMultipleAccounts over `accounts`; getProgramAccounts honours the memcmp
 * filters over the registry-owned accounts, plus `extraGpa` records a
 * misbehaving RPC might return (foreign owner, bad bytes).
 */
function mockRpc(
  accounts: Map<string, Stored>,
  opts: { calls?: string[]; gpaFails?: boolean; extraGpa?: { pubkey: Address; stored: Stored }[] } = {},
) {
  const calls = opts.calls ?? [];
  const rpc = {
    getMultipleAccounts: (addresses: Address[], config?: { commitment?: string }) => ({
      send: async () => {
        calls.push(`getMultipleAccounts:${addresses.length}:${config?.commitment ?? ""}`);
        return { value: addresses.map((a) => (accounts.has(a) ? rpcAccount(accounts.get(a)!) : null)) };
      },
    }),
    getAccountInfo: (a: Address, config?: { commitment?: string }) => ({
      send: async () => {
        calls.push(`getAccountInfo:${config?.commitment ?? ""}`);
        return { context: { slot: BigInt(1) }, value: accounts.has(a) ? rpcAccount(accounts.get(a)!) : null };
      },
    }),
    getProgramAccounts: (program: Address, config: { filters: Filter[] }) => ({
      send: async () => {
        calls.push("getProgramAccounts");
        if (opts.gpaFails) throw new Error("429 Too Many Requests");
        const matches = (data: Uint8Array) =>
          config.filters.every((f) => {
            const want = b58.encode(f.memcmp.bytes);
            const at = Number(f.memcmp.offset);
            return want.every((b, i) => data[at + i] === b);
          });
        const found = [...accounts.entries()]
          .filter(([, v]) => v.owner === program && matches(v.data))
          .map(([pubkey, v]) => ({ pubkey: pubkey as Address, account: rpcAccount(v) }));
        const extra = (opts.extraGpa ?? [])
          .filter((e) => matches(e.stored.data))
          .map((e) => ({ pubkey: e.pubkey, account: rpcAccount(e.stored) }));
        return [...found, ...extra];
      },
    }),
  };
  return rpc as unknown as Rpc;
}

const R = ASSET_REGISTRY_PROGRAM_ADDRESS;

async function world(over: { walletIsAdmin?: boolean; issuerKeyIsAdmin?: boolean } = {}) {
  const [platform] = await findPlatformPda();
  const [platformTransfer] = await findAcceptPlatformAdminTransferPda({ platform });
  const [ba] = await findBlocklistAuthorityPda();
  const [blocklistTransfer] = await findBlocklistTransferPda();
  const accounts = new Map<string, Stored>();
  const put = (a: Address, owner: Address, data: Uint8Array) => accounts.set(a, { owner, data });
  put(platform, R, platformBytes(SUPER));
  put(ba, TRANSFER_HOOK_PROGRAM_ADDRESS, getBlocklistAuthorityEncoder().encode({ authority: BA_KEY, bump: 253 }) as Uint8Array);
  // Platform, blocklist and pinned-registry proposals (the single reads).
  put(platformTransfer, R, transferBytes({ target: platform, currentAuthority: SUPER, newAuthority: WALLET, proposedBy: SUPER, bump: 1 }));
  put(
    blocklistTransfer,
    TRANSFER_HOOK_PROGRAM_ADDRESS,
    getBlocklistAuthorityTransferEncoder().encode({ currentAuthority: BA_KEY, newAuthority: WALLET, bump: 2 }) as Uint8Array,
  );
  put(PIN, R, registryBytes(KYC_KEY));
  put(await findAuthorityTransferPda(PIN), R, transferBytes({ target: PIN, currentAuthority: KYC_KEY, newAuthority: WALLET, proposedBy: KYC_KEY, bump: 3 }));
  // A registry that is not the platform's.
  put(OTHER_REGISTRY, R, registryBytes(KYC_KEY));
  put(
    await findAuthorityTransferPda(OTHER_REGISTRY),
    R,
    transferBytes({ target: OTHER_REGISTRY, currentAuthority: KYC_KEY, newAuthority: WALLET, proposedBy: KYC_KEY, bump: 4 }),
  );
  // Custody: live proposal by the Super Admin.
  put(VAULT, R, vaultBytes(OPERATOR));
  put(await findAuthorityTransferPda(VAULT), R, transferBytes({ target: VAULT, currentAuthority: OPERATOR, newAuthority: WALLET, proposedBy: SUPER, bump: 5 }));
  // Issuer rotation staged to this wallet.
  put(ISSUER, R, issuerBytes(ISSUER_KEY, KybStatus.Verified));
  put(await findAuthorityTransferPda(ISSUER), R, transferBytes({ target: ISSUER, currentAuthority: ISSUER_KEY, newAuthority: WALLET, proposedBy: ISSUER_KEY, bump: 6 }));
  // Issuer recovery to this wallet (executable at chain time 25).
  put(ISSUER_2, R, issuerBytes(ISSUER_KEY, KybStatus.Pending));
  put(await findIssuerRecoveryPda(ISSUER_2), R, recoveryBytes(ISSUER_2, ISSUER_KEY, SUPER));
  // Admin records.
  if (over.walletIsAdmin ?? true) put((await findAdminRecordPda({ authority: WALLET }))[0], R, adminBytes(WALLET));
  if (over.issuerKeyIsAdmin) put((await findAdminRecordPda({ authority: ISSUER_KEY }))[0], R, adminBytes(ISSUER_KEY));
  return { accounts, put, platform, ba, platformTransfer, blocklistTransfer };
}

const kinds = (rows: PendingRoleRow[]) => rows.map((r) => `${r.kind}:${r.target}`);
const opts = { platformRegistry: PIN, chainNow: async () => 25 };

describe("findPendingRolesForWallet", () => {
  it("classifies every target and sorts platform > blocklist > kyc > custody > issuer > recovery", async () => {
    const w = await world({ walletIsAdmin: false });
    const { rows, scanError } = await findPendingRolesForWallet(mockRpc(w.accounts), WALLET, opts);
    expect(scanError).toBeNull();
    expect(kinds(rows)).toEqual([
      `platform:${w.platform}`,
      `blocklist:${w.ba}`,
      `kyc:${PIN}`,
      `kyc:${OTHER_REGISTRY}`,
      `custody:${VAULT}`,
      `issuer:${ISSUER}`,
      `issuerRecovery:${ISSUER_2}`,
    ]);
    const byTarget = new Map(rows.map((r) => [r.target, r]));
    const pin = byTarget.get(PIN)!;
    const other = byTarget.get(OTHER_REGISTRY)!;
    expect(pin.kind === "kyc" && pin.platformRegistry).toBe(true);
    expect(other.kind === "kyc" && other.platformRegistry).toBe(false);
    expect(other.counted).toBe(false);
    const issuer = byTarget.get(ISSUER)!;
    expect(issuer.kind === "issuer" && issuer.kybStatus).toBe(KybStatus.Verified);
    expect(issuer.blocked).toBeNull();
    const recovery = byTarget.get(ISSUER_2)!;
    expect(recovery.kind === "issuerRecovery" && recovery.recovery.kind).toBe("executable");
    expect(recovery.blocked).toBeNull();
    // Without an Admin record the wallet cannot take custody.
    expect(byTarget.get(VAULT)!.blocked).toMatch(/Admin record/);
  });

  it("counts platform, blocklist, the platform registry and live custody — never issuer rows", async () => {
    const w = await world();
    const { rows } = await findPendingRolesForWallet(mockRpc(w.accounts), WALLET, opts);
    expect(rows.filter((r) => r.counted).map((r) => r.kind)).toEqual(["platform", "blocklist", "kyc", "custody"]);
    expect(pendingBadgeCount(rows)).toBe(4);
    for (const r of rows) if (r.kind === "issuer" || r.kind === "issuerRecovery") expect(r.counted).toBe(false);
  });

  it("calls verifyNetwork first and reads every account in ONE getMultipleAccounts after the two scans", async () => {
    const w = await world();
    const calls: string[] = [];
    const verifyNetwork = vi.fn(async () => {
      calls.push("verifyNetwork");
    });
    await findPendingRolesForWallet(mockRpc(w.accounts, { calls }), WALLET, { ...opts, verifyNetwork });
    expect(calls[0]).toBe("verifyNetwork");
    expect(calls.filter((c) => c === "getProgramAccounts")).toHaveLength(2);
    expect(calls.filter((c) => c.startsWith("getMultipleAccounts"))).toHaveLength(1);
    expect(calls.at(-1)).toMatch(/:confirmed$/);
  });

  it("fails before any read when the network check fails", async () => {
    const w = await world();
    const calls: string[] = [];
    await expect(
      findPendingRolesForWallet(mockRpc(w.accounts, { calls }), WALLET, {
        ...opts,
        verifyNetwork: async () => {
          throw new Error("different network");
        },
      }),
    ).rejects.toThrow("different network");
    expect(calls).toEqual([]);
  });

  it("ignores a transfer at the wrong PDA, a foreign owner and a wrong discriminator", async () => {
    const w = await world();
    const liar = address("SysvarEpochSchedu1e111111111111111111111111");
    const forged = transferBytes({ target: ISSUER, currentAuthority: ISSUER_KEY, newAuthority: WALLET, proposedBy: ISSUER_KEY, bump: 9 });
    // Only these fakes stage anything for the issuer: drop the real one.
    w.accounts.delete(await findAuthorityTransferPda(ISSUER));
    const wrongDisc = forged.slice();
    wrongDisc[0] ^= 0xff;
    const { rows } = await findPendingRolesForWallet(
      mockRpc(w.accounts, {
        extraGpa: [
          // Right bytes, wrong address: not ["authority_transfer", target].
          { pubkey: liar, stored: { owner: R, data: forged } },
          // Right address, foreign owner.
          { pubkey: await findAuthorityTransferPda(ISSUER), stored: { owner: FOREIGN, data: forged } },
        ],
      }),
      WALLET,
      opts,
    );
    expect(rows.some((r) => r.kind === "issuer")).toBe(false);
    // A wrong discriminator never matches the scan filter, and a transfer
    // whose target is a foreign-owned account is not a role either.
    w.put(await findAuthorityTransferPda(ISSUER), R, wrongDisc);
    w.put(ISSUER, FOREIGN, issuerBytes(ISSUER_KEY));
    const again = await findPendingRolesForWallet(mockRpc(w.accounts), WALLET, opts);
    expect(again.rows.some((r) => r.target === ISSUER)).toBe(false);
  });

  it("reports a stale or blocked custody proposal instead of offering Accept", async () => {
    const w = await world();
    const transferPda = await findAuthorityTransferPda(VAULT);
    // Proposed by a former Super Admin: stale.
    w.put(transferPda, R, transferBytes({ target: VAULT, currentAuthority: OPERATOR, newAuthority: WALLET, proposedBy: TREASURY, bump: 5 }));
    let custody = (await findPendingRolesForWallet(mockRpc(w.accounts), WALLET, opts)).rows.find((r) => r.kind === "custody")!;
    expect(custody.blocked).toBe(CUSTODY_STALE_PROPOSAL);
    expect(custody.counted).toBe(false);
    await expect(buildAcceptPendingRole(mockRpc(w.accounts), custody, createNoopSigner(WALLET))).rejects.toThrow(
      CUSTODY_STALE_PROPOSAL,
    );
    // The vault operator changed since: stale too.
    w.put(transferPda, R, transferBytes({ target: VAULT, currentAuthority: TREASURY, newAuthority: WALLET, proposedBy: SUPER, bump: 5 }));
    custody = (await findPendingRolesForWallet(mockRpc(w.accounts), WALLET, opts)).rows.find((r) => r.kind === "custody")!;
    expect(custody.blocked).toBe(CUSTODY_STALE_PROPOSAL);
    // Live proposal, but the vault already settled.
    w.put(transferPda, R, transferBytes({ target: VAULT, currentAuthority: OPERATOR, newAuthority: WALLET, proposedBy: SUPER, bump: 5 }));
    w.put(VAULT, R, vaultBytes(OPERATOR, VaultState.Realized));
    custody = (await findPendingRolesForWallet(mockRpc(w.accounts), WALLET, opts)).rows.find((r) => r.kind === "custody")!;
    expect(custody.blocked).toMatch(/Realized/);
    w.put(VAULT, R, vaultBytes(OPERATOR, VaultState.Triggered));
    custody = (await findPendingRolesForWallet(mockRpc(w.accounts), WALLET, opts)).rows.find((r) => r.kind === "custody")!;
    expect(custody.blocked).toBeNull();
    expect(custody.counted).toBe(true);
  });

  it("hides issuer Accept under the Admin-key rule, and allows it from another Admin key", async () => {
    const blocked = await world({ walletIsAdmin: true, issuerKeyIsAdmin: false });
    const row = (await findPendingRolesForWallet(mockRpc(blocked.accounts), WALLET, opts)).rows.find(
      (r) => r.kind === "issuer",
    )!;
    expect(row.blocked).toBe(ISSUER_ADMIN_KEY_RULE);
    const allowed = await world({ walletIsAdmin: true, issuerKeyIsAdmin: true });
    const ok = (await findPendingRolesForWallet(mockRpc(allowed.accounts), WALLET, opts)).rows.find(
      (r) => r.kind === "issuer",
    )!;
    expect(ok.blocked).toBeNull();
    // A stale issuer rotation (the issuer key moved since) is never acceptable.
    allowed.put(ISSUER, R, issuerBytes(TREASURY, KybStatus.Verified));
    const stale = (await findPendingRolesForWallet(mockRpc(allowed.accounts), WALLET, opts)).rows.find(
      (r) => r.kind === "issuer",
    )!;
    expect(stale.blocked).toMatch(/Stale/);
  });

  it("hides recovery Execute when the wallet is an Admin key, and explains a waiting window", async () => {
    const w = await world({ walletIsAdmin: true });
    const row = (await findPendingRolesForWallet(mockRpc(w.accounts), WALLET, opts)).rows.find(
      (r) => r.kind === "issuerRecovery",
    )!;
    expect(row.blocked).toBe(RECOVERY_ADMIN_KEY_RULE);
    const v = await world({ walletIsAdmin: false });
    const waiting = (
      await findPendingRolesForWallet(mockRpc(v.accounts), WALLET, { ...opts, chainNow: async () => 15 })
    ).rows.find((r) => r.kind === "issuerRecovery")!;
    expect(waiting.kind === "issuerRecovery" && waiting.recovery.kind).toBe("waiting");
    expect(waiting.blocked).toMatch(/Waiting period/);
  });

  it("does not read the chain clock when no recovery is staged", async () => {
    const w = await world();
    w.accounts.delete(await findIssuerRecoveryPda(ISSUER_2));
    const chainNow = vi.fn(async () => 25);
    await findPendingRolesForWallet(mockRpc(w.accounts), WALLET, { ...opts, chainNow });
    expect(chainNow).not.toHaveBeenCalled();
  });

  it("keeps the single-read proposals when the scans fail", async () => {
    const w = await world();
    const { rows, scanError } = await findPendingRolesForWallet(mockRpc(w.accounts, { gpaFails: true }), WALLET, opts);
    expect(scanError).toMatch(/Could not scan/);
    expect(kinds(rows)).toEqual([`platform:${w.platform}`, `blocklist:${w.ba}`, `kyc:${PIN}`]);
    expect(pendingBadgeCount(rows)).toBe(3);
  });

  it("drops a platform proposal that is no longer live and a blocklist proposal of a former authority", async () => {
    const w = await world();
    w.put(w.platform, R, platformBytes(TREASURY)); // the Super Admin changed
    w.put(
      w.blocklistTransfer,
      TRANSFER_HOOK_PROGRAM_ADDRESS,
      getBlocklistAuthorityTransferEncoder().encode({ currentAuthority: TREASURY, newAuthority: WALLET, bump: 2 }) as Uint8Array,
    );
    const { rows } = await findPendingRolesForWallet(mockRpc(w.accounts), WALLET, opts);
    expect(rows.some((r) => r.kind === "platform" || r.kind === "blocklist")).toBe(false);
  });

  it("chunks the account read at 100 addresses", async () => {
    const w = await world();
    const extraGpa: { pubkey: Address; stored: Stored }[] = [];
    for (let i = 0; i < 120; i += 1) {
      const bytes = new Uint8Array(32);
      bytes[0] = 7;
      bytes[1] = i;
      const target = (await import("@solana/kit")).getAddressDecoder().decode(bytes);
      extraGpa.push({
        pubkey: await findAuthorityTransferPda(target),
        stored: { owner: R, data: transferBytes({ target, currentAuthority: TREASURY, newAuthority: WALLET, proposedBy: TREASURY, bump: 1 }) },
      });
    }
    const calls: string[] = [];
    const { rows } = await findPendingRolesForWallet(mockRpc(w.accounts, { calls, extraGpa }), WALLET, opts);
    const reads = calls.filter((c) => c.startsWith("getMultipleAccounts"));
    expect(reads.length).toBeGreaterThan(1);
    for (const r of reads) expect(Number(r.split(":")[1])).toBeLessThanOrEqual(100);
    // Unknown (missing) targets are never roles.
    expect(rows).toHaveLength(7);
  });
});

describe("KYC registry accept / cancel builders re-read at finalized", () => {
  it("accept needs a live proposal naming the signer; cancel needs the live authority", async () => {
    const w = await world();
    const calls: string[] = [];
    const rpc = mockRpc(w.accounts, { calls });
    const ix = await buildAcceptKycRegistryRole(rpc, PIN, createNoopSigner(WALLET));
    expect(parseAcceptKycRegistryAuthorityInstruction(ix as never).accounts.kycRegistry.address).toBe(PIN);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.endsWith(":finalized"))).toBe(true);
    await expect(buildAcceptKycRegistryRole(rpc, PIN, createNoopSigner(SUPER))).rejects.toThrow(/No live proposal/);
    const cancel = await buildCancelKycRegistryProposal(rpc, PIN, createNoopSigner(KYC_KEY));
    expect(parseCancelKycRegistryAuthorityTransferInstruction(cancel as never).accounts.kycRegistry.address).toBe(PIN);
    await expect(buildCancelKycRegistryProposal(rpc, PIN, createNoopSigner(WALLET))).rejects.toThrow(
      /Connect the registry authority/,
    );
    // Stale (the authority moved since): accept refused, cancel allowed.
    w.put(PIN, R, registryBytes(TREASURY));
    await expect(buildAcceptKycRegistryRole(rpc, PIN, createNoopSigner(WALLET))).rejects.toThrow(/No live proposal/);
    await expect(buildCancelKycRegistryProposal(rpc, PIN, createNoopSigner(TREASURY))).resolves.toBeDefined();
  });

  it("buildAcceptPendingRole refuses a blocked row and issuer rows", async () => {
    const rpc = mockRpc(new Map());
    const base = { target: ISSUER, currentAuthority: ISSUER_KEY, proposedBy: ISSUER_KEY, counted: false };
    await expect(
      buildAcceptPendingRole(rpc, { ...base, kind: "issuer", kybStatus: KybStatus.Pending, blocked: null }, createNoopSigner(WALLET)),
    ).rejects.toThrow(/issuer\/rotation/);
    await expect(
      buildAcceptPendingRole(
        rpc,
        { ...base, kind: "issuer", kybStatus: KybStatus.Pending, blocked: ISSUER_ADMIN_KEY_RULE },
        createNoopSigner(WALLET),
      ),
    ).rejects.toThrow(ISSUER_ADMIN_KEY_RULE);
  });
});
