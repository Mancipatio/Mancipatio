// A conversion request's timeline (lib/conversion-timeline.ts), drawn two
// ways: "full" (every step with its typical duration, the current step, who
// acts next and the on-chain vault deadline) for the holder's
// /portfolio/conversion, and "compact" (a five-segment bar and one line) for
// table cells, the holder's and the read-only one on /admin/custody. No
// state, no chain or database read: the caller passes the status, whether a
// vault was ever linked and the deadline it read from the vault.

import {
  CONVERSION_DURATIONS_NOTE,
  conversionTimeline,
  conversionTimelineSummary,
  formatConversionDeadline,
  type ConversionActor,
  type ConversionStepState,
  type ConversionTimeline,
} from "@/lib/conversion-timeline";

type Audience = "holder" | "operator";

const ACTOR_LABEL: Record<Audience, Record<ConversionActor, string>> = {
  holder: { manci: "Manci", holder: "You" },
  operator: { manci: "Manci", holder: "Holder" },
};

export type ConversionTimelineProps = {
  status: string;
  /** conversion_requests.vault_pda is set: a cancel after approval reads differently. */
  hasVault: boolean;
  /** The vault's on-chain deadline (unix seconds), when the page read it. */
  vaultDeadlineSec?: bigint | number | null;
  /** The chain clock (lib/use-chain-clock), for "passed" and the days left. */
  nowSec: bigint | number;
  audience?: Audience;
};

function daysLeft(timeline: ConversionTimeline, nowSec: number): number | null {
  if (!timeline.deadline || timeline.deadline.passed) return null;
  return Math.max(0, Math.floor((timeline.deadline.atSec - nowSec) / 86_400));
}

function DeadlineLine({ timeline, nowSec }: { timeline: ConversionTimeline; nowSec: number }) {
  if (!timeline.deadline) return null;
  const at = formatConversionDeadline(timeline.deadline.atSec);
  const left = daysLeft(timeline, nowSec);
  return (
    <p className={`text-xs ${timeline.deadline.passed ? "text-red-700" : left !== null && left < 7 ? "text-amber-700" : "text-slate-600"}`}>
      On-chain vault deadline: <span className="font-mono">{at}</span>
      {timeline.deadline.passed ? " (passed)" : left !== null ? ` (${left} ${left === 1 ? "day" : "days"} left)` : ""}
    </p>
  );
}

function StepMarker({ state }: { state: ConversionStepState }) {
  if (state === "done") {
    return (
      <span aria-hidden="true" className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-[11px] font-bold text-white">
        ✓
      </span>
    );
  }
  if (state === "current") {
    return <span aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 rounded-full border-2 border-brand-600 bg-brand-100" />;
  }
  return <span aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 rounded-full border-2 border-slate-200" />;
}

const STATE_TEXT: Record<ConversionStepState, string> = {
  done: "done",
  current: "current step",
  upcoming: "upcoming",
  skipped: "not reached",
};

/** Every step with its typical duration, the current one marked, who acts next and the vault deadline. */
export function ConversionTimelineFull({ audience = "holder", ...props }: ConversionTimelineProps) {
  const nowSec = Number(props.nowSec);
  const timeline = conversionTimeline({ ...props, nowSec });
  if (!timeline.known) return null;
  const actors = ACTOR_LABEL[audience];
  return (
    <div className="space-y-3">
      <ol aria-label="Conversion steps" className="space-y-2.5">
        {timeline.steps.map((step) => (
          <li key={step.id} aria-current={step.state === "current" ? "step" : undefined}>
            <div className="flex gap-3">
              <StepMarker state={step.state} />
              <div className="min-w-0 flex-1">
                <p className={`text-sm font-medium ${step.state === "skipped" || step.state === "upcoming" ? "text-slate-400" : "text-slate-900"}`}>
                  {step.label}
                  <span className="sr-only"> ({STATE_TEXT[step.state]})</span>
                  {step.state === "current" && (
                    <span aria-hidden="true" className="ml-2 rounded-full bg-brand-100 px-2 py-0.5 align-middle text-[10px] font-semibold uppercase tracking-wide text-brand-800">
                      Now
                    </span>
                  )}
                </p>
                <p className={`mt-0.5 text-xs leading-snug ${step.state === "skipped" ? "text-slate-400 line-through" : "text-slate-500"}`}>
                  {step.typical}
                </p>
              </div>
            </div>
            {timeline.terminal?.afterStep === step.id && (
              <div className="mt-2.5 flex gap-3">
                <span aria-hidden="true" className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-500 text-[11px] font-bold text-white">
                  ×
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-slate-900">{timeline.terminal.label}</p>
                  <p className="mt-0.5 text-xs leading-snug text-slate-500">{timeline.terminal.detail}</p>
                </div>
              </div>
            )}
          </li>
        ))}
      </ol>
      <DeadlineLine timeline={timeline} nowSec={nowSec} />
      {timeline.next && (
        <p className="text-xs text-slate-700">
          <span className="font-semibold text-slate-900">Who acts next: {actors[timeline.next.actor]}.</span>{" "}
          {audience === "holder" ? timeline.next.text : timeline.next.operatorText}
        </p>
      )}
      {timeline.complete && (
        <p className="text-xs text-emerald-800">Conversion complete: the transfer is registered and the escrowed units were burned.</p>
      )}
      <p className="text-[11px] text-slate-400">{CONVERSION_DURATIONS_NOTE}</p>
    </div>
  );
}

const SEGMENT: Record<ConversionStepState, string> = {
  done: "bg-emerald-500",
  current: "bg-brand-500",
  upcoming: "bg-slate-200",
  skipped: "bg-slate-100",
};

/** Five segments and one line ("Step 4 of 5: … · Next: Manci"), for a table cell. */
export function ConversionTimelineCompact({ audience = "holder", ...props }: ConversionTimelineProps) {
  const nowSec = Number(props.nowSec);
  const timeline = conversionTimeline({ ...props, nowSec });
  if (!timeline.known) return null;
  const next = timeline.next ? ` · Next: ${ACTOR_LABEL[audience][timeline.next.actor]}` : "";
  const step = timeline.current
    ? timeline.steps.find((s) => s.id === timeline.current)
    : undefined;
  return (
    <div className="mt-1.5 max-w-56">
      <div aria-hidden="true" className="flex gap-0.5">
        {timeline.steps.map((s) => (
          <span key={s.id} className={`h-1.5 flex-1 rounded-full ${SEGMENT[s.state]}`} />
        ))}
      </div>
      <p className="mt-1 text-[11px] leading-snug text-slate-500">
        {conversionTimelineSummary(timeline)}
        {next}
      </p>
      {step && (
        // The current step's typical duration, never a promise.
        <p className="text-[11px] leading-snug text-slate-400">{step.typical}</p>
      )}
      {timeline.deadline && (
        <p className={`text-[11px] leading-snug ${timeline.deadline.passed ? "text-red-700" : "text-slate-500"}`}>
          Vault deadline <span className="font-mono">{formatConversionDeadline(timeline.deadline.atSec)}</span>
          {timeline.deadline.passed ? " (passed)" : ""}
        </p>
      )}
    </div>
  );
}
