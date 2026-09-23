import { describe, expect, it } from "vitest";
import {
  createNoopSigner,
  getAddressEncoder,
  getProgramDerivedAddress,
  type Address,
} from "@solana/kit";
import { getMintEncoder } from "@solana-program/token-2022";
import {
  buildBlocklistClawbackInstruction,
  buildClawbackInstruction,
  buildCreateVestingSeriesInstruction,
  buildUpdateMintMetadataInstruction,
  fetchMintTokenProgram,
  TOKEN_2022,
  TOKEN_CLASSIC,
} from "@/lib/transaction-builders";
import {
  parseClawbackBlocklistedHolderInstruction,
  parseClawbackFromHolderInstruction,
  parseCreateVestingSeriesInstruction,
  parseUpdateMintMetadataInstruction,
  VestingDeliveryMode,
  VestingTimingMode,
} from "@/lib/generated/asset_registry";
import {
  findConfigPda,
  getTransferHookConfigEncoder,
  RestrictionMode,
} from "@/lib/generated/transfer_hook";

const HOLDER = "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2" as Address;
const SHARE_CLASS = "5MZBGE68wKvzAiRnh9BLcxWzWZ9EGDgvS39mgLDLKTsy" as Address;
const MINT = "8sHgqRqBEXaSkhcyzXtY3vBSfGqBbTeR2SkVFDcxrfd9" as Address;
const VAULT = "6D6TgUKrYY6dJrCUZ6LcJKt5EGGdCUgHtVeUKmRZbUJ2" as Address;
const REGISTRY = "9V6dJcVh4Zq8bqXjbHZ8YbtcEQTP6NrbXKzmZ9pQxTaG" as Address;
const REGISTRY_PROGRAM =
  "FJs1EM1ND89L9sUXaS8VBKYXjmoXCkkVSJKRE19hmYxS" as Address;
const HOOK_PROGRAM = "GBDyesyTr266LqKeFq95r1DeigRyHpfw6ACWdjENHAPy" as Address;
const SYSTEM = "11111111111111111111111111111111" as Address;
const signer = createNoopSigner(HOLDER);

type Rpc = Parameters<typeof fetchMintTokenProgram>[0];
function rpcFor(
  accounts: Record<string, { owner: Address; data: Uint8Array }>,
): Rpc {
  return {
    getAccountInfo: (address: Address) => ({
      send: async () => {
        const account = accounts[address];
        return {
          context: { slot: BigInt(1) },
          value: account
            ? {
                data: [Buffer.from(account.data).toString("base64"), "base64"],
                owner: account.owner,
                executable: false,
                lamports: BigInt(1),
                space: BigInt(account.data.length),
                rentEpoch: BigInt(0),
              }
            : null,
        };
      },
    }),
  } as unknown as Rpc;
}
function mintData(initialized = true): Uint8Array {
  return new Uint8Array(
    getMintEncoder().encode({
      mintAuthority: HOLDER,
      supply: BigInt(0),
      decimals: 6,
      isInitialized: initialized,
      freezeAuthority: null,
      extensions: null,
    }),
  );
}
async function pda(program: Address, label: string, ...owners: Address[]) {
  return (
    await getProgramDerivedAddress({
      programAddress: program,
      seeds: [
        new TextEncoder().encode(label),
        ...owners.map((owner) => getAddressEncoder().encode(owner)),
      ],
    })
  )[0];
}

