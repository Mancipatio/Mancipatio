// lib/hook-metas.ts — the receiver-KYC proof tails `buy` must carry.
//
// Why this suite exists: the on-chain gate
// (asset_registry util.rs require_receiver_kyc_for_mint_to) resolves the tail
// BY RE-DERIVED PDA KEY and is fail-closed — a tail with the wrong seed, the
// wrong program id or a missing account fails with KycProofRequired (6077) or
// ReceiverNotApproved, and `npx tsc` cannot see any of it (every address is
// just a string). So the expected addresses below are derived INDEPENDENTLY
// from the literal seeds and program ids the programs use; if lib/pdas.ts or
// the generated client ever changes one, these tests fail instead of the
// buy button.
import { describe, expect, it } from "vitest";

import {
  AccountRole,
  getAddressEncoder,
  getProgramDerivedAddress,
  type Address,
} from "@solana/kit";
import { hookTransferMetas, kycReceiverMetas, openKycReceiverTail } from "@/lib/hook-metas";
import {
  findConfigPda,
  findExtraAccountMetaListPda,
  getTransferHookConfigEncoder,
  RestrictionMode,
} from "@/lib/generated/transfer_hook";
import { ASSET_REGISTRY_PROGRAM_ADDRESS } from "@/lib/generated/asset_registry";

// Program ids as the deployed programs know them (pinned, not imported).
const HOOK_PROGRAM = "GBDyesyTr266LqKeFq95r1DeigRyHpfw6ACWdjENHAPy" as Address;
const REGISTRY_PROGRAM =
  "FJs1EM1ND89L9sUXaS8VBKYXjmoXCkkVSJKRE19hmYxS" as Address;

const RECEIVER = "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2" as Address;
const SHARE_CLASS = "5MZBGE68wKvzAiRnh9BLcxWzWZ9EGDgvS39mgLDLKTsy" as Address;
const BLOCKLIST = "3n1mQ6zsrVpQyzFCkr9qFVGgU3qHiHQeAvGtaVJk9oNr" as Address;
const KYC_REGISTRY = "9V6dJcVh4Zq8bqXjbHZ8YbtcEQTP6NrbXKzmZ9pQxTaG" as Address;

// Distinct mints per test — hook-metas caches the config per mint for 30s.
const MINT_NO_CONFIG = "8sHgqRqBEXaSkhcyzXtY3vBSfGqBbTeR2SkVFDcxrfd9" as Address;
const MINT_OPEN = "6D6TgUKrYY6dJrCUZ6LcJKt5EGGdCUgHtVeUKmRZbUJ2" as Address;
const MINT_GATED = "4KcVAsHCdcCPpDxYPHV7ZLcTU1sfKZBLZTz3H1B5mMhx" as Address;

const addr = getAddressEncoder();
const seed = (s: string) => new TextEncoder().encode(s);

async function pda(
  programAddress: Address,
  seeds: (Uint8Array | ReadonlyUint8ArrayLike)[],
): Promise<Address> {
  const [value] = await getProgramDerivedAddress({
    programAddress,
    seeds: seeds as Uint8Array[],
  });
  return value;
}

type ReadonlyUint8ArrayLike = ReturnType<typeof addr.encode>;

/** transfer_hook `["blocked", wallet]`. */
const blockEntryPda = (wallet: Address) =>
  pda(HOOK_PROGRAM, [seed("blocked"), addr.encode(wallet)]);
/** transfer_hook `["extra-account-metas", mint]` (Token-2022 convention). */
const extraMetasPda = (mint: Address) =>
  pda(HOOK_PROGRAM, [seed("extra-account-metas"), addr.encode(mint)]);
/** transfer_hook `["hook_cfg", mint]`. */
const configPda = (mint: Address) =>
  pda(HOOK_PROGRAM, [seed("hook_cfg"), addr.encode(mint)]);
/** asset_registry `["kyc", registry, holder]`. */
const kycEntryPda = (registry: Address, holder: Address) =>
  pda(REGISTRY_PROGRAM, [
    seed("kyc"),
    addr.encode(registry),
    addr.encode(holder),
  ]);

