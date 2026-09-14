// SERVER-ONLY — the authoritative mint-support gate for vesting requests.
//
// The issuer form runs the same rules while the mint is being typed (F05,
// lib/vesting-mint-preflight.ts), but a request can also be submitted through
// the SIWS API directly, and a Token-2022 mint's extension set or hook
// binding can change between submission and review. Approved terms are
// immutable and an approved request cannot go back to review, so a mint that
// slips past approval can only fail at prepare-creation and force a brand-new
// request. `create` (submission) and `admin-review` (approval) therefore
// re-run the prepare-creation rules here and fail CLOSED: an unsupported mint
// is a 400 naming the concrete reason, an RPC failure is a 503 so the caller
// retries instead of being told the mint is bad.
import { address, isAddress, type Address } from "@solana/kit";
import { fetchVestingMintTokenProgram } from "@/lib/transaction-builders";
import { describeVestingMintError } from "@/lib/vesting-mint-preflight";
import { SiwsError } from "@/lib/server/siws";

type Rpc = Parameters<typeof fetchVestingMintTokenProgram>[0];

export type VestingMintGateStage = "submission" | "approval";

const RPC_TIMEOUT_MS = 12_000;

const RETRY_COPY: Record<VestingMintGateStage, string> = {
  submission: "The request was not submitted; try again once the RPC responds.",
  approval: "The request was not approved; try again once the RPC responds.",
};

/**
 * Resolve the owning token program of `mint` with the exact checks
 * prepare-creation applies (owning program, forbidden Token-2022 extensions,
 * registry hook binding). THROWS SiwsError: 400 when the mint itself is
 * unsupported (a retry cannot change the answer), 503 when the RPC could not
 * answer. Never returns on failure — callers must not persist or approve.
 */
export async function requireSupportedVestingMint(
  rpc: Rpc,
  mint: string,
  stage: VestingMintGateStage,
): Promise<Address> {
  const trimmed = mint.trim();
  if (!isAddress(trimmed))
    throw new SiwsError(400, "token_mint must be a base58 address");
  try {
    return await fetchVestingMintTokenProgram(rpc, address(trimmed), {
      abortSignal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
  } catch (error) {
    const { reason, retryable } = describeVestingMintError(error);
    if (retryable) {
      console.error(
        `[vesting-mint-gate] RPC failure verifying mint at ${stage}:`,
        error,
      );
      throw new SiwsError(
        503,
        `${reason.replace(/\s*Re-check before submitting\.$/, "")} ${RETRY_COPY[stage]}`,
      );
    }
    throw new SiwsError(
      400,
      stage === "approval"
        ? `Cannot approve: ${reason} Send the request back for changes so the client can choose a supported mint.`
        : `Unsupported token mint: ${reason}`,
    );
  }
}
