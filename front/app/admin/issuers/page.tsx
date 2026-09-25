"use client";

import Link from "next/link";
import { type Address } from "@solana/kit";
import { createWalletTransactionSigner } from "@solana/client";
import {
  useSendTransaction,
  useSolanaClient,
  useWalletConnection,
} from "@solana/react-hooks";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchMaybeIssuer,
  findIssuerPda,
  getRegisterIssuerInstructionAsync,
  getVerifyIssuerKybInstructionAsync,
  KybStatus,
  type Issuer,
} from "@/lib/generated/asset_registry";
import { loadNetwork, type NetworkData } from "@/lib/enumerate";
import { loadNetworkPreferIndexer } from "@/lib/indexer";
import { toBytes32 } from "@/lib/format";
import { createLatestGate } from "@/lib/latest-load";
import {
  applyKybOverrides,
  createKybDecisionGuard,
  createReconcileRegistry,
  decisionStatus,
  filterIssuers,
  giveUpOverride,
  ISSUER_STATUS_FILTERS,
  isPendingKyb,
  issuerLegalId,
  issuerStatusCounts,
  kybDecisionPreflight,
  kybDossierHref,
  kybLabel,
  matchesStatus,
  reconciledStatus,
  startKybReconcile,
  statusChipLabel,
  unsettledOverrides,
  waitForKybConfirmation,
  type IssuerStatusFilter,
  type KybDecisionGuard,
  type KybDecisionPhase,
  type KybOverride,
  type KybOverrides,
  type OpenReview,
} from "@/lib/issuer-directory";
import { SkeletonTable, SkeletonCard } from "@/components/skeleton";
import { ConfirmModal } from "@/components/confirm-modal";
import { useRole } from "@/lib/auth";
import { useToast } from "@/lib/toast";
import { recordAudit } from "@/lib/supabase";
import { IssuerPermissionsPanel } from "./issuer-permissions-panel";
import { IssuerRecoveryPanel } from "./issuer-recovery-panel";
import { IssuerRowGroup, reviewScrollOptions } from "./issuer-row";
import { recoveryPathFor } from "@/lib/issuer-recovery";
import { RequireRole } from "@/components/require-role";
import {
  getIssuerProfile,
  upsertIssuerProfile,
  type IssuerProfile,
} from "@/lib/issuer-profiles";
import { explainSendError } from "@/lib/tx-error";

/** Called once a KYB status is known from the chain for an issuer. */
type KybSettled = (
  legalId: string,
  issuerPda: Address,
  status: KybStatus,
  /** True when this page sent the decision (false: found already decided). */
  sent: boolean,
) => void;

export default function IssuersPage() {
  return (
    <section className="min-w-0 flex-1">
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
          Issuers
        </p>
        <h1 className="mt-1 text-xl font-semibold text-slate-900">
          Issuer directory
        </h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-slate-600">
          Every legal entity registered on Manci, with KYB status, asset
          count and review actions.
        </p>
      </div>
      <RequireRole role="admin">
        <IssuersOps />
      </RequireRole>
    </section>
  );
}

