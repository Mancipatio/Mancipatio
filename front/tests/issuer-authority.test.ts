// Issuer authority rotation, timelocked recovery and sale / payout sync
// (program 2C-2): the pure helpers, the builders' account lists, the GPA
// filters, the sync selection and bundling, and the transaction-error hints.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  address,
  generateKeyPairSigner,
  getAddressEncoder,
  getBase58Decoder,
  getProgramDerivedAddress,
  type Address,
} from "@solana/kit";

const mocks = vi.hoisted(() => ({ fetchEncodedAccount: vi.fn() }));
vi.mock("@solana/kit", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchEncodedAccount: mocks.fetchEncodedAccount,
}));

import {
  ASSET_REGISTRY_ERROR__INVALID_ISSUER_RECOVERY,
  ASSET_REGISTRY_ERROR__ISSUER_RECOVERY_EXPIRED,
  ASSET_REGISTRY_ERROR__ISSUER_RECOVERY_TIMELOCK_ACTIVE,
  ASSET_REGISTRY_ERROR__NOT_FOUNDER,
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  getAuthorityTransferDiscriminatorBytes,
  getAuthorityTransferEncoder,
  getIssuerDiscriminatorBytes,
  getIssuerRecoveryDiscriminatorBytes,
  getIssuerRecoveryEncoder,
  getSyncPayoutFounderDiscriminatorBytes,
  getSyncSaleAuthorityDiscriminatorBytes,
  SaleStatus,
} from "@/lib/generated/asset_registry";
import {
  buildAcceptIssuerAuthority,
  buildCancelIssuerAuthorityTransfer,
  buildCancelIssuerRecovery,
  buildExecuteIssuerRecovery,
  buildProposeIssuerAuthority,
  buildProposeIssuerRecovery,
  bundleWithSync,
  collectIssuerSyncTargets,
  describeRecoveryState,
  findIssuerRecoveryPda,
  findIssuerTransferPda,
  findPendingForWallet,
  formatCountdown,
  formatUtc,
  issuerAuthorityActions,
  issuerRecoveryState,
  issuerSyncInstructions,
  issuerTransferState,
  issuerVaultsFor,
  ISSUER_RECOVERY_DELAY_SECONDS,
  ISSUER_RECOVERY_WINDOW_SECONDS,
  NEW_AUTHORITY_OFFSET,
  pendingForWalletFilters,
  proposedIssuerAuthorityError,
  transactionSize,
  waitForIndexedAuthority,
  type IssuerRecoveryRecord,
  type PendingIssuerTransfer,
} from "@/lib/issuer-authority";
import { findIssuerPermissionsAddress } from "@/lib/issuer-permissions";
import { explainSendError, SALE_AUTHORITY_HINT } from "@/lib/tx-error";
import { findAssetPda, findPlatformPda } from "@/lib/generated/asset_registry";
import { findSalePda, findShareClassPda } from "@/lib/pdas";

const ISSUER = address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const A = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const B = address("SysvarC1ock11111111111111111111111111111111");
const ADMIN = address("SysvarRent111111111111111111111111111111111");
const STRANGER = address("Vote111111111111111111111111111111111111111");

async function randomAddress(): Promise<Address> {
  return (await generateKeyPairSigner()).address;
}

describe("proposedIssuerAuthorityError", () => {
  it("mirrors validate_new_authority and refuses another issuer's key", () => {
    expect(proposedIssuerAuthorityError("", A)).toBeNull();
    expect(proposedIssuerAuthorityError("not-a-key", A)).toMatch(/valid Solana address/);
    expect(proposedIssuerAuthorityError("11111111111111111111111111111111", A)).toMatch(/default/);
    expect(proposedIssuerAuthorityError(` ${A} `, A)).toMatch(/already the issuer authority/);
    expect(proposedIssuerAuthorityError(B, A, [STRANGER, B])).toMatch(/another issuer/);
    expect(proposedIssuerAuthorityError(B, A, [STRANGER])).toBeNull();
  });
});

