"use client";

// Issuer authority key (program 2C-2). Not gated by the issuer role on
// purpose: the wallet that ACCEPTS a rotation, or EXECUTES a recovery, is not
// an issuer yet. Every action is gated on on-chain state only, and the
// program enforces the same rules.
//
// * The current authority proposes a new key, cancels, shares a link
//   (?issuer=<pda>) and sees any pending recovery with a Cancel button.
// * The proposed key accepts (or, for a recovery, executes once the 7-day
//   timelock has passed). Both are bundled with the sale / payout-vault syncs
//   so the new key can close sales and draw payouts at once.
import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { type Address, type Instruction } from "@solana/kit";
import {
  useSendTransaction,
  useSolanaClient,
  useWalletConnection,
} from "@solana/react-hooks";
import { ConfirmModal } from "@/components/confirm-modal";
import { IssuerRecoveryBanner } from "@/components/issuer-recovery-banner";
import { WalletRequired } from "@/components/wallet-required";
import { SkeletonCard } from "@/components/skeleton";
import {
  fetchMaybeIssuer,
  fetchMaybePlatform,
  findIssuerPda,
  findPlatformPda,
  type Issuer,
} from "@/lib/generated/asset_registry";
import { loadNetwork, type NetworkData } from "@/lib/enumerate";
import { featureDisabledMessage, features } from "@/lib/features";
import { fromBytes32 } from "@/lib/format";
import { loadNetworkPreferIndexer } from "@/lib/indexer";
import {
  buildAcceptIssuerAuthority,
  buildCancelIssuerAuthorityTransfer,
  buildExecuteIssuerRecovery,
  buildProposeIssuerAuthority,
  bundleWithSync,
  collectIssuerSyncTargets,
  describeRecoveryState,
  fetchPendingIssuerTransfer,
  findPendingForWallet,
  issuerAuthorityActions,
  issuerRecoveryState,
  issuerSyncInstructions,
  issuerTransferState,
  adminKeyRuleError,
  proposedIssuerAuthorityError,
  sendBatches,
  waitForIndexedAuthority,
  type PendingForWallet,
  type PendingIssuerTransfer,
} from "@/lib/issuer-authority";
import { detectNetwork } from "@/lib/network";
import { loadPayoutVaults } from "@/lib/payout-vault";
import { getSupabase, recordAudit } from "@/lib/supabase";
import { useToast } from "@/lib/toast";
import { explainSendError } from "@/lib/tx-error";
import { invalidateRoles } from "@/lib/role-store";
import { LOCAL_CLOCK_NOTE, useChainAlignedClock } from "@/lib/use-chain-aligned-clock";
import { walletSigner } from "@/lib/wallet-signer";

const ENABLED = features().issuerRotation;
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

type IssuerRow = { address: Address; issuer: Issuer };

type Action =
  | { kind: "propose"; issuer: Address; newAuthority: string }
  | { kind: "cancel"; issuer: Address; newAuthority: string }
  | { kind: "accept"; issuer: Address; currentAuthority: Address }
  | { kind: "execute"; issuer: Address; currentAuthority: Address; proposer: Address };

const IX_NAME: Record<Action["kind"], string> = {
  propose: "propose_issuer_authority",
  cancel: "cancel_issuer_authority_transfer",
  accept: "accept_issuer_authority",
  execute: "execute_issuer_recovery",
};

export default function IssuerRotationPage() {
  return (
    <Suspense fallback={null}>
      <Rotation />
    </Suspense>
  );
}

