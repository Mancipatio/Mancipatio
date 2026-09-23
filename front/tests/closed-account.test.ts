import { describe, expect, it } from "vitest";
import { getAddressDecoder, type Address } from "@solana/kit";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  fetchMaybeCustodyVault,
  getCustodyVaultEncoder,
  RealizeAction,
  VaultState,
  VaultType,
} from "@/lib/generated/asset_registry";
import {
  CLOSED_ACCOUNT_TAG,
  fetchMaybeLiveCustodyVault,
  isClosedAccount,
} from "@/lib/closed-account";

const key = (n: number) => getAddressDecoder().decode(new Uint8Array(32).fill(n));

function rpcWith(accounts: Map<string, { owner: string; data: Uint8Array }>) {
  return {
    getAccountInfo: (addr: string) => ({
      send: async () => {
        const hit = accounts.get(addr);
        return {
          context: { slot: BigInt(1) },
          value: hit
            ? {
                data: [Buffer.from(hit.data).toString("base64"), "base64"],
                executable: false,
                lamports: BigInt(1),
                owner: hit.owner,
                rentEpoch: BigInt(0),
                space: BigInt(hit.data.length),
              }
            : null,
        };
      },
    }),
  } as unknown as Parameters<typeof fetchMaybeLiveCustodyVault>[0];
}

describe("2D tombstone (CLOSED_ACCOUNT_TAG)", () => {
  it("pins the same 8 bytes as the program constant", () => {
    expect(Array.from(CLOSED_ACCOUNT_TAG)).toEqual([67, 76, 79, 83, 69, 68, 95, 95]);
    expect(new TextDecoder().decode(CLOSED_ACCOUNT_TAG)).toBe("CLOSED__");
  });

  it("recognises only a registry-owned, exactly-8-byte tag", () => {
    expect(isClosedAccount(ASSET_REGISTRY_PROGRAM_ADDRESS, CLOSED_ACCOUNT_TAG)).toBe(true);
    expect(isClosedAccount(key(9), CLOSED_ACCOUNT_TAG)).toBe(false);
    expect(
      isClosedAccount(ASSET_REGISTRY_PROGRAM_ADDRESS, new Uint8Array([...CLOSED_ACCOUNT_TAG, 0])),
    ).toBe(false);
    expect(isClosedAccount(ASSET_REGISTRY_PROGRAM_ADDRESS, new Uint8Array(8))).toBe(false);
    expect(isClosedAccount(ASSET_REGISTRY_PROGRAM_ADDRESS, null)).toBe(false);
  });

  it("fetchMaybeLiveCustodyVault separates live, tombstoned and missing vaults", async () => {
    const live = key(1) as Address;
    const tombstone = key(2) as Address;
    const missing = key(3) as Address;
    const vault = new Uint8Array(
      getCustodyVaultEncoder().encode({
        shareClass: key(4), mint: key(5), escrow: key(6), vaultId: BigInt(7), authority: key(8),
        vaultType: VaultType.DeliveryEscrow, realizeAction: RealizeAction.BurnAndAttest,
        amount: BigInt(5), state: VaultState.Realized, deadline: BigInt(0),
        metadataHash: new Uint8Array(32), beneficiary: key(9), version: 2, bump: 255,
        deposited: BigInt(0), kycRegistry: key(10),
      }),
    );
    const rpc = rpcWith(
      new Map([
        [live, { owner: ASSET_REGISTRY_PROGRAM_ADDRESS, data: vault }],
        [tombstone, { owner: ASSET_REGISTRY_PROGRAM_ADDRESS, data: CLOSED_ACCOUNT_TAG }],
      ]),
    );
    const a = await fetchMaybeLiveCustodyVault(rpc, live);
    expect(a.exists && a.data.state).toBe(VaultState.Realized);
    expect(a.closed).toBe(false);
    expect(await fetchMaybeLiveCustodyVault(rpc, tombstone)).toEqual({
      address: tombstone,
      exists: false,
      closed: true,
    });
    expect(await fetchMaybeLiveCustodyVault(rpc, missing)).toEqual({
      address: missing,
      exists: false,
      closed: false,
    });
    // Why the wrapper exists: Codama's fetch throws on the 8-byte tombstone.
    await expect(fetchMaybeCustodyVault(rpc, tombstone)).rejects.toThrow();
  });
});
