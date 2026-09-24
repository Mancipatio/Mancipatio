import {
  AccountRole,
  address,
  getBase58Encoder,
  type ReadonlyUint8Array,
} from "@solana/kit";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  BUY_DISCRIMINATOR,
  DEPOSIT_TO_CUSTODY_VAULT_DISCRIMINATOR,
  RETURN_CUSTODY_VAULT_DISCRIMINATOR,
  REALIZE_CUSTODY_VAULT_DISCRIMINATOR,
  parseRealizeCustodyVaultInstruction,
  parseBuyInstruction,
  parseDepositToCustodyVaultInstruction,
  parseReturnCustodyVaultInstruction,
} from "@/lib/generated/asset_registry";
import {
  MEMO_PROGRAM_ADDRESS,
  parseDocumentTermsMemo,
} from "@/lib/document-terms";

export const CLASSIC_TOKEN_PROGRAM =
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
type Index = number | bigint;
export type CompiledChainInstruction = {
  programIdIndex: Index;
  accounts: readonly Index[];
  data: string;
};
type TokenBalance = {
  accountIndex: Index;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string; decimals: number | bigint };
};
export type ChainTransaction = {
  slot: Index;
  /** Unix seconds (json getTransaction); null when the node does not know it. */
  blockTime?: Index | null;
  transaction: {
    signatures: readonly string[];
    message: {
      header: { numRequiredSignatures: Index };
      accountKeys: readonly string[];
      instructions: readonly CompiledChainInstruction[];
    };
  };
  meta: null | {
    err: unknown;
    loadedAddresses?: {
      writable: readonly string[];
      readonly: readonly string[];
    };
    innerInstructions?:
      | readonly {
          index: Index;
          instructions: readonly CompiledChainInstruction[];
        }[]
      | null;
    preTokenBalances?: readonly TokenBalance[] | null;
    postTokenBalances?: readonly TokenBalance[] | null;
    /** Program logs; events (`Program data:`) appear only here. */
    logMessages?: readonly string[] | null;
  };
};

export class ChainEvidenceError extends Error {}
function requireProof(ok: unknown, message: string): asserts ok {
  if (!ok) throw new ChainEvidenceError(message);
}
function index(value: Index, length: number): number {
  const n = Number(value);
  requireProof(
    Number.isSafeInteger(n) && n >= 0 && n < length,
    "Invalid transaction account index",
  );
  return n;
}
function context(tx: ChainTransaction, signature: string) {
  requireProof(
    tx.meta && tx.meta.err === null,
    "Transaction did not complete successfully",
  );
  requireProof(
    tx.transaction.signatures[0] === signature,
    "Transaction signature does not match",
  );
  const keys = [
    ...tx.transaction.message.accountKeys,
    ...(tx.meta.loadedAddresses?.writable ?? []),
    ...(tx.meta.loadedAddresses?.readonly ?? []),
  ];
  const signerCount = Number(
    tx.transaction.message.header.numRequiredSignatures,
  );
  requireProof(
    Number.isSafeInteger(signerCount) &&
      signerCount > 0 &&
      signerCount <= tx.transaction.message.accountKeys.length,
    "Invalid transaction signer metadata",
  );
  const decode = (ix: CompiledChainInstruction) => ({
    programAddress: address(keys[index(ix.programIdIndex, keys.length)]),
    accounts: ix.accounts.map((i) => ({
      address: address(keys[index(i, keys.length)]),
      role: AccountRole.READONLY,
    })),
    data: getBase58Encoder().encode(ix.data),
  });
  return { keys, decode, signers: new Set(keys.slice(0, signerCount)) };
}
function startsWith(
  data: ReadonlyUint8Array,
  discriminator: ReadonlyUint8Array,
) {
  return discriminator.every((b, i) => data[i] === b);
}
function u64(data: ReadonlyUint8Array, offset: number) {
  return new DataView(
    data.buffer,
    data.byteOffset,
    data.byteLength,
  ).getBigUint64(offset, true);
}
function atomicAmount(value: string) {
  requireProof(/^\d+$/.test(value), "Invalid token balance amount");
  return BigInt(value);
}
/** Exact decimal string: do not round financial base units through Number. */
export function tokenDecimal(amount: bigint, decimals: number): string {
  requireProof(
    amount >= BigInt(0) &&
      Number.isInteger(decimals) &&
      decimals >= 0 &&
      decimals <= 18,
    "Unsupported token precision",
  );
  const padded = amount.toString().padStart(decimals + 1, "0");
  return decimals
    ? `${padded.slice(0, -decimals)}.${padded.slice(-decimals)}`
    : padded;
}

