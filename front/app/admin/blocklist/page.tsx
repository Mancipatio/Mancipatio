"use client";

import { useCallback, useEffect, useState } from "react";
import { createWalletTransactionSigner } from "@solana/client";
import {
  useSendTransaction,
  useSolanaClient,
  useWalletConnection,
} from "@solana/react-hooks";
import { isAddress, type Address } from "@solana/kit";
import {
  fetchMaybeBlocklistAuthority,
  findBlocklistAuthorityPda,
  getAddToBlocklistInstructionAsync,
  getRemoveFromBlocklistInstructionAsync,
  type BlocklistAuthority,
} from "@/lib/generated/transfer_hook";
import { listBlockEntries, type BlockEntryRow } from "@/lib/blocklist";
import { ConfirmModal } from "@/components/confirm-modal";
import { Kpi } from "@/components/kpi";
import { RequireRole } from "@/components/require-role";
import { SkeletonCard, SkeletonTable } from "@/components/skeleton";
import { detectNetwork, explorerAddressUrl } from "@/lib/network";
import { recordAudit } from "@/lib/supabase";
import { explainSendError } from "@/lib/tx-error";
import { useToast } from "@/lib/toast";

export default function BlocklistPage() {
  return (
    <section className="min-w-0 flex-1">
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
          Compliance
        </p>
        <h1 className="mt-1 text-xl font-semibold text-slate-900">
          Sanctions blocklist
        </h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-slate-600">
          On-chain sender blocklist enforced by the transfer_hook program on
          every Token-2022 transfer. A wallet on this list cannot move any
          Manci token — add entries for sanctions hits and court orders,
          remove them once the restriction lifts.
        </p>
      </div>
      <RequireRole role="admin">
        <BlocklistOps />
      </RequireRole>
    </section>
  );
}

