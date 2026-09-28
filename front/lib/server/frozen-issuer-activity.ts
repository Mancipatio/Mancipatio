// SERVER-ONLY — activity of a FROZEN issuer's authority wallet (D1, design
// 8.3 §5 high row, K1.4 / O-9). A proceeds freeze stops the issuer's sales and
// proceeds exits, but the program does not stop the issuer wallet's own
// secondary sales or transfers of units it already holds (O-9): the accepted
// mitigation is this alarm, so the Blocklist Authority can block the wallet
// before the units are out of reach (runbook §11 "Issuer proceeds freeze").
//
// For every live freeze (the 0079 `issuer_freezes` mirror) the issuer's
// authority wallet comes from the `issuers` mirror. A finalized, successful
// transaction of the alarm queue (lib/server/onchain-alarms.ts
// processEventJob) that moves units or trades them (an offer, a take, an OTC
// deal or deposit, a hooked Token-2022 transfer: `isTradeOrTransfer`; only
// those read the mirror) raises one high alert per frozen wallet that, in it:
//   * signs the transaction;
//   * is the maker of a taken offer (take_offer's maker_block_entry is the
//     wallet's ["blocked", wallet] PDA) or the seller of an OTC deal the buyer
//     settles (deposit_otc_payment's seller_block_entry), neither of which
//     the maker / seller signs;
//   * is named seller or buyer in create_otc_deal (the Admin signs it);
//   * owns the source of a hooked Token-2022 transfer (the hook's Execute
//     account 3: a transfer by a delegate is caught too).
// Instruction-first like the alarms (top-level and inner, lookup-table keys
// resolved); pure detection, the mirror read happens in the job.

import "server-only";
import type { Address } from "@solana/kit";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  CREATE_OFFER_DISCRIMINATOR,
  CREATE_OTC_DEAL_DISCRIMINATOR,
  DEPOSIT_OTC_ASSET_DISCRIMINATOR,
  DEPOSIT_OTC_PAYMENT_DISCRIMINATOR,
  DEPOSIT_TO_OFFER_ESCROW_DISCRIMINATOR,
  TAKE_OFFER_DISCRIMINATOR,
  getCreateOtcDealInstructionDataDecoder,
} from "@/lib/generated/asset_registry";
import { TRANSFER_HOOK_PROGRAM_ADDRESS } from "@/lib/generated/transfer_hook";
import type { Network } from "@/lib/network";
import { findBlockEntryPda } from "@/lib/pdas";
import { flattenInvocations, resolveAccountKeys, type InvocationTx } from "@/lib/server/tx-invocations";

/** A frozen issuer's authority wallet → its issuer and ["blocked", wallet] PDA. */
export type FrozenIssuerWallets = Map<string, { issuer: string; blockEntry: string }>;

export type FrozenIssuerHit = {
  wallet: string;
  issuer: string;
  /** Why this wallet was matched, each once (e.g. "signer", "offer maker"). */
  roles: string[];
  /** The instructions it was matched in, each once. */
  instructions: string[];
};

/** spl-transfer-hook-interface `Execute` (sha256("spl-transfer-hook-interface:execute")[..8]). */
export const HOOK_EXECUTE_DISCRIMINATOR = new Uint8Array([105, 37, 101, 197, 75, 251, 102, 26]);

/**
 * Where a frozen wallet shows up without signing: the account index (IDL
 * order, pinned by a test) of an instruction and what it holds there.
 */
export const FROZEN_WALLET_ACCOUNTS = [
  { name: "create_offer", discriminator: CREATE_OFFER_DISCRIMINATOR, index: 0, holds: "wallet", role: "offer maker" },
  { name: "deposit_to_offer_escrow", discriminator: DEPOSIT_TO_OFFER_ESCROW_DISCRIMINATOR, index: 0, holds: "wallet", role: "offer maker" },
  { name: "take_offer", discriminator: TAKE_OFFER_DISCRIMINATOR, index: 0, holds: "wallet", role: "offer taker" },
  { name: "take_offer", discriminator: TAKE_OFFER_DISCRIMINATOR, index: 13, holds: "block-entry", role: "offer maker" },
  { name: "deposit_otc_asset", discriminator: DEPOSIT_OTC_ASSET_DISCRIMINATOR, index: 0, holds: "wallet", role: "OTC seller" },
  { name: "deposit_otc_payment", discriminator: DEPOSIT_OTC_PAYMENT_DISCRIMINATOR, index: 0, holds: "wallet", role: "OTC buyer" },
  { name: "deposit_otc_payment", discriminator: DEPOSIT_OTC_PAYMENT_DISCRIMINATOR, index: 14, holds: "block-entry", role: "OTC seller" },
] as const;

const startsWith = (data: Uint8Array, d: ArrayLike<number>) =>
  data.length >= d.length && Array.from(d).every((b, i) => data[i] === b);

/**
 * Pure: whether the transaction trades or moves units (one of
 * FROZEN_WALLET_ACCOUNTS' instructions, create_otc_deal, or the hook's
 * Execute of a Token-2022 transfer). Only these are matched against the
 * frozen wallets, so the job reads the mirror for them only.
 */