describe("builders used by the issuer/admin pages", () => {
  it.each([TOKEN_CLASSIC, TOKEN_2022])(
    "creates vesting with the mint's actual program %s",
    async (owner) => {
      const rpc = rpcFor({ [MINT]: { owner, data: mintData() } });
      const ix = await buildCreateVestingSeriesInstruction(rpc, {
        authority: signer,
        tokenMint: MINT,
        seriesId: BigInt(7),
        tranches: [{ unlockTs: BigInt(2_000_000_000), amount: BigInt(100) }],
        timingMode: VestingTimingMode.Auto,
        deliveryMode: VestingDeliveryMode.Claim,
        approvalWindowSecs: BigInt(0),
        recoveryEnabled: false,
        cancellationEnabled: false,
        preCliffBps: 0,
      });
      const parsed = parseCreateVestingSeriesInstruction(ix);
      expect(parsed.accounts.tokenProgram.address).toBe(owner);
      expect(parsed.data.seriesId).toBe(BigInt(7));
      expect(parsed.accounts.authority.address).toBe(HOLDER);
    },
  );

  it("fails closed for missing, foreign, uninitialized or non-mint accounts", async () => {
    for (const rpc of [
      rpcFor({}),
      rpcFor({ [MINT]: { owner: SYSTEM, data: mintData() } }),
      rpcFor({ [MINT]: { owner: TOKEN_CLASSIC, data: mintData(false) } }),
      rpcFor({ [MINT]: { owner: TOKEN_2022, data: new Uint8Array(165) } }),
    ]) {
      await expect(fetchMintTokenProgram(rpc, MINT)).rejects.toThrow();
    }
  });

  it("does not substitute a token program after an RPC failure", async () => {
    const rpc = {
      getAccountInfo: () => ({
        send: async () => {
          throw new Error("offline");
        },
      }),
    } as unknown as Rpc;
    await expect(fetchMintTokenProgram(rpc, MINT)).rejects.toThrow("offline");
  });

  it("uses Token-2022 for the actual metadata instruction", () => {
    const ix = buildUpdateMintMetadataInstruction({
      authority: signer,
      adminRecord: REGISTRY,
      issuer: HOLDER,
      asset: VAULT,
      shareClass: SHARE_CLASS,
      mint: MINT,
      field: "uri",
      value: "https://example.com/metadata.json",
    });
    const parsed = parseUpdateMintMetadataInstruction(ix);
    expect(parsed.accounts.tokenProgram.address).toBe(TOKEN_2022);
    expect(parsed.data.value).toBe("https://example.com/metadata.json");
  });

  it("builds a permanent-delegate clawback with holder-owned BlockEntry and marker", async () => {
    const [config] = await findConfigPda({ mint: MINT });
    const rpc = rpcFor({
      [config]: {
        owner: HOOK_PROGRAM,
        data: new Uint8Array(
          getTransferHookConfigEncoder().encode({
            mint: MINT,
            shareClass: SHARE_CLASS,
            blocklist: REGISTRY,
            restrictionMode: RestrictionMode.KycGated,
            kycRegistry: REGISTRY,
            version: 1,
            bump: 254,
          }),
        ),
      },
    });
    const ix = await buildClawbackInstruction(rpc, {
      authority: signer,
      shareClass: SHARE_CLASS,
      mint: MINT,
      holderShareAccount: HOLDER,
      destination: VAULT,
      custodyVault: VAULT,
      kycRegistry: REGISTRY,
      holder: HOLDER,
      amount: BigInt(10),
    });
    const parsed = parseClawbackFromHolderInstruction(ix);
    expect(parsed.accounts.tokenProgram.address).toBe(TOKEN_2022);
    const tail = ix.accounts.slice(-9);
    expect(tail[0].address).toBe(await pda(HOOK_PROGRAM, "blocked", HOLDER));
    expect(tail[0].address).not.toBe(
      await pda(HOOK_PROGRAM, "blocked", SHARE_CLASS),
    );
    expect(tail[5].address).toBe(
      await pda(REGISTRY_PROGRAM, "escrow_marker", VAULT),
    );
    expect(tail[6].address).toBe(
      await pda(REGISTRY_PROGRAM, "escrow_marker", HOLDER),
    );
    expect(tail[8].address).toBe(HOOK_PROGRAM);
  });

  const hookConfig = (restrictionMode: RestrictionMode) =>
    new Uint8Array(
      getTransferHookConfigEncoder().encode({
        mint: MINT,
        shareClass: SHARE_CLASS,
        blocklist: REGISTRY,
        restrictionMode,
        kycRegistry: restrictionMode === RestrictionMode.KycGated ? REGISTRY : null,
        version: 1,
        bump: 254,
      }),
    );
  const blocklistInput = {
    authority: signer,
    shareClass: SHARE_CLASS,
    mint: MINT,
    holderShareAccount: HOLDER,
    destination: VAULT,
    custodyVault: VAULT,
    holder: HOLDER,
    amount: BigInt(0),
  };

  it("builds a blocklist clawback on an Open mint with the 3-account Open tail", async () => {
    const [config] = await findConfigPda({ mint: MINT });
    const rpc = rpcFor({
      [config]: { owner: HOOK_PROGRAM, data: hookConfig(RestrictionMode.Open) },
    });
    const ix = await buildBlocklistClawbackInstruction(rpc, blocklistInput);
    const parsed = parseClawbackBlocklistedHolderInstruction({
      ...ix,
      accounts: ix.accounts.slice(0, 11),
    });
    expect(parsed.accounts.tokenProgram.address).toBe(TOKEN_2022);
    expect(parsed.accounts.blockEntry.address).toBe(
      await pda(HOOK_PROGRAM, "blocked", HOLDER),
    );
    expect(parsed.accounts.hookConfig.address).toBe(config);
    expect(parsed.accounts.holderEscrowMarker.address).toBe(
      await pda(REGISTRY_PROGRAM, "escrow_marker", HOLDER),
    );
    expect(parsed.data.holder).toBe(HOLDER);
    expect(ix.accounts).toHaveLength(11 + 3);
    const tail = ix.accounts.slice(-3);
    expect(tail.map((a) => a.address)).toEqual([
      await pda(HOOK_PROGRAM, "blocked", HOLDER),
      await pda(HOOK_PROGRAM, "extra-account-metas", MINT),
      HOOK_PROGRAM,
    ]);
    // Keyed on the holder (source owner), never on the ShareClass authority.
    expect(tail[0].address).not.toBe(
      await pda(HOOK_PROGRAM, "blocked", SHARE_CLASS),
    );
  });

  it("builds a blocklist clawback on a KycGated mint with the 9-account tail", async () => {
    const [config] = await findConfigPda({ mint: MINT });
    const rpc = rpcFor({
      [config]: {
        owner: HOOK_PROGRAM,
        data: hookConfig(RestrictionMode.KycGated),
      },
    });
    const ix = await buildBlocklistClawbackInstruction(rpc, blocklistInput);
    expect(ix.accounts).toHaveLength(11 + 9);
    const tail = ix.accounts.slice(-9);
    expect(tail[0].address).toBe(await pda(HOOK_PROGRAM, "blocked", HOLDER));
    expect(tail[1].address).toBe(config);
    expect(tail[2].address).toBe(REGISTRY);
    expect(tail[4].address).toBe(
      await pda(REGISTRY_PROGRAM, "kyc", REGISTRY, VAULT),
    );
    expect(tail[5].address).toBe(
      await pda(REGISTRY_PROGRAM, "escrow_marker", VAULT),
    );
    expect(tail[6].address).toBe(
      await pda(REGISTRY_PROGRAM, "escrow_marker", HOLDER),
    );
    expect(tail[8].address).toBe(HOOK_PROGRAM);
  });

  it("refuses a blocklist clawback when the mint has no hook config", async () => {
    await expect(
      buildBlocklistClawbackInstruction(rpcFor({}), blocklistInput),
    ).rejects.toThrow(/no transfer-hook config/);
  });
});
