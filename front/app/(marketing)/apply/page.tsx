"use client";

import { WALLET_CONNECT_LABEL, WALLET_CONNECT_DESCRIPTION } from "@/lib/wallet-copy";

import { WalletRequired } from "@/components/wallet-required";

import { useEffect, useState } from "react";
import { useWalletConnection } from "@solana/react-hooks";
import {
  Badge,
  Body,
  Button,
  ButtonRow,
  Card,
  Eyebrow,
  Field,
  FootNote,
  H2,
  H3,
  Input,
  InstrumentCard,
  MX_ROUTES,
  PageHeader,
  Section,
  Select,
  Small,
  Textarea,
  TextLink,
  cx,
} from "@/components/mx";
import {
  impliedValuation,
  monthlyPayout,
  yieldEstimate,
} from "@/lib/launch-math";
import {
  checkApplyEligibility,
  getMyApplicationWithEvents,
  listMyApplications,
  submitApplication,
  updateApplicationContent,
  type ApplicationEvent,
  type ApplicationStatus,
  type ApplyEligibility,
  type LaunchApplication,
  type NewApplication,
  type RaiseType,
} from "@/lib/launchpad";
import {
  applicationReadStatusCopy,
  classifyApplicationReadError,
  withSigningObserver,
  type ApplicationReadFailure,
  type ApplicationReadPhase,
} from "@/lib/apply-read-state";
import { useToast } from "@/lib/toast";

/**
 * "Apply to issue" — prototype `#page-apply`, on the live application wizard.
 *
 * Presentation only was replaced: the eligibility gate (onboarding + verified
 * KYC), the signed self-read of existing applications, the review loop
 * (pending / changes requested / rejected / approved), edit & resubmit, every
 * validation guard and the signed submit path are unchanged.
 *
 * Copy changes taken from the prototype:
 * - the raise step no longer says founders sell "actual company equity" —
 *   backers receive tokens convertible into shares, and the cap is stated in
 *   EUR per SPV per year (it was written as a dollar figure elsewhere);
 * - the Serbian-entity question the prototype asks up front is folded into the
 *   existing incorporation field rather than added as a new stored field;
 * - a data-handling line sits above the submit button.
 */

// ── constants ──────────────────────────────────────────────────────────────

const CATEGORIES = ["DeFi","Infrastructure","Consumer","AI / ML","Gaming","Social","DAO Tooling","Payments","RWA","Other"];
const STAGES_STARTUP = ["Pre-seed","Seed","Series A","Post-revenue","Bootstrapped"];
const STAGES_MATURE = ["Post-revenue","Series B+","Profitable"];
// "Serbia" leads the list: company ownership, debt and revenue share are
// issued through a Serbian SPV, so this answers the prototype's qualifying
// question ("Do you have a Serbian company?") without a new column.
const INCORP = ["Not yet","Serbia","US (Delaware)","US (Wyoming)","BVI","Cayman Islands","Singapore","UK","Estonia","Switzerland","Other"];
const STEPS = [
  { id: "type", label: "Type" }, { id: "basics", label: "Basics" }, { id: "company", label: "Company" },
  { id: "raise", label: "Raise" }, { id: "founder", label: "Founder" }, { id: "review", label: "Review" },
];

const MIN_TICKETS = ["$100","$250","$500","$1,000","$5,000","$10,000"];

// ── form type ──────────────────────────────────────────────────────────────

type Form = {
  raiseType: RaiseType | "";
  companyName: string; oneLiner: string; website: string; category: string;
  stage: string; incorporation: string; valuation: string; annualRevenue: string; existingInvestors: string; problemOrWhy: string;
  raiseAmount: number; equityOffered: number; minTicket: string; raiseStructure: string; cliffMonths: number; vestingMonths: number;
  founderName: string; founderEmail: string; founderTwitter: string; founderLinkedin: string; founderWhy: string; pitchDeck: string;
};

const EMPTY: Form = {
  raiseType: "", companyName: "", oneLiner: "", website: "", category: "",
  stage: "", incorporation: "Not yet", valuation: "", annualRevenue: "", existingInvestors: "", problemOrWhy: "",
  raiseAmount: 500000, equityOffered: 5, minTicket: "$500", raiseStructure: "", cliffMonths: 0, vestingMonths: 12,
  founderName: "", founderEmail: "", founderTwitter: "", founderLinkedin: "", founderWhy: "", pitchDeck: "",
};

// The equity raise counts against the SPV's EUR 3M/year cap, so every money
// figure on this page is in euro.
const fmtM = (v: number) => `€${(v / 1_000_000).toFixed(v >= 1_000_000 ? 1 : 2)}M`;
const fmtEur = (v: number) => `€${v.toLocaleString()}`;

const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());

const fmtDate = (s: string | null) =>
  s ? new Date(s).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—";

/** Maps a stored application row back onto the wizard form for edit & resubmit. */
const formFromApplication = (a: LaunchApplication): Form => ({
  raiseType: a.raise_type,
  companyName: a.company_name,
  oneLiner: a.one_liner,
  website: a.website ?? "",
  category: a.category,
  stage: a.stage ?? "",
  incorporation: a.incorporation ?? "Not yet",
  valuation: a.valuation ?? "",
  annualRevenue: a.annual_revenue ?? "",
  existingInvestors: a.existing_investors ?? "",
  problemOrWhy: a.problem_or_why ?? "",
  raiseAmount: a.raise_amount,
  equityOffered: a.equity_offered,
  minTicket: a.min_ticket ?? "$500",
  raiseStructure: a.raise_structure ?? "",
  cliffMonths: a.cliff_months,
  vestingMonths: a.vesting_months,
  founderName: a.founder_name ?? "",
  founderEmail: a.founder_email ?? "",
  founderTwitter: a.founder_twitter ?? "",
  founderLinkedin: a.founder_linkedin ?? "",
  founderWhy: a.founder_why ?? "",
  pitchDeck: a.pitch_deck ?? "",
});

