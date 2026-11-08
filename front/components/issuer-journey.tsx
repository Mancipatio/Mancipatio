// The issuer journey (lib/issuer-journey.ts) as a list of the eight steps:
// each with its state, who acts, one sentence and the page where it happens.
// The issuer workspace renders it at the top (audience "issuer"); the admin
// issuer detail renders it read-only (audience "admin": the same states, with
// "waiting on the issuer" for the company's turn, and links into the admin
// console). No hooks: the reads are lib/use-issuer-journey.ts, and tests
// render this statically (tests/issuer-journey.test.ts).
//
// Hidden links stay hidden: a step's href is already null when navHrefVisible
// refuses it (KYC-only mode, a switched-off module), so the list never offers
// an entry the platform has paused. While issuance is paused the panel says
// that the status is shown for reference.
import Link from "next/link";
import type { IssuerJourney, JourneyActor, JourneyAudience, JourneyState, JourneyStep } from "@/lib/issuer-journey";

const STATE_LABEL: Record<JourneyAudience, Record<JourneyState, string>> = {
  issuer: {
    done: "Done",
    in_progress: "In progress",
    waiting_on_manci: "Waiting on Manci",
    waiting_on_you: "Your turn",
    not_started: "Not started",
    not_applicable: "Not applicable",
  },
  admin: {
    done: "Done",
    in_progress: "In progress",
    waiting_on_manci: "Waiting on Manci",
    waiting_on_you: "Waiting on the issuer",
    not_started: "Not started",
    not_applicable: "Not applicable",
  },
};

const ACTOR_LABEL: Record<JourneyAudience, Record<JourneyActor, string>> = {
  issuer: { issuer: "You", manci: "Manci", holders: "Token holders" },
  admin: { issuer: "Issuer", manci: "Manci", holders: "Token holders" },
};

const STATE_TONE: Record<JourneyState, string> = {
  done: "border-emerald-200 bg-emerald-50 text-emerald-800",
  in_progress: "border-sky-200 bg-sky-50 text-sky-800",
  waiting_on_manci: "border-indigo-200 bg-indigo-50 text-indigo-800",
  waiting_on_you: "border-amber-300 bg-amber-50 text-amber-900",
  not_started: "border-slate-200 bg-slate-50 text-slate-600",
  not_applicable: "border-dashed border-slate-300 bg-white text-slate-500",
};

/** The chip of a step: its state, or "Not loaded" when the data behind it could not be read. */
export function journeyStateLabel(step: Pick<JourneyStep, "state" | "unknown">, audience: JourneyAudience): string {
  return step.unknown ? "Not loaded" : STATE_LABEL[audience][step.state];
}

export function IssuerJourneyTracker({
  journey,
  audience,
  companyName,
  loading = false,
  unavailable = [],
  onRetry,
}: {
  journey: IssuerJourney;
  audience: JourneyAudience;
  /** Shown in the heading when known (the issuer profile's company name). */
  companyName?: string | null;
  /** The first read is still running: the steps may still change. */
  loading?: boolean;
  /** Reads that failed (lib/use-issuer-journey.ts). */
  unavailable?: readonly string[];
  onRetry?: () => void;
}) {
  const you = audience === "issuer";
  const next = journey.next;
  return (
    <section
      aria-labelledby={`issuer-journey-${audience}`}
      className="mt-6 rounded-xl border border-slate-200 bg-white p-5 shadow-card"
      data-issuer-journey={audience}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
            {you ? "Where you are" : "Issuance journey · read-only"}
          </p>
          <h2 id={`issuer-journey-${audience}`} className="mt-1 text-base font-semibold text-slate-900">
            {companyName ? `${companyName}: from verification to holders` : "From verification to holders"}
          </h2>
        </div>
        {loading && (
          <span role="status" className="text-xs text-slate-500">
            Checking the latest status…
          </span>
        )}
      </div>

      {next ? (
        <p className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700" data-journey-next={next.id}>
          <span className="font-semibold text-slate-900">
            Next: {ACTOR_LABEL[audience][next.actor]} · {next.title}.
          </span>{" "}
          {next.explanation}
        </p>
      ) : (
        <p className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
          Nothing is waiting on anyone right now.
        </p>
      )}

      {journey.paused && (
        <p className="mt-3 text-xs text-slate-500" data-journey-paused>
          Issuance is paused for now, so the actions are hidden; the status below is shown for reference.
        </p>
      )}

      {unavailable.length > 0 && (
        <div role="alert" className="mt-3 flex flex-wrap items-center gap-3 text-xs text-amber-900">
          <span>
            Could not load {unavailable.join(", ")}; the steps that depend on {unavailable.length === 1 ? "it" : "them"} say so.
          </span>
          {onRetry && (
            <button type="button" onClick={onRetry} className="font-medium underline underline-offset-2">
              Try again
            </button>
          )}
        </div>
      )}

      <ol className="mt-4 space-y-2" aria-label={you ? "Your issuance steps" : "Issuance steps"}>
        {journey.steps.map((step) => (
          <li
            key={step.id}
            data-step={step.id}
            data-state={step.state}
            aria-current={next?.id === step.id ? "step" : undefined}
            className={`grid gap-x-3 gap-y-1 rounded-lg border px-3 py-2.5 sm:grid-cols-[2rem_minmax(0,1fr)_auto] ${
              next?.id === step.id ? "border-slate-400 bg-slate-50/70" : "border-slate-100"
            }`}
          >
            <span
              aria-hidden="true"
              className={`flex h-7 w-7 items-center justify-center rounded-full border text-xs font-semibold ${
                step.state === "done" ? "border-emerald-700 bg-emerald-700 text-white" : "border-slate-300 text-slate-600"
              }`}
            >
              {step.state === "done" ? "✓" : step.number}
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-semibold text-slate-900">
                  <span className="sr-only">Step {step.number}: </span>
                  {step.title}
                </h3>
                <span className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${STATE_TONE[step.state]}`}>
                  {journeyStateLabel(step, audience)}
                </span>
                {step.state !== "done" && step.state !== "not_applicable" && (
                  <span className="text-[11px] text-slate-500">{ACTOR_LABEL[audience][step.actor]}</span>
                )}
                {step.offChain && (
                  <span className="rounded border border-slate-200 px-1.5 py-px text-[10px] uppercase tracking-wide text-slate-500" title="Part of this step happens outside the platform">
                    Off-chain
                  </span>
                )}
              </div>
              <p className="mt-0.5 text-[13px] leading-relaxed text-slate-600">{step.explanation}</p>
            </div>
            {step.href && step.linkLabel ? (
              <Link
                href={step.href}
                className="self-center text-xs font-medium text-slate-800 underline decoration-slate-300 underline-offset-2 hover:text-slate-950 sm:justify-self-end"
              >
                {step.linkLabel} →
              </Link>
            ) : (
              <span aria-hidden="true" />
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
