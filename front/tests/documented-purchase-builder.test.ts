import { beforeEach, describe, it, expect, vi } from "vitest";
import {
  address,
  createNoopSigner,
  getBase58Decoder,
  type Address,
} from "@solana/kit";
import { getMintEncoder } from "@solana-program/token-2022";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
} from "@solana-program/token-2022";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  KybStatus,
  getBuyInstruction,
  type Sale,
} from "@/lib/generated/asset_registry";
import {
  getTransferHookConfigEncoder,
  RestrictionMode,
  TRANSFER_HOOK_PROGRAM_ADDRESS,
} from "@/lib/generated/transfer_hook";
import {
  buildDocumentedPurchase,
  planDocumentedPurchase,
} from "@/lib/purchase-builder";
import {
  documentTermsMemo,
  type SaleDocumentTerms,
} from "@/lib/document-terms";
import { findSalePda } from "@/lib/pdas";
import { TOKEN_CLASSIC, TOKEN_2022 } from "@/lib/transaction-builders";
const mocks = vi.hoisted(() => ({
  share: null as unknown,
  asset: null as unknown,
  issuer: null as unknown,
}));
vi.mock("@/lib/generated/asset_registry", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchMaybeShareClass: async () => mocks.share,
  fetchMaybeAsset: async () => mocks.asset,
  fetchMaybeIssuer: async () => mocks.issuer,
}));
const key = (n: number) =>
  address(getBase58Decoder().decode(new Uint8Array(32).fill(n)));
const buyer = createNoopSigner(key(1));
const sale = {
  shareClass: key(2),
  mint: key(3),
  paymentMint: key(4),
  saleId: BigInt(1),
  proceeds: key(5),
} as Sale;
let terms: SaleDocumentTerms;
beforeEach(async () => {
  mocks.share = {
    exists: true,
    programAddress: ASSET_REGISTRY_PROGRAM_ADDRESS,
    data: { mint: sale.mint, asset: key(6) },
  };
  mocks.asset = {
    exists: true,
    programAddress: ASSET_REGISTRY_PROGRAM_ADDRESS,
    data: { issuer: key(7) },
  };
  mocks.issuer = {
    exists: true,
    programAddress: ASSET_REGISTRY_PROGRAM_ADDRESS,
    data: { kybStatus: KybStatus.Verified },
  };
  terms = {
    versionId: "10000000-0000-4000-8000-000000000001",
    sha256: "a".repeat(64),
    sale: await findSalePda(sale.shareClass, sale.saleId),
    asset: key(6),
    url: "https://fixture.test/document",
    verifiedAt: "2026-09-07",
  };
});
function rpc(mode: RestrictionMode) {
  return {
    getAccountInfo: (pda: Address) => ({
      send: async () => {
        const payment = pda === sale.paymentMint;
        const data = payment
          ? getMintEncoder().encode({
              mintAuthority: key(8),
              supply: BigInt(10),
              decimals: 6,
              isInitialized: true,
              freezeAuthority: null,
              extensions: null,
            })
          : getTransferHookConfigEncoder().encode({
              mint: sale.mint,
              shareClass: sale.shareClass,
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
            owner: payment ? TOKEN_CLASSIC : TRANSFER_HOOK_PROGRAM_ADDRESS,
            executable: false,
            lamports: BigInt(1),
            space: BigInt(data.length),
            rentEpoch: BigInt(0),
          },
        };
      },
    }),
  } as unknown as Parameters<typeof buildDocumentedPurchase>[0];
}
describe("documented primary purchase wire plan", () => {
  it.each([RestrictionMode.Open, RestrictionMode.KycGated])(
    "uses real two-ATA +118-byte memo + Buy with asset/issuer and receiver proof (mode %s)",
    async (mode) => {
      const result = await buildDocumentedPurchase(rpc(mode), {
        buyer,
        sale,
        amount: BigInt(1),
        terms,
      });
      const instructions = result.purchaseInstructions;
      expect(documentTermsMemo(terms).data).toHaveLength(118);
      expect(result.purchaseBytes).toBeLessThanOrEqual(1232);
      const buy = instructions.at(-1)!;
      expect(buy.accounts![10].address).toBe(key(6));
      expect(buy.accounts![11].address).toBe(key(7));
      expect(buy.accounts).toHaveLength(
        mode === RestrictionMode.KycGated ? 16 : 15,
      );
      const memo = instructions.at(-2)!;
      expect(memo.data).toEqual(documentTermsMemo(terms).data);
    },
  );
  it("keeps document acceptance with the payment when account preparation must be split", async () => {
    const [shareAta] = await findAssociatedTokenPda({
      mint: sale.mint,
      owner: buyer.address,
      tokenProgram: TOKEN_2022,
    });
    const [paymentAta] = await findAssociatedTokenPda({
      mint: sale.paymentMint,
      owner: buyer.address,
      tokenProgram: TOKEN_CLASSIC,
    });
    const buy = getBuyInstruction({
      buyer,
      sale: address(terms.sale),
      shareClass: sale.shareClass,
      mint: sale.mint,
      buyerShareAccount: shareAta,
      buyerPaymentAccount: paymentAta,
      paymentMint: sale.paymentMint,
      proceeds: sale.proceeds,
      shareTokenProgram: TOKEN_2022,
      paymentTokenProgram: TOKEN_CLASSIC,
      asset: key(6),
      issuer: key(7),
      amount: BigInt(1),
    });
    const ata = await getCreateAssociatedTokenIdempotentInstructionAsync({
      payer: buyer,
      owner: buyer.address,
      mint: sale.mint,
      tokenProgram: TOKEN_2022,
    });
    const memo = documentTermsMemo(terms),
      padding = {
        programAddress: key(18),
        accounts: [],
        data: new Uint8Array(700),
      };
    const plan = planDocumentedPurchase([ata, padding], [memo, buy], buyer);
    expect(plan.combinedBytes).toBeGreaterThan(1232);
    expect(plan.preparationInstructions).toEqual([ata, padding]);
    expect(plan.purchaseInstructions).toEqual([memo, buy]);
  });
  it("rejects an unverified issuer and a document for another asset before building a purchase", async () => {
    mocks.issuer = {
      exists: true,
      programAddress: ASSET_REGISTRY_PROGRAM_ADDRESS,
      data: { kybStatus: KybStatus.Rejected },
    };
    await expect(
      buildDocumentedPurchase(rpc(RestrictionMode.Open), {
        buyer,
        sale,
        amount: BigInt(1),
        terms,
      }),
    ).rejects.toThrow(/verified KYB/);
    mocks.issuer = {
      exists: true,
      programAddress: ASSET_REGISTRY_PROGRAM_ADDRESS,
      data: { kybStatus: KybStatus.Verified },
    };
    await expect(
      buildDocumentedPurchase(rpc(RestrictionMode.Open), {
        buyer,
        sale,
        amount: BigInt(1),
        terms: { ...terms, asset: key(20) },
      }),
    ).rejects.toThrow(/document/);
  });
});