function BlocklistOps() {
  const conn = useWalletConnection();
  const client = useSolanaClient();
  const tx = useSendTransaction();
  const toast = useToast();
  const wallet = conn.wallet?.account.address;

  const [authorityPda, setAuthorityPda] = useState("");
  const [authority, setAuthority] = useState<BlocklistAuthority | null | undefined>(
    undefined,
  );
  const [entries, setEntries] = useState<BlockEntryRow[] | null>(null);
  const [newWallet, setNewWallet] = useState("");
  const [confirmAdd, setConfirmAdd] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<BlockEntryRow | null>(null);

  const refresh = useCallback(async () => {
    const [pda] = await findBlocklistAuthorityPda();
    setAuthorityPda(pda);
    const maybe = await fetchMaybeBlocklistAuthority(client.runtime.rpc, pda);
    setAuthority(maybe.exists ? maybe.data : null);
    setEntries(await listBlockEntries(client.runtime.rpc));
  }, [client]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const target = newWallet.trim();
  const targetValid = isAddress(target);
  const alreadyBlocked =
    targetValid && (entries ?? []).some((r) => r.entry.wallet === target);
  const isAuthority =
    authority != null && wallet != null && authority.authority === wallet;

  async function send(
    kind: "add_to_blocklist" | "remove_from_blocklist",
    targetWallet: string,
    reason: string,
  ) {
    if (!wallet || !conn.wallet) return;
    const pendingId = toast.showPending(
      kind === "add_to_blocklist"
        ? "Blocking wallet…"
        : "Removing from blocklist…",
      reason,
    );
    try {
      const { signer } = createWalletTransactionSigner(conn.wallet);
      const ix =
        kind === "add_to_blocklist"
          ? await getAddToBlocklistInstructionAsync({
              authority: signer,
              wallet: targetWallet as Address,
            })
          : await getRemoveFromBlocklistInstructionAsync({
              authority: signer,
              wallet: targetWallet as Address,
            });
      const result = await tx.send({ instructions: [ix], feePayer: signer });
      const sig = typeof result === "string" ? result : "";
      toast.dismiss(pendingId);
      toast.showTx(sig, {
        title:
          kind === "add_to_blocklist" ? "Wallet blocked" : "Wallet unblocked",
      });
      void recordAudit({
        ix_name: kind,
        category: "other",
        actor_wallet: wallet.toString(),
        reason,
        target_label: targetWallet,
        tx_signature: sig || undefined,
        status: "success",
      });
      setConfirmAdd(false);
      setConfirmRemove(null);
      setNewWallet("");
      await refresh();
    } catch (err) {
      toast.dismiss(pendingId);
      const detail = explainSendError(err);
      toast.showError("Transaction failed", detail);
      void recordAudit({
        ix_name: kind,
        category: "other",
        actor_wallet: wallet.toString(),
        reason,
        target_label: targetWallet,
        status: "failed",
        metadata: { error: detail },
      });
      console.error(`[${kind}] full error:`, err);
    }
  }

  return (
    <div className="mt-8 space-y-6">
      {/* Authority state */}
      {authority === undefined ? (
        <SkeletonCard rows={2} />
      ) : authority === null ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-6">
          <p className="text-sm font-semibold text-amber-900">
            Blocklist not initialized on this network
          </p>
          <p className="mt-1 text-xs leading-relaxed text-amber-800/90">
            The transfer_hook program has no BlocklistAuthority singleton on
            the connected cluster yet (PDA{" "}
            <span className="font-mono">{authorityPda}</span>). It is created
            once at deployment by <code>initialize_blocklist_authority</code>{" "}
            — until then no wallet can be blocked.
          </p>
        </div>
      ) : (
        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-card">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-base font-semibold text-slate-900">
              Blocklist authority
            </h2>
            <span className="text-[10px] uppercase tracking-wider text-slate-400">
              on-chain
            </span>
          </div>
          <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
            <Field label="Authority wallet" value={authority.authority} mono />
            <Field label="Authority PDA" value={authorityPda} mono />
          </dl>
          {wallet && !isAuthority && (
            <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-relaxed text-amber-800">
              Connected wallet is <strong>not</strong> the blocklist authority
              — add / remove transactions below will be rejected on-chain
              (Unauthorized). Connect with the authority wallet to make
              changes.
            </p>
          )}
        </section>
      )}

      {/* Entries */}
      <section className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <Kpi
            label="Blocked wallets"
            value={entries === null ? "…" : String(entries.length)}
            tone={(entries?.length ?? 0) > 0 ? "warn" : "default"}
          />
        </div>

        {/* Add form */}
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-card">
          <h2 className="text-base font-semibold text-slate-900">
            Block a wallet
          </h2>
          <div className="mt-3 flex flex-wrap items-start gap-3">
            <div className="min-w-64 flex-1">
              <input
                value={newWallet}
                onChange={(e) => setNewWallet(e.target.value)}
                placeholder="Wallet address (base58)"
                className="w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-xs focus:border-slate-400 focus:outline-none"
              />
              {target !== "" && !targetValid && (
                <p className="mt-1 text-[11px] text-red-600">
                  Not a valid base58 Solana address.
                </p>
              )}
              {alreadyBlocked && (
                <p className="mt-1 text-[11px] text-amber-700">
                  This wallet is already on the blocklist.
                </p>
              )}
            </div>
            <button
              type="button"
              disabled={
                !targetValid ||
                alreadyBlocked ||
                authority == null ||
                !wallet ||
                tx.isSending
              }
              onClick={() => setConfirmAdd(true)}
              className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
            >
              + Add to blocklist
            </button>
          </div>
        </div>

        {/* Table */}
        {entries === null ? (
          <SkeletonTable rows={3} cols={4} />
        ) : entries.length === 0 ? (
          <div className="rounded-xl border border-slate-200 bg-white p-12 text-center shadow-card">
            <p className="text-sm text-slate-600">
              No wallets on the blocklist.
            </p>
            <p className="mt-1 text-xs text-slate-400">
              Entries appear here once a wallet is blocked above.
            </p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-card">
            <table className="w-full text-sm">
              <thead className="border-b border-slate-100 bg-slate-50 text-left text-xs uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-4 py-3 font-medium">Blocked wallet</th>
                  <th className="px-4 py-3 font-medium">Added by</th>
                  <th className="px-4 py-3 font-medium">Entry PDA</th>
                  <th className="px-4 py-3 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {entries.map((r) => (
                  <tr key={r.pda} className="text-slate-700">
                    <td className="px-4 py-3">
                      <a
                        href={explorerAddressUrl(r.entry.wallet, detectNetwork())}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-mono text-xs text-slate-800 underline-offset-2 hover:underline"
                        title={r.entry.wallet}
                      >
                        {r.entry.wallet.slice(0, 8)}…{r.entry.wallet.slice(-6)}
                      </a>
                    </td>
                    <td
                      className="px-4 py-3 font-mono text-[11px] text-slate-500"
                      title={r.entry.addedBy}
                    >
                      {r.entry.addedBy.slice(0, 6)}…{r.entry.addedBy.slice(-4)}
                    </td>
                    <td
                      className="px-4 py-3 font-mono text-[11px] text-slate-500"
                      title={r.pda}
                    >
                      {r.pda.slice(0, 6)}…{r.pda.slice(-4)}
                    </td>
                    <td className="px-4 py-3 text-right text-xs">
                      <button
                        type="button"
                        onClick={() => setConfirmRemove(r)}
                        className="text-red-700 underline-offset-2 hover:underline"
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {confirmAdd && (
        <ConfirmModal
          open
          onClose={() => setConfirmAdd(false)}
          onConfirm={(reason) => void send("add_to_blocklist", target, reason)}
          title="Block wallet"
          kind="destructive"
          confirmLabel="Block"
          busy={tx.isSending}
          description={
            <p>
              <span className="font-mono text-xs">
                {target.slice(0, 8)}…{target.slice(-6)}
              </span>{" "}
              will be unable to send any Manci token — every transfer out of
              its token accounts will fail on-chain. A Manci admin can then
              claw this wallet&apos;s units into a burn-only quarantine on any
              class, Open or KYC-gated. Provide the sanctions / legal basis; it
              lands in the audit log.
            </p>
          }
        />
      )}

      {confirmRemove && (
        <ConfirmModal
          open
          onClose={() => setConfirmRemove(null)}
          onConfirm={(reason) =>
            void send("remove_from_blocklist", confirmRemove.entry.wallet, reason)
          }
          title="Remove from blocklist"
          kind="warning"
          confirmLabel="Remove"
          busy={tx.isSending}
          description={
            <p>
              <span className="font-mono text-xs">
                {confirmRemove.entry.wallet.slice(0, 8)}…
                {confirmRemove.entry.wallet.slice(-6)}
              </span>{" "}
              regains the ability to transfer Manci tokens. Units already
              clawed back into quarantine are not returned. Provide the reason
              for lifting the restriction; it lands in the audit log.
            </p>
          }
        />
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
