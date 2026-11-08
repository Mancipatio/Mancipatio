// Where a conversion request stands, as one timeline: five steps from the
// request to the burn, the two terminal branches (cancelled, returned), the
// current step, who acts next, the on-chain vault deadline (read by the
// caller from the vault, never from the database) and a TYPICAL duration per
// step. Pure and isomorphic: /portfolio/conversion and /admin/custody render
// it (components/conversion-timeline.tsx), and the conversion emails
// (lib/server/conversion-notifications.ts) quote the same durations, so a
// page and an email never disagree.
//
// The durations are typical, never promised: the review is Manci's, the
// deposit is the holder's (bounded only by the vault deadline, which no
// instruction extends), and the notary appointment, the filing and the
// register's decision depend on people outside the platform. Every sentence
// built from them says "typically" or "about", and a note under every
// timeline says they are not guaranteed; tests/conversion-timeline.test.ts
// keeps promises ("will take", "within", "at most") out of the steps.
//
// The database has no status for the off-chain filing: a request stays
// `deposited` from the deposit until the admin's "Confirm conversion" burn
// records `converted` (migration 0034, deposited -> converted is direct). So
// `deposited` marks "Units in escrow" done and the filing current.

/** The statuses a timeline knows (lib/conversion.ts ConversionStatus); any other value reads as unknown. */
export type ConversionTimelineStatus =
  | "requested"
  | "vault_opened"
  | "deposited"
  | "converted"
  | "cancelled"
  | "returned";

export type ConversionStepId =
  | "requested"
  | "escrow_open"
  | "in_escrow"
  | "filing"
  | "registered";

/** done: reached; current: where the request is now; upcoming: still ahead; skipped: never reached (a terminal branch ended the request). */
export type ConversionStepState = "done" | "current" | "upcoming" | "skipped";

/** Who acts next: Manci (the review, the filing, the burn) or the holder (the deposit). */
export type ConversionActor = "manci" | "holder";

/**
 * Typical durations (owner's figures, 2026-11-08). Fragments, so a page can
 * put them in a sentence; lib/server/conversion-notifications.ts quotes them.
 */
export const CONVERSION_TYPICAL_DURATIONS = {
  /** Manci's review of a request, up to the opened escrow vault. */
  review: "about 2 business days",
  /** The holder's deposit: the vault deadline is the only bound. */
  deposit: "until the vault deadline",
  /** The notary appointment and the business register filing. */
  filing: "5–10 business days",
  /** The register's decision, counted from the filing. */
  registerDecision: "about 5 business days after filing",
} as const;

export type ConversionStepDefinition = {
  id: ConversionStepId;
  label: string;
  /** The typical duration of this step, as a sentence. */
  typical: string;
  /** Who acts while the request sits at this step. */
  actor: ConversionActor;
  /** Off chain: the step happens outside Solana (no transaction marks it). */
  offChain: boolean;
};

export const CONVERSION_STEPS: readonly ConversionStepDefinition[] = [
  {
    id: "requested",
    label: "Requested",
    typical: `Review by Manci: typically ${CONVERSION_TYPICAL_DURATIONS.review}.`,
    actor: "manci",
    offChain: true,
  },
  {
    id: "escrow_open",
    label: "Approved, escrow vault open",
    typical: `Deposit: any time ${CONVERSION_TYPICAL_DURATIONS.deposit}.`,
    actor: "holder",
    offChain: false,
  },
  {
    id: "in_escrow",
    label: "Units in escrow",
    typical: "Recorded as soon as the deposit is final on Solana.",
    actor: "manci",
    offChain: false,
  },
  {
    id: "filing",
    label: "Notary and business register filing (off-chain)",
    typical: `Notary appointment and filing: typically ${CONVERSION_TYPICAL_DURATIONS.filing}.`,
    actor: "manci",
    offChain: true,
  },
  {
    id: "registered",
    label: "Registered, units burned",
    typical: `Register decision: typically ${CONVERSION_TYPICAL_DURATIONS.registerDecision}; then the escrowed units are burned.`,
    actor: "manci",
    offChain: false,
  },
];

/** Shown under every timeline: the durations above are not a commitment. */
export const CONVERSION_DURATIONS_NOTE =
  "Durations are typical, not guaranteed: they depend on the notary, the business register and your deposit.";

export type ConversionTimelineStep = ConversionStepDefinition & { state: ConversionStepState };

export type ConversionTimeline = {
  /** False for a status this module does not know (an older schema's `approved`): no step is marked. */
  known: boolean;
  steps: ConversionTimelineStep[];
  /** The step the request is at now; null once it ended (converted, cancelled, returned) or for an unknown status. */
  current: ConversionStepId | null;
  /** 1-based position of the current step (or of the last reached step once it ended). */
  position: number;
  /**
   * Who acts next and what happens, in the holder's words (`text`, for
   * /portfolio/conversion and the holder emails) and the operator's
   * (`operatorText`, for /admin/custody); null once the request ended.
   */
  next: { actor: ConversionActor; text: string; operatorText: string } | null;
  /** The terminal branch that ended the request early, after the last reached step. */
  terminal: { kind: "cancelled" | "returned"; label: string; detail: string; afterStep: ConversionStepId } | null;
  /** True when every step is done (converted). */
  complete: boolean;
  /** The vault deadline, while it matters (escrow open, units in escrow) and the caller read it. */
  deadline: { atSec: number; passed: boolean } | null;
};

export type ConversionTimelineInput = {
  status: string;
  /** Whether the request ever had a vault linked (conversion_requests.vault_pda): tells a cancel before approval from one after. */
  hasVault: boolean;
  /** The vault's on-chain deadline (unix seconds), when read; null or undefined otherwise. */
  vaultDeadlineSec?: bigint | number | null;
  /** The chain clock (unix seconds) for the deadline's "passed". */
  nowSec?: bigint | number;
};