describe("issuerTransferState", () => {
  const pending = (over: Partial<PendingIssuerTransfer> = {}): PendingIssuerTransfer => ({
    target: ISSUER,
    currentAuthority: A,
    newAuthority: B,
    proposedBy: A,
    ...over,
  });
  it("is live only when staged by the live authority for this issuer", () => {
    expect(issuerTransferState(ISSUER, A, null)).toEqual({ kind: "none" });
    expect(issuerTransferState(ISSUER, A, pending({ target: STRANGER }))).toEqual({ kind: "none" });
    expect(issuerTransferState(ISSUER, A, pending())).toEqual({ kind: "live", newAuthority: B });
    // A recovery moved the key since: accept would fail.
    expect(issuerTransferState(ISSUER, STRANGER, pending())).toEqual({ kind: "stale", newAuthority: B });
    expect(issuerTransferState(ISSUER, A, pending({ proposedBy: STRANGER }))).toEqual({ kind: "stale", newAuthority: B });
  });
});

describe("issuerRecoveryState", () => {
  const eta = 1_000_000;
  const recovery: IssuerRecoveryRecord = {
    issuer: ISSUER,
    currentAuthority: A,
    newAuthority: B,
    proposedBy: ADMIN,
    proposedAt: eta - ISSUER_RECOVERY_DELAY_SECONDS,
    eta,
    expiresAt: eta + ISSUER_RECOVERY_WINDOW_SECONDS,
  };
  const issuer = { address: ISSUER, authority: A };

  it("counts down to eta, then to expiry, then expires", () => {
    expect(issuerRecoveryState(null, issuer, ADMIN, eta)).toEqual({ kind: "none" });
    expect(issuerRecoveryState({ ...recovery, issuer: STRANGER }, issuer, ADMIN, eta).kind).toBe("none");
    expect(issuerRecoveryState(recovery, issuer, ADMIN, eta - 1)).toMatchObject({ kind: "waiting", remaining: 1 });
    expect(issuerRecoveryState(recovery, issuer, ADMIN, eta)).toMatchObject({
      kind: "executable",
      remaining: ISSUER_RECOVERY_WINDOW_SECONDS,
      until: recovery.expiresAt,
    });
    expect(issuerRecoveryState(recovery, issuer, ADMIN, recovery.expiresAt - 1)).toMatchObject({
      kind: "executable",
      remaining: 1,
    });
    expect(issuerRecoveryState(recovery, issuer, ADMIN, recovery.expiresAt).kind).toBe("expired");
  });

  it("goes stale when the issuer key or the super admin changed", () => {
    expect(issuerRecoveryState(recovery, { address: ISSUER, authority: STRANGER }, ADMIN, eta).kind).toBe(
      "stale-authority",
    );
    expect(issuerRecoveryState(recovery, issuer, STRANGER, eta).kind).toBe("stale-admin");
  });

  it("describes each state", () => {
    expect(describeRecoveryState({ kind: "none" })).toMatch(/No recovery/);
    expect(describeRecoveryState(issuerRecoveryState(recovery, issuer, ADMIN, eta - 90))).toMatch(/1m 30s/);
    expect(describeRecoveryState(issuerRecoveryState(recovery, issuer, STRANGER, eta))).toMatch(/Super Admin changed/);
    expect(describeRecoveryState(issuerRecoveryState(recovery, issuer, ADMIN, recovery.expiresAt))).toMatch(/Expired/);
  });
});

describe("issuerAuthorityActions", () => {
  const live = { kind: "live", newAuthority: B } as const;
  const executable = {
    kind: "executable",
    newAuthority: B,
    proposedBy: ADMIN,
    eta: 1,
    until: 2,
    remaining: 1,
  } as const;
  const waiting = { ...executable, kind: "waiting", expiresAt: 2 } as const;
  const ctx = { issuerAuthority: A, platformAdmin: ADMIN, transfer: live, recovery: executable };

  it("gives each role exactly its on-chain rights", () => {
    expect(issuerAuthorityActions(A, ctx)).toEqual({
      canPropose: true,
      canCancelTransfer: true,
      canAccept: false,
      canProposeRecovery: false,
      canCancelRecovery: true,
      canExecuteRecovery: false,
    });
    expect(issuerAuthorityActions(B, ctx)).toEqual({
      canPropose: false,
      canCancelTransfer: false,
      canAccept: true,
      canProposeRecovery: false,
      canCancelRecovery: false,
      canExecuteRecovery: true,
    });
    expect(issuerAuthorityActions(ADMIN, ctx)).toEqual({
      canPropose: false,
      canCancelTransfer: false,
      canAccept: false,
      canProposeRecovery: true,
      canCancelRecovery: true,
      canExecuteRecovery: false,
    });
    expect(Object.values(issuerAuthorityActions(STRANGER, ctx)).some(Boolean)).toBe(false);
    expect(Object.values(issuerAuthorityActions(null, ctx)).some(Boolean)).toBe(false);
  });

  it("never offers execute inside the timelock or accept of a stale proposal", () => {
    expect(issuerAuthorityActions(B, { ...ctx, recovery: waiting }).canExecuteRecovery).toBe(false);
    expect(
      issuerAuthorityActions(B, { ...ctx, transfer: { kind: "stale", newAuthority: B } }).canAccept,
    ).toBe(false);
    expect(issuerAuthorityActions(A, { ...ctx, transfer: { kind: "none" } }).canCancelTransfer).toBe(false);
  });
});

