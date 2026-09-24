"use client";

// initialize_blocklist_authority in the browser (Talas 3.1 K3). The init is
// one-time and its `authority` is not a signer, so a wrong key there could
// never be fixed: the only browser path writes the connected upgrade
// authority itself ("self, then rotate"), and the permanent blocklist
// authority is proposed next and proves control by accepting at
// /account/roles. Mainnet bootstrap runs only through the 3.3 CLI, which
// takes an explicit authority plus a signed proof of control.

import { useCallback, useEffect, useState } from "react";
import {
  useSolanaClient,
  useWalletConnection,
  useSendTransaction,
} from "@solana/react-hooks";
import {
  TRANSFER_HOOK_PROGRAM_ADDRESS,
  fetchMaybeBlocklistAuthority,
  findBlocklistAuthorityPda,
} from "@/lib/generated/transfer_hook";
import {
  bootstrapRoleErrors,
  buildInitializeBlocklistAuthorityInstruction,
  MAINNET_BOOTSTRAP_REFUSAL,
} from "@/lib/program-bootstrap";
import { detectNetwork } from "@/lib/network";
import { recordAudit } from "@/lib/supabase";
import { walletSigner } from "@/lib/wallet-signer";
import { useToast } from "@/lib/toast";
import { explainSendError } from "@/lib/tx-error";
import { invalidateRoles } from "@/lib/role-store";
import { startFinalityPoll } from "@/lib/finality-poll";
import { UpgradeAuthorityNote, useUpgradeAuthorityStatus } from "./upgrade-authority-status";

