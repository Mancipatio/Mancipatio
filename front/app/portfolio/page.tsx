"use client";

import { WalletRequired } from "@/components/wallet-required";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSolanaClient, useWalletConnection } from "@solana/react-hooks";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Address } from "@solana/kit";
import { assetHref } from "@/lib/asset-links";
import { enrichPortfolioHoldings, type PortfolioHolding } from "@/lib/portfolio-overview";
import { useChainClock } from "@/lib/use-chain-clock";
import { loadKycAuthorityContext } from "@/lib/kyc-authority";
import { Kpi } from "@/components/kpi";
import { detectNetwork, networkLabel } from "@/lib/network";
import { loadNetwork } from "@/lib/enumerate";
import { loadNetworkPreferIndexer } from "@/lib/indexer";
import { loadHoldings } from "@/lib/holdings";
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
import { navHrefVisible } from "@/lib/pilot-scope";

// Only jurisdictions the server actually accepts (/api/passport/submit
// validates against DEFAULT_APPROVED_JURISDICTIONS — offering the full ISO
// list meant signing a wallet message only to get a 400). Every listed code
// is also encodable in the on-chain registry bitmap (128 bytes since the
// 2026-08-10 widening), so intake approval implies issuability.
const PASSPORT_COUNTRY_OPTIONS = COUNTRIES.filter((c) =>
  isDefaultApprovedJurisdiction(parseInt(c.code, 10)),
);

type PassportState =
  | { phase: "loading" }
  | { phase: "none" }
  | { phase: "error" }
  | { phase: "ready"; entry: KycEntry };

type RequestState =
  | { phase: "loading" }
  | { phase: "error" }
  | { phase: "ready"; request: OpenPassportRequest | null };

export default function PortfolioOverviewPage() {
  const conn = useWalletConnection();
  const wallet = conn.wallet?.account.address;
  if (!conn.isReady) {
    return <main className="min-w-0 flex-1"><SkeletonCard className="max-w-md" rows={3} /></main>;
  }
  if (!wallet) {
    return <main className="min-w-0 flex-1"><WalletRequired /></main>;
  }
  // A new wallet gets a fresh component before its first render. Responses,
  // open dialogs and private upload links from the previous wallet cannot leak.
  return <PortfolioForWallet key={`${detectNetwork()}:${wallet}`} wallet={wallet} />;
}

