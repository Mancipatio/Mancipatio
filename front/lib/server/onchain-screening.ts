// SERVER-ONLY — sanctions screening of on-chain entries the platform does
// not mediate (8.5, gap-2026-09-28). A primary buy of an Open class mints
// without the transfer hook and the program has no blocklist check of the
// buyer, so a wallet that calls the program directly (its own script, no
// site) never reaches a screened route: not the sale page's pre-check, not
// the purchase record. The alarm worker sees every finalized program
// transaction the indexer delivers (onchain_event_jobs, lib/server/
// onchain-alarms.ts processEventJob); this screens the SIGNER of each entry
// below in it, and a hit raises the same compliance alert as the routes
// (raise_sanctions_hit, one per wallet, with the transaction), so
// compliance blocklists and claws back (runbook "Sanctions list").
//
// Instruction-first like the alarms: top-level and inner (CPI) invocations,
// account keys resolved through the lookup tables. A list that cannot answer
// where the screen fails closed (mainnet) keeps the job pending (it retries
// with backoff until the list is usable): a buy is never "screened" against
// a stale list. Off mainnet an unusable list is not enforced (the routes'
// rule), so the job completes.

import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  BUY_DISCRIMINATOR,
  CREATE_OFFER_DISCRIMINATOR,
  TAKE_OFFER_DISCRIMINATOR,
} from "@/lib/generated/asset_registry";
import { reportSanctionsHits } from "@/lib/server/sanctions";
import { flattenInvocations, type InvocationTx } from "@/lib/server/tx-invocations";

/**
 * The entries whose signer is screened: the IDL instruction name (a test pins
 * `account` to the IDL's account order) and the signer's role.
 */
export const SCREENED_ENTRIES = [
  { name: "buy", discriminator: BUY_DISCRIMINATOR, account: 0, party: "buyer" },
  { name: "create_offer", discriminator: CREATE_OFFER_DISCRIMINATOR, account: 0, party: "maker" },
  { name: "take_offer", discriminator: TAKE_OFFER_DISCRIMINATOR, account: 0, party: "taker" },
] as const;

export type ScreenedParty = { wallet: string; instruction: (typeof SCREENED_ENTRIES)[number]["name"]; party: string };

const startsWith = (data: Uint8Array, d: Uint8Array) => data.length >= d.length && d.every((b, i) => data[i] === b);

/** Pure: the signers of the screened entries in one transaction, each wallet once. */
export function screenedParties(tx: InvocationTx): ScreenedParty[] {
  const out: ScreenedParty[] = [];
  for (const inv of flattenInvocations(tx)) {
    if (inv.programId !== ASSET_REGISTRY_PROGRAM_ADDRESS) continue;
    const entry = SCREENED_ENTRIES.find((e) => startsWith(inv.data, e.discriminator as Uint8Array));
    const wallet = entry ? inv.accounts[entry.account] : undefined;
    if (!entry || !wallet || out.some((p) => p.wallet === wallet)) continue;
    out.push({ wallet, instruction: entry.name, party: entry.party });
  }
  return out;
}

/**
 * Screens the signers of one finalized, successful transaction. "retry" when
 * the screen could not run where it fails closed; THROWS when an alert could
 * not be written (the job retries). The number of hits otherwise.
 */
export async function screenTransactionParties(
  sb: SupabaseClient,
  signature: string,
  tx: InvocationTx,
): Promise<{ hits: number } | "retry"> {
  const parties = screenedParties(tx);
  if (parties.length === 0) return { hits: 0 };
  const { hits, retryLater } = await reportSanctionsHits(sb, {
    route: `on-chain ${[...new Set(parties.map((p) => p.instruction))].join(", ")} (indexer)`,
    wallets: parties.map((p) => ({ wallet: p.wallet, role: "onchain-signer" as const })),
    txSignature: signature,
  }, { strict: true });
  return retryLater ? "retry" : { hits: hits.length };
}