/** Encoded TransferHookConfig account bytes for the stub RPC. */
function encodeConfig(
  mint: Address,
  mode: RestrictionMode,
  kycRegistry: Address | null,
): Uint8Array {
  return new Uint8Array(
    getTransferHookConfigEncoder().encode({
      mint,
      shareClass: SHARE_CLASS,
      blocklist: BLOCKLIST,
      restrictionMode: mode,
      kycRegistry: kycRegistry
        ? { __option: "Some", value: kycRegistry }
        : { __option: "None" },
      version: 1,
      bump: 254,
    }),
  );
}

/** Minimal getAccountInfo stub in the shape @solana/kit's fetcher expects. */
function stubRpc(accounts: Record<string, Uint8Array>) {
  const rpc = {
    getAccountInfo: (address: Address) => ({
      send: async () => {
        const data = accounts[address.toString()];
        return {
          // BigInt literals are not available at this tsconfig target — the
          // shape is what matters, not the numeric literal syntax.
          context: { slot: BigInt(1) },
          value: data
            ? {
                data: [Buffer.from(data).toString("base64"), "base64"],
                executable: false,
                lamports: BigInt(1_000_000),
                owner: HOOK_PROGRAM,
                rentEpoch: BigInt(0),
                space: BigInt(data.length),
              }
            : null,
        };
      },
    }),
  };
  return rpc as unknown as Parameters<typeof kycReceiverMetas>[0];
}

describe("openKycReceiverTail", () => {
  it("is the 3-account Open proof tail, read-only, in hook order", async () => {
    const tail = await openKycReceiverTail(MINT_OPEN, RECEIVER);
    expect(tail).toHaveLength(3);
    expect(tail.map((m) => m.role)).toEqual([
      AccountRole.READONLY,
      AccountRole.READONLY,
      AccountRole.READONLY,
    ]);
    expect(tail.map((m) => m.address)).toEqual([
      await blockEntryPda(RECEIVER),
      await extraMetasPda(MINT_OPEN),
      HOOK_PROGRAM,
    ]);
  });

  it("carries the ExtraAccountMetaList — the account that PROVES Open mode", async () => {
    // require_receiver_kyc_for_mint_to falls back to this PDA when no config
    // is in the tail; without it every Open-mint buy fails with 6077.
    const tail = await openKycReceiverTail(MINT_OPEN, RECEIVER);
    expect(tail.map((m) => m.address)).toContain(
      await extraMetasPda(MINT_OPEN),
    );
  });

  it("keys the BlockEntry on the receiver (a mint_to has no source)", async () => {
    const other = SHARE_CLASS; // any other wallet
    const mine = await openKycReceiverTail(MINT_OPEN, RECEIVER);
    const theirs = await openKycReceiverTail(MINT_OPEN, other);
    expect(mine[0].address).not.toEqual(theirs[0].address);
    expect(theirs[0].address).toEqual(await blockEntryPda(other));
  });
});

describe("PDA seeds the tails depend on", () => {
  it("matches the generated client's derivations (seed drift guard)", async () => {
    const [generatedConfig] = await findConfigPda({ mint: MINT_GATED });
    expect(generatedConfig).toEqual(await configPda(MINT_GATED));
    const [generatedMetas] = await findExtraAccountMetaListPda({
      mint: MINT_GATED,
    });
    expect(generatedMetas).toEqual(await extraMetasPda(MINT_GATED));
  });
});