function PortfolioForWallet({ wallet }: { wallet: Address }) {
  const conn = useWalletConnection();
  const client = useSolanaClient();
  const router = useRouter();
  const toast = useToast();
  const [enriched, setEnriched] = useState<PortfolioHolding[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [passport, setPassport] = useState<PassportState>({ phase: "loading" });
  const now = Number(useChainClock());
  const [registryPda, setRegistryPda] = useState<string | null>(null);
  const [requestState, setRequestState] = useState<RequestState>({ phase: "loading" });
  const [requestModalOpen, setRequestModalOpen] = useState(false);
  const [revision, setRevision] = useState(0);
  const [lastLoadedAt, setLastLoadedAt] = useState<Date | null>(null);
  const active = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);
  const refresh = () => setRevision((value) => value + 1);

  useEffect(() => {
    let cancelled = false;
    async function loadHoldingsState() {
      setEnriched(null);
      setFailed(false);
      setLastLoadedAt(null);
      try {
        const [network, holdings] = await Promise.all([
          loadNetworkPreferIndexer(() => loadNetwork(client.runtime.rpc)),
          loadHoldings(client.runtime.rpc, wallet),
        ]);
        const rows = await enrichPortfolioHoldings(network, holdings);
        if (!cancelled) {
          setEnriched(rows);
          setLastLoadedAt(new Date());
        }
      } catch {
        if (!cancelled) setFailed(true);
      }
    }
    async function loadPassport() {
      setPassport({ phase: "loading" });
      setRegistryPda(null);
      try {
        const ctx = await loadKycAuthorityContext(client.runtime.rpc, { fresh: revision > 0 });
        // Preserve the configured registry address across authority rotation.
        // A missing pin is an unavailable read, never proof of no passport.
        if (ctx.ambiguous || ctx.pinnedMissing) throw new Error("Passport registry unavailable");
        const registry = ctx.registry?.address;
        const entry = registry ? await fetchPassport(client.runtime.rpc, registry, wallet) : null;
        if (!cancelled) {
          setRegistryPda(registry?.toString() ?? null);
          setPassport(entry ? { phase: "ready", entry } : { phase: "none" });
        }
      } catch {
        if (!cancelled) setPassport({ phase: "error" });
      }
    }
    async function loadRequest() {
      setRequestState({ phase: "loading" });
      try {
        const request = await getOpenPassportRequest(wallet.toString());
        if (!cancelled) setRequestState({ phase: "ready", request });
      } catch {
        if (!cancelled) setRequestState({ phase: "error" });
      }
    }
    void loadHoldingsState();
    void loadPassport();
    void loadRequest();
    return () => { cancelled = true; };
  }, [client, wallet, revision]);

  // "Resume document upload": the magic-link is shown exactly once in the
  // submit modal, so a closed tab used to strand dossiers provisioned without
  // an email. The wallet owner proves identity with one SIWS signature
  // (explicit click — no popup on page load) and the server re-serves (or
  // re-issues) their own upload link.
  const [resumeBusy, setResumeBusy] = useState(false);
  const resumeUpload = useCallback(async () => {
    if (!conn.wallet || conn.wallet.account.address !== wallet || resumeBusy) return;
    setResumeBusy(true);
    try {
      const { path, notice } = await getMyOnboardingPath(conn.wallet);
      if (!active.current) return;
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
      if (!active.current) return;
      toast.showError(
        "Could not open the upload page",
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      if (active.current) setResumeBusy(false);
    }
  }, [conn.wallet, resumeBusy, router, toast, wallet]);

  const loading = enriched === null && !failed;
  const refreshing = loading || passport.phase === "loading" || requestState.phase === "loading";

  return (
    <main className="min-w-0 flex-1">
      <div className="flex flex-wrap items-start justify-between gap-4">
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
        {lastLoadedAt && <p className="mt-2 text-xs text-slate-500">Balances checked at {lastLoadedAt.toLocaleTimeString()}.</p>}
        </div>
        <button type="button" onClick={refresh} className="btn-brand">
          Refresh status
        </button>
      </div>
      {refreshing && <p role="status" className="mt-3 text-xs text-slate-500">Checking latest status… You can refresh again if the connection stalls.</p>}

      {/* Verification (investor passport) card */}
      <section className="mt-8">
        <PassportCard
          state={passport}
          now={now}
          requestState={requestState}
          onRetry={refresh}
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
        onSubmitted={refresh}
      />

      {/* Summary tiles */}
      <section className="mt-8 grid gap-4 sm:grid-cols-3">
        <Kpi
          label="Holdings"
          value={enriched === null ? "—" : String(enriched.length)}
        />
        <Kpi
          label="Distinct assets"
          value={enriched === null ? "—" : String(new Set(enriched.map((h) => h.assetPda)).size)}
        />
        <Kpi
          label="Network"
          value={networkLabel(detectNetwork())}
        />
      </section>

      <section className="mt-10">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-500">
          Token holdings
        </h2>
        {failed ? (
          <div role="alert" className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-900">
            <p className="font-semibold">Balances could not be loaded</p>
            <p className="mt-1">Your holdings are unknown until the connection recovers. Try loading them again.</p>
            <button type="button" onClick={refresh} className="btn-brand mt-3">Try again</button>
          </div>
        ) : loading || enriched === null ? (
          <div className="mt-4">
            <SkeletonTable rows={3} cols={4} />
          </div>
        ) : enriched.length === 0 ? (
          <Empty />
        ) : (
          <div className="mt-4 overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-card">
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
                {enriched.map((h) => (
                  <tr key={h.mint} className="text-slate-700">
                    <td className="px-4 py-3">
                      <Link href={assetHref(h.assetPda)} className="font-medium text-brand-700 hover:underline">{h.assetName}</Link>
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
        Balances show the share units held in this wallet. Market value and returns are not estimated.
      </p>
    </main>
  );
}

// ── Investor passport card ────────────────────────────────────────────────────

function PassportCard({
  state,
  now,
  requestState,
  onRetry,
  onApply,
  onResumeUpload,
  resumeBusy,
}: {
  state: PassportState;
  now: number;
  requestState: RequestState;
  onRetry: () => void;
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

  if (state.phase === "error") {
    return (
      <div role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-900">
        <p className="font-semibold">Verification status unavailable</p>
        <p className="mt-1">We could not verify your investor passport. Reload its status before starting a new application.</p>
        <button type="button" onClick={onRetry} className="btn-brand mt-3">Try again</button>
      </div>
    );
  }
  const openRequest = requestState.phase === "ready" ? requestState.request : null;

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
          Buying tokens does not require verification unless the class is KYC-gated.
          {navHrefVisible("/portfolio/conversion") && " Complete KYC before converting tokens into company shares."}
          {navHrefVisible("/portfolio/delivery") && " Physical delivery also requires KYC."}
        </p>
        {requestState.phase !== "ready" ? <RequestReadStatus state={requestState} onRetry={onRetry} /> : openRequest ? (
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
    if (isExpired || entry.status === KycStatus.Expired) {
      return {
        label: "Expired",
        badge: "border-orange-200 bg-orange-50 text-orange-700",
        dot: "bg-orange-500",
        border: "border-orange-200",
        header: "text-orange-700",
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

      {entry.status === KycStatus.Approved && !isExpired && (
        <div className="mt-5 border-t border-slate-100 pt-4">
          <p className="text-xs font-semibold uppercase tracking-widest text-slate-500">Next step</p>
          <p className="mt-2 text-sm text-slate-600">Your verification is active. Review your holdings and the eligibility requirements for any selected offering.</p>
          <div className="mt-3 flex flex-wrap gap-3">
            {navHrefVisible("/marketplace/launchpad") && <Link href="/marketplace/launchpad" className="btn-brand">Explore offerings</Link>}
            {navHrefVisible("/portfolio/vesting") && <Link href="/portfolio/vesting" className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">View vesting</Link>}
          </div>
        </div>
      )}
      {entry.status === KycStatus.Pending && (
        <div className="mt-4 text-sm text-slate-600">
          <p>Your verification is awaiting a decision. Complete any requested documents, then refresh to check for an update.</p>
          {requestState.phase !== "ready" ? <RequestReadStatus state={requestState} onRetry={onRetry} /> : (
            <button type="button" onClick={onResumeUpload} disabled={resumeBusy} className="btn-brand mt-3">{resumeBusy ? "Opening…" : "Continue verification"}</button>
          )}
        </div>
      )}

      {entry.status !== KycStatus.Pending && (entry.status === KycStatus.Revoked || isExpired || entry.status === KycStatus.Expired) && (
        <div className="mt-4 rounded-lg border border-slate-100 bg-slate-50 px-3 py-2">
          <p className="text-[12px] text-slate-500">
            {entry.status === KycStatus.Revoked
              ? "Your verification has been revoked. Contact support or verify again."
              : "Your verification has expired. Renew it before using services that require an approved investor passport."}
            {" "}
            {requestState.phase !== "ready" ? <RequestReadStatus state={requestState} onRetry={onRetry} /> : openRequest ? (
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

function RequestReadStatus({ state, onRetry }: { state: Exclude<RequestState, { phase: "ready" }>; onRetry: () => void }) {
  if (state.phase === "loading") return <span role="status" className="mt-3 block text-sm text-slate-500">Checking existing verification requests…</span>;
  return <span role="alert" className="mt-3 block text-sm text-amber-800">We could not check whether you already have a verification request in review. <button type="button" onClick={onRetry} className="font-semibold underline">Retry verification status</button></span>;
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
  // Primary sales paused (KYC-only mode, lib/pilot-scope.ts): no buy prompt.
  const salesOn = navHrefVisible("/marketplace/launchpad");
  return (
    <div className="mt-4 rounded-xl border border-slate-200 bg-white p-12 text-center shadow-card">
      <p className="text-sm text-slate-600">
        No Manci holdings yet.
      </p>
      {salesOn ? (
        <>
          <p className="mt-1 text-xs text-slate-400">
            Buy on a primary sale{navHrefVisible("/marketplace/otc") && " or take an OTC offer"} to see balances here.
          </p>
          <Link
            href="/marketplace/launchpad"
            className="mt-4 inline-block rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:border-slate-400"
          >
            Browse launchpad →
          </Link>
        </>
      ) : (
        <p className="mt-1 text-xs text-slate-400">Holdings you receive appear here.</p>
      )}
    </div>
  );
}
