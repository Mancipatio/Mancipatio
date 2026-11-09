"use client";

import Link from "next/link";

import { WalletRequired } from "@/components/wallet-required";

import { type Address } from "@solana/kit";
import { createWalletTransactionSigner } from "@solana/client";
import {
  useSendTransaction,
  useSolanaClient,
  useWalletConnection,
} from "@solana/react-hooks";
import { useCallback, useEffect, useMemo, useState } from "react";
import { getRemoveAdminInstructionAsync } from "@/lib/generated/asset_registry";
import {
  buildCancelAdminProposal,
  buildGrantAdmin,
  buildProposeAdmin,
  listAdmins,
  listPendingAdmins,
  probeDirectGrant,
  type AdminDirectory,
  type DirectGrantSupport,
  type PendingAdminRecord,
} from "@/lib/admin-grants";
import {
  WALLET_LABEL_MAX,
  isWalletAddress,
  normalizeWalletLabel,
  readWalletLabels,
  setWalletLabel,
  type WalletLabels,
} from "@/lib/admin-wallet-labels";
import { describeProposalWindow, proposalWindowState } from "@/lib/proposal-window";
import { useChainClock } from "@/lib/use-chain-clock";
import { ACCOUNT_ROLES_PATH } from "@/components/require-role";
import { ConfirmModal } from "@/components/confirm-modal";
import { recordAudit } from "@/lib/supabase";
import { invalidateRoles } from "@/lib/role-store";
import { notifyAdminBadges } from "@/lib/admin-badges-events";
import { useRole } from "@/lib/auth";
import { WalletSessionRequiredError } from "@/lib/siws-client";
import { explainSendError } from "@/lib/tx-error";
import { detectNetwork, explorerTxUrl } from "@/lib/network";
import { useToast } from "@/lib/toast";

const CARD = "rounded-xl border border-slate-200 bg-white shadow-card p-6";
const BTN =
  "rounded-lg border border-slate-300/60 px-4 py-2 text-sm font-medium text-slate-900 transition-colors hover:border-slate-400 hover:text-slate-900 disabled:opacity-50";
const BTN2 =
  "rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:border-slate-500 disabled:opacity-50";
const BTN_SM =
  "rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:border-slate-500 disabled:opacity-50";
const INPUT =
  "w-full min-w-0 rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-slate-400";
