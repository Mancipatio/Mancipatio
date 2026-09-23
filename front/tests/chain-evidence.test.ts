import { describe, expect, it } from "vitest";
import {
  address,
  createNoopSigner,
  getAddressDecoder,
  getBase58Decoder,
  type Instruction,
  type ReadonlyUint8Array,
} from "@solana/kit";
import {
  getBuyInstruction,
  getDepositToCustodyVaultInstruction,
  getReturnCustodyVaultInstruction,
  getRealizeCustodyVaultInstruction,
  ASSET_REGISTRY_PROGRAM_ADDRESS,
} from "@/lib/generated/asset_registry";
import {
  purchaseEvidence,
  custodyDepositEvidence,
  custodyReturnEvidence,
  custodyRealizationEvidence,
  tokenDecimal,
  CLASSIC_TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
  type ChainTransaction,
  type CompiledChainInstruction,
} from "@/lib/chain-evidence";
import { documentTermsMemo, MEMO_PROGRAM_ADDRESS } from "@/lib/document-terms";

const key = (n: number) =>
  getAddressDecoder().decode(new Uint8Array(32).fill(n));
const buyer = key(1),
  sale = key(2),
  shareClass = key(3),
  mint = key(4),
  paymentMint = key(5),
  proceeds = key(6),
  shares = key(7),
  payment = key(8),
  vault = key(9),
  escrow = key(10),
  // Platform PDA stand-in (read-only emergency-pause gate, last named account).
  platform = key(11),
  // DeliveryEscrow realize (2C-3): the pinned KYC registry + the holder's entry.
  kycRegistry = key(12),
  kycEntry = key(13);
const signature = getBase58Decoder().decode(new Uint8Array(64).fill(42));
const expected = {
  buyer,
  sale,
  shareClass,
  asset: shareClass,
  issuer: buyer,
  mint,
  paymentMint,
  proceeds,
  pricePerUnit: BigInt(250000),
};
function tokenData(op: number, amount: bigint, decimals?: number) {
  const data = new Uint8Array(decimals === undefined ? 9 : 10);
  data[0] = op;
  new DataView(data.buffer).setBigUint64(1, amount, true);
  if (decimals !== undefined) data[9] = decimals;
  return data;
}
function fixture() {
  const keys = [
    buyer,
    sale,
    shareClass,
    mint,
    paymentMint,
    proceeds,
    shares,
    payment,
    vault,
    escrow,
    address(ASSET_REGISTRY_PROGRAM_ADDRESS),
    address(CLASSIC_TOKEN_PROGRAM),
    address(TOKEN_2022_PROGRAM),
    platform,
    kycRegistry,
    kycEntry,
  ];
  const compiled = (
    program: string,
    accounts: readonly string[],
    data: ReadonlyUint8Array,
  ): CompiledChainInstruction => ({
    programIdIndex: keys.indexOf(address(program)),
    accounts: accounts.map((a) => keys.indexOf(address(a))),
    data: getBase58Decoder().decode(data),
  });
  const compile = (ix: Instruction) =>
    compiled(
      ix.programAddress,
      ix.accounts!.map((a) => a.address),
      ix.data!,
    );
  const buy = compile(
    getBuyInstruction({
      buyer: createNoopSigner(buyer),
      sale,
      shareClass,
      mint,
      buyerShareAccount: shares,
      buyerPaymentAccount: payment,
      paymentMint,
      proceeds,
      shareTokenProgram: address(TOKEN_2022_PROGRAM),
      paymentTokenProgram: address(CLASSIC_TOKEN_PROGRAM),
      asset: shareClass,
      issuer: buyer,
      platform,
      amount: 3,
    }),
  );
  const tx: ChainTransaction = {
    slot: 123,
    transaction: {
      signatures: [signature],
      message: {
        header: { numRequiredSignatures: 1 },
        accountKeys: keys,
        instructions: [buy],
      },
    },
    meta: {
      err: null,
      innerInstructions: [
        {
          index: 0,
          instructions: [
            compiled(
              CLASSIC_TOKEN_PROGRAM,
              [payment, paymentMint, proceeds, buyer],
              tokenData(12, BigInt(750000), 6),
            ),
            compiled(
              TOKEN_2022_PROGRAM,
              [mint, shares, shareClass],
              tokenData(7, BigInt(3)),
            ),
          ],
        },
      ],
      preTokenBalances: [
        {
          accountIndex: 5,
          mint: paymentMint,
          uiTokenAmount: { amount: "100", decimals: 6 },
        },
      ],
      postTokenBalances: [
        {
          accountIndex: 5,
          mint: paymentMint,
          uiTokenAmount: { amount: "750100", decimals: 6 },
        },
      ],
    },
  };
  return { tx, compiled, compile };
}