describe("formatting", () => {
  it("formats countdowns and UTC times", () => {
    expect(formatCountdown(0)).toBe("now");
    expect(formatCountdown(-5)).toBe("now");
    expect(formatCountdown(45)).toBe("45s");
    expect(formatCountdown(65)).toBe("1m 05s");
    expect(formatCountdown(3_720)).toBe("1h 02m");
    expect(formatCountdown(ISSUER_RECOVERY_DELAY_SECONDS - 60)).toBe("6d 23h 59m");
    expect(formatUtc(0)).toBe("1970-01-01 00:00 UTC");
  });
});

describe("builders", () => {
  it("accept derives the old grant from the live authority and the new one from the signer", async () => {
    const signer = await generateKeyPairSigner();
    const ix = await buildAcceptIssuerAuthority({ newAuthoritySigner: signer, issuer: ISSUER, currentAuthority: A });
    expect(ix.accounts.map((a) => a.address)).toEqual([
      signer.address,
      ISSUER,
      await findIssuerTransferPda(ISSUER),
      await findIssuerPermissionsAddress(ISSUER, A),
      await findIssuerPermissionsAddress(ISSUER, signer.address),
      "11111111111111111111111111111111",
    ]);
  });

  it("propose / cancel use the issuer-seeded transfer PDA", async () => {
    const signer = await generateKeyPairSigner();
    const [transfer] = await getProgramDerivedAddress({
      programAddress: ASSET_REGISTRY_PROGRAM_ADDRESS,
      seeds: [new TextEncoder().encode("authority_transfer"), getAddressEncoder().encode(ISSUER)],
    });
    expect(await findIssuerTransferPda(ISSUER)).toBe(transfer);
    const propose = await buildProposeIssuerAuthority({ authoritySigner: signer, issuer: ISSUER, newAuthority: B });
    expect(propose.accounts.map((a) => a.address).slice(0, 3)).toEqual([signer.address, ISSUER, transfer]);
    const cancel = await buildCancelIssuerAuthorityTransfer({ authoritySigner: signer, issuer: ISSUER });
    expect(cancel.accounts.map((a) => a.address)).toEqual([signer.address, ISSUER, transfer]);
  });

  it("recovery builders pin the recovery PDA, the platform and the proposer", async () => {
    const signer = await generateKeyPairSigner();
    const [recovery] = await getProgramDerivedAddress({
      programAddress: ASSET_REGISTRY_PROGRAM_ADDRESS,
      seeds: [new TextEncoder().encode("issuer_recovery"), getAddressEncoder().encode(ISSUER)],
    });
    expect(await findIssuerRecoveryPda(ISSUER)).toBe(recovery);
    const [platform] = await findPlatformPda();
    const propose = await buildProposeIssuerRecovery({ superAdminSigner: signer, issuer: ISSUER, newAuthority: B });
    expect(propose.accounts.map((a) => a.address).slice(0, 4)).toEqual([signer.address, platform, ISSUER, recovery]);
    const cancel = await buildCancelIssuerRecovery({ cancellerSigner: signer, issuer: ISSUER, proposer: ADMIN });
    expect(cancel.accounts.map((a) => a.address)).toEqual([signer.address, platform, ISSUER, recovery, ADMIN]);
    const execute = await buildExecuteIssuerRecovery({
      newAuthoritySigner: signer,
      issuer: ISSUER,
      currentAuthority: A,
      proposer: ADMIN,
    });
    expect(execute.accounts.map((a) => a.address)).toEqual([
      signer.address,
      platform,
      ISSUER,
      recovery,
      ADMIN,
      await findIssuerPermissionsAddress(ISSUER, A),
      await findIssuerPermissionsAddress(ISSUER, signer.address),
    ]);
  });
});

