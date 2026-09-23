"use client";

import { useCustodyOpenRecovery } from "@/lib/use-custody-open-recovery";
import { parseCustodyVaultId, requireCustodyRequestAmount } from "@/lib/custody-open-recovery";

import { useCustodyOutcomeRecovery } from "@/lib/use-custody-outcome-recovery";
import { CustodyAuthorityTransfer } from "@/components/custody-authority-transfer";
import { custodyAuthorityRecord } from "@/lib/custody-authority";
import {
  REALIZE_ACTION_LABEL,
  assertSupportedRealizeAction,
  realizeActionOptions,
  unsupportedRealizeActionReason,
} from "@/lib/custody-realization";

import { address, type Address } from "@solana/kit";
import { walletSigner } from "@/lib/wallet-signer";
import {
  useSendTransaction,
  useSolanaClient,
  useWalletConnection,
} from "@solana/react-hooks";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
} from "@solana-program/token-2022";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  findAssetPda,
  findIssuerPda,
  findOpenCustodyVaultEscrowPda,
  getOpenCustodyVaultInstructionAsync,
  getRealizeCustodyVaultInstructionAsync,
  getReturnCustodyVaultInstructionAsync,
  getRevertCustodyVaultInstructionAsync,
  getTriggerCustodyVaultInstruction,
  RealizeAction,
  VaultState,
  VaultType,
  type Asset,
  type CustodyVault,
  type ShareClass,
} from "@/lib/generated/asset_registry";
import { fetchMaybeLiveCustodyVault } from "@/lib/closed-account";
import { loadNetwork, type NetworkData } from "@/lib/enumerate";
import {
  loadCustodyVaultsFromIndexer,
  loadNetworkPreferIndexer,
} from "@/lib/indexer";
import {
  adminListDeliveryRequests,
  adminUpdateDeliveryRequest,
  type DeliveryRequest,
  type DeliveryStatus,
} from "@/lib/delivery";
import {
  adminListConversionRequests,
  adminUpdateConversionRequest,
  type ConversionRequest,
  type ConversionStatus,
} from "@/lib/conversion";
import { signedUpload, sha256HexOfFile } from "@/lib/storage-client";
import { previewEscrowRelease } from "@/lib/escrow-ledger";
import { fromBytes32, toBytes32 } from "@/lib/format";
import { hookTransferMetas } from "@/lib/hook-metas";
import { findCustodyVaultPda, findShareClassPda } from "@/lib/pdas";
import { ConfirmModal } from "@/components/confirm-modal";
import { FieldError, FieldHelp, FieldLabel } from "@/components/field";
import { SkeletonTable } from "@/components/skeleton";
import { RequireRole } from "@/components/require-role";
import { recordAudit } from "@/lib/supabase";
import { useToast } from "@/lib/toast";
import { explainSendError } from "@/lib/tx-error";
import { custodyReclaimBlocker, reclaimCustodyVault } from "@/lib/reclaim-rent";
import {
  loadBeneficiaryPassport,
  passportShortcutHref,
  pinnedRegistryWarning,
  PASSPORT_STATUS_LABEL,
  realizeKycAccounts,
  type PassportEvaluation,
} from "@/lib/custody-kyc";
import {
  kycRegistryUnavailableReason,
  loadKycAuthorityContext,
} from "@/lib/kyc-authority";
import { configuredKycRegistry } from "@/lib/kyc-registry-pin";
import { detectNetwork } from "@/lib/network";

const TOKEN_2022_ADDRESS =
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" as Address;

const VAULT_TYPE_LABEL = [
  "Vesting",
  "Conversion pending",
  "Delivery escrow",
  "Redemption queue",
];
const VAULT_STATE_LABEL = [
  "Active",
  "Triggered",
  "Realized",
  "Reverted",
  "Expired",
  "Returned",
];

const STATE_BADGE: Record<number, string> = {
  0: "bg-emerald-100 text-emerald-800 border-emerald-200", // Active
  1: "bg-amber-100 text-amber-800 border-amber-200", // Triggered
  2: "bg-slate-200 text-slate-800 border-slate-300", // Realized
  3: "bg-brand-100 text-brand-800 border-brand-200", // Reverted
  4: "bg-red-100 text-red-800 border-red-200", // Expired
  5: "bg-slate-200 text-slate-800 border-slate-300", // Returned
};

type StateFilter =
  | "all"
  | "active"
  | "triggered"
  | "realized"
  | "reverted"
  | "expired"
  | "returned";

const FILTER_TO_STATE: Record<Exclude<StateFilter, "all">, number> = {
  active: 0,
  triggered: 1,
  realized: 2,
  reverted: 3,
  expired: 4,
  returned: 5,
};

const DELIVERY_STATUS_LABEL: Record<DeliveryStatus, string> = {
  requested: "Requested",
  vault_opened: "Vault opened",
  deposited: "Deposited",
  in_delivery: "In delivery",
  delivered: "Delivered",
  cancelled: "Cancelled",
  returned: "Returned",
};

const DELIVERY_STATUS_BADGE: Record<DeliveryStatus, string> = {
  requested: "bg-amber-100 text-amber-800 border-amber-200",
  vault_opened: "bg-brand-100 text-brand-800 border-brand-200",
  deposited: "bg-emerald-100 text-emerald-800 border-emerald-200",
  in_delivery: "bg-amber-100 text-amber-800 border-amber-200",
  delivered: "bg-emerald-100 text-emerald-800 border-emerald-200",
  cancelled: "bg-red-100 text-red-800 border-red-200",
  returned: "bg-slate-200 text-slate-800 border-slate-300",
};

const CONVERSION_STATUS_LABEL: Record<ConversionStatus, string> = {
  requested: "Requested",
  vault_opened: "Vault opened",
  deposited: "Deposited",
  converted: "Converted",
  cancelled: "Cancelled",
  returned: "Returned",
};

const CONVERSION_STATUS_BADGE: Record<ConversionStatus, string> = {
  requested: "bg-amber-100 text-amber-800 border-amber-200",
  vault_opened: "bg-brand-100 text-brand-800 border-brand-200",
  deposited: "bg-emerald-100 text-emerald-800 border-emerald-200",
  converted: "bg-emerald-100 text-emerald-800 border-emerald-200",
  cancelled: "bg-red-100 text-red-800 border-red-200",
  returned: "bg-slate-200 text-slate-800 border-slate-300",
};

// ---------------------------------------------------------------------------
// Vault attestation document / hash (metadata_hash on open_custody_vault).
//
// Every open-vault path used to send metadataHash: new Uint8Array(32) — an
// all-zero "attestation" that binds the vault to nothing. Now each open-vault
// modal requires a REAL sha256: either upload the underlying document
// (conversion agreement / delivery confirmation / vault spec) — stored under
// the admin-only confidential prefix issuer-agreement/<kind>/… and hashed
// client-side — or paste the sha256 of a document kept off-platform. The open
// button stays disabled until a valid hash exists. Realize/confirm re-uses
// the hash the vault carried at open (it is immutable on-chain).
// ---------------------------------------------------------------------------

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/**
 * A usable digest is 64 lowercase hex chars AND not a degenerate filler
 * value: the all-zero hash is exactly the "attestation bound to nothing"
 * this section exists to eliminate (pasting 64 zeros must not unlock the
 * button), and all-ff is the analogous junk filler.
 */
function isValidSha256Hex(hex: string): boolean {
  return (
    SHA256_HEX_RE.test(hex) && !/^0{64}$/.test(hex) && !/^f{64}$/.test(hex)
  );
}

/**
 * Reads back what a just-sent `return_custody_vault` actually did.
 *
 * The instruction is NOT unconditionally terminal any more. It splits the
 * escrow against `custody_vault.deposited`: up to the ledger goes back to the
 * beneficiary with no receiver check, and any surplus above it is a delivery
 * that only leaves the escrow if the beneficiary's `KycEntry` passes. When the
 * surplus is withheld the handler deliberately keeps the vault `Active` /
 * `Triggered` with its `EscrowMarker` open, so the remainder still has an exit.
 *
 * This helper describes vault closure only. Holder request completion uses
 * the finalized transfer proof and its own deposit ledger, independently of
 * unrelated surplus that may remain in the vault.
 */
type ReturnOutcome = {
  terminal: boolean;
  /** Units still recorded as the beneficiary's after the return. */
  depositedAfter: bigint | null;
};

async function readReturnOutcome(
  rpc: Parameters<typeof fetchMaybeLiveCustodyVault>[0],
  vaultPda: Address,
): Promise<ReturnOutcome> {
  try {
    const after = await fetchMaybeLiveCustodyVault(rpc, vaultPda);
    if (!after.exists) return { terminal: false, depositedAfter: null };
    return {
      terminal: after.data.state === VaultState.Returned,
      depositedAfter: after.data.deposited,
    };
  } catch {
    // Could not read it back — assume NOT terminal. Leaving the row in its
    // current state is recoverable (the operator retries); marking it closed
    // while the chain still holds tokens is not.
    return { terminal: false, depositedAfter: null };
  }
}

const PARTIAL_RETURN_HINT =
  "Only the beneficiary's recorded deposit was released. The rest was never deposited by them, so releasing it is a delivery that needs a valid investor passport. The vault stays open — retry once the passport is valid, or trigger + realize to burn the remainder.";

function hexToBytes32(hex: string): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** issuer-agreement/<kind>/<sha8>-<sanitized-name> — admin-only confidential
 *  prefix; the sha8 prefix keeps paths unique per content. */
function attestationDocPath(
  kind: string,
  sha256: string,
  fileName: string,
): string {
  const safe =
    fileName
      .replace(/[^A-Za-z0-9._-]/g, "-")
      .replace(/^[._-]+/, "")
      .slice(0, 120) || "document";
  return `issuer-agreement/${kind}/${sha256.slice(0, 8)}-${safe}`;
}

/**
 * Upload the attestation document (when one was picked) under the admin-only
 * issuer-agreement/ prefix. A 409 "already exists" is fine — the path is
 * content-prefixed, so the same document is already stored. Throws on any
 * other failure.
 */
async function uploadAttestationDoc(
  session: Parameters<typeof signedUpload>[0],
  kind: string,
  file: File,
  sha256: string,
): Promise<void> {
  try {
    await signedUpload(session, {
      path: attestationDocPath(kind, sha256, file.name),
      file,
      sha256,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/already exists/i.test(message)) throw err;
  }
}

/** Shared attestation-document fields for the open-vault modals. The parent
 *  owns the state; the effective hash is file-hash when a file is picked,
 *  otherwise the pasted hash (if valid). */
function AttestationDocSection({
  kindLabel,
  file,
  fileHash,
  pastedHash,
  onFileChange,
  onPastedChange,
  disabled,
}: {
  kindLabel: string;
  file: File | null;
  fileHash: string;
  pastedHash: string;
  onFileChange: (file: File | null, sha256: string) => void;
  onPastedChange: (value: string) => void;
  disabled?: boolean;
}) {
  const [hashing, setHashing] = useState(false);
  const effective = file ? fileHash : pastedHash.trim().toLowerCase();
  const ok = isValidSha256Hex(effective);

  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-600">
        Attestation document <span className="text-red-600">*</span>
      </p>
      <p className="mt-1 text-[11px] leading-snug text-slate-500">
        The vault&apos;s on-chain metadata hash is the sha256 of the {kindLabel}
        . Upload the document (stored confidentially under issuer-agreement/) or
        paste its sha256 if it lives off-platform.
      </p>
      <div className="mt-2 space-y-2">
        <input
          type="file"
          accept=".pdf,.png,.jpg,.jpeg,.docx"
          disabled={disabled || hashing}
          onChange={(e) => {
            const f = e.target.files?.[0] ?? null;
            if (!f) {
              onFileChange(null, "");
              return;
            }
            setHashing(true);
            void sha256HexOfFile(f)
              .then((hex) => onFileChange(f, hex))
              .finally(() => setHashing(false));
          }}
          className="block w-full text-xs text-slate-600 file:mr-3 file:rounded-md file:border file:border-slate-300 file:bg-white file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-slate-700 hover:file:border-slate-400"
        />
        {!file && (
          <input
            value={pastedHash}
            disabled={disabled}
            onChange={(e) => onPastedChange(e.target.value)}
            placeholder="…or paste the document's sha256 (64 hex chars)"
            className="w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-xs focus:border-slate-400 focus:outline-none"
          />
        )}
        {hashing ? (
          <p className="text-[11px] text-slate-500">Hashing…</p>
        ) : ok ? (
          <p className="break-all font-mono text-[11px] text-emerald-700">
            sha256: {effective}
          </p>
        ) : (
          <p className="text-[11px] text-amber-700">
            {file || pastedHash.trim()
              ? "Not a usable sha256 (need 64 lowercase hex characters; the all-zero and all-ff digests are rejected)."
              : "Required — the vault cannot be opened with a zero hash."}
          </p>
        )}
      </div>
    </div>
  );
}

export default function CustodyPage() {
  return (
    <section className="min-w-0 flex-1">
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
          Custody
        </p>
        <h1 className="mt-1 text-xl font-semibold text-slate-900">
          Custody vaults
        </h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-slate-600">
          Program-owned escrows for vesting, conversion, delivery and redemption
          — opened by issuers, run through trigger → realize.
        </p>
      </div>
      <RequireRole role="admin">
        <CustodyOps />
      </RequireRole>
    </section>
  );
}

