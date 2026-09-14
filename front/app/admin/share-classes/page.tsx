"use client";

import { WALLET_CONNECT_DESCRIPTION } from "@/lib/wallet-copy";

import {
  loadIssuerPermission,
  resolveIssuerPermission,
  ISSUER_CAPABILITIES,
} from "@/lib/issuer-permissions";
import { WalletRequired } from "@/components/wallet-required";

import { type Address } from "@solana/kit";
import { createWalletTransactionSigner } from "@solana/client";
import {
  useSendTransaction,
  useSolanaClient,
  useWalletConnection,
} from "@solana/react-hooks";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AssetType,
  fetchMaybeAsset,
  fetchMaybeIssuer,
  findAssetPda,
  findIssuerPda,
  findMintPda,
  getAddShareClassInstructionAsync,
  getInitializeShareClassMintInstructionAsync,
  getLockSupplyInstructionAsync,
  getMintToTreasuryInstructionAsync,
  getSetConvertibleToInstruction,
  ShareClassType,
  type Asset,
  type ShareClass,
} from "@/lib/generated/asset_registry";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
} from "@solana-program/token-2022";
import {
  findConfigPda,
  findExtraAccountMetaListPda,
  fetchMaybeTransferHookConfig,
  getUpdateTransferHookConfigInstructionAsync,
  RestrictionMode,
  TRANSFER_HOOK_PROGRAM_ADDRESS,
} from "@/lib/generated/transfer_hook";
import { loadNetwork, type NetworkData } from "@/lib/enumerate";
import { loadNetworkPreferIndexer } from "@/lib/indexer";
import { ASSET_TYPE_LABEL, fromBytes32, toBytes32 } from "@/lib/format";
import { findShareClassPda } from "@/lib/pdas";
import { shareClassTypesForAssetType } from "@/lib/asset-types";
import { walletSigner } from "@/lib/wallet-signer";
import { buildUpdateMintMetadataInstruction } from "@/lib/transaction-builders";
import { loadKycAuthorityContext } from "@/lib/kyc-authority";
import { ConfirmModal } from "@/components/confirm-modal";
import { recordAudit } from "@/lib/supabase";
import { SkeletonCard, SkeletonTable } from "@/components/skeleton";
import { RequireRole } from "@/components/require-role";
import { useRole } from "@/lib/auth";
import { useToast } from "@/lib/toast";

const TOKEN_2022_ADDRESS =
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" as Address;

const CLASS_TYPE = [
  "Common",
  "Preferred A",
  "Preferred B",
  "Senior debt",
  "Junior debt",
  "Rev-share tier",
  "Royalty tier",
];

const RIGHTS = [
  { bit: 1, label: "Vote" },
  { bit: 2, label: "Dividend" },
  { bit: 4, label: "Liquidation pref." },
  { bit: 8, label: "Convertible" },
  { bit: 16, label: "Redeemable" },
  { bit: 32, label: "Transferable" },
];

type LifecycleStatus = "pending-mint" | "active" | "locked";
type StatusFilter = "all" | LifecycleStatus;

function statusOf(sc: ShareClass): LifecycleStatus {
  if (sc.supplyLocked) return "locked";
  if (sc.mintInitialized) return "active";
  return "pending-mint";
}

const STATUS_BADGE: Record<LifecycleStatus, string> = {
  "pending-mint": "bg-amber-100 text-amber-800 border-amber-200",
  active: "bg-emerald-100 text-emerald-800 border-emerald-200",
  locked: "bg-slate-200 text-slate-800 border-slate-300",
};

const STATUS_LABEL: Record<LifecycleStatus, string> = {
  "pending-mint": "Pending mint",
  active: "Active",
  locked: "Locked",
};

export default function ShareClassesPage() {
  return (
    <section className="min-w-0 flex-1">
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
          Share classes
        </p>
        <h1 className="mt-1 text-xl font-semibold text-slate-900">
          Share class lifecycle
        </h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-slate-600">
          Every share class on Mancipatio — Token-2022 mint state, supply,
          rights bitfield and lifecycle actions.
        </p>
      </div>
      <RequireRole role="admin">
        <ShareClassesOps />
      </RequireRole>
    </section>
  );
}