describe("sync selection and bundling", () => {
  it("builds syncs only for out-of-sync sales and vaults", async () => {
    const [sale1, sale2, vault1, vault2, sc, asset] = await Promise.all(
      Array.from({ length: 6 }, () => randomAddress()),
    );
    const ixs = issuerSyncInstructions({
      issuer: ISSUER,
      issuerAuthority: B,
      sales: [
        { address: sale1, shareClass: sc, asset, authority: A },
        { address: sale2, shareClass: sc, asset, authority: B },
      ],
      vaults: [
        { address: vault1, shareClass: sc, asset, founder: B },
        { address: vault2, shareClass: sc, asset, founder: A },
      ],
    });
    expect(ixs).toHaveLength(2);
    expect(Array.from(ixs[0].data!.slice(0, 8))).toEqual(Array.from(getSyncSaleAuthorityDiscriminatorBytes()));
    expect(ixs[0].accounts!.map((a) => a.address)).toEqual([sale1, sc, asset, ISSUER]);
    expect(Array.from(ixs[1].data!.slice(0, 8))).toEqual(Array.from(getSyncPayoutFounderDiscriminatorBytes()));
    expect(ixs[1].accounts!.map((a) => a.address)).toEqual([vault2, sc, asset, ISSUER]);
    expect(issuerSyncInstructions({ issuer: ISSUER, issuerAuthority: A, sales: [], vaults: [] })).toEqual([]);
  });

  async function manySyncs(n: number) {
    const out = [];
    for (let i = 0; i < n; i++) {
      const [vault, sc, asset] = await Promise.all([randomAddress(), randomAddress(), randomAddress()]);
      out.push({ address: vault, shareClass: sc, asset, founder: A });
    }
    return issuerSyncInstructions({ issuer: ISSUER, issuerAuthority: B, vaults: out });
  }

  it("keeps the primary first and splits the syncs under the packet limit", async () => {
    const signer = await generateKeyPairSigner();
    const primary = await buildAcceptIssuerAuthority({ newAuthoritySigner: signer, issuer: ISSUER, currentAuthority: A });
    const syncs = await manySyncs(12);
    const txs = bundleWithSync([primary], syncs, { feePayer: signer.address, order: "primary-first" });
    expect(txs.length).toBeGreaterThan(1);
    expect(txs[0][0]).toBe(primary);
    expect(txs.flat()).toEqual([primary, ...syncs]);
    for (const t of txs) expect(transactionSize(signer.address, t)).toBeLessThanOrEqual(1232);
    // A handful fits atomically with the accept.
    const few = syncs.slice(0, 3);
    expect(bundleWithSync([primary], few, { feePayer: signer.address, order: "primary-first" })).toEqual([
      [primary, ...few],
    ]);
  });

  it("puts the primary last after the syncs it must follow", async () => {
    const signer = await generateKeyPairSigner();
    const primary = await buildCancelIssuerAuthorityTransfer({ authoritySigner: signer, issuer: ISSUER });
    const syncs = await manySyncs(12);
    const txs = bundleWithSync([primary], syncs, { feePayer: signer.address, order: "sync-first" });
    expect(txs.length).toBeGreaterThan(1);
    const last = txs[txs.length - 1];
    expect(last[last.length - 1]).toBe(primary);
    expect(txs.flat()).toEqual([...syncs, primary]);
    for (const t of txs) expect(transactionSize(signer.address, t)).toBeLessThanOrEqual(1232);
    expect(bundleWithSync([primary], [], { feePayer: signer.address, order: "sync-first" })).toEqual([[primary]]);
  });

  it("collects the issuer's open sales and every vault of its share classes", async () => {
    const [assetPda] = await findAssetPda({ issuer: ISSUER, assetId: "a-1" });
    const scPda = await findShareClassPda(assetPda, 0);
    const other = await randomAddress();
    const data = {
      assets: [{ issuer: ISSUER, assetId: "a-1" }, { issuer: STRANGER, assetId: "b-1" }],
      shareClasses: [{ asset: assetPda, classIndex: 0 }],
      legacyShareClasses: [],
      sales: [
        { shareClass: scPda, saleId: BigInt(1), status: SaleStatus.Open, authority: A },
        { shareClass: scPda, saleId: BigInt(2), status: SaleStatus.Closed, authority: A },
        { shareClass: other, saleId: BigInt(3), status: SaleStatus.Open, authority: A },
      ],
    } as unknown as Parameters<typeof collectIssuerSyncTargets>[0];
    const vaultAddress = await randomAddress();
    const targets = await collectIssuerSyncTargets(
      data,
      [
        { address: vaultAddress, vault: { shareClass: scPda, founder: A } },
        { address: await randomAddress(), vault: { shareClass: other, founder: A } },
      ],
      ISSUER,
    );
    expect(targets.sales).toEqual([
      { address: await findSalePda(scPda, BigInt(1)), shareClass: scPda, asset: assetPda, authority: A },
    ]);
    expect(targets.vaults).toEqual([{ address: vaultAddress, shareClass: scPda, asset: assetPda, founder: A }]);
  });

  it("shows the new key its issuer's unsynced vaults, flagged", () => {
    const records = [
      { vault: { founder: B, shareClass: "sc-mine" } },
      { vault: { founder: A, shareClass: "sc-mine" } },
      { vault: { founder: A, shareClass: "sc-other" } },
    ];
    const issuerOf = (sc: string) => (sc === "sc-mine" ? "issuer-mine" : "issuer-other");
    const view = issuerVaultsFor(records, { wallet: B, issuer: "issuer-mine", issuerOfShareClass: issuerOf, rotation: true });
    expect(view.map((v) => [v.record, v.founderOutOfSync])).toEqual([
      [records[0], false],
      [records[1], true],
    ]);
    const off = issuerVaultsFor(records, { wallet: B, issuer: "issuer-mine", issuerOfShareClass: issuerOf, rotation: false });
    expect(off.map((v) => v.record)).toEqual([records[0]]);
  });
});