export function BlocklistBootstrap({
  hideWhenInitialized = false,
  onInitialized,
}: {
  /** The bootstrap page shows this card only while the authority is missing. */
  hideWhenInitialized?: boolean;
  /** After the init landed; carries the permanent authority to pre-fill the rotation. */
  onInitialized?: (permanentBlocklistAuthority: string | null) => void;
} = {}) {
  const client = useSolanaClient(),
    conn = useWalletConnection(),
    tx = useSendTransaction(),
    toast = useToast();
  const network = detectNetwork();
  const wallet = conn.wallet?.account.address?.toString() ?? null;
  const [authority, setAuthority] = useState<string | null | undefined>(
      undefined,
    ),
    [error, setError] = useState<string | null>(null),
    [successor, setSuccessor] = useState(""),
    [ack, setAck] = useState(false),
    // The init landed (confirmed) but the finalized read may trail it: never
    // offer a second init meanwhile (it would only fail on-chain).
    [submitted, setSubmitted] = useState(false),
    [gaveUp, setGaveUp] = useState(false);
  const refused = network === "mainnet";
  const upgrade = useUpgradeAuthorityStatus(
    TRANSFER_HOOK_PROGRAM_ADDRESS,
    wallet,
    !refused && authority === null,
  );
  const check = bootstrapRoleErrors({
    network,
    surface: "browser",
    upgradeAuthority: wallet,
    blocklistAuthority: wallet,
    permanentBlocklistAuthority: successor,
  });
  /** Resolves true once the finalized authority exists. */
  const refresh = useCallback(async (): Promise<boolean> => {
    try {
      const [pda] = await findBlocklistAuthorityPda();
      const result = await fetchMaybeBlocklistAuthority(
        client.runtime.rpc,
        pda,
        { commitment: "finalized" },
      );
      setAuthority(result.exists ? result.data.authority : null);
      setError(null);
      return result.exists;
    } catch {
      setError(
        "Could not verify the hook's operational authority. Retry after RPC recovery.",
      );
      return false;
    }
  }, [client]);
  useEffect(() => {
    // Fetch and display live finalized authority after hydration.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);
  const waiting = submitted && !authority;
  useEffect(() => {
    // After the init: re-read until the finalized account appears.
    if (!waiting) return;
    return startFinalityPoll(refresh, { onGiveUp: () => setGaveUp(true) });
  }, [waiting, refresh]);
  async function initialize() {
    if (!conn.wallet || !wallet) return;
    const recheck = bootstrapRoleErrors({
      network: detectNetwork(),
      surface: "browser",
      upgradeAuthority: wallet,
      blocklistAuthority: wallet,
      permanentBlocklistAuthority: successor,
    });
    if (recheck.errors.length > 0) {
      toast.showError("Initialization unavailable", recheck.errors[0]);
      return;
    }
    const permanent = successor.trim() || null;
    const reason = "Program upgrade authority initializes the blocklist authority (self, then rotate)";
    const metadata = { authority: wallet, upgradeAuthority: wallet, permanentBlocklistAuthority: permanent };
    try {
      const signer = walletSigner(conn.wallet);
      // Self only: the authority is the connected upgrade authority.
      const ix = await buildInitializeBlocklistAuthorityInstruction(
        client.runtime.rpc,
        { payer: signer, upgradeAuthority: signer, authority: signer.address },
      );
      const signature = await tx.send({ instructions: [ix], feePayer: signer });
      const sig = typeof signature === "string" ? signature : "";
      toast.showTx(sig, {
        title: "Blocklist authority initialization submitted",
      });
      void recordAudit({
        ix_name: "initialize_blocklist_authority",
        category: "platform",
        actor_wallet: wallet,
        reason,
        target_label: wallet,
        tx_signature: sig || undefined,
        status: "success",
        metadata,
      });
      setSubmitted(true);
      setGaveUp(false);
      invalidateRoles();
      onInitialized?.(permanent);
      void refresh();
    } catch (error) {
      const detail = explainSendError(error);
      toast.showError("Initialization unavailable", detail);
      void recordAudit({
        ix_name: "initialize_blocklist_authority",
        category: "platform",
        actor_wallet: wallet,
        reason,
        target_label: wallet,
        status: "failed",
        metadata: { ...metadata, error: detail },
      });
    }
  }
  if (hideWhenInitialized && authority) return null;
  return (
    <section className="mt-6 rounded-xl border border-slate-200 bg-white p-6 shadow-card">
      <h2 className="text-lg font-semibold text-slate-900">
        Blocklist authority
      </h2>
      {error ? (
        <p className="mt-2 text-sm text-amber-800">{error}</p>
      ) : authority === undefined ? (
        <p className="mt-2 text-sm text-slate-500">Checking authority…</p>
      ) : authority ? (
        <p className="mt-2 break-all font-mono text-xs text-slate-600">
          {authority}
        </p>
      ) : waiting ? (
        <p className="mt-2 text-sm text-slate-600" role="status">
          Initialization submitted. Waiting for it to be finalized (usually
          under 30 s) before the authority shows here and can be rotated.
          {gaveUp && (
            <>
              {" "}Still not finalized: use Refresh authority, or reload the
              page if the transaction did not land.
            </>
          )}
        </p>
      ) : refused ? (
        <p className="mt-2 text-sm text-slate-700">
          The hook&apos;s blocklist authority is not initialized.{" "}
          {MAINNET_BOOTSTRAP_REFUSAL}, with the authority given explicitly
          and a signed proof that its key is controlled.
        </p>
      ) : (
        <>
          <p className="mt-2 text-sm text-slate-600">
            The hook&apos;s blocklist authority is not initialized. The
            transfer-hook program&apos;s upgrade-authority wallet initializes it,
            and <strong>becomes</strong> the blocklist authority:{" "}
            <span className="break-all font-mono text-xs">{wallet ?? "—"}</span>.
            The init is one-time, so no other key is written here: propose the
            permanent blocklist authority next; it accepts at /account/roles.
            Program upgrade authority is unchanged.
          </p>
          <UpgradeAuthorityNote state={upgrade} />
          <label className="mt-3 block text-xs text-slate-600">
            Permanent blocklist authority (optional — pre-fills the proposal after the init)
            <input
              value={successor}
              onChange={(e) => setSuccessor(e.target.value)}
              spellCheck={false}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs"
            />
          </label>
          {check.errors.map((e) => (
            <p key={e} className="mt-1 text-xs text-red-600">
              {e}
            </p>
          ))}
          <label className="mt-3 flex items-start gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={ack}
              onChange={(e) => setAck(e.target.checked)}
              className="mt-1"
            />
            <span>I will propose the permanent blocklist authority next.</span>
          </label>
          <button
            type="button"
            disabled={
              tx.isSending ||
              !conn.wallet ||
              !ack ||
              check.errors.length > 0 ||
              upgrade.status !== "ok"
            }
            onClick={() => void initialize()}
            className="mt-4 rounded-lg border border-brand-200 bg-brand-50 px-4 py-2 text-sm font-medium text-brand-800 disabled:opacity-50"
          >
            Initialize blocklist authority
          </button>
        </>
      )}
      <button
        type="button"
        onClick={() => void refresh()}
        className="mt-3 block text-xs text-slate-500 underline"
      >
        Refresh authority
      </button>
    </section>
  );
}