export type PurchaseExpectation = {
  buyer: string;
  sale: string;
  shareClass: string;
  asset: string;
  issuer: string;
  mint: string;
  paymentMint: string;
  proceeds: string;
  pricePerUnit: bigint;
};
/** Verify a direct registry buy, its own payment CPI and mint CPI. Unrelated
 * account-key presence or a different successful instruction is never proof.
 * Inner-only/multisig wrapper purchases need a separately reviewed decoder. */
export function purchaseEvidence(
  tx: ChainTransaction,
  signature: string,
  expected: PurchaseExpectation,
  requestedIndex?: number,
) {
  const c = context(tx, signature);
  requireProof(
    c.signers.has(expected.buyer),
    "Buyer did not sign the transaction",
  );
  const buys = tx.transaction.message.instructions.flatMap(
    (raw, instructionIndex) => {
      const ix = c.decode(raw);
      if (
        ix.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS ||
        !startsWith(ix.data, BUY_DISCRIMINATOR)
      )
        return [];
      requireProof(ix.data.length === 16, "Unsupported buy instruction layout");
      const parsed = parseBuyInstruction(ix);
      if (
        parsed.accounts.buyer.address !== expected.buyer ||
        parsed.accounts.sale.address !== expected.sale
      )
        return [];
      if (requestedIndex !== undefined && requestedIndex !== instructionIndex)
        return [];
      return [{ ...parsed, instructionIndex }];
    },
  );
  requireProof(
    buys.length === 1,
    "Expected one matching buy instruction; provide its instruction index when ambiguous",
  );
  const buy = buys[0];
  for (const key of [
    "shareClass",
    "mint",
    "paymentMint",
    "proceeds",
    "asset",
    "issuer",
  ] as const) {
    requireProof(
      buy.accounts[key].address === expected[key],
      `Buy ${key} does not match the sale`,
    );
  }
  requireProof(
    buy.accounts.shareTokenProgram.address === TOKEN_2022_PROGRAM,
    "Unsupported share token program",
  );
  const paymentProgram = buy.accounts.paymentTokenProgram.address;
  requireProof(
    paymentProgram === CLASSIC_TOKEN_PROGRAM ||
      paymentProgram === TOKEN_2022_PROGRAM,
    "Unsupported payment program",
  );
  const units = buy.data.amount;
  const amountAtomic = units * expected.pricePerUnit;
  requireProof(
    units > BigInt(0) &&
      amountAtomic > BigInt(0) &&
      amountAtomic <= BigInt("18446744073709551615"),
    "Invalid purchase amount",
  );
  const inner =
    tx
      .meta!.innerInstructions?.find(
        (group) => Number(group.index) === buy.instructionIndex,
      )
      ?.instructions.map(c.decode) ?? [];
  const payments = inner.filter(
    (ix) =>
      ix.programAddress === paymentProgram &&
      ix.data.length === 10 &&
      ix.data[0] === 12 &&
      ix.accounts[0]?.address === buy.accounts.buyerPaymentAccount.address &&
      ix.accounts[1]?.address === expected.paymentMint &&
      ix.accounts[2]?.address === expected.proceeds &&
      ix.accounts[3]?.address === expected.buyer &&
      u64(ix.data, 1) === amountAtomic,
  );
  requireProof(
    payments.length === 1,
    "Expected payment transfer is not proven",
  );
  const decimals = payments[0].data[9];
  const minted = inner.filter(
    (ix) =>
      ix.programAddress === TOKEN_2022_PROGRAM &&
      ix.data.length === 9 &&
      ix.data[0] === 7 &&
      ix.accounts[0]?.address === expected.mint &&
      ix.accounts[1]?.address === buy.accounts.buyerShareAccount.address &&
      ix.accounts[2]?.address === expected.shareClass &&
      u64(ix.data, 1) === units,
  );
  requireProof(minted.length === 1, "Expected share mint is not proven");
  // A fee-bearing or mixed-flow payment must not be presented as the gross
  // amount raised. Require the exact receipt for the supported direct flow.
  const proceedsIndex = c.keys.indexOf(expected.proceeds);
  const before = tx.meta!.preTokenBalances?.find(
    (b) => Number(b.accountIndex) === proceedsIndex,
  );
  const after = tx.meta!.postTokenBalances?.find(
    (b) => Number(b.accountIndex) === proceedsIndex,
  );
  requireProof(
    before &&
      after &&
      before.mint === expected.paymentMint &&
      after.mint === expected.paymentMint &&
      Number(before.uiTokenAmount.decimals) === decimals &&
      Number(after.uiTokenAmount.decimals) === decimals &&
      atomicAmount(after.uiTokenAmount.amount) -
        atomicAmount(before.uiTokenAmount.amount) ===
        amountAtomic,
    "Exact proceeds receipt is not proven; mixed or fee-bearing payment needs reconciliation",
  );
  const terms = tx.transaction.message.instructions.flatMap(
    (raw, instructionIndex) => {
      const ix = c.decode(raw);
      if (ix.programAddress !== MEMO_PROGRAM_ADDRESS) return [];
      try {
        const parsed = parseDocumentTermsMemo(new Uint8Array(ix.data));
        return parsed ? [{ ...parsed, instructionIndex }] : [];
      } catch {
        return [];
      }
    },
  );
  return {
    instructionIndex: buy.instructionIndex,
    slot: tx.slot.toString(),
    units: units.toString(),
    paymentMint: expected.paymentMint,
    amountAtomic: amountAtomic.toString(),
    decimals,
    amount: tokenDecimal(amountAtomic, decimals),
    ...(terms.length === 1 ? { terms: terms[0] } : {}),
  };
}