describe("chain readers", () => {
  beforeEach(() => mocks.fetchEncodedAccount.mockReset());

  it("filters both account types by discriminator and new_authority at byte 72", () => {
    const disc = getIssuerRecoveryDiscriminatorBytes();
    const filters = pendingForWalletFilters(disc, B);
    expect(NEW_AUTHORITY_OFFSET).toBe(72);
    expect(filters[0].memcmp).toMatchObject({ offset: BigInt(0), bytes: getBase58Decoder().decode(disc) });
    expect(filters[1].memcmp).toMatchObject({ offset: BigInt(72), bytes: B });
    // Both layouts put new_authority at byte 72.
    const recovery = getIssuerRecoveryEncoder().encode({
      issuer: ISSUER,
      currentAuthority: A,
      newAuthority: B,
      proposedBy: ADMIN,
      proposedAt: BigInt(1),
      eta: BigInt(2),
      expiresAt: BigInt(3),
      version: 1,
      bump: 255,
    });
    const transfer = getAuthorityTransferEncoder().encode({
      target: ISSUER,
      currentAuthority: A,
      newAuthority: B,
      proposedBy: A,
      bump: 255,
    });
    const b = getAddressEncoder().encode(B);
    expect(Array.from(recovery.slice(72, 104))).toEqual(Array.from(b));
    expect(Array.from(transfer.slice(72, 104))).toEqual(Array.from(b));
    expect(recovery.length).toBe(162);
  });

  it("finds rotations and recoveries staged for a wallet, issuers only", async () => {
    const platformTarget = await randomAddress();
    const recoveryPda = await findIssuerRecoveryPda(ISSUER);
    const encode64 = (bytes: ArrayLike<number>) => btoa(String.fromCharCode(...Array.from(bytes)));
    const issuerTransfer = getAuthorityTransferEncoder().encode({
      target: ISSUER,
      currentAuthority: A,
      newAuthority: B,
      proposedBy: A,
      bump: 255,
    });
    const platformTransfer = getAuthorityTransferEncoder().encode({
      target: platformTarget,
      currentAuthority: A,
      newAuthority: B,
      proposedBy: A,
      bump: 255,
    });
    const recovery = getIssuerRecoveryEncoder().encode({
      issuer: ISSUER,
      currentAuthority: A,
      newAuthority: B,
      proposedBy: ADMIN,
      proposedAt: BigInt(10),
      eta: BigInt(20),
      expiresAt: BigInt(30),
      version: 1,
      bump: 255,
    });
    const owner = ASSET_REGISTRY_PROGRAM_ADDRESS;
    const transferDisc = getBase58Decoder().decode(getAuthorityTransferDiscriminatorBytes());
    const calls: unknown[] = [];
    const rpc = {
      getProgramAccounts: (_program: string, config: { filters: { memcmp: { bytes: string } }[] }) => ({
        send: async () => {
          calls.push(config.filters);
          return config.filters[0].memcmp.bytes === transferDisc
            ? [
                { pubkey: await randomAddress(), account: { owner, data: [encode64(issuerTransfer), "base64"] } },
                { pubkey: await randomAddress(), account: { owner, data: [encode64(platformTransfer), "base64"] } },
              ]
            : [{ pubkey: recoveryPda, account: { owner, data: [encode64(recovery), "base64"] } }];
        },
      }),
    };
    mocks.fetchEncodedAccount.mockImplementation(async (_rpc: unknown, target: string) =>
      target === ISSUER
        ? { exists: true, programAddress: owner, data: new Uint8Array([...getIssuerDiscriminatorBytes(), ...new Uint8Array(109)]) }
        : { exists: true, programAddress: owner, data: new Uint8Array(85) },
    );
    const found = await findPendingForWallet(rpc as never, B);
    expect(calls).toHaveLength(2);
    expect(found.transfers).toEqual([
      { issuer: ISSUER, transfer: { target: ISSUER, currentAuthority: A, newAuthority: B, proposedBy: A } },
    ]);
    expect(found.recoveries).toEqual([
      {
        issuer: ISSUER,
        recovery: {
          issuer: ISSUER,
          currentAuthority: A,
          newAuthority: B,
          proposedBy: ADMIN,
          proposedAt: 10,
          eta: 20,
          expiresAt: 30,
        },
      },
    ]);
  });

  it("waits for the indexer to name the new key", async () => {
    const reads = ["old", null, "new"];
    const sleep = vi.fn(async () => undefined);
    await expect(waitForIndexedAuthority(async () => reads.shift() ?? null, "new", { sleep })).resolves.toBe(true);
    expect(sleep).toHaveBeenCalledTimes(2);
    const failing = vi.fn(async () => {
      throw new Error("down");
    });
    await expect(waitForIndexedAuthority(failing, "new", { attempts: 3, sleep })).resolves.toBe(false);
    expect(failing).toHaveBeenCalledTimes(3);
  });
});

