import "server-only";
import { address, signature as toSignature } from "@solana/kit";
import { fetchMaybeToken } from "@solana-program/token-2022";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  fetchMaybeSale,
  fetchMaybeCustodyVault,
  fetchMaybeKycEntry,
  fetchMaybeKycRegistry,
  fetchMaybeShareClass,
  fetchMaybeAsset,
  findAssetPda,
  VaultState,
  VaultType,
  RealizeAction,
} from "@/lib/generated/asset_registry";
import {
  findCustodyVaultPda,
  findSalePda,
  findShareClassPda,
} from "@/lib/pdas";
import {
  ChainEvidenceError,
  custodyDepositEvidence,
  purchaseEvidence,
  TOKEN_2022_PROGRAM,
  type ChainTransaction,
} from "@/lib/chain-evidence";
import { getServerRpc } from "@/lib/server/rpc";
import { configuredKycRegistry } from "@/lib/kyc-registry-pin";
import { evaluatePassport } from "@/lib/custody-kyc";
import { getEntryPda } from "@/lib/passport";
import { SiwsError } from "@/lib/server/siws";

export function transactionSignature(value: unknown): string {
  try {
    if (typeof value !== "string") throw new Error();
    return toSignature(value);
  } catch {
    throw new SiwsError(400, "A valid transaction signature is required");
  }
}
function evidenceSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(12_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
async function finalizedTransaction(signature: string, signal?: AbortSignal) {
  let tx;
  try {
    tx = await getServerRpc()
      .getTransaction(toSignature(signature), {
        commitment: "finalized",
        encoding: "json",
        maxSupportedTransactionVersion: 0,
      })
      .send({ abortSignal: evidenceSignal(signal) });
  } catch {
    throw new SiwsError(
      503,
      "Transaction verification unavailable; retry recording without sending funds again",
    );
  }
  if (!tx)
    throw new SiwsError(
      503,
      "Transaction is not finalized or not yet available; retry recording without sending funds again",
    );
  if (!tx.meta || tx.meta.err !== null)
    throw new SiwsError(400, "Transaction did not complete successfully");
  return tx as ChainTransaction;
}
function proofError(error: unknown): never {
  if (error instanceof SiwsError) throw error;
  if (error instanceof ChainEvidenceError)
    throw new SiwsError(400, error.message);
  throw new SiwsError(
    503,
    "On-chain evidence could not be verified; try again",
  );
}
export async function requirePurchaseEvidence(
  signature: string,
  salePda: string,
  buyer: string,
  instructionIndex?: number,
  signal?: AbortSignal,
) {
  try {
    signal?.throwIfAborted();
    const tx = await finalizedTransaction(
      transactionSignature(signature),
      signal,
    );
    signal?.throwIfAborted();
    const sale = await fetchMaybeSale(getServerRpc(), address(salePda), {
      commitment: "finalized",
      minContextSlot: BigInt(tx.slot),
      abortSignal: evidenceSignal(signal),
    });
    if (
      !sale.exists ||
      sale.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS ||
      (await findSalePda(sale.data.shareClass, sale.data.saleId)) !== salePda
    ) {
      throw new SiwsError(400, "Sale does not match a registry-owned sale PDA");
    }
    const shareClass = await fetchMaybeShareClass(
      getServerRpc(),
      sale.data.shareClass,
      {
        commitment: "finalized",
        minContextSlot: BigInt(tx.slot),
        abortSignal: evidenceSignal(signal),
      },
    );
    if (
      !shareClass.exists ||
      shareClass.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS ||
      (await findShareClassPda(
        shareClass.data.asset,
        shareClass.data.classIndex,
      )) !== sale.data.shareClass
    )
      throw new SiwsError(400, "Sale share class identity mismatch");
    const asset = await fetchMaybeAsset(getServerRpc(), shareClass.data.asset, {
      commitment: "finalized",
      minContextSlot: BigInt(tx.slot),
      abortSignal: evidenceSignal(signal),
    });
    if (
      !asset.exists ||
      asset.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS ||
      (
        await findAssetPda({
          issuer: asset.data.issuer,
          assetId: asset.data.assetId,
        })
      )[0] !== shareClass.data.asset
    )
      throw new SiwsError(400, "Sale asset identity mismatch");
    const proof = purchaseEvidence(
      tx,
      signature,
      {
        buyer,
        sale: salePda,
        shareClass: sale.data.shareClass,
        asset: shareClass.data.asset,
        issuer: asset.data.issuer,
        mint: sale.data.mint,
        paymentMint: sale.data.paymentMint,
        proceeds: sale.data.proceeds,
        pricePerUnit: sale.data.pricePerUnit,
      },
      instructionIndex,
    );
    return { ...proof, asset: shareClass.data.asset.toString() };
  } catch (error) {
    proofError(error);
  }
}

/** `Pubkey::default()` — the kyc_registry of a vault that pins none. */
const UNPINNED_REGISTRY = "11111111111111111111111111111111";

export type CustodyRequestEvidence = {
  holder_wallet: string;
  share_class_pda: string;
  mint: string;
  vault_pda: string | null;
  vault_id?: string | number | null;
  amount: string | number;
};
export type RequestVaultOptions = {
  /**
   * Link step only: the vault must be pinned to the platform registry
   * (`NEXT_PUBLIC_KYC_REGISTRY`), or to some registry when none is
   * configured. Every later step (deposit, return, cancel, outcome) only
   * needs a pinned DeliveryEscrow: the chain enforces the pin that was set at
   * open, and a later re-pointing of the platform registry must never strand
   * an in-flight request (return stays ungated).
   */
  requirePlatformPin?: boolean;
};
export async function requireRequestVault(
  row: CustodyRequestEvidence,
  minContextSlot?: bigint,
  options: RequestVaultOptions = {},
) {
  try {
    if (!row.vault_pda)
      throw new SiwsError(409, "A verified custody vault must be linked first");
    if (
      (typeof row.amount === "number" && !Number.isSafeInteger(row.amount)) ||
      !/^[1-9]\d*$/.test(String(row.amount))
    )
      throw new SiwsError(
        400,
        "Custody amount must be an exact positive integer",
      );
    if (
      row.vault_id !== undefined &&
      row.vault_id !== null &&
      ((typeof row.vault_id === "number" &&
        !Number.isSafeInteger(row.vault_id)) ||
        !/^\d+$/.test(String(row.vault_id)))
    )
      throw new SiwsError(400, "Custody vault ID must be an exact integer");
    const vault = await fetchMaybeCustodyVault(
      getServerRpc(),
      address(row.vault_pda),
      {
        commitment: "finalized",
        minContextSlot,
        abortSignal: AbortSignal.timeout(12_000),
      },
    );
    if (
      !vault.exists ||
      vault.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS ||
      vault.data.shareClass !== row.share_class_pda ||
      vault.data.mint !== row.mint ||
      vault.data.beneficiary !== row.holder_wallet ||
      vault.data.vaultType !== VaultType.DeliveryEscrow ||
      vault.data.realizeAction !== RealizeAction.BurnAndAttest ||
      vault.data.amount !== BigInt(row.amount) ||
      (row.vault_id !== undefined &&
        row.vault_id !== null &&
        vault.data.vaultId !== BigInt(row.vault_id)) ||
      (await findCustodyVaultPda(vault.data.shareClass, vault.data.vaultId)) !==
        row.vault_pda
    ) {
      throw new SiwsError(400, "Custody vault terms do not match this request");
    }
    // KYC at conversion / delivery (2C-3): the vault's realize checks the
    // holder in the registry it pinned at open, so a request may only be
    // LINKED to a vault pinned to the platform registry (or, with no pin
    // configured, to some registry at all). Later steps only need a pin.
    const platformRegistry = options.requirePlatformPin
      ? configuredKycRegistry()
      : null;
    if (
      vault.data.kycRegistry === UNPINNED_REGISTRY ||
      (platformRegistry !== null && vault.data.kycRegistry !== platformRegistry)
    ) {
      throw new SiwsError(
        400,
        "Custody vault is not pinned to the platform KYC registry",
      );
    }
    const escrow = await fetchMaybeToken(getServerRpc(), vault.data.escrow, {
      commitment: "finalized",
      minContextSlot,
      abortSignal: AbortSignal.timeout(12_000),
    });
    if (
      !escrow.exists ||
      escrow.programAddress !== TOKEN_2022_PROGRAM ||
      escrow.data.owner !== row.vault_pda ||
      escrow.data.mint !== row.mint
    ) {
      throw new SiwsError(400, "Custody escrow does not match this request");
    }
    return { vault: vault.data, escrow: escrow.data };
  } catch (error) {
    proofError(error);
  }
}
/**
 * KYC at delivery (2C-3), off-chain half: the physical handover ("in
 * delivery") must not start unless the beneficiary's passport in the vault's
 * pinned registry would pass the realize gate (Approved, unexpired,
 * jurisdiction allowed) — otherwise the goods could leave while the burn can
 * only fail and the deposit's one exit is a return.
 */
export async function requireBeneficiaryPassport(
  vault: { beneficiary: string; kycRegistry: string },
  nowSec: number = Math.floor(Date.now() / 1000),
) {
  if (vault.kycRegistry === UNPINNED_REGISTRY)
    throw new SiwsError(
      409,
      "This vault pins no KYC registry; return the deposit instead",
    );
  let evaluation: ReturnType<typeof evaluatePassport>;
  try {
    const registryAddress = address(vault.kycRegistry);
    const entryAddress = await getEntryPda(
      registryAddress,
      address(vault.beneficiary),
    );
    // "confirmed": a revocation must block the handover as soon as it lands.
    const config = {
      commitment: "confirmed" as const,
      abortSignal: AbortSignal.timeout(12_000),
    };
    const [entry, registry] = await Promise.all([
      fetchMaybeKycEntry(getServerRpc(), entryAddress, config),
      fetchMaybeKycRegistry(getServerRpc(), registryAddress, config),
    ]);
    evaluation = evaluatePassport(
      entry.exists ? entry.data : null,
      registry.exists ? registry.data : null,
      nowSec,
    );
  } catch {
    throw new SiwsError(
      503,
      "The holder's investor passport could not be verified; try again",
    );
  }
  if (evaluation.status !== "approved")
    throw new SiwsError(
      409,
      `${evaluation.reason} Delivery needs the holder's approved investor passport; without one the deposit can only be returned.`,
    );
}
export async function requireDepositEvidence(
  signature: string,
  row: CustodyRequestEvidence,
) {
  try {
    const tx = await finalizedTransaction(transactionSignature(signature));
    const { vault, escrow } = await requireRequestVault(row, BigInt(tx.slot));
    const amount = BigInt(row.amount);
    if (
      amount <= BigInt(0) ||
      (vault.state !== VaultState.Active &&
        vault.state !== VaultState.Triggered) ||
      vault.deposited < amount ||
      escrow.amount < amount
    ) {
      throw new SiwsError(
        409,
        "Requested deposit is not currently held in custody",
      );
    }
    return custodyDepositEvidence(tx, signature, {
      holder: row.holder_wallet,
      shareClass: row.share_class_pda,
      vault: row.vault_pda!,
      mint: row.mint,
      escrow: vault.escrow,
      amount,
    });
  } catch (error) {
    proofError(error);
  }
}