export type DepositExpectation = {
  holder: string;
  shareClass: string;
  vault: string;
  mint: string;
  escrow: string;
  amount: bigint;
};
export function custodyReturnEvidence(
  tx: ChainTransaction,
  signature: string,
  expected: DepositExpectation,
) {
  const c = context(tx, signature);
  const returns = tx.transaction.message.instructions.flatMap(
    (raw, instructionIndex) => {
      const ix = c.decode(raw);
      if (
        ix.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS ||
        !startsWith(ix.data, RETURN_CUSTODY_VAULT_DISCRIMINATOR)
      )
        return [];
      requireProof(
        ix.data.length === 8,
        "Unsupported custody return instruction layout",
      );
      const parsed = parseReturnCustodyVaultInstruction(ix);
      if (parsed.accounts.custodyVault.address !== expected.vault) return [];
      return [{ ...parsed, instructionIndex }];
    },
  );
  requireProof(
    returns.length === 1,
    "Expected one matching custody return instruction",
  );
  const returned = returns[0];
  requireProof(
    c.signers.has(returned.accounts.signer.address) &&
      returned.accounts.shareClass.address === expected.shareClass &&
      returned.accounts.mint.address === expected.mint &&
      returned.accounts.escrow.address === expected.escrow &&
      returned.accounts.tokenProgram.address === TOKEN_2022_PROGRAM,
    "Custody return terms do not match the request",
  );
  const transfers =
    tx
      .meta!.innerInstructions?.find(
        (g) => Number(g.index) === returned.instructionIndex,
      )
      ?.instructions.map(c.decode)
      .filter(
        (ix) =>
          ix.programAddress === TOKEN_2022_PROGRAM &&
          ix.data.length === 10 &&
          ix.data[0] === 12 &&
          ix.accounts[0]?.address === expected.escrow &&
          ix.accounts[1]?.address === expected.mint &&
          ix.accounts[2]?.address ===
            returned.accounts.beneficiaryTokenAccount.address &&
          ix.accounts[3]?.address === expected.vault,
      ) ?? [];
  requireProof(
    transfers.length === 1,
    "Expected one return transfer to the holder",
  );
  const amount = u64(transfers[0].data, 1),
    destinationIndex = c.keys.indexOf(
      returned.accounts.beneficiaryTokenAccount.address,
    );
  const before = tx.meta!.preTokenBalances?.find(
    (b) => Number(b.accountIndex) === destinationIndex,
  );
  const after = tx.meta!.postTokenBalances?.find(
    (b) => Number(b.accountIndex) === destinationIndex,
  );
  requireProof(
    expected.amount > BigInt(0) &&
      amount >= expected.amount &&
      after?.owner === expected.holder &&
      after.mint === expected.mint &&
      (!before || before.mint === expected.mint) &&
      atomicAmount(after.uiTokenAmount.amount) -
        atomicAmount(before?.uiTokenAmount.amount ?? "0") ===
        amount,
    "The requested tokens were not proven returned to the holder wallet",
  );
  return {
    instructionIndex: returned.instructionIndex,
    slot: tx.slot.toString(),
    amountAtomic: amount.toString(),
  };
}
export function custodyDepositEvidence(
  tx: ChainTransaction,
  signature: string,
  expected: DepositExpectation,
) {
  const c = context(tx, signature);
  requireProof(
    c.signers.has(expected.holder),
    "Holder did not sign the deposit",
  );
  const deposits = tx.transaction.message.instructions.flatMap(
    (raw, instructionIndex) => {
      const ix = c.decode(raw);
      if (
        ix.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS ||
        !startsWith(ix.data, DEPOSIT_TO_CUSTODY_VAULT_DISCRIMINATOR)
      )
        return [];
      requireProof(
        ix.data.length === 16,
        "Unsupported deposit instruction layout",
      );
      const parsed = parseDepositToCustodyVaultInstruction(ix);
      if (
        parsed.accounts.depositor.address !== expected.holder ||
        parsed.accounts.custodyVault.address !== expected.vault
      )
        return [];
      return [{ ...parsed, instructionIndex }];
    },
  );
  requireProof(
    deposits.length === 1,
    "Expected one matching custody deposit instruction",
  );
  const deposit = deposits[0];
  requireProof(
    deposit.accounts.shareClass.address === expected.shareClass &&
      deposit.accounts.mint.address === expected.mint &&
      deposit.accounts.escrow.address === expected.escrow &&
      deposit.accounts.tokenProgram.address === TOKEN_2022_PROGRAM &&
      deposit.data.amount === expected.amount &&
      expected.amount > BigInt(0),
    "Deposit terms do not match the request",
  );
  return {
    instructionIndex: deposit.instructionIndex,
    slot: tx.slot.toString(),
    amountAtomic: deposit.data.amount.toString(),
  };
}

