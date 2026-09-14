// Vesting mint preflight — the same support rules `prepare-creation` applies
// (owning token program, forbidden Token-2022 extensions, hook binding),
// evaluated while the issuer is still typing the mint into the "New vesting
// series" form. Approved terms are immutable and an approved request cannot
// go back to review, so an unsupported mint discovered at creation time
// forces a brand-new request; catching it at input time avoids that.
import { isAddress, type Address } from "@solana/kit";
import {
  TOKEN_2022,
  TOKEN_CLASSIC,
  fetchVestingMintTokenProgram,
} from "@/lib/transaction-builders";

type Rpc = Parameters<typeof fetchVestingMintTokenProgram>[0];

export type VestingMintPreflight =
  | { ok: true; tokenProgram: Address; programLabel: string }
  | { ok: false; reason: string; retryable: boolean };

export function tokenProgramLabel(program: Address): string {
  if (program === TOKEN_CLASSIC) return "Token program";
  if (program === TOKEN_2022) return "Token-2022";
  return program;
}

const NOT_FOUND_RE = /account not found|does not exist|could not find/i;
const TRANSPORT_RE =
  /failed to fetch|networkerror|network request failed|load failed|fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|429|503|timeout/i;

/**
 * Translate a `fetchVestingMintTokenProgram` failure into form copy and say
 * whether a retry could change the answer (RPC trouble) or the mint itself is
 * unsupported (retrying is pointless; a different mint is needed).
 */
export function describeVestingMintError(error: unknown): {
  reason: string;
  retryable: boolean;
} {
  const text =
    error instanceof Error ? error.message : String(error ?? "Unknown error");
  if (NOT_FOUND_RE.test(text))
    return {
      reason:
        "No account exists at this address on the current network. Check the mint address and the network.",
      retryable: false,
    };
  if (/not owned by a supported token program/i.test(text))
    return {
      reason:
        "This account is not a token mint: it is not owned by the Token program or Token-2022.",
      retryable: false,
    };
  if (/not an initialized token mint/i.test(text))
    return {
      reason:
        "This account is not an initialized token mint (token accounts and other data are not accepted).",
      retryable: false,
    };
  if (/does not support the mint extension/i.test(text))
    return {
      reason: `${text.replace(/\s*No escrow should be funded for this mint\.?$/, "")} Vesting cannot escrow this token — choose a mint without that extension.`,
      retryable: false,
    };
  if (/transfer-hook configuration|not bound to this registry/i.test(text))
    return {
      reason: `${text}. Only registry-issued share-class mints may carry a transfer hook.`,
      retryable: false,
    };
  if (error instanceof TypeError || TRANSPORT_RE.test(text))
    return {
      reason: `Could not verify the mint (RPC error: ${text}). Re-check before submitting.`,
      retryable: true,
    };
  return { reason: `Could not verify the mint: ${text}`, retryable: true };
}

/** Input-time check; never throws — the form renders the result inline. */
export async function preflightVestingMint(
  rpc: Rpc,
  mint: string,
): Promise<VestingMintPreflight> {
  const trimmed = mint.trim();
  if (!isAddress(trimmed))
    return {
      ok: false,
      reason: "Token mint must be a base58 address.",
      retryable: false,
    };
  try {
    const tokenProgram = await fetchVestingMintTokenProgram(rpc, trimmed);
    return { ok: true, tokenProgram, programLabel: tokenProgramLabel(tokenProgram) };
  } catch (error) {
    return { ok: false, ...describeVestingMintError(error) };
  }
}
