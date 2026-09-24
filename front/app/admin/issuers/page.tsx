"use client";

import { type Address } from "@solana/kit";
import { createWalletTransactionSigner } from "@solana/client";
import {
  useSendTransaction,
  useSolanaClient,
  useWalletConnection,
} from "@solana/react-hooks";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  findIssuerPda,
  getRegisterIssuerInstructionAsync,
  getVerifyIssuerKybInstructionAsync,
  type Issuer,
} from "@/lib/generated/asset_registry";
import { loadNetwork, type NetworkData } from "@/lib/enumerate";
import { loadNetworkPreferIndexer } from "@/lib/indexer";
import { fromBytes32, KYB_LABEL, toBytes32 } from "@/lib/format";
import { SkeletonTable, SkeletonCard } from "@/components/skeleton";
import { ConfirmModal } from "@/components/confirm-modal";
import { useRole } from "@/lib/auth";
import { useToast } from "@/lib/toast";
import { recordAudit } from "@/lib/supabase";
import { IssuerPermissionsPanel } from "./issuer-permissions-panel";
import { IssuerRecoveryPanel } from "./issuer-recovery-panel";
import { recoveryPathFor } from "@/lib/issuer-recovery";
import { RequireRole } from "@/components/require-role";
import {
  getIssuerProfile,
  upsertIssuerProfile,
  type IssuerProfile,
} from "@/lib/issuer-profiles";
import { explainSendError } from "@/lib/tx-error";

type StatusFilter = "all" | "pending" | "verified" | "rejected" | "suspended";

const STATUS_BADGE: Record<number, string> = {
  0: "bg-amber-100 text-amber-800 border-amber-200",
  1: "bg-emerald-100 text-emerald-800 border-emerald-200",
  2: "bg-red-100 text-red-800 border-red-200",
  3: "bg-slate-100 text-slate-700 border-slate-300",
};