const EVENT_LABEL: Record<ApplicationEvent["action"], string> = {
  submitted: "Submitted",
  resubmitted: "Resubmitted",
  approved: "Approved",
  rejected: "Rejected",
  needs_changes: "Changes requested",
};

const STATUS_TITLE: Record<ApplicationStatus, string> = {
  pending: "Application under review",
  needs_changes: "Changes requested",
  rejected: "Application not accepted",
  approved: "Application approved",
};

/** True when blank (optional) or a valid http(s) URL. */
const isOptionalUrl = (s: string) => {
  const v = s.trim();
  if (!v) return true;
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
};

// ── local presentation pieces (mx language, this page only) ────────────────

/** Required-field marker. Announced by the control's own `required` attribute. */
function Req() {
  return (
    <span aria-hidden="true" className="text-mx-ink-faint">
      {" *"}
    </span>
  );
}

/** Hairline progress rail — six segments, filled up to the current step. */
function Progress({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex gap-1" aria-hidden="true">
      {Array.from({ length: total }).map((_, i) => (
        <div
          key={i}
          className={cx("h-[3px] flex-1", i <= current ? "bg-mx-ink" : "bg-mx-rule")}
        />
      ))}
    </div>
  );
}

/** Mono step ledger: 01 Type · 02 Basics … current one in indigo. */
function StepLedger({
  steps,
  current,
}: {
  steps: { id: string; label: string }[];
  current: number;
}) {
  return (
    <div className="mt-3.5 flex flex-wrap gap-x-5 gap-y-1.5">
      {steps.map((s, i) => (
        <span
          key={s.id}
          className={cx(
            "font-mono text-[11px] uppercase tracking-[0.09em]",
            i === current ? "text-mx-indigo" : "text-mx-ink-faint",
          )}
        >
          {String(i + 1).padStart(2, "0")} {s.label}
        </span>
      ))}
    </div>
  );
}

/** Single-choice chips. Same contract as the wizard always had. */
function Choice({
  options,
  value,
  onChange,
  labelledBy,
}: {
  options: string[];
  value: string;
  onChange: (v: string) => void;
  labelledBy: string;
}) {
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-labelledby={labelledBy}>
      {options.map((o) => {
        const active = o === value;
        return (
          <button
            key={o}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(o)}
            className={cx(
              "rounded-[3px] border px-3.5 py-1.5 text-[13.5px] transition-colors",
              active
                ? "border-mx-ink bg-mx-ink text-mx-paper"
                : "border-mx-rule-strong text-mx-ink-soft hover:border-mx-ink hover:text-mx-ink",
            )}
          >
            {o}
          </button>
        );
      })}
    </div>
  );
}

/** Range control with a mono readout above it. */
function Range({
  id,
  value,
  min,
  max,
  step,
  onChange,
  format,
}: {
  id: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  format: (v: number) => string;
}) {
  return (
    <div>
      <div className="font-mono text-[21px] text-mx-ink">{format(value)}</div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-2 w-full"
        style={{ accentColor: "var(--mx-ink)" }}
      />
      <div className="mt-1 flex justify-between font-mono text-[11px] text-mx-ink-faint">
        <span>{format(min)}</span>
        <span>{format(max)}</span>
      </div>
    </div>
  );
}

/** Vesting bars — decorative; the sentence underneath carries the numbers. */
function PayoutBars({
  vestingMonths,
  cliffMonths,
}: {
  vestingMonths: number;
  cliffMonths: number;
}) {
  return (
    <div className="flex items-end gap-0.5" aria-hidden="true">
      {Array.from({ length: vestingMonths }).map((_, i) => (
        <div
          key={i}
          className={cx(
            "flex-1",
            i < cliffMonths ? "h-2 bg-mx-rule-strong" : "h-10 bg-mx-ink",
          )}
        />
      ))}
    </div>
  );
}

/** Three equal shares of the yield earned on funds still held back. */
function YieldSplit() {
  const parts: { label: string; className: string }[] = [
    { label: "You (founder)", className: "bg-mx-ink" },
    { label: "Investors", className: "bg-mx-ink-soft" },
    { label: "Platform", className: "bg-mx-rule-strong" },
  ];
  return (
    <div>
      <div className="flex h-2 overflow-hidden">
        {parts.map((p) => (
          <div key={p.label} className={cx("flex-1", p.className)} aria-hidden="true" />
        ))}
      </div>
      <div className="mt-2 flex justify-between font-mono text-[11px] text-mx-ink-faint">
        {parts.map((p) => (
          <span key={p.label}>{p.label}</span>
        ))}
      </div>
    </div>
  );
}

/** A ruled key/value strip — used for the implied valuation readout. */
function Readout({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border border-mx-rule bg-mx-surface px-4 py-3">
      <span className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-mx-ink-faint">
        {label}
      </span>
      <span className="font-mono text-[15px] text-mx-ink">{value}</span>
    </div>
  );
}

// ── page ───────────────────────────────────────────────────────────────────

