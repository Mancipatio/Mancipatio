import { describe, it, expect } from "vitest";
import { address } from "@solana/kit";
import {
  AccountState,
  getMintEncoder,
  getMintDecoder,
  type ExtensionArgs,
} from "@solana-program/token-2022";
import { assertVestingMintExtensions } from "@/lib/transaction-builders";
const authority = address("11111111111111111111111111111111");
function mint(extensions: ExtensionArgs[] | null) {
  return getMintDecoder().decode(
    getMintEncoder().encode({
      mintAuthority: authority,
      supply: BigInt(100),
      decimals: 6,
      isInitialized: true,
      freezeAuthority: null,
      extensions,
    }),
  );
}
describe("external vesting mint capabilities", () => {
  it("accepts a plain initialized mint and benign metadata", () => {
    expect(() => assertVestingMintExtensions(mint(null))).not.toThrow();
    expect(() =>
      assertVestingMintExtensions(
        mint([
          { __kind: "MetadataPointer", authority: null, metadataAddress: null },
        ]),
      ),
    ).not.toThrow();
  });
  it("rejects transfer fees even when the currently configured fee is zero", () => {
    const fee = {
      epoch: BigInt(0),
      maximumFee: BigInt(0),
      transferFeeBasisPoints: 0,
    };
    expect(() =>
      assertVestingMintExtensions(
        mint([
          {
            __kind: "TransferFeeConfig",
            transferFeeConfigAuthority: authority,
            withdrawWithheldAuthority: authority,
            withheldAmount: BigInt(0),
            olderTransferFee: fee,
            newerTransferFee: fee,
          },
        ]),
      ),
    ).toThrow(/TransferFeeConfig/);
  });
  it.each<ExtensionArgs>([
    { __kind: "DefaultAccountState", state: AccountState.Initialized },
    { __kind: "DefaultAccountState", state: AccountState.Frozen },
    { __kind: "NonTransferable" },
    { __kind: "PermanentDelegate", delegate: authority },
    { __kind: "TransferHook", authority, programId: authority },
    { __kind: "ConfidentialMintBurn" },
  ])("rejects unsupported transfer behavior: $.__kind", (extension) => {
    expect(() => assertVestingMintExtensions(mint([extension]))).toThrow(
      /does not support/,
    );
  });
});
