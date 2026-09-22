"use client";

import { WalletRequired } from "@/components/wallet-required";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSolanaClient, useWalletConnection } from "@solana/react-hooks";
import { useCallback, useEffect, useMemo, useState } from "react";
import { findAssetPda } from "@/lib/generated/asset_registry";
import { loadKycAuthorityContext } from "@/lib/kyc-authority";
import { Kpi } from "@/components/kpi";
import { loadNetwork, type NetworkData } from "@/lib/enumerate";
import { loadNetworkPreferIndexer } from "@/lib/indexer";
import { loadHoldings, type Holding } from "@/lib/holdings";
import { SkeletonCard, SkeletonTable } from "@/components/skeleton";
import {
  fetchPassport,
  getOpenPassportRequest,
  isDefaultApprovedJurisdiction,
  isPassportExpired,
  KycStatus,
  submitPassportRequest,
  type KycEntry,
  type OpenPassportRequest,
} from "@/lib/passport";
import { getMyOnboardingPath } from "@/lib/clients";
import { countryName, COUNTRIES } from "@/lib/countries";
import { FieldError, FieldHelp, FieldLabel } from "@/components/field";
import { useToast } from "@/lib/toast";

const CLASS_TYPE = [
  "Common",
  "Preferred A",
  "Preferred B",
  "Senior debt",
  "Junior debt",
  "Rev-share tier",
  "Royalty tier",
];

// Only jurisdictions the server actually accepts (/api/passport/submit
// validates against DEFAULT_APPROVED_JURISDICTIONS — offering the full ISO
// list meant signing a wallet message only to get a 400). Every listed code
// is also encodable in the on-chain registry bitmap (128 bytes since the
// 2026-08-10 widening), so intake approval implies issuability.
const PASSPORT_COUNTRY_OPTIONS = COUNTRIES.filter((c) =>
  isDefaultApprovedJurisdiction(parseInt(c.code, 10)),
);

type EnrichedHolding = Holding & {
  className: string;
  assetName: string;
  assetId: string;
  classIndex: number;
  classType: number;
};

type PassportState =
  | { phase: "loading" }
  | { phase: "none" }
  | { phase: "ready"; entry: KycEntry };