export default function ApplyPage() {
  const conn = useWalletConnection();
  const walletAddress = conn.wallet?.account.address?.toString() ?? "";
  const toast = useToast();

  const [step, setStep] = useState(0);
  const [form, setForm] = useState<Form>(EMPTY);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [isResubmission, setIsResubmission] = useState(false);

  // ── existing-application state (review loop) ─────────────────────────────
  const [myApps, setMyApps] = useState<LaunchApplication[] | null>(null);
  const [appsLoading, setAppsLoading] = useState(false);
  // F08: the private read is a wallet signature + a fetch. Show which one the
  // user is waiting on, and never render a failed read as "no applications".
  const [readPhase, setReadPhase] = useState<ApplicationReadPhase>("loading");
  const [readError, setReadError] = useState<ApplicationReadFailure | null>(
    null,
  );
  const [readAttempt, setReadAttempt] = useState(0);
  const [events, setEvents] = useState<ApplicationEvent[]>([]);
  // Apply gate (onboarding + KYC). null = check unavailable → fail open
  // client-side; the signed submit route enforces the gate authoritatively.
  const [eligibility, setEligibility] = useState<ApplyEligibility | null>(null);
  const [eligibilityLoading, setEligibilityLoading] = useState(false);
  // Set when the founder chose "Start a new application" from a status panel.
  const [startNew, setStartNew] = useState(false);
  // Set when the founder is editing & resubmitting an existing application.
  const [editingApp, setEditingApp] = useState<LaunchApplication | null>(null);

  useEffect(() => {
    if (!walletAddress) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setMyApps(null);
      setEvents([]);
      setAppsLoading(false);
      setEligibility(null);
      setEligibilityLoading(false);
      setReadPhase("loading");
      setReadError(null);
      return;
    }
    let cancelled = false;
    setAppsLoading(true);
    setEligibilityLoading(true);
    setReadPhase("loading");
    setReadError(null);
    // Every signed call opens a wallet prompt; surface that wait explicitly.
    const session = withSigningObserver(conn.wallet, {
      onSignStart: () => {
        if (!cancelled) setReadPhase("signing");
      },
      onSignEnd: () => {
        if (!cancelled) setReadPhase("loading");
      },
    });
    void (async () => {
      // Signed self-read (launch_applications has no anon SELECT) — one call
      // returns the wallet's own applications AND the latest's event timeline.
      let rows: LaunchApplication[] = [];
      let latestEvents: ApplicationEvent[] = [];
      try {
        rows = await listMyApplications(session);
        const latest = rows[0];
        if (latest) {
          const detail = await getMyApplicationWithEvents(session, latest.id);
          latestEvents = detail.events;
        }
      } catch (e) {
        // A declined signature or an unreachable API is NOT an empty list:
        // keep `myApps` unknown and show the failure with a retry.
        if (cancelled) return;
        setReadError(classifyApplicationReadError(e));
        setReadPhase("error");
        setMyApps(null);
        setAppsLoading(false);
        setEvents([]);
        return;
      }
      if (cancelled) return;
      setMyApps(rows);
      setAppsLoading(false);
      setEvents(latestEvents);
      setReadPhase("ready");
    })();
    void (async () => {
      const kyc = await checkApplyEligibility(walletAddress);
      if (cancelled) return;
      setEligibility(kyc);
      setEligibilityLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [walletAddress, conn.wallet, readAttempt]);

  const latestApp = myApps?.[0] ?? null;

  const set = <K extends keyof Form>(k: K, v: Form[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  // ── computed ──────────────────────────────────────────────────────────────
  const implied = impliedValuation(form.raiseAmount, form.equityOffered);
  const monthly = monthlyPayout(form.raiseAmount, form.vestingMonths, form.cliffMonths);
  const yldEst = yieldEstimate(form.raiseAmount, form.vestingMonths);
  const isStartup = form.raiseType === "startup";
  const canContinue =
    step === 0 ? !!form.raiseType
    : step === 1 ? !!form.companyName.trim() && !!form.oneLiner.trim() && !!form.category && isOptionalUrl(form.website)
    : step === 2 ? !!form.stage && !!form.valuation.trim() && !!form.problemOrWhy.trim()
    : step === 3 ? !!form.raiseStructure
    : step === 4 ? !!form.founderName.trim() && isEmail(form.founderEmail) && !!form.founderWhy.trim() && isOptionalUrl(form.founderLinkedin) && isOptionalUrl(form.pitchDeck)
    : true;

  // ── submit ────────────────────────────────────────────────────────────────
  async function handleSubmit() {
    if (!walletAddress) {
      toast.showError(WALLET_CONNECT_LABEL, WALLET_CONNECT_DESCRIPTION,);
      return;
    }
    if (eligibility && !eligibility.eligible) {
      toast.showError(
        "Onboarding & KYC required",
        "Your wallet must be linked to a verified client profile before applying.",
      );
      return;
    }
    if (!form.raiseType) {
      toast.showError("Select a raise type", "Please go back to Step 1.");
      return;
    }
    // Re-assert all required fields — the wizard nav is not the source of truth.
    if (!form.companyName.trim() || !form.oneLiner.trim() || !form.category) {
      toast.showError("Missing company basics", "Please complete Step 2 (Basics).");
      return;
    }
    if (!form.stage || !form.valuation.trim() || !form.problemOrWhy.trim()) {
      toast.showError("Missing company details", "Please complete Step 3 (Company).");
      return;
    }
    if (!form.raiseStructure) {
      toast.showError("Missing raise structure", "Please complete Step 4 (Raise).");
      return;
    }
    if (!form.founderName.trim() || !isEmail(form.founderEmail) || !form.founderWhy.trim()) {
      toast.showError("Missing founder details", "Please complete Step 5 (Founder) with a valid email.");
      return;
    }
    if (!isOptionalUrl(form.website) || !isOptionalUrl(form.founderLinkedin) || !isOptionalUrl(form.pitchDeck)) {
      toast.showError("Invalid link", "Website, LinkedIn and pitch-deck links must start with http(s)://");
      return;
    }
    setSubmitting(true);
    const payload: NewApplication = {
      applicant_wallet: walletAddress,
      raise_type: form.raiseType as RaiseType,
      company_name: form.companyName,
      one_liner: form.oneLiner,
      website: form.website || null,
      category: form.category,
      stage: form.stage || null,
      incorporation: form.incorporation || null,
      valuation: form.valuation || null,
      annual_revenue: form.annualRevenue || null,
      existing_investors: form.existingInvestors || null,
      problem_or_why: form.problemOrWhy || null,
      raise_amount: form.raiseAmount,
      equity_offered: form.equityOffered,
      min_ticket: form.minTicket || null,
      raise_structure: form.raiseStructure || null,
      cliff_months: form.cliffMonths,
      vesting_months: form.vestingMonths,
      founder_name: form.founderName || null,
      founder_email: form.founderEmail || null,
      founder_twitter: form.founderTwitter || null,
      founder_linkedin: form.founderLinkedin || null,
      founder_why: form.founderWhy || null,
      pitch_deck: form.pitchDeck || null,
    };
    try {
      if (editingApp) {
        // Edit & resubmit: the signed route updates the SAME application row
        // (status back to pending, revision_count bumped) and logs the
        // "resubmitted" event server-side.
        await updateApplicationContent(conn.wallet, editingApp.id, payload);
        setIsResubmission(true);
        setDone(true);
      } else {
        // Signed route: server verifies the wallet signature, enforces the
        // KYC apply gate, stamps applicant_wallet, and logs "submitted".
        await submitApplication(conn.wallet, payload);
        setDone(true);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : "Please try again.";
      toast.showError(editingApp ? "Could not resubmit" : "Could not submit", message);
    } finally {
      setSubmitting(false);
    }
  }

  // ── success screen ────────────────────────────────────────────────────────
  if (done) {
    return (
      <>
        <PageHeader
          eyebrow="Application"
          title={isResubmission ? "Revision submitted" : "Application received"}
          lede={
            <>
              We&apos;ll review{" "}
              <span className="mx-strong">{form.companyName || "your company"}</span>{" "}
              and get back to you within 48 hours.
              {isResubmission
                ? " Your application went back into the review queue."
                : null}
            </>
          }
        />
        <Section>
          <InstrumentCard
            title="What you submitted"
            rows={[
              { label: "Raising", value: fmtM(form.raiseAmount) },
              { label: "Equity offered", value: `${form.equityOffered}%` },
              {
                label: isStartup ? "Payout" : "Disbursement",
                value: isStartup ? "Vested monthly" : "Instant on close",
              },
            ]}
          />
          <FootNote className="mt-4">
            A person reads every application, and we come back to you either way.
          </FootNote>
        </Section>
      </>
    );
  }

  // ── loading ───────────────────────────────────────────────────────────────
  if (walletAddress && ((appsLoading && myApps === null) || eligibilityLoading)) {
    const phase = readPhase === "signing" ? "signing" : "loading";
    return (
      <PageHeader eyebrow="Application" title="Apply to issue">
        <div role="status" aria-live="polite">
          <Small className="mt-6">{applicationReadStatusCopy(phase)}</Small>
        </div>
      </PageHeader>
    );
  }

  // ── private read failed ───────────────────────────────────────────────────
  // Not the same as "no applications": the wallet declined, the wallet cannot
  // sign, or the API was unreachable. Offer a retry instead of the blank form.
  if (walletAddress && readPhase === "error" && readError) {
    return (
      <>
        <PageHeader eyebrow="Application" title="Apply to issue" />
        <Section>
          <Card className="mx-card--attention">
            <Eyebrow>
              {readError.kind === "signature_rejected"
                ? "Wallet request declined"
                : readError.kind === "signing_unsupported"
                  ? "Wallet cannot sign messages"
                  : "Could not read your applications"}
            </Eyebrow>
            <div role="alert">
              <Body className="mt-2">{readError.message}</Body>
            </div>
            <FootNote className="mt-2 break-words">
              Details: {readError.detail}
            </FootNote>
            <ButtonRow className="mt-4">
              <Button onClick={() => setReadAttempt((n) => n + 1)}>
                {readError.kind === "signature_rejected"
                  ? "Sign again"
                  : "Retry"}
              </Button>
            </ButtonRow>
          </Card>
        </Section>
      </>
    );
  }

  // ── existing-application status panel ─────────────────────────────────────
  if (walletAddress && latestApp && !startNew && !editingApp) {
    const status = latestApp.status;
    const company = <span className="mx-strong">{latestApp.company_name}</span>;

    const lede =
      status === "pending" ? (
        <>
          Your application for {company} was submitted on{" "}
          {fmtDate(latestApp.submitted_at ?? latestApp.created_at)} and is being
          reviewed by our team. We&apos;ll get back to you within 48 hours.
        </>
      ) : status === "needs_changes" ? (
        <>
          Our team reviewed {company} and needs a few changes before it can move
          forward. You can edit your application and resubmit — it goes back to
          the same review queue.
        </>
      ) : status === "rejected" ? (
        <>
          We reviewed {company} and decided not to move forward with this
          application. You&apos;re welcome to submit a fresh application at any
          time.
        </>
      ) : (
        <>
          Congratulations — {company} was approved. Complete issuer onboarding if
          you haven&apos;t yet, then open your sale.
        </>
      );

    const actions =
      status === "needs_changes" ? (
        <Button
          onClick={() => {
            setForm(formFromApplication(latestApp));
            setEditingApp(latestApp);
            setStep(0);
          }}
        >
          Edit &amp; resubmit
        </Button>
      ) : status === "approved" ? (
        <>
          <Button href={`/issuer/launchpad?application=${latestApp.id}`}>
            Open your sale →
          </Button>
          <Button href="/issuer/onboarding" variant="ghost">
            Issuer onboarding
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setStartNew(true)}>
            Start a new application
          </Button>
        </>
      ) : (
        <Button variant="ghost" onClick={() => setStartNew(true)}>
          Start a new application
        </Button>
      );

    const reasonBlock =
      (status === "needs_changes" || status === "rejected") &&
      latestApp.review_reason ? (
        <Card
          className="max-w-[640px]"
          title={status === "needs_changes" ? "What to change" : "Reason"}
        >
          <p className="whitespace-pre-wrap">{latestApp.review_reason}</p>
        </Card>
      ) : null;

    const timeline =
      events.length > 0 ? (
        <div
          className={cx(
            "max-w-[640px] border border-mx-rule bg-mx-surface p-5",
            reasonBlock && "mt-4",
          )}
        >
          <Eyebrow>History</Eyebrow>
          <ol className="mt-2 space-y-2.5">
            {events.map((ev) => (
              <li key={ev.id} className="flex items-start gap-3 text-[14px]">
                <span
                  aria-hidden="true"
                  className="mt-[9px] h-[5px] w-[5px] shrink-0 bg-mx-rule-strong"
                />
                <div className="min-w-0">
                  <p>
                    <span className="mx-strong">{EVENT_LABEL[ev.action]}</span>
                    <span className="text-mx-ink-faint">
                      {" · "}
                      {fmtDate(ev.created_at)}
                    </span>
                  </p>
                  {ev.reason ? (
                    <p className="mt-0.5 text-[13px] text-mx-ink-soft">
                      {ev.reason}
                    </p>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        </div>
      ) : null;

    return (
      <>
        <PageHeader
          eyebrow="Application status"
          title={STATUS_TITLE[status]}
          lede={lede}
        >
          {latestApp.revision_count > 0 ? (
            <p className="mt-5">
              <Badge>Revision {latestApp.revision_count}</Badge>
            </p>
          ) : null}
          <ButtonRow>{actions}</ButtonRow>
        </PageHeader>
        {reasonBlock || timeline ? (
          <Section>
            {reasonBlock}
            {timeline}
          </Section>
        ) : null}
      </>
    );
  }

  // ── apply gate: onboarding + verified KYC required to submit ──────────────
  // Renders INSTEAD of the wizard when the connected wallet has no verified
  // client profile. Existing-application status panels above stay reachable.
  // eligibility === null (check unavailable) fails open — the signed submit
  // route enforces the gate authoritatively either way.
  if (!walletAddress || (eligibilityLoading && !eligibility) || (eligibility && !eligibility.eligible)) {
    const checking = !!walletAddress && eligibilityLoading && !eligibility;
    const status = eligibility?.kycStatus ?? null;
    const inProgress = status === "pending" || status === "more_info";
    return (
      <>
        <PageHeader
          eyebrow="Application"
          title={checking ? "Checking your verification…" : !walletAddress ? "Verification required" : inProgress ? "Your verification is in progress" : "Your account is not verified"}
          lede={
            checking ? "One moment while we check your account." : !walletAddress ? (
              <>Raising capital on Manci requires a verified account (KYC). Connect your wallet to check your status or start verification.</>
            ) : inProgress ? (
              <>We are reviewing your verification{status === "more_info" ? " and still need some documents" : ""}. Once it is approved you can submit your application here.</>
            ) : (
              <>A verified account (KYC) is required for these services. Complete verification first — it takes a few minutes — and then come back to submit your application.</>
            )
          }
        >
          {!checking && (walletAddress ? (
            <ButtonRow>
              <Button href={`/verify?type=kyc&next=/apply`}>{inProgress ? "Continue verification" : "Complete KYC"}</Button>
              <Button variant="ghost" href={`/verify?type=kyb&next=/apply`}>Raising as a company? Verify company (KYB)</Button>
              {latestApp ? (
                <Button variant="ghost" onClick={() => { setStartNew(false); setEditingApp(null); }}>View my existing application</Button>
              ) : null}
            </ButtonRow>
          ) : <WalletRequired className="mt-6" />)}
          {walletAddress && !checking ? (
            <FootNote className="mt-5">
              Connected wallet: <span className="font-mono break-all">{walletAddress}</span>
              {status ? <> · status: <span className="font-mono">{status}</span></> : null}
            </FootNote>
          ) : null}
        </PageHeader>
      </>
    );
  }

  // ── the wizard ────────────────────────────────────────────────────────────
  return (
    <>
      <PageHeader
        eyebrow="Application"
        title="Apply to issue"
        lede="A person reads every application, and we come back to you either way."
      />

      <Section>
        <div className="max-w-[600px]">
          {editingApp ? (
            <Card className="mb-8" title="Editing an existing application">
              <p>
                You&apos;re editing your existing application for{" "}
                <span className="mx-strong">{editingApp.company_name}</span>.
                Submitting will resubmit the same application for review.
              </p>
            </Card>
          ) : null}

          {!walletAddress && <WalletRequired className="mb-8" />}

          <Progress current={step} total={STEPS.length} />
          <StepLedger steps={STEPS} current={step} />
          <p className="sr-only" aria-live="polite">
            Step {step + 1} of {STEPS.length}: {STEPS[step].label}
          </p>

          {/* ── STEP 0: Type ────────────────────────────────────────────── */}
          {step === 0 && (
            <div className="mt-8">
              <H2>What type of raise is this?</H2>
              <Body className="mt-4">
                This determines how and when you receive funds.
              </Body>

              <Card className="mt-6" title="This form is for equity raises">
                <p>
                  Tokenizing a bond, real estate, a royalty, a revenue share or
                  goods?{" "}
                  <TextLink href={MX_ROUTES.contact}>Contact the team</TextLink>{" "}
                  and we&apos;ll scope it with you.
                </p>
              </Card>

              <div className="mt-6 flex flex-col gap-3">
                {(
                  [
                    {
                      value: "startup" as const,
                      title: "Startup raising capital",
                      badge: "Vested payout",
                      body: "You're building something new and need capital to grow. Early-stage or pre-revenue.",
                      note: "Funds vested over time to build investor confidence.",
                    },
                    {
                      value: "mature" as const,
                      title: "Established company",
                      badge: "Instant payout",
                      body: "Your company has revenue, customers, and a track record. You're selling a piece of what you've already built.",
                      note: "Funds disbursed immediately upon close.",
                    },
                  ] satisfies {
                    value: RaiseType;
                    title: string;
                    badge: string;
                    body: string;
                    note: string;
                  }[]
                ).map((opt) => {
                  const active = form.raiseType === opt.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      aria-pressed={active}
                      onClick={() => set("raiseType", opt.value)}
                      className={cx(
                        "mx-card text-left transition-colors",
                        active
                          ? "border-mx-ink shadow-[inset_0_0_0_1px_var(--mx-ink)]"
                          : "hover:border-mx-rule-strong",
                      )}
                    >
                      <div className="mb-2 flex flex-wrap items-center gap-2.5">
                        <H3>{opt.title}</H3>
                        <Badge>{opt.badge}</Badge>
                      </div>
                      <p>{opt.body}</p>
                      <p className="mt-2 font-mono text-[11.5px] text-mx-ink-faint">
                        {opt.note}
                      </p>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* ── STEP 1: Basics ──────────────────────────────────────────── */}
          {step === 1 && (
            <div className="mt-8">
              <H2>What are you building?</H2>
              <Body className="mt-4 mb-7">
                Tell us the basics. This takes 2 minutes.
              </Body>

              <Field
                id="companyName"
                label={
                  <>
                    Company name
                    <Req />
                  </>
                }
              >
                <Input
                  id="companyName"
                  name="companyName"
                  required
                  value={form.companyName}
                  onChange={(e) => set("companyName", e.target.value)}
                  placeholder="e.g. Acme Protocol"
                />
              </Field>

              <Field
                id="oneLiner"
                label={
                  <>
                    One-liner
                    <Req />
                  </>
                }
                hint="Describe what you do in one sentence."
              >
                <Input
                  id="oneLiner"
                  name="oneLiner"
                  required
                  value={form.oneLiner}
                  onChange={(e) => set("oneLiner", e.target.value)}
                  placeholder="e.g. On-chain payroll for remote teams"
                />
              </Field>

              <Field id="website" label="Website">
                <Input
                  id="website"
                  name="website"
                  type="url"
                  value={form.website}
                  onChange={(e) => set("website", e.target.value)}
                  placeholder="https://"
                />
              </Field>

              <div className="mx-field">
                <p className="mx-label" id="category-label">
                  Category
                  <Req />
                </p>
                <Choice
                  labelledBy="category-label"
                  options={CATEGORIES}
                  value={form.category}
                  onChange={(v) => set("category", v)}
                />
              </div>
            </div>
          )}

          {/* ── STEP 2: Company ─────────────────────────────────────────── */}
          {step === 2 && (
            <div className="mt-8">
              <H2>About the company</H2>
              <Body className="mt-4 mb-7">
                Help backers understand where you are today.
              </Body>

              <div className="mx-field">
                <p className="mx-label" id="stage-label">
                  Stage
                  <Req />
                </p>
                <Choice
                  labelledBy="stage-label"
                  options={isStartup ? STAGES_STARTUP : STAGES_MATURE}
                  value={form.stage}
                  onChange={(v) => set("stage", v)}
                />
              </div>

              <Field
                id="incorporation"
                label="Incorporation"
                hint="Company ownership, debt and revenue share are issued through a Serbian SPV. If you don't have a Serbian company, we incorporate one."
              >
                <Select
                  id="incorporation"
                  name="incorporation"
                  value={form.incorporation}
                  onChange={(e) => set("incorporation", e.target.value)}
                >
                  {INCORP.map((opt) => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field
                id="valuation"
                label={
                  <>
                    Current valuation
                    <Req />
                  </>
                }
                hint="What valuation are you selling equity at?"
              >
                <Input
                  id="valuation"
                  name="valuation"
                  required
                  value={form.valuation}
                  onChange={(e) => set("valuation", e.target.value)}
                  placeholder="e.g. €10M"
                />
              </Field>

              {!isStartup && (
                <Field
                  id="annualRevenue"
                  label="Annual revenue"
                  hint="Approximate current ARR or annual revenue."
                >
                  <Input
                    id="annualRevenue"
                    name="annualRevenue"
                    value={form.annualRevenue}
                    onChange={(e) => set("annualRevenue", e.target.value)}
                    placeholder="e.g. €2.5M ARR"
                  />
                </Field>
              )}

              <Field
                id="existingInvestors"
                label="Existing investors"
                hint="Any notable backers? Leave blank if none."
              >
                <Input
                  id="existingInvestors"
                  name="existingInvestors"
                  value={form.existingInvestors}
                  onChange={(e) => set("existingInvestors", e.target.value)}
                  placeholder="e.g. Paradigm, Angel Collective"
                />
              </Field>

              <Field
                id="problemOrWhy"
                label={
                  <>
                    {isStartup
                      ? "What problem are you solving?"
                      : "Why are you selling equity?"}
                    <Req />
                  </>
                }
              >
                <Textarea
                  id="problemOrWhy"
                  name="problemOrWhy"
                  required
                  rows={4}
                  value={form.problemOrWhy}
                  onChange={(e) => set("problemOrWhy", e.target.value)}
                  placeholder={
                    isStartup
                      ? "Describe the pain point and why existing solutions fall short."
                      : "Why are you raising? Growth, expansion, M&A, liquidity event?"
                  }
                />
              </Field>
            </div>
          )}

          {/* ── STEP 3: Raise ───────────────────────────────────────────── */}
          {step === 3 && (
            <div className="mt-8">
              <H2>Structure your raise</H2>
              <Body className="mt-4">
                Issuance is capped at EUR 3 million per SPV per year. Backers
                receive tokens carrying the right to convert into shares, and
                conversion runs through the standard legal share-transfer
                procedure.
                {isStartup
                  ? " Funds are vested to build investor confidence."
                  : " Funds are disbursed immediately upon close."}
              </Body>

              <div className="mx-field mt-7">
                <label className="mx-label" htmlFor="raiseAmount">
                  How much are you raising?
                  <Req />
                </label>
                <p className="mb-2 text-[12.5px] text-mx-ink-faint">
                  Annual equity sale, maximum EUR 3 million.
                </p>
                <Range
                  id="raiseAmount"
                  value={form.raiseAmount}
                  min={50000}
                  max={3000000}
                  step={50000}
                  format={fmtM}
                  onChange={(v) => set("raiseAmount", v)}
                />
              </div>

              <div className="mx-field mt-7">
                <label className="mx-label" htmlFor="equityOffered">
                  Equity offered
                  <Req />
                </label>
                <p className="mb-2 text-[12.5px] text-mx-ink-faint">
                  What percentage of the company are you selling for this raise?
                </p>
                <Range
                  id="equityOffered"
                  value={form.equityOffered}
                  min={1}
                  max={30}
                  step={0.5}
                  format={(v) => `${v}%`}
                  onChange={(v) => set("equityOffered", v)}
                />
              </div>

              <Readout label="Implied valuation" value={fmtM(implied)} />

              {isStartup && (
                <>
                  <div className="mx-field mt-7">
                    <p className="mx-label" id="vesting-label">
                      Disbursement schedule
                      <Req />
                    </p>
                    <p className="mb-2 text-[12.5px] text-mx-ink-faint">
                      How long should funds vest? You&apos;ll receive equal
                      monthly payouts over this period.
                    </p>
                    <div
                      className="flex gap-2"
                      role="group"
                      aria-labelledby="vesting-label"
                    >
                      {[6, 12, 18, 24].map((n) => {
                        const active = form.vestingMonths === n;
                        return (
                          <button
                            key={n}
                            type="button"
                            aria-pressed={active}
                            onClick={() => set("vestingMonths", n)}
                            className={cx(
                              "flex-1 rounded-[3px] border px-2 py-3 text-center transition-colors",
                              active
                                ? "border-mx-ink bg-mx-ink text-mx-paper"
                                : "border-mx-rule-strong text-mx-ink-soft hover:border-mx-ink",
                            )}
                          >
                            <span className="block font-mono text-[19px]">
                              {n}
                            </span>
                            <span className="block font-mono text-[10px] uppercase tracking-[0.1em]">
                              months
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div className="mx-field mt-7">
                    <p className="mx-label" id="cliff-label">
                      Cliff period
                    </p>
                    <p className="mb-2 text-[12.5px] text-mx-ink-faint">
                      Optional. No funds disbursed during the cliff — proves
                      commitment before the first payout.
                    </p>
                    <Choice
                      labelledBy="cliff-label"
                      options={["No cliff", "1 month", "2 months", "3 months"]}
                      value={
                        form.cliffMonths === 0
                          ? "No cliff"
                          : form.cliffMonths === 1
                            ? "1 month"
                            : `${form.cliffMonths} months`
                      }
                      onChange={(v) =>
                        set("cliffMonths", v === "No cliff" ? 0 : parseInt(v, 10))
                      }
                    />
                  </div>

                  <div className="mt-7 border border-mx-rule bg-mx-surface p-5">
                    <Eyebrow>Your payout schedule</Eyebrow>
                    <div className="mt-4">
                      <PayoutBars
                        vestingMonths={form.vestingMonths}
                        cliffMonths={form.cliffMonths}
                      />
                    </div>
                    <p className="mt-4 text-[13px] text-mx-ink-soft">
                      Monthly payout{" "}
                      <span className="mx-strong font-mono">
                        {fmtEur(monthly)}
                      </span>
                      {" · "}First payout month{" "}
                      <span className="mx-strong font-mono">
                        {form.cliffMonths + 1}
                      </span>
                      {" · "}Estimated yield{" "}
                      <span className="mx-strong font-mono">
                        {fmtEur(yldEst)}
                      </span>
                    </p>
                    <div className="mt-5">
                      <Eyebrow>Yield split on unvested funds</Eyebrow>
                      <div className="mt-3">
                        <YieldSplit />
                      </div>
                    </div>
                  </div>

                  <Card className="mt-4" title="Unlocking each payout">
                    <p>
                      The founder posts a monthly update to unlock each payout.
                      Miss three consecutive updates and the remaining unvested
                      funds freeze — investors then get a 30-day window to vote:
                      return capital, or extend the runway.
                    </p>
                  </Card>
                </>
              )}

              {!isStartup && (
                <Card className="mt-7" title="Instant disbursement">
                  <p>
                    Full proceeds are released to you when the sale closes.
                  </p>
                </Card>
              )}

              <Field
                id="minTicket"
                label="Minimum ticket"
                hint="Smallest amount a single backer can invest."
                className="mt-7"
              >
                <Select
                  id="minTicket"
                  name="minTicket"
                  value={form.minTicket}
                  onChange={(e) => set("minTicket", e.target.value)}
                >
                  {MIN_TICKETS.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </Select>
              </Field>

              <div className="mx-field">
                <p className="mx-label" id="structure-label">
                  Raise structure
                  <Req />
                </p>
                <Choice
                  labelledBy="structure-label"
                  options={
                    isStartup
                      ? ["SAFE", "Convertible note", "Equity (priced round)"]
                      : ["Equity (priced round)", "Revenue share", "SAFE"]
                  }
                  value={form.raiseStructure}
                  onChange={(v) => set("raiseStructure", v)}
                />
              </div>
            </div>
          )}

          {/* ── STEP 4: Founder ─────────────────────────────────────────── */}
          {step === 4 && (
            <div className="mt-8">
              <H2>About you</H2>
              <Body className="mt-4 mb-7">Backers invest in people first.</Body>

              <Field
                id="founderName"
                label={
                  <>
                    Your name
                    <Req />
                  </>
                }
              >
                <Input
                  id="founderName"
                  name="founderName"
                  required
                  value={form.founderName}
                  onChange={(e) => set("founderName", e.target.value)}
                  placeholder="Full name"
                />
              </Field>

              <Field
                id="founderEmail"
                label={
                  <>
                    Email
                    <Req />
                  </>
                }
              >
                <Input
                  id="founderEmail"
                  name="founderEmail"
                  type="email"
                  required
                  value={form.founderEmail}
                  onChange={(e) => set("founderEmail", e.target.value)}
                  placeholder="you@company.com"
                />
              </Field>

              <Field id="founderTwitter" label="X (Twitter)">
                <Input
                  id="founderTwitter"
                  name="founderTwitter"
                  value={form.founderTwitter}
                  onChange={(e) => set("founderTwitter", e.target.value)}
                  placeholder="@handle"
                />
              </Field>

              <Field id="founderLinkedin" label="LinkedIn or personal site">
                <Input
                  id="founderLinkedin"
                  name="founderLinkedin"
                  type="url"
                  value={form.founderLinkedin}
                  onChange={(e) => set("founderLinkedin", e.target.value)}
                  placeholder="https://"
                />
              </Field>

              <Field
                id="founderWhy"
                label={
                  <>
                    Why are you the right person to build this?
                    <Req />
                  </>
                }
                hint="Background, domain expertise, unfair advantages…"
              >
                <Textarea
                  id="founderWhy"
                  name="founderWhy"
                  required
                  rows={4}
                  value={form.founderWhy}
                  onChange={(e) => set("founderWhy", e.target.value)}
                  placeholder="e.g. Former lead engineer at …; shipped X to Y users"
                />
              </Field>

              <Field
                id="pitchDeck"
                label="Pitch deck or docs"
                hint="Link to your deck, notion page, or supporting materials."
              >
                <Input
                  id="pitchDeck"
                  name="pitchDeck"
                  type="url"
                  value={form.pitchDeck}
                  onChange={(e) => set("pitchDeck", e.target.value)}
                  placeholder="https://…"
                />
              </Field>
            </div>
          )}

          {/* ── STEP 5: Review ──────────────────────────────────────────── */}
          {step === 5 && (
            <div className="mt-8">
              <H2>Review your application</H2>
              <Body className="mt-4 mb-7">
                Make sure everything looks right before submitting.
              </Body>

              <InstrumentCard
                className="max-w-none"
                title={form.companyName || "Your application"}
                rows={[
                  {
                    label: "Raise type",
                    value: isStartup
                      ? "Startup (vested)"
                      : "Established (instant)",
                  },
                  { label: "Company", value: form.companyName },
                  { label: "One-liner", value: form.oneLiner },
                  { label: "Category", value: form.category },
                  { label: "Stage", value: form.stage },
                  { label: "Incorporation", value: form.incorporation },
                  { label: "Valuation", value: form.valuation },
                  { label: "Raising", value: fmtM(form.raiseAmount) },
                  { label: "Equity", value: `${form.equityOffered}%` },
                  { label: "Implied valuation", value: fmtM(implied) },
                  ...(isStartup
                    ? [
                        {
                          label: "Vesting",
                          value: `${form.vestingMonths} months linear`,
                        },
                        {
                          label: "Cliff",
                          value:
                            form.cliffMonths > 0
                              ? `${form.cliffMonths} month${form.cliffMonths > 1 ? "s" : ""}`
                              : "None",
                        },
                        {
                          label: "Monthly payout",
                          value: `${fmtEur(monthly)}/mo`,
                        },
                      ]
                    : [{ label: "Disbursement", value: "Immediate upon close" }]),
                  { label: "Structure", value: form.raiseStructure },
                  { label: "Min ticket", value: form.minTicket },
                  { label: "Founder", value: form.founderName },
                  { label: "Email", value: form.founderEmail },
                ]}
              />

              <FootNote className="mt-5">
                We use these details only to assess your application. See our{" "}
                <TextLink href={MX_ROUTES.privacy}>privacy policy</TextLink> for
                how we store and handle them.
              </FootNote>
            </div>
          )}

          {/* ── footer nav ──────────────────────────────────────────────── */}
          <div className="mt-10 flex justify-between gap-3">
            <Button
              variant="ghost"
              disabled={step === 0}
              onClick={() => setStep((s) => s - 1)}
            >
              Back
            </Button>
            {step === STEPS.length - 1 ? (
              <Button disabled={submitting} onClick={() => void handleSubmit()}>
                {submitting
                  ? "Submitting…"
                  : editingApp
                    ? "Resubmit application"
                    : "Submit application"}
              </Button>
            ) : (
              <Button
                disabled={!canContinue}
                onClick={() => setStep((s) => s + 1)}
              >
                Continue
              </Button>
            )}
          </div>
        </div>
      </Section>
    </>
  );
}
