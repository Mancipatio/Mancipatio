"use client";

import { WALLET_CONNECT_LABEL, WALLET_CONNECT_DESCRIPTION } from "@/lib/wallet-copy";

import Link from "next/link";
import { Fragment, use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type Address } from "@solana/kit";
import type { WalletSession } from "@solana/client";
import {
  useSendTransaction,
  useSolanaClient,
  useWalletConnection,
} from "@solana/react-hooks";
import { RequireRole } from "@/components/require-role";
import { ConfirmModal } from "@/components/confirm-modal";
import { SkeletonCard } from "@/components/skeleton";
import {
  addNote,
  adminGetClientDetail,
  getClientDocumentUrl,
  suspendClient,
  syncPassportToClient,
  updateClient,
  updateClientStatus,
  reviewRequirement,
  uploadClientDocument,
  requestRequirements,
  KYC_DOC_KINDS,
  KYC_VALIDITY_DAYS,
  type ClientDocument,
  type ClientVerificationDetails,
  adminDecideKyb,
  type ClientKycStatus,
  type ClientNote,
  type ClientRow,
  type ClientType,
  type KycRequirement,
  type KycRequirementStatus,
  type KycDocKind,
} from "@/lib/clients";
import { COUNTRIES, countryName } from "@/lib/countries";
import { useToast } from "@/lib/toast";
import { recordAudit } from "@/lib/supabase";
import { walletSigner } from "@/lib/wallet-signer";
import { explainSendError } from "@/lib/tx-error";
import {
  buildIssuePassport,
  buildRevokePassport,
  fetchPassport,
  dossierHash,
  isPassportExpired,
  issueBlockers as computeIssueBlockers,
  KycStatus,
  type KycEntry,
} from "@/lib/passport";
import { type KycRegistry } from "@/lib/generated/asset_registry";
import {
  loadKycAuthorityContext,
  passportAuthorityFor,
  type KycAuthorityContext,
} from "@/lib/kyc-authority";
import { listBlockEntries } from "@/lib/blocklist";
import { listAlerts } from "@/lib/compliance";

const TYPE_LABEL: Record<ClientType, string> = {
  issuer: "Issuer",
  investor: "Investor",
  delegate: "Delegate",
  officer: "Officer",
};

const TYPE_BADGE: Record<ClientType, string> = {
  issuer: "bg-brand-50 text-brand-700 border-brand-200",
  investor: "bg-emerald-50 text-emerald-700 border-emerald-200",
  delegate: "bg-brand-50 text-brand-700 border-brand-200",
  officer: "bg-amber-50 text-amber-700 border-amber-200",
};

const KYC_BADGE: Record<ClientKycStatus, string> = {
  pending: "bg-amber-100 text-amber-800 border-amber-200",
  verified: "bg-emerald-100 text-emerald-800 border-emerald-200",
  rejected: "bg-red-100 text-red-800 border-red-200",
  suspended: "bg-slate-300 text-slate-700 border-slate-400",
  expired: "bg-orange-100 text-orange-700 border-orange-200",
  more_info: "bg-brand-100 text-brand-800 border-brand-200",
};

const REQ_BADGE: Record<KycRequirementStatus, string> = {
  requested: "bg-amber-100 text-amber-800 border-amber-200",
  submitted: "bg-brand-100 text-brand-800 border-brand-200",
  approved: "bg-emerald-100 text-emerald-800 border-emerald-200",
  rejected: "bg-red-100 text-red-800 border-red-200",
};

/**
 * clients.jurisdiction (zero-padded ISO string) → numeric code, or null when
 * unset/unparseable. NEVER coerce to 0 — `Number(null) || 0` was exactly how
 * this page could issue a jurisdiction-0 passport that every on-chain check
 * rejects.
 */
function parseJurisdictionCode(raw: string | null | undefined): number | null {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export default function ClientDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  return (
    <section className="min-w-0 flex-1">
      <Link
        href="/admin/clients"
        className="text-xs text-slate-500 underline-offset-2 hover:underline"
      >
        ← Clients
      </Link>
      <RequireRole role="admin">
        <ClientDetail id={id} />
      </RequireRole>
    </section>
  );
}

