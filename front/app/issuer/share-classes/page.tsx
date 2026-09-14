"use client";

import {
  loadIssuerPermission,
  resolveIssuerPermission,
  ISSUER_CAPABILITIES,
} from "@/lib/issuer-permissions";
import { IssuerOperatingActions } from "./operating-actions";
import { WalletRequired } from "@/components/wallet-required";

import Link from "next/link";
import { type Address } from "@solana/kit";
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
import {
  findAssetPda,
  findIssuerPda,
  AssetType,
  findMintPda,
  getAddShareClassInstructionAsync,
  getInitializeShareClassMintInstructionAsync,
  getLockSupplyInstructionAsync,
  getMintToTreasuryInstructionAsync,
  ShareClassType,
  type Asset,
  type Issuer,
  type ShareClass,
} from "@/lib/generated/asset_registry";
import {
  findConfigPda,
  findExtraAccountMetaListPda,
  TRANSFER_HOOK_PROGRAM_ADDRESS,
} from "@/lib/generated/transfer_hook";
import { loadNetwork, type NetworkData } from "@/lib/enumerate";
import { loadNetworkPreferIndexer } from "@/lib/indexer";
import { findShareClassPda } from "@/lib/pdas";
import { shareClassTypesForAssetType } from "@/lib/asset-types";
import { fromBytes32 } from "@/lib/format";
import { walletSigner } from "@/lib/wallet-signer";
import { explainSendError } from "@/lib/tx-error";
import { ConfirmModal } from "@/components/confirm-modal";
import { SkeletonTable } from "@/components/skeleton";
import { recordAudit } from "@/lib/supabase";
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

// NOTE (destination binding): this screen used to mint to an arbitrary
// destination wallet, guarded only by an off-chain onboarding lookup plus an
// override checkbox. `mint_to_treasury` now binds the destination ON-CHAIN —
// it must be owned by the signing issuer authority (the treasury) or be the
// escrow of an `Active` `CustodyVault` / `RightsIssuance` of this mint, with
// that parent PDA in remaining accounts; anything else fails with
// MintDestinationNotBound (6078). Reason: `mint_to` never fires the transfer
// hook, so units minted straight into an investor wallet would bypass every
// receiver-KYC check. Investors get their units through a sale (`buy`, gated)
// or a hook-checked transfer out of the treasury.

