import "server-only";
import { address } from "@solana/kit";
import { requireAdmin } from "@/lib/server/admin-gate";
import { SiwsError } from "@/lib/server/siws";
import { getServerRpc } from "@/lib/server/rpc";
import { ASSET_REGISTRY_PROGRAM_ADDRESS, fetchMaybeAsset, fetchMaybeIssuer,
  getAssetDiscriminatorBytes, getIssuerDiscriminatorBytes, findAssetPda, findIssuerPda } from "@/lib/generated/asset_registry";

export function readPdas(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) throw new SiwsError(400, "Provide 1–100 profile addresses");
  return [...new Set(value.map((v) => {
    if (typeof v !== "string") throw new SiwsError(400, "Invalid profile address");
    try { return address(v).toString(); } catch { throw new SiwsError(400, "Invalid profile address"); }
  }))];
}

export async function isProfileAdmin(wallet: string): Promise<boolean> {
  try { await requireAdmin(wallet); return true; }
  catch (err) { if (err instanceof SiwsError && err.status === 403) return false; throw err; }
}

export async function requireProfileOwner(wallet: string, pda: string, kind: "asset" | "issuer"): Promise<void> {
  try {
    const rpc = getServerRpc();
    const options = { commitment: "finalized" as const, abortSignal: AbortSignal.timeout(8_000) };
    let issuerPda = address(pda);
    if (kind === "asset") {
      const asset = await fetchMaybeAsset(rpc, address(pda), options);
      if (!asset.exists || asset.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS ||
          !asset.data.discriminator.every((b, i) => b === getAssetDiscriminatorBytes()[i])) throw new SiwsError(403, "Profile access denied");
      const [expected] = await findAssetPda({ issuer: asset.data.issuer, assetId: asset.data.assetId });
      if (expected !== pda) throw new SiwsError(403, "Profile access denied");
      issuerPda = asset.data.issuer;
    }
    const issuer = await fetchMaybeIssuer(rpc, issuerPda, options);
    if (!issuer.exists || issuer.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS ||
        !issuer.data.discriminator.every((b, i) => b === getIssuerDiscriminatorBytes()[i]) ||
        issuer.data.authority.toString() !== wallet) throw new SiwsError(403, "Profile access denied");
    const [expected] = await findIssuerPda({ legalEntityId: issuer.data.legalEntityId });
    if (expected !== issuerPda) throw new SiwsError(403, "Profile access denied");
  } catch (err) {
    if (err instanceof SiwsError) throw err;
    throw new SiwsError(503, "Profile authorization unavailable — try again");
  }
}
