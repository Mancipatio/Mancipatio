"use client";

import { WalletRequired } from "@/components/wallet-required";

import Link from "next/link";
import { createWalletTransactionSigner } from "@solana/client";
import {
  useSendTransaction,
  useSolanaClient,
  useWalletConnection,
} from "@solana/react-hooks";
import { useCallback, useEffect, useState } from "react";
import { isAddress } from "@solana/kit";
import {
  fetchMaybePlatform,
  findPlatformPda,
  getSetProtocolTreasuryInstructionAsync,
  type Platform,
} from "@/lib/generated/asset_registry";
import { PauseFlagsPanel } from "@/components/pause-flags-panel";
import { pauseStatus } from "@/lib/pause-flags";
import { protocolTreasuryError } from "@/lib/protocol-treasury";
import {
  kycGates,
  kycRegistryUnavailableReason,
  loadKycAuthorityContext,
} from "@/lib/kyc-authority";
import { AuthorityRotation, initKey } from "./authority-rotation";
import { BlocklistBootstrap } from "./blocklist-bootstrap";
import { PlatformInitCard } from "./platform-init-card";
import { ConfirmModal } from "@/components/confirm-modal";
import { recordAudit } from "@/lib/supabase";
import { explainSendError } from "@/lib/tx-error";
import { detectNetwork, explorerTxUrl } from "@/lib/network";
import { useToast } from "@/lib/toast";

const CARD = "rounded-xl border border-slate-200 bg-white shadow-card p-6";
const PAUSE_CHIP = {
  active: "bg-emerald-100 text-emerald-700",
  paused: "bg-red-100 text-red-700",
  undefined: "bg-amber-100 text-amber-800",
} as const;
const BTN =
  "rounded-lg border border-slate-300/60 px-4 py-2 text-sm font-medium text-slate-900 transition-colors hover:border-slate-400 hover:text-slate-900 disabled:opacity-50";

