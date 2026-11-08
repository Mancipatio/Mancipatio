// Token migration (V1): which existing tokens a campaign can accept. Pure and
// isomorphic: the admin calculator shows the verdict before a draft is saved
// and the save route re-reads the mint and runs the same verdict on the
// server, so nothing the browser said is trusted.
//
// V1 deposits are plain transfers (TransferChecked) verified from the token
// balances a finalized transaction reports, refunds are plain transfers back
// and the collected tokens are burned by the deposit owner. A mint whose
// rules break any of those is refused, with the reason in plain words:
//   - TransferFeeConfig (and its confidential twin): the deposit account
//     receives less than the holder sent, so no deposit is an exact multiple
//     of the lot and refunds come back short;
//   - TransferHook: another program runs on every transfer and needs extra
//     accounts a plain transfer does not carry (it may also refuse refunds);
//   - NonTransferable: the token cannot be deposited at all;
//   - PermanentDelegate: the delegate can move tokens out of any account,
//     the deposit account included;
//   - ConfidentialTransferMint with auto-approved accounts ("default on"):
//     amounts can move hidden, which the balance check cannot see;
//   - ConfidentialMintBurn: supply changes are hidden too;
//   - DefaultAccountState frozen: the deposit account would start frozen;
//   - Pausable: its authority can stop every transfer and burn, so refunds
//     and the burn could be blocked;
//   - any extension this version does not know (fail closed).
// Metadata, group and close-authority extensions only describe the mint;
// interest-bearing and scaled-UI-amount mints change what wallets DISPLAY,
// not the base units the ratio counts, and are accepted with a warning, as
// are a live freeze authority (it can freeze the deposit account) and a live
// mint authority (the supply can still grow after the snapshot).

import { isSome, type Address } from "@solana/kit";
import { AccountState, type Mint } from "@solana-program/token-2022";
import { classifyMintAccount, type MintAccount } from "@/lib/payment-mints";
import { MAX_OLD_DECIMALS } from "@/lib/token-migration/ratio";
import { TOKEN_PROGRAM_2022, TOKEN_PROGRAM_CLASSIC } from "@/lib/token-migration/model";

export type OldMintRefusal = { extension: string; reason: string };

export type OldMintVerdict = {
  /** True when a campaign can accept this mint. */
  ok: boolean;
  tokenProgram: typeof TOKEN_PROGRAM_CLASSIC | typeof TOKEN_PROGRAM_2022;
  decimals: number;
  supply: bigint;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  /** The mint's extension kinds, as decoded (none for a classic SPL mint). */
  extensions: string[];
  refusals: OldMintRefusal[];
  warnings: string[];
};

const DESCRIPTIVE = new Set([
  "MintCloseAuthority",
  "MetadataPointer",
  "TokenMetadata",
  "GroupPointer",
  "TokenGroup",
  "GroupMemberPointer",
  "TokenGroupMember",
]);

const REFUSED: Record<string, string> = {
  TransferFeeConfig:
    "It charges a transfer fee: the deposit account would receive less than the holder sent, so no deposit could be an exact multiple of the lot, and refunds would come back short.",
  ConfidentialTransferFee:
    "It charges confidential transfer fees: deposits and refunds would not arrive in full.",
  TransferHook:
    "It runs a transfer hook program on every transfer: V1 deposits are plain transfers without the hook's extra accounts, and the hook could refuse refunds.",
  NonTransferable: "It is non-transferable: holders could not deposit it.",
  PermanentDelegate:
    "It has a permanent delegate that can move tokens out of any account, including the deposit account.",
  ConfidentialMintBurn: "It mints and burns confidentially: supply changes would be hidden.",
  PausableConfig:
    "Its pause authority can stop every transfer and burn: refunds and the burn of the collected tokens could be blocked.",
};

/** The mint's verdict from its account (owner program and data), or THROWS when the account is not an initialized mint. */
export function inspectOldMint(account: MintAccount): OldMintVerdict {
  const classified = classifyMintAccount(account, { plainPayment: false });
  return oldMintVerdict(classified.owner, classified.mint);
}

export function oldMintVerdict(owner: Address | string, mint: Mint): OldMintVerdict {
  const tokenProgram = owner === TOKEN_PROGRAM_2022 ? TOKEN_PROGRAM_2022 : TOKEN_PROGRAM_CLASSIC;
  const extensions = isSome(mint.extensions) ? mint.extensions.value : [];
  const refusals: OldMintRefusal[] = [];
  const warnings: string[] = [];
  for (const extension of extensions) {
    const kind = extension.__kind;
    if (DESCRIPTIVE.has(kind)) continue;
    if (kind in REFUSED) {
      refusals.push({ extension: kind, reason: REFUSED[kind] });
      continue;
    }
    if (extension.__kind === "ConfidentialTransferMint") {
      if (extension.autoApproveNewAccounts) {
        refusals.push({
          extension: kind,
          reason: "Confidential transfers are on by default (new accounts are approved automatically): amounts could move hidden, which the deposit check cannot see.",
        });
      } else {
        warnings.push("Confidential transfers exist on this mint, but each account needs its authority's approval; deposits must be plain transfers.");
      }
      continue;
    }
    if (extension.__kind === "DefaultAccountState") {
      if (extension.state === AccountState.Frozen) {
        refusals.push({
          extension: kind,
          reason: "New token accounts start frozen: the deposit account could not receive tokens until the freeze authority thaws it.",
        });
      }
      continue;
    }
    if (kind === "InterestBearingConfig" || kind === "ScaledUiAmountConfig") {
      warnings.push("Wallets show this token with an interest or scaling factor: the lot is counted in raw base units, which may differ from what holders see.");
      continue;
    }
    if (kind === "Uninitialized") continue;
    refusals.push({ extension: kind, reason: `The ${kind} extension is not supported by V1 migrations.` });
  }
  if (mint.decimals > MAX_OLD_DECIMALS) {
    refusals.push({ extension: "decimals", reason: `It has ${mint.decimals} decimals; V1 handles at most ${MAX_OLD_DECIMALS}.` });
  }
  if (mint.supply < BigInt(1)) {
    refusals.push({ extension: "supply", reason: "Its supply is zero: there is nothing to migrate." });
  }
  const freezeAuthority = isSome(mint.freezeAuthority) ? mint.freezeAuthority.value.toString() : null;
  const mintAuthority = isSome(mint.mintAuthority) ? mint.mintAuthority.value.toString() : null;
  if (freezeAuthority) {
    warnings.push(`The freeze authority (${freezeAuthority}) can freeze the deposit account; refunds and the burn would then wait for it to thaw the account.`);
  }
  if (mintAuthority) {
    warnings.push(`The supply can still grow (mint authority ${mintAuthority}): the ratio uses the supply read when the draft is saved, and the units cap does not grow with it.`);
  }
  return {
    ok: refusals.length === 0,
    tokenProgram,
    decimals: mint.decimals,
    supply: mint.supply,
    mintAuthority,
    freezeAuthority,
    extensions: extensions.map((e) => e.__kind),
    refusals,
    warnings,
  };
}