function IssuersOps() {
  const client = useSolanaClient();
  const [data, setData] = useState<NetworkData | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");
  // "All" stays the default even with pending issuers: pending rows are
  // listed first anyway, and the chip counts show the queue, so nothing is
  // hidden. The open review keeps its queue position while it is open
  // (filterIssuers `keep`), so a just-decided row never jumps out of view.
  const [status, setStatus] = useState<IssuerStatusFilter>("all");
  const [openReview, setOpenReview] = useState<OpenReview | null>(null);
  const selectedLegalId = openReview?.legalId ?? null;
  const [showAdd, setShowAdd] = useState(false);
  // KYB statuses seen on chain that the indexer-backed list may not show yet.
  const [overrides, setOverrides] = useState<KybOverrides>({});
  const [loadGate] = useState(createLatestGate);
  const [polls] = useState(createReconcileRegistry);
  // KYB decisions in flight, held here so a re-opened review stays locked.
  const [decisionPhases, setDecisionPhases] = useState<
    ReadonlyMap<string, KybDecisionPhase>
  >(() => new Map());
  const [decisions] = useState(() => createKybDecisionGuard(setDecisionPhases));
  const selectedGroup = useRef<HTMLTableSectionElement | null>(null);
  const scrolledFor = useRef<string | null>(null);

  /** Indexer-first load; only the most recently started one commits. */
  const load = useCallback(async (): Promise<NetworkData> => {
    const isLatest = loadGate.begin();
    const network = await loadNetworkPreferIndexer(() =>
      loadNetwork(client.runtime.rpc),
    );
    if (isLatest()) {
      setData(network);
      setOverrides((prev) => unsettledOverrides(network.issuers, prev));
    }
    return network;
  }, [client, loadGate]);

  const refresh = useCallback(async () => {
    try {
      await load();
    } catch {
      setFailed(true);
    }
  }, [load]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  // Polls stop on unmount, and one that a decision settling after the
  // unmount would start never does (the registry is closed).
  useEffect(() => {
    polls.open();
    return () => polls.close();
  }, [polls]);

  // A KYB status is known from the chain: show it on the row at once, then
  // poll the indexer-backed list (bounded) until it agrees.
  const settleKyb = useCallback<KybSettled>(
    (legalId, issuerPda, decided, sent) => {
      if (!polls.isOpen) return;
      setOverrides((prev) => ({
        ...prev,
        [legalId]: { status: decided, phase: "syncing" },
      }));
      if (!sent) void load().catch(() => undefined);
      void (async () => {
        let target = decided;
        if (sent) {
          // Re-read THIS issuer on chain (not the indexer): the decision is
          // confirmed, so a status other than Pending is the chain's truth.
          try {
            const live = await fetchMaybeIssuer(client.runtime.rpc, issuerPda, {
              commitment: "confirmed",
            });
            target = reconciledStatus(
              decided,
              live.exists ? live.data.kybStatus : null,
            );
          } catch {
            // Keep the confirmed decision; the poll below still reconciles.
          }
          if (target !== decided && polls.isOpen) {
            setOverrides((prev) => ({
              ...prev,
              [legalId]: { status: target, phase: "syncing" },
            }));
          }
        }
        polls.start(legalId, (release) =>
          startKybReconcile({
            legalId,
            status: target,
            load: async () => (await load()).issuers,
            onAgree: release,
            onGiveUp: () => {
              release();
              // The indexer never agreed: check the chain before the row
              // claims "on-chain" (a Pending chain drops the override).
              void (async () => {
                let live: KybStatus | null = null;
                try {
                  const account = await fetchMaybeIssuer(
                    client.runtime.rpc,
                    issuerPda,
                    { commitment: "confirmed" },
                  );
                  live = account.exists ? account.data.kybStatus : null;
                } catch {
                  // Unknown: the row keeps the status it read from the chain.
                }
                setOverrides((prev) => giveUpOverride(prev, legalId, live));
              })();
            },
          }),
        );
      })();
    },
    [client, load, polls],
  );

  const issuers = useMemo(
    () => (data ? applyKybOverrides(data.issuers, overrides) : []),
    [data, overrides],
  );

  const counts = useMemo(
    () => (data ? issuerStatusCounts(issuers) : null),
    [data, issuers],
  );

  const filtered = useMemo(
    () => filterIssuers(issuers, { query, status, keep: openReview }),
    [issuers, query, status, openReview],
  );

  const selectedVisible =
    selectedLegalId !== null &&
    filtered.some((i) => issuerLegalId(i) === selectedLegalId);

  // Bring the opened review into view once (not again on every refresh).
  useEffect(() => {
    if (selectedLegalId === null) {
      scrolledFor.current = null;
      return;
    }
    if (!selectedVisible || scrolledFor.current === selectedLegalId) return;
    scrolledFor.current = selectedLegalId;
    const reduceMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    selectedGroup.current?.scrollIntoView(reviewScrollOptions(reduceMotion));
  }, [selectedLegalId, selectedVisible]);

  function changeStatus(next: IssuerStatusFilter) {
    setStatus(next);
    const open = issuers.find((i) => issuerLegalId(i) === selectedLegalId);
    if (open && !matchesStatus(open, next)) setOpenReview(null);
  }

  if (failed) {
    return (
      <p className="mt-8 text-sm text-red-600">
        Failed to load issuer directory.
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
          placeholder="Search by name, wallet or jurisdiction…"
          aria-label="Search issuers"
          className="min-w-0 flex-1 basis-[280px] rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-slate-400"
        />
        <div
          role="group"
          aria-label="Filter by KYB status"
          className="flex flex-wrap gap-1 rounded-lg border border-slate-200 bg-white p-1 text-xs"
        >
          {ISSUER_STATUS_FILTERS.map((s) => {
            const queued = s === "pending" && (counts?.pending ?? 0) > 0;
            return (
              <button
                key={s}
                type="button"
                onClick={() => changeStatus(s)}
                aria-pressed={status === s}
                className={`rounded-md px-3 py-1.5 transition-colors ${
                  status === s
                    ? "bg-slate-900 text-white"
                    : queued
                      ? "font-semibold text-amber-800 hover:bg-amber-50"
                      : "text-slate-600 hover:bg-slate-100"
                }`}
              >
                {statusChipLabel(s, counts)}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          onClick={() => setShowAdd(true)}
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
        >
          + Add issuer
        </button>
      </div>

      {counts && counts.pending > 0 && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-900">
          {counts.pending === 1
            ? "1 issuer is waiting for KYB review."
            : `${counts.pending} issuers are waiting for KYB review.`}{" "}
          They are listed first — open one with <strong>Review</strong> to see
          its details and decide, or check its documents in the{" "}
          <strong>KYB dossier</strong>.
        </p>
      )}

      {/* Table */}
      {data === null ? (
        <SkeletonTable rows={5} cols={5} />
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-12 text-center shadow-card">
          <p className="text-sm text-slate-600">
            {data.issuers.length === 0
              ? "No issuers registered yet."
              : "No issuers match the current filter."}
          </p>
          {data.issuers.length === 0 && (
            <button
              type="button"
              onClick={() => setShowAdd(true)}
              className="mt-4 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
            >
              Register the first issuer
            </button>
          )}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-card">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-100 bg-slate-50 text-left text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-4 py-3 font-medium">Legal entity</th>
                <th className="hidden px-4 py-3 font-medium sm:table-cell">Jurisdiction</th>
                <th className="px-4 py-3 font-medium">KYB</th>
                <th className="hidden px-4 py-3 text-right font-medium sm:table-cell">Assets</th>
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            {filtered.map((i) => {
              const legalId = issuerLegalId(i);
              const isSelected = legalId === selectedLegalId;
              return (
                <IssuerRowGroup
                  key={legalId}
                  issuer={i}
                  legalId={legalId}
                  sync={overrides[legalId]?.phase ?? null}
                  expanded={isSelected}
                  anotherOpen={selectedLegalId !== null && !isSelected}
                  groupRef={isSelected ? selectedGroup : undefined}
                  onToggle={() =>
                    setOpenReview(
                      isSelected ? null : { legalId, pending: isPendingKyb(i) },
                    )
                  }
                >
                  {isSelected && (
                    <IssuerDetail
                      issuer={i}
                      sync={overrides[legalId]?.phase ?? null}
                      otherAuthorities={issuers
                        .filter((other) => issuerLegalId(other) !== legalId)
                        .map((other) => other.authority.toString())}
                      decision={decisionPhases.get(legalId) ?? null}
                      decisions={decisions}
                      onKybSettled={settleKyb}
                      onClose={() => setOpenReview(null)}
                    />
                  )}
                </IssuerRowGroup>
              );
            })}
          </table>
        </div>
      )}

      {/* Add modal */}
      {showAdd && (
        <RegisterIssuerModal
          onClose={() => setShowAdd(false)}
          onSuccess={(legalId) => {
            void refresh();
            // register_issuer always starts at Pending KYB.
            setOpenReview({ legalId, pending: true });
            setShowAdd(false);
          }}
        />
      )}
    </div>
  );
}

function IssuerDetail({
  issuer,
  sync,
  otherAuthorities,
  decision,
  decisions,
  onKybSettled,
  onClose,
}: {
  issuer: Issuer;
  /** Set while the row shows a chain status the indexer has not caught up to. */
  sync: KybOverride["phase"] | null;
  /** Authorities of every other issuer (a recovery key must not be one). */
  otherAuthorities: readonly string[];
  /** This issuer's KYB decision in flight, if any (it outlives this detail). */
  decision: KybDecisionPhase | null;
  decisions: KybDecisionGuard;
  onKybSettled: KybSettled;
  onClose: () => void;
}) {
  const client = useSolanaClient();
  const conn = useWalletConnection();
  const tx = useSendTransaction();
  const { isSuperAdmin } = useRole();
  const toast = useToast();
  const wallet = conn.wallet?.account.address;
  const [issuerPda, setIssuerPda] = useState<Address | null>(null);
  const [profile, setProfile] = useState<IssuerProfile | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileLoading, setProfileLoading] = useState(true);
  const [confirm, setConfirm] = useState<"verify" | "reject" | null>(null);
  // One KYB decision at a time per issuer: the page-level guard closes the
  // window before the first re-render disables the buttons (a double click
  // would send twice), and it survives this detail closing and re-opening.
  const busy = decision !== null || tx.isSending;
  const pending = isPendingKyb(issuer);
  // Onboarding-profile edit state (admin may create/fix it — SD4: the upsert
  // route authorizes platform admins, so this fills the gap where an issuer's
  // one-shot onboarding write failed).
  const [editingProfile, setEditingProfile] = useState(false);
  const [pfCompany, setPfCompany] = useState("");
  const [pfEmail, setPfEmail] = useState("");
  const [pfWebsite, setPfWebsite] = useState("");
  const [pfSaving, setPfSaving] = useState(false);
  const legalId = issuerLegalId(issuer);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const [pda] = await findIssuerPda({
        legalEntityId: issuer.legalEntityId,
      });
      if (!cancelled) setIssuerPda(pda);
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [issuer.legalEntityId]);

  // A row the indexer lists as Pending may already be decided on chain (the
  // indexer lags a decision by a few seconds, longer when it is behind). Read
  // the live record when the review opens so the row shows the truth.
  useEffect(() => {
    if (!issuerPda || !pending) return;
    let cancelled = false;
    void (async () => {
      try {
        const live = await fetchMaybeIssuer(client.runtime.rpc, issuerPda, {
          commitment: "confirmed",
        });
        if (cancelled || !live.exists || isPendingKyb(live.data)) return;
        onKybSettled(legalId, issuerPda, live.data.kybStatus, false);
      } catch {
        // Best effort: the decision itself re-reads the chain before sending.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, issuerPda, pending, legalId, onKybSettled]);

  // Off-chain onboarding profile (company / contact / website) so the reviewer
  // sees who they're verifying.
  const loadProfile = useCallback(async () => {
    if (!issuerPda) {
      setProfile(null);
      return;
    }
    setProfile(null);
    setProfileLoading(true);
    if (!conn.wallet) return;
    try {
      setProfile(await getIssuerProfile(conn.wallet, issuerPda.toString()));
      setProfileError(null);
    } catch (err) {
      setProfileError(
        err instanceof Error ? err.message : "Company profile unavailable",
      );
    } finally {
      setProfileLoading(false);
    }
  }, [issuerPda, conn.wallet]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadProfile();
  }, [loadProfile]);

  function openProfileEdit() {
    setPfCompany(profile?.company_name ?? "");
    setPfEmail(profile?.contact_email ?? "");
    setPfWebsite(profile?.website ?? "");
    setEditingProfile(true);
  }

  async function saveProfile() {
    if (!issuerPda) return;
    setPfSaving(true);
    const ok = await upsertIssuerProfile(conn.wallet, {
      issuer_pda: issuerPda.toString(),
      company_name: pfCompany.trim() || null,
      contact_email: pfEmail.trim() || null,
      website: pfWebsite.trim() || null,
    });
    setPfSaving(false);
    if (!ok) {
      toast.showError("Could not save profile", "Please try again.");
      return;
    }
    toast.show({ kind: "success", title: "Profile saved" });
    setEditingProfile(false);
    await loadProfile();
  }

  async function review(approved: boolean, reason: string) {
    if (!wallet || !conn.wallet || !issuerPda) return;
    if (!decisions.begin(legalId)) return;
    try {
      await decide(conn.wallet, issuerPda, approved, reason);
    } finally {
      decisions.end(legalId);
    }
  }

  async function decide(
    session: NonNullable<typeof conn.wallet>,
    pda: Address,
    approved: boolean,
    reason: string,
  ) {
    // Re-read the LIVE record first: the list is indexer-first and can still
    // say Pending for an issuer that is already decided on chain.
    let live: Awaited<ReturnType<typeof fetchMaybeIssuer>>;
    try {
      live = await fetchMaybeIssuer(client.runtime.rpc, pda, {
        commitment: "confirmed",
      });
    } catch (err) {
      toast.showError(
        "Could not read the issuer on chain",
        `Nothing was sent. ${explainSendError(err)}`,
      );
      return;
    }
    const check = kybDecisionPreflight(live.exists ? live.data : null);
    if (!check.ok) {
      setConfirm(null);
      if (check.status === null) {
        toast.showError("Cannot review this issuer", check.message);
        return;
      }
      toast.show({
        kind: "info",
        title: check.message,
        description: "Nothing was sent. The directory is refreshing.",
      });
      onKybSettled(legalId, pda, check.status, false);
      return;
    }

    let pendingId = toast.showPending(
      approved ? "Approving issuer KYB…" : "Rejecting issuer KYB…",
      reason,
    );
    try {
      const { signer } = createWalletTransactionSigner(session);
      const ix = await getVerifyIssuerKybInstructionAsync({
        admin: signer,
        issuer: pda,
        approved,
      });
      const sig = await tx.send({ instructions: [ix], feePayer: signer });
      const audit = {
        ix_name: "verify_issuer_kyb",
        category: "issuers",
        actor_wallet: wallet?.toString() ?? "",
        reason,
        tx_signature: sig,
      } as const;
      // Attribution first (it survives a closed tab); the outcome follows.
      void recordAudit({
        ...audit,
        target_label: `${legalId} · ${approved ? "approve" : "reject"}`,
        status: "pending",
      });
      // Sent is not landed: the row changes only once the chain confirms.
      setConfirm(null);
      decisions.confirming(legalId);
      toast.dismiss(pendingId);
      pendingId = toast.showPending("Confirming the KYB decision on chain…");
      const outcome = await waitForKybConfirmation(async () =>
        (
          await client.runtime.rpc
            .getSignatureStatuses([sig])
            .send({ abortSignal: AbortSignal.timeout(10_000) })
        ).value[0],
      );
      toast.dismiss(pendingId);
      if (outcome === "failed") {
        void recordAudit({
          ...audit,
          target_label: `${legalId} · ${approved ? "approve" : "reject"}`,
          status: "failed",
          metadata: { error: "Transaction failed on chain" },
        });
        toast.showError(
          approved ? "Failed to verify" : "Failed to reject",
          "The transaction failed on chain; the issuer is still pending.",
        );
        return;
      }
      if (outcome === "unconfirmed") {
        // The pending audit row stands: the outcome is not known.
        toast.show({
          kind: "info",
          title: "Not confirmed yet",
          description:
            "The decision was sent but the chain has not confirmed it. Re-open the review in a minute: Verify / Reject read the chain before sending again.",
        });
        // It may have landed after all: show it if the chain already has it.
        try {
          const after = await fetchMaybeIssuer(client.runtime.rpc, pda, {
            commitment: "confirmed",
          });
          if (after.exists && !isPendingKyb(after.data)) {
            onKybSettled(legalId, pda, after.data.kybStatus, false);
          }
        } catch {
          // The row stays Pending; the next decision re-reads the chain.
        }
        return;
      }
      toast.showTx(sig, {
        title: approved ? "Issuer verified" : "Issuer rejected",
      });
      void recordAudit({
        ...audit,
        target_label: `${legalId} · ${approved ? "approved" : "rejected"}`,
        status: "success",
      });
      onKybSettled(legalId, pda, decisionStatus(approved), true);
    } catch (err) {
      toast.dismiss(pendingId);
      void recordAudit({
        ix_name: "verify_issuer_kyb",
        category: "issuers",
        actor_wallet: wallet?.toString() ?? "",
        reason,
        target_label: `${legalId} · ${approved ? "approve" : "reject"}`,
        status: "failed",
        metadata: { error: explainSendError(err) },
      });
      toast.showError(
        approved ? "Failed to verify" : "Failed to reject",
        explainSendError(err),
      );
    }
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-card sm:p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            Issuer detail
          </p>
          <h3 className="mt-1 text-lg font-semibold text-slate-900">
            {legalId}
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

      {/* The KYB decision comes first: it is what a pending row is opened for. */}
      {pending && (
        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4">
          <p className="text-sm font-semibold text-amber-900">
            KYB review pending
          </p>
          <p className="mt-1 text-[13px] leading-relaxed text-amber-900">
            Check the KYB documents and AML screening in the client dossier
            before deciding.{" "}
            <Link
              href={kybDossierHref(issuer.authority.toString())}
              className="font-medium underline underline-offset-2 hover:text-amber-950"
            >
              Open the KYB dossier →
            </Link>
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            {isSuperAdmin ? (
              <>
                <button
                  type="button"
                  disabled={busy || !issuerPda || !conn.wallet}
                  onClick={() => setConfirm("verify")}
                  className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                >
                  Verify KYB
                </button>
                <button
                  type="button"
                  disabled={busy || !issuerPda || !conn.wallet}
                  onClick={() => setConfirm("reject")}
                  className="rounded-lg border border-red-300 bg-red-50 px-4 py-2 text-sm font-medium text-red-900 hover:bg-red-100 disabled:opacity-50"
                >
                  Reject KYB
                </button>
                {busy && (
                  <span className="text-xs text-amber-900" role="status">
                    {decision === "confirming" ? "Confirming…" : "Sending…"}
                  </span>
                )}
              </>
            ) : (
              <p className="text-xs text-amber-900">
                Only Super Admin can verify or reject KYB.
              </p>
            )}
          </div>
        </div>
      )}
      {!pending && sync && (
        <p
          role="status"
          className="mt-4 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[13px] text-slate-600"
        >
          KYB is {kybLabel(issuer.kybStatus).toLowerCase()} on chain.{" "}
          {sync === "syncing"
            ? "Waiting for the directory index to catch up…"
            : "The directory index has not caught up yet, so this row shows the status read from the chain."}
        </p>
      )}

      <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
        <Field label="Issuer PDA" value={issuerPda ?? "…"} mono />
        <Field
          label="Authority wallet"
          value={issuer.authority.toString()}
          mono
        />
        <Field
          label="Jurisdiction (ISO-3166)"
          value={String(issuer.jurisdiction)}
        />
        <Field
          label="KYB status"
          value={kybLabel(issuer.kybStatus)}
        />
        <Field label="Assets registered" value={String(issuer.assetsCount)} />
        <Field label="Version" value={String(issuer.version)} />
      </dl>

      <div className="mt-5 border-t border-slate-100 pt-5">
        {profileError && (
          <div role="alert" className="mb-3 text-sm text-amber-800">
            <p>{profileError}</p>
            <button
              type="button"
              onClick={() => void loadProfile()}
              className="btn-brand mt-2"
            >
              Try again
            </button>
          </div>
        )}
        {profileLoading && (
          <p className="mb-3 text-sm text-slate-500">
            Loading private profile…
          </p>
        )}
        <div className="flex items-center justify-between gap-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            Onboarding profile
          </p>
          {!editingProfile && (
            <button
              type="button"
              onClick={openProfileEdit}
              disabled={profileLoading || !!profileError}
              className="rounded-md border border-slate-300 px-2.5 py-1 text-[11px] font-medium text-slate-700 hover:border-slate-400"
            >
              {profile ? "Edit" : "Add"}
            </button>
          )}
        </div>
        {editingProfile ? (
          <div className="mt-3 space-y-2">
            <input
              value={pfCompany}
              onChange={(e) => setPfCompany(e.target.value)}
              placeholder="Company name"
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
            />
            <input
              value={pfEmail}
              onChange={(e) => setPfEmail(e.target.value)}
              placeholder="Contact email"
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
            />
            <input
              value={pfWebsite}
              onChange={(e) => setPfWebsite(e.target.value)}
              placeholder="Website (https://…)"
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
            />
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setEditingProfile(false)}
                disabled={pfSaving}
                className="rounded-md px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void saveProfile()}
                disabled={pfSaving}
                className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
              >
                {pfSaving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        ) : profile &&
          (profile.company_name || profile.contact_email || profile.website) ? (
          <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
            <Field label="Company" value={profile.company_name || "—"} />
            <Field label="Contact email" value={profile.contact_email || "—"} />
            <div className="sm:col-span-2">
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Website
              </dt>
              <dd className="mt-0.5 break-all text-sm text-slate-800">
                {profile.website ? (
                  <a
                    href={
                      /^https?:\/\//i.test(profile.website)
                        ? profile.website
                        : `https://${profile.website}`
                    }
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline decoration-slate-300 underline-offset-2 hover:text-slate-900"
                  >
                    {profile.website}
                  </a>
                ) : (
                  "—"
                )}
              </dd>
            </div>
          </dl>
        ) : (
          <p className="mt-2 text-xs text-slate-500">
            No off-chain onboarding profile on record — this issuer may have
            been registered directly (e.g. via Add issuer) without the company /
            contact details.
          </p>
        )}
      </div>

      {isSuperAdmin &&
        recoveryPathFor(issuer) === "registration" && (
          <a
            href="/issuer/recovery"
            className="mt-5 block rounded-lg border border-brand-200 bg-brand-50 p-3 text-sm font-semibold text-brand-900"
          >
            Recover this unused registration with both wallets →
          </a>
        )}
      {issuerPda && (
        <IssuerPermissionsPanel
          issuer={issuerPda}
          authority={issuer.authority}
          canEdit={isSuperAdmin}
        />
      )}
      {issuerPda && (
        <IssuerRecoveryPanel
          issuer={issuerPda}
          authority={issuer.authority}
          otherAuthorities={otherAuthorities}
          canEdit={isSuperAdmin}
        />
      )}

      <ConfirmModal
        open={confirm === "verify"}
        onClose={() => setConfirm(null)}
        onConfirm={(reason) => review(true, reason)}
        title="Verify issuer KYB"
        kind="info"
        confirmLabel="Verify"
        description={
          <>
            <p>
              Verifying KYB unlocks the issuer to create assets and share
              classes. Make sure off-chain KYB documents and AML screening have
              passed.
            </p>
            <p className="mt-2 text-xs text-slate-500">
              Reason will be recorded in the audit log.
            </p>
          </>
        }
        busy={busy}
      />
      <ConfirmModal
        open={confirm === "reject"}
        onClose={() => setConfirm(null)}
        onConfirm={(reason) => review(false, reason)}
        title="Reject issuer KYB"
        kind="destructive"
        confirmLabel="Reject"
        description={
          <>
            <p>
              Rejecting marks the KYB as failed on-chain. The issuer cannot
              proceed without re-registering.
            </p>
            <p className="mt-2 text-xs text-slate-500">
              Reason will be recorded in the audit log and shared with the
              issuer.
            </p>
          </>
        }
        busy={busy}
      />
    </div>
  );
}

function RegisterIssuerModal({
  onClose,
  onSuccess,
}: {
  onClose: () => void;
  onSuccess: (legalId: string) => void;
}) {
  const conn = useWalletConnection();
  const tx = useSendTransaction();
  const toast = useToast();
  const wallet = conn.wallet?.account.address;
  const [regId, setRegId] = useState("");
  const [jurisdiction, setJurisdiction] = useState("688");

  async function register() {
    if (!wallet || !conn.wallet || !regId.trim()) return;
    const pendingId = toast.showPending(
      `Registering ${regId.trim()}…`,
      `Jurisdiction ${jurisdiction}`,
    );
    try {
      const { signer } = createWalletTransactionSigner(conn.wallet);
      const ix = await getRegisterIssuerInstructionAsync({
        authority: signer,
        legalEntityId: toBytes32(regId.trim()),
        jurisdiction: Number(jurisdiction) || 0,
        kybDocHash: new Uint8Array(32),
      });
      const sig = await tx.send({ instructions: [ix], feePayer: signer });
      toast.dismiss(pendingId);
      toast.showTx(sig, { title: "Issuer registered" });
      onSuccess(regId.trim());
    } catch (err) {
      toast.dismiss(pendingId);
      toast.showError(
        "Failed to register issuer",
        explainSendError(err),
      );
    }
  }

  if (!wallet) {
    return (
      <div
        className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <SkeletonCard className="mx-4 max-w-md" rows={3} />
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !tx.isSending) onClose();
      }}
    >
      <div className="mx-4 w-full max-w-md overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl">
        <div className="border-b border-slate-100 px-5 py-4">
          <p className="text-sm font-semibold uppercase tracking-wide text-slate-700">
            Register issuer
          </p>
        </div>
        <div className="space-y-4 px-5 py-4">
          <p className="text-sm text-slate-600">
            The connected wallet becomes the issuer&apos;s authority. KYB still
            needs to be verified by Super Admin before the issuer can create
            assets.
          </p>
          <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            Use a dedicated issuer key, not an Admin key: the issuer authority
            signs the issuer&apos;s own operations, and keeping it separate
            lets either role be rotated or revoked without touching the other.
          </p>
          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Legal entity ID
            </span>
            <input
              value={regId}
              maxLength={32}
              onChange={(e) => setRegId(e.target.value)}
              placeholder="e.g. ACME-DOO-2026"
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              autoFocus
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Jurisdiction (ISO-3166 numeric)
            </span>
            <input
              value={jurisdiction}
              inputMode="numeric"
              onChange={(e) =>
                setJurisdiction(e.target.value.replace(/\D/g, ""))
              }
              placeholder="688"
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
            />
            <span className="mt-1 block text-[11px] text-slate-400">
              688 = Serbia · 826 = UK · 840 = USA · 784 = UAE
            </span>
          </label>
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
            onClick={() => void register()}
            disabled={tx.isSending || !regId.trim()}
            className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {tx.isSending ? "Sending…" : "Register"}
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