export default function MyShareClassesPage() {
  const conn = useWalletConnection();
  const client = useSolanaClient();
  const wallet = conn.wallet?.account.address;
  const [data, setData] = useState<NetworkData | null>(null);
  const [failed, setFailed] = useState(false);
  const [me, setMe] = useState<Issuer | null>(null);
  const [myAssets, setMyAssets] = useState<Asset[]>([]);
  const [assetPdaMap, setAssetPdaMap] = useState<Map<string, Asset>>(new Map());
  const [showAdd, setShowAdd] = useState(false);
  const [selectedSc, setSelectedSc] = useState<{
    sc: ShareClass;
    asset: Asset;
    scPda: string;
  } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const network = await loadNetworkPreferIndexer(() =>
        loadNetwork(client.runtime.rpc),
      );
      setData(network);
      if (wallet) {
        const found = network.issuers.find(
          (i) => i.authority.toString() === wallet.toString(),
        );
        setMe(found ?? null);
        if (found) {
          const [pda] = await findIssuerPda({
            legalEntityId: found.legalEntityId,
          });
          const mine = network.assets.filter(
            (a) => a.issuer.toString() === pda.toString(),
          );
          setMyAssets(mine);
          const m = new Map<string, Asset>();
          for (const a of mine) {
            const [apda] = await findAssetPda({
              issuer: a.issuer,
              assetId: a.assetId,
            });
            m.set(apda.toString(), a);
          }
          setAssetPdaMap(m);
        }
      }
    } catch {
      setFailed(true);
    }
  }, [client, wallet]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const rows = useMemo(() => {
    if (!data || assetPdaMap.size === 0) return [];
    return data.shareClasses
      .filter((sc) => assetPdaMap.has(sc.asset.toString()))
      .sort((a, b) => a.classIndex - b.classIndex);
  }, [data, assetPdaMap]);

  const verified = me?.kybStatus === 1;
  const canCreate = verified && myAssets.length > 0;

  if (!wallet)
    return (
      <main>
        <WalletRequired />
      </main>
    );

  return (
    <main className="min-w-0 flex-1">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-slate-500">
            My share classes
          </p>
          <h1 className="mt-1 text-2xl font-semibold text-slate-900">
            Share classes
          </h1>
          <p className="mt-2 text-sm text-slate-600">
            Token-2022 share classes minted under your assets.
          </p>
        </div>
        <button
          type="button"
          disabled={!canCreate}
          onClick={() => setShowAdd(true)}
          title={
            !verified
              ? "Verify KYB first."
              : myAssets.length === 0
                ? "Create an asset first."
                : undefined
          }
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          + Add share class
        </button>
      </div>

      {!verified && me && (
        <div className="mt-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
          KYB pending — share-class creation locked.
        </div>
      )}
      {verified && myAssets.length === 0 && (
        <div className="mt-6 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-700">
          You need to create an asset first.{" "}
          <Link href="/issuer/assets" className="font-semibold underline">
            Go to assets →
          </Link>
        </div>
      )}

      {failed ? (
        <p className="mt-8 text-sm text-red-600">Failed to load.</p>
      ) : data === null ? (
        <div className="mt-8">
          <SkeletonTable rows={3} cols={5} />
        </div>
      ) : !me ? (
        <NotIssuer />
      ) : rows.length === 0 ? (
        <Empty />
      ) : (
        <div className="mt-8 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-card">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-100 bg-slate-50 text-left text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-4 py-3 font-medium">Asset / class</th>
                <th className="px-4 py-3 font-medium">Type</th>
                <th className="px-4 py-3 text-right font-medium">
                  Circulating
                </th>
                <th className="px-4 py-3 font-medium">Mint</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((sc, i) => {
                const asset = assetPdaMap.get(sc.asset.toString());
                const status = sc.supplyLocked
                  ? "Locked"
                  : sc.mintInitialized
                    ? "Active"
                    : "Pending mint";
                const isSelected =
                  selectedSc?.sc.classIndex === sc.classIndex &&
                  selectedSc?.asset.assetId === asset?.assetId;
                return (
                  <SCRow
                    key={i}
                    sc={sc}
                    asset={asset}
                    status={status}
                    isSelected={isSelected}
                    onSelect={(asset, scPda) => {
                      setSelectedSc(isSelected ? null : { sc, asset, scPda });
                    }}
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {selectedSc && (
        <ShareClassActions
          sc={selectedSc.sc}
          asset={selectedSc.asset}
          scPda={selectedSc.scPda as Address}
          onRefresh={refresh}
          onClose={() => setSelectedSc(null)}
        />
      )}

      {showAdd && me && (
        <AddShareClassModal
          issuer={me}
          myAssets={myAssets}
          onClose={() => setShowAdd(false)}
          onSuccess={() => {
            void refresh();
            setShowAdd(false);
          }}
        />
      )}
    </main>
  );
}

// Tiny wrapper so we can derive the share-class PDA inside a row component
// without making the outer page async-render.
function SCRow({
  sc,
  asset,
  status,
  isSelected,
  onSelect,
}: {
  sc: ShareClass;
  asset: Asset | undefined;
  status: string;
  isSelected: boolean;
  onSelect: (asset: Asset, scPda: string) => Promise<void> | void;
}) {
  const [scPda, setScPda] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const pda = await findShareClassPda(sc.asset, sc.classIndex);
      if (!cancelled) setScPda(pda.toString());
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [sc.asset, sc.classIndex]);

  return (
    <tr
      onClick={() => {
        if (asset && scPda) void onSelect(asset, scPda);
      }}
      className={`cursor-pointer transition-colors ${isSelected ? "bg-slate-50" : "hover:bg-slate-50/60"}`}
    >
      <td className="px-4 py-3">
        <p className="font-medium text-slate-900">{asset?.name ?? "—"}</p>
        <p className="mt-0.5 text-xs text-slate-500">
          #{sc.classIndex} · {asset?.assetId ?? "—"}
        </p>
      </td>
      <td className="px-4 py-3">{CLASS_TYPE[sc.classType] ?? "?"}</td>
      <td className="px-4 py-3 text-right font-mono">
        {String(sc.circulatingSupply)}
      </td>
      <td className="px-4 py-3 font-mono text-[11px] text-slate-500">
        {sc.mintInitialized
          ? `${sc.mint.toString().slice(0, 6)}…${sc.mint.toString().slice(-4)}`
          : "—"}
      </td>
      <td className="px-4 py-3 text-xs">{status}</td>
      <td className="px-4 py-3 text-right text-xs text-slate-500">
        {isSelected ? "▾" : "▸"}
      </td>
    </tr>
  );
}

function ShareClassActions({
  sc,
  asset,
  scPda,
  onRefresh,
  onClose,
}: {
  sc: ShareClass;
  asset: Asset;
  scPda: Address;
  onRefresh: () => Promise<void>;
  onClose: () => void;
}) {
  const conn = useWalletConnection();
  const tx = useSendTransaction();
  const toast = useToast();
  const client = useSolanaClient();
  const [issuerCapabilities, setIssuerCapabilities] = useState(0);
  const [globalAdmin, setGlobalAdmin] = useState(false);
  const wallet = conn.wallet?.account.address;
  const [mintAmount, setMintAmount] = useState("");
  const [confirmMint, setConfirmMint] = useState(false);
  const [confirmLock, setConfirmLock] = useState(false);

  const issuerPda = asset.issuer;
  useEffect(() => {
    let active = true;
    if (wallet)
      loadIssuerPermission(client.runtime.rpc, issuerPda, wallet)
        .then((permission) => {
          if (active) {
            setIssuerCapabilities(permission.capabilities);
            setGlobalAdmin(permission.globalAdmin);
          }
        })
        .catch(() => {
          if (active) {
            setIssuerCapabilities(0);
            setGlobalAdmin(false);
          }
        });
    return () => {
      active = false;
    };
  }, [client, issuerPda, wallet]);
  const canMint = (issuerCapabilities & ISSUER_CAPABILITIES.Mint) !== 0;

  async function initMint() {
    if (!wallet || !conn.wallet) return;
    const pendingId = toast.showPending("Initializing Token-2022 mint…");
    try {
      const signer = walletSigner(conn.wallet);
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
      toast.showError("Failed to initialize mint", explainSendError(err));
    }
  }

  // Mints into the ISSUER TREASURY — the token account owned by the signing
  // issuer authority (the connected wallet). The only destination the program
  // accepts from this screen; see the destination-binding note at the top.
  async function mintToTreasury(reason: string) {
    if (!wallet || !conn.wallet || !mintAmount.trim()) return;
    const destination = wallet;
    const amount = BigInt(mintAmount);
    const pendingId = toast.showPending(
      `Minting ${amount} units to the issuer treasury…`,
    );
    try {
      const signer = walletSigner(conn.wallet);
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
      toast.showError("Failed to mint", explainSendError(err));
    }
  }

  async function lockSupply(reason: string) {
    if (!wallet || !conn.wallet) return;
    const pendingId = toast.showPending("Locking supply…", reason);
    try {
      const signer = walletSigner(conn.wallet);
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
      toast.showError("Failed to lock supply", explainSendError(err));
    }
  }

  return (
    <section className="mt-6 rounded-xl border border-slate-200 bg-white p-6 shadow-card">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            Lifecycle actions
          </p>
          <h2 className="mt-1 text-lg font-semibold text-slate-900">
            {asset.name} · class #{sc.classIndex}
          </h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-xs text-slate-400 hover:text-slate-700"
        >
          Close ✕
        </button>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-2">
        {/*
          Mint initialization and treasury minting require a current issuer capability or global Admin proof; the issuer always signs.
        */}
        {!canMint && !sc.supplyLocked && (
          <div className="w-full rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
            {!sc.mintInitialized ? (
              <>
                <p className="font-medium text-slate-800">
                  Mint permission required
                </p>
                <p className="mt-1 text-[13px]">
                  The Super Admin can grant this issuer the Mint capability.
                  Your issuer wallet then initializes and mints its own class;
                  no global admin role is required.
                </p>
              </>
            ) : (
              <>
                <p className="font-medium text-slate-800">
                  Mint initialized — treasury minting handled by Mancipatio
                </p>
                <p className="mt-1 text-[13px]">
                  The Mancipatio team mints your allocation to the treasury and
                  locks supply. Contact us if you need a change to the schedule.
                </p>
              </>
            )}
          </div>
        )}

        {canMint && !sc.mintInitialized && (
          <button
            type="button"
            disabled={tx.isSending}
            onClick={() => void initMint()}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {tx.isSending ? "Sending…" : "Initialize Token-2022 mint"}
          </button>
        )}

        {canMint && sc.mintInitialized && !sc.supplyLocked && (
          <div className="w-full space-y-2">
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
              <p className="text-xs font-medium text-slate-700">
                Destination: the issuer treasury —{" "}
                <code className="break-all rounded bg-white px-1 font-mono text-[11px]">
                  {wallet ? wallet.toString() : "Not connected"}
                </code>
              </p>
              <p className="mt-1 text-[11px] text-slate-500">
                The program binds the destination on-chain: minted units may
                only land in the signing issuer authority&apos;s own token
                account (or a custody / rights escrow of this mint). Minting
                directly to an investor wallet is rejected
                (MintDestinationNotBound) — sell through a sale or transfer out
                of the treasury under the hook instead.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <input
                value={mintAmount}
                inputMode="numeric"
                onChange={(e) =>
                  setMintAmount(e.target.value.replace(/\D/g, ""))
                }
                placeholder="Units to mint"
                className="min-w-[200px] flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              />
              <button
                type="button"
                disabled={tx.isSending || !mintAmount.trim()}
                onClick={() => setConfirmMint(true)}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-900 hover:border-slate-400 disabled:opacity-50"
              >
                Mint to treasury
              </button>
              {globalAdmin && (
                <button
                  type="button"
                  disabled={tx.isSending}
                  onClick={() => setConfirmLock(true)}
                  className="rounded-lg border border-red-300 bg-red-50 px-4 py-2 text-sm font-medium text-red-900 hover:bg-red-100 disabled:opacity-50"
                >
                  Lock supply
                </button>
              )}
            </div>
          </div>
        )}

        {sc.supplyLocked && (
          <p className="text-sm text-slate-500">
            Supply permanently locked — no further minting possible.
          </p>
        )}
      </div>

      <IssuerOperatingActions
        issuer={issuerPda}
        shareClass={scPda}
        sc={sc}
        capabilities={issuerCapabilities}
        onRefresh={onRefresh}
      />

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
        open={confirmLock}
        onClose={() => setConfirmLock(false)}
        onConfirm={(reason) => lockSupply(reason)}
        title="Lock supply permanently"
        kind="destructive"
        confirmLabel="Lock supply"
        description={
          <p>
            Locking the supply is <strong>one-way</strong> — once locked, no
            further{" "}
            <code className="rounded bg-slate-100 px-1">mint_to_treasury</code>{" "}
            calls will succeed.
          </p>
        }
        busy={tx.isSending}
      />
    </section>
  );
}

function AddShareClassModal({
  issuer,
  myAssets,
  onClose,
  onSuccess,
}: {
  issuer: Issuer;
  myAssets: Asset[];
  onClose: () => void;
  onSuccess: () => void;
}) {
  const conn = useWalletConnection();
  const tx = useSendTransaction();
  const toast = useToast();
  const wallet = conn.wallet?.account.address;

  const [selectedAssetId, setSelectedAssetId] = useState(
    myAssets[0]?.assetId ?? "",
  );
  const [classType, setClassType] = useState<ShareClassType>(
    ShareClassType.Common,
  );
  const [rights, setRights] = useState(1 | 2 | 32);
  const [liqPref, setLiqPref] = useState("10000");
  const [liqSeniority, setLiqSeniority] = useState("0");
  const [votingWeight, setVotingWeight] = useState("1");
  const [maxSupply, setMaxSupply] = useState("");
  const [mintablePostLaunch, setMintablePostLaunch] = useState(false);

  const selectedAsset = myAssets.find((a) => a.assetId === selectedAssetId);
  const nextIndex = selectedAsset?.shareClassesCount ?? 0;

  // Physical goods are unique items — the program enforces exactly one
  // supply-1 class per asset, never mintable post-launch
  // (PhysicalGoodRequiresUnitSupply / PhysicalGoodSingleClass /
  // PhysicalGoodPostLaunchMint), so lock the fields instead of letting the
  // transaction bounce.
  const isPhysical = selectedAsset?.assetType === AssetType.PhysicalGood;
  const physicalBlocked = isPhysical && nextIndex > 0;

  // Constrain the class-type choices to those sensible for the parent asset's type.
  const allowedClassTypes = useMemo(
    () => shareClassTypesForAssetType(selectedAsset?.assetType),
    [selectedAsset],
  );
  // Keep the selected class type valid when the asset (and its allowed set) changes.
  useEffect(() => {
    if (!allowedClassTypes.some((t) => t.value === classType)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setClassType(allowedClassTypes[0]?.value as ShareClassType);
    }
  }, [allowedClassTypes, classType]);

  async function add() {
    if (!wallet || !conn.wallet || !selectedAsset) return;
    const pendingId = toast.showPending(
      `Adding class #${nextIndex} to ${selectedAsset.assetId}…`,
    );
    try {
      const [issuerPda] = await findIssuerPda({
        legalEntityId: issuer.legalEntityId,
      });
      const [assetPda] = await findAssetPda({
        issuer: issuerPda,
        assetId: selectedAsset.assetId,
      });
      const shareClassPda = await findShareClassPda(assetPda, nextIndex);
      const signer = walletSigner(conn.wallet);
      const ix = await getAddShareClassInstructionAsync({
        authority: signer,
        issuer: issuerPda,
        asset: assetPda,
        shareClass: shareClassPda,
        classIndex: nextIndex,
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
      toast.showError("Failed to add share class", explainSendError(err));
      console.error("[add_share_class]", err);
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
            Add share class
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Issuer:{" "}
            <strong className="font-mono">
              {fromBytes32(issuer.legalEntityId)}
            </strong>
          </p>
        </div>
        <div className="space-y-4 px-5 py-4">
          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Asset
            </span>
            <select
              value={selectedAssetId}
              onChange={(e) => setSelectedAssetId(e.target.value)}
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
            >
              {myAssets.map((a) => (
                <option key={`${a.issuer.toString()}:${a.assetId}`} value={a.assetId}>
                  {a.name} · {a.assetId} (#{a.shareClassesCount} classes)
                </option>
              ))}
            </select>
            {selectedAsset && (
              <span className="mt-1 block text-[11px] text-slate-500">
                Class index will be #{nextIndex}.
              </span>
            )}
          </label>

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
              {selectedAsset && (
                <span className="mt-1 block text-[11px] text-slate-400">
                  Limited to types valid for this asset.
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
                Liq. pref. multi (bps)
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
              (burned) unit must not be re-mintable.
            </p>
          )}
          {physicalBlocked && (
            <p className="text-[11px] text-amber-700">
              This physical-good asset already has its single share class — the
              program rejects a second one.
            </p>
          )}
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
            disabled={tx.isSending || !selectedAsset || physicalBlocked}
            className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {tx.isSending ? "Sending…" : `Add class #${nextIndex}`}
          </button>
        </div>
      </div>
    </div>
  );
}

function NotIssuer() {
  return (
    <div className="mt-8 rounded-xl border border-amber-200 bg-amber-50 p-6">
      <p className="text-sm font-semibold text-amber-900">
        No issuer found for this wallet
      </p>
      <Link
        href="/issuer/onboarding"
        className="mt-3 inline-block rounded-lg bg-amber-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-950"
      >
        Start onboarding →
      </Link>
    </div>
  );
}

function Empty() {
  return (
    <div className="mt-8 rounded-xl border border-slate-200 bg-white p-12 text-center shadow-card">
      <p className="text-sm text-slate-600">No share classes yet.</p>
      <p className="mt-1 text-xs text-slate-400">
        Use &quot;+ Add share class&quot; above to create the first one.
      </p>
    </div>
  );
}
