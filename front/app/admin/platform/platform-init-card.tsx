"use client";

// initialize_platform in the browser (Talas 3.1 K2): devnet / testnet /
// localnet only, "self, then rotate". The connected upgrade authority becomes
// the initial Super Admin and admin #1 (the program writes both from the
// signer), the protocol treasury is an explicit input, and the permanent
// Super Admin is proposed right after (it accepts at /account/roles, which
// proves control). Mainnet bootstrap runs only through the 3.3 CLI.

import { useState } from "react";
import { createWalletTransactionSigner } from "@solana/client";
import { useSendTransaction, useSolanaClient, useWalletConnection } from "@solana/react-hooks";
import type { Address } from "@solana/kit";
import { ASSET_REGISTRY_PROGRAM_ADDRESS } from "@/lib/generated/asset_registry";
import {
  bootstrapRoleErrors,
  buildInitializePlatformInstruction,
  MAINNET_BOOTSTRAP_REFUSAL,
} from "@/lib/program-bootstrap";
import { detectNetwork } from "@/lib/network";
import { invalidateRoles } from "@/lib/role-store";
import { recordAudit } from "@/lib/supabase";
import { useToast } from "@/lib/toast";
import { explainSendError } from "@/lib/tx-error";
import { UpgradeAuthorityNote, useUpgradeAuthorityStatus } from "./upgrade-authority-status";

const CARD = "rounded-xl border border-slate-200 bg-white shadow-card p-6";
const BTN =
  "rounded-lg border border-slate-300/60 px-4 py-2 text-sm font-medium text-slate-900 transition-colors hover:border-slate-400 hover:text-slate-900 disabled:opacity-50";
const INPUT = "mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs";
// protocol_fee_bps is a RESERVED on-chain field — no instruction charges or
// collects it, and pricing is agreed per engagement (settled off-chain).
// Initialize it at 0: there is no update instruction, so a non-zero value
// written here could never be corrected on-chain.
export const PROTOCOL_FEE_BPS = 0;