describe("transaction-error hints (2C-2)", () => {
  const withLogs = (logs: string[]) =>
    Object.assign(new Error("Transaction simulation failed"), { context: { logs } });
  const code = (n: number) => `Program x failed: custom program error: 0x${n.toString(16)}`;

  it("explains the recovery errors 0x17f3-0x17f5 and the NotFounder sync hint", () => {
    expect(ASSET_REGISTRY_ERROR__ISSUER_RECOVERY_TIMELOCK_ACTIVE).toBe(6131);
    expect(ASSET_REGISTRY_ERROR__ISSUER_RECOVERY_EXPIRED).toBe(6132);
    expect(ASSET_REGISTRY_ERROR__INVALID_ISSUER_RECOVERY).toBe(6133);
    expect(explainSendError(withLogs(["Program x failed: custom program error: 0x17f3"]))).toMatch(/7-day waiting period/);
    expect(explainSendError(withLogs(["Program x failed: custom program error: 0x17f4"]))).toMatch(/14-day window/);
    expect(explainSendError(withLogs(["Program x failed: custom program error: 0x17f5"]))).toMatch(/InvalidIssuerRecovery/);
    expect(explainSendError(withLogs([code(ASSET_REGISTRY_ERROR__NOT_FOUNDER)]))).toMatch(/sync the payout vault first/);
  });

  it("points a sale authority mismatch at the sync", () => {
    expect(
      explainSendError(
        withLogs([
          "Program log: AnchorError caused by account: sale. Error Code: Unauthorized. Error Number: 6001. Error Message: Unauthorized.",
        ]),
      ),
    ).toBe(SALE_AUTHORITY_HINT);
  });
});