function ClientDetail({ id }: { id: string }) {
  const conn = useWalletConnection();
  const solanaClient = useSolanaClient();
  const tx = useSendTransaction();
  const toast = useToast();
  const wallet = conn.wallet?.account.address;
  const [client, setClient] = useState<ClientRow | null | undefined>(undefined);
  const [notes, setNotes] = useState<ClientNote[]>([]);
  const [requirements, setRequirements] = useState<KycRequirement[]>([]);
  const [documents, setDocuments] = useState<ClientDocument[]>([]);
  const [verification, setVerification] = useState<ClientVerificationDetails[]>([]);
  const [kybBusy, setKybBusy] = useState(false);
  const [kybNote, setKybNote] = useState("");
  const [noteBody, setNoteBody] = useState("");
  const [confirm, setConfirm] = useState<
    null | "approve" | "reject" | "suspend"
  >(null);

  // On-chain passport state
  // Render-stable "now" for the expiry hint (same pattern as /portfolio).
  const [nowSec] = useState(() => Math.floor(Date.now() / 1000));
  const [passport, setPassport] = useState<KycEntry | null | undefined>(
    undefined,
  );
  const [passportLoading, setPassportLoading] = useState(false);
  const [passportTxBusy, setPassportTxBusy] = useState(false);

  // Edit mode
  const [editing, setEditing] = useState(false);
  const [editTypes, setEditTypes] = useState<ClientType[]>([]);
  const [editDisplayName, setEditDisplayName] = useState("");
  const [editEmail, setEditEmail] = useState("");
  const [editCompany, setEditCompany] = useState("");
  const [editJurisdiction, setEditJurisdiction] = useState("");
  const [editTier, setEditTier] = useState("");
  const [editSource, setEditSource] = useState("");
  const [editTags, setEditTags] = useState("");
  const [editSaving, setEditSaving] = useState(false);

  // Request more info / return-to-supplement modal
  const [showMoreInfo, setShowMoreInfo] = useState(false);

  // Admin upload
  const [uploadKind, setUploadKind] = useState<KycDocKind>(KYC_DOC_KINDS[0].kind);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const uploadInputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    if (!conn.wallet) return;
    try {
      const detail = await adminGetClientDetail(conn.wallet, id);
      setClient(detail.client);
      setNotes(detail.notes);
      setRequirements(detail.requirements);
      setDocuments(detail.documents);
      setVerification(detail.verification ?? []);
    } catch (err) {
      console.warn("[admin/clients] detail load failed:", err);
    }
  }, [id, conn.wallet]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  // KYC authority context (e2e §5): the passport registry is the LIVE
  // KycRegistry found on-chain — never derived from the connected wallet or
  // from Platform.admin. After admin rotation the registry stays with its
  // original provider key, so the new Super Admin must not be offered
  // Issue/Revoke against a registry PDA that does not exist, and the original
  // provider must keep the panel. `undefined` = not loaded yet.
  const [kycCtx, setKycCtx] = useState<KycAuthorityContext | null | undefined>(
    undefined,
  );
  const passportAuth = useMemo(
    () => passportAuthorityFor(wallet, kycCtx),
    [wallet, kycCtx],
  );
  const { isKycProvider, registryAddress, registryAuthority } = passportAuth;

  const refreshPassport = useCallback(
    async (clientWallet: string) => {
      if (!registryAddress) {
        setPassport(undefined);
        return;
      }
      setPassportLoading(true);
      try {
        const entry = await fetchPassport(
          solanaClient.runtime.rpc,
          registryAddress,
          clientWallet as Address,
        );
        setPassport(entry);
      } catch {
        setPassport(null);
      } finally {
        setPassportLoading(false);
      }
    },
    [registryAddress, solanaClient],
  );

  useEffect(() => {
    if (!client?.wallet) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPassport(undefined);
      return;
    }
    void refreshPassport(client.wallet);
  }, [client?.wallet, refreshPassport]);

  // Issue-gate context (SHARED gate — lib/passport.ts issueBlockers, same as
  // /admin/kyc): live registry + on-chain blocklist, loaded via plain RPC
  // (no signature prompt). Each source degrades independently to null =
  // "unknown, check skipped" — the chain still enforces both on transfer.
  // Compliance alerts are a SIGNED read and are fetched at send time instead,
  // to avoid an extra wallet popup on every page load.
  const gateRegistry: KycRegistry | null = kycCtx?.registry?.registry ?? null;
  const [gateBlocked, setGateBlocked] = useState<Set<string> | null>(null);

  const refreshGate = useCallback(async () => {
    try {
      setKycCtx(await loadKycAuthorityContext(solanaClient.runtime.rpc));
    } catch (err) {
      console.warn("[admin/clients] registry load failed:", err);
      setKycCtx(null);
    }
    try {
      const entries = await listBlockEntries(solanaClient.runtime.rpc);
      setGateBlocked(new Set(entries.map((e) => e.entry.wallet.toString())));
    } catch (err) {
      console.warn("[admin/clients] blocklist load failed:", err);
      setGateBlocked(null);
    }
  }, [solanaClient]);

  useEffect(() => {
    if (!client?.wallet) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshGate();
  }, [client?.wallet, refreshGate]);

  // Open edit mode: initialise form from current client
  function openEdit() {
    if (!client) return;
    const types =
      client.types && client.types.length > 0 ? client.types : [client.type];
    setEditTypes(types);
    setEditDisplayName(client.display_name ?? "");
    setEditEmail(client.email ?? "");
    setEditCompany(client.company_name ?? "");
    setEditJurisdiction(client.jurisdiction ?? "");
    setEditTier(client.tier ?? "starter");
    setEditSource(client.source ?? "");
    setEditTags((client.tags ?? []).join(", "));
    setEditing(true);
  }

  async function saveEdit() {
    if (!wallet || editTypes.length === 0) return;
    setEditSaving(true);
    try {
      const ok = await updateClient(conn.wallet, id, {
        display_name: editDisplayName.trim() || undefined,
        email: editEmail.trim() || undefined,
        company_name: editCompany.trim() || undefined,
        jurisdiction: editJurisdiction.trim() || undefined,
        tier: editTier.trim() || undefined,
        source: editSource.trim() || undefined,
        tags: editTags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
        types: editTypes,
      });
      if (!ok) throw new Error("Update returned false");
      toast.show({ kind: "success", title: "Client updated" });
      setEditing(false);
      await refresh();
    } catch (err) {
      toast.showError(
        "Failed to update client",
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setEditSaving(false);
    }
  }

  async function applyStatus(s: ClientKycStatus, reason: string) {
    try {
      // Reason (when given) is recorded as a kyc-event note server-side.
      await updateClientStatus(
        conn.wallet,
        id,
        s,
        s === "verified" ? "verified" : s === "rejected" ? "rejected" : undefined,
        reason || undefined,
      );
      toast.show({
        kind: "success",
        title: `Status: ${s}`,
      });
      setConfirm(null);
      await refresh();
    } catch (err) {
      toast.showError(
        "Failed to update status",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  async function applySuspend(reason: string) {
    try {
      // Reason (when given) is recorded as a system note server-side.
      await suspendClient(conn.wallet, id, reason || undefined);
      toast.show({ kind: "success", title: "Client suspended" });
      setConfirm(null);
      await refresh();
    } catch (err) {
      toast.showError(
        "Failed to suspend",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  async function postNote() {
    if (!noteBody.trim() || !wallet) return;
    try {
      await addNote(conn.wallet, id, noteBody.trim());
      setNoteBody("");
      await refresh();
    } catch (err) {
      toast.showError(
        "Failed to add note",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  async function approveReq(reqId: number) {
    if (!wallet) return;
    const { ok, recomputed } = await reviewRequirement(conn.wallet, reqId, "approved");
    if (ok) {
      toast.show({
        kind: "success",
        title: "Requirement approved",
        description:
          recomputed === "pending"
            ? "All requirements cleared — client moved back to pending for final review."
            : undefined,
      });
      await refresh();
    } else {
      toast.showError("Failed", "Could not update requirement");
    }
  }

  async function rejectReq(reqId: number) {
    if (!wallet) return;
    const { ok } = await reviewRequirement(conn.wallet, reqId, "rejected");
    if (ok) {
      toast.show({ kind: "success", title: "Requirement rejected" });
      await refresh();
    } else {
      toast.showError("Failed", "Could not update requirement");
    }
  }

  async function handleAdHocUpload() {
    if (!wallet || !uploadFile) return;
    setUploading(true);
    try {
      const { ok } = await uploadClientDocument(
        conn.wallet,
        id,
        uploadFile,
        uploadKind,
      );
      if (!ok) throw new Error("Upload returned false");
      toast.show({ kind: "success", title: "Document uploaded" });
      setUploadFile(null);
      if (uploadInputRef.current) uploadInputRef.current.value = "";
      await refresh();
    } catch (err) {
      toast.showError(
        "Upload failed",
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setUploading(false);
    }
  }

  async function handleRequirementUpload(
    req: KycRequirement,
    file: File,
  ) {
    if (!wallet) return;
    const { ok, recomputed } = await uploadClientDocument(
      conn.wallet,
      id,
      file,
      req.doc_kind,
      req.id,
    );
    if (ok) {
      toast.show({
        kind: "success",
        title: "Uploaded & requirement set to submitted",
        description:
          recomputed === "pending"
            ? "All requirements cleared — client moved back to pending for final review."
            : undefined,
      });
      await refresh();
    } else {
      toast.showError("Upload failed", "Could not upload document");
    }
  }

  async function issuePassport() {
    if (!wallet || !conn.wallet || !client?.wallet) {
      toast.showError(
        WALLET_CONNECT_LABEL, WALLET_CONNECT_DESCRIPTION,
      );
      return;
    }
    // Only the live registry authority can sign approve_holder; the Super
    // Admin role does not imply it (registry.authority is enforced on-chain).
    if (!isKycProvider || !registryAuthority) {
      toast.showError(
        "Not the KYC provider",
        registryAuthority
          ? `Only the registry authority ${registryAuthority} can issue passports.`
          : "No live KYC registry found — create it on /admin/kyc first.",
      );
      return;
    }
    setPassportTxBusy(true);
    let pendingId: number | null = null;
    try {
      // ── SHARED issue gate (lib/passport.ts) — the authoritative send-time
      // stop; this page must run the exact same checks as /admin/kyc.
      // Alerts are a signed read, fetched here (deliberate action) instead of
      // on page load; a failed load degrades to "unknown" like /admin/kyc.
      let hasOpenAlert: boolean | null = null;
      try {
        const alerts = await listAlerts(conn.wallet);
        hasOpenAlert = alerts.some(
          (a) => a.status === "open" && a.wallet === client.wallet,
        );
      } catch (err) {
        console.warn("[admin/clients] compliance alerts load failed:", err);
      }
      const jurisdictionCode = parseJurisdictionCode(client.jurisdiction);
      const blockers = computeIssueBlockers({
        client,
        jurisdiction: jurisdictionCode,
        registry: gateRegistry,
        walletBlocked: gateBlocked ? gateBlocked.has(client.wallet) : null,
        hasOpenAlert,
      });
      if (blockers.length > 0 || jurisdictionCode == null) {
        toast.showError(
          "Cannot issue passport",
          blockers[0] ?? "No jurisdiction on record.",
        );
        return;
      }
      pendingId = toast.showPending("Issuing on-chain passport…");
      const signer = walletSigner(conn.wallet);
      const tierMap: Record<string, number> = {
        starter: 0,
        pro: 1,
        enterprise: 2,
      };
      const accreditationLevel = tierMap[client.tier ?? "starter"] ?? 0;
      // On-chain expiry mirrors the off-chain verdict's kyc_expires_at (set at
      // verification). A PAST stored expiry is caught by the gate above, so
      // the policy-window fallback only covers legacy verified rows with no
      // stored date (approve_holder requires expiry > now).
      const nowSec = Math.floor(Date.now() / 1000);
      const storedExpirySec = client.kyc_expires_at
        ? Math.floor(new Date(client.kyc_expires_at).getTime() / 1000)
        : 0;
      const expirySec =
        storedExpirySec > nowSec
          ? storedExpirySec
          : nowSec + KYC_VALIDITY_DAYS * 24 * 3600;
      const expiry = BigInt(expirySec);
      const providerId = 0;
      const externalRefHash = await dossierHash(
        `${client.id}:${client.kyc_verified_at ?? ""}`,
      );
      const ix = await buildIssuePassport({
        authoritySigner: signer,
        registryAuthority,
        holder: client.wallet as Address,
        jurisdiction: jurisdictionCode,
        accreditationLevel,
        expiry,
        providerId,
        externalRefHash,
      });
      const sig = await tx.send({ instructions: [ix], feePayer: signer });
      toast.dismiss(pendingId);
      pendingId = null;
      toast.showTx(sig, { title: "On-chain passport issued" });
      const actor_wallet = wallet.toString();
      void recordAudit({
        ix_name: "approve_holder",
        category: "issuers",
        actor_wallet,
        reason: "Issue on-chain passport",
        target_label: client.display_name,
        tx_signature: sig,
      });
      // Mirror the outcome into the dossier: kyc_provider='manual',
      // kyc_provider_ref=tx signature, kyc_expires_at=on-chain expiry
      // (+ kyc-event note + approval email server-side). A failed write-back
      // MUST be loud — silence leaves the dossier diverged from the chain.
      const syncOk = await syncPassportToClient(
        conn.wallet,
        id,
        "issued",
        sig,
        new Date(expirySec * 1000).toISOString(),
      );
      if (!syncOk) {
        toast.show({
          kind: "error",
          title: "Passport issued on-chain but the dossier sync FAILED",
          description:
            "The client record is missing kyc_provider_ref / kyc_expires_at and no approval email was sent. Reconcile manually against this transaction.",
          signature: sig,
          duration: 0,
        });
        void recordAudit({
          ix_name: "passport_sync_failed",
          category: "issuers",
          actor_wallet,
          reason:
            "Off-chain write-back after approve_holder failed (dossier not updated)",
          target_label: client.display_name,
          tx_signature: sig,
          status: "failed",
        });
      }
      await refreshPassport(client.wallet);
      await refresh();
    } catch (err) {
      if (pendingId != null) toast.dismiss(pendingId);
      const msg = explainSendError(err);
      if (/AccountNotFound|not found|does not exist/i.test(msg)) {
        toast.showError(
          "Registry not found",
          "Create the platform KYC registry first.",
        );
      } else {
        toast.showError("Failed to issue passport", msg);
      }
    } finally {
      setPassportTxBusy(false);
    }
  }

  async function revokePassport() {
    if (!wallet || !conn.wallet || !client?.wallet) {
      toast.showError(
        WALLET_CONNECT_LABEL, WALLET_CONNECT_DESCRIPTION,
      );
      return;
    }
    if (!isKycProvider || !registryAuthority) {
      toast.showError(
        "Not the KYC provider",
        registryAuthority
          ? `Only the registry authority ${registryAuthority} can revoke passports.`
          : "No live KYC registry found.",
      );
      return;
    }
    setPassportTxBusy(true);
    const pendingId = toast.showPending("Revoking on-chain passport…");
    try {
      const signer = walletSigner(conn.wallet);
      const ix = await buildRevokePassport({
        authoritySigner: signer,
        registryAuthority,
        holder: client.wallet as Address,
      });
      const sig = await tx.send({ instructions: [ix], feePayer: signer });
      toast.dismiss(pendingId);
      toast.showTx(sig, { title: "On-chain passport revoked" });
      const actor_wallet = wallet.toString();
      void recordAudit({
        ix_name: "revoke_holder",
        category: "issuers",
        actor_wallet,
        reason: "Revoke on-chain passport",
        target_label: client.display_name,
        tx_signature: sig,
      });
      // Mirror the revocation into the dossier: kyc_status='suspended' +
      // kyc-event note + notification email server-side. A revoked passport
      // is an operator action against a verified client (suspension), not a
      // failed application ('rejected'). A failed write-back MUST be loud —
      // otherwise the dossier still reads "verified" while the chain says
      // revoked.
      const syncOk = await syncPassportToClient(conn.wallet, id, "revoked", sig);
      if (!syncOk) {
        toast.show({
          kind: "error",
          title: "Passport revoked on-chain but the dossier sync FAILED",
          description:
            "The client is NOT marked suspended off-chain — dossier-gated flows still see them as verified. Suspend manually and reconcile against this transaction.",
          signature: sig,
          duration: 0,
        });
        void recordAudit({
          ix_name: "passport_sync_failed",
          category: "issuers",
          actor_wallet,
          reason:
            "Off-chain write-back after revoke_holder failed (client not suspended)",
          target_label: client.display_name,
          tx_signature: sig,
          status: "failed",
        });
      }
      await refreshPassport(client.wallet);
      await refresh();
    } catch (err) {
      toast.dismiss(pendingId);
      toast.showError("Failed to revoke passport", explainSendError(err));
    } finally {
      setPassportTxBusy(false);
    }
  }

  if (client === undefined) {
    return (
      <div className="mt-4">
        <SkeletonCard rows={6} />
      </div>
    );
  }

  if (client === null) {
    return (
      <div className="mt-4">
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
          Client
        </p>
        <h1 className="mt-1 text-xl font-semibold text-slate-900">
          Not found
        </h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-slate-600">
          No client with this ID. Maybe it was deleted.
        </p>
      </div>
    );
  }

  const clientTypes =
    client.types && client.types.length > 0 ? client.types : [client.type];

  // UI hint for the Issue button — same SHARED gate as /admin/kyc. Alerts are
  // a signed read checked at send time, so they are "unknown" (null) here.
  // nowSec keeps the render pure (no Date.now() during render).
  const uiIssueBlockers =
    isKycProvider && client.wallet
      ? computeIssueBlockers({
          client,
          jurisdiction: parseJurisdictionCode(client.jurisdiction),
          registry: gateRegistry,
          walletBlocked: gateBlocked ? gateBlocked.has(client.wallet) : null,
          hasOpenAlert: null,
          nowMs: nowSec * 1000,
        })
      : [];

  return (
    <div className="mt-4">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-1.5">
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
              Client
            </p>
            {clientTypes.map((t) => (
              <span
                key={t}
                className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold ${TYPE_BADGE[t]}`}
              >
                {TYPE_LABEL[t]}
              </span>
            ))}
          </div>
          <h1 className="mt-1 text-xl font-semibold text-slate-900">
            {client.display_name || "(unnamed)"}
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            {client.email ?? "no email"} ·{" "}
            {client.company_name ?? "—"} ·{" "}
            {countryName(client.jurisdiction)}
          </p>
        </div>
        <span
          className={`shrink-0 rounded-full border px-3 py-1 text-xs font-semibold ${KYC_BADGE[client.kyc_status]}`}
        >
          KYC: {client.kyc_status}
        </span>
      </div>

      {/* Compliance Actions */}
      <section className="mt-8 rounded-xl border border-slate-200 bg-white p-6 shadow-card">
        <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
          Compliance actions
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          {(client.kyc_status === "pending" ||
            client.kyc_status === "more_info" ||
            client.kyc_status === "expired" ||
            client.kyc_status === "rejected") && (
            <>
              <button
                type="button"
                onClick={() => setConfirm("approve")}
                className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700"
              >
                {client.kyc_status === "expired" ||
                client.kyc_status === "rejected"
                  ? "Re-verify KYC"
                  : "Approve KYC"}
              </button>
              {client.kyc_status !== "rejected" && (
                <button
                  type="button"
                  onClick={() => setConfirm("reject")}
                  className="rounded-lg border border-red-300 bg-red-50 px-4 py-2 text-sm font-medium text-red-900 hover:bg-red-100"
                >
                  Reject
                </button>
              )}
            </>
          )}
          {client.kyc_status !== "suspended" && (
            <>
              <button
                type="button"
                onClick={() => setConfirm("suspend")}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:border-slate-400"
              >
                Suspend
              </button>
              <button
                type="button"
                onClick={() => setShowMoreInfo(true)}
                className="rounded-lg border border-brand-300 bg-brand-50 px-4 py-2 text-sm font-medium text-brand-900 hover:bg-brand-100"
              >
                Request more info
              </button>
            </>
          )}
          {client.kyc_status === "verified" && (
            <>
              <button
                type="button"
                onClick={() => setShowMoreInfo(true)}
                className="rounded-lg border border-orange-300 bg-orange-50 px-4 py-2 text-sm font-medium text-orange-900 hover:bg-orange-100"
              >
                Return to supplement
              </button>
              <span className="self-center text-xs text-slate-500">
                Verified on{" "}
                {client.kyc_verified_at
                  ? new Date(client.kyc_verified_at).toISOString().slice(0, 10)
                  : "—"}
              </span>
            </>
          )}
        </div>

        {/* Terms of Service acceptance */}
        <div className="mt-4 flex items-center gap-2 border-t border-slate-100 pt-4 text-sm">
          <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Terms of Service
          </span>
          {client.tos_accepted_at ? (
            <span className="text-slate-700">
              ToS v{client.tos_version ?? "?"} accepted{" "}
              {new Date(client.tos_accepted_at).toISOString().slice(0, 10)}
            </span>
          ) : (
            <span className="inline-flex rounded-full border border-amber-200 bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800">
              Not accepted
            </span>
          )}
        </div>
      </section>

      {/* On-chain passport — status is visible to every admin; Issue/Revoke
          only for the KYC provider (live registry authority), which is a
          separate role from the Super Admin. */}
        <section className="mt-6 rounded-xl border border-brand-200 bg-brand-50 p-6 shadow-card">
          <p className="text-xs font-semibold uppercase tracking-wider text-brand-700">
            On-chain passport
          </p>
          {kycCtx === null && (
            <p className="mt-2 text-xs text-amber-700">
              Could not load the KYC registry — passport status unknown.
            </p>
          )}
          {kycCtx?.ambiguous && (
            <p className="mt-2 text-xs text-red-600">
              {kycCtx.registries.length} KYC registries exist and none belongs
              to the platform admin — resolve the KYC authority on /admin/kyc
              before issuing passports.
            </p>
          )}
          {kycCtx && !kycCtx.registry && !kycCtx.ambiguous && (
            <p className="mt-2 text-xs text-amber-700">
              No KYC registry on-chain yet — create it on /admin/kyc first.
            </p>
          )}
          {registryAuthority && !isKycProvider && (
            <p className="mt-2 text-xs text-slate-600">
              Only the KYC provider (registry authority{" "}
              <span className="font-mono">{registryAuthority.toString()}</span>)
              can issue or revoke this passport
              {passportAuth.isPlatformAdmin
                ? " — the Super Admin role does not include it."
                : "."}
            </p>
          )}

          {/* Status display */}
          <div className="mt-4">
            {!client.wallet ? (
              <p className="text-sm text-slate-500">
                No wallet connected — cannot issue a passport.
              </p>
            ) : passportLoading ? (
              <p className="text-sm text-slate-400">Loading passport status…</p>
            ) : passport === undefined ? (
              <p className="text-sm text-slate-400">—</p>
            ) : passport === null ? (
              <span className="inline-flex rounded-full border border-slate-300 bg-white px-3 py-1 text-xs font-semibold text-slate-600">
                No passport on-chain
              </span>
            ) : passport.status === KycStatus.Approved ? (
              <div className="flex flex-wrap items-center gap-3">
                {/* Chain semantics: the account keeps status Approved after
                    expiry — the hook only honours expiry > now (0 = always
                    expired), so surface staleness explicitly. */}
                {isPassportExpired(passport.expiry, nowSec) ? (
                  <span className="inline-flex rounded-full border border-orange-300 bg-orange-100 px-3 py-1 text-xs font-semibold text-orange-800">
                    Approved — expired
                  </span>
                ) : (
                  <span className="inline-flex rounded-full border border-emerald-300 bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-800">
                    Approved
                  </span>
                )}
                <span className="text-xs text-slate-600">
                  Tier {passport.accreditationLevel} ·{" "}
                  {countryName(String(passport.jurisdiction).padStart(3, "0"))}{" "}
                  · expires{" "}
                  {new Date(Number(passport.expiry) * 1000)
                    .toISOString()
                    .slice(0, 10)}
                </span>
              </div>
            ) : passport.status === KycStatus.Revoked ? (
              <span className="inline-flex rounded-full border border-red-300 bg-red-100 px-3 py-1 text-xs font-semibold text-red-800">
                Revoked
              </span>
            ) : passport.status === KycStatus.Expired ? (
              <span className="inline-flex rounded-full border border-orange-300 bg-orange-100 px-3 py-1 text-xs font-semibold text-orange-800">
                Expired
              </span>
            ) : (
              <span className="inline-flex rounded-full border border-amber-300 bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-800">
                Pending
              </span>
            )}
          </div>

          {/* Actions — KYC provider only */}
          {client.wallet && isKycProvider && (
            <div className="mt-4 flex flex-wrap gap-2">
              {/* Issue — enabled when kyc_status is verified AND not already
                  Approved AND the shared issue gate has no blockers */}
              {client.kyc_status === "verified" &&
                passport !== undefined &&
                passport?.status !== KycStatus.Approved && (
                  <>
                    <button
                      type="button"
                      disabled={
                        passportTxBusy ||
                        tx.isSending ||
                        uiIssueBlockers.length > 0
                      }
                      title={uiIssueBlockers[0]}
                      onClick={() => void issuePassport()}
                      className="rounded-lg bg-brand-700 px-4 py-2 text-sm font-medium text-white hover:bg-brand-800 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {passportTxBusy ? "Issuing…" : "Issue passport"}
                    </button>
                    {uiIssueBlockers.length > 0 && (
                      <p className="w-full self-center text-xs leading-snug text-amber-700">
                        {uiIssueBlockers[0]}
                      </p>
                    )}
                  </>
                )}

              {/* Revoke — shown when on-chain status is Approved */}
              {passport?.status === KycStatus.Approved && (
                <button
                  type="button"
                  disabled={passportTxBusy || tx.isSending}
                  onClick={() => void revokePassport()}
                  className="rounded-lg border border-red-300 bg-red-50 px-4 py-2 text-sm font-medium text-red-900 hover:bg-red-100 disabled:opacity-50"
                >
                  {passportTxBusy ? "Revoking…" : "Revoke passport"}
                </button>
              )}

              {client.kyc_status !== "verified" && (
                <p className="self-center text-xs text-slate-500">
                  KYC must be verified before issuing a passport.
                </p>
              )}
            </div>
          )}
        </section>

      {/* Identity */}
      <section className="mt-6 rounded-xl border border-slate-200 bg-white p-6 shadow-card">
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            Identity
          </p>
          {!editing && (
            <button
              type="button"
              onClick={openEdit}
              className="rounded-md border border-slate-200 px-3 py-1 text-xs font-medium text-slate-600 hover:border-slate-300 hover:bg-slate-50"
            >
              Edit
            </button>
          )}
        </div>

        {editing ? (
          <div className="mt-4 space-y-4">
            {/* Types multi-toggle */}
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Types (at least one)
              </span>
              <div className="mt-2 flex flex-wrap gap-2">
                {(["investor", "issuer", "delegate", "officer"] as ClientType[]).map(
                  (t) => {
                    const active = editTypes.includes(t);
                    return (
                      <button
                        key={t}
                        type="button"
                        onClick={() =>
                          setEditTypes((prev) =>
                            prev.includes(t)
                              ? prev.length > 1
                                ? prev.filter((x) => x !== t)
                                : prev
                              : [...prev, t],
                          )
                        }
                        aria-pressed={active}
                        className={`rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                          active
                            ? "border-slate-900 bg-slate-900 text-white"
                            : "border-slate-200 bg-white text-slate-700 hover:border-slate-300"
                        }`}
                      >
                        {TYPE_LABEL[t]}
                      </button>
                    );
                  },
                )}
              </div>
            </label>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                  Display name
                </span>
                <input
                  value={editDisplayName}
                  onChange={(e) => setEditDisplayName(e.target.value)}
                  className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
                />
              </label>
              <label className="block">
                <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                  Email
                </span>
                <input
                  type="email"
                  value={editEmail}
                  onChange={(e) => setEditEmail(e.target.value)}
                  className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
                />
              </label>
              <label className="block sm:col-span-2">
                <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                  Company name
                </span>
                <input
                  value={editCompany}
                  onChange={(e) => setEditCompany(e.target.value)}
                  className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
                />
              </label>
              <label className="block">
                <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                  Jurisdiction (country)
                </span>
                <select
                  value={editJurisdiction}
                  onChange={(e) => setEditJurisdiction(e.target.value)}
                  className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
                >
                  <option value="">— unset —</option>
                  {COUNTRIES.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                  Tier
                </span>
                <select
                  value={editTier}
                  onChange={(e) => setEditTier(e.target.value)}
                  className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
                >
                  <option value="starter">Starter</option>
                  <option value="pro">Pro</option>
                  <option value="enterprise">Enterprise</option>
                </select>
              </label>
              <label className="block">
                <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                  Source
                </span>
                <input
                  value={editSource}
                  onChange={(e) => setEditSource(e.target.value)}
                  className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
                />
              </label>
              <label className="block">
                <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                  Tags (comma-separated)
                </span>
                <input
                  value={editTags}
                  onChange={(e) => setEditTags(e.target.value)}
                  placeholder="vip, high-risk, manual"
                  className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
                />
              </label>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                disabled={editSaving}
                onClick={() => setEditing(false)}
                className="rounded-md px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={editSaving || editTypes.length === 0 || !wallet}
                onClick={() => void saveEdit()}
                className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
              >
                {editSaving ? "Saving…" : "Save changes"}
              </button>
            </div>
          </div>
        ) : (
          <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Types
              </dt>
              <dd className="mt-0.5 flex flex-wrap gap-1">
                {clientTypes.map((t) => (
                  <span
                    key={t}
                    className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${TYPE_BADGE[t]}`}
                  >
                    {TYPE_LABEL[t]}
                  </span>
                ))}
              </dd>
            </div>
            <Field label="Tier" value={client.tier ?? "—"} />
            <Field label="Source" value={client.source ?? "—"} />
            <Field
              label="Jurisdiction"
              value={countryName(client.jurisdiction)}
            />
            <Field
              label="Wallet"
              value={client.wallet ?? "(not yet connected)"}
              mono
            />
            <Field
              label="Issuer PDA"
              value={client.issuer_pda ?? "—"}
              mono
            />
            <Field
              label="Onboarding"
              value={client.onboarding_status}
            />
            <Field
              label="Created"
              value={new Date(client.created_at)
                .toISOString()
                .slice(0, 16)
                .replace("T", " ")}
            />
            <Field
              label="Tags"
              value={
                client.tags.length === 0
                  ? "—"
                  : client.tags.map((t) => `#${t}`).join("  ")
              }
            />
          </dl>
        )}
      </section>

      {/* Self-service verification details (/verify) */}
      {verification.length > 0 && (
        <section className="mt-6 rounded-xl border border-slate-200 bg-white p-6 shadow-card">
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            Submitted verification details
          </p>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            {verification.map((v) => {
              const pad = (n: number | null) => (n == null ? null : String(n).padStart(3, "0"));
              const rows: [string, string | null][] = v.kind === "kyb"
                ? [["Company", v.company_name], ["Registration no.", v.company_reg_number], ["Country", countryName(pad(v.company_country))],
                   ["Registered address", v.company_address], ["Website", v.company_website], ["Representative", `${v.legal_name}${v.representative_role ? ` · ${v.representative_role}` : ""}`],
                   ["Representative residence", countryName(pad(v.residence_country))], ["Representative address", `${v.address_line}, ${v.postal_code} ${v.city}`],
                   ["Email", v.email], ["Phone", v.phone]]
                : [["Legal name", v.legal_name], ["Date of birth", v.date_of_birth], ["Nationality", countryName(pad(v.nationality))],
                   ["Residence", countryName(pad(v.residence_country))], ["Address", `${v.address_line}, ${v.postal_code} ${v.city}`],
                   ["Email", v.email], ["Phone", v.phone]];
              return (
                <div key={v.kind} className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
                  <p className="text-sm font-semibold text-slate-900">
                    {v.kind === "kyb" ? "Company (KYB)" : "Individual (KYC)"}
                    <span className="ml-2 text-xs font-normal text-slate-500">
                      submitted {new Date(v.submitted_at).toLocaleString("en-GB")}
                    </span>
                  </p>
                  <dl className="mt-2 grid grid-cols-[150px_1fr] gap-x-3 gap-y-1 text-sm">
                    {rows.filter(([, value]) => value).map(([label, value]) => (
                      <Fragment key={label}><dt className="text-slate-500">{label}</dt><dd className="break-words text-slate-800">{value}</dd></Fragment>
                    ))}
                  </dl>
                  <p className="mt-2 break-all font-mono text-[11px] text-slate-400">by {v.submitted_by_wallet}</p>
                  {v.kind === "kyb" && (
                    <div className="mt-3 border-t border-slate-200 pt-3">
                      <p className="text-sm">
                        KYB decision:{" "}
                        <span className={`font-semibold ${v.status === "verified" ? "text-emerald-700" : v.status === "rejected" ? "text-red-700" : "text-amber-700"}`}>
                          {v.status === "verified" ? "Approved" : v.status === "rejected" ? "Rejected" : "Pending review"}
                        </span>
                        {v.reviewed_at && <span className="ml-2 text-xs text-slate-500">{new Date(v.reviewed_at).toLocaleString("en-GB")}</span>}
                      </p>
                      {v.review_note && <p className="mt-1 text-xs text-slate-600">{v.review_note}</p>}
                      <p className="mt-1 text-xs text-slate-500">Approving KYB lets this wallet submit raise applications. Review the company documents first.</p>
                      <input value={kybNote} onChange={(e) => setKybNote(e.target.value)} maxLength={1000} placeholder="Note / reason (optional, saved to the dossier)"
                        className="mt-2 w-full rounded-md border border-slate-300 px-2 py-1 text-xs" aria-label="KYB decision note" />
                      <div className="mt-2 flex flex-wrap gap-2">
                        {v.status !== "verified" && <button type="button" disabled={kybBusy} className="rounded-md bg-emerald-600 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                          onClick={async () => { setKybBusy(true); try { await adminDecideKyb(conn.wallet, id, "verified", kybNote.trim() || undefined); setKybNote(""); toast.show({ kind: "success", title: "KYB approved" }); await refresh(); } catch (e) { toast.show({ kind: "error", title: e instanceof Error ? e.message : "Could not approve KYB" }); } finally { setKybBusy(false); } }}>Approve KYB</button>}
                        {v.status !== "rejected" && <button type="button" disabled={kybBusy} className="rounded-md border border-red-300 bg-red-50 px-3 py-1 text-xs font-medium text-red-800 hover:bg-red-100 disabled:opacity-50"
                          onClick={async () => { setKybBusy(true); try { await adminDecideKyb(conn.wallet, id, "rejected", kybNote.trim() || undefined); setKybNote(""); toast.show({ kind: "success", title: "KYB rejected" }); await refresh(); } catch (e) { toast.show({ kind: "error", title: e instanceof Error ? e.message : "Could not reject KYB" }); } finally { setKybBusy(false); } }}>Reject KYB</button>}
                        {v.status !== "pending" && <button type="button" disabled={kybBusy} className="rounded-md border border-slate-300 px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                          onClick={async () => { setKybBusy(true); try { await adminDecideKyb(conn.wallet, id, "pending"); toast.show({ kind: "success", title: "KYB reopened" }); await refresh(); } catch (e) { toast.show({ kind: "error", title: e instanceof Error ? e.message : "Could not reopen KYB" }); } finally { setKybBusy(false); } }}>Reopen</button>}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* KYC Documents & Requirements */}
      <section className="mt-6 rounded-xl border border-slate-200 bg-white p-6 shadow-card">
        <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
          KYC documents &amp; requirements
        </p>

        {/* Requirements list */}
        {requirements.length === 0 ? (
          <p className="mt-4 text-sm text-slate-500">
            No requirements requested yet. Use &quot;Request more info&quot; above to
            request documents from the client.
          </p>
        ) : (
          <ul className="mt-4 space-y-3">
            {requirements.map((req) => {
              const linkedDoc = req.document_id
                ? documents.find((d) => d.id === req.document_id)
                : null;
              return (
                <li
                  key={req.id}
                  className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-800">
                        {req.label}
                      </p>
                      <p className="mt-0.5 text-[11px] text-slate-500">
                        {req.doc_kind}
                        {req.note && (
                          <> · <span className="italic">{req.note}</span></>
                        )}
                      </p>
                    </div>
                    <span
                      className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${REQ_BADGE[req.status]}`}
                    >
                      {req.status}
                    </span>
                  </div>

                  {/* Linked document download — signed URL via admin route */}
                  {linkedDoc && (
                    <DocLink
                      session={conn.wallet}
                      documentId={linkedDoc.id}
                      label="Download attached document ↗"
                      className="mt-2 inline-flex items-center gap-1 text-xs text-brand-700 underline-offset-2 hover:underline"
                    />
                  )}

                  {/* Admin actions */}
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {req.status === "submitted" && wallet && (
                      <>
                        <button
                          type="button"
                          onClick={() => void approveReq(req.id)}
                          className="rounded-md bg-emerald-600 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-700"
                        >
                          Approve
                        </button>
                        <button
                          type="button"
                          onClick={() => void rejectReq(req.id)}
                          className="rounded-md border border-red-300 bg-red-50 px-3 py-1 text-xs font-medium text-red-800 hover:bg-red-100"
                        >
                          Reject
                        </button>
                      </>
                    )}
                    {/* Per-requirement upload (only for requested status) */}
                    {req.status === "requested" && wallet && (
                      <label className="flex cursor-pointer items-center gap-1.5 text-xs text-slate-600">
                        <span className="rounded-md border border-slate-300 bg-white px-2 py-1 hover:bg-slate-50">
                          Upload for this requirement
                        </span>
                        <input
                          type="file"
                          className="sr-only"
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (f) void handleRequirementUpload(req, f);
                            e.target.value = "";
                          }}
                        />
                      </label>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {/* Uploaded documents list */}
        {documents.length > 0 && (
          <div className="mt-6">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
              All uploaded documents ({documents.length})
            </p>
            <ul className="mt-2 space-y-1.5">
              {documents.map((doc) => {
                return (
                  <li
                    key={doc.id}
                    className="flex flex-wrap items-center gap-3 rounded-md border border-slate-200 bg-white px-3 py-2 text-xs"
                  >
                    <span className="font-medium text-slate-700">
                      {doc.kind}
                    </span>
                    <span className="text-slate-400">·</span>
                    <span className="font-mono text-slate-500">
                      by {doc.uploaded_by.slice(0, 6)}…
                      {doc.uploaded_by.slice(-4)}
                    </span>
                    {doc.size_bytes != null && (
                      <>
                        <span className="text-slate-400">·</span>
                        <span className="text-slate-500">
                          {(doc.size_bytes / 1024).toFixed(1)} KB
                        </span>
                      </>
                    )}
                    <DocLink
                      session={conn.wallet}
                      documentId={doc.id}
                      label="Download ↗"
                      className="ml-auto text-brand-700 underline-offset-2 hover:underline"
                    />
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {/* Ad-hoc admin upload */}
        {wallet && (
          <div className="mt-6 rounded-lg border border-dashed border-slate-300 p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Admin: upload document
            </p>
            <div className="mt-3 flex flex-wrap items-end gap-3">
              <label className="block">
                <span className="text-[11px] uppercase tracking-wide text-slate-500">
                  Document type
                </span>
                <select
                  value={uploadKind}
                  onChange={(e) => setUploadKind(e.target.value as KycDocKind)}
                  className="mt-1 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
                >
                  {KYC_DOC_KINDS.map((k) => (
                    <option key={k.kind} value={k.kind}>
                      {k.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block flex-1">
                <span className="text-[11px] uppercase tracking-wide text-slate-500">
                  File
                </span>
                <input
                  ref={uploadInputRef}
                  type="file"
                  onChange={(e) => setUploadFile(e.target.files?.[0] ?? null)}
                  className="mt-1 block w-full text-sm text-slate-600 file:mr-3 file:cursor-pointer file:rounded-md file:border file:border-slate-300 file:bg-white file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-slate-700 hover:file:border-slate-400"
                />
              </label>
              <button
                type="button"
                disabled={!uploadFile || uploading}
                onClick={() => void handleAdHocUpload()}
                className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
              >
                {uploading ? "Uploading…" : "Upload"}
              </button>
            </div>
          </div>
        )}
      </section>

      {/* Notes */}
      <section className="mt-6 rounded-xl border border-slate-200 bg-white p-6 shadow-card">
        <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
          Internal notes ({notes.length})
        </p>
        <div className="mt-4 flex gap-2">
          <input
            value={noteBody}
            onChange={(e) => setNoteBody(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && noteBody.trim()) {
                void postNote();
              }
            }}
            placeholder="Add a private note (Enter to post)…"
            className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
          />
          <button
            type="button"
            disabled={!noteBody.trim() || !wallet}
            onClick={() => void postNote()}
            className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            Post
          </button>
        </div>
        {notes.length === 0 ? (
          <p className="mt-4 text-sm text-slate-500">
            No notes yet — the first post starts the internal timeline.
          </p>
        ) : (
          <ul className="mt-4 space-y-3">
            {notes.map((n) => (
              <li
                key={n.id}
                className={`rounded-lg border px-3 py-2 ${
                  n.kind === "kyc-event"
                    ? "border-emerald-200 bg-emerald-50"
                    : n.kind === "system"
                      ? "border-slate-200 bg-slate-50"
                      : "border-slate-200 bg-white"
                }`}
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                    {n.kind}
                  </span>
                  <span className="text-[11px] text-slate-400">
                    {new Date(n.created_at)
                      .toISOString()
                      .slice(0, 16)
                      .replace("T", " ")}
                  </span>
                </div>
                <p className="mt-1 whitespace-pre-wrap text-sm text-slate-800">
                  {n.body}
                </p>
                <p className="mt-1 font-mono text-[11px] text-slate-500">
                  by {n.author.slice(0, 6)}…{n.author.slice(-4)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Approve / Reject / Suspend modals */}
      <ConfirmModal
        open={confirm === "approve"}
        onClose={() => setConfirm(null)}
        onConfirm={(reason) => applyStatus("verified", reason)}
        title="Approve KYC"
        kind="info"
        confirmLabel="Approve"
        description={
          <p>
            Verifying unlocks the client. Reason will be recorded as a
            kyc-event note.
          </p>
        }
      />
      <ConfirmModal
        open={confirm === "reject"}
        onClose={() => setConfirm(null)}
        onConfirm={(reason) => applyStatus("rejected", reason)}
        title="Reject KYC"
        kind="destructive"
        confirmLabel="Reject"
        description={
          <p>
            Rejecting marks the client KYC as failed. They&apos;ll need to
            re-onboard.
          </p>
        }
      />
      <ConfirmModal
        open={confirm === "suspend"}
        onClose={() => setConfirm(null)}
        onConfirm={(reason) => applySuspend(reason)}
        title="Suspend client"
        kind="warning"
        confirmLabel="Suspend"
        description={
          <p>
            Suspending blocks every flow that gates on KYC. Use for AML or
            sanctions hits.
          </p>
        }
      />

      {/* Request more info / return-to-supplement bespoke modal */}
      {showMoreInfo && (
        <RequestMoreInfoModal
          onClose={() => setShowMoreInfo(false)}
          onConfirm={async (selectedKinds, note) => {
            if (!wallet) return;
            const items = selectedKinds.map((k) => ({
              doc_kind: k.kind,
              label: k.label,
              note: note || undefined,
            }));
            const { ok, uploadLinkWarning } = await requestRequirements(
              conn.wallet,
              id,
              items,
            );
            if (ok) {
              if (uploadLinkWarning) {
                // The requirements ARE recorded, but the client's email went
                // out WITHOUT an upload link — say so and keep it on screen.
                toast.show({
                  kind: "error",
                  title: "Requested — but no upload link could be sent",
                  description: uploadLinkWarning,
                  duration: 0,
                });
              } else {
                toast.show({
                  kind: "success",
                  title: "Request sent",
                  description: `${items.length} document(s) requested; status set to more_info.`,
                });
              }
              setShowMoreInfo(false);
              await refresh();
            } else {
              toast.showError("Failed", "Could not create requirements");
            }
          }}
        />
      )}
    </div>
  );
}

// ─── Bespoke request-more-info modal ────────────────────────────────────────
// Uses the same overlay style as AddClientModal (fixed inset, backdrop, white
// card). ConfirmModal was not reused because its body is fixed to a single
// reason textarea; the checklist requires a list of checkboxes + a shared note
// textarea, which cannot fit ConfirmModal's `description` slot cleanly and
// would require re-implementing all the checkbox state outside anyway.

function RequestMoreInfoModal({
  onClose,
  onConfirm,
}: {
  onClose: () => void;
  onConfirm: (
    selectedKinds: { kind: KycDocKind; label: string }[],
    note: string,
  ) => Promise<void>;
}) {
  const [selected, setSelected] = useState<Set<KycDocKind>>(new Set());
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  function toggle(kind: KycDocKind) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }

  async function confirm() {
    if (selected.size === 0 || busy) return;
    setBusy(true);
    try {
      const items = KYC_DOC_KINDS.filter((k) => selected.has(k.kind));
      await onConfirm(items, note.trim());
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center overflow-y-auto bg-slate-900/40 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="mx-auto w-full max-w-lg overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl">
        <div className="border-b border-brand-200 bg-brand-50 px-5 py-4">
          <p className="text-sm font-semibold uppercase tracking-wide text-brand-900">
            Request more info
          </p>
        </div>

        <div className="space-y-4 px-5 py-4">
          <p className="text-sm text-slate-600">
            Select the document(s) to request. The client&apos;s KYC status will
            be set to <span className="font-semibold">more_info</span>.
          </p>

          {/* KYC doc-kind checklist */}
          <div className="space-y-2">
            {KYC_DOC_KINDS.map((k) => (
              <label
                key={k.kind}
                className="flex cursor-pointer items-center gap-3 rounded-md border border-slate-200 px-3 py-2 hover:bg-slate-50"
              >
                <input
                  type="checkbox"
                  checked={selected.has(k.kind)}
                  onChange={() => toggle(k.kind)}
                  disabled={busy}
                  className="h-4 w-4 rounded border-slate-300 accent-slate-900"
                />
                <span className="text-sm text-slate-700">{k.label}</span>
              </label>
            ))}
          </div>

          {/* Optional note */}
          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Note (optional — sent to client)
            </span>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. Please provide a certified copy issued within the last 3 months."
              rows={3}
              disabled={busy}
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-slate-400 focus:outline-none"
            />
          </label>
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-100 bg-slate-50 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-md px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-200 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void confirm()}
            disabled={busy || selected.size === 0}
            className="rounded-md bg-brand-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-800 disabled:opacity-50"
          >
            {busy ? "Sending…" : `Request ${selected.size > 0 ? `(${selected.size})` : ""}`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * KYC documents live in the PRIVATE `client-documents` bucket — resolving a
 * URL requires an admin-signed request (60-minute signed URL; legacy public
 * fallback handled server-side). Fetch-on-click keeps the page free of
 * pre-generated links.
 */
function DocLink({
  session,
  documentId,
  label,
  className,
}: {
  session: WalletSession | null | undefined;
  documentId: number;
  label: string;
  className?: string;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function open() {
    if (busy) return;
    setBusy(true);
    try {
      const url = await getClientDocumentUrl(session, documentId);
      if (!url) throw new Error("Could not resolve the document URL");
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      toast.showError(
        "Download failed",
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={() => void open()}
      disabled={busy}
      className={`${className ?? ""} disabled:opacity-50`}
    >
      {busy ? "Preparing…" : label}
    </button>
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