const STATUS_TO_FILTER: Record<number, StatusFilter> = {
  0: "pending",
  1: "verified",
  2: "rejected",
  3: "suspended",
};

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
  const [status, setStatus] = useState<StatusFilter>("all");
  const [selectedLegalId, setSelectedLegalId] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const network = await loadNetworkPreferIndexer(() =>
        loadNetwork(client.runtime.rpc),
      );
      setData(network);
    } catch {
      setFailed(true);
    }
  }, [client]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const filtered = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    return data.issuers
      .filter((i) => {
        if (status !== "all" && STATUS_TO_FILTER[i.kybStatus] !== status)
          return false;
        if (!q) return true;
        return (
          fromBytes32(i.legalEntityId).toLowerCase().includes(q) ||
          i.authority.toString().toLowerCase().includes(q) ||
          String(i.jurisdiction).includes(q)
        );
      })
      .sort((a, b) =>
        fromBytes32(a.legalEntityId).localeCompare(
          fromBytes32(b.legalEntityId),
        ),
      );
  }, [data, query, status]);

  const selected = useMemo(() => {
    if (!data || !selectedLegalId) return null;
    return (
      data.issuers.find(
        (i) => fromBytes32(i.legalEntityId) === selectedLegalId,
      ) ?? null
    );
  }, [data, selectedLegalId]);

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
          className="min-w-[280px] flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-slate-400"
        />
        <div className="flex gap-1 rounded-lg border border-slate-200 bg-white p-1 text-xs">
          {(
            ["all", "pending", "verified", "rejected", "suspended"] as const
          ).map((s) => (
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
              {s === "all" ? "All" : s.charAt(0).toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setShowAdd(true)}
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
        >
          + Add issuer
        </button>
      </div>

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
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-card">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-100 bg-slate-50 text-left text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-4 py-3 font-medium">Legal entity</th>
                <th className="px-4 py-3 font-medium">Jurisdiction</th>
                <th className="px-4 py-3 font-medium">KYB</th>
                <th className="px-4 py-3 text-right font-medium">Assets</th>
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map((i) => {
                const legalId = fromBytes32(i.legalEntityId);
                const isSelected = legalId === selectedLegalId;
                return (
                  <tr
                    key={legalId}
                    onClick={() =>
                      setSelectedLegalId(isSelected ? null : legalId)
                    }
                    className={`cursor-pointer transition-colors ${
                      isSelected ? "bg-slate-50" : "hover:bg-slate-50/60"
                    }`}
                  >
                    <td className="px-4 py-3">
                      <p className="font-medium text-slate-900">
                        {legalId || "—"}
                      </p>
                      <p
                        className="mt-0.5 font-mono text-[11px] text-slate-500"
                        title={i.authority.toString()}
                      >
                        {i.authority.toString().slice(0, 6)}…
                        {i.authority.toString().slice(-4)}
                      </p>
                    </td>
                    <td className="px-4 py-3 text-slate-700">
                      {i.jurisdiction}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
                          STATUS_BADGE[i.kybStatus] ?? STATUS_BADGE[0]
                        }`}
                      >
                        {KYB_LABEL[i.kybStatus] ?? "Unknown"}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-slate-700">
                      {String(i.assetsCount)}
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

      {/* Detail drawer */}
      {selected && (
        <IssuerDetail
          issuer={selected}
          otherAuthorities={(data?.issuers ?? [])
            .filter((i) => i !== selected)
            .map((i) => i.authority.toString())}
          onRefresh={refresh}
          onClose={() => setSelectedLegalId(null)}
        />
      )}

      {/* Add modal */}
      {showAdd && (
        <RegisterIssuerModal
          onClose={() => setShowAdd(false)}
          onSuccess={(legalId) => {
            void refresh();
            setSelectedLegalId(legalId);
            setShowAdd(false);
          }}
        />
      )}
    </div>
  );
}

function IssuerDetail({
  issuer,
  otherAuthorities,
  onRefresh,
  onClose,
}: {
  issuer: Issuer;
  /** Authorities of every other issuer (a recovery key must not be one). */
  otherAuthorities: readonly string[];
  onRefresh: () => Promise<void>;
  onClose: () => void;
}) {
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
  // Onboarding-profile edit state (admin may create/fix it — SD4: the upsert
  // route authorizes platform admins, so this fills the gap where an issuer's
  // one-shot onboarding write failed).
  const [editingProfile, setEditingProfile] = useState(false);
  const [pfCompany, setPfCompany] = useState("");
  const [pfEmail, setPfEmail] = useState("");
  const [pfWebsite, setPfWebsite] = useState("");
  const [pfSaving, setPfSaving] = useState(false);
  const legalId = fromBytes32(issuer.legalEntityId);

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
    const pendingId = toast.showPending(
      approved ? "Approving issuer KYB…" : "Rejecting issuer KYB…",
      reason,
    );
    try {
      const { signer } = createWalletTransactionSigner(conn.wallet);
      const ix = await getVerifyIssuerKybInstructionAsync({
        admin: signer,
        issuer: issuerPda,
        approved,
      });
      const sig = await tx.send({ instructions: [ix], feePayer: signer });
      toast.dismiss(pendingId);
      toast.showTx(sig, {
        title: approved ? "Issuer verified" : "Issuer rejected",
      });
      void recordAudit({
        ix_name: "verify_issuer_kyb",
        category: "issuers",
        actor_wallet: wallet?.toString() ?? "",
        reason,
        target_label: `${legalId} · ${approved ? "approved" : "rejected"}`,
        tx_signature: sig,
        status: "success",
      });
      setConfirm(null);
      await onRefresh();
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
    <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-card">
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
          value={KYB_LABEL[issuer.kybStatus] ?? "Unknown"}
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

      {issuer.kybStatus === 0 && (
        <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-slate-100 pt-5">
          {isSuperAdmin ? (
            <>
              <button
                type="button"
                disabled={tx.isSending}
                onClick={() => setConfirm("verify")}
                className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                Verify KYB
              </button>
              <button
                type="button"
                disabled={tx.isSending}
                onClick={() => setConfirm("reject")}
                className="rounded-lg border border-red-300 bg-red-50 px-4 py-2 text-sm font-medium text-red-900 hover:bg-red-100 disabled:opacity-50"
              >
                Reject KYB
              </button>
            </>
          ) : (
            <p className="text-xs text-slate-500">
              Only Super Admin can verify or reject KYB.
            </p>
          )}
        </div>
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
        busy={tx.isSending}
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
        busy={tx.isSending}
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
