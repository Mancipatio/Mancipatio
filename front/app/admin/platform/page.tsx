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
import {
  fetchMaybePlatform,
  findPlatformPda,
  getSetPauseInstructionAsync,
  type Platform,
} from "@/lib/generated/asset_registry";
import { buildInitializePlatformInstruction } from "@/lib/program-bootstrap";
import { kycGates, loadKycAuthorityContext } from "@/lib/kyc-authority";
import { AuthorityRotation } from "./authority-rotation";
import { BlocklistBootstrap } from "./blocklist-bootstrap";
import { ConfirmModal } from "@/components/confirm-modal";
import { recordAudit } from "@/lib/supabase";
import { explainSendError } from "@/lib/tx-error";
import { detectNetwork, explorerTxUrl } from "@/lib/network";
import { useToast } from "@/lib/toast";

const CARD = "rounded-xl border border-slate-200 bg-white shadow-card p-6";
const BTN =
  "rounded-lg border border-slate-300/60 px-4 py-2 text-sm font-medium text-slate-900 transition-colors hover:border-slate-400 hover:text-slate-900 disabled:opacity-50";
// protocol_fee_bps is a RESERVED on-chain field — no instruction charges or
// collects it, and pricing is agreed per engagement (settled off-chain).
// Initialize it at 0: there is no update instruction, so a non-zero value
// written here could never be corrected on-chain.
const PROTOCOL_FEE_BPS = 0;