function CustodyOps() {
  const client = useSolanaClient();
  const [data, setData] = useState<NetworkData | null>(null);
  const [failed, setFailed] = useState(false);
  const [assetPdaMap, setAssetPdaMap] = useState<Map<string, Asset>>(new Map());
  const [shareClassPdaMap, setShareClassPdaMap] = useState<
    Map<string, ShareClass>
  >(new Map());
  const [query, setQuery] = useState("");
  const [stateFilter, setStateFilter] = useState<StateFilter>("all");
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [showOpen, setShowOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const network = await loadNetworkPreferIndexer(() =>
        loadNetwork(client.runtime.rpc),
      );
      setData(network);

      // Resolve asset PDA → Asset.
      const assets = new Map<string, Asset>();
      for (const asset of network.assets) {
        const [pda] = await findAssetPda({
          issuer: asset.issuer,
          assetId: asset.assetId,
        });
        assets.set(pda.toString(), asset);
      }
      setAssetPdaMap(assets);

      // Resolve share-class PDA → ShareClass.
      const shareClasses = new Map<string, ShareClass>();
      for (const sc of network.shareClasses) {
        const scPda = await findShareClassPda(sc.asset, sc.classIndex);
        shareClasses.set(scPda.toString(), sc);
      }
      setShareClassPdaMap(shareClasses);
    } catch {
      setFailed(true);
    }
  }, [client]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  // Custody vaults are not in NetworkData yet — load them from the indexer
  // and fall back to a getProgramAccounts scan only if the indexer is empty.
  const [customVaults, setCustomVaults] = useState<CustodyVault[]>([]);
  const loadVaults = useCallback(async () => {
    try {
      const fromIndexer = await loadCustodyVaultsFromIndexer().catch(() => []);
      if (fromIndexer.length > 0) {
        setCustomVaults(fromIndexer);
        return;
      }
      // Fallback: on-chain scan.
      const {
        ASSET_REGISTRY_PROGRAM_ADDRESS,
        getCustodyVaultDecoder,
        getCustodyVaultDiscriminatorBytes,
      } = await import("@/lib/generated/asset_registry");
      const rpc = client.runtime.rpc;
      const res = await rpc
        .getProgramAccounts(ASSET_REGISTRY_PROGRAM_ADDRESS, {
          encoding: "base64",
        })
        .send();
      const disc = getCustodyVaultDiscriminatorBytes();
      const decoder = getCustodyVaultDecoder();
      const out: CustodyVault[] = [];
      for (const r of res) {
        const b64 = (r.account.data as readonly [string, string])[0];
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
        if (bytes.length < 8) continue;
        let match = true;
        for (let i = 0; i < 8; i += 1) {
          if (bytes[i] !== disc[i]) {
            match = false;
            break;
          }
        }
        if (match) out.push(decoder.decode(bytes));
      }
      setCustomVaults(out);
    } catch {
      setFailed(true);
    }
  }, [client]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadVaults();
  }, [loadVaults]);

  // Off-chain delivery requests (Supabase) — the holder-initiated flow that
  // drives DeliveryEscrow vaults below.
  // Helper: link vault → share class → asset.
  const vaultLinks = useMemo(() => {
    return customVaults.map((vault) => ({
      vault,
      shareClass: shareClassPdaMap.get(vault.shareClass.toString()),
      asset:
        shareClassPdaMap.get(vault.shareClass.toString()) &&
        assetPdaMap.get(
          shareClassPdaMap.get(vault.shareClass.toString())!.asset.toString(),
        ),
    }));
  }, [customVaults, shareClassPdaMap, assetPdaMap]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return vaultLinks
      .map((vl, i) => ({ ...vl, originalIndex: i }))
      .filter(({ vault, asset }) => {
        if (
          stateFilter !== "all" &&
          vault.state !== FILTER_TO_STATE[stateFilter]
        )
          return false;
        if (!q) return true;
        return (
          (asset?.name ?? "").toLowerCase().includes(q) ||
          String(vault.vaultId).includes(q) ||
          VAULT_TYPE_LABEL[vault.vaultType]?.toLowerCase().includes(q)
        );
      })
      .sort((a, b) => Number(b.vault.vaultId - a.vault.vaultId));
  }, [vaultLinks, query, stateFilter]);

  const selectedRow = useMemo(() => {
    if (selectedIdx === null) return null;
    return rows.find((r) => r.originalIndex === selectedIdx) ?? null;
  }, [rows, selectedIdx]);

  if (failed) {
    return (
      <p className="mt-8 text-sm text-red-600">
        Failed to load custody directory.
      </p>
    );
  }

  return (
    <div className="mt-8 space-y-6">
      <DeliveryRequestsSection onVaultsChanged={loadVaults} />

      <ConversionRequestsSection onVaultsChanged={loadVaults} />

      <div className="flex flex-wrap items-center gap-3">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by asset, vault ID, or type…"
          className="min-w-[280px] flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-slate-400"
        />
        <div className="flex gap-1 rounded-lg border border-slate-200 bg-white p-1 text-xs">
          {(
            [
              "all",
              "active",
              "triggered",
              "realized",
              "reverted",
              "expired",
              "returned",
            ] as const
          ).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStateFilter(s)}
              className={`rounded-md px-3 py-1.5 transition-colors ${
                stateFilter === s
                  ? "bg-slate-900 text-white"
                  : "text-slate-600 hover:bg-slate-100"
              }`}
            >
              {s === "all" ? "All" : s.charAt(0).toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setShowOpen(true)}
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
        >
          + Open vault
        </button>
      </div>

      {data === null ? (
        <SkeletonTable rows={5} cols={5} />
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-12 text-center shadow-card">
          <p className="text-sm text-slate-600">
            {customVaults.length === 0
              ? "No custody vaults opened yet."
              : "No vaults match the current filter."}
          </p>
          {customVaults.length === 0 && (
            <button
              type="button"
              onClick={() => setShowOpen(true)}
              className="mt-4 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
            >
              Open the first vault
            </button>
          )}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-card">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-100 bg-slate-50 text-left text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-4 py-3 font-medium">Vault</th>
                <th className="px-4 py-3 font-medium">Type</th>
                <th className="px-4 py-3 text-right font-medium">Amount</th>
                <th className="px-4 py-3 font-medium">Realize</th>
                <th className="px-4 py-3 font-medium">State</th>
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map(({ vault, asset, originalIndex }) => {
                const isSelected = selectedIdx === originalIndex;
                return (
                  <tr
                    key={originalIndex}
                    onClick={() =>
                      setSelectedIdx(isSelected ? null : originalIndex)
                    }
                    className={`cursor-pointer transition-colors ${
                      isSelected ? "bg-slate-50" : "hover:bg-slate-50/60"
                    }`}
                  >
                    <td className="px-4 py-3">
                      <p className="font-medium text-slate-900">
                        {asset?.name || "(asset unknown)"}
                      </p>
                      <p className="mt-0.5 text-xs text-slate-500">
                        vault #{String(vault.vaultId)}
                      </p>
                    </td>
                    <td className="px-4 py-3 text-slate-700">
                      {VAULT_TYPE_LABEL[vault.vaultType] ?? "?"}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-slate-700">
                      {String(vault.amount)}
                    </td>
                    <td className="px-4 py-3 text-slate-700">
                      {REALIZE_ACTION_LABEL[vault.realizeAction] ?? "?"}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
                          STATE_BADGE[vault.state] ?? STATE_BADGE[0]
                        }`}
                      >
                        {VAULT_STATE_LABEL[vault.state] ?? "?"}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span className="text-xs text-slate-500">
                        {isSelected ? "▾ collapse" : "▸ expand"}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {selectedRow && (
        <VaultDetail
          vault={selectedRow.vault}
          asset={selectedRow.asset}
          onRefresh={async () => {
            await refresh();
            await loadVaults();
          }}
          onClose={() => setSelectedIdx(null)}
        />
      )}

      {showOpen && data && (
        <OpenVaultModal
          data={data}
          onClose={() => setShowOpen(false)}
          onSuccess={() => {
            void refresh();
            void loadVaults();
            setShowOpen(false);
          }}
        />
      )}
    </div>
  );
}

function VaultDetail({
  vault,
  asset,
  onRefresh,
  onClose,
}: {
  vault: CustodyVault;
  asset: Asset | undefined;
  onRefresh: () => Promise<void>;
  onClose: () => void;
}) {
  const conn = useWalletConnection();
  const client = useSolanaClient();
  const tx = useSendTransaction();
  const toast = useToast();
  const wallet = conn.wallet?.account.address;
  const [confirmRealize, setConfirmRealize] = useState(false);
  const [confirmRevert, setConfirmRevert] = useState(false);
  const [confirmReturn, setConfirmReturn] = useState(false);
  const [vaultPda, setVaultPda] = useState<Address | null>(null);
  // Live escrow token balance. The DIFFERENCE against `vault.deposited` is
  // what decides whether a return needs the beneficiary's KYC — see the
  // "Escrow balance" field below.
  const [escrowBalance, setEscrowBalance] = useState<bigint | null>(null);
  // KYC at conversion / delivery (2C-3): a DeliveryEscrow realize needs the
  // beneficiary's passport in the registry the vault pinned at open.
  const kycGated = vault.vaultType === VaultType.DeliveryEscrow;
  const [passport, setPassport] = useState<PassportEvaluation | null>(null);

  useEffect(() => {
    if (!kycGated) return;
    let cancelled = false;
    async function loadPassport() {
      const result = await loadBeneficiaryPassport(client.runtime.rpc, {
        vaultType: vault.vaultType,
        beneficiary: vault.beneficiary,
        kycRegistry: vault.kycRegistry,
      });
      if (!cancelled) setPassport(result);
    }
    void loadPassport();
    return () => {
      cancelled = true;
    };
  }, [client, kycGated, vault.vaultType, vault.beneficiary, vault.kycRegistry, vault.state]);
  const realizeBlocked = kycGated ? passportBlockReason(passport) : null;

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const pda = await findCustodyVaultPda(vault.shareClass, vault.vaultId);
      if (!cancelled) setVaultPda(pda);
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [vault.shareClass, vault.vaultId]);

  useEffect(() => {
    let cancelled = false;
    async function loadBalance() {
      try {
        const res = await client.runtime.rpc
          .getTokenAccountBalance(vault.escrow)
          .send();
        if (!cancelled) setEscrowBalance(BigInt(res.value.amount));
      } catch {
        // Escrow closed / RPC hiccup — leave it unknown rather than claiming 0.
        if (!cancelled) setEscrowBalance(null);
      }
    }
    void loadBalance();
    return () => {
      cancelled = true;
    };
  }, [client, vault.escrow, vault.state, vault.deposited]);

  // Split preview, mirroring util.rs `split_escrow_release`: at most
  // `deposited` comes back to the beneficiary with NO receiver check (their
  // own property), and any SURPLUS above the ledger is a delivery that only
  // goes out if the beneficiary's KycEntry passes. A withheld surplus keeps
  // the vault open — `return_custody_vault` is only terminal when it fully
  // drains the escrow.
  const release =
    escrowBalance === null
      ? null
      : previewEscrowRelease(escrowBalance, vault.deposited);
  const surplus = release?.surplus ?? null;

  async function trigger() {
    if (!wallet || !vaultPda) return;
    const pendingId = toast.showPending(`Triggering vault #${vault.vaultId}…`);
    try {
      const signer = walletSigner(conn.wallet);
      const ix = getTriggerCustodyVaultInstruction({
        authority: signer,
        custodyVault: vaultPda,
        authorityAdminRecord: await custodyAuthorityRecord(
          client.runtime.rpc,
          vaultPda,
        ),
      });
      // send() resolves with the confirmed signature; tx.signature is stale
      // state from the render this closure was created in.
      const sig = await tx.send({ instructions: [ix], feePayer: signer });
      toast.dismiss(pendingId);
      toast.showTx(sig, { title: "Vault triggered" });
      await onRefresh();
    } catch (err) {
      toast.dismiss(pendingId);
      toast.showError(
        "Failed to trigger",
        explainSendError(err),
      );
    }
  }

  async function realize(reason: string) {
    if (!wallet || !vaultPda) return;
    const target = `vault #${vault.vaultId}`;
    const pendingId = toast.showPending(`Realizing ${target}…`, reason);
    try {
      const signer = walletSigner(conn.wallet);
      // escrowMarker (["escrow_marker", vault PDA]) is auto-derived by the
      // async builder — closed on-chain by this terminal path. A
      // DeliveryEscrow also passes its pinned registry and the beneficiary's
      // KycEntry (2C-3); other types pass neither.
      const ix = await getRealizeCustodyVaultInstructionAsync({
        authority: signer,
        shareClass: vault.shareClass,
        custodyVault: vaultPda,
        authorityAdminRecord: await custodyAuthorityRecord(
          client.runtime.rpc,
          vaultPda,
        ),
        mint: vault.mint,
        escrow: vault.escrow,
        tokenProgram: TOKEN_2022_ADDRESS,
        ...(await realizeKycAccounts(vault)),
      });
      const sig = await tx.send({ instructions: [ix], feePayer: signer });
      toast.dismiss(pendingId);
      toast.showTx(sig, { title: "Vault realized" });
      void recordAudit({
        ix_name: "realize_custody",
        category: "custody",
        actor_wallet: wallet.toString(),
        reason,
        target_label: target,
        tx_signature: sig,
        metadata: {
          vault_pda: vaultPda.toString(),
          realize_action: vault.realizeAction,
          kyc_registry: kycGated ? vault.kycRegistry.toString() : null,
        },
      });
      setConfirmRealize(false);
      await onRefresh();
    } catch (err) {
      toast.dismiss(pendingId);
      const message = explainSendError(err);
      toast.showError("Failed to realize", message);
      void recordAudit({
        ix_name: "realize_custody",
        category: "custody",
        actor_wallet: wallet.toString(),
        reason,
        target_label: target,
        status: "failed",
        metadata: { vault_pda: vaultPda.toString(), error: message },
      });
    }
  }

  async function revert(reason: string) {
    if (!wallet || !vaultPda) return;
    const target = `vault #${vault.vaultId}`;
    const pendingId = toast.showPending(`Reverting ${target}…`, reason);
    try {
      const signer = walletSigner(conn.wallet);
      // escrowMarker (["escrow_marker", vault PDA]) is auto-derived by the
      // async builder — closed on-chain by this terminal path.
      const ix = await getRevertCustodyVaultInstructionAsync({
        payer: signer,
        shareClass: vault.shareClass,
        custodyVault: vaultPda,
        authorityAdminRecord: await custodyAuthorityRecord(
          client.runtime.rpc,
          vaultPda,
        ),
        mint: vault.mint,
        escrow: vault.escrow,
        tokenProgram: TOKEN_2022_ADDRESS,
      });
      const sig = await tx.send({ instructions: [ix], feePayer: signer });
      toast.dismiss(pendingId);
      toast.showTx(sig, { title: "Vault reverted" });
      void recordAudit({
        ix_name: "revert_custody",
        category: "custody",
        actor_wallet: wallet.toString(),
        reason,
        target_label: target,
        tx_signature: sig,
        metadata: { vault_pda: vaultPda.toString() },
      });
      setConfirmRevert(false);
      await onRefresh();
    } catch (err) {
      toast.dismiss(pendingId);
      const message = explainSendError(err);
      toast.showError("Failed to revert", message);
      void recordAudit({
        ix_name: "revert_custody",
        category: "custody",
        actor_wallet: wallet.toString(),
        reason,
        target_label: target,
        status: "failed",
        metadata: { vault_pda: vaultPda.toString(), error: message },
      });
    }
  }

  // 2D: the local half of the reclaim gate (the linked-request half needs the
  // signed request queues and runs on click).
  const reclaimBlocked = custodyReclaimBlocker({
    wallet: wallet?.toString(),
    authority: vault.authority.toString(),
    terminal:
      vault.state === VaultState.Realized ||
      vault.state === VaultState.Reverted ||
      vault.state === VaultState.Returned,
    escrowBalance,
    linked: [],
  });

  /**
   * 2D: close the settled vault's empty escrow and tombstone the vault; all
   * rent goes to the vault authority. Always its OWN transaction, never
   * bundled with realize / return: the request evidence parsers need the
   * escrow's post balance from those transactions.
   */
  async function closeVault() {
    if (!wallet || !conn.wallet || !vaultPda) return;
    const target = `vault #${vault.vaultId}`;
    const pendingId = toast.showPending(`Closing ${target}…`);
    try {
      const [deliveries, conversions] = await Promise.all([
        adminListDeliveryRequests(conn.wallet),
        adminListConversionRequests(conn.wallet),
      ]);
      const linked = [...deliveries, ...conversions].filter(
        (request) => request.vault_pda === vaultPda.toString(),
      ) as { status: string; outcome_evidence?: unknown }[];
      const blocker = custodyReclaimBlocker({
        wallet: wallet.toString(),
        authority: vault.authority.toString(),
        terminal: true,
        escrowBalance,
        linked,
      });
      if (blocker) throw new Error(blocker);
      const signer = walletSigner(conn.wallet);
      const ix = reclaimCustodyVault({
        authority: signer,
        vault: vaultPda,
        data: vault,
      });
      const sig = await tx.send({ instructions: [ix], feePayer: signer });
      toast.dismiss(pendingId);
      toast.showTx(sig, { title: "Vault closed, rent reclaimed" });
      void recordAudit({
        ix_name: "reclaim_rent",
        category: "custody",
        actor_wallet: wallet.toString(),
        reason: "Close a settled custody vault and reclaim its rent",
        target_label: target,
        tx_signature: sig,
        metadata: { vault_pda: vaultPda.toString() },
      });
      onClose();
      await onRefresh();
    } catch (err) {
      toast.dismiss(pendingId);
      toast.showError("Failed to close the vault", explainSendError(err));
    }
  }

  /**
   * Return a DeliveryEscrow vault's deposit to its on-chain beneficiary. For
   * manually-opened delivery vaults (not tied to a request-queue row) this is
   * the only exit besides confirm-and-burn.
   *
   * NOT necessarily terminal. `return_custody_vault` splits the escrow against
   * the vault's deposit ledger: up to `deposited` goes back unconditionally,
   * and the surplus above it goes out only if the beneficiary's KYC passes.
   * When a surplus is WITHHELD the handler leaves the vault `Active` /
   * `Triggered` with its EscrowMarker open, so the remainder still has an exit
   * (a second, fully-gated return once the passport is valid, or trigger +
   * realize to burn it). Terminality is therefore READ BACK from the account
   * after the transaction, never assumed.
   */
  async function returnToHolder(reason: string) {
    if (!wallet || !vaultPda) return;
    const target = `vault #${vault.vaultId}`;
    const beneficiary = vault.beneficiary;
    const pendingId = toast.showPending(
      `Returning ${target} to holder…`,
      reason,
    );
    try {
      const signer = walletSigner(conn.wallet);
      const [escrow] = await findOpenCustodyVaultEscrowPda({
        custodyVault: vaultPda,
      });
      const [beneficiaryAta] = await findAssociatedTokenPda({
        owner: beneficiary,
        tokenProgram: TOKEN_2022_ADDRESS,
        mint: vault.mint,
      });
      const createAtaIx =
        await getCreateAssociatedTokenIdempotentInstructionAsync({
          payer: signer,
          owner: beneficiary,
          mint: vault.mint,
          tokenProgram: TOKEN_2022_ADDRESS,
        });
      const baseIx = await getReturnCustodyVaultInstructionAsync({
        signer,
        shareClass: vault.shareClass,
        custodyVault: vaultPda,
        authorityAdminRecord: await custodyAuthorityRecord(
          client.runtime.rpc,
          vaultPda,
        ),
        mint: vault.mint,
        escrow,
        beneficiaryTokenAccount: beneficiaryAta,
        tokenProgram: TOKEN_2022_ADDRESS,
      });
      const returnIx = {
        ...baseIx,
        accounts: [
          ...baseIx.accounts,
          ...(await hookTransferMetas(client.runtime.rpc, vault.mint, {
            sourceTokenAccount: escrow,
            destTokenAccount: beneficiaryAta,
            transferAuthority: vaultPda,
            sourceOwner: vaultPda,
            destOwner: beneficiary,
          })),
        ],
      };
      const sig = await tx.send({
        instructions: [createAtaIx, returnIx],
        feePayer: signer,
      });
      // Read the outcome back: `Returned` means the escrow was fully drained
      // and the vault is closed; still `Active`/`Triggered` means a surplus
      // was withheld (the beneficiary's KycEntry did not pass for the
      // un-deposited part) and the vault is deliberately still open.
      const outcome = await readReturnOutcome(client.runtime.rpc, vaultPda);
      toast.dismiss(pendingId);
      toast.showTx(sig, {
        title: outcome.terminal
          ? "Returned to holder — vault closed"
          : "Partial return — vault still open",
      });
      if (!outcome.terminal) {
        toast.showError("Some units were withheld", PARTIAL_RETURN_HINT);
      }
      void recordAudit({
        ix_name: "return_custody_vault",
        category: "custody",
        actor_wallet: wallet.toString(),
        reason,
        target_label: target,
        tx_signature: sig,
        metadata: {
          vault_pda: vaultPda.toString(),
          terminal: outcome.terminal,
          deposited_after: outcome.depositedAfter?.toString() ?? null,
        },
      });
      setConfirmReturn(false);
      await onRefresh();
    } catch (err) {
      toast.dismiss(pendingId);
      toast.showError(
        "Failed to return",
        explainSendError(err),
      );
    }
  }

  const deadlineDisplay =
    vault.deadline === BigInt(0)
      ? "no deadline"
      : new Date(Number(vault.deadline) * 1000).toISOString().slice(0, 16) +
        "Z";

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-card">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            Vault detail
          </p>
          <h3 className="mt-1 text-lg font-semibold text-slate-900">
            {asset?.name ?? "(asset unknown)"} · vault #{String(vault.vaultId)}
          </h3>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-xs text-slate-400 hover:text-slate-700"
        >
          Close ✕
        </button>
      </div>

      <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
        <Field label="Type" value={VAULT_TYPE_LABEL[vault.vaultType] ?? "?"} />
        <Field label="State" value={VAULT_STATE_LABEL[vault.state] ?? "?"} />
        <Field label="Amount" value={String(vault.amount)} />
        {/* Ledger vs balance. `deposited` is what the beneficiary put in
            through `deposit_to_custody_vault`; the escrow balance is whatever
            the token account actually holds (anyone can raw-transfer into it).
            A return releases the ledger unconditionally and the surplus only
            to a KYC-passing receiver — so the DIFFERENCE is what decides
            whether a return needs KYC and whether it closes the vault. */}
        <Field label="Deposited (ledger)" value={String(vault.deposited)} />
        <Field
          label="Escrow balance"
          value={escrowBalance === null ? "unknown" : String(escrowBalance)}
        />
        <Field
          label="Un-ledgered surplus"
          value={
            surplus === null
              ? "unknown"
              : surplus === BigInt(0)
                ? "0 — a return is KYC-free and closes the vault"
                : `${surplus} — needs the beneficiary's KYC; withheld otherwise`
          }
        />
        <Field
          label="Realize action"
          value={REALIZE_ACTION_LABEL[vault.realizeAction] ?? "?"}
        />
        <Field label="Deadline" value={deadlineDisplay} />
        <Field label="Authority" value={vault.authority.toString()} mono />
        <Field label="Mint" value={vault.mint.toString()} mono />
        <Field label="Escrow" value={vault.escrow.toString()} mono />
        <Field label="Vault PDA" value={vaultPda?.toString() ?? "…"} mono />
        {kycGated && (
          <Field label="Beneficiary" value={vault.beneficiary.toString()} mono />
        )}
      </dl>

      {kycGated && (
        <BeneficiaryPassport
          passport={passport}
          registry={vault.kycRegistry.toString()}
          shortcutHref={passportShortcutHref({
            clientId: null,
            wallet: vault.beneficiary.toString(),
          })}
        />
      )}

      {vaultPda && (
        <CustodyAuthorityTransfer vaultPda={vaultPda} onRefresh={onRefresh} />
      )}

      {/* State diagram */}
      <div className="mt-5 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          Lifecycle
        </p>
        <div className="mt-2 flex items-center gap-2 text-xs">
          {VAULT_STATE_LABEL.map((label, i) => (
            <span key={label} className="flex items-center gap-2">
              <span
                className={`rounded-full px-2 py-0.5 ${
                  vault.state === i
                    ? "bg-slate-900 text-white"
                    : "bg-white text-slate-500 border border-slate-200"
                }`}
              >
                {label}
              </span>
              {i < VAULT_STATE_LABEL.length - 1 && (
                <span className="text-slate-300">→</span>
              )}
            </span>
          ))}
        </div>
      </div>

      {/* State-driven actions */}
      <div className="mt-6 space-y-3 border-t border-slate-100 pt-5">
        <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
          Available actions
        </p>
        <div className="flex flex-wrap gap-2">
          {vault.state === VaultState.Active && (
            <button
              type="button"
              disabled={tx.isSending}
              onClick={() => void trigger()}
              className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
            >
              Trigger
            </button>
          )}
          {vault.state === VaultState.Triggered && (
            <button
              type="button"
              disabled={tx.isSending || realizeBlocked !== null}
              title={realizeBlocked ?? undefined}
              onClick={() => setConfirmRealize(true)}
              className="rounded-lg border border-red-300 bg-red-50 px-4 py-2 text-sm font-medium text-red-900 hover:bg-red-100 disabled:opacity-50"
            >
              Realize
            </button>
          )}
          {/* revert_custody_vault requires Active on-chain. */}
          {vault.vaultType !== VaultType.DeliveryEscrow &&
            vault.state === VaultState.Active && (
              <button
                type="button"
                disabled={tx.isSending}
                onClick={() => setConfirmRevert(true)}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:border-slate-400 disabled:opacity-50"
              >
                Revert
              </button>
            )}
          {vault.vaultType === VaultType.DeliveryEscrow &&
            (vault.state === VaultState.Active ||
              vault.state === VaultState.Triggered) && (
              <>
                <button
                  type="button"
                  disabled={tx.isSending}
                  onClick={() => setConfirmReturn(true)}
                  className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:border-slate-400 disabled:opacity-50"
                >
                  Return to holder
                </button>
                <p className="w-full text-xs text-slate-500">
                  Delivery / conversion escrows hold a holder&apos;s own deposit
                  — revert (burn) is banned on-chain. Return sends the deposit
                  back to the vault&apos;s beneficiary; confirm &amp; burn is
                  offered from the request queue and needs the holder&apos;s
                  approved investor passport. Without a passport the
                  holder&apos;s deposit can be returned.
                </p>
                {vault.state === VaultState.Triggered && realizeBlocked && (
                  <p className="w-full text-xs text-amber-700">
                    Realize is disabled: {realizeBlocked}
                  </p>
                )}
              </>
            )}
          {(vault.state === VaultState.Realized ||
            vault.state === VaultState.Reverted ||
            vault.state === VaultState.Returned) && (
            <>
              <button
                type="button"
                disabled={tx.isSending || reclaimBlocked !== null}
                title={
                  reclaimBlocked ??
                  "Closes the empty escrow and returns all rent to you (the vault authority)."
                }
                onClick={() => void closeVault()}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:border-slate-400 disabled:opacity-50"
              >
                Close vault &amp; reclaim rent
              </button>
              <p className="w-full text-xs text-slate-500">
                Vault is in a terminal state.{" "}
                {reclaimBlocked ??
                  "Closing it keeps its ID reserved forever; any linked request must already record its verified outcome."}
              </p>
            </>
          )}
        </div>
      </div>

      <ConfirmModal
        open={confirmRealize}
        onClose={() => setConfirmRealize(false)}
        onConfirm={(reason) => realize(reason)}
        title={`Realize vault #${vault.vaultId}`}
        kind="destructive"
        confirmLabel="Realize"
        description={
          <>
            <p>
              Realizing executes the configured action (
              <strong>
                {REALIZE_ACTION_LABEL[vault.realizeAction] ?? "unknown"}
              </strong>
              ) — burning the underlying or transferring to beneficiary. This is{" "}
              <strong>irreversible</strong>.
            </p>
            <p className="mt-2 text-xs text-slate-500">
              Verify off-chain delivery prerequisites are complete (KYC, legal
              docs, buyer confirmation). Reason recorded in audit log.
            </p>
          </>
        }
        busy={tx.isSending}
      />
      <ConfirmModal
        open={confirmRevert}
        onClose={() => setConfirmRevert(false)}
        onConfirm={(reason) => revert(reason)}
        title={`Revert vault #${vault.vaultId}`}
        kind="warning"
        confirmLabel="Revert"
        description={
          <>
            <p>
              Reverting <strong>burns</strong> the escrowed balance (undoing a
              provisional mint) and closes the vault. It is only valid for
              vaults that hold provisional mints — never for delivery or
              conversion escrows, which hold a holder&apos;s own deposit and
              exit via return instead.
            </p>
            <p className="mt-2 text-xs text-amber-700">
              On-chain authorization: the vault authority may revert once the
              deadline allows; anyone else needs a POSITIVE deadline that has
              already passed. A vault opened with{" "}
              <code className="font-mono">deadline = 0</code> (the quarantine
              default) is authority-only — a foreign signer gets
              RevertNotAllowed.
            </p>
            <p className="mt-2 text-xs text-slate-500">
              Reason recorded in audit log.
            </p>
          </>
        }
        busy={tx.isSending}
      />
      <ConfirmModal
        open={confirmReturn}
        onClose={() => setConfirmReturn(false)}
        onConfirm={(reason) => returnToHolder(reason)}
        title={`Return vault #${vault.vaultId} to holder`}
        kind="warning"
        confirmLabel="Return to holder"
        description={
          <>
            <p>
              Returns the escrowed deposit to the vault&apos;s on-chain
              beneficiary. Use this to unwind a delivery / conversion escrow
              that will not proceed. Reason recorded in audit log.
            </p>
            {surplus !== null && surplus > BigInt(0) ? (
              <p className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                The escrow holds{" "}
                <strong>{String(surplus)} un-ledgered unit(s)</strong> on top of
                the beneficiary&apos;s recorded {String(vault.deposited)}. Those
                did not come from the beneficiary, so releasing them is a
                delivery and requires their investor passport to pass. If it
                does not, only the recorded deposit goes out and{" "}
                <strong>the vault stays open</strong> so the remainder can still
                be swept later or burned.
              </p>
            ) : (
              <p className="mt-2 text-xs text-slate-500">
                The escrow holds nothing beyond the beneficiary&apos;s recorded
                deposit, so this return is KYC-free and closes the vault.
              </p>
            )}
          </>
        }
        busy={tx.isSending}
      />
    </div>
  );
}

/** The KYC registry a new DeliveryEscrow pins (2C-3): the platform registry
 *  (`NEXT_PUBLIC_KYC_REGISTRY`, or the resolved one when unpinned). `error`
 *  explains why none is usable; the open stays blocked until it resolves. */
function usePlatformKycRegistry(enabled: boolean): {
  registry: Address | null;
  error: string | null;
} {
  const client = useSolanaClient();
  const [state, setState] = useState<{ registry: Address | null; error: string | null }>({
    registry: null,
    error: null,
  });
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    async function resolve() {
      try {
        const ctx = await loadKycAuthorityContext(client.runtime.rpc);
        const reason = kycRegistryUnavailableReason(ctx, detectNetwork());
        const next = ctx.registry
          ? { registry: ctx.registry.address, error: null }
          : {
              registry: null,
              error:
                reason ??
                "No KYC registry exists yet — create the platform registry on /admin/kyc first.",
            };
        if (!cancelled) setState(next);
      } catch (err) {
        if (!cancelled)
          setState({
            registry: null,
            error: `Could not resolve the platform KYC registry: ${
              err instanceof Error ? err.message : String(err)
            }`,
          });
      }
    }
    void resolve();
    return () => {
      cancelled = true;
    };
  }, [client, enabled]);
  return state;
}

