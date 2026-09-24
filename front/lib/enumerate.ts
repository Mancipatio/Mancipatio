// Enumerate every asset_registry account via getProgramAccounts, then
// classify each by its 8-byte discriminator and decode it.

import type { SolanaClient } from "@solana/client";
import type { Address } from "@solana/kit";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  getAssetDecoder,
  getAssetDiscriminatorBytes,
  getIssuerDecoder,
  getIssuerDiscriminatorBytes,
  getOfferDecoder,
  getOfferDiscriminatorBytes,
  getRightsIssuanceDecoder,
  getRightsIssuanceDiscriminatorBytes,
  getSaleDecoder,
  getSaleDiscriminatorBytes,
  getShareClassDiscriminatorBytes,
  getVestingMilestoneDecoder,
  getVestingMilestoneDiscriminatorBytes,
  type Asset,
  type Issuer,
  type Offer,
  type RightsIssuance,
  type Sale,
  type ShareClass,
  type VestingMilestone,
} from "@/lib/generated/asset_registry";

import { decodeShareClassV2 } from "@/lib/account-versions";

type Rpc = SolanaClient["runtime"]["rpc"];
type Raw = { address: Address; data: Uint8Array };

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

async function fetchAll(rpc: Rpc): Promise<Raw[]> {
  const res = await rpc
    .getProgramAccounts(ASSET_REGISTRY_PROGRAM_ADDRESS, { encoding: "base64", commitment: "finalized" })
    .send();
  return res.map((r) => {
    if (r.account.owner !== ASSET_REGISTRY_PROGRAM_ADDRESS) throw new Error("Program snapshot has an unexpected owner");
    const data = b64ToBytes((r.account.data as readonly [string, string])[0]);
    if (data.length < 8) throw new Error("Program snapshot has an incomplete discriminator");
    return { address: r.pubkey, data };
  });
}

/** A tracked account with stale/incomplete bytes invalidates the snapshot.
 * Silently skipping it would present partial holdings and financial totals. */
function ofType<T>(
  raws: Raw[],
  disc: ArrayLike<number>,
  decode: (d: Uint8Array) => T,
  label: string,
): T[] {
  const out: T[] = [];
  for (const r of raws) {
    if (r.data.length < 8) continue;
    let match = true;
    for (let i = 0; i < 8; i += 1) {
      if (r.data[i] !== disc[i]) {
        match = false;
        break;
      }
    }
    if (!match) continue;
    try {
      out.push(decode(r.data));
    } catch (err) {
      throw new Error(`${label} ${r.address} requires an explicit account migration or a complete RPC snapshot: ${err instanceof Error ? err.message : "decode failed"}`);
    }
  }
  return out;
}

export type NetworkData = {
  issuers: Issuer[];
  assets: Asset[];
  shareClasses: ShareClass[];
  sales: Sale[];
  offers: Offer[];
  rightsIssuances: RightsIssuance[];
  milestones: VestingMilestone[];
};

export async function loadNetwork(rpc: Rpc): Promise<NetworkData> {
  const raws = await fetchAll(rpc);
  return {
    issuers: ofType(
      raws,
      getIssuerDiscriminatorBytes(),
      (d) => getIssuerDecoder().decode(d),
      "Issuer",
    ),
    assets: ofType(
      raws,
      getAssetDiscriminatorBytes(),
      (d) => getAssetDecoder().decode(d),
      "Asset",
    ),
    shareClasses: ofType(raws, getShareClassDiscriminatorBytes(), decodeShareClassV2, "ShareClass"),
    sales: ofType(
      raws,
      getSaleDiscriminatorBytes(),
      (d) => getSaleDecoder().decode(d),
      "Sale",
    ),
    offers: ofType(
      raws,
      getOfferDiscriminatorBytes(),
      (d) => getOfferDecoder().decode(d),
      "Offer",
    ),
    rightsIssuances: ofType(
      raws,
      getRightsIssuanceDiscriminatorBytes(),
      (d) => getRightsIssuanceDecoder().decode(d),
      "RightsIssuance",
    ),
    milestones: ofType(
      raws,
      getVestingMilestoneDiscriminatorBytes(),
      (d) => getVestingMilestoneDecoder().decode(d),
      "VestingMilestone",
    ),
  };
}