describe("custody return transaction evidence", () => {
  it("accepts the exact return instruction and rejects unrelated successful transactions", () => {
    const { tx, compile, compiled } = fixture();
    const expectedReturn = {
      holder: buyer,
      shareClass,
      vault,
      mint,
      escrow,
      amount: BigInt(3),
    };
    expect(() => custodyReturnEvidence(tx, signature, expectedReturn)).toThrow(
      /matching custody return/,
    );
    tx.transaction.message.instructions = [
      compile(
        getReturnCustodyVaultInstruction({
          signer: createNoopSigner(buyer),
          shareClass,
          custodyVault: vault,
          mint,
          escrow,
          beneficiaryTokenAccount: shares,
          escrowMarker: escrow,
          tokenProgram: address(TOKEN_2022_PROGRAM),
          authorityAdminRecord: buyer,
        }),
      ),
    ];
    tx.meta!.innerInstructions = [
      {
        index: 0,
        instructions: [
          compiled(
            TOKEN_2022_PROGRAM,
            [escrow, mint, shares, vault],
            tokenData(12, BigInt(3), 0),
          ),
        ],
      },
    ];
    tx.meta!.preTokenBalances = [
      {
        accountIndex: 6,
        mint,
        owner: buyer,
        uiTokenAmount: { amount: "5", decimals: 0 },
      },
    ];
    tx.meta!.postTokenBalances = [
      {
        accountIndex: 6,
        mint,
        owner: buyer,
        uiTokenAmount: { amount: "8", decimals: 0 },
      },
    ];
    expect(custodyReturnEvidence(tx, signature, expectedReturn)).toEqual({
      instructionIndex: 0,
      slot: "123",
      amountAtomic: "3",
    });
    expect(() =>
      custodyReturnEvidence(tx, signature, {
        ...expectedReturn,
        amount: BigInt(4),
      }),
    ).toThrow(/requested tokens/);
    expect(() =>
      custodyReturnEvidence(tx, signature, {
        ...expectedReturn,
        holder: payment,
      }),
    ).toThrow(/requested tokens/);
    expect(() =>
      custodyReturnEvidence(tx, signature, {
        ...expectedReturn,
        mint: paymentMint,
      }),
    ).toThrow(/terms/);
    tx.meta!.err = { InstructionError: [0, "failed"] };
    expect(() => custodyReturnEvidence(tx, signature, expectedReturn)).toThrow(
      /successfully/,
    );
  });
});

