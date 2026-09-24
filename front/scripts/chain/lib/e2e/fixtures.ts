/**
 * Test fixtures the matrix builds for itself (design-6.3 §B): SOL for the
 * ephemeral roles, and a payment mint the run controls. No allowlist or
 * decimals rule stops a plain classic SPL mint on-chain (approve_sale/buy use
 * require_supported_mint), and devnet buyers cannot get Circle USDC.
 */
import type { Address, Instruction, TransactionSigner } from "@solana/kit";
import { getCreateAccountInstruction, getTransferSolInstruction } from "@solana-program/system";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getInitializeMint2Instruction,
  getMintToCheckedInstruction,
} from "@solana-program/token-2022";
import { TOKEN_CLASSIC } from "@/lib/transaction-builders";
import type { ChainRpc } from "../rpc";

export const PAYMENT_DECIMALS = 6;
/** One payment unit (1.000000). */
export const PAYMENT_UNIT = BigInt(10 ** PAYMENT_DECIMALS);
const MINT_SIZE = 82;

export function fundInstructions(from: TransactionSigner, targets: readonly { to: Address; lamports: bigint }[]): Instruction[] {
  return targets.map((t) => getTransferSolInstruction({ source: from, destination: t.to, amount: t.lamports }));
}

/** Tops `to` up to `target` lamports (null when it already holds that much). */
export async function topUp(
  rpc: ChainRpc,
  to: Address,
  target: bigint,
): Promise<{ to: Address; lamports: bigint } | null> {
  const { value } = await rpc.getBalance(to, { commitment: "confirmed" }).send();
  return value >= target ? null : { to, lamports: target - value };
}

export async function createPaymentMintInstructions(input: {
  rpc: ChainRpc;
  payer: TransactionSigner;
  mint: TransactionSigner;
  authority: Address;
}): Promise<Instruction[]> {
  const lamports = await input.rpc.getMinimumBalanceForRentExemption(BigInt(MINT_SIZE)).send();
  return [
    getCreateAccountInstruction({
      payer: input.payer,
      newAccount: input.mint,
      lamports,
      space: MINT_SIZE,
      programAddress: TOKEN_CLASSIC,
    }),
    getInitializeMint2Instruction(
      { mint: input.mint.address, decimals: PAYMENT_DECIMALS, mintAuthority: input.authority, freezeAuthority: null },
      { programAddress: TOKEN_CLASSIC },
    ),
  ];
}

export async function paymentAta(owner: Address, mint: Address): Promise<Address> {
  const [ata] = await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_CLASSIC });
  return ata;
}

/** Creates each owner's payment ATA (idempotent) and mints `amount` to it. */
export async function mintPaymentInstructions(input: {
  payer: TransactionSigner;
  mintAuthority: TransactionSigner;
  mint: Address;
  owners: readonly Address[];
  amount: bigint;
}): Promise<Instruction[]> {
  const out: Instruction[] = [];
  for (const owner of input.owners) {
    out.push(
      await getCreateAssociatedTokenIdempotentInstructionAsync({
        payer: input.payer,
        owner,
        mint: input.mint,
        tokenProgram: TOKEN_CLASSIC,
      }),
      getMintToCheckedInstruction(
        {
          mint: input.mint,
          token: await paymentAta(owner, input.mint),
          mintAuthority: input.mintAuthority,
          amount: input.amount,
          decimals: PAYMENT_DECIMALS,
        },
        { programAddress: TOKEN_CLASSIC },
      ),
    );
  }
  return out;
}

/** Raw token amount of a (classic or Token-2022) token account; 0 when it does not exist. */
export async function tokenBalance(rpc: ChainRpc, account: Address): Promise<bigint> {
  const { value } = await rpc
    .getAccountInfo(account, { encoding: "base64", commitment: "finalized", dataSlice: { offset: 64, length: 8 } })
    .send();
  if (!value) return BigInt(0);
  return Buffer.from(value.data[0], "base64").readBigUInt64LE(0);
}
