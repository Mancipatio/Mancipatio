// `claim_vested` (Claim mode, signed by the recipient) and `push_vested`
// (Push mode, anyone pays), v1.0.0-rc: both name the recipient's hook
// blocklist entry ["blocked", position.wallet] after `token_program` and
// before the hook tail (a blocked recipient refuses the release, 6144). The
// tail (escrow owned by the series PDA → the recipient) is appended by the
// caller when the mint carries the Manci hook.
import type { Address, TransactionSigner } from "@solana/kit";
import {
  getClaimVestedInstruction,
  getPushVestedInstruction,
} from "@/lib/generated/asset_registry";
import { findBlockEntryPda } from "@/lib/pdas";

export async function buildVestingReleaseInstruction(input: {
  mode: "claim" | "push";
  /** The recipient (claim) or any fee payer (push). */
  signer: TransactionSigner;
  series: Address;
  position: Address;
  positionIndex: number;
  /** `position.wallet`: the recipient the program pays and screens. */
  recipient: Address;
  tokenMint: Address;
  escrow: Address;
  recipientTokenAccount: Address;
  tokenProgram: Address;
}) {
  const recipientBlockEntry = await findBlockEntryPda(input.recipient);
  const common = {
    series: input.series,
    position: input.position,
    tokenMint: input.tokenMint,
    escrow: input.escrow,
    recipientTokenAccount: input.recipientTokenAccount,
    tokenProgram: input.tokenProgram,
    recipientBlockEntry,
    positionIndex: input.positionIndex,
  };
  return input.mode === "push"
    ? getPushVestedInstruction({ payer: input.signer, ...common })
    : getClaimVestedInstruction({ recipient: input.signer, ...common });
}
