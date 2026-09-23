// Live-chain preflight for closing a revoked passport (2D, the KycEntry arm of
// `reclaim_rent`). The chain only enforces `Revoked && expiry <= now`; this
// check refuses the close while the holder still has something a clawback or
// a KYC-gated exit would need the entry for. It reads the chain, never the
// Supabase mirrors (candidates from the mirrors are re-read live here).
//
// After a close, `clawback_from_holder` needs the one-transaction recovery
// (approve with a one-second expiry + revoke + clawback) or the blocklist path.
import {
  fetchEncodedAccount,
  type Address,
} from "@solana/kit";
import {
  type CustodyVault,
  decodeOffer,
  fetchMaybeKycEntry,
  findKycEntryPda,
  KycStatus,
  OfferStatus,
  OtcDealStatus,
  VaultState,
  VaultType,
  type OtcDeal,
} from "@/lib/generated/asset_registry";
import {
  fetchMaybeTransferHookConfig,
  findConfigPda,
  RestrictionMode,
} from "@/lib/generated/transfer_hook";
import { fetchMaybeLiveCustodyVault, isClosedAccount } from "@/lib/closed-account";
import type { SolanaClient } from "@solana/client";

type Rpc = SolanaClient["runtime"]["rpc"];

const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" as Address;

export type ClosePassportCheck = {
  closable: boolean;
  /** Unix seconds from which the on-chain gate opens (the entry's expiry). */
  closableAt: bigint | null;
  blockers: string[];
};

export type ClosePassportCandidates = {
  /** Custody vaults that may name the holder as beneficiary (e.g. mirror rows). */
  vaults: readonly Address[];
  /** Offers that may be the holder's (e.g. mirror rows). */
  offers: readonly Address[];
  /** OTC deals, already read live (lib/otc `loadOtcDeals`). */
  deals: readonly { pda: Address; deal: Pick<OtcDeal, "seller" | "status"> }[];
};

/** Non-zero Token-2022 balances of `owner`, by mint. Throws on RPC failure. */
async function heldMints(rpc: Rpc, owner: Address): Promise<string[]> {
  const res = await rpc
    .getTokenAccountsByOwner(
      owner,
      { programId: TOKEN_2022 },
      { encoding: "jsonParsed", commitment: "confirmed" },
    )
    .send();
  const mints = new Set<string>();
  for (const item of res.value) {
    const info = (
      item.account.data as unknown as {
        parsed?: { info?: { mint?: string; tokenAmount?: { amount?: string } } };
      }
    )?.parsed?.info;
    if (info?.mint && info.tokenAmount?.amount && BigInt(info.tokenAmount.amount) > BigInt(0))
      mints.add(info.mint);
  }
  return [...mints];
}

export async function closePassportPreflight(
  rpc: Rpc,
  input: { registry: Address; holder: Address; nowSec?: bigint },
  candidates: ClosePassportCandidates,
): Promise<ClosePassportCheck> {
  const now = input.nowSec ?? BigInt(Math.floor(Date.now() / 1000));
  const config = { commitment: "confirmed" as const };
  const blockers: string[] = [];
  let closableAt: bigint | null = null;

  const [entryPda] = await findKycEntryPda({
    kycRegistry: input.registry,
    holder: input.holder,
  });
  const entry = await fetchMaybeKycEntry(rpc, entryPda, config);
  if (!entry.exists) {
    blockers.push("This wallet has no passport on-chain in this registry.");
  } else {
    if (entry.data.status !== KycStatus.Revoked)
      blockers.push("Revoke the passport first.");
    closableAt = entry.data.expiry;
    if (entry.data.expiry > now)
      blockers.push(
        `Closable after ${new Date(Number(entry.data.expiry) * 1000).toISOString()} (the passport's expiry): until then it stays available for a clawback.`,
      );
  }

  for (const mint of await heldMints(rpc, input.holder)) {
    const [configPda] = await findConfigPda({ mint: mint as Address });
    const hook = await fetchMaybeTransferHookConfig(rpc, configPda, config);
    if (!hook.exists || hook.data.restrictionMode !== RestrictionMode.KycGated) continue;
    const pinned = hook.data.kycRegistry;
    if (pinned.__option === "Some" && pinned.value === input.registry)
      blockers.push(
        `The wallet still holds units of the KYC-gated mint ${mint}, which uses this registry. Claw them back first.`,
      );
  }

  for (const vault of candidates.vaults) {
    const live = await fetchMaybeLiveCustodyVault(rpc, vault, config);
    if (!live.exists) continue;
    const v: CustodyVault = live.data;
    if (
      v.vaultType === VaultType.DeliveryEscrow &&
      (v.state === VaultState.Active || v.state === VaultState.Triggered) &&
      v.beneficiary === input.holder &&
      v.kycRegistry === input.registry
    )
      blockers.push(
        `The wallet is the beneficiary of the open delivery escrow ${vault}, which checks this registry. Settle or return it first.`,
      );
  }

  for (const offer of candidates.offers) {
    const account = await fetchEncodedAccount(rpc, offer, config);
    if (!account.exists || isClosedAccount(account.programAddress, account.data)) continue;
    const o = decodeOffer(account).data;
    if (o.maker === input.holder && o.status === OfferStatus.Open)
      blockers.push(`The wallet has an open offer ${offer}. Cancel or expire it first.`);
  }

  for (const { pda, deal } of candidates.deals)
    if (deal.seller === input.holder && deal.status === OtcDealStatus.Open)
      blockers.push(`The wallet is the seller in the open OTC deal ${pda}. Settle or cancel it first.`);

  return { closable: blockers.length === 0, closableAt, blockers };
}