export default function PortfolioOverviewPage() {
  const conn = useWalletConnection();
  const client = useSolanaClient();
  const router = useRouter();
  const toast = useToast();
  const wallet = conn.wallet?.account.address;
  const [data, setData] = useState<NetworkData | null>(null);
  const [holdings, setHoldings] = useState<Holding[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [passport, setPassport] = useState<PassportState>({ phase: "loading" });
  const [now] = useState(() => Math.floor(Date.now() / 1000));
  const [registryPda, setRegistryPda] = useState<string | null>(null);
  const [openRequest, setOpenRequest] = useState<OpenPassportRequest | null>(
    null,
  );
  const [requestModalOpen, setRequestModalOpen] = useState(false);

  const refresh = useCallback(async () => {
    if (!wallet) return;
    try {
      const [network, hs] = await Promise.all([
        loadNetworkPreferIndexer(() => loadNetwork(client.runtime.rpc)),
        loadHoldings(client.runtime.rpc, wallet),
      ]);
      setData(network);
      setHoldings(hs);
    } catch {
      setFailed(true);
    }
  }, [client, wallet]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  // Passport fetch — use the live KYC registry (independent of platform.admin).
  useEffect(() => {
    let cancelled = false;
    async function loadPassport() {
      if (!wallet) {
        if (!cancelled) setPassport({ phase: "none" });
        return;
      }
      try {
        // The live registry is bound to its original provider key, not to the
        // current platform admin — resolve it from chain, never via Platform.admin.
        const ctx = await loadKycAuthorityContext(client.runtime.rpc);
        if (!ctx.registry) {
          if (!cancelled) setPassport({ phase: "none" });
          return;
        }
        const registry = ctx.registry.address;
        if (!cancelled) setRegistryPda(registry.toString());
        const entry = await fetchPassport(client.runtime.rpc, registry, wallet);
        if (!cancelled) {
          setPassport(entry ? { phase: "ready", entry } : { phase: "none" });
        }
      } catch {
        if (!cancelled) setPassport({ phase: "none" });
      }
    }
    void loadPassport();
    return () => {
      cancelled = true;
    };
  }, [client, wallet]);

  // Open (undecided) passport request for this wallet — drives the card's
  // "application under review" state instead of the Apply/Reapply button.
  const refreshOpenRequest = useCallback(async () => {
    if (!wallet) {
      setOpenRequest(null);
      return;
    }
    // Minimal unsigned status probe — the passport_requests table itself is
    // no longer anon-readable (0031); the server returns only the newest
    // undecided request's id/status/created_at for this wallet.
    setOpenRequest(await getOpenPassportRequest(wallet.toString()));
  }, [wallet]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshOpenRequest();
  }, [refreshOpenRequest]);

  // "Resume document upload": the magic-link is shown exactly once in the
  // submit modal, so a closed tab used to strand dossiers provisioned without
  // an email. The wallet owner proves identity with one SIWS signature
  // (explicit click — no popup on page load) and the server re-serves (or
  // re-issues) their own upload link.
  const [resumeBusy, setResumeBusy] = useState(false);
  const resumeUpload = useCallback(async () => {
    if (!conn.wallet || resumeBusy) return;
    setResumeBusy(true);
    try {
      const { path, notice } = await getMyOnboardingPath(conn.wallet);
      if (path) {
        router.push(path);
      } else {
        toast.showError(
          "No upload page available",
          notice ??
            "Your dossier has no open document checklist right now — the compliance team may already have everything they need.",
        );
      }
    } catch (err) {
      toast.showError(
        "Could not open the upload page",
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setResumeBusy(false);
    }
  }, [conn.wallet, resumeBusy, router, toast]);

  // Asset PDA → { name, assetId } for joining share-classes back to their asset.
  const [assetPdaMap, setAssetPdaMap] = useState<
    Map<string, { name: string; assetId: string }>
  >(new Map());
  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!data) return;
      const m = new Map<string, { name: string; assetId: string }>();
      for (const a of data.assets) {
        const [pda] = await findAssetPda({
          issuer: a.issuer,
          assetId: a.assetId,
        });
        m.set(pda.toString(), { name: a.name, assetId: a.assetId });
      }
      if (!cancelled) setAssetPdaMap(m);
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [data]);

  // Match each holding to the Manci share class by mint.
  const enriched = useMemo<EnrichedHolding[]>(() => {
    if (!data || !holdings) return [];
    const out: EnrichedHolding[] = [];
    for (const h of holdings) {
      const sc = data.shareClasses.find((s) => s.mint.toString() === h.mint);
      if (!sc) continue;
      const asset = assetPdaMap.get(sc.asset.toString());
      out.push({
        ...h,
        className: CLASS_TYPE[sc.classType] ?? "?",
        assetName: asset?.name ?? "(unknown)",
        assetId: asset?.assetId ?? "—",
        classIndex: sc.classIndex,
        classType: sc.classType,
      });
    }
    return out;
  }, [data, holdings, assetPdaMap]);

  if (!conn.isReady) {
    return (
      <main className="min-w-0 flex-1">
        <SkeletonCard className="max-w-md" rows={3} />
      </main>
    );
  }

  if (!wallet) {
    return (
      <main className="min-w-0 flex-1">
        <WalletRequired />
      </main>
    );
  }

  if (failed) {
    return (
      <main className="min-w-0 flex-1">
        <p className="text-sm text-red-600">Failed to load portfolio.</p>
      </main>
    );
  }

  const loading = data === null || holdings === null;

  return (
    <main className="min-w-0 flex-1">
      <div>
        <p className="text-xs font-semibold uppercase tracking-widest text-slate-500">
          Portfolio
        </p>
        <h1 className="mt-1 text-2xl font-semibold text-slate-900">Holdings</h1>
        <p className="mt-2 text-sm text-slate-600">
          Every Manci share-class token held by{" "}
          <code className="font-mono text-xs">
            {wallet.toString().slice(0, 6)}…{wallet.toString().slice(-4)}
          </code>
          .
        </p>
      </div>

      {/* Verification (investor passport) card */}
      <section className="mt-8">
        <PassportCard
          state={passport}
          now={now}
          openRequest={openRequest}
          onApply={() => router.push("/verify?type=kyc")}
          onResumeUpload={() => void resumeUpload()}
          resumeBusy={resumeBusy}
        />
      </section>

      <PassportRequestModal
        open={requestModalOpen}
        wallet={wallet.toString()}
        registryPda={registryPda}
        onClose={() => setRequestModalOpen(false)}
        onSubmitted={() => void refreshOpenRequest()}
      />

      {/* Summary tiles */}
      <section className="mt-8 grid gap-4 sm:grid-cols-3">
        <Kpi
          label="Holdings"
          value={loading ? "…" : String(enriched.length)}
        />
        <Kpi
          label="Distinct assets"
          value={loading ? "…" : String(new Set(enriched.map((h) => h.assetName)).size)}
        />
        <Kpi
          label="Network"
          value="Devnet"
        />
      </section>

      <section className="mt-10">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-500">
          Token holdings
        </h2>
        {loading ? (
          <div className="mt-4">
            <SkeletonTable rows={3} cols={4} />
          </div>
        ) : enriched.length === 0 ? (
          <Empty />
        ) : (
          <div className="mt-4 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-card">
            <table className="w-full text-sm">
              <thead className="border-b border-slate-100 bg-slate-50 text-left text-xs uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-4 py-3 font-medium">Asset / class</th>
                  <th className="px-4 py-3 font-medium">Type</th>
                  <th className="px-4 py-3 text-right font-medium">Balance</th>
                  <th className="px-4 py-3 font-medium">Mint</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {enriched.map((h, i) => (
                  <tr key={i} className="text-slate-700">
                    <td className="px-4 py-3">
                      <p className="font-medium text-slate-900">{h.assetName}</p>
                      <p className="mt-0.5 text-xs text-slate-500">
                        #{h.classIndex} · {h.assetId}
                      </p>
                    </td>
                    <td className="px-4 py-3">{h.className}</td>
                    <td className="px-4 py-3 text-right font-mono text-slate-700">
                      {String(h.balance)}
                    </td>
                    <td className="px-4 py-3 font-mono text-[11px] text-slate-500">
                      {h.mint.slice(0, 6)}…{h.mint.slice(-4)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <p className="mt-10 text-xs text-slate-400">
        USD valuation, P/L and tax-lot tracking arrive once a price oracle is
        wired up (Faza F backlog).
      </p>
    </main>
  );
}

// ── Investor passport card ────────────────────────────────────────────────────

function PassportCard({
  state,
  now,
  openRequest,
  onApply,
  onResumeUpload,
  resumeBusy,
}: {
  state: PassportState;
  now: number;
  openRequest: OpenPassportRequest | null;
  onApply: () => void;
  onResumeUpload: () => void;
  resumeBusy: boolean;
}) {
  if (state.phase === "loading") {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-card animate-pulse">
        <div className="h-3 w-32 rounded bg-slate-100" />
        <div className="mt-3 h-5 w-48 rounded bg-slate-100" />
      </div>
    );
  }

  if (state.phase === "none") {
    return (
      <div className="rounded-xl border border-brand-100 bg-brand-50 p-5 shadow-card">
        <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-brand-500">
          Verification
        </p>
        <p className="mt-2 text-[14px] font-semibold text-slate-800">
          Not verified yet
        </p>
        <p className="mt-1 text-[13px] text-slate-500">
          Buying and trading tokens does not require verification. Complete
          KYC before you convert tokens into company shares, take delivery of
          a physical good, or buy a KYC-gated class.
        </p>
        {openRequest ? (
          <>
            <PendingRequestNote request={openRequest} />
            <div className="mt-2">
              <button
                type="button"
                onClick={onResumeUpload}
                disabled={resumeBusy}
                className="inline-flex items-center gap-1 rounded-md border border-brand-200 bg-white px-3 py-1.5 font-mono text-[11px] font-semibold text-brand-700 transition-colors hover:bg-brand-50 disabled:opacity-50"
              >
                {resumeBusy ? "Opening…" : "Continue verification →"}
              </button>
              <p className="mt-1 text-[11px] text-slate-400">
                Signs a message with your wallet to reopen your personal
                upload page.
              </p>
            </div>
          </>
        ) : (
          <button
            type="button"
            onClick={onApply}
            className="mt-3 inline-flex items-center gap-1 rounded-md border border-brand-200 bg-white px-3 py-1.5 font-mono text-[11px] font-semibold text-brand-700 transition-colors hover:bg-brand-50"
          >
            Start verification →
          </button>
        )}
      </div>
    );
  }

  const { entry } = state;
  const expiryTs = Number(entry.expiry);
  // Chain semantics (isPassportExpired): valid only while expiry > now, so
  // expiry == 0 means ALWAYS expired — never "no expiry".
  const isExpired = isPassportExpired(entry.expiry, now);
  const expiryDate = expiryTs > 0
    ? new Date(expiryTs * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
    : "—";

  type BadgeCfg = { label: string; badge: string; dot: string; border: string; header: string };
  const cfg: BadgeCfg = (() => {
    if (isExpired || entry.status === KycStatus.Expired) {
      return {
        label: "Expired",
        badge: "border-orange-200 bg-orange-50 text-orange-700",
        dot: "bg-orange-500",
        border: "border-orange-200",
        header: "text-orange-700",
      };
    }
    if (entry.status === KycStatus.Revoked) {
      return {
        label: "Revoked",
        badge: "border-red-200 bg-red-50 text-red-700",
        dot: "bg-red-500",
        border: "border-red-200",
        header: "text-red-700",
      };
    }
    if (entry.status === KycStatus.Pending) {
      return {
        label: "Pending",
        badge: "border-amber-200 bg-amber-50 text-amber-700",
        dot: "bg-amber-400",
        border: "border-amber-200",
        header: "text-amber-700",
      };
    }
    // Approved
    return {
      label: "Verified investor",
      badge: "border-emerald-200 bg-emerald-50 text-emerald-700",
      dot: "bg-emerald-500",
      border: "border-emerald-200",
      header: "text-emerald-700",
    };
  })();

  const tierLabel =
    entry.accreditationLevel === 0
      ? "Retail"
      : entry.accreditationLevel === 1
        ? "Accredited"
        : entry.accreditationLevel === 2
          ? "Qualified"
          : `Tier ${entry.accreditationLevel}`;

  const jurisdictionStr = countryName(
    entry.jurisdiction > 0 ? String(entry.jurisdiction).padStart(3, "0") : null,
  );

  return (
    <div className={`rounded-xl border bg-white p-5 shadow-card ${cfg.border}`}>
      <div className="flex items-center justify-between">
        <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-400">
          Verification
        </p>
        <span
          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-[11px] font-semibold ${cfg.badge}`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${cfg.dot}`} />
          {cfg.label}
        </span>
      </div>

      <dl className="mt-4 grid grid-cols-3 gap-4 text-[13px]">
        <div>
          <dt className="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-400">
            Tier
          </dt>
          <dd className="mt-1 font-semibold text-slate-800">{tierLabel}</dd>
        </div>
        <div>
          <dt className="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-400">
            Jurisdiction
          </dt>
          <dd className="mt-1 font-semibold text-slate-800">{jurisdictionStr}</dd>
        </div>
        <div>
          <dt className="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-400">
            Expires
          </dt>
          <dd className={`mt-1 font-semibold ${isExpired ? "text-orange-600" : "text-slate-800"}`}>
            {expiryDate}
          </dd>
        </div>
      </dl>

      {(entry.status === KycStatus.Revoked || isExpired || entry.status === KycStatus.Expired) && (
        <div className="mt-4 rounded-lg border border-slate-100 bg-slate-50 px-3 py-2">
          <p className="text-[12px] text-slate-500">
            {entry.status === KycStatus.Revoked
              ? "Your verification has been revoked. Contact support or verify again."
              : "Your verification has expired. Renew it before converting tokens into company shares, taking delivery, or buying KYC-gated classes."}
            {" "}
            {openRequest ? (
              <>
                <span className="font-medium text-slate-600">
                  Reapplication under review.
                </span>{" "}
                <button
                  type="button"
                  onClick={onResumeUpload}
                  disabled={resumeBusy}
                  className="font-medium text-brand-600 underline-offset-2 hover:underline disabled:opacity-50"
                >
                  {resumeBusy ? "Opening…" : "Continue verification →"}
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={onApply}
                className="font-medium text-brand-600 hover:underline underline-offset-2"
              >
                Renew verification →
              </button>
            )}
          </p>
        </div>
      )}
    </div>
  );
}

function PendingRequestNote({ request }: { request: OpenPassportRequest }) {
  const submitted = new Date(request.created_at).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  return (
    <div className="mt-3 inline-flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-1.5">
      <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
      <p className="text-[12px] text-amber-800">
        Verification submitted {submitted} —{" "}
        {request.status === "in_review" ? "in review" : "awaiting review"}.
      </p>
    </div>
  );
}

// ── Passport request modal ────────────────────────────────────────────────────

function PassportRequestModal(props: {
  open: boolean;
  wallet: string;
  registryPda: string | null;
  onClose: () => void;
  onSubmitted: () => void;
}) {
  if (!props.open) return null;
  return <PassportRequestModalInner {...props} />;
}

const NOTE_MAX = 500;

function PassportRequestModalInner({
  wallet,
  registryPda,
  onClose,
  onSubmitted,
}: {
  open: boolean;
  wallet: string;
  registryPda: string | null;
  onClose: () => void;
  onSubmitted: () => void;
}) {
  const conn = useWalletConnection();
  const toast = useToast();
  const [jurisdiction, setJurisdiction] = useState("");
  const [note, setNote] = useState("");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  // Set after a successful submit — the modal flips to a success view with
  // the magic-link to the document-upload flow (/onboarding/{id}).
  const [submittedPath, setSubmittedPath] = useState<string | null | undefined>(
    undefined,
  );
  // Server-supplied reason why no upload link came back (e.g. the database is
  // missing migration 0041) — shown instead of the generic "we'll be in touch".
  const [submittedNotice, setSubmittedNotice] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const jurisdictionError = jurisdiction ? null : "Select your jurisdiction.";
  const noteError =
    note.length > NOTE_MAX ? `Keep the note under ${NOTE_MAX} characters.` : null;
  const valid = !jurisdictionError && !noteError;

  async function submit() {
    setTouched(true);
    if (!valid || busy) return;
    setBusy(true);
    try {
      const result = await submitPassportRequest(conn.wallet, {
        wallet,
        registryPda: registryPda ?? undefined,
        jurisdiction: parseInt(jurisdiction, 10),
        note: note.trim() || undefined,
      });
      toast.show({
        kind: "success",
        title: "Verification submitted",
        description: "Our compliance team will review it and get back to you.",
      });
      onSubmitted();
      setSubmittedNotice(result.onboardingNotice);
      setSubmittedPath(result.onboardingPath);
    } catch (err) {
      toast.showError(
        "Failed to submit application",
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setBusy(false);
    }
  }

  // Success view: the application is in; hand the applicant straight to the
  // document-upload flow (magic-link) when one was provisioned.
  if (submittedPath !== undefined) {
    return (
      <div
        className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm"
        role="dialog"
        aria-modal="true"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div className="mx-4 w-full max-w-md overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl">
          <div className="border-b border-emerald-100 bg-emerald-50 px-5 py-4">
            <p className="text-sm font-semibold uppercase tracking-wide text-emerald-700">
              Application submitted
            </p>
          </div>
          <div className="space-y-3 px-5 py-4">
            <p className="text-sm leading-relaxed text-slate-700">
              Your verification is in the review queue.
            </p>
            {submittedPath ? (
              <p className="text-sm leading-relaxed text-slate-700">
                To speed up the review, upload your KYC documents (passport,
                proof of address, selfie) now — the link below is your personal
                upload page. Keep it private.
              </p>
            ) : submittedNotice ? (
              <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm leading-relaxed text-amber-900">
                {submittedNotice}
              </p>
            ) : (
              <p className="text-sm leading-relaxed text-slate-700">
                Our compliance team will get back to you once the review is
                complete.
              </p>
            )}
          </div>
          <div className="flex justify-end gap-2 border-t border-slate-100 bg-slate-50 px-5 py-3">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-200"
            >
              Close
            </button>
            {submittedPath && (
              <Link
                href={submittedPath}
                className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
              >
                Upload documents →
              </Link>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="passport-request-title"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="mx-4 w-full max-w-md overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl">
        <div className="border-b border-brand-100 bg-brand-50 px-5 py-4">
          <p
            id="passport-request-title"
            className="text-sm font-semibold uppercase tracking-wide text-brand-700"
          >
            Start verification
          </p>
        </div>
        <div className="space-y-4 px-5 py-4">
          <p className="text-sm leading-relaxed text-slate-700">
            Submit a KYC application for wallet{" "}
            <code className="font-mono text-xs">
              {wallet.slice(0, 6)}…{wallet.slice(-4)}
            </code>
            . The compliance team reviews it and verifies your wallet.
          </p>
          <div>
            <label htmlFor="passport-jurisdiction" className="mb-1 block">
              <FieldLabel required>Jurisdiction</FieldLabel>
            </label>
            <select
              id="passport-jurisdiction"
              value={jurisdiction}
              onChange={(e) => setJurisdiction(e.target.value)}
              disabled={busy}
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-slate-400 focus:outline-none"
            >
              <option value="">Select country…</option>
              {PASSPORT_COUNTRY_OPTIONS.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name}
                </option>
              ))}
            </select>
            {touched && <FieldError error={jurisdictionError} />}
            <FieldHelp>
              Country of residence (individuals) or incorporation. Only listed
              countries are currently supported.
            </FieldHelp>
          </div>
          <div>
            <label htmlFor="passport-note" className="mb-1 block">
              <FieldLabel>Note</FieldLabel>
            </label>
            <textarea
              id="passport-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Anything the compliance team should know (optional)"
              rows={3}
              maxLength={NOTE_MAX + 1}
              disabled={busy}
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-slate-400 focus:outline-none"
            />
            <FieldError error={noteError} />
          </div>
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
            onClick={() => void submit()}
            disabled={busy || (touched && !valid)}
            className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {busy ? "Submitting…" : "Submit application"}
          </button>
        </div>
      </div>
    </div>
  );
}


function Empty() {
  return (
    <div className="mt-4 rounded-xl border border-slate-200 bg-white p-12 text-center shadow-card">
      <p className="text-sm text-slate-600">
        No Manci holdings yet.
      </p>
      <p className="mt-1 text-xs text-slate-400">
        Buy on a primary sale or take an OTC offer to see balances here.
      </p>
      <Link
        href="/marketplace/launchpad"
        className="mt-4 inline-block rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:border-slate-400"
      >
        Browse launchpad →
      </Link>
    </div>
  );
}
