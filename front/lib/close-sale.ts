"use client";

// "End and collect" of a Mature sale: close_sale sweeps 100 % of the proceeds
// to a USDC account the sale authority names (close_sale.rs: any token
// account of the payment mint whose owner is not blocklisted; no on-chain fee,
// no refunds), and the sale stops taking buys.
//
// The destination is the issuer authority's own USDC account by default
// (created in the same transaction when missing). Any other account is read
// from chain first — it must be a token account of the sale's payment mint,
// and its owner is shown — and needs the issuer's explicit confirmation in
// the UI (owner decision: proceeds to another account only when confirmed).
//
// One transaction: [sync the sale's issuer key?] [create the issuer's USDC
// account?] close_sale [set_pause_flags(set 0x20 | 0x02?)?]. The re-pause
// rides along when the signer is an Admin (any Admin may set bits): 0x20
// always, 0x02 only when no other sale is Open (lib/public-sale closeFlowStep).
import type { Address, Instruction, TransactionSigner } from "@solana/kit";
import { fetchEncodedAccount } from "@solana/kit";
import { findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstructionAsync, getTokenDecoder } from "@solana-program/token-2022";
import { getSetPauseFlagsInstructionAsync, type Sale } from "@/lib/generated/asset_registry";
import { buildCloseSaleInstruction } from "@/lib/proceeds-exits";
import { syncSaleIfNeeded } from "@/lib/issuer-authority";
import { fetchPlainPaymentMintTokenProgram } from "@/lib/transaction-builders";
import type { Rpc } from "@/lib/tokenize-shares-chain";

export type ProceedsAccount = { tokenAccount: Address; owner: Address };

/**
 * A token account the proceeds may go to: it exists, belongs to the payment
 * mint's token program and holds the sale's payment mint. Returns its owner
 * (shown before the issuer confirms), or the reason it cannot be used.
 */
export async function readProceedsAccount(
  rpc: Rpc,
  tokenAccount: Address,
  sale: Pick<Sale, "paymentMint">,
): Promise<{ account: ProceedsAccount } | { problem: string }> {
  const tokenProgram = await fetchPlainPaymentMintTokenProgram(rpc, sale.paymentMint);
  const raw = await fetchEncodedAccount(rpc, tokenAccount, { commitment: "confirmed" });
  if (!raw.exists) return { problem: "No account at that address. Give a USDC token account (or leave the default)." };
  if (raw.programAddress !== tokenProgram) return { problem: "That address is not a token account of the payment token's program." };
  let decoded;
  try {
    decoded = getTokenDecoder().decode(raw.data);
  } catch {
    return { problem: "That address is not a token account." };
  }
  if (decoded.mint !== sale.paymentMint) return { problem: "That token account holds another token, not the sale's USDC." };
  return { account: { tokenAccount, owner: decoded.owner } };
}

/** The issuer authority's own USDC account for the sale (the default destination). */
export async function defaultProceedsAccount(rpc: Rpc, owner: Address, sale: Pick<Sale, "paymentMint">): Promise<ProceedsAccount & { tokenProgram: Address }> {
  const tokenProgram = await fetchPlainPaymentMintTokenProgram(rpc, sale.paymentMint);
  const [tokenAccount] = await findAssociatedTokenPda({ owner, mint: sale.paymentMint, tokenProgram });
  return { tokenAccount, owner, tokenProgram };
}

export async function buildEndAndCollect(
  rpc: Rpc,
  input: {
    signer: TransactionSigner;
    sale: Pick<Sale, "shareClass" | "proceeds" | "paymentMint" | "authority"> & { address: Address };
    /** null: the signer's own USDC account (created when missing). */
    destination: ProceedsAccount | null;
    /** Bits to set in the same transaction (0: none; the signer must be an Admin otherwise). */
    repause: number;
    /** Copy a rotated issuer key into the sale first (2C-2). */
    syncIssuerKey: boolean;
  },
): Promise<{ instructions: Instruction[]; destination: ProceedsAccount }> {
  const paymentTokenProgram = await fetchPlainPaymentMintTokenProgram(rpc, input.sale.paymentMint);
  const instructions: Instruction[] = [];
  if (input.syncIssuerKey && input.sale.authority !== input.signer.address) {
    instructions.push(
      ...(await syncSaleIfNeeded(rpc, { address: input.sale.address, shareClass: input.sale.shareClass, authority: input.sale.authority })),
    );
  }
  let destination = input.destination;
  if (!destination) {
    const own = await defaultProceedsAccount(rpc, input.signer.address, input.sale);
    destination = { tokenAccount: own.tokenAccount, owner: own.owner };
    instructions.push(
      await getCreateAssociatedTokenIdempotentInstructionAsync({
        payer: input.signer,
        owner: input.signer.address,
        mint: input.sale.paymentMint,
        tokenProgram: paymentTokenProgram,
      }),
    );
  }
  instructions.push(
    await buildCloseSaleInstruction(rpc, {
      authority: input.signer,
      sale: { address: input.sale.address, shareClass: input.sale.shareClass, proceeds: input.sale.proceeds, paymentMint: input.sale.paymentMint },
      destination: destination.tokenAccount,
      destinationOwner: destination.owner,
      paymentTokenProgram,
    }),
  );
  // After the close: close_sale reads 0x20 when it runs; set_pause_flags then sets it (and 0x02) again.
  if (input.repause !== 0) {
    instructions.push(await getSetPauseFlagsInstructionAsync({ authority: input.signer, setMask: input.repause, clearMask: 0 }));
  }
  return { instructions, destination };
}