describe("chain-derived purchase evidence", () => {
  it("binds accepted file version and full hash to the actual signed buy transaction", () => {
    const { tx } = fixture();
    const terms = {
      versionId: "10000000-0000-4000-8000-000000000001",
      sha256: "a".repeat(64),
    };
    const memo = documentTermsMemo(terms);
    const programIdIndex = tx.transaction.message.accountKeys.length;
    tx.transaction.message.accountKeys = [
      ...tx.transaction.message.accountKeys,
      MEMO_PROGRAM_ADDRESS,
    ];
    const instruction = {
      programIdIndex,
      accounts: [],
      data: getBase58Decoder().decode(memo.data!),
    };
    tx.transaction.message.instructions = [
      ...tx.transaction.message.instructions,
      instruction,
    ];
    expect(purchaseEvidence(tx, signature, expected).terms).toEqual({
      ...terms,
      instructionIndex: 1,
    });
    tx.transaction.message.instructions = [
      ...tx.transaction.message.instructions,
      instruction,
    ];
    expect(purchaseEvidence(tx, signature, expected).terms).toBeUndefined();
  });
  it("derives exact base units, payment mint, instruction and slot from a successful buy", () => {
    expect(purchaseEvidence(fixture().tx, signature, expected)).toEqual({
      instructionIndex: 0,
      slot: "123",
      units: "3",
      paymentMint,
      amountAtomic: "750000",
      decimals: 6,
      amount: "0.750000",
    });
  });
  it("resolves address lookup table keys in canonical writable/read-only order", () => {
    const { tx } = fixture();
    const keys = [...tx.transaction.message.accountKeys];
    tx.transaction.message.accountKeys = keys.slice(0, 5);
    tx.meta!.loadedAddresses = {
      writable: keys.slice(5, 10),
      readonly: keys.slice(10),
    };
    expect(purchaseEvidence(tx, signature, expected).amountAtomic).toBe(
      "750000",
    );
  });
  it.each([
    "failed",
    "missing-meta",
    "wrong-signature",
    "wrong-program",
    "wrong-instruction",
    "wrong-buyer",
    "wrong-sale",
    "wrong-asset",
    "wrong-issuer",
    "wrong-mint",
    "missing-cpi",
    "wrong-cost",
    "wrong-receiver",
    "fee-receipt",
  ])("rejects %s instead of trusting account-key presence", (kind) => {
    const { tx, compiled } = fixture();
    const target = { ...expected };
    if (kind === "failed") tx.meta!.err = { InstructionError: [0, "failure"] };
    if (kind === "missing-meta") tx.meta = null;
    if (kind === "wrong-program")
      tx.transaction.message.instructions[0].programIdIndex = 11;
    if (kind === "wrong-instruction")
      tx.transaction.message.instructions[0].data = getBase58Decoder().decode(
        new Uint8Array(16),
      );
    if (kind === "wrong-buyer") target.buyer = key(17);
    if (kind === "wrong-sale") target.sale = key(18);
    if (kind === "wrong-asset") target.asset = key(18);
    if (kind === "wrong-issuer") target.issuer = key(18);
    if (kind === "wrong-mint") target.paymentMint = key(19);
    if (kind === "missing-cpi") tx.meta!.innerInstructions = [];
    if (kind === "wrong-cost")
      tx.meta!.innerInstructions![0].instructions = [
        compiled(
          CLASSIC_TOKEN_PROGRAM,
          [payment, paymentMint, proceeds, buyer],
          tokenData(12, BigInt(1), 6),
        ),
      ];
    if (kind === "wrong-receiver")
      tx.meta!.innerInstructions![0].instructions = [
        compiled(
          CLASSIC_TOKEN_PROGRAM,
          [payment, paymentMint, shares, buyer],
          tokenData(12, BigInt(750000), 6),
        ),
      ];
    if (kind === "fee-receipt")
      tx.meta!.postTokenBalances![0].uiTokenAmount.amount = "749100";
    expect(() =>
      purchaseEvidence(
        tx,
        kind === "wrong-signature" ? "different" : signature,
        target,
      ),
    ).toThrow();
  });
  it("does not accept an ambiguous multiple-buy claim", () => {
    const { tx } = fixture();
    tx.transaction.message.instructions = [
      ...tx.transaction.message.instructions,
      tx.transaction.message.instructions[0],
    ];
    expect(() => purchaseEvidence(tx, signature, expected)).toThrow(
      /one matching buy/,
    );
    expect(purchaseEvidence(tx, signature, expected, 0).instructionIndex).toBe(
      0,
    );
  });
  it("still parses a pre-2A buy: 12 named accounts, then the receiver tail", () => {
    // Before the emergency-pause upgrade `buy` had no Platform account, so in
    // historical transactions position 12 holds the first tail account.
    // Evidence must never read accounts.platform.
    const { tx } = fixture();
    const keys = tx.transaction.message.accountKeys;
    const tail = [key(20), key(21), key(22)];
    tx.transaction.message.accountKeys = [...keys, ...tail];
    const [buy] = tx.transaction.message.instructions;
    expect(buy.accounts).toHaveLength(13);
    tx.transaction.message.instructions = [
      {
        ...buy,
        accounts: [
          ...buy.accounts.slice(0, 12),
          ...tail.map((_, i) => keys.length + i),
        ],
      },
    ];
    expect(purchaseEvidence(tx, signature, expected).instructionIndex).toBe(0);
  });
  it("keeps large and fractional atomic values exact", () => {
    expect(tokenDecimal(BigInt("18446744073709551615"), 18)).toBe(
      "18.446744073709551615",
    );
    expect(() => tokenDecimal(BigInt(1), 19)).toThrow(/precision/);
  });
});
describe("custody deposit proof", () => {
  function deposit() {
    const f = fixture();
    f.tx.transaction.message.instructions = [
      f.compile(
        getDepositToCustodyVaultInstruction({
          depositor: createNoopSigner(buyer),
          shareClass,
          custodyVault: vault,
          mint,
          escrow,
          depositorShareAccount: shares,
          tokenProgram: address(TOKEN_2022_PROGRAM),
          platform,
          amount: 5,
        }),
      ),
    ];
    return f.tx;
  }
  const terms = {
    holder: buyer,
    shareClass,
    vault,
    mint,
    escrow,
    amount: BigInt(5),
  };
  it("binds a successful deposit to the holder, vault, mint and exact amount", () => {
    expect(custodyDepositEvidence(deposit(), signature, terms)).toEqual({
      instructionIndex: 0,
      slot: "123",
      amountAtomic: "5",
    });
  });
  it("still parses a pre-2A deposit: 7 named accounts, then the hook tail", () => {
    const tx = deposit();
    const keys = tx.transaction.message.accountKeys;
    const tail = [key(20), key(21), key(22)];
    tx.transaction.message.accountKeys = [...keys, ...tail];
    const [ix] = tx.transaction.message.instructions;
    expect(ix.accounts).toHaveLength(8);
    tx.transaction.message.instructions = [
      {
        ...ix,
        accounts: [
          ...ix.accounts.slice(0, 7),
          ...tail.map((_, i) => keys.length + i),
        ],
      },
    ];
    expect(custodyDepositEvidence(tx, signature, terms).amountAtomic).toBe("5");
  });
  it.each(["holder", "vault", "mint", "escrow", "shareClass"] as const)(
    "rejects another %s",
    (field) => {
      expect(() =>
        custodyDepositEvidence(deposit(), signature, {
          ...terms,
          [field]: key(31),
        }),
      ).toThrow();
    },
  );
  it("rejects a partial deposit and an unrelated successful buy", () => {
    expect(() =>
      custodyDepositEvidence(deposit(), signature, {
        ...terms,
        amount: BigInt(6),
      }),
    ).toThrow();
    expect(() =>
      custodyDepositEvidence(fixture().tx, signature, terms),
    ).toThrow();
  });
});