/** The holder's passport in `registry` — shown when a request is approved
 *  (information only: opening and depositing need no KYC). */
function useHolderPassport(
  registry: Address | null,
  holderWallet: string,
): PassportEvaluation | null {
  const client = useSolanaClient();
  const [passport, setPassport] = useState<PassportEvaluation | null>(null);
  useEffect(() => {
    if (!registry) return;
    let cancelled = false;
    async function loadPassport() {
      const result = await loadBeneficiaryPassport(client.runtime.rpc, {
        vaultType: VaultType.DeliveryEscrow,
        beneficiary: holderWallet,
        kycRegistry: registry!,
      });
      if (!cancelled) setPassport(result);
    }
    void loadPassport();
    return () => {
      cancelled = true;
    };
  }, [client, registry, holderWallet]);
  return passport;
}

/** Read-only line naming the registry a DeliveryEscrow will pin. */
function PinnedRegistryLine({
  registry,
  error,
}: {
  registry: Address | null;
  error: string | null;
}) {
  return (
    <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs">
      <p className="font-medium uppercase tracking-wide text-slate-500">
        KYC registry pinned on the vault
      </p>
      {registry ? (
        <p className="mt-1 break-all font-mono text-slate-700">{registry}</p>
      ) : (
        <p className="mt-1 text-red-600">{error ?? "Resolving the platform KYC registry…"}</p>
      )}
      <p className="mt-1 text-slate-500">
        Opening and depositing need no KYC. Confirming the conversion / delivery
        (realize) requires the holder&apos;s approved investor passport in this
        registry; without one the deposit can only be returned.
      </p>
    </div>
  );
}