export function isTradeOrTransfer(tx: InvocationTx): boolean {
  return flattenInvocations(tx).some((inv) =>
    inv.programId === TRANSFER_HOOK_PROGRAM_ADDRESS
      ? startsWith(inv.data, HOOK_EXECUTE_DISCRIMINATOR)
      : inv.programId === ASSET_REGISTRY_PROGRAM_ADDRESS &&
        (startsWith(inv.data, CREATE_OTC_DEAL_DISCRIMINATOR) || FROZEN_WALLET_ACCOUNTS.some((spec) => startsWith(inv.data, spec.discriminator))),
  );
}

/** Pure: every frozen issuer wallet active in one trade or transfer transaction. */
export function frozenIssuerActivity(tx: InvocationTx, frozen: FrozenIssuerWallets): FrozenIssuerHit[] {
  if (frozen.size === 0 || !isTradeOrTransfer(tx)) return [];
  const byBlockEntry = new Map<string, string>();
  for (const [wallet, info] of frozen) byBlockEntry.set(info.blockEntry, wallet);
  const hits = new Map<string, FrozenIssuerHit>();
  const hit = (wallet: string | undefined, role: string, instruction: string) => {
    if (!wallet) return;
    const info = frozen.get(wallet);
    if (!info) return;
    const entry = hits.get(wallet) ?? { wallet, issuer: info.issuer, roles: [], instructions: [] };
    if (!entry.roles.includes(role)) entry.roles.push(role);
    if (!entry.instructions.includes(instruction)) entry.instructions.push(instruction);
    hits.set(wallet, entry);
  };

  const invocations = flattenInvocations(tx);
  const ours = invocations.filter((inv) => inv.programId === ASSET_REGISTRY_PROGRAM_ADDRESS || inv.programId === TRANSFER_HOOK_PROGRAM_ADDRESS);
  for (const inv of ours) {
    if (inv.programId === TRANSFER_HOOK_PROGRAM_ADDRESS) {
      if (startsWith(inv.data, HOOK_EXECUTE_DISCRIMINATOR)) hit(inv.accounts[3], "transfer source owner", "token transfer");
      continue;
    }
    for (const spec of FROZEN_WALLET_ACCOUNTS) {
      if (!startsWith(inv.data, spec.discriminator)) continue;
      const key = inv.accounts[spec.index];
      hit(spec.holds === "wallet" ? key : key ? byBlockEntry.get(key) : undefined, spec.role, spec.name);
    }
    if (startsWith(inv.data, CREATE_OTC_DEAL_DISCRIMINATOR)) {
      try {
        const args = getCreateOtcDealInstructionDataDecoder().decode(inv.data);
        hit(args.seller, "OTC seller", "create_otc_deal");
        hit(args.buyer, "OTC buyer", "create_otc_deal");
      } catch {
        // Undecodable arguments: the signer check below still applies.
      }
    }
  }
  // A trade or transfer the frozen wallet signs (whatever its role in it).
  const keys = resolveAccountKeys(tx);
  const signers = Number(tx.transaction.message.header?.numRequiredSignatures ?? 1);
  for (const signer of keys.slice(0, Math.max(0, signers))) hit(signer, "signer", "transaction");
  return [...hits.values()];
}

function missingRelation(error: { code?: unknown } | null): boolean {
  return error?.code === "42P01" || error?.code === "PGRST205";
}

/**
 * The authority wallets of the issuers frozen on `network` (the 0079 mirror,
 * joined with the issuers mirror). Empty before 0079 is applied. THROWS when
 * the mirror cannot be read (the job retries: a freeze must not be missed).
 */
export async function loadFrozenIssuerWallets(sb: SupabaseClient, network: Network, signal: AbortSignal): Promise<FrozenIssuerWallets> {
  const out: FrozenIssuerWallets = new Map();
  const freezes = await sb.from("issuer_freezes").select("issuer_pda").eq("network", network).limit(1000).abortSignal(signal);
  if (freezes.error) {
    if (missingRelation(freezes.error)) return out;
    throw new Error("Issuer freeze mirror unavailable");
  }
  const issuers = [...new Set(((freezes.data ?? []) as { issuer_pda: string }[]).map((r) => r.issuer_pda))];
  if (issuers.length === 0) return out;
  const rows = await sb.from("issuers").select("pda,authority").eq("network", network).in("pda", issuers).abortSignal(signal);
  if (rows.error) throw new Error("Issuer mirror unavailable");
  for (const row of (rows.data ?? []) as { pda: string; authority: string }[]) {
    out.set(row.authority, { issuer: row.pda, blockEntry: await findBlockEntryPda(row.authority as Address) });
  }
  return out;
}

/** One alert per hit: high, minimal format (the issuer PDA, never an amount). */
export function frozenIssuerAlerts(sig: string, hits: readonly FrozenIssuerHit[]) {
  return hits.map((h) => ({
    dedupKey: `onchain:${sig}:frozen-issuer:${h.issuer}`,
    source: "onchain:frozen-issuer-activity",
    severity: "high" as const,
    summary: `The authority wallet of a FROZEN issuer is active on chain (${h.roles.join(", ")} in ${h.instructions.join(", ")}). Check the transaction; to stop its units leaving, the Blocklist Authority blocks that wallet (runbook §11 "Issuer proceeds freeze", O-9)`,
    evidence: { issuer: h.issuer, roles: h.roles, instructions: h.instructions },
  }));
}