export default function AdminPage() {
  const conn = useWalletConnection();
  const client = useSolanaClient();
  const tx = useSendTransaction();
  const [platformPda, setPlatformPda] = useState("");
  const [platform, setPlatform] = useState<Platform | null | undefined>(
    undefined,
  );
  const [treasuryInput, setTreasuryInput] = useState("");
  const [confirmTreasury, setConfirmTreasury] = useState(false);
  // KYC provider = live KycRegistry.authority — shown next to the platform
  // admin because the two roles are separate on-chain and diverge on rotation.
  const [kycProvider, setKycProvider] = useState<string | null | undefined>(
    undefined,
  );
  // Why there is no provider when a registry is expected (pin missing on this
  // network, or several registries and no pin); null = simply none yet.
  const [kycProviderNote, setKycProviderNote] = useState<string | null>(null);
  // The permanent keys entered at bootstrap pre-fill the rotation panels.
  /** undefined until this page initialized the platform; then the permanent key (or null). */
  const [platformSuccessor, setPlatformSuccessor] = useState<string | null | undefined>(undefined);
  /** undefined until this page initialized the blocklist authority; then the permanent key (or null). */
  const [blocklistSuccessor, setBlocklistSuccessor] = useState<string | null | undefined>(undefined);
  const toast = useToast();

  const refresh = useCallback(async () => {
    const [pda] = await findPlatformPda();
    setPlatformPda(pda);
    const maybe = await fetchMaybePlatform(client.runtime.rpc, pda);
    setPlatform(maybe.exists ? maybe.data : null);
    try {
      const ctx = await loadKycAuthorityContext(client.runtime.rpc);
      setKycProvider(ctx.registry?.registry.authority.toString() ?? null);
      setKycProviderNote(kycRegistryUnavailableReason(ctx, detectNetwork()));
    } catch {
      setKycProvider(undefined);
      setKycProviderNote(null);
    }
  }, [client]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const walletAddress = conn.wallet?.account.address;

  const treasuryCandidate = treasuryInput.trim();
  const treasuryError = protocolTreasuryError(
    treasuryCandidate,
    platform?.protocolTreasury,
  );

  async function rotateTreasury(reason: string) {
    if (!walletAddress || !platform || !conn.wallet) return;
    if (!treasuryCandidate || treasuryError || !isAddress(treasuryCandidate))
      return;
    const old = platform.protocolTreasury;
    const pendingId = toast.showPending("Rotating protocol treasury…", reason);
    try {
      const { signer } = createWalletTransactionSigner(conn.wallet);
      const ix = await getSetProtocolTreasuryInstructionAsync({
        superAdmin: signer,
        newTreasury: treasuryCandidate,
      });
      const result = await tx.send({ instructions: [ix], feePayer: signer });
      const sig = typeof result === "string" ? result : "";
      toast.dismiss(pendingId);
      toast.showTx(sig, { title: "Protocol treasury rotated" });
      void recordAudit({
        ix_name: "set_protocol_treasury",
        category: "platform",
        actor_wallet: walletAddress.toString(),
        reason,
        target_label: treasuryCandidate,
        tx_signature: sig || undefined,
        status: "success",
        metadata: { old, new: treasuryCandidate },
      });
      setConfirmTreasury(false);
      setTreasuryInput("");
      await refresh();
    } catch (err) {
      toast.dismiss(pendingId);
      const detail = explainSendError(err);
      toast.showError("Failed to rotate the treasury", detail);
      void recordAudit({
        ix_name: "set_protocol_treasury",
        category: "platform",
        actor_wallet: walletAddress.toString(),
        reason,
        target_label: treasuryCandidate,
        status: "failed",
        metadata: { old, new: treasuryCandidate, error: detail },
      });
    }
  }

  return (
    <section className="flex-1 text-slate-900">
      <div className="mx-auto max-w-3xl px-6 py-16">
        <p className="font-mono text-xs uppercase tracking-widest text-slate-500">
          Admin
        </p>
        <h1 className="mt-2 text-3xl font-semibold">Platform console</h1>
        <p className="mt-3 text-slate-600">
          The Platform singleton governs Manci on the selected network — super
          admin, the emergency pause, the protocol treasury and a reserved fee
          field (nothing is charged on-chain; pricing is agreed per
          engagement).
        </p>

        {!conn.isReady ? (
          <p className="mt-8 text-slate-500">Loading wallet…</p>
        ) : !conn.connected || !walletAddress ? (
          <WalletRequired className="mt-8" />
        ) : platform === undefined ? (
          <p className="mt-8 text-slate-500">Loading platform…</p>
        ) : platform === null ? (
          <PlatformInitCard
            platformPda={platformPda}
            onInitialized={async ({ permanentSuperAdmin }) => {
              setPlatformSuccessor(permanentSuperAdmin);
              await refresh();
            }}
          />
        ) : (
          <div className={`mt-8 ${CARD}`}>
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-slate-900">Platform</h2>
              <span
                className={`rounded-full px-2 py-0.5 text-xs ${
                  PAUSE_CHIP[pauseStatus(platform.pauseFlags).tone]
                }`}
              >
                {pauseStatus(platform.pauseFlags).label}
              </span>
            </div>
            <dl className="mt-4 space-y-2 text-sm">
              <Row label="Super Admin" value={platform.admin} />
              <Row
                label="KYC provider"
                value={
                  kycProvider === undefined
                    ? "unknown (registry read failed)"
                    : kycProvider === null
                      ? (kycProviderNote ?? "no KYC registry yet")
                      : kycProvider
                }
              />
              <Row label="Treasury" value={platform.protocolTreasury} />
              <Row
                label="Protocol fee"
                value={`${platform.protocolFeeBps} bps — reserved on-chain field, not charged`}
              />
              <Row label="Issuers" value={String(platform.issuersCount)} />
            </dl>
            {kycProvider &&
              !kycGates(walletAddress, kycProvider, platform.admin)
                .providerIsPlatformAdmin && (
                <p className="mt-3 text-xs text-amber-700">
                  The KYC provider (registry authority) differs from the Super
                  Admin. Passports are issued and revoked only by the registry
                  authority; it moves only through the propose/accept rotation
                  on /admin/kyc, never with an admin rotation. That key reaches
                  /admin/kyc and the client detail pages as the KYC provider,
                  without an Admin record (Admins are managed on
                  /admin/admins).
                </p>
              )}
            <div className="mt-6">
              <PauseFlagsPanel platform={platform} onChanged={refresh} />
            </div>
            {platform.admin === walletAddress ? (
              <div className="mt-6 border-t border-slate-100 pt-5">
                <p className="text-[13px] font-semibold text-slate-900">
                  Protocol treasury
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  The wallet whose token accounts receive the platform third of
                  routed yield. It is read live, so the next routed yield pays
                  the new wallet. The new wallet does not have to sign (a
                  multisig vault can be the treasury).
                </p>
                <div className="mt-3 flex flex-wrap items-start gap-2">
                  <input
                    value={treasuryInput}
                    onChange={(e) => setTreasuryInput(e.target.value)}
                    placeholder="New treasury wallet address"
                    spellCheck={false}
                    className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs"
                    aria-invalid={treasuryError ? true : undefined}
                  />
                  <button
                    type="button"
                    disabled={
                      tx.isSending || !treasuryCandidate || !!treasuryError
                    }
                    onClick={() => setConfirmTreasury(true)}
                    className={BTN}
                  >
                    Rotate treasury
                  </button>
                </div>
                {treasuryError && (
                  <p className="mt-1 text-xs text-red-600">{treasuryError}</p>
                )}
              </div>
            ) : (
              <p className="mt-6 text-sm text-slate-500">
                Connected wallet is not the Super Admin — only the Super Admin
                can resume paused areas or rotate the treasury.
              </p>
            )}
            <button
              type="button"
              onClick={() => void refresh()}
              className="ml-3 text-sm text-slate-500 underline hover:text-slate-700"
            >
              Refresh
            </button>
          </div>
        )}

        {tx.signature && (
          <p className="mt-4 text-sm text-emerald-600">
            ✓ Sent —{" "}
            <a
              className="underline"
              href={explorerTxUrl(tx.signature, detectNetwork())}
              target="_blank"
              rel="noreferrer"
            >
              view on explorer
            </a>
          </p>
        )}
        {tx.error != null && (
          <p className="mt-4 break-words text-sm text-red-600">
            {tx.error instanceof Error ? tx.error.message : String(tx.error)}
          </p>
        )}

        <p className="mt-8 text-sm text-slate-400">
          <Link className="underline hover:text-slate-600" href="/">
            ← back
          </Link>
        </p>
      </div>
      <BlocklistBootstrap onInitialized={setBlocklistSuccessor} />
      <AuthorityRotation
        key={`platform:${initKey(platformSuccessor)}`}
        kind="platform"
        initialNext={platformSuccessor ?? undefined}
        awaitInitialization={platformSuccessor !== undefined}
      />
      <AuthorityRotation
        key={`blocklist:${initKey(blocklistSuccessor)}`}
        kind="blocklist"
        initialNext={blocklistSuccessor ?? undefined}
        awaitInitialization={blocklistSuccessor !== undefined}
      />
      {platform && confirmTreasury && !treasuryError && treasuryCandidate && (
        <ConfirmModal
          open={confirmTreasury}
          onClose={() => setConfirmTreasury(false)}
          onConfirm={(reason) => rotateTreasury(reason)}
          title="Rotate protocol treasury"
          kind="warning"
          confirmLabel="Rotate"
          description={
            <div className="space-y-2">
              <p>
                From <span className="break-all font-mono">{platform.protocolTreasury}</span>
              </p>
              <p>
                To <span className="break-all font-mono">{treasuryCandidate}</span>
              </p>
              <p>
                Routed yield will require a token account owned by the new
                wallet. Check the address carefully; the reason is recorded in
                the audit log.
              </p>
            </div>
          }
          busy={tx.isSending}
        />
      )}
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-slate-500">{label}</dt>
      <dd className="break-all text-right font-mono text-slate-700">{value}</dd>
    </div>
  );
}