export default function AdminPage() {
  const conn = useWalletConnection();
  const client = useSolanaClient();
  const tx = useSendTransaction();
  const [platformPda, setPlatformPda] = useState("");
  const [platform, setPlatform] = useState<Platform | null | undefined>(
    undefined,
  );
  const [confirmPause, setConfirmPause] = useState(false);
  // KYC provider = live KycRegistry.authority — shown next to the platform
  // admin because the two roles are separate on-chain and diverge on rotation.
  const [kycProvider, setKycProvider] = useState<string | null | undefined>(
    undefined,
  );
  const toast = useToast();

  const refresh = useCallback(async () => {
    const [pda] = await findPlatformPda();
    setPlatformPda(pda);
    const maybe = await fetchMaybePlatform(client.runtime.rpc, pda);
    setPlatform(maybe.exists ? maybe.data : null);
    try {
      const ctx = await loadKycAuthorityContext(client.runtime.rpc);
      setKycProvider(ctx.registry?.registry.authority.toString() ?? null);
    } catch {
      setKycProvider(undefined);
    }
  }, [client]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const walletAddress = conn.wallet?.account.address;

  async function initializePlatform() {
    if (!walletAddress || !conn.wallet) return;
    const pendingId = toast.showPending(
      "Initializing platform…",
      "Program upgrade authority authorizes the initial Super Admin",
    );
    const reason =
      "Program upgrade authority authorizes the initial Super Admin";
    try {
      const { signer } = createWalletTransactionSigner(conn.wallet);
      const ix = await buildInitializePlatformInstruction(client.runtime.rpc, {
        admin: signer,
        upgradeAuthority: signer,
        protocolTreasury: walletAddress,
        protocolFeeBps: PROTOCOL_FEE_BPS,
      });
      const result = await tx.send({ instructions: [ix], feePayer: signer });
      const sig = typeof result === "string" ? result : "";
      toast.dismiss(pendingId);
      toast.showTx(sig, { title: "Platform initialized" });
      void recordAudit({
        ix_name: "initialize_platform",
        category: "platform",
        actor_wallet: walletAddress.toString(),
        reason,
        target_label: walletAddress.toString(),
        tx_signature: sig || undefined,
        status: "success",
      });
      await refresh();
    } catch (err) {
      toast.dismiss(pendingId);
      const detail = explainSendError(err);
      toast.showError("Failed to initialize platform", detail);
      void recordAudit({
        ix_name: "initialize_platform",
        category: "platform",
        actor_wallet: walletAddress.toString(),
        reason,
        target_label: walletAddress.toString(),
        status: "failed",
        metadata: { error: detail },
      });
      console.error("[initialize_platform] full error:", err);
    }
  }

  async function togglePause(reason: string) {
    if (!walletAddress || !platform || !conn.wallet) return;
    const action = platform.paused ? "Unpausing" : "Pausing";
    const ixName = platform.paused ? "unpause" : "set_pause";
    const pendingId = toast.showPending(`${action} platform…`, reason);
    try {
      const { signer } = createWalletTransactionSigner(conn.wallet);
      const ix = await getSetPauseInstructionAsync({
        admin: signer,
        paused: !platform.paused,
      });
      const result = await tx.send({
        instructions: [ix],
        feePayer: signer,
      });
      const sig = typeof result === "string" ? result : "";
      toast.dismiss(pendingId);
      toast.showTx(sig, {
        title: platform.paused ? "Platform unpaused" : "Platform paused",
      });
      void recordAudit({
        ix_name: ixName,
        category: "platform",
        actor_wallet: walletAddress.toString(),
        reason,
        target_label: platformPda || undefined,
        tx_signature: sig || undefined,
        status: "success",
      });
      setConfirmPause(false);
      await refresh();
    } catch (err) {
      toast.dismiss(pendingId);
      const message = err instanceof Error ? err.message : String(err);
      toast.showError("Failed to toggle pause", message);
      void recordAudit({
        ix_name: ixName,
        category: "platform",
        actor_wallet: walletAddress.toString(),
        reason,
        target_label: platformPda || undefined,
        status: "failed",
        metadata: { error: message },
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
          The Platform singleton governs Mancipatio on the selected network — super admin, the
          pause switch and a reserved fee field (nothing is charged on-chain;
          pricing is agreed per engagement).
        </p>

        {!conn.isReady ? (
          <p className="mt-8 text-slate-500">Loading wallet…</p>
        ) : !conn.connected || !walletAddress ? (
          <WalletRequired className="mt-8" />
        ) : platform === undefined ? (
          <p className="mt-8 text-slate-500">Loading platform…</p>
        ) : platform === null ? (
          <div className={`mt-8 ${CARD}`}>
            <h2 className="text-lg font-semibold text-slate-900">
              Platform not initialized
            </h2>
            <p className="mt-2 text-sm text-slate-600">
              Connect the deployed registry program’s current upgrade-authority
              wallet. This setup appoints the connected wallet as initial Super
              Admin and treasury; program upgrade authority is unchanged.
            </p>
            <dl className="mt-4 space-y-2 text-sm">
              <Row label="Platform PDA" value={platformPda} />
              <Row label="Super Admin (you)" value={walletAddress} />
              <Row
                label="Protocol fee"
                value={`${PROTOCOL_FEE_BPS} bps — reserved field, not charged`}
              />
            </dl>
            <button
              type="button"
              disabled={tx.isSending}
              onClick={() => void initializePlatform()}
              className={`mt-6 ${BTN}`}
            >
              {tx.isSending ? "Sending…" : "Initialize Platform"}
            </button>
          </div>
        ) : (
          <div className={`mt-8 ${CARD}`}>
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-slate-900">Platform</h2>
              <span
                className={`rounded-full px-2 py-0.5 text-xs ${
                  platform.paused
                    ? "bg-red-100 text-red-700"
                    : "bg-emerald-100 text-emerald-700"
                }`}
              >
                {platform.paused ? "paused" : "active"}
              </span>
            </div>
            <dl className="mt-4 space-y-2 text-sm">
              <Row label="Super Admin" value={platform.admin} />
              <Row
                label="KYC provider"
                value={
                  kycProvider === undefined
                    ? "unknown (registry scan failed)"
                    : kycProvider === null
                      ? "no KYC registry yet"
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
                  The KYC provider differs from the Super Admin: passports stay
                  under the registry authority after admin rotation, and no
                  instruction rotates the KYC authority itself. Rotation closed
                  the provider&apos;s Admin record — re-add the provider key via
                  add_admin so it can still reach /admin/kyc and the client
                  detail pages to issue and revoke passports.
                </p>
              )}
            {platform.admin === walletAddress ? (
              <button
                type="button"
                disabled={tx.isSending}
                onClick={() => setConfirmPause(true)}
                className={`mt-6 ${BTN}`}
              >
                {tx.isSending
                  ? "Sending…"
                  : platform.paused
                    ? "Unpause platform"
                    : "Pause platform"}
              </button>
            ) : (
              <p className="mt-6 text-sm text-slate-500">
                Connected wallet is not the Super Admin — admin actions will be
                rejected on-chain.
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
      <BlocklistBootstrap />
      <AuthorityRotation kind="platform" />
      <AuthorityRotation kind="blocklist" />
      {platform && (
        <ConfirmModal
          open={confirmPause}
          onClose={() => setConfirmPause(false)}
          onConfirm={(reason) => togglePause(reason)}
          title={platform.paused ? "Unpause platform" : "Pause platform"}
          kind={platform.paused ? "warning" : "destructive"}
          confirmLabel={platform.paused ? "Unpause" : "Pause"}
          description={
            platform.paused ? (
              <p>
                Unpausing allows new issuer registrations, assets and share
                classes to be created. The reason will be recorded in the audit
                log.
              </p>
            ) : (
              <p>
                Pausing blocks{" "}
                <strong>
                  new issuer registrations, assets and share classes
                </strong>
                . Existing sales, transfers, custody, votes and claims continue.
                The reason will be recorded in the audit log.
              </p>
            )
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