function Rotation() {
  const params = useSearchParams();
  const router = useRouter();
  const issuerParam = params.get("issuer");
  const conn = useWalletConnection();
  const client = useSolanaClient();
  const tx = useSendTransaction();
  const toast = useToast();
  const { now, fromChain } = useChainAlignedClock(client.runtime.rpc);
  const wallet = conn.wallet?.account.address?.toString() ?? null;

  const [data, setData] = useState<NetworkData | null>(null);
  const [issuers, setIssuers] = useState<IssuerRow[]>([]);
  const [live, setLive] = useState<Map<string, Issuer>>(new Map());
  const [platformAdmin, setPlatformAdmin] = useState<string | null>(null);
  const [pendingForMe, setPendingForMe] = useState<PendingForWallet | null>(null);
  const [myTransfer, setMyTransfer] = useState<PendingIssuerTransfer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [proposeInput, setProposeInput] = useState("");
  const [action, setAction] = useState<Action | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!ENABLED || !wallet) return;
    try {
      const rpc = client.runtime.rpc;
      const [network, [platformPda]] = await Promise.all([
        loadNetworkPreferIndexer(() => loadNetwork(rpc)),
        findPlatformPda(),
      ]);
      const platform = await fetchMaybePlatform(rpc, platformPda);
      const rows: IssuerRow[] = await Promise.all(
        network.issuers.map(async (issuer) => ({
          address: (await findIssuerPda({ legalEntityId: issuer.legalEntityId }))[0],
          issuer,
        })),
      );
      const staged = await findPendingForWallet(rpc, wallet as Address);
      // Live (chain) state for every issuer this page acts on: the indexer may
      // lag a rotation by a few seconds.
      const focus = new Set<string>([
        ...staged.transfers.map((t) => t.issuer.toString()),
        ...staged.recoveries.map((r) => r.issuer.toString()),
        ...rows.filter((r) => r.issuer.authority.toString() === wallet).map((r) => r.address.toString()),
        ...(issuerParam ? [issuerParam] : []),
      ]);
      const liveMap = new Map<string, Issuer>();
      for (const address of focus) {
        const record = await fetchMaybeIssuer(rpc, address as Address, { commitment: "confirmed" });
        if (record.exists) liveMap.set(address, record.data);
      }
      setData(network);
      setIssuers(rows);
      setLive(liveMap);
      setPlatformAdmin(platform.exists ? platform.data.admin.toString() : null);
      setPendingForMe(staged);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [client, wallet, issuerParam]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  // The issuer this wallet controls (the ?issuer= link wins when it names one).
  const mineEntry = wallet
    ? [...live.entries()].find(
        ([address, issuer]) =>
          issuer.authority.toString() === wallet && (!issuerParam || issuerParam === address),
      )
    : undefined;
  const mine = mineEntry ? { address: mineEntry[0] as Address, issuer: mineEntry[1] } : null;
  const mineAddress = mine?.address ?? null;

  useEffect(() => {
    let cancelled = false;
    async function read() {
      if (!mineAddress) {
        setMyTransfer(null);
        return;
      }
      try {
        const t = await fetchPendingIssuerTransfer(client.runtime.rpc, mineAddress);
        if (!cancelled) setMyTransfer(t);
      } catch {
        if (!cancelled) setMyTransfer(null);
      }
    }
    void read();
    return () => {
      cancelled = true;
    };
    // `live` is a new Map after every load(), so a propose / cancel re-reads
    // the pending transfer even though the issuer address is unchanged.
  }, [client, mineAddress, live]);

  const otherAuthorities = issuers
    .filter((r) => r.address.toString() !== mineAddress)
    .map((r) => (live.get(r.address.toString()) ?? r.issuer).authority.toString());

  if (!ENABLED) {
    return (
      <main className="min-w-0 flex-1">
        <p className="text-sm text-slate-600">{featureDisabledMessage("issuerRotation")}</p>
      </main>
    );
  }
  if (!conn.isReady) {
    return (
      <main className="min-w-0 flex-1">
        <SkeletonCard className="max-w-md" rows={4} />
      </main>
    );
  }
  if (!wallet || !conn.wallet) {
    return (
      <main className="min-w-0 flex-1">
        <WalletRequired />
      </main>
    );
  }

  /** Every out-of-sync sale / vault of `issuer`, measured against `authority`. */
  async function syncsFor(issuer: Address, authority: Address): Promise<Instruction[]> {
    if (!data) return [];
    const vaults = await loadPayoutVaults(client.runtime.rpc);
    const targets = await collectIssuerSyncTargets(data, vaults, issuer);
    return issuerSyncInstructions({ issuer, issuerAuthority: authority, ...targets });
  }

  async function run(current: Action, reason: string) {
    if (!conn.wallet || !wallet) return;
    const signer = walletSigner(conn.wallet);
    const ixName = IX_NAME[current.kind];
    const metadata: Record<string, unknown> = { issuer: current.issuer.toString() };
    const pendingId = toast.showPending(`${ixName.replaceAll("_", " ")}…`, reason);
    try {
      let batches: Instruction[][];
      switch (current.kind) {
        case "propose": {
          metadata.new_authority = current.newAuthority;
          const liveIssuer = live.get(current.issuer.toString());
          const adminError = liveIssuer
            ? await adminKeyRuleError(
                client.runtime.rpc,
                "rotation",
                liveIssuer.authority,
                current.newAuthority as Address,
              )
            : null;
          if (adminError) throw new Error(adminError);
          batches = [[
            await buildProposeIssuerAuthority({
              authoritySigner: signer,
              issuer: current.issuer,
              newAuthority: current.newAuthority as Address,
            }),
          ]];
          break;
        }
        case "cancel":
          metadata.cancelled_new_authority = current.newAuthority;
          batches = [[await buildCancelIssuerAuthorityTransfer({ authoritySigner: signer, issuer: current.issuer })]];
          break;
        case "accept": {
          metadata.previous_authority = current.currentAuthority.toString();
          const primary = await buildAcceptIssuerAuthority({
            newAuthoritySigner: signer,
            issuer: current.issuer,
            currentAuthority: current.currentAuthority,
          });
          const syncs = await syncsFor(current.issuer, signer.address);
          metadata.syncs = syncs.length;
          batches = bundleWithSync([primary], syncs, { feePayer: signer.address, order: "primary-first" });
          break;
        }
        case "execute": {
          metadata.previous_authority = current.currentAuthority.toString();
          metadata.proposed_by = current.proposer.toString();
          const primary = await buildExecuteIssuerRecovery({
            newAuthoritySigner: signer,
            issuer: current.issuer,
            currentAuthority: current.currentAuthority,
            proposer: current.proposer,
          });
          const syncs = await syncsFor(current.issuer, signer.address);
          metadata.syncs = syncs.length;
          batches = bundleWithSync([primary], syncs, { feePayer: signer.address, order: "primary-first" });
          break;
        }
      }
      const result = await sendBatches(batches, (instructions, i) => {
        if (batches.length > 1) setStatus(`Sending transaction ${i + 1} of ${batches.length}…`);
        return tx.send({ instructions, feePayer: signer });
      });
      const signature = result.signature;
      toast.dismiss(pendingId);
      toast.showTx(signature, { title: ixName.replaceAll("_", " ") });
      if (result.error) {
        // The key change landed with the first transaction; only later syncs
        // failed. Old snapshots keep the previous key's close / payout window
        // open until they are synced.
        metadata.syncs_pending = result.pending;
        metadata.sync_error = explainSendError(result.error);
        toast.showError(
          `${result.pending} sale / payout-vault sync${result.pending === 1 ? "" : "s"} did not land`,
          "The key change itself succeeded. Sync the rest from the payouts page or ask the Super Admin to run “Sync all”.",
        );
      }
      void recordAudit({
        ix_name: ixName,
        category: "issuers",
        actor_wallet: wallet,
        reason,
        target_label: current.issuer.toString(),
        tx_signature: signature || undefined,
        status: "success",
        metadata,
      });
      setAction(null);
      setProposeInput("");
      invalidateRoles();
      if (current.kind === "accept" || current.kind === "execute") {
        setStatus("Waiting for the indexer to record the new issuer key…");
        const sb = getSupabase();
        const indexed = sb
          ? await waitForIndexedAuthority(async () => {
              const { data: row } = await sb
                .from("issuers")
                .select("authority")
                .eq("network", detectNetwork())
                .eq("pda", current.issuer.toString())
                .maybeSingle();
              return (row as { authority?: string } | null)?.authority ?? null;
            }, wallet)
          : false;
        if (indexed) {
          // The issuer pages resolve "my issuer" from the indexer, which now
          // names this wallet.
          invalidateRoles();
          router.push("/issuer");
          return;
        }
        setStatus(
          "The issuer key moved on-chain. The indexer has not caught up yet: reload in a minute to open the issuer dashboard.",
        );
      } else {
        setStatus(null);
      }
      await load();
    } catch (err) {
      toast.dismiss(pendingId);
      setStatus(null);
      const detail = explainSendError(err);
      toast.showError(`${ixName.replaceAll("_", " ")} failed`, detail);
      void recordAudit({
        ix_name: ixName,
        category: "issuers",
        actor_wallet: wallet,
        reason,
        target_label: current.issuer.toString(),
        status: "failed",
        metadata: { ...metadata, error: detail },
      });
    }
  }

  const transferState = mine
    ? issuerTransferState(mine.address.toString(), mine.issuer.authority.toString(), myTransfer)
    : ({ kind: "none" } as const);
  const proposeError = mine
    ? proposedIssuerAuthorityError(proposeInput, mine.issuer.authority.toString(), otherAuthorities)
    : null;
  const shareLink =
    mine && typeof window !== "undefined"
      ? `${window.location.origin}/issuer/rotation?issuer=${mine.address.toString()}`
      : null;

  const incomingTransfers = (pendingForMe?.transfers ?? []).map((t) => {
    const issuer = live.get(t.issuer.toString());
    const state = issuer
      ? issuerTransferState(t.issuer.toString(), issuer.authority.toString(), t.transfer)
      : ({ kind: "none" } as const);
    return { ...t, issuerRecord: issuer, state };
  });
  const incomingRecoveries = (pendingForMe?.recoveries ?? []).map((r) => {
    const issuer = live.get(r.issuer.toString());
    const state =
      issuer && now !== null
        ? issuerRecoveryState(
            r.recovery,
            { address: r.issuer.toString(), authority: issuer.authority.toString() },
            platformAdmin,
            now,
          )
        : ({ kind: "none" } as const);
    return { ...r, issuerRecord: issuer, state };
  });

  return (
    <main className="min-w-0 flex-1">
      <p className="text-xs font-semibold uppercase tracking-widest text-slate-500">Issuer</p>
      <h1 className="mt-1 text-2xl font-semibold text-slate-900">Authority key</h1>
      <p className="mt-1 max-w-2xl text-sm text-slate-600">
        The issuer&apos;s legal identity, assets and sales stay where they are. Only the wallet that signs for the
        issuer moves. The current wallet proposes a new one, and the new wallet accepts with its own signature.
      </p>
      {error && (
        <p role="alert" className="mt-4 text-sm text-red-600">
          Could not read the issuer state: {error}
        </p>
      )}
      {status && (
        <p role="status" className="mt-4 rounded-lg border border-brand-200 bg-brand-50 px-3 py-2 text-xs text-brand-900">
          {status}
        </p>
      )}
      {data === null && !error && <SkeletonCard className="mt-6" rows={4} />}

      {/* Staged for this wallet */}
      {(incomingTransfers.length > 0 || incomingRecoveries.length > 0) && (
        <section className="mt-6 space-y-3" aria-labelledby="incoming-heading">
          <h2 id="incoming-heading" className="text-xs font-semibold uppercase tracking-widest text-slate-500">
            Waiting for this wallet
          </h2>
          {incomingTransfers.map((t) => {
            const name = t.issuerRecord ? fromBytes32(t.issuerRecord.legalEntityId) : short(t.issuer.toString());
            return (
              <div key={`t-${t.issuer}`} className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-950">
                <p className="font-semibold">Issuer {name} proposed this wallet as its authority</p>
                <p className="mt-1 text-xs">
                  Current authority <code className="font-mono">{short(t.transfer.currentAuthority)}</code>. Accepting
                  moves the issuer key here, carries its operating permissions over, and syncs its open sales and
                  payout vaults in the same step.
                </p>
                {t.state.kind === "live" && t.issuerRecord ? (
                  <button
                    type="button"
                    disabled={tx.isSending}
                    onClick={() =>
                      setAction({ kind: "accept", issuer: t.issuer, currentAuthority: t.issuerRecord!.authority })
                    }
                    className="mt-2 rounded-md bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-800 disabled:opacity-50"
                  >
                    Accept issuer authority
                  </button>
                ) : (
                  <p className="mt-2 text-xs text-amber-800">
                    This proposal is stale (the issuer key changed since), so it cannot be accepted.
                  </p>
                )}
              </div>
            );
          })}
          {incomingRecoveries.map((r) => {
            const name = r.issuerRecord ? fromBytes32(r.issuerRecord.legalEntityId) : short(r.issuer.toString());
            return (
              <div key={`r-${r.issuer}`} className="rounded-lg border border-brand-200 bg-brand-50 p-4 text-sm text-brand-950">
                <p className="font-semibold">Recovery of issuer {name} to this wallet</p>
                <p className="mt-1 text-xs">{describeRecoveryState(r.state)}</p>
                {!fromChain && <p className="mt-1 text-[11px] text-slate-500">{LOCAL_CLOCK_NOTE}</p>}
                {r.state.kind === "executable" && r.issuerRecord && (
                  <button
                    type="button"
                    disabled={tx.isSending}
                    onClick={() =>
                      setAction({
                        kind: "execute",
                        issuer: r.issuer,
                        currentAuthority: r.issuerRecord!.authority,
                        proposer: r.recovery.proposedBy as Address,
                      })
                    }
                    className="mt-2 rounded-md bg-brand-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-800 disabled:opacity-50"
                  >
                    Execute recovery
                  </button>
                )}
                <p className="mt-2 text-[11px] text-slate-600">
                  A recovery carries no operating permissions: the Super Admin grants them again after review.
                </p>
              </div>
            );
          })}
        </section>
      )}

      {/* The issuer this wallet controls */}
      {mine && (
        <section className="mt-6 rounded-xl border border-slate-200 bg-white p-5 shadow-card" aria-labelledby="mine-heading">
          <h2 id="mine-heading" className="text-sm font-semibold text-slate-900">
            {fromBytes32(mine.issuer.legalEntityId)}
          </h2>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
            <dt className="text-slate-500">Issuer</dt>
            <dd className="break-all font-mono text-slate-800">{mine.address.toString()}</dd>
            <dt className="text-slate-500">Authority</dt>
            <dd className="break-all font-mono text-slate-800">{mine.issuer.authority.toString()}</dd>
            <dt className="text-slate-500">Pending</dt>
            <dd className="text-slate-800">
              {transferState.kind === "none" ? (
                "None"
              ) : (
                <>
                  to <span className="break-all font-mono">{transferState.newAuthority}</span>
                  {transferState.kind === "stale" && (
                    <span className="ml-1 text-amber-700">(stale: it cannot be accepted, cancel it)</span>
                  )}
                </>
              )}
            </dd>
          </dl>

          <div className="mt-3 flex flex-wrap items-start gap-2">
            <label className="sr-only" htmlFor="issuer-new-authority">
              New authority wallet
            </label>
            <input
              id="issuer-new-authority"
              value={proposeInput}
              onChange={(e) => setProposeInput(e.target.value)}
              placeholder="New issuer wallet (e.g. a hardware wallet)"
              spellCheck={false}
              className="min-w-0 flex-1 rounded-md border border-slate-300 px-3 py-1.5 font-mono text-xs focus:border-slate-400 focus:outline-none"
            />
            <button
              type="button"
              disabled={tx.isSending || !proposeInput.trim() || proposeError !== null}
              onClick={() => setAction({ kind: "propose", issuer: mine.address, newAuthority: proposeInput.trim() })}
              className="rounded-md bg-brand-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-800 disabled:opacity-50"
            >
              {transferState.kind === "none" ? "Propose" : "Replace proposal"}
            </button>
            {issuerAuthorityActions(wallet, {
              issuerAuthority: mine.issuer.authority.toString(),
              platformAdmin,
              transfer: transferState,
              recovery: { kind: "none" },
            }).canCancelTransfer && (
              <button
                type="button"
                disabled={tx.isSending}
                onClick={() =>
                  setAction({
                    kind: "cancel",
                    issuer: mine.address,
                    newAuthority: transferState.kind === "none" ? "" : transferState.newAuthority,
                  })
                }
                className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                Cancel proposal
              </button>
            )}
            {proposeError && <p className="w-full text-xs text-red-600">{proposeError}</p>}
          </div>

          <ul className="mt-3 list-disc space-y-1 pl-5 text-[11px] text-slate-600">
            <li>
              Link the new wallet to your Manci account before proposing it: sale approvals and treasury
              reservations are checked against the wallets linked to your account.
            </li>
            <li>One wallet controls one issuer. A wallet that is already another issuer&apos;s authority is refused.</li>
            <li>
              A pending treasury mint reservation was made by this wallet: release it and reserve again from the
              new wallet after the rotation.
            </li>
            <li>Operating permissions (mint, metadata, conversion) move with the key.</li>
          </ul>

          {shareLink && transferState.kind === "live" && (
            <div className="mt-3 text-xs text-slate-700">
              Send the new wallet this link to accept:{" "}
              <code className="break-all font-mono">{shareLink}</code>{" "}
              <button
                type="button"
                onClick={() => void navigator.clipboard?.writeText(shareLink)}
                className="ml-1 rounded border border-slate-300 px-2 py-0.5 text-[11px] hover:bg-slate-50"
              >
                Copy
              </button>
            </div>
          )}

          <IssuerRecoveryBanner issuer={mine.address} issuerAuthority={mine.issuer.authority} onChanged={load} />
        </section>
      )}

      {data !== null && !mine && incomingTransfers.length === 0 && incomingRecoveries.length === 0 && (
        <p className="mt-6 text-sm text-slate-600">
          {issuerParam
            ? "This wallet is not this issuer's authority, and no rotation or recovery is waiting for it. Connect the wallet that was proposed."
            : "This wallet controls no issuer, and no rotation or recovery is waiting for it."}
        </p>
      )}

      {action && (
        <ConfirmModal
          open
          busy={tx.isSending}
          onClose={() => setAction(null)}
          onConfirm={(reason) => run(action, reason)}
          title={
            action.kind === "propose"
              ? "Propose a new issuer authority"
              : action.kind === "cancel"
                ? "Cancel the pending proposal"
                : action.kind === "accept"
                  ? "Accept the issuer authority"
                  : "Execute the issuer recovery"
          }
          kind={action.kind === "cancel" ? "warning" : "destructive"}
          confirmLabel={
            action.kind === "propose"
              ? "Propose"
              : action.kind === "cancel"
                ? "Cancel proposal"
                : action.kind === "accept"
                  ? "Accept"
                  : "Execute"
          }
          description={
            action.kind === "propose" ? (
              <p>
                Stage <span className="break-all font-mono">{action.newAuthority}</span> as this issuer&apos;s
                authority. Nothing moves until that wallet accepts. After that, only it can create assets, open
                and close sales, and draw payouts.
              </p>
            ) : action.kind === "cancel" ? (
              <p>Withdraw the pending proposal. The rent returns to this wallet.</p>
            ) : action.kind === "accept" ? (
              <p>
                Take over the issuer from {short(action.currentAuthority.toString())}. Its open sales and payout
                vaults are synced to this wallet in the same step (more transactions follow if they do not fit).
              </p>
            ) : (
              <p>
                Take over the issuer from the lost key {short(action.currentAuthority.toString())}. Its operating
                permissions are closed; the Super Admin grants them again. Open sales and payout vaults are synced
                to this wallet.
              </p>
            )
          }
        />
      )}
    </main>
  );
}