export function PlatformInitCard({
  platformPda,
  onInitialized,
}: {
  platformPda: string;
  /** After the init landed; carries the permanent Super Admin to pre-fill the rotation. */
  onInitialized: (result: { permanentSuperAdmin: string | null }) => void | Promise<void>;
}) {
  const conn = useWalletConnection();
  const client = useSolanaClient();
  const tx = useSendTransaction();
  const toast = useToast();
  const network = detectNetwork();
  const wallet = conn.wallet?.account.address?.toString() ?? null;
  const [treasury, setTreasury] = useState("");
  const [successor, setSuccessor] = useState("");
  const [ack, setAck] = useState(false);

  const refused = network === "mainnet";
  const upgrade = useUpgradeAuthorityStatus(ASSET_REGISTRY_PROGRAM_ADDRESS, wallet, !refused);
  const check = bootstrapRoleErrors({
    network,
    surface: "browser",
    upgradeAuthority: wallet,
    superAdmin: wallet,
    treasury,
    permanentSuperAdmin: successor,
  });
  // An empty treasury is "not filled in yet", not an error to shout about.
  const shownErrors = check.errors.filter((e) => treasury.trim() || e !== "The protocol treasury is required.");

  async function initialize() {
    if (!wallet || !conn.wallet) return;
    const reason = "Program upgrade authority initializes the platform (self, then rotate)";
    const permanentSuperAdmin = successor.trim() || null;
    const metadata = { treasury: treasury.trim(), upgradeAuthority: wallet, permanentSuperAdmin };
    const recheck = bootstrapRoleErrors({
      network: detectNetwork(),
      surface: "browser",
      upgradeAuthority: wallet,
      superAdmin: wallet,
      treasury,
      permanentSuperAdmin: successor,
    });
    if (recheck.errors.length > 0) {
      toast.showError("Platform not initialized", recheck.errors[0]);
      return;
    }
    const pendingId = toast.showPending("Initializing platform…", reason);
    try {
      const { signer } = createWalletTransactionSigner(conn.wallet);
      const ix = await buildInitializePlatformInstruction(client.runtime.rpc, {
        admin: signer,
        upgradeAuthority: signer,
        protocolTreasury: treasury.trim() as Address,
        protocolFeeBps: PROTOCOL_FEE_BPS,
      });
      const result = await tx.send({ instructions: [ix], feePayer: signer });
      const sig = typeof result === "string" ? result : "";
      toast.dismiss(pendingId);
      toast.showTx(sig, { title: "Platform initialized" });
      void recordAudit({
        ix_name: "initialize_platform",
        category: "platform",
        actor_wallet: wallet,
        reason,
        target_label: wallet,
        tx_signature: sig || undefined,
        status: "success",
        metadata,
      });
      invalidateRoles();
      await onInitialized({ permanentSuperAdmin });
    } catch (err) {
      toast.dismiss(pendingId);
      const detail = explainSendError(err);
      toast.showError("Failed to initialize platform", detail);
      void recordAudit({
        ix_name: "initialize_platform",
        category: "platform",
        actor_wallet: wallet,
        reason,
        target_label: wallet,
        status: "failed",
        metadata: { ...metadata, error: detail },
      });
      console.error("[initialize_platform] full error:", err);
    }
  }

  return (
    <div className={`mt-8 ${CARD}`}>
      <h2 className="text-lg font-semibold text-slate-900">Platform not initialized</h2>
      {refused ? (
        <p className="mt-2 text-sm text-slate-700">
          {MAINNET_BOOTSTRAP_REFUSAL}: the initial Super Admin, the protocol
          treasury and the blocklist authority are set there, each explicitly.
        </p>
      ) : (
        <>
          <p className="mt-2 text-sm text-slate-600">
            Connect the deployed registry program&apos;s current upgrade-authority
            wallet. It becomes the initial Super Admin and admin #1; program
            upgrade authority is unchanged. Propose the permanent Super Admin
            right after, on this page: that wallet accepts at /account/roles.
          </p>
          <p className="mt-2 text-sm text-amber-800">
            The platform starts <strong>fully paused</strong>: every
            emergency-pause area is on until the Super Admin resumes them.
            Finish the bootstrap (blocklist authority, admins) first, then
            resume every area in the Emergency pause panel before handing
            authority over.
          </p>
          <dl className="mt-4 space-y-2 text-sm">
            <Row label="Platform PDA" value={platformPda} />
            <Row label="Super Admin = connected upgrade authority" value={wallet ?? "—"} />
            <Row label="Protocol fee" value={`${PROTOCOL_FEE_BPS} bps — reserved field, not charged`} />
          </dl>
          <UpgradeAuthorityNote state={upgrade} />
          <label className="mt-4 block text-xs text-slate-600">
            Protocol treasury (required)
            <input
              value={treasury}
              onChange={(e) => setTreasury(e.target.value)}
              placeholder="The Squads vault PDA that receives the platform share"
              spellCheck={false}
              className={INPUT}
            />
          </label>
          <label className="mt-3 block text-xs text-slate-600">
            Permanent Super Admin (optional — pre-fills the proposal after the init)
            <input
              value={successor}
              onChange={(e) => setSuccessor(e.target.value)}
              spellCheck={false}
              className={INPUT}
            />
          </label>
          {shownErrors.map((e) => (
            <p key={e} className="mt-1 text-xs text-red-600">
              {e}
            </p>
          ))}
          {check.warnings.map((w) => (
            <p key={w} className="mt-1 text-xs text-amber-800">
              {w}
            </p>
          ))}
          <label className="mt-4 flex items-start gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-1" />
            <span>
              This wallet becomes Super Admin and admin #1; I will propose the
              permanent Super Admin next.
            </span>
          </label>
          <button
            type="button"
            disabled={tx.isSending || !ack || check.errors.length > 0 || upgrade.status !== "ok"}
            onClick={() => void initialize()}
            className={`mt-5 ${BTN}`}
          >
            {tx.isSending ? "Sending…" : "Initialize Platform"}
          </button>
        </>
      )}
    </div>
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