function OpenVaultModal({
  data,
  onClose,
  onSuccess,
}: {
  data: NetworkData;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const conn = useWalletConnection();
  const tx = useSendTransaction();
  const toast = useToast();
  const wallet = conn.wallet?.account.address;

  const [issuerLegalId, setIssuerLegalId] = useState("");
  const [assetId, setAssetId] = useState("");
  const [classIndex, setClassIndex] = useState("0");
  const [vaultId, setVaultId] = useState("1");
  const [vaultType, setVaultType] = useState<VaultType>(VaultType.Vesting);
  const [realizeAction, setRealizeAction] = useState<RealizeAction>(
    RealizeAction.BurnAndAttest,
  );
  const [amount, setAmount] = useState("");
  const [deadlineDate, setDeadlineDate] = useState("");
  const [beneficiary, setBeneficiary] = useState("");
  // A DeliveryEscrow pins the platform KYC registry (2C-3); every other type
  // passes none (the program refuses a pin on them).
  const platformRegistry = usePlatformKycRegistry(
    vaultType === VaultType.DeliveryEscrow,
  );
  const registryBlock =
    vaultType === VaultType.DeliveryEscrow && platformRegistry.registry === null
      ? (platformRegistry.error ?? "Resolving the platform KYC registry…")
      : null;
  // realize_custody_vault only implements BurnAndAttest; a vault opened with
  // any other action could never be realized, reverted or returned. The
  // option is disabled in the <select>, and this guard also covers a value
  // that reached state some other way (tampered DOM, stale draft).
  const realizeActionError = unsupportedRealizeActionReason(realizeAction);

  // Attestation document / hash → metadata_hash (no more zero hashes).
  const [attFile, setAttFile] = useState<File | null>(null);
  const [attFileHash, setAttFileHash] = useState("");
  const [attPasted, setAttPasted] = useState("");
  const attHash = attFile ? attFileHash : attPasted.trim().toLowerCase();
  const attHashOk = isValidSha256Hex(attHash);
  const vaultKindSlug =
    (["vesting", "conversion", "delivery", "redemption"] as const)[vaultType] ??
    "other";

  const matchedIssuer = useMemo(() => {
    if (!issuerLegalId.trim()) return null;
    return (
      data.issuers.find(
        (i) => fromBytes32(i.legalEntityId) === issuerLegalId.trim(),
      ) ?? null
    );
  }, [data, issuerLegalId]);

  async function openVault() {
    if (
      !wallet ||
      !issuerLegalId.trim() ||
      !assetId.trim() ||
      !amount.trim() ||
      !attHashOk ||
      registryBlock !== null
    )
      return;
    try {
      assertSupportedRealizeAction(realizeAction);
    } catch (e) {
      toast.showError(
        "Unsupported realize action",
        e instanceof Error ? e.message : String(e),
      );
      return;
    }
    const pendingId = toast.showPending(`Opening vault #${vaultId}…`);
    try {
      // Store the attestation document first (when one was picked) so the
      // on-chain hash always references a retrievable file. Off-platform
      // documents skip this — the pasted hash is the reference.
      if (attFile) {
        await uploadAttestationDoc(
          conn.wallet,
          vaultKindSlug,
          attFile,
          attHash,
        );
      }
      const [ip] = await findIssuerPda({
        legalEntityId: toBytes32(issuerLegalId.trim()),
      });
      const [ap] = await findAssetPda({
        issuer: ip,
        assetId: assetId.trim(),
      });
      const scPda = await findShareClassPda(ap, Number(classIndex) || 0);
      const sc = data.shareClasses.find(
        (x) =>
          x.classIndex === (Number(classIndex) || 0) &&
          x.asset.toString() === ap.toString(),
      );
      if (!sc) {
        toast.dismiss(pendingId);
        toast.showError(
          "Share class not found",
          "Verify issuer ID, asset ID and class index.",
        );
        return;
      }
      if (!sc.mintInitialized) {
        toast.dismiss(pendingId);
        toast.showError(
          "Share class mint not initialized",
          "Initialize the Token-2022 mint first.",
        );
        return;
      }
      // A DeliveryEscrow MUST have a real (>=24h) deadline — deadline 0 disables
      // the permissionless post-deadline return path (the holder's safety net).
      if (vaultType === VaultType.DeliveryEscrow) {
        const err = deliveryDeadlineError(deadlineDate);
        if (err) {
          toast.dismiss(pendingId);
          toast.showError("Invalid deadline", err);
          return;
        }
      }
      const deadlineBig = deadlineDate.trim()
        ? BigInt(Math.floor(new Date(deadlineDate).getTime() / 1000))
        : BigInt(0);
      const signer = walletSigner(conn.wallet);
      const ix = await getOpenCustodyVaultInstructionAsync({
        authority: signer,
        shareClass: scPda,
        mint: sc.mint,
        tokenProgram: TOKEN_2022_ADDRESS,
        vaultId: BigInt(vaultId || "0"),
        vaultType,
        realizeAction,
        amount: BigInt(amount),
        deadline: deadlineBig,
        metadataHash: hexToBytes32(attHash),
        beneficiary:
          vaultType === VaultType.DeliveryEscrow
            ? address(beneficiary.trim())
            : address("11111111111111111111111111111111"),
        ...(vaultType === VaultType.DeliveryEscrow && platformRegistry.registry
          ? { kycRegistry: platformRegistry.registry }
          : {}),
      });
      const sig = await tx.send({ instructions: [ix], feePayer: signer });
      toast.dismiss(pendingId);
      toast.showTx(sig, { title: "Vault opened" });
      onSuccess();
    } catch (err) {
      toast.dismiss(pendingId);
      toast.showError(
        "Failed to open vault",
        explainSendError(err),
      );
    }
  }

  if (!wallet) return null;

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center overflow-y-auto bg-slate-900/40 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !tx.isSending) onClose();
      }}
    >
      <div className="mx-auto w-full max-w-2xl overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl">
        <div className="border-b border-slate-100 px-5 py-4">
          <p className="text-sm font-semibold uppercase tracking-wide text-slate-700">
            Open custody vault
          </p>
        </div>
        <div className="space-y-4 px-5 py-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="block sm:col-span-2">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Issuer legal entity ID
              </span>
              <input
                value={issuerLegalId}
                maxLength={32}
                onChange={(e) => setIssuerLegalId(e.target.value)}
                placeholder="e.g. ACME-DOO-2026"
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              />
              {issuerLegalId.trim() && matchedIssuer === null && (
                <span className="mt-1 block text-[11px] text-amber-700">
                  No issuer with this legal entity ID.
                </span>
              )}
            </label>
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Class index
              </span>
              <input
                value={classIndex}
                inputMode="numeric"
                onChange={(e) =>
                  setClassIndex(e.target.value.replace(/\D/g, ""))
                }
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              />
            </label>
            <label className="block sm:col-span-2">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Asset ID
              </span>
              <input
                value={assetId}
                maxLength={32}
                onChange={(e) => setAssetId(e.target.value)}
                placeholder="e.g. SERIES-A"
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Vault ID
              </span>
              <input
                value={vaultId}
                inputMode="numeric"
                onChange={(e) => setVaultId(e.target.value.replace(/\D/g, ""))}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              />
            </label>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Vault type
              </span>
              <select
                value={vaultType}
                onChange={(e) =>
                  setVaultType(Number(e.target.value) as VaultType)
                }
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              >
                {VAULT_TYPE_LABEL.map((label, i) =>
                  // 2D: ConversionPending is retired on-chain
                  // (VaultTypeRetired); holder conversions are Delivery
                  // escrows from the request queue. The label stays for
                  // display of any legacy vault.
                  i === VaultType.ConversionPending ? null : (
                    <option key={i} value={i}>
                      {label}
                    </option>
                  ),
                )}
              </select>
            </label>
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Realize action
              </span>
              <select
                value={realizeAction}
                onChange={(e) =>
                  setRealizeAction(Number(e.target.value) as RealizeAction)
                }
                aria-describedby="custody-realize-action-support"
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              >
                {realizeActionOptions().map((option) => (
                  <option
                    key={option.value}
                    value={option.value}
                    disabled={option.disabled}
                  >
                    {option.disabled
                      ? `${option.label} — not supported yet`
                      : option.label}
                  </option>
                ))}
              </select>
              <p
                id="custody-realize-action-support"
                className={`mt-1 text-xs ${
                  realizeActionError ? "font-medium text-red-600" : "text-slate-500"
                }`}
              >
                {realizeActionError ??
                  "Only Burn & attest can be realized on-chain today. Transfer to beneficiary and Burn & payout are listed for completeness but cannot be selected: a vault opened with them could never be realized, reverted or returned."}
              </p>
            </label>
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Amount (units)
              </span>
              <input
                value={amount}
                inputMode="numeric"
                onChange={(e) => setAmount(e.target.value.replace(/\D/g, ""))}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Deadline (optional)
              </span>
              <input
                type="datetime-local"
                value={deadlineDate}
                onChange={(e) => setDeadlineDate(e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              />
            </label>
            {vaultType === VaultType.DeliveryEscrow && (
              <label className="block sm:col-span-2">
                <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                  Beneficiary wallet
                </span>
                <input
                  value={beneficiary}
                  onChange={(e) => setBeneficiary(e.target.value)}
                  placeholder="Token holder wallet that receives tokens back on cancel"
                  className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-xs focus:border-slate-400 focus:outline-none"
                />
              </label>
            )}
          </div>
          {vaultType === VaultType.DeliveryEscrow && (
            <PinnedRegistryLine
              registry={platformRegistry.registry}
              error={platformRegistry.error}
            />
          )}
          <AttestationDocSection
            kindLabel="underlying agreement or vault spec"
            file={attFile}
            fileHash={attFileHash}
            pastedHash={attPasted}
            onFileChange={(f, hex) => {
              setAttFile(f);
              setAttFileHash(hex);
            }}
            onPastedChange={setAttPasted}
            disabled={tx.isSending}
          />
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-100 bg-slate-50 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={tx.isSending}
            className="rounded-md px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-200 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void openVault()}
            disabled={
              tx.isSending ||
              realizeActionError !== null ||
              !issuerLegalId.trim() ||
              !assetId.trim() ||
              !amount.trim() ||
              !attHashOk ||
              registryBlock !== null ||
              (vaultType === VaultType.DeliveryEscrow &&
                (!beneficiary.trim() ||
                  deliveryDeadlineError(deadlineDate) !== null))
            }
            className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {tx.isSending ? "Sending…" : "Open vault"}
          </button>
        </div>
      </div>
    </div>
  );
}

function conversionTargetLabel(req: ConversionRequest): string {
  return `conversion ${req.id.slice(0, 8)} · ${req.asset_label || req.mint}`;
}