describe("owner-based transfer tails", () => {
  it("keeps the source-owner blocklist when an ordinary delegate signs an Open transfer", async () => {
    const tail = await hookTransferMetas(stubRpc({}), MINT_OPEN, {
      sourceTokenAccount: MINT_NO_CONFIG, destTokenAccount: MINT_GATED,
      sourceOwner: RECEIVER, transferAuthority: SHARE_CLASS, destOwner: BLOCKLIST,
    });
    expect(tail.map((meta) => meta.address)).toEqual([
      await blockEntryPda(RECEIVER), await extraMetasPda(MINT_OPEN), HOOK_PROGRAM,
    ]);
    expect(tail[0].address).not.toBe(await blockEntryPda(SHARE_CLASS));
  });

  it("does not reuse a mint's cached Open mode for another RPC/cluster", async () => {
    const cfg = await configPda(MINT_OPEN);
    const accounts = {
      sourceTokenAccount: MINT_NO_CONFIG, destTokenAccount: MINT_GATED,
      sourceOwner: RECEIVER, transferAuthority: RECEIVER, destOwner: BLOCKLIST,
    };
    const open = await hookTransferMetas(stubRpc({}), MINT_OPEN, accounts);
    const gated = await hookTransferMetas(stubRpc({
      [cfg]: encodeConfig(MINT_OPEN, RestrictionMode.KycGated, KYC_REGISTRY),
    }), MINT_OPEN, accounts);
    expect(open).toHaveLength(3);
    expect(gated).toHaveLength(9);
    expect(gated[2].address).toBe(KYC_REGISTRY);
    expect(gated[4].address).toBe(await kycEntryPda(KYC_REGISTRY, BLOCKLIST));
  });
});

describe("kycReceiverMetas", () => {
  it("NEVER returns an empty tail — an unconfigured mint gets the Open proof", async () => {
    const rpc = stubRpc({});
    const tail = await kycReceiverMetas(rpc, MINT_NO_CONFIG, RECEIVER);
    expect(tail).toHaveLength(3);
    expect(tail.map((m) => m.address)).toEqual([
      await blockEntryPda(RECEIVER),
      await extraMetasPda(MINT_NO_CONFIG),
      HOOK_PROGRAM,
    ]);
  });

  it("returns the Open proof tail for an Open-mode config", async () => {
    const cfg = await configPda(MINT_OPEN);
    const rpc = stubRpc({
      [cfg.toString()]: encodeConfig(MINT_OPEN, RestrictionMode.Open, null),
    });
    const tail = await kycReceiverMetas(rpc, MINT_OPEN, RECEIVER);
    expect(tail.map((m) => m.address)).toEqual([
      await blockEntryPda(RECEIVER),
      await extraMetasPda(MINT_OPEN),
      HOOK_PROGRAM,
    ]);
  });

  it("returns config + registry + program + KycEntry for a KycGated mint", async () => {
    const cfg = await configPda(MINT_GATED);
    const rpc = stubRpc({
      [cfg.toString()]: encodeConfig(
        MINT_GATED,
        RestrictionMode.KycGated,
        KYC_REGISTRY,
      ),
    });
    const tail = await kycReceiverMetas(rpc, MINT_GATED, RECEIVER);
    // Exactly the four accounts receiver_kyc_outcome resolves for KycGated.
    expect(tail).toHaveLength(4);
    expect(tail.map((m) => m.address)).toEqual([
      cfg,
      KYC_REGISTRY,
      ASSET_REGISTRY_PROGRAM_ADDRESS,
      await kycEntryPda(KYC_REGISTRY, RECEIVER),
    ]);
    expect(tail.every((m) => m.role === AccountRole.READONLY)).toBe(true);
    // The generated program id must stay the one the KycEntry seeds use.
    expect(ASSET_REGISTRY_PROGRAM_ADDRESS).toEqual(REGISTRY_PROGRAM);
  });

  it("throws for a KycGated config with no registry (never a silent Open tail)", async () => {
    const gatedNoRegistry =
      "2ScpXtNvTr5vC4bLcxfnB2gnPYxnJqDBDx5EotdcnZ8v" as Address;
    const cfg = await configPda(gatedNoRegistry);
    const rpc = stubRpc({
      [cfg.toString()]: encodeConfig(
        gatedNoRegistry,
        RestrictionMode.KycGated,
        null,
      ),
    });
    await expect(
      kycReceiverMetas(rpc, gatedNoRegistry, RECEIVER),
    ).rejects.toThrow(/no KYC registry/i);
  });
});