/** An already-realized vault alone does not prove a supplied receipt. Bind the
 * transaction to this vault and its actual full-escrow burn. */
export function custodyRealizationEvidence(
  tx: ChainTransaction,
  signature: string,
  expected: DepositExpectation,
) {
  const c = context(tx, signature);
  const matches = tx.transaction.message.instructions.flatMap(
    (raw, instructionIndex) => {
      const ix = c.decode(raw);
      if (
        ix.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS ||
        !startsWith(ix.data, REALIZE_CUSTODY_VAULT_DISCRIMINATOR)
      )
        return [];
      requireProof(
        ix.data.length === 8,
        "Unsupported custody realization layout",
      );
      const parsed = parseRealizeCustodyVaultInstruction(ix);
      return parsed.accounts.custodyVault.address === expected.vault
        ? [{ ...parsed, instructionIndex }]
        : [];
    },
  );
  requireProof(
    matches.length === 1,
    "Expected one matching custody realization instruction",
  );
  const realized = matches[0];
  requireProof(
    c.signers.has(realized.accounts.authority.address) &&
      realized.accounts.shareClass.address === expected.shareClass &&
      realized.accounts.mint.address === expected.mint &&
      realized.accounts.escrow.address === expected.escrow &&
      realized.accounts.tokenProgram.address === TOKEN_2022_PROGRAM,
    "Custody realization terms do not match this request",
  );
  const burns =
    tx
      .meta!.innerInstructions?.find(
        (g) => Number(g.index) === realized.instructionIndex,
      )
      ?.instructions.map(c.decode)
      .filter(
        (ix) =>
          ix.programAddress === TOKEN_2022_PROGRAM &&
          ix.data.length === 9 &&
          ix.data[0] === 8 &&
          ix.accounts[0]?.address === expected.escrow &&
          ix.accounts[1]?.address === expected.mint &&
          ix.accounts[2]?.address === expected.vault,
      ) ?? [];
  requireProof(burns.length === 1, "The custody burn is not proven");
  const amount = u64(burns[0].data, 1),
    escrowIndex = c.keys.indexOf(expected.escrow);
  const before = tx.meta!.preTokenBalances?.find(
      (b) => Number(b.accountIndex) === escrowIndex,
    ),
    after = tx.meta!.postTokenBalances?.find(
      (b) => Number(b.accountIndex) === escrowIndex,
    );
  requireProof(
    expected.amount > BigInt(0) &&
      amount >= expected.amount &&
      before?.mint === expected.mint &&
      before.owner === expected.vault &&
      after?.mint === expected.mint &&
      atomicAmount(before.uiTokenAmount.amount) === amount &&
      atomicAmount(after.uiTokenAmount.amount) === BigInt(0),
    "The requested escrow balance was not proven burned",
  );
  return {
    instructionIndex: realized.instructionIndex,
    slot: tx.slot.toString(),
    amountAtomic: amount.toString(),
  };
}