function ShareClassesOps() {
  const client = useSolanaClient();
  const [data, setData] = useState<NetworkData | null>(null);
  const [failed, setFailed] = useState(false);
  const [assetPdaMap, setAssetPdaMap] = useState<Map<string, Asset>>(new Map());
  // ShareClass PDA (string) → ShareClass — lets the table resolve a
  // `convertible_to` target address back to a human-readable class.
  const [scByPda, setScByPda] = useState<Map<string, ShareClass>>(new Map());
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const network = await loadNetworkPreferIndexer(() =>
        loadNetwork(client.runtime.rpc),
      );
      setData(network);

      // Resolve each Asset's PDA so we can join share_class.asset → Asset.
      // Asset.issuer is already the Issuer PDA, so we only need (issuer PDA, assetId).
      const next = new Map<string, Asset>();
      for (const asset of network.assets) {
        const [pda] = await findAssetPda({
          issuer: asset.issuer,
          assetId: asset.assetId,
        });
        next.set(pda.toString(), asset);
      }
      setAssetPdaMap(next);

      const byPda = new Map<string, ShareClass>();
      for (const sc of network.shareClasses) {
        const pda = await findShareClassPda(sc.asset, sc.classIndex);
        byPda.set(pda.toString(), sc);
      }
      setScByPda(byPda);
    } catch {
      setFailed(true);
    }
  }, [client]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const rows = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    return data.shareClasses
      .map((sc, i) => {
        const asset = assetPdaMap.get(sc.asset.toString());
        return { sc, asset, originalIndex: i };
      })
      .filter(({ sc, asset }) => {
        if (status !== "all" && statusOf(sc) !== status) return false;
        if (!q) return true;
        return (
          (asset?.name ?? "").toLowerCase().includes(q) ||
          (asset?.assetId ?? "").toLowerCase().includes(q) ||
          sc.mint.toString().toLowerCase().includes(q) ||
          CLASS_TYPE[sc.classType]?.toLowerCase().includes(q)
        );
      })
      .sort((a, b) => {
        const an = a.asset?.name ?? "~";
        const bn = b.asset?.name ?? "~";
        const cmp = an.localeCompare(bn);
        return cmp !== 0 ? cmp : a.sc.classIndex - b.sc.classIndex;
      });
  }, [data, assetPdaMap, query, status]);

  const selectedRow = useMemo(() => {
    if (!data || selectedIdx === null) return null;
    return rows.find((r) => r.originalIndex === selectedIdx) ?? null;
  }, [data, rows, selectedIdx]);

  if (failed) {
    return (
      <p className="mt-8 text-sm text-red-600">
        Failed to load share class directory.
      </p>
    );
  }

  return (
    <div className="mt-8 space-y-6">
      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-3">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by asset, mint, or class type…"
          className="min-w-[280px] flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-slate-400"
        />
        <div className="flex gap-1 rounded-lg border border-slate-200 bg-white p-1 text-xs">
          {(["all", "pending-mint", "active", "locked"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatus(s)}
              className={`rounded-md px-3 py-1.5 transition-colors ${
                status === s
                  ? "bg-slate-900 text-white"
                  : "text-slate-600 hover:bg-slate-100"
              }`}
            >
              {s === "all" ? "All" : STATUS_LABEL[s]}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setShowAdd(true)}
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
        >
          + Add share class
        </button>
      </div>

      {/* Table */}
      {data === null ? (
        <SkeletonTable rows={5} cols={7} />
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-12 text-center shadow-card">
          <p className="text-sm text-slate-600">
            {data.shareClasses.length === 0
              ? "No share classes registered yet."
              : "No share classes match the current filter."}
          </p>
          {data.shareClasses.length === 0 && (
            <button
              type="button"
              onClick={() => setShowAdd(true)}
              className="mt-4 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
            >
              Add the first share class
            </button>
          )}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-card">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-100 bg-slate-50 text-left text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-4 py-3 font-medium">Asset / class</th>
                <th className="px-4 py-3 font-medium">Type</th>
                <th className="px-4 py-3 font-medium">Mint</th>
                <th className="px-4 py-3 text-right font-medium">
                  Circulating
                </th>
                <th className="px-4 py-3 font-medium">Converts to</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map(({ sc, asset, originalIndex }) => {
                const s = statusOf(sc);
                const isSelected = originalIndex === selectedIdx;
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
                        #{sc.classIndex} · {asset?.assetId ?? "—"}
                      </p>
                    </td>
                    <td className="px-4 py-3 text-slate-700">
                      {CLASS_TYPE[sc.classType] ?? "?"}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-500">
                      {sc.mintInitialized
                        ? `${sc.mint.toString().slice(0, 6)}…${sc.mint.toString().slice(-4)}`
                        : "—"}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-slate-700">
                      {String(sc.circulatingSupply)}
                      {sc.maxSupply.__option === "Some" && (
                        <span className="ml-1 text-xs text-slate-400">
                          /{String(sc.maxSupply.value)}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-600">
                      <ConvertibleTargetLabel sc={sc} scByPda={scByPda} />
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${STATUS_BADGE[s]}`}
                      >
                        {STATUS_LABEL[s]}
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

      {/* Detail */}
      {selectedRow && data && (
        <ShareClassDetail
          sc={selectedRow.sc}
          asset={selectedRow.asset}
          allClasses={data.shareClasses}
          scByPda={scByPda}
          onRefresh={refresh}
          onClose={() => setSelectedIdx(null)}
        />
      )}

      {/* Add modal */}
      {showAdd && data && (
        <AddShareClassModal
          data={data}
          onClose={() => setShowAdd(false)}
          onSuccess={() => {
            void refresh();
            setShowAdd(false);
          }}
        />
      )}
    </div>
  );
}

/** Resolves a ShareClass PDA (from `convertible_to`) to "#idx · type". */
function describeTarget(
  target: Address,
  scByPda: Map<string, ShareClass>,
): string {
  const t = scByPda.get(target.toString());
  if (!t)
    return `${target.toString().slice(0, 6)}…${target.toString().slice(-4)}`;
  return `#${t.classIndex} · ${CLASS_TYPE[t.classType] ?? "?"}`;
}

function ConvertibleTargetLabel({
  sc,
  scByPda,
}: {
  sc: ShareClass;
  scByPda: Map<string, ShareClass>;
}) {
  if (sc.convertibleTo.__option === "None") {
    return <span className="text-slate-400">—</span>;
  }
  return <span>{describeTarget(sc.convertibleTo.value, scByPda)}</span>;
}

// "none" = mint exists but no hook config account (legacy mint — config
// creation is now CPI-only from the registry, so it cannot be added here).
type HookMode = "open" | "kyc-gated" | "none" | "unknown" | "loading";

// NOTE (destination binding): `mint_to_treasury` used to accept an arbitrary
// destination wallet here, guarded only by an off-chain "is this an onboarded
// client?" lookup plus an override checkbox. The program now BINDS the
// destination on-chain (handle_mint_to_treasury): it must be owned by the
// signing issuer authority — the treasury — or be the escrow of an `Active`
// `CustodyVault` / a `RightsIssuance` of this very mint, proven by passing
// that parent PDA in remaining accounts. Anything else fails with
// MintDestinationNotBound (6078), because `mint_to` never fires the transfer
// hook and freshly minted units would otherwise land in a wallet no
// receiver-KYC check ever saw. The wallet input and the override are gone;
// distribution to investors goes through a sale (`buy`, receiver-KYC gated)
// or a hook-checked transfer out of the treasury. Custody-vault / rights
// escrows are funded from their own screens (/admin/custody, /admin/rights).

function ShareClassDetail({
  sc,
  asset,
  allClasses,
  scByPda,
  onRefresh,
  onClose,
}: {
  sc: ShareClass;
  asset: Asset | undefined;
  allClasses: ShareClass[];
  scByPda: Map<string, ShareClass>;
  onRefresh: () => Promise<void>;
  onClose: () => void;
}) {
  const conn = useWalletConnection();
  const client = useSolanaClient();
  const tx = useSendTransaction();
  const toast = useToast();
  const { isSuperAdmin } = useRole();
  const wallet = conn.wallet?.account.address;
  const [mintAmount, setMintAmount] = useState("");
  const [confirmMint, setConfirmMint] = useState(false);
  const [confirmLock, setConfirmLock] = useState(false);
  const [scPda, setScPda] = useState<Address | null>(null);
  const [hookMode, setHookMode] = useState<HookMode>("loading");
  // Asset.issuer IS the Issuer PDA — no derivation needed.
  const issuerPda = asset?.issuer ?? null;

  // ── Conversion target (set_convertible_to) ─────────────────────────────
  // On-chain double gate: the signer must be the issuer authority AND hold
  // an issuer permission — mirror both checks here before offering the controls.
  const [issuerAuthority, setIssuerAuthority] = useState<string | null>(null);
  const [issuerCapabilities, setIssuerCapabilities] = useState(0);
  const [targetClassIndex, setTargetClassIndex] = useState("");
  const [confirmConvertible, setConfirmConvertible] = useState<
    "set" | "clear" | null
  >(null);
  const [metadataUri, setMetadataUri] = useState("");
  const [confirmMetadata, setConfirmMetadata] = useState(false);

  // Sibling classes of the SAME asset — the only valid conversion targets.
  const siblingClasses = useMemo(
    () =>
      allClasses.filter(
        (x) =>
          x.asset.toString() === sc.asset.toString() &&
          x.classIndex !== sc.classIndex,
      ),
    [allClasses, sc.asset, sc.classIndex],
  );

  useEffect(() => {
    let cancelled = false;
    async function loadIssuerAuthority() {
      if (!issuerPda) {
        if (!cancelled) setIssuerAuthority(null);
        return;
      }
      try {
        const maybe = await fetchMaybeIssuer(client.runtime.rpc, issuerPda);
        if (!cancelled) {
          setIssuerAuthority(
            maybe.exists ? maybe.data.authority.toString() : null,
          );
        }
      } catch {
        if (!cancelled) setIssuerAuthority(null);
      }
    }
    void loadIssuerAuthority();
    return () => {
      cancelled = true;
    };
  }, [issuerPda, client]);

  useEffect(() => {
    let active = true;
    if (wallet && issuerPda)
      loadIssuerPermission(client.runtime.rpc, issuerPda, wallet)
        .then((p) => {
          if (active) setIssuerCapabilities(p.capabilities);
        })
        .catch(() => {
          if (active) setIssuerCapabilities(0);
        });
    return () => {
      active = false;
    };
  }, [wallet, issuerPda, client]);

  const isIssuerAuthority =
    !!wallet && !!issuerAuthority && issuerAuthority === wallet.toString();

  async function setConvertibleTarget(reason: string, mode: "set" | "clear") {
    if (!wallet || !conn.wallet || !issuerPda || !scPda) return;
    if (mode === "set" && !targetClassIndex.trim()) return;
    const pendingId = toast.showPending(
      mode === "set"
        ? "Setting conversion target…"
        : "Clearing conversion target…",
    );
    try {
      const adminPda = await resolveIssuerPermission(
        client.runtime.rpc,
        issuerPda,
        wallet,
        ISSUER_CAPABILITIES.Conversion,
      );
      const signer = walletSigner(conn.wallet);
      const targetPda =
        mode === "set"
          ? await findShareClassPda(sc.asset, Number(targetClassIndex))
          : undefined;
      // Omitting targetShareClass clears convertible_to (optional account).
      const ix = await getSetConvertibleToInstruction({
        authority: signer,
        adminRecord: adminPda,
        issuer: issuerPda,
        asset: sc.asset,
        shareClass: scPda,
        ...(targetPda ? { targetShareClass: targetPda } : {}),
      });
      const sig = await tx.send({ instructions: [ix], feePayer: signer });
      toast.dismiss(pendingId);
      toast.showTx(sig, {
        title:
          mode === "set"
            ? "Conversion target set"
            : "Conversion target cleared",
      });
      void recordAudit({
        ix_name: "set_convertible_to",
        category: "share-class",
        actor_wallet: wallet.toString(),
        reason,
        target_label: scPda.toString(),
        tx_signature: sig,
        metadata:
          mode === "set" && targetPda
            ? { target_share_class: targetPda.toString() }
            : { target_share_class: null },
      });
      setConfirmConvertible(null);
      setTargetClassIndex("");
      await onRefresh();
    } catch (err) {
      toast.dismiss(pendingId);
      toast.showError(
        mode === "set"
          ? "Failed to set conversion target"
          : "Failed to clear conversion target",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /** update_mint_metadata — only the `uri` field may change (program-enforced). */
  async function updateMetadataUri(reason: string) {
    if (!wallet || !conn.wallet || !issuerPda || !scPda) return;
    const value = metadataUri.trim();
    if (value.length === 0) return;
    const pendingId = toast.showPending("Updating the mint metadata URI…");
    try {
      const adminPda = await resolveIssuerPermission(
        client.runtime.rpc,
        issuerPda,
        wallet,
        ISSUER_CAPABILITIES.Metadata,
      );
      const signer = walletSigner(conn.wallet);
      const ix = buildUpdateMintMetadataInstruction({
        authority: signer,
        adminRecord: adminPda,
        issuer: issuerPda,
        asset: sc.asset,
        shareClass: scPda,
        mint: sc.mint,
        field: "uri",
        value,
      });
      const sig = await tx.send({ instructions: [ix], feePayer: signer });
      toast.dismiss(pendingId);
      toast.showTx(sig, { title: "Metadata URI updated" });
      void recordAudit({
        ix_name: "update_mint_metadata",
        category: "share-class",
        actor_wallet: wallet.toString(),
        reason,
        target_label: scPda.toString(),
        tx_signature: sig,
        metadata: { field: "uri", value },
      });
      setConfirmMetadata(false);
      setMetadataUri("");
      await onRefresh();
    } catch (err) {
      toast.dismiss(pendingId);
      toast.showError(
        "Metadata update failed",
        err instanceof Error ? err.message : undefined,
      );
    }
  }

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const pda = await findShareClassPda(sc.asset, sc.classIndex);
      if (!cancelled) setScPda(pda);
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [sc.asset, sc.classIndex]);

  // Fetch transfer hook config to show current mode.
  useEffect(() => {
    let cancelled = false;
    async function loadHookMode() {
      if (!sc.mintInitialized) {
        if (!cancelled) setHookMode("unknown");
        return;
      }
      try {
        const [configPda] = await findConfigPda({ mint: sc.mint });
        const maybe = await fetchMaybeTransferHookConfig(
          client.runtime.rpc,
          configPda,
        );
        if (cancelled) return;
        if (!maybe.exists) {
          setHookMode("none");
        } else {
          setHookMode(
            maybe.data.restrictionMode === RestrictionMode.KycGated
              ? "kyc-gated"
              : "open",
          );
        }
      } catch {
        if (!cancelled) setHookMode("unknown");
      }
    }
    void loadHookMode();
    return () => {
      cancelled = true;
    };
  }, [sc.mint, sc.mintInitialized, client]);

  // Flip the hook config between Open and KycGated via
  // update_transfer_hook_config (super-admin op, gated on-chain by the
  // BlocklistAuthority). Config creation itself is CPI-only — legacy mints
  // without a config cannot be configured from here.
  async function updateHookMode(target: "open" | "kyc-gated") {
    if (
      !wallet ||
      !conn.wallet ||
      !isSuperAdmin ||
      !scPda ||
      !sc.mintInitialized
    )
      return;
    const label = target === "kyc-gated" ? "KycGated" : "Open";
    const pendingId = toast.showPending(`Setting transfer hook to ${label}…`);
    try {
      const signer = walletSigner(conn.wallet);
      let kycRegistry: Address | null = null;
      if (target === "kyc-gated") {
        // The program stores kyc_registry as plain instruction data — it
        // cannot verify the account exists, and a config pointing at a
        // nonexistent registry blocks every transfer of the mint. Pin the
        // hook to the LIVE registry found on-chain (e2e §5): the registry is
        // bound to its original provider key, so deriving it from the
        // connected Super Admin would, after admin rotation, point at a PDA
        // that does not exist (or steer the admin into creating a second one).
        const ctx = await loadKycAuthorityContext(client.runtime.rpc);
        if (ctx.ambiguous) {
          toast.dismiss(pendingId);
          toast.showError(
            "KYC registry ambiguous",
            `${ctx.registries.length} KYC registries exist and none belongs to the platform admin — resolve the KYC authority on /admin/kyc before gating this mint.`,
          );
          return;
        }
        if (!ctx.registry) {
          toast.dismiss(pendingId);
          toast.showError(
            "KYC registry not found",
            "No on-chain KYC registry exists — create it on /admin/kyc first. Setting KycGated now would point the hook at a nonexistent registry and block every transfer of this mint.",
          );
          return;
        }
        kycRegistry = ctx.registry.address;
      }

      // blocklistAuthority, config and extraAccountMetaList PDAs are
      // auto-derived by the generated client.
      const ix = await getUpdateTransferHookConfigInstructionAsync({
        authority: signer,
        mint: sc.mint,
        restrictionMode:
          target === "kyc-gated"
            ? RestrictionMode.KycGated
            : RestrictionMode.Open,
        kycRegistry,
      });

      // tx.signature is stale render-time state inside this callback — use
      // the signature send() resolves with.
      const sig = await tx.send({ instructions: [ix], feePayer: signer });
      toast.dismiss(pendingId);
      toast.showTx(sig, { title: `Transfer hook set to ${label}` });
      void recordAudit({
        ix_name: "update_transfer_hook_config",
        category: "share-class",
        actor_wallet: wallet.toString(),
        reason: `Set ${label} restriction mode`,
        target_label: scPda.toString(),
        tx_signature: sig,
      });
      setHookMode(target);
      await onRefresh();
    } catch (err) {
      toast.dismiss(pendingId);
      const message = err instanceof Error ? err.message : String(err);
      toast.showError(`Failed to set ${label}`, message);
    }
  }

  async function initMint() {
    if (!wallet || !conn.wallet || !issuerPda || !scPda) return;
    const pendingId = toast.showPending("Initializing Token-2022 mint…");
    try {
      const { signer } = createWalletTransactionSigner(conn.wallet);
      const [mintPda] = await findMintPda({ shareClass: scPda });
      const [hookConfigPda] = await findConfigPda({ mint: mintPda });
      const [metaListPda] = await findExtraAccountMetaListPda({
        mint: mintPda,
      });
      const ix = await getInitializeShareClassMintInstructionAsync({
        authority: signer,
        adminRecord: await resolveIssuerPermission(
          client.runtime.rpc,
          issuerPda,
          signer.address,
          ISSUER_CAPABILITIES.Mint,
        ),
        issuer: issuerPda,
        asset: sc.asset,
        shareClass: scPda,
        mint: mintPda,
        hookConfig: hookConfigPda,
        extraAccountMetaList: metaListPda,
        transferHookProgram: TRANSFER_HOOK_PROGRAM_ADDRESS,
        tokenProgram: TOKEN_2022_ADDRESS,
      });
      const sig = await tx.send({ instructions: [ix], feePayer: signer });
      toast.dismiss(pendingId);
      toast.showTx(sig, { title: "Mint initialized" });
      await onRefresh();
    } catch (err) {
      toast.dismiss(pendingId);
      toast.showError(
        "Failed to initialize mint",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // Mints into the ISSUER TREASURY — the token account owned by the signing
  // issuer authority (the connected wallet). That is the only destination the
  // program accepts from this screen; see the destination-binding note above.
  async function mintToTreasury(reason: string) {
    if (!wallet || !conn.wallet || !issuerPda || !scPda || !mintAmount.trim())
      return;
    if (!isIssuerAuthority) return;
    const destination = wallet;
    const amount = BigInt(mintAmount);
    const pendingId = toast.showPending(
      `Minting ${amount} units to the issuer treasury…`,
    );
    try {
      const { signer } = createWalletTransactionSigner(conn.wallet);
      const mint = sc.mint;
      const [ata] = await findAssociatedTokenPda({
        owner: destination,
        tokenProgram: TOKEN_2022_ADDRESS,
        mint,
      });
      const createAtaIx =
        await getCreateAssociatedTokenIdempotentInstructionAsync({
          payer: signer,
          owner: destination,
          mint,
          tokenProgram: TOKEN_2022_ADDRESS,
        });
      const mintIx = await getMintToTreasuryInstructionAsync({
        authority: signer,
        adminRecord: await resolveIssuerPermission(
          client.runtime.rpc,
          issuerPda,
          signer.address,
          ISSUER_CAPABILITIES.Mint,
        ),
        issuer: issuerPda,
        asset: sc.asset,
        shareClass: scPda,
        destination: ata,
        tokenProgram: TOKEN_2022_ADDRESS,
        amount,
      });
      const sig = await tx.send({
        instructions: [createAtaIx, mintIx],
        feePayer: signer,
      });
      toast.dismiss(pendingId);
      toast.showTx(sig, { title: "Minted to treasury" });
      void recordAudit({
        ix_name: "mint_to_treasury",
        category: "share-class",
        actor_wallet: wallet.toString(),
        reason,
        target_label: scPda.toString(),
        tx_signature: sig,
        metadata: {
          destination: "issuer_treasury",
          destination_wallet: destination.toString(),
          destination_token_account: ata.toString(),
          amount: amount.toString(),
        },
      });
      setConfirmMint(false);
      setMintAmount("");
      await onRefresh();
    } catch (err) {
      toast.dismiss(pendingId);
      toast.showError(
        "Failed to mint",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  async function lockSupply(reason: string) {
    if (!wallet || !conn.wallet || !scPda) return;
    const pendingId = toast.showPending("Locking supply…", reason);
    try {
      const { signer } = createWalletTransactionSigner(conn.wallet);
      const ix = await getLockSupplyInstructionAsync({
        authority: signer,
        shareClass: scPda,
      });
      const sig = await tx.send({ instructions: [ix], feePayer: signer });
      toast.dismiss(pendingId);
      toast.showTx(sig, { title: "Supply locked permanently" });
      void recordAudit({
        ix_name: "lock_supply",
        category: "share-class",
        actor_wallet: wallet.toString(),
        reason,
        target_label: scPda.toString(),
        tx_signature: sig,
      });
      setConfirmLock(false);
      await onRefresh();
    } catch (err) {
      toast.dismiss(pendingId);
      const message = err instanceof Error ? err.message : String(err);
      toast.showError("Failed to lock supply", message);
      void recordAudit({
        ix_name: "lock_supply",
        category: "share-class",
        actor_wallet: wallet.toString(),
        reason,
        target_label: scPda.toString(),
        status: "failed",
        metadata: { error: message },
      });
    }
  }

  const lifecycle = statusOf(sc);
  const rights = RIGHTS.filter((r) => (sc.rightsBitfield & r.bit) !== 0)
    .map((r) => r.label)
    .join(", ");

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-card">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            Share class detail
          </p>
          <h3 className="mt-1 text-lg font-semibold text-slate-900">
            {asset?.name ?? "(asset unknown)"} · #{sc.classIndex}
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
        <Field label="Class type" value={CLASS_TYPE[sc.classType] ?? "?"} />
        <Field label="Lifecycle" value={STATUS_LABEL[lifecycle]} />
        <Field label="Rights" value={rights || "none"} />
        <Field label="Voting weight" value={String(sc.votingWeight)} />
        <Field
          label="Liq. pref. multiplier"
          value={`${sc.liqPrefMultiplierBps} bps`}
        />
        <Field label="Liq. seniority" value={String(sc.liqSeniority)} />
        <Field
          label="Mint"
          value={sc.mintInitialized ? sc.mint.toString() : "not initialized"}
          mono
        />
        <Field label="Share class PDA" value={scPda?.toString() ?? "…"} mono />
        <Field
          label="Circulating supply"
          value={String(sc.circulatingSupply)}
        />
        <Field label="Locked supply" value={String(sc.lockedSupply)} />
        <Field
          label="Max supply"
          value={
            sc.maxSupply.__option === "Some"
              ? String(sc.maxSupply.value)
              : "uncapped"
          }
        />
        <Field
          label="Mintable post-launch"
          value={sc.mintablePostLaunch ? "Yes" : "No"}
        />
      </dl>

      {/* Transfer hook / KycGated */}
      {sc.mintInitialized && (
        <div className="mt-6 space-y-3 border-t border-slate-100 pt-5">
          <div className="flex items-center justify-between gap-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              Transfer restriction
            </p>
            {(hookMode === "open" || hookMode === "kyc-gated") && (
              <span
                className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
                  hookMode === "kyc-gated"
                    ? "border-brand-200 bg-brand-100 text-brand-800"
                    : "border-slate-200 bg-slate-100 text-slate-700"
                }`}
              >
                {hookMode === "kyc-gated" ? "KYC-gated" : "Open"}
              </span>
            )}
            {hookMode === "none" && (
              <span className="inline-flex rounded-full border border-amber-200 bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800">
                No hook config
              </span>
            )}
            {hookMode === "loading" && (
              <span className="text-xs text-slate-400">checking…</span>
            )}
          </div>
          {hookMode === "open" && isSuperAdmin && (
            <div>
              <p className="text-[13px] text-slate-600">
                Enable the KYC transfer hook — restricts all token transfers to
                holders with a valid on-chain passport.
              </p>
              <button
                type="button"
                disabled={tx.isSending}
                onClick={() => void updateHookMode("kyc-gated")}
                className="mt-3 rounded-lg border border-brand-300 bg-brand-50 px-4 py-2 text-sm font-medium text-brand-900 hover:bg-brand-100 disabled:opacity-50"
              >
                {tx.isSending ? "Sending…" : "Set KycGated"}
              </button>
              {!wallet && <WalletRequired />}
            </div>
          )}
          {hookMode === "kyc-gated" && (
            <div>
              <p className="text-sm text-brand-700">
                Transfer hook is active — all transfers require a valid KYC
                passport.
              </p>
              {isSuperAdmin && (
                <>
                  <button
                    type="button"
                    disabled={tx.isSending}
                    onClick={() => void updateHookMode("open")}
                    className="mt-3 rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-900 hover:border-slate-400 disabled:opacity-50"
                  >
                    {tx.isSending ? "Sending…" : "Set Open"}
                  </button>
                  {!wallet && <WalletRequired />}
                </>
              )}
            </div>
          )}
          {hookMode === "none" && (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] leading-relaxed text-amber-800">
              Legacy mint without hook config — transfers are disabled. The
              config can no longer be initialized directly; recreate the share
              class or run an ops migration.
            </p>
          )}
        </div>
      )}

      {/* Conversion target (set_convertible_to) */}
      <div className="mt-6 space-y-3 border-t border-slate-100 pt-5">
        <div className="flex items-center justify-between gap-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            Conversion target
          </p>
          {sc.convertibleTo.__option === "Some" ? (
            <span className="inline-flex rounded-full border border-brand-200 bg-brand-50 px-2 py-0.5 text-[11px] font-semibold text-brand-800">
              {describeTarget(sc.convertibleTo.value, scByPda)}
            </span>
          ) : (
            <span className="inline-flex rounded-full border border-slate-200 bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">
              Not convertible
            </span>
          )}
        </div>
        <p className="text-[13px] leading-relaxed text-slate-600">
          The share class this one converts into — must be another class of the
          same asset. Setting it requires the issuer authority wallet holding an
          admin record (on-chain double gate). A class with a recorded target
          appears in holders&apos; conversion-request flow; clearing it removes
          it.
        </p>
        {sc.convertibleTo.__option === "Some" && (
          <p className="break-all font-mono text-xs text-slate-500">
            {sc.convertibleTo.value.toString()}
          </p>
        )}
        {isIssuerAuthority &&
        (issuerCapabilities & ISSUER_CAPABILITIES.Conversion) !== 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={targetClassIndex}
              onChange={(e) => setTargetClassIndex(e.target.value)}
              disabled={siblingClasses.length === 0}
              className="min-w-[240px] rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-400 focus:outline-none disabled:opacity-50"
            >
              <option value="">
                {siblingClasses.length === 0
                  ? "No other share classes on this asset"
                  : "Select target class…"}
              </option>
              {siblingClasses.map((x) => (
                <option key={x.classIndex} value={String(x.classIndex)}>
                  #{x.classIndex} · {CLASS_TYPE[x.classType] ?? "?"}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={tx.isSending || !targetClassIndex.trim()}
              onClick={() => setConfirmConvertible("set")}
              className="rounded-lg border border-brand-300 bg-brand-50 px-4 py-2 text-sm font-medium text-brand-900 hover:bg-brand-100 disabled:opacity-50"
            >
              Set target
            </button>
            {sc.convertibleTo.__option === "Some" && (
              <button
                type="button"
                disabled={tx.isSending}
                onClick={() => setConfirmConvertible("clear")}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-900 hover:border-slate-400 disabled:opacity-50"
              >
                Clear target
              </button>
            )}
          </div>
        ) : (
          <p className="text-xs text-slate-400">
            {!wallet
              ? WALLET_CONNECT_DESCRIPTION
              : !isIssuerAuthority
                ? "Connected wallet is not this asset's issuer authority."
                : "Connected wallet holds no on-chain admin record — grant one on /admin/admins."}
          </p>
        )}
      </div>

      {/* Mint metadata (update_mint_metadata — uri only) */}
      {sc.mintInitialized && (
        <div className="mt-6 space-y-3 border-t border-slate-100 pt-5">
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            Mint metadata
          </p>
          <p className="text-[13px] leading-relaxed text-slate-600">
            Only the metadata{" "}
            <code className="rounded bg-slate-100 px-1 font-mono text-[11px]">
              uri
            </code>{" "}
            may change — name and symbol are fixed at mint creation. A longer
            uri grows the mint account; the program tops up rent automatically
            (payer = you). Same double gate as minting: issuer authority + admin
            record.
          </p>
          {isIssuerAuthority &&
          (issuerCapabilities & ISSUER_CAPABILITIES.Metadata) !== 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              <input
                value={metadataUri}
                onChange={(e) => setMetadataUri(e.target.value)}
                placeholder="https://…/metadata.json"
                className="min-w-[320px] flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-xs focus:border-slate-400 focus:outline-none"
              />
              <button
                type="button"
                disabled={tx.isSending || metadataUri.trim().length === 0}
                onClick={() => setConfirmMetadata(true)}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-900 hover:border-slate-400 disabled:opacity-50"
              >
                Update URI
              </button>
            </div>
          ) : (
            <p className="text-xs text-slate-400">
              {!wallet
                ? WALLET_CONNECT_DESCRIPTION
                : !isIssuerAuthority
                  ? "Connected wallet is not this asset's issuer authority."
                  : "Connected wallet holds no on-chain admin record — grant one on /admin/admins."}
            </p>
          )}
        </div>
      )}

      {/* Lifecycle actions */}
      <div className="mt-6 space-y-3 border-t border-slate-100 pt-5">
        <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
          Lifecycle actions
        </p>

        {!sc.mintInitialized && (
          <button
            type="button"
            disabled={tx.isSending}
            onClick={() => void initMint()}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {tx.isSending ? "Sending…" : "Initialize Token-2022 mint"}
          </button>
        )}

        {sc.mintInitialized && !sc.supplyLocked && (
          <div className="space-y-2">
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
              <p className="text-xs font-medium text-slate-700">
                Destination: the issuer treasury —{" "}
                <code className="break-all rounded bg-white px-1 font-mono text-[11px]">
                  {wallet ? wallet.toString() : "Not connected"}
                </code>
              </p>
              <p className="mt-1 text-[11px] text-slate-500">
                The program binds this destination on-chain: freshly minted
                units may only land in the signing issuer authority&apos;s own
                token account (or a custody / rights escrow of this mint, funded
                from /admin/custody and /admin/rights). Minting straight to an
                investor wallet is rejected (MintDestinationNotBound) — a{" "}
                <code className="font-mono">mint_to</code> never runs the
                transfer hook, so no receiver-KYC check would ever see it.
                Distribute from the treasury through a sale or a hook-checked
                transfer.
              </p>
              {wallet && !isIssuerAuthority && (
                <p className="mt-1 text-[11px] font-medium text-amber-700">
                  {issuerAuthority
                    ? "Connected wallet is not this asset's issuer authority — mint_to_treasury would fail with Unauthorized."
                    : "Could not read this asset's issuer authority — reload before minting."}
                </p>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <input
                value={mintAmount}
                inputMode="numeric"
                onChange={(e) =>
                  setMintAmount(e.target.value.replace(/\D/g, ""))
                }
                placeholder="Units to mint to treasury"
                className="min-w-[240px] flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              />
              <button
                type="button"
                disabled={
                  tx.isSending || !mintAmount.trim() || !isIssuerAuthority
                }
                onClick={() => setConfirmMint(true)}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-900 hover:border-slate-400 disabled:opacity-50"
              >
                Mint to treasury
              </button>
              <button
                type="button"
                disabled={tx.isSending}
                onClick={() => setConfirmLock(true)}
                className="rounded-lg border border-red-300 bg-red-50 px-4 py-2 text-sm font-medium text-red-900 hover:bg-red-100 disabled:opacity-50"
              >
                Lock supply
              </button>
            </div>
          </div>
        )}

        {sc.supplyLocked && (
          <p className="text-sm text-slate-500">
            Supply is permanently locked — no further minting possible.
          </p>
        )}
      </div>

      <ConfirmModal
        open={confirmMint}
        onClose={() => setConfirmMint(false)}
        onConfirm={(reason) => mintToTreasury(reason)}
        title="Mint to treasury"
        kind="info"
        confirmLabel="Mint"
        description={
          <>
            <p>
              Mint <strong>{mintAmount || "0"}</strong> units into the issuer
              treasury —{" "}
              <code className="break-all rounded bg-slate-100 px-1 font-mono text-xs">
                {wallet ? wallet.toString() : ""}
              </code>
              .
            </p>
            <p className="mt-2 text-xs text-slate-600">
              Units stay in the treasury until they are sold through a sale
              (receiver-KYC gated) or transferred out under the transfer hook.
            </p>
            <p className="mt-2 text-xs text-slate-500">
              Reason will be recorded in the audit log.
            </p>
          </>
        }
        busy={tx.isSending}
      />

      <ConfirmModal
        open={confirmMetadata}
        onClose={() => setConfirmMetadata(false)}
        onConfirm={(reason) => updateMetadataUri(reason)}
        title="Update mint metadata URI"
        kind="warning"
        confirmLabel="Update URI"
        description={
          <>
            <p>
              Point the Token-2022 metadata{" "}
              <code className="rounded bg-slate-100 px-1 font-mono text-xs">
                uri
              </code>{" "}
              of <strong>#{sc.classIndex}</strong>&apos;s mint to:
            </p>
            <p className="mt-2 break-all font-mono text-xs">
              {metadataUri.trim()}
            </p>
            <p className="mt-2 text-xs text-slate-600">
              Wallets and explorers resolve this uri for the token&apos;s
              off-chain metadata (image, description). Only the uri can change —
              name and symbol are fixed. A longer uri grows the mint account;
              the rent top-up is charged to you in the same transaction.
            </p>
            <p className="mt-2 text-xs text-slate-500">
              Reason will be recorded in the audit log.
            </p>
          </>
        }
        busy={tx.isSending}
      />

      <ConfirmModal
        open={confirmConvertible !== null}
        onClose={() => setConfirmConvertible(null)}
        onConfirm={(reason) =>
          setConvertibleTarget(reason, confirmConvertible ?? "set")
        }
        title={
          confirmConvertible === "clear"
            ? "Clear conversion target"
            : "Set conversion target"
        }
        kind="info"
        confirmLabel={confirmConvertible === "clear" ? "Clear" : "Set target"}
        description={
          <>
            {confirmConvertible === "clear" ? (
              <p>
                Clear the conversion target of{" "}
                <strong>
                  #{sc.classIndex} · {CLASS_TYPE[sc.classType] ?? "?"}
                </strong>{" "}
                — the class will no longer be convertible.
              </p>
            ) : (
              <p>
                Set{" "}
                <strong>
                  #{sc.classIndex} · {CLASS_TYPE[sc.classType] ?? "?"}
                </strong>{" "}
                to convert into{" "}
                <strong>
                  #{targetClassIndex}
                  {" · "}
                  {CLASS_TYPE[
                    siblingClasses.find(
                      (x) => String(x.classIndex) === targetClassIndex,
                    )?.classType ?? -1
                  ] ?? "?"}
                </strong>
                .
              </p>
            )}
            <p className="mt-2 text-xs text-slate-500">
              Reason will be recorded in the audit log.
            </p>
          </>
        }
        busy={tx.isSending}
      />

      <ConfirmModal
        open={confirmLock}
        onClose={() => setConfirmLock(false)}
        onConfirm={(reason) => lockSupply(reason)}
        title="Lock supply permanently"
        kind="destructive"
        confirmLabel="Lock supply"
        description={
          <>
            <p>
              Locking the supply is <strong>one-way</strong> — once locked, no
              further{" "}
              <code className="rounded bg-slate-100 px-1">
                mint_to_treasury
              </code>{" "}
              calls will succeed, even by Super Admin.
            </p>
            <p className="mt-2 text-xs text-slate-500">
              Reason will be recorded in the audit log.
            </p>
          </>
        }
        busy={tx.isSending}
      />
    </div>
  );
}

function AddShareClassModal({
  data,
  onClose,
  onSuccess,
}: {
  data: NetworkData;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const conn = useWalletConnection();
  const client = useSolanaClient();
  const tx = useSendTransaction();
  const toast = useToast();
  const wallet = conn.wallet?.account.address;

  const [issuerLegalId, setIssuerLegalId] = useState("");
  const [assetId, setAssetId] = useState("");
  const [classType, setClassType] = useState<ShareClassType>(
    ShareClassType.Common,
  );
  const [rights, setRights] = useState(1 | 2 | 32);
  const [liqPref, setLiqPref] = useState("10000");
  const [liqSeniority, setLiqSeniority] = useState("0");
  const [votingWeight, setVotingWeight] = useState("1");
  const [maxSupply, setMaxSupply] = useState("");
  const [mintablePostLaunch, setMintablePostLaunch] = useState(false);

  // Hint when issuer ID does not match.
  const matchedIssuer = useMemo(() => {
    if (!issuerLegalId.trim()) return null;
    return (
      data.issuers.find(
        (i) => fromBytes32(i.legalEntityId) === issuerLegalId.trim(),
      ) ?? null
    );
  }, [data, issuerLegalId]);

  // Resolve the matched issuer's PDA so we can pin the asset (and its type).
  const [matchedIssuerPda, setMatchedIssuerPda] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    async function derive() {
      if (!matchedIssuer) {
        setMatchedIssuerPda(null);
        return;
      }
      const [pda] = await findIssuerPda({
        legalEntityId: matchedIssuer.legalEntityId,
      });
      if (!cancelled) setMatchedIssuerPda(pda.toString());
    }
    void derive();
    return () => {
      cancelled = true;
    };
  }, [matchedIssuer]);

  // The asset being targeted — used to constrain the class-type options.
  const matchedAsset = useMemo(() => {
    if (!matchedIssuerPda || !assetId.trim()) return null;
    return (
      data.assets.find(
        (a) =>
          a.issuer.toString() === matchedIssuerPda &&
          a.assetId === assetId.trim(),
      ) ?? null
    );
  }, [data, matchedIssuerPda, assetId]);

  // Constrain the class-type choices to those sensible for the parent asset's type.
  const allowedClassTypes = useMemo(
    () => shareClassTypesForAssetType(matchedAsset?.assetType),
    [matchedAsset],
  );

  // Physical goods are unique items — the program enforces max_supply == 1
  // (PhysicalGoodRequiresUnitSupply), so lock the field instead of letting
  // the transaction bounce.
  const isPhysical = matchedAsset?.assetType === AssetType.PhysicalGood;
  useEffect(() => {
    if (isPhysical) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setMaxSupply("1");
    }
  }, [isPhysical]);
  // Keep the selected class type valid as the targeted asset (and its allowed
  // set) changes.
  useEffect(() => {
    if (!allowedClassTypes.some((t) => t.value === classType)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setClassType(allowedClassTypes[0]?.value as ShareClassType);
    }
  }, [allowedClassTypes, classType]);

  async function add() {
    if (!wallet || !conn.wallet || !issuerLegalId.trim() || !assetId.trim())
      return;
    const pendingId = toast.showPending(
      `Adding share class to ${assetId.trim()}…`,
    );
    try {
      const [ip] = await findIssuerPda({
        legalEntityId: toBytes32(issuerLegalId.trim()),
      });
      const [ap] = await findAssetPda({
        issuer: ip,
        assetId: assetId.trim(),
      });
      const assetData = await fetchMaybeAsset(client.runtime.rpc, ap);
      if (!assetData.exists) {
        toast.dismiss(pendingId);
        toast.showError("Asset not found", "Verify issuer ID and asset ID.");
        return;
      }
      const classIndex = assetData.data.shareClassesCount;
      const shareClassPda = await findShareClassPda(ap, classIndex);
      const { signer } = createWalletTransactionSigner(conn.wallet);
      const ix = await getAddShareClassInstructionAsync({
        authority: signer,
        issuer: ip,
        asset: ap,
        shareClass: shareClassPda,
        classIndex,
        classType,
        rightsBitfield: rights,
        liqPrefMultiplierBps: Number(liqPref) || 10000,
        liqSeniority: Number(liqSeniority) || 0,
        votingWeight: Number(votingWeight) || 0,
        maxSupply: isPhysical
          ? BigInt(1)
          : maxSupply.trim()
            ? BigInt(maxSupply)
            : null,
        mintablePostLaunch: isPhysical ? false : mintablePostLaunch,
      });
      const sig = await tx.send({ instructions: [ix], feePayer: signer });
      toast.dismiss(pendingId);
      toast.showTx(sig, { title: "Share class added" });
      onSuccess();
    } catch (err) {
      toast.dismiss(pendingId);
      toast.showError(
        "Failed to add share class",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  if (!wallet) {
    return (
      <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm">
        <SkeletonCard className="mx-4 max-w-md" rows={4} />
      </div>
    );
  }

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
            Add share class
          </p>
        </div>
        <div className="space-y-4 px-5 py-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
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
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Class type
              </span>
              <select
                value={classType}
                onChange={(e) =>
                  setClassType(Number(e.target.value) as ShareClassType)
                }
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              >
                {allowedClassTypes.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
              {matchedAsset && (
                <span className="mt-1 block text-[11px] text-slate-400">
                  Limited to types valid for{" "}
                  {ASSET_TYPE_LABEL[matchedAsset.assetType] ?? "this asset"}.
                </span>
              )}
            </label>
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Voting weight
              </span>
              <input
                value={votingWeight}
                inputMode="numeric"
                onChange={(e) =>
                  setVotingWeight(e.target.value.replace(/\D/g, ""))
                }
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Liq. pref. multiplier (bps)
              </span>
              <input
                value={liqPref}
                inputMode="numeric"
                onChange={(e) => setLiqPref(e.target.value.replace(/\D/g, ""))}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Liq. seniority
              </span>
              <input
                value={liqSeniority}
                inputMode="numeric"
                onChange={(e) =>
                  setLiqSeniority(e.target.value.replace(/\D/g, ""))
                }
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              />
            </label>
            <label className="block sm:col-span-2">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                {isPhysical ? "Max supply" : "Max supply (blank = uncapped)"}
              </span>
              <input
                value={isPhysical ? "1" : maxSupply}
                inputMode="numeric"
                readOnly={isPhysical}
                onChange={(e) =>
                  setMaxSupply(e.target.value.replace(/\D/g, ""))
                }
                className={`mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none ${
                  isPhysical ? "bg-slate-50 text-slate-500" : ""
                }`}
              />
              {isPhysical && (
                <span className="mt-1 block text-[11px] text-slate-400">
                  Unique items are supply-1 by design.
                </span>
              )}
            </label>
          </div>

          <div>
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Rights
            </span>
            <div className="mt-2 flex flex-wrap gap-3">
              {RIGHTS.map((r) => (
                <label
                  key={r.bit}
                  className="flex items-center gap-2 text-sm text-slate-700"
                >
                  <input
                    type="checkbox"
                    checked={(rights & r.bit) !== 0}
                    onChange={() => setRights(rights ^ r.bit)}
                  />
                  {r.label}
                </label>
              ))}
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={isPhysical ? false : mintablePostLaunch}
              disabled={isPhysical}
              onChange={(e) => setMintablePostLaunch(e.target.checked)}
            />
            Mintable post-launch (allow dilution)
          </label>
          {isPhysical && (
            <p className="text-[11px] text-slate-400">
              Physical goods are never mintable post-launch — a delivered
              (burned) unit must not be re-mintable — and the program allows
              exactly one class per physical-good asset.
            </p>
          )}

          <p className="text-[11px] text-slate-400">
            Class index is auto-derived from the asset&apos;s current
            shareClassesCount.
          </p>
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
            onClick={() => void add()}
            disabled={tx.isSending || !issuerLegalId.trim() || !assetId.trim()}
            className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {tx.isSending ? "Sending…" : "Add share class"}
          </button>
        </div>
      </div>
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