const STEP_INDEX: Record<ConversionStepId, number> = {
  requested: 0,
  escrow_open: 1,
  in_escrow: 2,
  filing: 3,
  registered: 4,
};

function stepsWith(state: (index: number) => ConversionStepState): ConversionTimelineStep[] {
  return CONVERSION_STEPS.map((step, index) => ({ ...step, state: state(index) }));
}

function deadlineOf(input: ConversionTimelineInput): ConversionTimeline["deadline"] {
  const raw = input.vaultDeadlineSec;
  if (raw === null || raw === undefined) return null;
  const atSec = Number(raw);
  if (!Number.isSafeInteger(atSec) || atSec <= 0) return null;
  const now = input.nowSec === undefined ? Math.floor(Date.now() / 1000) : Number(input.nowSec);
  return { atSec, passed: Number.isFinite(now) && now >= atSec };
}

/** The timeline of one request (see the header). */
export function conversionTimeline(input: ConversionTimelineInput): ConversionTimeline {
  const status = input.status;
  const base = { terminal: null, complete: false, deadline: null } as const;
  switch (status) {
    case "requested":
    case "vault_opened":
    case "deposited": {
      // deposited: the units are in escrow (done) and the off-chain filing runs.
      const current: ConversionStepId =
        status === "requested" ? "requested" : status === "vault_opened" ? "escrow_open" : "filing";
      const at = STEP_INDEX[current];
      const deadline = status === "requested" ? null : deadlineOf(input);
      return {
        ...base,
        known: true,
        steps: stepsWith((i) => (i < at ? "done" : i === at ? "current" : "upcoming")),
        current,
        position: at + 1,
        next: nextStep(status, deadline),
        deadline,
      };
    }
    case "converted":
      return {
        ...base,
        known: true,
        steps: stepsWith(() => "done"),
        current: null,
        position: CONVERSION_STEPS.length,
        next: null,
        complete: true,
      };
    case "cancelled": {
      // Cancelled before any deposit (the 0034 guard allows it from requested
      // and vault_opened only): nothing moved on chain.
      const afterStep: ConversionStepId = input.hasVault ? "escrow_open" : "requested";
      const at = STEP_INDEX[afterStep];
      return {
        ...base,
        known: true,
        steps: stepsWith((i) => (i <= at ? "done" : "skipped")),
        current: null,
        position: at + 1,
        next: null,
        terminal: {
          kind: "cancelled",
          label: "Cancelled",
          detail: input.hasVault
            ? "Cancelled before any deposit; the escrow vault was closed and no units moved."
            : "Cancelled before approval; no units moved.",
          afterStep,
        },
      };
    }
    case "returned": {
      const at = STEP_INDEX.in_escrow;
      return {
        ...base,
        known: true,
        steps: stepsWith((i) => (i <= at ? "done" : "skipped")),
        current: null,
        position: at + 1,
        next: null,
        terminal: {
          kind: "returned",
          label: "Returned",
          detail: "The escrowed units were returned to the holder's wallet; nothing was burned.",
          afterStep: "in_escrow",
        },
      };
    }
    default:
      return {
        ...base,
        known: false,
        steps: stepsWith(() => "upcoming"),
        current: null,
        position: 0,
        next: null,
      };
  }
}

function nextStep(
  status: "requested" | "vault_opened" | "deposited",
  deadline: ConversionTimeline["deadline"],
): ConversionTimeline["next"] {
  if (status === "requested") {
    return {
      actor: "manci",
      text: "Manci reviews your request and opens the escrow vault.",
      operatorText: "Review the request; approving opens the escrow vault.",
    };
  }
  if (status === "vault_opened") {
    // After the deadline anyone can return a vault: a deposit then is a risk.
    return deadline?.passed
      ? {
          actor: "manci",
          text: "The vault deadline has passed: contact Manci before depositing.",
          operatorText: "The vault deadline has passed: close the empty vault with Cancel (no deposit).",
        }
      : {
          actor: "holder",
          text: "Deposit the units into the escrow vault before its deadline.",
          operatorText: "Waiting for the holder's deposit, before the vault deadline.",
        };
  }
  return deadline?.passed
    ? {
        actor: "holder",
        text: "The vault deadline has passed: you can reclaim your units, or wait for Manci to confirm the conversion.",
        operatorText: "The vault deadline has passed: anyone can now return the escrow to the holder.",
      }
    : {
        actor: "manci",
        text: "Manci arranges the notary appointment and files with the business register.",
        operatorText: "Notary appointment and register filing; confirm the conversion after the register decision, before the vault deadline.",
      };
}

/** "Step 4 of 5: Notary and business register filing (off-chain)", or the ending. */
export function conversionTimelineSummary(timeline: ConversionTimeline): string {
  if (!timeline.known) return "Status unknown";
  if (timeline.complete) return `Step ${CONVERSION_STEPS.length} of ${CONVERSION_STEPS.length}: complete`;
  if (timeline.terminal) {
    const step = CONVERSION_STEPS[STEP_INDEX[timeline.terminal.afterStep]];
    return `${timeline.terminal.label} after step ${timeline.position} of ${CONVERSION_STEPS.length} (${step.label})`;
  }
  const step = CONVERSION_STEPS[timeline.position - 1];
  return `Step ${timeline.position} of ${CONVERSION_STEPS.length}: ${step.label}`;
}

/** A vault deadline as the timeline and the emails write it: "2027-03-09 14:00 UTC". */
export function formatConversionDeadline(atSec: number): string {
  return `${new Date(atSec * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
