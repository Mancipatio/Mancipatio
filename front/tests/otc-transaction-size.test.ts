import { describe, expect, it } from "vitest";
import {
  AccountRole,
  address,
  createNoopSigner,
  getBase58Decoder,
  type Address,
} from "@solana/kit";
import { findPlatformPda } from "@/lib/generated/asset_registry";
import {
  getTransferHookConfigEncoder,
  RestrictionMode,
  TRANSFER_HOOK_PROGRAM_ADDRESS,
} from "@/lib/generated/transfer_hook";
import {
  buildDepositOtcAssetInstructions,
  buildTakeOfferInstructions,
} from "@/lib/otc-transactions";
import { vestingTransactionBytes } from "@/lib/vesting-creation";

// The two largest secondary-market wallet transactions, built by the same
// functions the pages call, under the worst case: a KycGated mint (9-account
// hook tails), every idempotent ATA creation, and no address shared between
// the parties. 2A added the read-only Platform PDA (+33 bytes) to both.
const PACKET_LIMIT = 1232;
const key = (n: number) =>
  address(getBase58Decoder().decode(new Uint8Array(32).fill(n)));
const TOKEN_CLASSIC = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;

function rpc(mode: RestrictionMode) {
  return {
    getAccountInfo: () => ({
      send: async () => {
        const data = getTransferHookConfigEncoder().encode({
          mint: key(3),
          shareClass: key(2),
          blocklist: key(9),
          restrictionMode: mode,
          kycRegistry: mode === RestrictionMode.KycGated ? key(10) : null,
          version: 2,
          bump: 1,
        });
        return {
          context: { slot: BigInt(1) },
          value: {
            data: [Buffer.from(data).toString("base64"), "base64"],
            owner: TRANSFER_HOOK_PROGRAM_ADDRESS,
            executable: false,
            lamports: BigInt(1),
            space: BigInt(data.length),
            rentEpoch: BigInt(0),
          },
        };
      },
    }),
  } as unknown as Parameters<typeof buildDepositOtcAssetInstructions>[0];
}

async function expectPlatformGate(
  accounts: readonly { address: Address; role: AccountRole }[],
  index: number,
) {
  const [platform] = await findPlatformPda();
  expect(accounts[index].address).toBe(platform);
  expect(accounts[index].role).toBe(AccountRole.READONLY);
}

describe("OTC wallet transactions stay within one packet", () => {
  it.each([RestrictionMode.Open, RestrictionMode.KycGated])(
    "settling deposit_otc_asset: 2 ATAs + two hook tails (mode %s)",
    async (mode) => {
      const seller = createNoopSigner(key(1));
      const instructions = await buildDepositOtcAssetInstructions(rpc(mode), {
        seller,
        dealPda: key(11),
        deal: {
          mint: key(3),
          buyer: key(12),
          paymentMint: key(4),
          assetEscrow: key(13),
          paymentEscrow: key(14),
        },
        paymentTokenProgram: TOKEN_CLASSIC,
      });
      expect(instructions).toHaveLength(3);
      const deposit = instructions.at(-1)!;
      const tail = mode === RestrictionMode.KycGated ? 9 : 3;
      // 13 named accounts, Platform last, then both equal-length hook tails.
      expect(deposit.accounts).toHaveLength(13 + 2 * tail);
      await expectPlatformGate(deposit.accounts!, 12);
      const bytes = vestingTransactionBytes(instructions, seller);
      expect(bytes).toBeLessThanOrEqual(PACKET_LIMIT);
      if (mode === RestrictionMode.KycGated) expect(bytes).toBeGreaterThan(1000);
    },
  );

  it.each([RestrictionMode.Open, RestrictionMode.KycGated])(
    "take_offer: 3 ATAs + hook tail (mode %s)",
    async (mode) => {
      const taker = createNoopSigner(key(21));
      const instructions = await buildTakeOfferInstructions(rpc(mode), {
        taker,
        offerPda: key(22),
        offer: {
          mint: key(3),
          maker: key(23),
          escrow: key(24),
          paymentMint: key(4),
        },
        paymentTokenProgram: TOKEN_CLASSIC,
      });
      expect(instructions).toHaveLength(4);
      const take = instructions.at(-1)!;
      const tail = mode === RestrictionMode.KycGated ? 9 : 3;
      // 12 named accounts, Platform last, then the release hook tail.
      expect(take.accounts).toHaveLength(12 + tail);
      await expectPlatformGate(take.accounts!, 11);
      expect(vestingTransactionBytes(instructions, taker)).toBeLessThanOrEqual(
        PACKET_LIMIT,
      );
    },
  );
});