function shortAddr(value: string): string {
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

/** Truncated mono address with a copy affordance — used wherever the admin
 *  must verify the ON-CHAIN identity instead of a holder-supplied label. */
function CopyableAddress({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1 font-mono text-[11px] text-slate-500">
      <span className="text-slate-400">{label}</span>
      <span title={value}>{shortAddr(value)}</span>
      <button
        type="button"
        title={`Copy ${label}: ${value}`}
        onClick={() => void navigator.clipboard.writeText(value)}
        className="rounded border border-slate-200 px-1 text-[10px] text-slate-500 hover:border-slate-400 hover:text-slate-700"
      >
        copy
      </button>
    </span>
  );
}

/** On-chain facts about a request's custody vault the queue must not act
 *  without: current state (deposit/cancel gating), authority (trigger /
 *  realize / pre-deadline return are bound to the wallet that OPENED it) and
 *  deadline (after it, return is permissionless for any signer). */
type VaultOnChainInfo = {
  state: VaultState;
  authority: string;
  deadline: bigint;
  vaultType: VaultType;
  beneficiary: string;
  /** Registry pinned at open (2C-3); `1111…1111` for non-delivery vaults. */
  kycRegistry: string;
  /** Beneficiary passport in the pinned registry (DeliveryEscrow only). */
  passport: PassportEvaluation | null;
};

/** Reads a request's vault and, for a DeliveryEscrow, its beneficiary's
 *  passport. Null when the vault does not exist. */
async function readVaultOnChainInfo(
  rpc: Parameters<typeof fetchMaybeLiveCustodyVault>[0],
  vaultPda: Address,
): Promise<VaultOnChainInfo | null> {
  const maybe = await fetchMaybeLiveCustodyVault(rpc, vaultPda);
  if (!maybe.exists) return null;
  const v = maybe.data;
  return {
    state: v.state,
    authority: v.authority.toString(),
    deadline: v.deadline,
    vaultType: v.vaultType,
    beneficiary: v.beneficiary.toString(),
    kycRegistry: v.kycRegistry.toString(),
    passport:
      v.vaultType === VaultType.DeliveryEscrow
        ? await loadBeneficiaryPassport(rpc, v)
        : null,
  };
}

/** Fetches the live vault right before realize and returns the KYC accounts
 *  its realize needs (the pinned registry + the beneficiary's entry). */
async function requestRealizeKycAccounts(
  rpc: Parameters<typeof fetchMaybeLiveCustodyVault>[0],
  vaultPda: Address,
) {
  const maybe = await fetchMaybeLiveCustodyVault(rpc, vaultPda);
  if (!maybe.exists) throw new Error(`Custody vault ${vaultPda} not found`);
  return realizeKycAccounts(maybe.data);
}

/** The holder's passport for one request row, with the issue shortcut. */
/** Why a request row has no vault info: the vault account does not exist, or
 *  the read failed (retryable). */
type VaultLoadIssue = "missing" | "error";

/** passportBlockReason for a request row: says why the passport is unknown
 *  instead of "Checking…" when the vault is missing, unreadable or not a
 *  KYC-gated DeliveryEscrow. */
function requestPassportBlock(
  info: VaultOnChainInfo | undefined,
  issue: VaultLoadIssue | undefined,
): string | null {
  if (info === undefined && issue === "missing")
    return "The linked custody vault was not found on-chain.";
  if (info === undefined && issue === "error")
    return "Could not read the custody vault or the holder's investor passport — retry.";
  if (info !== undefined && info.passport === null)
    return "The linked vault is not a KYC-gated DeliveryEscrow — return the deposit instead.";
  return passportBlockReason(info?.passport);
}

function RequestPassportGate({
  info,
  issue,
  onRetry,
  clientId,
  holderWallet,
}: {
  info: VaultOnChainInfo | undefined;
  issue: VaultLoadIssue | undefined;
  onRetry: () => void;
  clientId: string | null;
  holderWallet: string;
}) {
  if (info === undefined && issue !== undefined) {
    return (
      <p className="mt-1 text-[11px] text-slate-600">
        {requestPassportBlock(info, issue)}{" "}
        <button
          type="button"
          onClick={onRetry}
          className="font-medium text-brand-700 underline-offset-2 hover:underline"
        >
          Retry
        </button>
      </p>
    );
  }
  return (
    <BeneficiaryPassport
      passport={info?.passport}
      registry={info?.kycRegistry ?? null}
      shortcutHref={passportShortcutHref({ clientId, wallet: holderWallet })}
      compact
    />
  );
}

function deadlinePassed(info: VaultOnChainInfo): boolean {
  return (
    info.deadline > BigInt(0) &&
    BigInt(Math.floor(Date.now() / 1000)) >= info.deadline
  );
}

function ConversionRequestsSection({
  onVaultsChanged,
}: {
  onVaultsChanged: () => Promise<void>;
}) {
  const conn = useWalletConnection();
  const client = useSolanaClient();
  const tx = useSendTransaction();
  const toast = useToast();
  const wallet = conn.wallet?.account.address;

  // conversion_requests has NO anon SELECT (holder contact = PII) — the queue
  // loads through the signed admin route, which prompts for a signature.
  const [requests, setRequests] = useState<ConversionRequest[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [approveReq, setApproveReq] = useState<ConversionRequest | null>(null);
  const [rejectReq, setRejectReq] = useState<ConversionRequest | null>(null);
  const [confirmReq, setConfirmReq] = useState<ConversionRequest | null>(null);
  const [returnReq, setReturnReq] = useState<ConversionRequest | null>(null);
  const [cancelOpenReq, setCancelOpenReq] = useState<ConversionRequest | null>(
    null,
  );
  // vault_pda → on-chain state/authority for live rows. trigger/realize and
  // the pre-deadline return are `has_one = authority` on-chain (the wallet
  // that opened the vault) — surface that instead of failing Unauthorized.
  const [vaultInfo, setVaultInfo] = useState<Map<string, VaultOnChainInfo>>(
    new Map(),
  );
  const [vaultLoadIssue, setVaultLoadIssue] = useState<
    Map<string, VaultLoadIssue>
  >(new Map());

  const loadVaultInfo = useCallback(
    async (rows: ConversionRequest[]) => {
      const targets = rows.filter(
        (r) =>
          r.vault_pda &&
          (r.status === "vault_opened" || r.status === "deposited"),
      );
      const entries: Array<[string, VaultOnChainInfo]> = [];
      const issues: Array<[string, VaultLoadIssue]> = [];
      await Promise.all(
        targets.map(async (r) => {
          try {
            const info = await readVaultOnChainInfo(
              client.runtime.rpc,
              address(r.vault_pda!),
            );
            if (info) entries.push([r.vault_pda!, info]);
            else issues.push([r.vault_pda!, "missing"]);
          } catch {
            // Unknown: Confirm conversion fails CLOSED (passport unverifiable)
            // while the other buttons stay enabled — the program still gates.
            // The row offers a retry.
            issues.push([r.vault_pda!, "error"]);
          }
        }),
      );
      setVaultInfo(new Map(entries));
      setVaultLoadIssue(new Map(issues));
    },
    [client],
  );

  const load = useCallback(async () => {
    if (!conn.wallet) return;
    try {
      const rows = await adminListConversionRequests(conn.wallet);
      setRequests(rows);
      setLoaded(true);
      setLoadError(null);
      void loadVaultInfo(rows);
    } catch (err) {
      setLoadError(
        err instanceof Error
          ? err.message
          : "Could not load conversion requests",
      );
    }
  }, [conn.wallet, loadVaultInfo]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function refreshAll() {
    await load();
    await onVaultsChanged();
  }

  const pendingCount = requests.filter((r) => r.status === "requested").length;

  const outcomeRecovery = useCustodyOutcomeRecovery(
    "conversion",
    conn.wallet,
    refreshAll,
  );

  async function reject(req: ConversionRequest, reason: string) {
    if (!wallet) return;
    const pendingId = toast.showPending(
      "Rejecting conversion request…",
      reason,
    );
    const ok = await adminUpdateConversionRequest(conn.wallet, req.id, {
      status: "cancelled",
      admin_note: reason || null,
      decide: true,
    });
    toast.dismiss(pendingId);
    if (!ok) {
      toast.showError("Reject failed", "Could not update the request.");
      return;
    }
    toast.show({ kind: "success", title: "Request rejected" });
    void recordAudit({
      ix_name: "conversion_reject",
      category: "custody",
      actor_wallet: wallet.toString(),
      reason: reason || "Rejected",
      target_label: conversionTargetLabel(req),
      metadata: { conversion_request_id: req.id },
    });
    setRejectReq(null);
    await refreshAll();
  }

  async function confirmConversion(req: ConversionRequest, reason: string) {
    if (!wallet || !req.vault_pda) return;
    const target = conversionTargetLabel(req);
    const pendingId = toast.showPending(
      `Confirming conversion for ${target}…`,
      reason,
    );
    let sentSignature: string | undefined;
    let prepared = false;
    try {
      outcomeRecovery.prepare(req.id, "converted");
      prepared = true;
      const signer = walletSigner(conn.wallet);
      const vaultPda = address(req.vault_pda);
      const [escrow] = await findOpenCustodyVaultEscrowPda({
        custodyVault: vaultPda,
      });
      const triggerIx = getTriggerCustodyVaultInstruction({
        authority: signer,
        custodyVault: vaultPda,
        authorityAdminRecord: await custodyAuthorityRecord(
          client.runtime.rpc,
          vaultPda,
        ),
      });
      // escrowMarker (["escrow_marker", vault PDA]) is auto-derived by the
      // async builder — closed on-chain by this terminal path. The KYC gate
      // (2C-3) needs the pinned registry + the holder's KycEntry; if it
      // fails, the whole transaction (trigger included) rolls back.
      const kycAccounts = await requestRealizeKycAccounts(
        client.runtime.rpc,
        vaultPda,
      );
      const realizeIx = await getRealizeCustodyVaultInstructionAsync({
        authority: signer,
        shareClass: address(req.share_class_pda),
        custodyVault: vaultPda,
        authorityAdminRecord: await custodyAuthorityRecord(
          client.runtime.rpc,
          vaultPda,
        ),
        mint: address(req.mint),
        escrow,
        tokenProgram: TOKEN_2022_ADDRESS,
        ...kycAccounts,
      });
      // BurnAndAttest burns the escrowed tokens — trigger then realize in one
      // transaction; the attestation hash the vault carried at open is what
      // gets attested (it is immutable on-chain). send() resolves with the
      // confirmed signature — tx.signature is stale closure state.
      const sig = await tx.send({
        instructions: [triggerIx, realizeIx],
        feePayer: signer,
      });
      sentSignature = sig;
      await outcomeRecovery.record(req.id, "converted", sig);
      toast.dismiss(pendingId);
      toast.showTx(sig, {
        title: "Custody realization recorded — tokens burned",
      });
      void recordAudit({
        ix_name: "realize_custody",
        category: "custody",
        actor_wallet: wallet.toString(),
        reason,
        target_label: target,
        tx_signature: sig,
        metadata: {
          conversion_request_id: req.id,
          vault_pda: req.vault_pda,
          realize_action: RealizeAction.BurnAndAttest,
          kyc_registry: kycAccounts.kycRegistry ?? null,
        },
      });
      setConfirmReq(null);
      await refreshAll();
    } catch (err) {
      toast.dismiss(pendingId);
      const message = explainSendError(err);
      if (sentSignature)
        toast.showTx(sentSignature, {
          title: "Transaction sent — retry recording below",
        });
      toast.showError("Failed to confirm conversion", message);
      void recordAudit({
        ix_name: "realize_custody",
        category: "custody",
        actor_wallet: wallet.toString(),
        reason,
        target_label: target,
        status: "failed",
        metadata: {
          conversion_request_id: req.id,
          vault_pda: req.vault_pda,
          error: message,
        },
      });
    } finally {
      if (prepared) outcomeRecovery.release();
    }
  }

  async function cancelAndReturn(req: ConversionRequest, reason: string) {
    if (!wallet || !req.vault_pda) return;
    const target = conversionTargetLabel(req);
    const pendingId = toast.showPending(
      `Returning escrow for ${target}…`,
      reason,
    );
    let sentSignature: string | undefined;
    let prepared = false;
    try {
      outcomeRecovery.prepare(req.id, "returned");
      prepared = true;
      const signer = walletSigner(conn.wallet);
      const vaultPda = address(req.vault_pda);
      const mint = address(req.mint);
      const beneficiary = address(req.holder_wallet);
      const [escrow] = await findOpenCustodyVaultEscrowPda({
        custodyVault: vaultPda,
      });
      const [beneficiaryAta] = await findAssociatedTokenPda({
        owner: beneficiary,
        tokenProgram: TOKEN_2022_ADDRESS,
        mint,
      });
      const createAtaIx =
        await getCreateAssociatedTokenIdempotentInstructionAsync({
          payer: signer,
          owner: beneficiary,
          mint,
          tokenProgram: TOKEN_2022_ADDRESS,
        });
      // escrowMarker (["escrow_marker", vault PDA]) is auto-derived by the
      // async builder. It is closed ONLY when the return fully drains the
      // escrow — a withheld surplus keeps both the vault and the marker alive
      // so the remainder still has an exit (readReturnOutcome reports which).
      const baseIx = await getReturnCustodyVaultInstructionAsync({
        signer,
        shareClass: address(req.share_class_pda),
        custodyVault: vaultPda,
        authorityAdminRecord: await custodyAuthorityRecord(
          client.runtime.rpc,
          vaultPda,
        ),
        mint,
        escrow,
        beneficiaryTokenAccount: beneficiaryAta,
        tokenProgram: TOKEN_2022_ADDRESS,
      });
      // The escrow pays out via transfer_checked of a hook mint — append the
      // mode-aware hook tail for the return leg (source authority = vault PDA).
      const returnIx = {
        ...baseIx,
        accounts: [
          ...baseIx.accounts,
          ...(await hookTransferMetas(client.runtime.rpc, mint, {
            sourceTokenAccount: escrow,
            destTokenAccount: beneficiaryAta,
            transferAuthority: vaultPda,
            sourceOwner: vaultPda,
            destOwner: beneficiary,
          })),
        ],
      };
      const sig = await tx.send({
        instructions: [createAtaIx, returnIx],
        feePayer: signer,
      });
      sentSignature = sig;
      await outcomeRecovery.record(req.id, "returned", sig);
      toast.dismiss(pendingId);
      toast.showTx(sig, { title: "Holder deposit returned and recorded" });
      void recordAudit({
        ix_name: "return_custody_vault",
        category: "custody",
        actor_wallet: wallet.toString(),
        reason,
        target_label: target,
        tx_signature: sig,
        metadata: {
          conversion_request_id: req.id,
          vault_pda: req.vault_pda,
        },
      });
      setReturnReq(null);
      await refreshAll();
    } catch (err) {
      toast.dismiss(pendingId);
      const message = explainSendError(err);
      if (sentSignature)
        toast.showTx(sentSignature, {
          title: "Transaction sent — retry recording below",
        });
      toast.showError("Failed to return escrow", message);
      void recordAudit({
        ix_name: "return_custody_vault",
        category: "custody",
        actor_wallet: wallet.toString(),
        reason,
        target_label: target,
        status: "failed",
        metadata: {
          conversion_request_id: req.id,
          vault_pda: req.vault_pda,
          error: message,
        },
      });
    } finally {
      if (prepared) outcomeRecovery.release();
    }
  }

  /**
   * Exit for a stalled `vault_opened` request (the holder never deposited):
   * close the (normally empty) escrow on-chain via return_custody_vault —
   * normally marking the vault Returned so a later deposit into an orphaned
   * escrow is impossible; if someone raw-transferred un-ledgered units in,
   * the return withholds them and the vault stays open, which is surfaced
   * as a warning — AND write status `cancelled` in the same flow. When the
   * vault is already terminal on-chain (e.g. returned from the vault detail
   * card), only the row is updated, so the queue can no longer desync from
   * the chain.
   */
  async function cancelNoDeposit(req: ConversionRequest, reason: string) {
    if (!wallet) return;
    const target = conversionTargetLabel(req);
    const pendingId = toast.showPending(`Cancelling ${target}…`, reason);
    try {
      const info = req.vault_pda ? vaultInfo.get(req.vault_pda) : undefined;
      const vaultLive =
        info === undefined ||
        info.state === VaultState.Active ||
        info.state === VaultState.Triggered;
      let sig: string | undefined;
      let returnTerminal = true;
      if (req.vault_pda && vaultLive) {
        const signer = walletSigner(conn.wallet);
        const vaultPda = address(req.vault_pda);
        const mint = address(req.mint);
        const beneficiary = address(req.holder_wallet);
        const [escrow] = await findOpenCustodyVaultEscrowPda({
          custodyVault: vaultPda,
        });
        const [beneficiaryAta] = await findAssociatedTokenPda({
          owner: beneficiary,
          tokenProgram: TOKEN_2022_ADDRESS,
          mint,
        });
        const createAtaIx =
          await getCreateAssociatedTokenIdempotentInstructionAsync({
            payer: signer,
            owner: beneficiary,
            mint,
            tokenProgram: TOKEN_2022_ADDRESS,
          });
        const baseIx = await getReturnCustodyVaultInstructionAsync({
          signer,
          shareClass: address(req.share_class_pda),
          custodyVault: vaultPda,
          authorityAdminRecord: await custodyAuthorityRecord(
            client.runtime.rpc,
            vaultPda,
          ),
          mint,
          escrow,
          beneficiaryTokenAccount: beneficiaryAta,
          tokenProgram: TOKEN_2022_ADDRESS,
        });
        const returnIx = {
          ...baseIx,
          accounts: [
            ...baseIx.accounts,
            ...(await hookTransferMetas(client.runtime.rpc, mint, {
              sourceTokenAccount: escrow,
              destTokenAccount: beneficiaryAta,
              transferAuthority: vaultPda,
              sourceOwner: vaultPda,
              destOwner: beneficiary,
            })),
          ],
        };
        sig = await tx.send({
          instructions: [createAtaIx, returnIx],
          feePayer: signer,
        });
        // Normally the escrow is empty here (that is the premise of this
        // exit), so the return is terminal — but un-ledgered units pushed in
        // by anyone are withheld unless the beneficiary's KYC passes, which
        // leaves the vault OPEN while this row says "cancelled".
        returnTerminal = (await readReturnOutcome(client.runtime.rpc, vaultPda))
          .terminal;
      }
      const ok = await adminUpdateConversionRequest(conn.wallet, req.id, {
        status: "cancelled",
        admin_note: reason || null,
        outcome_tx: sig ?? null,
        decide: true,
      });
      toast.dismiss(pendingId);
      if (!ok) {
        toast.showError(
          "Status update failed",
          sig
            ? "The vault was closed on-chain but the request row could not be updated."
            : "Could not update the request.",
        );
      } else if (sig) {
        toast.showTx(sig, {
          title: returnTerminal
            ? "Request cancelled — vault closed"
            : "Request cancelled — vault still open",
        });
      } else {
        toast.show({ kind: "success", title: "Request cancelled" });
      }
      if (!returnTerminal) {
        toast.showError(
          "Request cancelled, but the vault is still open",
          `${PARTIAL_RETURN_HINT} Resolve it from the vault detail card — the request row is already cancelled.`,
        );
      }
      void recordAudit({
        ix_name: "conversion_cancel_no_deposit",
        category: "custody",
        actor_wallet: wallet.toString(),
        reason: reason || "Cancelled before deposit",
        target_label: target,
        tx_signature: sig,
        metadata: {
          conversion_request_id: req.id,
          vault_pda: req.vault_pda,
          vault_closed_on_chain: sig !== undefined,
        },
      });
      setCancelOpenReq(null);
      await refreshAll();
    } catch (err) {
      toast.dismiss(pendingId);
      const message = explainSendError(err);
      toast.showError("Failed to cancel", message);
      void recordAudit({
        ix_name: "conversion_cancel_no_deposit",
        category: "custody",
        actor_wallet: wallet.toString(),
        reason,
        target_label: target,
        status: "failed",
        metadata: {
          conversion_request_id: req.id,
          vault_pda: req.vault_pda,
          error: message,
        },
      });
    }
  }

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-card">
      {outcomeRecovery.panel}
      <div className="flex items-center justify-between gap-4 border-b border-slate-100 px-4 py-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            Conversion requests
          </p>
          <p className="mt-0.5 text-[11px] text-slate-500">
            Equity / real-estate holders converting tokens into the off-chain
            right. Approve to open a conversion escrow (a DeliveryEscrow-type
            vault, Burn &amp; attest — return goes to the holder, revert is
            banned on-chain), then track deposit → off-chain conversion → burn.
          </p>
        </div>
        {pendingCount > 0 && (
          <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800">
            {pendingCount} pending
          </span>
        )}
      </div>

      {loadError ? (
        <div className="flex items-center justify-between gap-4 px-4 py-6">
          <p className="text-sm text-slate-600">
            The queue is private (holder contact details) — a wallet signature
            is needed to load it.
          </p>
          <button
            type="button"
            onClick={() => void load()}
            className="shrink-0 rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:border-slate-400"
          >
            Sign to load
          </button>
        </div>
      ) : !loaded ? (
        <p className="px-4 py-8 text-center text-sm text-slate-500">
          Loading conversion requests…
        </p>
      ) : requests.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-slate-500">
          No conversion requests yet.
        </p>
      ) : (
        <table className="w-full text-sm">
          <thead className="border-b border-slate-100 bg-slate-50 text-left text-xs uppercase tracking-wider text-slate-500">
            <tr>
              <th className="px-4 py-3 font-medium">Request</th>
              <th className="px-4 py-3 font-medium">Holder</th>
              <th className="px-4 py-3 text-right font-medium">Amount</th>
              <th className="px-4 py-3 font-medium">Note</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {requests.map((r) => {
              const info = r.vault_pda ? vaultInfo.get(r.vault_pda) : undefined;
              // Fail OPEN when the vault could not be fetched — the program
              // still gates; these flags only pre-empt guaranteed failures.
              const isVaultAuthority =
                info === undefined ||
                wallet === undefined ||
                info.authority === wallet.toString();
              const returnUnlocked = info !== undefined && deadlinePassed(info);
              const vaultTerminal =
                info !== undefined &&
                info.state !== VaultState.Active &&
                info.state !== VaultState.Triggered;
              const authorityHint =
                info === undefined
                  ? undefined
                  : `Vault authority is ${info.authority} — trigger/realize and the pre-deadline return only work from that wallet.`;
              // KYC at conversion (2C-3): the realize needs the holder's
              // approved passport in the vault's pinned registry.
              const loadIssue = r.vault_pda
                ? vaultLoadIssue.get(r.vault_pda)
                : undefined;
              const passportBlock = requestPassportBlock(info, loadIssue);
              return (
                <tr key={r.id} className="text-slate-700">
                  <td className="px-4 py-3">
                    <p className="font-medium text-slate-900">
                      {r.asset_label || "—"}
                    </p>
                    <p className="mt-0.5 font-mono text-[11px] text-slate-500">
                      {r.id.slice(0, 8)} ·{" "}
                      {new Date(r.created_at).toISOString().slice(0, 10)}
                      {r.vault_id != null ? ` · vault #${r.vault_id}` : ""}
                    </p>
                    {/* The label above is HOLDER-SUPPLIED text — the on-chain
                        identity the vault acts on is this mint/class pair. */}
                    <p className="mt-1 space-x-2">
                      <CopyableAddress label="mint" value={r.mint} />
                      <CopyableAddress
                        label="class"
                        value={r.share_class_pda}
                      />
                    </p>
                    {info !== undefined && !isVaultAuthority && (
                      <p
                        className="mt-1 text-[11px] leading-snug text-amber-700"
                        title={authorityHint}
                      >
                        Vault authority: {shortAddr(info.authority)} — connect
                        that wallet to act on this vault.
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <p
                      className="font-mono text-xs text-slate-700"
                      title={r.holder_wallet}
                    >
                      {r.holder_wallet.slice(0, 4)}…{r.holder_wallet.slice(-4)}
                    </p>
                    <p
                      className="mt-0.5 max-w-36 truncate text-[11px] text-slate-500"
                      title={r.contact}
                    >
                      {r.contact || "—"}
                    </p>
                    {(r.status === "vault_opened" || r.status === "deposited") && (
                      <RequestPassportGate
                        info={info}
                        issue={loadIssue}
                        onRetry={() => void loadVaultInfo(requests)}
                        clientId={r.client_id}
                        holderWallet={r.holder_wallet}
                      />
                    )}
                  </td>
                  <td className="px-4 py-3 text-right font-mono">{r.amount}</td>
                  <td className="px-4 py-3">
                    <p
                      className="max-w-52 truncate text-xs text-slate-600"
                      title={r.note}
                    >
                      {r.note || "—"}
                    </p>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${CONVERSION_STATUS_BADGE[r.status]}`}
                    >
                      {CONVERSION_STATUS_LABEL[r.status]}
                    </span>
                    {r.status === "cancelled" && r.admin_note && (
                      <p className="mt-1 max-w-44 text-[11px] leading-snug text-slate-500">
                        {r.admin_note}
                      </p>
                    )}
                  </td>
                  <td className="space-x-3 px-4 py-3 text-right text-xs">
                    {r.status === "requested" && (
                      <>
                        <button
                          type="button"
                          disabled={tx.isSending}
                          onClick={() => setApproveReq(r)}
                          className="text-slate-700 underline-offset-2 hover:underline disabled:opacity-50"
                        >
                          Approve &amp; open vault
                        </button>
                        <button
                          type="button"
                          disabled={tx.isSending}
                          onClick={() => setRejectReq(r)}
                          className="text-red-700 underline-offset-2 hover:underline disabled:opacity-50"
                        >
                          Reject
                        </button>
                      </>
                    )}
                    {r.status === "vault_opened" && (
                      <>
                        <span className="text-slate-400">
                          Awaiting holder deposit
                        </span>
                        <button
                          type="button"
                          disabled={
                            tx.isSending ||
                            (!vaultTerminal &&
                              !isVaultAuthority &&
                              !returnUnlocked)
                          }
                          title={
                            !vaultTerminal &&
                            !isVaultAuthority &&
                            !returnUnlocked
                              ? authorityHint
                              : undefined
                          }
                          onClick={() => setCancelOpenReq(r)}
                          className="text-red-700 underline-offset-2 hover:underline disabled:opacity-50"
                        >
                          Cancel (no deposit)
                        </button>
                      </>
                    )}
                    {r.status === "deposited" && (
                      <>
                        <button
                          type="button"
                          disabled={
                            tx.isSending ||
                            !r.vault_pda ||
                            !isVaultAuthority ||
                            passportBlock !== null
                          }
                          title={
                            passportBlock ??
                            (!isVaultAuthority ? authorityHint : undefined)
                          }
                          onClick={() => setConfirmReq(r)}
                          className="text-emerald-700 underline-offset-2 hover:underline disabled:opacity-50"
                        >
                          Confirm conversion
                        </button>
                        <button
                          type="button"
                          disabled={
                            tx.isSending ||
                            !r.vault_pda ||
                            (!isVaultAuthority && !returnUnlocked)
                          }
                          title={
                            !isVaultAuthority && !returnUnlocked
                              ? authorityHint
                              : undefined
                          }
                          onClick={() => setReturnReq(r)}
                          className="text-red-700 underline-offset-2 hover:underline disabled:opacity-50"
                        >
                          Cancel &amp; return
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {approveReq && (
        <ApproveConversionModal
          req={approveReq}
          onClose={() => setApproveReq(null)}
          onSuccess={() => {
            setApproveReq(null);
            void refreshAll();
          }}
        />
      )}

      <ConfirmModal
        open={rejectReq !== null}
        onClose={() => setRejectReq(null)}
        onConfirm={async (reason) => {
          if (rejectReq) await reject(rejectReq, reason);
        }}
        title="Reject conversion request"
        kind="warning"
        confirmLabel="Reject"
        description={
          <p>
            Rejecting marks the request as Cancelled before any vault is opened
            — no tokens move. The reason is stored as an admin note visible to
            the holder.
          </p>
        }
        busy={tx.isSending || outcomeRecovery.busy || !outcomeRecovery.ready}
      />
      <ConfirmModal
        open={confirmReq !== null}
        onClose={() => setConfirmReq(null)}
        onConfirm={async (reason) => {
          if (confirmReq) await confirmConversion(confirmReq, reason);
        }}
        title="Confirm conversion"
        kind="destructive"
        confirmLabel="Confirm & burn"
        description={
          <>
            <p>
              Triggers and realizes the conversion escrow vault (
              <strong>Burn &amp; attest</strong>) — the escrowed tokens are
              burned against the attestation hash the vault carried at open.
              This is <strong>irreversible</strong>.
            </p>
            <p className="mt-2 text-xs text-slate-500">
              Confirm only after the off-chain conversion (share-register entry
              / title transfer) is legally executed. Reason recorded in audit
              log.
            </p>
          </>
        }
        busy={tx.isSending || outcomeRecovery.busy || !outcomeRecovery.ready}
      />
      <ConfirmModal
        open={returnReq !== null}
        onClose={() => setReturnReq(null)}
        onConfirm={async (reason) => {
          if (returnReq) await cancelAndReturn(returnReq, reason);
        }}
        title="Cancel & return escrow"
        kind="warning"
        confirmLabel="Return tokens"
        description={
          <p>
            Returns the escrowed tokens to the holder&apos;s wallet via
            return_custody_vault and marks the request as Returned. Use when the
            off-chain conversion cannot be completed. Reason recorded in audit
            log.
          </p>
        }
        busy={tx.isSending || outcomeRecovery.busy || !outcomeRecovery.ready}
      />
      <ConfirmModal
        open={cancelOpenReq !== null}
        onClose={() => setCancelOpenReq(null)}
        onConfirm={async (reason) => {
          if (cancelOpenReq) await cancelNoDeposit(cancelOpenReq, reason);
        }}
        title="Cancel request (no deposit)"
        kind="warning"
        confirmLabel="Cancel request"
        description={
          <>
            <p>
              The holder never deposited. This closes the escrow vault on-chain
              via return_custody_vault (nothing to transfer — the escrow is
              empty; any stray balance goes back to the holder) and marks the
              request as Cancelled, so the orphaned escrow can never swallow a
              late deposit.
            </p>
            <p className="mt-2 text-xs text-slate-500">
              If the vault is already closed on-chain, only the request row is
              updated. Reason recorded in audit log.
            </p>
          </>
        }
        busy={tx.isSending || outcomeRecovery.busy || !outcomeRecovery.ready}
      />
    </div>
  );
}

function ApproveConversionModal({
  req,
  onClose,
  onSuccess,
}: {
  req: ConversionRequest;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const conn = useWalletConnection();
  const tx = useSendTransaction();
  const toast = useToast();
  const wallet = conn.wallet?.account.address;
  const recovery = useCustodyOpenRecovery(
    "conversion",
    req,
    conn.wallet,
    onSuccess,
  );

  const [vaultId, setVaultId] = useState("1");
  const amount = String(req.amount);
  let inputError: string | null = null;
  try {
    parseCustodyVaultId(vaultId);
    requireCustodyRequestAmount(amount, req.amount);
  } catch (error) {
    inputError =
      error instanceof Error
        ? error.message
        : "Invalid vault ID or request amount.";
  }
  const [deadlineDate, setDeadlineDate] = useState(() =>
    toDatetimeLocalValue(new Date(Date.now() + 30 * DAY_MS)),
  );
  const deadlineError = deliveryDeadlineError(deadlineDate);

  // Attestation document / hash → metadata_hash (no more zero hashes).
  const [attFile, setAttFile] = useState<File | null>(null);
  const [attFileHash, setAttFileHash] = useState("");
  const [attPasted, setAttPasted] = useState("");
  const attHash = attFile ? attFileHash : attPasted.trim().toLowerCase();
  const attHashOk = isValidSha256Hex(attHash);
  // KYC at conversion / delivery (2C-3): the vault pins the platform KYC
  // registry; the holder's passport there is shown for information (the
  // open needs none — the realize does).
  const platformRegistry = usePlatformKycRegistry(true);
  const pinnedRegistry = platformRegistry.registry;
  const holderPassport = useHolderPassport(pinnedRegistry, req.holder_wallet);

  async function approve() {
    if (
      !wallet ||
      inputError ||
      deadlineError ||
      !attHashOk ||
      !pinnedRegistry ||
      !recovery.ready ||
      recovery.pending
    )
      return;
    const target = conversionTargetLabel(req);
    const pendingId = toast.showPending(
      `Opening conversion vault #${vaultId}…`,
    );
    try {
      const signer = walletSigner(conn.wallet);
      const intent = await recovery.open(
        vaultId,
        async () => {
          if (attFile)
            await uploadAttestationDoc(
              conn.wallet,
              "conversion",
              attFile,
              attHash,
            );
          // Both holder workflows deliberately use DeliveryEscrow: its refund
          // returns property, while ConversionPending's deadline exit burns it.
          return getOpenCustodyVaultInstructionAsync({
            authority: signer,
            shareClass: address(req.share_class_pda),
            mint: address(req.mint),
            tokenProgram: TOKEN_2022_ADDRESS,
            vaultId: parseCustodyVaultId(vaultId),
            vaultType: VaultType.DeliveryEscrow,
            realizeAction: RealizeAction.BurnAndAttest,
            amount: requireCustodyRequestAmount(amount, req.amount),
            deadline: BigInt(
              Math.floor(new Date(deadlineDate).getTime() / 1000),
            ),
            metadataHash: hexToBytes32(attHash),
            beneficiary: address(req.holder_wallet),
            kycRegistry: pinnedRegistry,
          });
        },
        (ix) => tx.send({ instructions: [ix], feePayer: signer }),
      );
      toast.dismiss(pendingId);
      if (intent.signature)
        toast.showTx(intent.signature, {
          title: "Conversion vault opened and linked",
        });
      void recordAudit({
        ix_name: "open_custody_vault",
        category: "custody",
        actor_wallet: wallet.toString(),
        reason: `Approve conversion request ${req.id.slice(0, 8)}`,
        target_label: target,
        tx_signature: intent.signature ?? undefined,
        metadata: {
          conversion_request_id: req.id,
          vault_pda: intent.vaultPda,
          vault_id: intent.vaultId,
          vault_type: "DeliveryEscrow",
          beneficiary: req.holder_wallet,
          kyc_registry: pinnedRegistry,
          metadata_hash: attHash,
          metadata_hash_source: attFile ? "file" : "pasted",
        },
      });
      onSuccess();
    } catch (err) {
      toast.dismiss(pendingId);
      toast.showError(
        recovery.hasPending()
          ? "Approval recording pending"
          : "Failed to open vault",
        explainSendError(err),
      );
    }
  }

  if (!wallet) return null;

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center overflow-y-auto bg-slate-900/40 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !tx.isSending && !recovery.busy)
          onClose();
      }}
    >
      <div className="mx-auto w-full max-w-2xl overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl">
        <div className="border-b border-slate-100 px-5 py-4">
          <p className="text-sm font-semibold uppercase tracking-wide text-slate-700">
            Approve conversion request
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Opens a conversion escrow (DeliveryEscrow-type custody vault, Burn
            &amp; attest) with the holder as beneficiary — a cancel returns the
            deposit to the holder, a confirm burns it. The holder then deposits
            the tokens.
          </p>
        </div>
        <div className="space-y-4 px-5 py-4">
          {recovery.panel}
          <FieldError error={inputError} />
          <dl className="grid gap-3 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Asset (label as submitted)
              </dt>
              <dd className="mt-0.5 text-slate-800">
                {req.asset_label || "—"}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Holder (beneficiary)
              </dt>
              <dd className="mt-0.5 break-all font-mono text-xs text-slate-800">
                {req.holder_wallet}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Contact
              </dt>
              <dd className="mt-0.5 text-slate-800">{req.contact || "—"}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Holder note
              </dt>
              <dd className="mt-0.5 whitespace-pre-wrap text-slate-800">
                {req.note || "—"}
              </dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
                On-chain target — the vault opens against exactly this
              </dt>
              <dd className="mt-1 space-y-1">
                {(
                  [
                    ["Mint", req.mint],
                    ["Share class", req.share_class_pda],
                  ] as const
                ).map(([label, value]) => (
                  <p
                    key={label}
                    className="flex items-center gap-2 break-all font-mono text-xs text-slate-800"
                  >
                    <span className="w-20 shrink-0 text-slate-500">
                      {label}
                    </span>
                    <span className="break-all">{value}</span>
                    <button
                      type="button"
                      title={`Copy ${label.toLowerCase()}`}
                      onClick={() => void navigator.clipboard.writeText(value)}
                      className="shrink-0 rounded border border-slate-300 px-1.5 text-[10px] text-slate-500 hover:border-slate-400 hover:text-slate-700"
                    >
                      copy
                    </button>
                  </p>
                ))}
              </dd>
              <p className="mt-1.5 text-[11px] leading-snug text-amber-700">
                Verify the mint / share class against the asset named in the
                label before executing anything off-chain — the label is
                holder-supplied text and is not proven by the chain.
              </p>
            </div>
          </dl>

          <div className="grid gap-3 sm:grid-cols-3">
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Vault ID
              </span>
              <input
                value={vaultId}
                inputMode="numeric"
                onChange={(e) => setVaultId(e.target.value.replace(/\D/g, ""))}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Amount (units)
              </span>
              <input
                value={amount}
                inputMode="numeric"
                readOnly
                aria-readonly="true"
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              />
              <span className="mt-1 block text-[11px] text-slate-400">
                Fixed to the requested amount: {req.amount}
              </span>
            </label>
            <label className="block">
              <FieldLabel required>Deadline</FieldLabel>
              <input
                type="datetime-local"
                value={deadlineDate}
                onChange={(e) => setDeadlineDate(e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              />
              <FieldError error={deadlineError} />
              <FieldHelp>
                After this deadline the escrow becomes permissionlessly
                returnable to the holder.
              </FieldHelp>
            </label>
          </div>
          <PinnedRegistryLine
            registry={pinnedRegistry}
            error={platformRegistry.error}
          />
          {pinnedRegistry && (
            <BeneficiaryPassport
              passport={holderPassport}
              registry={pinnedRegistry}
              shortcutHref={passportShortcutHref({
                clientId: req.client_id,
                wallet: req.holder_wallet,
              })}
            />
          )}
          <AttestationDocSection
            kindLabel="conversion agreement"
            file={attFile}
            fileHash={attFileHash}
            pastedHash={attPasted}
            onFileChange={(f, hex) => {
              setAttFile(f);
              setAttFileHash(hex);
            }}
            onPastedChange={setAttPasted}
            disabled={tx.isSending || recovery.busy}
          />
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-100 bg-slate-50 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={tx.isSending || recovery.busy}
            className="rounded-md px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-200 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void approve()}
            disabled={
              tx.isSending ||
              recovery.busy ||
              !recovery.ready ||
              !!recovery.pending ||
              inputError !== null ||
              !vaultId.trim() ||
              !amount.trim() ||
              deadlineError !== null ||
              !attHashOk ||
              !pinnedRegistry
            }
            className="rounded-md bg-brand-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-800 disabled:opacity-50"
          >
            {tx.isSending || recovery.busy ? "Processing…" : "Open vault"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The platform KYC registry pin, or null (a malformed pin must not crash a
 *  render — loadKycAuthorityContext reports it where a registry is needed). */
function platformKycRegistryPin(): string | null {
  try {
    return configuredKycRegistry();
  } catch {
    return null;
  }
}

const PASSPORT_BADGE: Record<PassportEvaluation["status"], string> = {
  approved: "bg-emerald-100 text-emerald-800 border-emerald-200",
  missing: "bg-amber-100 text-amber-800 border-amber-200",
  not_approved: "bg-red-100 text-red-800 border-red-200",
  expired: "bg-amber-100 text-amber-800 border-amber-200",
  jurisdiction: "bg-red-100 text-red-800 border-red-200",
  registry_unreadable: "bg-slate-200 text-slate-800 border-slate-300",
};

/** Why a DeliveryEscrow realize (conversion / delivery) cannot run yet, or
 *  null when the beneficiary's passport passes. Unknown blocks too: the
 *  program would refuse, and the deposit's exit is return instead. */
function passportBlockReason(passport: PassportEvaluation | null | undefined): string | null {
  if (passport === undefined || passport === null) {
    return "Checking the holder's investor passport…";
  }
  if (passport.status === "approved") return null;
  return `${passport.reason} Converting or delivering needs an approved passport; without one the deposit can only be returned.`;
}

/** KYC at conversion / delivery (2C-3): the beneficiary's passport in the
 *  registry the vault pinned at open, with a shortcut to issue one. */
function BeneficiaryPassport({
  passport,
  registry,
  shortcutHref,
  compact = false,
}: {
  passport: PassportEvaluation | null | undefined;
  registry: string | null;
  shortcutHref: string;
  compact?: boolean;
}) {
  const warning =
    registry === null ? null : pinnedRegistryWarning(registry, platformKycRegistryPin());
  const expiry =
    passport?.expiry != null && passport.expiry > BigInt(0)
      ? new Date(Number(passport.expiry) * 1000).toISOString().slice(0, 10)
      : null;
  return (
    <div className={compact ? "mt-1 space-y-0.5" : "mt-4 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3"}>
      {!compact && (
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          Beneficiary passport
        </p>
      )}
      <p className={`flex flex-wrap items-center gap-2 ${compact ? "text-[11px]" : "mt-1 text-xs"}`}>
        <span
          className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
            passport ? PASSPORT_BADGE[passport.status] : PASSPORT_BADGE.registry_unreadable
          }`}
        >
          {passport ? PASSPORT_STATUS_LABEL[passport.status] : "Checking…"}
        </span>
        {expiry && <span className="text-slate-500">expires {expiry}</span>}
        {registry && !compact && (
          <span className="font-mono text-slate-500" title={registry}>
            registry {shortAddr(registry)}
          </span>
        )}
        {passport && passport.status !== "approved" && (
          <Link
            href={shortcutHref}
            className="font-medium text-brand-700 underline-offset-2 hover:underline"
          >
            Issue passport →
          </Link>
        )}
      </p>
      {!compact && passport && passport.status !== "approved" && (
        <p className="mt-1 text-xs text-slate-600">{passport.reason}</p>
      )}
      {warning && (
        <p className={`${compact ? "text-[11px]" : "mt-1 text-xs"} text-amber-700`}>{warning}</p>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </dt>
      <dd
        className={`mt-0.5 break-all text-slate-800 ${mono ? "font-mono text-xs" : "text-sm"}`}
      >
        {value}
      </dd>
    </div>
  );
}

function deliveryTargetLabel(req: DeliveryRequest): string {
  return `delivery ${req.id.slice(0, 8)} · ${req.asset_label || req.mint}`;
}

function DeliveryRequestsSection({
  onVaultsChanged,
}: {
  onVaultsChanged: () => Promise<void>;
}) {
  const conn = useWalletConnection();
  const client = useSolanaClient();
  const tx = useSendTransaction();
  const toast = useToast();
  const wallet = conn.wallet?.account.address;
  const [requests, setRequests] = useState<DeliveryRequest[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [approveReq, setApproveReq] = useState<DeliveryRequest | null>(null);
  const [rejectReq, setRejectReq] = useState<DeliveryRequest | null>(null);
  const [confirmReq, setConfirmReq] = useState<DeliveryRequest | null>(null);
  const [returnReq, setReturnReq] = useState<DeliveryRequest | null>(null);
  const [cancelOpenReq, setCancelOpenReq] = useState<DeliveryRequest | null>(
    null,
  );
  const [busyId, setBusyId] = useState<string | null>(null);
  // vault_pda → on-chain vault + the holder's passport (2C-3: confirming a
  // delivery realizes a KYC-gated DeliveryEscrow).
  const [vaultInfo, setVaultInfo] = useState<Map<string, VaultOnChainInfo>>(
    new Map(),
  );
  const [vaultLoadIssue, setVaultLoadIssue] = useState<
    Map<string, VaultLoadIssue>
  >(new Map());

  const loadVaultInfo = useCallback(
    async (rows: DeliveryRequest[]) => {
      const targets = rows.filter(
        (r) =>
          r.vault_pda &&
          (r.status === "vault_opened" ||
            r.status === "deposited" ||
            r.status === "in_delivery"),
      );
      const entries: Array<[string, VaultOnChainInfo]> = [];
      const issues: Array<[string, VaultLoadIssue]> = [];
      await Promise.all(
        targets.map(async (r) => {
          try {
            const info = await readVaultOnChainInfo(
              client.runtime.rpc,
              address(r.vault_pda!),
            );
            if (info) entries.push([r.vault_pda!, info]);
            else issues.push([r.vault_pda!, "missing"]);
          } catch {
            // Unknown: Mark in delivery / Confirm delivery fail CLOSED
            // (passport unverifiable); the row offers a retry.
            issues.push([r.vault_pda!, "error"]);
          }
        }),
      );
      setVaultInfo(new Map(entries));
      setVaultLoadIssue(new Map(issues));
    },
    [client],
  );

  // delivery_requests has no anon SELECT (rows carry the holder's physical
  // address + contact — PII); load the queue through the signed admin route.
  const load = useCallback(async () => {
    if (!conn.wallet) return;
    try {
      const rows = await adminListDeliveryRequests(conn.wallet);
      setRequests(rows);
      setLoaded(true);
      setLoadError(null);
      void loadVaultInfo(rows);
    } catch (err) {
      setLoadError(
        err instanceof Error ? err.message : "Could not load delivery requests",
      );
    }
  }, [conn.wallet, loadVaultInfo]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const onRefresh = useCallback(async () => {
    await load();
    await onVaultsChanged();
  }, [load, onVaultsChanged]);

  const pendingCount = requests.filter((r) => r.status === "requested").length;

  const outcomeRecovery = useCustodyOutcomeRecovery(
    "delivery",
    conn.wallet,
    onRefresh,
  );

  async function markInDelivery(req: DeliveryRequest) {
    if (!wallet) return;
    setBusyId(req.id);
    const pendingId = toast.showPending("Marking in delivery…");
    const ok = await adminUpdateDeliveryRequest(conn.wallet, req.id, {
      status: "in_delivery",
    });
    setBusyId(null);
    toast.dismiss(pendingId);
    if (!ok) {
      toast.showError("Update failed", "Could not update the request.");
      return;
    }
    toast.show({
      kind: "success",
      title: "Marked in delivery",
      description:
        "Off-chain step — the physical handover happens outside the chain.",
    });
    void recordAudit({
      ix_name: "delivery_mark_in_delivery",
      category: "custody",
      actor_wallet: wallet.toString(),
      reason: "Physical delivery underway (off-chain)",
      target_label: deliveryTargetLabel(req),
      metadata: { delivery_request_id: req.id },
    });
    await onRefresh();
  }

  async function reject(req: DeliveryRequest, reason: string) {
    if (!wallet) return;
    const pendingId = toast.showPending("Rejecting delivery request…", reason);
    const ok = await adminUpdateDeliveryRequest(conn.wallet, req.id, {
      status: "cancelled",
      admin_note: reason || null,
      decide: true,
    });
    toast.dismiss(pendingId);
    if (!ok) {
      toast.showError("Reject failed", "Could not update the request.");
      return;
    }
    toast.show({ kind: "success", title: "Request rejected" });
    void recordAudit({
      ix_name: "delivery_reject",
      category: "custody",
      actor_wallet: wallet.toString(),
      reason: reason || "Rejected",
      target_label: deliveryTargetLabel(req),
      metadata: { delivery_request_id: req.id },
    });
    setRejectReq(null);
    await onRefresh();
  }

  /**
   * Exit for a stalled `vault_opened` delivery (the holder never deposited):
   * close the (normally empty) escrow on-chain via return_custody_vault when it
   * is still live — so a late deposit into an orphaned escrow is impossible —
   * AND flip the row to `cancelled`. Mirrors the conversion-queue action.
   */
  async function cancelNoDeposit(req: DeliveryRequest, reason: string) {
    if (!wallet || !conn.wallet) return;
    const target = deliveryTargetLabel(req);
    const pendingId = toast.showPending(`Cancelling ${target}…`, reason);
    try {
      let sig: string | undefined;
      let returnTerminal = true;
      if (req.vault_pda) {
        // Only return if the vault is still live on-chain (idempotent otherwise).
        const maybe = await fetchMaybeLiveCustodyVault(
          client.runtime.rpc,
          address(req.vault_pda),
        );
        const vaultLive =
          maybe.exists &&
          (maybe.data.state === VaultState.Active ||
            maybe.data.state === VaultState.Triggered);
        if (vaultLive) {
          const signer = walletSigner(conn.wallet);
          const vaultPda = address(req.vault_pda);
          const mint = address(req.mint);
          const beneficiary = address(req.holder_wallet);
          const [escrow] = await findOpenCustodyVaultEscrowPda({
            custodyVault: vaultPda,
          });
          const [beneficiaryAta] = await findAssociatedTokenPda({
            owner: beneficiary,
            tokenProgram: TOKEN_2022_ADDRESS,
            mint,
          });
          const createAtaIx =
            await getCreateAssociatedTokenIdempotentInstructionAsync({
              payer: signer,
              owner: beneficiary,
              mint,
              tokenProgram: TOKEN_2022_ADDRESS,
            });
          const baseIx = await getReturnCustodyVaultInstructionAsync({
            signer,
            shareClass: address(req.share_class_pda),
            custodyVault: vaultPda,
            authorityAdminRecord: await custodyAuthorityRecord(
              client.runtime.rpc,
              vaultPda,
            ),
            mint,
            escrow,
            beneficiaryTokenAccount: beneficiaryAta,
            tokenProgram: TOKEN_2022_ADDRESS,
          });
          const returnIx = {
            ...baseIx,
            accounts: [
              ...baseIx.accounts,
              ...(await hookTransferMetas(client.runtime.rpc, mint, {
                sourceTokenAccount: escrow,
                destTokenAccount: beneficiaryAta,
                transferAuthority: vaultPda,
                sourceOwner: vaultPda,
                destOwner: beneficiary,
              })),
            ],
          };
          sig = await tx.send({
            instructions: [createAtaIx, returnIx],
            feePayer: signer,
          });
          // Normally the escrow is empty here (that is the whole premise of
          // this exit), so the return is terminal. It is not guaranteed:
          // anyone can raw-transfer into an escrow, and un-ledgered units are
          // withheld unless the beneficiary's KYC passes — which leaves the
          // vault OPEN while this row says "cancelled".
          returnTerminal = (
            await readReturnOutcome(client.runtime.rpc, vaultPda)
          ).terminal;
        }
      }
      const ok = await adminUpdateDeliveryRequest(conn.wallet, req.id, {
        status: "cancelled",
        admin_note: reason || null,
        outcome_tx: sig ?? null,
        decide: true,
      });
      toast.dismiss(pendingId);
      if (!ok) {
        toast.showError(
          "Status update failed",
          "The escrow was closed on-chain but the request row could not be updated.",
        );
      } else {
        toast.show({ kind: "success", title: "Delivery cancelled" });
      }
      if (!returnTerminal) {
        toast.showError(
          "Request cancelled, but the vault is still open",
          `${PARTIAL_RETURN_HINT} Resolve it from the vault detail card — the request row is already cancelled.`,
        );
      }
      void recordAudit({
        ix_name: "delivery_cancel_no_deposit",
        category: "custody",
        actor_wallet: wallet.toString(),
        reason: reason || "Cancelled — no deposit",
        target_label: target,
        tx_signature: sig,
        metadata: { delivery_request_id: req.id, vault_pda: req.vault_pda },
      });
      setCancelOpenReq(null);
      await onRefresh();
    } catch (err) {
      toast.dismiss(pendingId);
      toast.showError(
        "Cancel failed",
        explainSendError(err),
      );
    }
  }

  async function confirmDelivery(req: DeliveryRequest, reason: string) {
    if (!wallet || !req.vault_pda) return;
    const target = deliveryTargetLabel(req);
    const pendingId = toast.showPending(
      `Confirming delivery for ${target}…`,
      reason,
    );
    let sentSignature: string | undefined;
    let prepared = false;
    try {
      outcomeRecovery.prepare(req.id, "delivered");
      prepared = true;
      const signer = walletSigner(conn.wallet);
      const vaultPda = address(req.vault_pda);
      const [escrow] = await findOpenCustodyVaultEscrowPda({
        custodyVault: vaultPda,
      });
      const triggerIx = getTriggerCustodyVaultInstruction({
        authority: signer,
        custodyVault: vaultPda,
        authorityAdminRecord: await custodyAuthorityRecord(
          client.runtime.rpc,
          vaultPda,
        ),
      });
      // escrowMarker (["escrow_marker", vault PDA]) is auto-derived by the
      // async builder — closed on-chain by this terminal path. The KYC gate
      // (2C-3) needs the pinned registry + the holder's KycEntry; if it
      // fails, the whole transaction (trigger included) rolls back.
      const kycAccounts = await requestRealizeKycAccounts(
        client.runtime.rpc,
        vaultPda,
      );
      const realizeIx = await getRealizeCustodyVaultInstructionAsync({
        authority: signer,
        shareClass: address(req.share_class_pda),
        custodyVault: vaultPda,
        authorityAdminRecord: await custodyAuthorityRecord(
          client.runtime.rpc,
          vaultPda,
        ),
        mint: address(req.mint),
        escrow,
        tokenProgram: TOKEN_2022_ADDRESS,
        ...kycAccounts,
      });
      // BurnAndAttest burns the escrowed tokens — trigger then realize in one
      // transaction; the Triggered state from the first ix is visible to the
      // second within the same transaction. send() resolves with the confirmed
      // signature — tx.signature is stale closure state.
      const sig = await tx.send({
        instructions: [triggerIx, realizeIx],
        feePayer: signer,
      });
      sentSignature = sig;
      await outcomeRecovery.record(req.id, "delivered", sig);
      toast.dismiss(pendingId);
      toast.showTx(sig, {
        title: "Custody realization recorded — tokens burned",
      });
      void recordAudit({
        ix_name: "realize_custody",
        category: "custody",
        actor_wallet: wallet.toString(),
        reason,
        target_label: target,
        tx_signature: sig,
        metadata: {
          delivery_request_id: req.id,
          vault_pda: req.vault_pda,
          realize_action: RealizeAction.BurnAndAttest,
          kyc_registry: kycAccounts.kycRegistry ?? null,
        },
      });
      setConfirmReq(null);
      await onRefresh();
    } catch (err) {
      toast.dismiss(pendingId);
      const message = explainSendError(err);
      if (sentSignature)
        toast.showTx(sentSignature, {
          title: "Transaction sent — retry recording below",
        });
      toast.showError("Failed to confirm delivery", message);
      void recordAudit({
        ix_name: "realize_custody",
        category: "custody",
        actor_wallet: wallet.toString(),
        reason,
        target_label: target,
        status: "failed",
        metadata: {
          delivery_request_id: req.id,
          vault_pda: req.vault_pda,
          error: message,
        },
      });
    } finally {
      if (prepared) outcomeRecovery.release();
    }
  }

  async function cancelAndReturn(req: DeliveryRequest, reason: string) {
    if (!wallet || !req.vault_pda) return;
    const target = deliveryTargetLabel(req);
    const pendingId = toast.showPending(
      `Returning escrow for ${target}…`,
      reason,
    );
    let sentSignature: string | undefined;
    let prepared = false;
    try {
      outcomeRecovery.prepare(req.id, "returned");
      prepared = true;
      const signer = walletSigner(conn.wallet);
      const vaultPda = address(req.vault_pda);
      const mint = address(req.mint);
      const beneficiary = address(req.holder_wallet);
      const [escrow] = await findOpenCustodyVaultEscrowPda({
        custodyVault: vaultPda,
      });
      const [beneficiaryAta] = await findAssociatedTokenPda({
        owner: beneficiary,
        tokenProgram: TOKEN_2022_ADDRESS,
        mint,
      });
      const createAtaIx =
        await getCreateAssociatedTokenIdempotentInstructionAsync({
          payer: signer,
          owner: beneficiary,
          mint,
          tokenProgram: TOKEN_2022_ADDRESS,
        });
      // escrowMarker (["escrow_marker", vault PDA]) is auto-derived by the
      // async builder. It is closed ONLY when the return fully drains the
      // escrow — a withheld surplus keeps both the vault and the marker alive
      // so the remainder still has an exit (readReturnOutcome reports which).
      const baseIx = await getReturnCustodyVaultInstructionAsync({
        signer,
        shareClass: address(req.share_class_pda),
        custodyVault: vaultPda,
        authorityAdminRecord: await custodyAuthorityRecord(
          client.runtime.rpc,
          vaultPda,
        ),
        mint,
        escrow,
        beneficiaryTokenAccount: beneficiaryAta,
        tokenProgram: TOKEN_2022_ADDRESS,
      });
      // The escrow pays out via transfer_checked of a hook mint — append the
      // mode-aware hook tail for the return leg (source authority = vault PDA).
      const returnIx = {
        ...baseIx,
        accounts: [
          ...baseIx.accounts,
          ...(await hookTransferMetas(client.runtime.rpc, mint, {
            sourceTokenAccount: escrow,
            destTokenAccount: beneficiaryAta,
            transferAuthority: vaultPda,
            sourceOwner: vaultPda,
            destOwner: beneficiary,
          })),
        ],
      };
      const sig = await tx.send({
        instructions: [createAtaIx, returnIx],
        feePayer: signer,
      });
      sentSignature = sig;
      await outcomeRecovery.record(req.id, "returned", sig);
      toast.dismiss(pendingId);
      toast.showTx(sig, { title: "Holder deposit returned and recorded" });
      void recordAudit({
        ix_name: "return_custody_vault",
        category: "custody",
        actor_wallet: wallet.toString(),
        reason,
        target_label: target,
        tx_signature: sig,
        metadata: {
          delivery_request_id: req.id,
          vault_pda: req.vault_pda,
        },
      });
      setReturnReq(null);
      await onRefresh();
    } catch (err) {
      toast.dismiss(pendingId);
      const message = explainSendError(err);
      if (sentSignature)
        toast.showTx(sentSignature, {
          title: "Transaction sent — retry recording below",
        });
      toast.showError("Failed to return escrow", message);
      void recordAudit({
        ix_name: "return_custody_vault",
        category: "custody",
        actor_wallet: wallet.toString(),
        reason,
        target_label: target,
        status: "failed",
        metadata: {
          delivery_request_id: req.id,
          vault_pda: req.vault_pda,
          error: message,
        },
      });
    } finally {
      if (prepared) outcomeRecovery.release();
    }
  }

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-card">
      {outcomeRecovery.panel}
      <div className="flex items-center justify-between gap-4 border-b border-slate-100 px-4 py-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            Delivery requests
          </p>
          <p className="mt-0.5 text-[11px] text-slate-500">
            Approve to open a DeliveryEscrow vault, then track deposit →
            delivery → burn. &quot;Mark in delivery&quot; is off-chain only —
            the physical handover happens outside the chain. It and
            &quot;Confirm delivery&quot; both need the holder&apos;s approved
            investor passport.
          </p>
        </div>
        {pendingCount > 0 && (
          <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800">
            {pendingCount} pending
          </span>
        )}
      </div>

      {loadError ? (
        <div className="px-4 py-8 text-center text-sm text-red-600">
          {loadError}{" "}
          <button
            type="button"
            onClick={() => void load()}
            className="underline underline-offset-2"
          >
            Retry
          </button>
        </div>
      ) : !loaded ? (
        <p className="px-4 py-8 text-center text-sm text-slate-500">
          Loading delivery requests…
        </p>
      ) : requests.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-slate-500">
          No delivery requests yet.
        </p>
      ) : (
        <table className="w-full text-sm">
          <thead className="border-b border-slate-100 bg-slate-50 text-left text-xs uppercase tracking-wider text-slate-500">
            <tr>
              <th className="px-4 py-3 font-medium">Request</th>
              <th className="px-4 py-3 font-medium">Holder</th>
              <th className="px-4 py-3 text-right font-medium">Amount</th>
              <th className="px-4 py-3 font-medium">Delivery details</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {requests.map((r) => {
              const info = r.vault_pda ? vaultInfo.get(r.vault_pda) : undefined;
              // KYC at delivery (2C-3): the handover ("Mark in delivery") and
              // the realize both need the holder's approved passport in the
              // vault's pinned registry.
              const loadIssue = r.vault_pda
                ? vaultLoadIssue.get(r.vault_pda)
                : undefined;
              const passportBlock = requestPassportBlock(info, loadIssue);
              return (
              <tr key={r.id} className="text-slate-700">
                <td className="px-4 py-3">
                  <p className="font-medium text-slate-900">
                    {r.asset_label || "—"}
                  </p>
                  <p className="mt-0.5 font-mono text-[11px] text-slate-500">
                    {r.id.slice(0, 8)} ·{" "}
                    {new Date(r.created_at).toISOString().slice(0, 10)}
                    {r.vault_id != null ? ` · vault #${r.vault_id}` : ""}
                  </p>
                </td>
                <td className="px-4 py-3">
                  <p
                    className="font-mono text-xs text-slate-700"
                    title={r.holder_wallet}
                  >
                    {r.holder_wallet.slice(0, 4)}…{r.holder_wallet.slice(-4)}
                  </p>
                  <p
                    className="mt-0.5 max-w-36 truncate text-[11px] text-slate-500"
                    title={r.contact}
                  >
                    {r.contact || "—"}
                  </p>
                  {(r.status === "vault_opened" ||
                    r.status === "deposited" ||
                    r.status === "in_delivery") && (
                    <RequestPassportGate
                      info={info}
                      issue={loadIssue}
                      onRetry={() => void loadVaultInfo(requests)}
                      clientId={r.client_id}
                      holderWallet={r.holder_wallet}
                    />
                  )}
                </td>
                <td className="px-4 py-3 text-right font-mono">{r.amount}</td>
                <td className="px-4 py-3">
                  <p
                    className="max-w-52 truncate text-xs text-slate-600"
                    title={r.delivery_details}
                  >
                    {r.delivery_details || "—"}
                  </p>
                </td>
                <td className="px-4 py-3">
                  <span
                    className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${DELIVERY_STATUS_BADGE[r.status]}`}
                  >
                    {DELIVERY_STATUS_LABEL[r.status]}
                  </span>
                  {r.status === "cancelled" && r.admin_note && (
                    <p className="mt-1 max-w-44 text-[11px] leading-snug text-slate-500">
                      {r.admin_note}
                    </p>
                  )}
                </td>
                <td className="space-x-3 px-4 py-3 text-right text-xs">
                  {r.status === "requested" && (
                    <>
                      <button
                        type="button"
                        disabled={tx.isSending || busyId === r.id}
                        onClick={() => setApproveReq(r)}
                        className="text-slate-700 underline-offset-2 hover:underline disabled:opacity-50"
                      >
                        Approve &amp; open vault
                      </button>
                      <button
                        type="button"
                        disabled={tx.isSending || busyId === r.id}
                        onClick={() => setRejectReq(r)}
                        className="text-red-700 underline-offset-2 hover:underline disabled:opacity-50"
                      >
                        Reject
                      </button>
                    </>
                  )}
                  {r.status === "vault_opened" && (
                    <>
                      <span className="text-slate-400">
                        Awaiting holder deposit
                      </span>
                      <button
                        type="button"
                        disabled={tx.isSending}
                        onClick={() => setCancelOpenReq(r)}
                        className="ml-3 text-red-700 underline-offset-2 hover:underline disabled:opacity-50"
                      >
                        Cancel (no deposit)
                      </button>
                    </>
                  )}
                  {(r.status === "deposited" || r.status === "in_delivery") && (
                    <>
                      {r.status === "deposited" && (
                        <button
                          type="button"
                          disabled={
                            tx.isSending ||
                            busyId === r.id ||
                            passportBlock !== null
                          }
                          title={passportBlock ?? undefined}
                          onClick={() => void markInDelivery(r)}
                          className="text-slate-700 underline-offset-2 hover:underline disabled:opacity-50"
                        >
                          Mark in delivery
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={
                          tx.isSending ||
                          busyId === r.id ||
                          !r.vault_pda ||
                          passportBlock !== null
                        }
                        title={passportBlock ?? undefined}
                        onClick={() => setConfirmReq(r)}
                        className="text-emerald-700 underline-offset-2 hover:underline disabled:opacity-50"
                      >
                        Confirm delivery
                      </button>
                      <button
                        type="button"
                        disabled={
                          tx.isSending || busyId === r.id || !r.vault_pda
                        }
                        onClick={() => setReturnReq(r)}
                        className="text-red-700 underline-offset-2 hover:underline disabled:opacity-50"
                      >
                        Cancel &amp; return
                      </button>
                    </>
                  )}
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {approveReq && (
        <ApproveDeliveryModal
          req={approveReq}
          onClose={() => setApproveReq(null)}
          onSuccess={() => {
            setApproveReq(null);
            void onRefresh();
          }}
        />
      )}

      <ConfirmModal
        open={rejectReq !== null}
        onClose={() => setRejectReq(null)}
        onConfirm={async (reason) => {
          if (rejectReq) await reject(rejectReq, reason);
        }}
        title="Reject delivery request"
        kind="warning"
        confirmLabel="Reject"
        description={
          <p>
            Rejecting marks the request as Cancelled before any vault is opened
            — no tokens move. The reason is stored as an admin note visible to
            the holder.
          </p>
        }
        busy={tx.isSending || outcomeRecovery.busy || !outcomeRecovery.ready}
      />
      <ConfirmModal
        open={cancelOpenReq !== null}
        onClose={() => setCancelOpenReq(null)}
        onConfirm={async (reason) => {
          if (cancelOpenReq) await cancelNoDeposit(cancelOpenReq, reason);
        }}
        title="Cancel — no deposit"
        kind="warning"
        confirmLabel="Cancel delivery"
        description={
          <p>
            The holder never deposited. This closes the (empty) escrow vault
            on-chain so it can never swallow a late deposit, and marks the
            request Cancelled. Reason stored as an admin note.
          </p>
        }
        busy={tx.isSending || outcomeRecovery.busy || !outcomeRecovery.ready}
      />
      <ConfirmModal
        open={confirmReq !== null}
        onClose={() => setConfirmReq(null)}
        onConfirm={async (reason) => {
          if (confirmReq) await confirmDelivery(confirmReq, reason);
        }}
        title="Confirm delivery"
        kind="destructive"
        confirmLabel="Confirm & burn"
        description={
          <>
            <p>
              Triggers and realizes the DeliveryEscrow vault (
              <strong>Burn &amp; attest</strong>) — the escrowed tokens are
              burned. This is <strong>irreversible</strong>.
            </p>
            <p className="mt-2 text-xs text-slate-500">
              Confirm only after the physical delivery is complete. Reason
              recorded in audit log.
            </p>
          </>
        }
        busy={tx.isSending || outcomeRecovery.busy || !outcomeRecovery.ready}
      />
      <ConfirmModal
        open={returnReq !== null}
        onClose={() => setReturnReq(null)}
        onConfirm={async (reason) => {
          if (returnReq) await cancelAndReturn(returnReq, reason);
        }}
        title="Cancel & return escrow"
        kind="warning"
        confirmLabel="Return tokens"
        description={
          <p>
            Returns the escrowed tokens to the holder&apos;s wallet via
            return_custody_vault and marks the request as Returned. Use when the
            off-chain delivery cannot be completed. Reason recorded in audit
            log.
          </p>
        }
        busy={tx.isSending || outcomeRecovery.busy || !outcomeRecovery.ready}
      />
    </div>
  );
}

/** Format a Date as a `datetime-local` input value (local time, minute precision). */
function toDatetimeLocalValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Deadline is mandatory for DeliveryEscrow and must be at least 24h out. */
function deliveryDeadlineError(value: string): string | null {
  if (!value.trim()) return "Deadline is required";
  const t = new Date(value).getTime();
  if (Number.isNaN(t)) return "Not a valid date";
  if (t < Date.now() + DAY_MS)
    return "Deadline must be at least 24 hours from now";
  return null;
}

function ApproveDeliveryModal({
  req,
  onClose,
  onSuccess,
}: {
  req: DeliveryRequest;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const conn = useWalletConnection();
  const tx = useSendTransaction();
  const toast = useToast();
  const wallet = conn.wallet?.account.address;
  const recovery = useCustodyOpenRecovery(
    "delivery",
    req,
    conn.wallet,
    onSuccess,
  );

  const [vaultId, setVaultId] = useState("1");
  const amount = String(req.amount);
  let inputError: string | null = null;
  try {
    parseCustodyVaultId(vaultId);
    requireCustodyRequestAmount(amount, req.amount);
  } catch (error) {
    inputError =
      error instanceof Error
        ? error.message
        : "Invalid vault ID or request amount.";
  }
  const [deadlineDate, setDeadlineDate] = useState(() =>
    toDatetimeLocalValue(new Date(Date.now() + 30 * DAY_MS)),
  );
  const deadlineError = deliveryDeadlineError(deadlineDate);

  // Attestation document / hash → metadata_hash (no more zero hashes).
  const [attFile, setAttFile] = useState<File | null>(null);
  const [attFileHash, setAttFileHash] = useState("");
  const [attPasted, setAttPasted] = useState("");
  const attHash = attFile ? attFileHash : attPasted.trim().toLowerCase();
  const attHashOk = isValidSha256Hex(attHash);
  // KYC at conversion / delivery (2C-3): the vault pins the platform KYC
  // registry; the holder's passport there is shown for information (the
  // open needs none — the realize does).
  const platformRegistry = usePlatformKycRegistry(true);
  const pinnedRegistry = platformRegistry.registry;
  const holderPassport = useHolderPassport(pinnedRegistry, req.holder_wallet);

  async function approve() {
    if (
      !wallet ||
      inputError ||
      deadlineError ||
      !attHashOk ||
      !pinnedRegistry ||
      !recovery.ready ||
      recovery.pending
    )
      return;
    const target = deliveryTargetLabel(req);
    const pendingId = toast.showPending(`Opening delivery vault #${vaultId}…`);
    try {
      const signer = walletSigner(conn.wallet);
      const intent = await recovery.open(
        vaultId,
        async () => {
          if (attFile)
            await uploadAttestationDoc(
              conn.wallet,
              "delivery",
              attFile,
              attHash,
            );
          // Both holder workflows deliberately use DeliveryEscrow: its refund
          // returns property, while ConversionPending's deadline exit burns it.
          return getOpenCustodyVaultInstructionAsync({
            authority: signer,
            shareClass: address(req.share_class_pda),
            mint: address(req.mint),
            tokenProgram: TOKEN_2022_ADDRESS,
            vaultId: parseCustodyVaultId(vaultId),
            vaultType: VaultType.DeliveryEscrow,
            realizeAction: RealizeAction.BurnAndAttest,
            amount: requireCustodyRequestAmount(amount, req.amount),
            deadline: BigInt(
              Math.floor(new Date(deadlineDate).getTime() / 1000),
            ),
            metadataHash: hexToBytes32(attHash),
            beneficiary: address(req.holder_wallet),
            kycRegistry: pinnedRegistry,
          });
        },
        (ix) => tx.send({ instructions: [ix], feePayer: signer }),
      );
      toast.dismiss(pendingId);
      if (intent.signature)
        toast.showTx(intent.signature, {
          title: "Delivery vault opened and linked",
        });
      void recordAudit({
        ix_name: "open_custody_vault",
        category: "custody",
        actor_wallet: wallet.toString(),
        reason: `Approve delivery request ${req.id.slice(0, 8)}`,
        target_label: target,
        tx_signature: intent.signature ?? undefined,
        metadata: {
          delivery_request_id: req.id,
          vault_pda: intent.vaultPda,
          vault_id: intent.vaultId,
          vault_type: "DeliveryEscrow",
          beneficiary: req.holder_wallet,
          kyc_registry: pinnedRegistry,
          metadata_hash: attHash,
          metadata_hash_source: attFile ? "file" : "pasted",
        },
      });
      onSuccess();
    } catch (err) {
      toast.dismiss(pendingId);
      toast.showError(
        recovery.hasPending()
          ? "Approval recording pending"
          : "Failed to open vault",
        explainSendError(err),
      );
    }
  }

  if (!wallet) return null;

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center overflow-y-auto bg-slate-900/40 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !tx.isSending && !recovery.busy)
          onClose();
      }}
    >
      <div className="mx-auto w-full max-w-2xl overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl">
        <div className="border-b border-slate-100 px-5 py-4">
          <p className="text-sm font-semibold uppercase tracking-wide text-slate-700">
            Approve delivery request
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Opens a DeliveryEscrow custody vault (Burn &amp; attest) with the
            holder as beneficiary. The holder then deposits the tokens.
          </p>
        </div>
        <div className="space-y-4 px-5 py-4">
          {recovery.panel}
          <FieldError error={inputError} />
          <dl className="grid gap-3 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Asset
              </dt>
              <dd className="mt-0.5 text-slate-800">
                {req.asset_label || "—"}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Holder (beneficiary)
              </dt>
              <dd className="mt-0.5 break-all font-mono text-xs text-slate-800">
                {req.holder_wallet}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Contact
              </dt>
              <dd className="mt-0.5 text-slate-800">{req.contact || "—"}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Delivery details
              </dt>
              <dd className="mt-0.5 whitespace-pre-wrap text-slate-800">
                {req.delivery_details || "—"}
              </dd>
            </div>
          </dl>

          <div className="grid gap-3 sm:grid-cols-3">
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Vault ID
              </span>
              <input
                value={vaultId}
                inputMode="numeric"
                onChange={(e) => setVaultId(e.target.value.replace(/\D/g, ""))}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Amount (units)
              </span>
              <input
                value={amount}
                inputMode="numeric"
                readOnly
                aria-readonly="true"
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              />
              <span className="mt-1 block text-[11px] text-slate-400">
                Fixed to the requested amount: {req.amount}
              </span>
            </label>
            <label className="block">
              <FieldLabel required>Deadline</FieldLabel>
              <input
                type="datetime-local"
                value={deadlineDate}
                onChange={(e) => setDeadlineDate(e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              />
              <FieldError error={deadlineError} />
              <FieldHelp>
                After this deadline the escrow becomes permissionlessly
                returnable to the holder.
              </FieldHelp>
            </label>
          </div>
          <PinnedRegistryLine
            registry={pinnedRegistry}
            error={platformRegistry.error}
          />
          {pinnedRegistry && (
            <BeneficiaryPassport
              passport={holderPassport}
              registry={pinnedRegistry}
              shortcutHref={passportShortcutHref({
                clientId: req.client_id,
                wallet: req.holder_wallet,
              })}
            />
          )}
          <AttestationDocSection
            kindLabel="delivery confirmation / agreement"
            file={attFile}
            fileHash={attFileHash}
            pastedHash={attPasted}
            onFileChange={(f, hex) => {
              setAttFile(f);
              setAttFileHash(hex);
            }}
            onPastedChange={setAttPasted}
            disabled={tx.isSending || recovery.busy}
          />
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-100 bg-slate-50 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={tx.isSending || recovery.busy}
            className="rounded-md px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-200 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void approve()}
            disabled={
              tx.isSending ||
              recovery.busy ||
              !recovery.ready ||
              !!recovery.pending ||
              inputError !== null ||
              !vaultId.trim() ||
              !amount.trim() ||
              deadlineError !== null ||
              !attHashOk ||
              !pinnedRegistry
            }
            className="rounded-md bg-brand-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-800 disabled:opacity-50"
          >
            {tx.isSending || recovery.busy ? "Processing…" : "Open vault"}
          </button>
        </div>
      </div>
    </div>
  );
}