const BADGE =
  "rounded-full border border-brand-200 bg-brand-50 px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wider text-brand-700";

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export default function AdminsPage() {
  const conn = useWalletConnection();
  const client = useSolanaClient();
  const tx = useSendTransaction();
  const wallet = conn.wallet?.account.address;
  // grant_admin / propose_admin / remove_admin and the names are the Super
  // Admin's alone (the program and the routes refuse anyone else); other
  // Admins see the list and may cancel a staged grant.
  const role = useRole({ kyc: true });
  const { isSuperAdmin, isAdmin } = role;
  const superAdminOnly = isSuperAdmin ? undefined : "Super Admin only: the program rejects this from any other wallet";

  const [directory, setDirectory] = useState<AdminDirectory | null>(null);
  const [directoryError, setDirectoryError] = useState<string | null>(null);
  const [pendingGrants, setPendingGrants] = useState<PendingAdminRecord[] | null>(null);
  const [pendingError, setPendingError] = useState<string | null>(null);
  const [support, setSupport] = useState<DirectGrantSupport | "checking">("checking");
  const [names, setNames] = useState<WalletLabels | null>(null);
  const [namesError, setNamesError] = useState<{ session: boolean; message: string } | null>(null);

  const [addAddr, setAddAddr] = useState("");
  const [addName, setAddName] = useState("");
  const [confirmAdd, setConfirmAdd] = useState(false);
  const [editing, setEditing] = useState<{ wallet: string; value: string } | null>(null);
  const [savingName, setSavingName] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState<PendingAdminRecord | null>(null);
  const [confirmGrantNow, setConfirmGrantNow] = useState<PendingAdminRecord | null>(null);
  const [revokeAddr, setRevokeAddr] = useState("");
  const toast = useToast();
  const now = useChainClock();

  const loadChain = useCallback(async () => {
    const rpc = client.runtime.rpc;
    const [admins, pending] = await Promise.allSettled([listAdmins(rpc), listPendingAdmins(rpc)]);
    if (admins.status === "fulfilled") {
      setDirectory(admins.value);
      setDirectoryError(null);
    } else {
      setDirectoryError(errorText(admins.reason));
    }
    if (pending.status === "fulfilled") {
      setPendingGrants(pending.value);
      setPendingError(null);
    } else {
      setPendingError(errorText(pending.reason));
    }
  }, [client]);

  useEffect(() => {
    // Load the chain state after hydration.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadChain();
  }, [loadChain]);

  // Whether this network's program grants at once (one simulation, nothing
  // sent). The Super Admin comes from the list, or is the connected wallet
  // when the list cannot be read, so adding never waits on the list.
  const superAdmin = directory?.superAdmin ?? null;
  const probeAs = superAdmin ?? (isSuperAdmin && wallet ? wallet.toString() : null);
  useEffect(() => {
    if (!probeAs) return;
    let live = true;
    void probeDirectGrant(client.runtime.rpc, probeAs as Address).then((s) => {
      if (live) setSupport(s);
    });
    return () => {
      live = false;
    };
  }, [client, probeAs]);

  const listed = useMemo(() => {
    const all = new Set<string>();
    for (const a of directory?.admins ?? []) all.add(a.admin);
    for (const p of pendingGrants ?? []) all.add(p.newAdmin);
    return [...all].sort();
  }, [directory, pendingGrants]);
  const listedKey = listed.join(",");

  const loadNames = useCallback(
    async (interactive: boolean | "session-only" = "session-only") => {
      if (!conn.wallet || listedKey === "") return;
      try {
        setNames(await readWalletLabels(conn.wallet, listedKey.split(","), { interactive }));
        setNamesError(null);
      } catch (err) {
        setNamesError({ session: err instanceof WalletSessionRequiredError, message: errorText(err) });
      }
    },
    [conn.wallet, listedKey],
  );
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadNames();
  }, [loadNames]);

  const direct = support === "supported";
  const addTarget = addAddr.trim();
  const addTargetValid = isWalletAddress(addTarget);
  let addNameError: string | null = null;
  try {
    normalizeWalletLabel(addName);
  } catch (err) {
    addNameError = errorText(err);
  }

  /** Names a wallet after a grant; a refusal leaves the role in place. */
  async function saveName(target: string, raw: string, quietWhenEmpty: boolean): Promise<boolean> {
    if (!conn.wallet) return false;
    const label = normalizeWalletLabel(raw);
    if (label === "" && quietWhenEmpty) return true;
    if (names && !names.available) {
      toast.showError("Name not saved", "Wallet names are not set up on this network yet (database migration 0092).");
      return false;
    }
    try {
      await setWalletLabel(conn.wallet, target, label);
      await loadNames(true);
      return true;
    } catch (err) {
      toast.showError("Name not saved", errorText(err));
      return false;
    }
  }

  /** Adds an Admin: at once (grant_admin) where the program has it, else the 48 h proposal. */
  async function add(reason: string) {
    if (!isSuperAdmin || !wallet || !conn.wallet || !addTargetValid || addNameError) return;
    const target = addTarget;
    const ixName = direct ? "grant_admin" : "propose_admin";
    const pendingId = toast.showPending(
      direct ? `Adding Admin ${short(target)}…` : `Proposing Admin ${short(target)}…`,
      reason,
    );
    try {
      const { signer } = createWalletTransactionSigner(conn.wallet);
      // Both re-read the Super Admin and refuse a wallet that is already an Admin.
      const instructions = direct
        ? await buildGrantAdmin(client.runtime.rpc, signer, target as Address)
        : [await buildProposeAdmin(client.runtime.rpc, signer, target as Address)];
      const sig = await tx.send({ instructions, feePayer: signer });
      toast.dismiss(pendingId);
      toast.showTx(sig, { title: direct ? "Admin added" : "Admin grant proposed" });
      void recordAudit({
        ix_name: ixName,
        category: "admins",
        actor_wallet: wallet.toString(),
        reason,
        target_label: target,
        tx_signature: sig,
      });
      setConfirmAdd(false);
      setAddAddr("");
      await saveName(target, addName, true);
      setAddName("");
      invalidateRoles();
      void loadChain();
      notifyAdminBadges({ afterIndexer: true });
    } catch (err) {
      toast.dismiss(pendingId);
      const explained = explainSendError(err);
      toast.showError(direct ? "Failed to add the Admin" : "Failed to propose the Admin", explained);
      void recordAudit({
        ix_name: ixName,
        category: "admins",
        actor_wallet: wallet.toString(),
        reason,
        target_label: target,
        status: "failed",
        metadata: { error: errorText(err), explained },
      });
    }
  }

  /** A staged grant made an Admin at once: one transaction cancels it and grants. */
  async function grantNow(p: PendingAdminRecord, reason: string) {
    if (!isSuperAdmin || !wallet || !conn.wallet) return;
    const target = p.newAdmin.toString();
    try {
      const { signer } = createWalletTransactionSigner(conn.wallet);
      const instructions = await buildGrantAdmin(client.runtime.rpc, signer, p.newAdmin);
      const sig = await tx.send({ instructions, feePayer: signer });
      toast.showTx(sig, { title: "Admin added" });
      void recordAudit({
        ix_name: "grant_admin",
        category: "admins",
        actor_wallet: wallet.toString(),
        reason,
        target_label: target,
        tx_signature: sig,
        metadata: { replaced_staged_grant: true },
      });
      setConfirmGrantNow(null);
      invalidateRoles();
      void loadChain();
      notifyAdminBadges({ afterIndexer: true });
    } catch (err) {
      const explained = explainSendError(err);
      toast.showError("Failed to add the Admin", explained);
      void recordAudit({
        ix_name: "grant_admin",
        category: "admins",
        actor_wallet: wallet.toString(),
        reason,
        target_label: target,
        status: "failed",
        metadata: { error: explained, replaced_staged_grant: true },
      });
    }
  }

  async function cancelGrant(p: PendingAdminRecord, reason: string) {
    if (!wallet || !conn.wallet) return;
    const target = p.newAdmin.toString();
    try {
      const { signer } = createWalletTransactionSigner(conn.wallet);
      const ix = await buildCancelAdminProposal(client.runtime.rpc, signer, p.newAdmin);
      const sig = await tx.send({ instructions: [ix], feePayer: signer });
      toast.showTx(sig, { title: "Admin grant cancelled" });
      void recordAudit({
        ix_name: "cancel_admin_proposal",
        category: "admins",
        actor_wallet: wallet.toString(),
        reason,
        target_label: target,
        tx_signature: sig,
      });
      setConfirmCancel(null);
      void loadChain();
      notifyAdminBadges({ afterIndexer: true });
    } catch (err) {
      const explained = explainSendError(err);
      toast.showError("Failed to cancel the grant", explained);
      void recordAudit({
        ix_name: "cancel_admin_proposal",
        category: "admins",
        actor_wallet: wallet.toString(),
        reason,
        target_label: target,
        status: "failed",
        metadata: { error: explained },
      });
    }
  }

  async function revoke(target: string, reason: string) {
    if (!isSuperAdmin || !wallet || !conn.wallet) return;
    const pendingId = toast.showPending(`Revoking Admin ${short(target)}…`, reason);
    try {
      const { signer } = createWalletTransactionSigner(conn.wallet);
      const ix = await getRemoveAdminInstructionAsync({
        superAdmin: signer,
        admin: target as Address,
      });
      const sig = await tx.send({ instructions: [ix], feePayer: signer });
      toast.dismiss(pendingId);
      toast.showTx(sig, { title: "Admin revoked" });
      void recordAudit({
        ix_name: "remove_admin",
        category: "admins",
        actor_wallet: wallet.toString(),
        reason,
        target_label: target,
        tx_signature: sig,
      });
      setConfirmRevoke(null);
      setRevokeAddr("");
      invalidateRoles();
      void loadChain();
    } catch (err) {
      toast.dismiss(pendingId);
      const explained = explainSendError(err);
      toast.showError("Failed to revoke the Admin", explained);
      void recordAudit({
        ix_name: "remove_admin",
        category: "admins",
        actor_wallet: wallet.toString(),
        reason,
        target_label: target,
        status: "failed",
        metadata: { error: errorText(err), explained },
      });
    }
  }

  async function rename() {
    if (!editing) return;
    setSavingName(true);
    const ok = await saveName(editing.wallet, editing.value, false);
    setSavingName(false);
    if (ok) setEditing(null);
  }

  const kycAuthority = role.kycRegistry?.registry.authority?.toString() ?? null;
  const blocklistAuthority = role.blocklistAuthority?.toString() ?? null;
  const rolesOf = (key: string) =>
    [
      key === superAdmin ? "Super Admin" : null,
      "Admin",
      key === kycAuthority ? "KYC provider" : null,
      key === blocklistAuthority ? "Blocklist authority" : null,
    ].filter((r): r is string => r !== null);

  const addHelp =
    support === "supported"
      ? "The wallet is an Admin as soon as the transaction lands. It signs nothing; you pay its record (about 0.0014 SOL, returned when you revoke it)."
      : support === "unsupported"
        ? "This network's program still grants in two steps: the wallet accepts at /account/roles once 48 hours have passed, within 14 days. Adding at once arrives with the program upgrade."
        : support === "checking"
          ? "Checking whether this network's program grants at once…"
          : "Could not check whether this network's program grants at once, so this proposes the grant (the wallet accepts at /account/roles after 48 hours).";

  return (
    <section className="min-w-0 flex-1">
      <h1 className="text-2xl font-semibold">Admins</h1>
      <p className="mt-1.5 max-w-3xl text-[13px] leading-relaxed text-slate-600">
        Admins operate issuance and custody. The Super Admin adds and revokes
        them; both are on-chain transactions, and every one raises a critical
        alert. Names are notes for operators: they grant nothing, and every
        role on this page is read from the chain. The blocklist is changed
        only by the blocklist authority, a separate key.
      </p>

      {!conn.isReady ? (
        <p className="mt-8 text-slate-500">Loading wallet…</p>
      ) : !wallet ? (
        <WalletRequired className="mt-8" />
      ) : (
        <div className="mt-8 space-y-6">
          <div className={CARD}>
            <h2 className="text-lg font-semibold text-slate-900">Add an Admin</h2>
            <p className="mt-1 max-w-2xl text-sm text-slate-500">
              Super Admin only. {addHelp}
            </p>
            <div className="mt-4 grid gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto]">
              <input
                className={INPUT}
                value={addAddr}
                placeholder="Wallet address"
                aria-label="Wallet address"
                spellCheck={false}
                onChange={(e) => setAddAddr(e.target.value)}
              />
              <input
                className={INPUT}
                value={addName}
                maxLength={WALLET_LABEL_MAX + 20}
                placeholder="Name, e.g. Ana — operations"
                aria-label="Name (who holds this wallet)"
                onChange={(e) => setAddName(e.target.value)}
              />
              <button
                type="button"
                disabled={!isSuperAdmin || tx.isSending || !addTargetValid || addNameError !== null || support === "checking"}
                title={superAdminOnly}
                onClick={() => setConfirmAdd(true)}
                className={`shrink-0 ${BTN}`}
              >
                {direct ? "Add Admin" : "Propose"}
              </button>
            </div>
            {addTarget !== "" && !addTargetValid && (
              <p className="mt-2 text-xs text-amber-800">That is not a Solana wallet address.</p>
            )}
            {addNameError && <p className="mt-2 text-xs text-amber-800">{addNameError}</p>}
          </div>

          <div className={CARD}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-lg font-semibold text-slate-900">
                Admins{directory ? ` (${directory.admins.length})` : ""}
              </h2>
              <button type="button" className={BTN_SM} onClick={() => void loadChain()}>
                Refresh
              </button>
            </div>
            {namesError && (
              <div className="mt-3 flex flex-col gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700 sm:flex-row sm:items-center sm:justify-between">
                <span role="alert">
                  {namesError.session
                    ? "Sign in with your wallet to see the names (one signature, nothing is sent on chain)."
                    : `Could not load the names: ${namesError.message}`}
                </span>
                <button type="button" className={BTN_SM} onClick={() => void loadNames(true)}>
                  {namesError.session ? "Sign in" : "Retry"}
                </button>
              </div>
            )}
            {names && !names.available && isSuperAdmin && (
              <p className="mt-3 text-xs text-amber-800">
                Wallet names are not set up on this network yet (database migration 0092).
              </p>
            )}
            {directoryError ? (
              <p className="mt-3 text-sm text-amber-800">Could not read the Admins: {directoryError}</p>
            ) : directory === null ? (
              <p className="mt-3 text-sm text-slate-500">Loading…</p>
            ) : (
              <ul className="mt-3 divide-y divide-slate-100">
                {directory.admins.map((a) => {
                  const key = a.admin.toString();
                  const isSa = key === superAdmin;
                  const isEditing = editing?.wallet === key;
                  return (
                    <li key={key} className="flex flex-wrap items-start justify-between gap-3 py-3 text-sm">
                      <div className="min-w-0 flex-1 space-y-1">
                        {isEditing ? (
                          <div className="flex flex-wrap gap-2">
                            <input
                              className={`${INPUT} max-w-sm`}
                              value={editing.value}
                              autoFocus
                              maxLength={WALLET_LABEL_MAX + 20}
                              placeholder="Name (empty removes it)"
                              aria-label={`Name of ${key}`}
                              onChange={(e) => setEditing({ wallet: key, value: e.target.value })}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") void rename();
                                if (e.key === "Escape") setEditing(null);
                              }}
                            />
                            <button type="button" className={BTN_SM} disabled={savingName} onClick={() => void rename()}>
                              {savingName ? "Saving…" : "Save"}
                            </button>
                            <button type="button" className={BTN_SM} disabled={savingName} onClick={() => setEditing(null)}>
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <WalletName address={key} names={names} />
                        )}
                        <p className="break-all font-mono text-xs text-slate-700">{key}</p>
                        <div className="flex flex-wrap items-center gap-1.5">
                          {rolesOf(key).map((r) => (
                            <span key={r} className={BADGE}>
                              {r}
                            </span>
                          ))}
                          <span className="text-[11px] text-slate-500">
                            {key === wallet ? "This wallet · " : ""}
                            {isSa && a.addedBy.toString() === key ? "set up with the platform" : `added by ${a.addedBy.toString() === superAdmin ? "the Super Admin" : short(a.addedBy.toString())}`}
                          </span>
                        </div>
                      </div>
                      {!isEditing && (
                        <div className="flex shrink-0 gap-2">
                          <button
                            type="button"
                            className={BTN_SM}
                            disabled={!isSuperAdmin || (names !== null && !names.available)}
                            title={isSuperAdmin ? undefined : "Super Admin only"}
                            onClick={() => setEditing({ wallet: key, value: names?.labels[key]?.label ?? "" })}
                          >
                            {names?.labels[key] ? "Rename" : "Name"}
                          </button>
                          <button
                            type="button"
                            className={BTN_SM}
                            disabled={!isSuperAdmin || isSa || tx.isSending}
                            title={
                              isSa
                                ? "The Super Admin's own record stays while it is the Super Admin; hand the role over first (/account/roles)"
                                : superAdminOnly
                            }
                            onClick={() => setConfirmRevoke(key)}
                          >
                            Revoke
                          </button>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {directoryError && (
              <div className="mt-4 border-t border-slate-100 pt-4">
                <p className="text-sm text-slate-600">Revoke by address while the list cannot be read:</p>
                <div className="mt-2 flex gap-2">
                  <input
                    className={INPUT}
                    value={revokeAddr}
                    placeholder="Admin wallet address"
                    aria-label="Admin wallet address"
                    onChange={(e) => setRevokeAddr(e.target.value)}
                  />
                  <button
                    type="button"
                    disabled={!isSuperAdmin || tx.isSending || !isWalletAddress(revokeAddr.trim())}
                    title={superAdminOnly}
                    onClick={() => setConfirmRevoke(revokeAddr.trim())}
                    className={`shrink-0 ${BTN2}`}
                  >
                    Revoke
                  </button>
                </div>
              </div>
            )}
            <p className="mt-4 max-w-2xl text-xs leading-relaxed text-slate-500">
              The program has one Admin role. The Super Admin, the KYC provider
              and the blocklist authority are separate keys: each is handed
              over by proposing the next key, which accepts with its own
              signature on{" "}
              <Link href={ACCOUNT_ROLES_PATH} className="font-medium text-brand-700 underline">
                {ACCOUNT_ROLES_PATH}
              </Link>
              .
            </p>
          </div>

          {(pendingError || (pendingGrants !== null && pendingGrants.length > 0)) && (
            <div className={CARD}>
              <h2 className="text-lg font-semibold text-slate-900">Pending admin grants</h2>
              <p className="mt-1 max-w-2xl text-sm text-slate-500">
                Proposed grants the proposed wallet executes itself at{" "}
                <Link href={ACCOUNT_ROLES_PATH} className="underline">
                  {ACCOUNT_ROLES_PATH}
                </Link>{" "}
                after 48 hours, within 14 days.
                {direct && " The Super Admin can add the wallet now instead: the proposal is cancelled in the same transaction."}
              </p>
              {pendingError ? (
                <p className="mt-2 text-sm text-amber-800">Could not read the pending grants: {pendingError}</p>
              ) : (
                <ul className="mt-3 divide-y divide-slate-100">
                  {(pendingGrants ?? []).map((p) => (
                    <li key={p.address} className="flex flex-wrap items-start justify-between gap-3 py-3 text-sm">
                      <div className="min-w-0 flex-1 space-y-1">
                        <WalletName address={p.newAdmin.toString()} names={names} />
                        <p className="break-all font-mono text-xs text-slate-800">{p.newAdmin}</p>
                        <p className="text-xs text-slate-500">
                          {/* The program waives the 48 h while the bootstrap window (bit 7) is open (util::effective_eta). */}
                          {describeProposalWindow(
                            proposalWindowState(p, now, { pauseFlags: p.platformPauseFlags, bootstrapWaived: true }),
                          )}
                        </p>
                        {p.stale && (
                          <p className="text-xs text-amber-800">
                            Proposed by an earlier Super Admin ({p.proposedBy.slice(0, 6)}…): it can no longer be
                            executed. Cancel it.
                          </p>
                        )}
                      </div>
                      <div className="flex shrink-0 gap-2">
                        {direct && (
                          <button
                            type="button"
                            disabled={!isSuperAdmin || tx.isSending}
                            title={superAdminOnly}
                            onClick={() => setConfirmGrantNow(p)}
                            className={BTN_SM}
                          >
                            Add now
                          </button>
                        )}
                        <button
                          type="button"
                          disabled={!isAdmin || tx.isSending}
                          title={isAdmin ? undefined : "Admins (and the upgrade authority) only"}
                          onClick={() => setConfirmCancel(p)}
                          className={BTN_SM}
                        >
                          Cancel
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
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
      <ConfirmModal
        open={confirmAdd}
        onClose={() => setConfirmAdd(false)}
        onConfirm={(reason) => add(reason)}
        title={direct ? "Add an Admin" : "Propose an Admin"}
        kind="info"
        confirmLabel={direct ? "Add Admin" : "Propose"}
        description={
          <>
            <p>{direct ? "You are about to make this wallet an Admin:" : "You are about to propose admin permissions for:"}</p>
            <p className="mt-2 break-all rounded bg-slate-100 px-2 py-1 font-mono text-xs">{addTarget}</p>
            {normalizeSafe(addName) && <p className="mt-2 text-sm">Name: {normalizeSafe(addName)}</p>}
            <p className="mt-2 text-xs text-slate-500">
              {direct
                ? "It gains access to issuance and custody as soon as the transaction lands, without signing anything. You can revoke it at any time. "
                : "After 48 hours that wallet takes the role itself, within 14 days. It will gain access to issuance and custody. "}
              The blocklist stays with the blocklist authority. The reason is recorded in the audit log
              {normalizeSafe(addName) ? "; saving the name asks for one more wallet signature." : "."}
            </p>
          </>
        }
        busy={tx.isSending}
      />
      <ConfirmModal
        open={confirmGrantNow !== null}
        onClose={() => setConfirmGrantNow(null)}
        onConfirm={(reason) => (confirmGrantNow ? grantNow(confirmGrantNow, reason) : undefined)}
        title="Add this Admin now"
        kind="info"
        confirmLabel="Add Admin"
        description={
          <p>
            <span className="break-all font-mono text-xs">{confirmGrantNow?.newAdmin}</span> becomes an Admin
            at once. Its pending proposal is cancelled in the same transaction (the proposal&apos;s rent
            returns to the Super Admin who made it).
          </p>
        }
        busy={tx.isSending}
      />
      <ConfirmModal
        open={confirmCancel !== null}
        onClose={() => setConfirmCancel(null)}
        onConfirm={(reason) => (confirmCancel ? cancelGrant(confirmCancel, reason) : undefined)}
        title="Cancel the admin grant"
        kind="warning"
        confirmLabel="Cancel grant"
        description={
          <p>
            The pending grant for{" "}
            <span className="break-all font-mono text-xs">{confirmCancel?.newAdmin}</span> is
            withdrawn; its rent returns to the Super Admin who proposed it.
          </p>
        }
        busy={tx.isSending}
      />
      <ConfirmModal
        open={confirmRevoke !== null}
        onClose={() => setConfirmRevoke(null)}
        onConfirm={(reason) => (confirmRevoke ? revoke(confirmRevoke, reason) : undefined)}
        title="Revoke admin role"
        kind="destructive"
        confirmLabel="Revoke"
        description={
          <>
            <p>You are about to revoke admin permissions from:</p>
            {confirmRevoke && names?.labels[confirmRevoke] && (
              <p className="mt-2 text-sm font-semibold">{names.labels[confirmRevoke].label}</p>
            )}
            <p className="mt-2 break-all rounded bg-slate-100 px-2 py-1 font-mono text-xs">{confirmRevoke}</p>
            <p className="mt-2 text-xs text-slate-500">
              It loses access to every operational instruction at once. Its name stays, so a later grant
              shows it again. The reason is recorded in the audit log.
            </p>
          </>
        }
        busy={tx.isSending}
      />
    </section>
  );
}

/** Who holds a wallet: its operator name (0092) and the Manci account it is linked to. */
function WalletName({ address, names }: { address: string; names: WalletLabels | null }) {
  const label = names?.labels[address]?.label ?? null;
  const account = names?.accounts[address] ?? null;
  const accountText = account
    ? [account.displayName || null, account.email].filter(Boolean).join(" · ") || "linked Manci account"
    : null;
  return (
    <div className="min-w-0">
      <p className={label ? "font-semibold text-slate-900" : "text-slate-500"}>{label ?? "No name"}</p>
      {accountText && <p className="mt-0.5 text-xs text-slate-600">Account: {accountText}</p>}
    </div>
  );
}

/** The name as it would be stored, or "" while it is invalid. */
function normalizeSafe(raw: string): string {
  try {
    return normalizeWalletLabel(raw);
  } catch {
    return "";
  }
}