describe("custody realization transaction evidence", () => {
  function realized() {
    const f = fixture();
    f.tx.transaction.message.instructions = [
      f.compile(
        getRealizeCustodyVaultInstruction({
          authority: createNoopSigner(buyer),
          shareClass,
          custodyVault: vault,
          mint,
          escrow,
          escrowMarker: escrow,
          tokenProgram: address(TOKEN_2022_PROGRAM),
          authorityAdminRecord: buyer,
          kycRegistry,
          kycEntry,
        }),
      ),
    ];
    f.tx.meta!.innerInstructions = [
      {
        index: 0,
        instructions: [
          f.compiled(
            TOKEN_2022_PROGRAM,
            [escrow, mint, vault],
            tokenData(8, BigInt(5)),
          ),
        ],
      },
    ];
    f.tx.meta!.preTokenBalances = [
      {
        accountIndex: 9,
        mint,
        owner: vault,
        uiTokenAmount: { amount: "5", decimals: 0 },
      },
    ];
    f.tx.meta!.postTokenBalances = [
      {
        accountIndex: 9,
        mint,
        owner: vault,
        uiTokenAmount: { amount: "0", decimals: 0 },
      },
    ];
    return f;
  }
  const terms = {
    holder: buyer,
    shareClass,
    vault,
    mint,
    escrow,
    amount: BigInt(3),
  };
  it("binds the exact realization and full escrow burn even with surplus", () => {
    expect(custodyRealizationEvidence(realized().tx, signature, terms)).toEqual(
      { instructionIndex: 0, slot: "123", amountAtomic: "5" },
    );
  });
  it.each([
    "wrong-vault",
    "wrong-mint",
    "missing-burn",
    "partial-burn",
    "nonzero-balance",
    "wrong-owner",
    "unrelated-tx",
  ])("rejects %s", (kind) => {
    const f = realized(),
      expected = { ...terms };
    if (kind === "wrong-vault") expected.vault = sale;
    if (kind === "wrong-mint") expected.mint = paymentMint;
    if (kind === "missing-burn") f.tx.meta!.innerInstructions = [];
    if (kind === "partial-burn")
      f.tx.meta!.innerInstructions![0].instructions = [
        f.compiled(
          TOKEN_2022_PROGRAM,
          [escrow, mint, vault],
          tokenData(8, BigInt(3)),
        ),
      ];
    if (kind === "nonzero-balance")
      f.tx.meta!.postTokenBalances![0].uiTokenAmount.amount = "2";
    if (kind === "wrong-owner") f.tx.meta!.preTokenBalances![0].owner = buyer;
    expect(() =>
      custodyRealizationEvidence(
        kind === "unrelated-tx" ? fixture().tx : f.tx,
        signature,
        expected,
      ),
    ).toThrow();
  });
});
