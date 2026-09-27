// What a mainnet build requires of the operator and legal slots
// (next.config.ts assertBuildMainnetLegal). Pure: the env and the slots are
// parameters, so tests/legal-slots.test.ts checks both the rules and the
// values committed today.
//
// A mainnet build is refused unless:
//   (a) the mainnet operator record is complete (lib/legal/operator.ts);
//   (b) the operator's licence is recorded, OR MAINNET_LICENSE_NOT_REQUIRED
//       is exactly "true" — set it only on counsel's written opinion that the
//       services offered need no licence, and keep that opinion on file
//       (ops/runbook-mainnet.md). A recorded licence together with the waiver
//       is refused as contradictory;
//   (c) counsel's mainnet Terms, Privacy Policy and acceptance-dialog summary
//       are in lib/legal/mainnet-copy.ts and say nothing of devnet or "no real
//       assets", and the purchase risk warning is counsel's
//       (lib/legal/risk-warning.ts, status "counsel");
//   (d) and, separately in next.config.ts, the existing conditions
//       (MAINNET_LEGAL_COPY_APPROVED=true, the mainnet Supabase project, the
//       KYC registry pin).
//
// Relative imports only, no directives: next.config.ts loads this file.

import { forbiddenMainnetPhrases, legalDocumentProblems, type LegalDocument } from "./document";
import { MAINNET_PRIVACY, MAINNET_TERMS, MAINNET_TOS_GATE_POINTS } from "./mainnet-copy";
import { OPERATORS, operatorProblems, type Operator } from "./operator";
import { PURCHASE_RISK_WARNING, type RiskWarning } from "./risk-warning";

/** Build-time only (never NEXT_PUBLIC_): counsel's written "no licence needed". */
export const MAINNET_LICENSE_WAIVER = "MAINNET_LICENSE_NOT_REQUIRED";

export type MainnetLegalSlots = {
  operator: Operator;
  terms: LegalDocument | null;
  privacy: LegalDocument | null;
  tosGatePoints: string[] | null;
  riskWarning: RiskWarning;
};

/** The values committed today. */
export const MAINNET_LEGAL_SLOTS: MainnetLegalSlots = {
  operator: OPERATORS.mainnet,
  terms: MAINNET_TERMS,
  privacy: MAINNET_PRIVACY,
  tosGatePoints: MAINNET_TOS_GATE_POINTS,
  riskWarning: PURCHASE_RISK_WARNING,
};

/** Every reason a mainnet build would be refused; empty when ready. */
export function mainnetLegalProblems(
  env: Record<string, string | undefined>,
  slots: MainnetLegalSlots = MAINNET_LEGAL_SLOTS,
): string[] {
  const problems = [...operatorProblems(slots.operator)];

  const waiver = env[MAINNET_LICENSE_WAIVER]?.trim() === "true";
  if (!slots.operator.licence && !waiver) {
    problems.push(
      "operator.licence is not recorded. Record the licence (authority, decision number and date, services), " +
        `or set ${MAINNET_LICENSE_WAIVER}=true only on counsel's written opinion that none is needed`,
    );
  }
  if (slots.operator.licence && waiver) {
    problems.push(
      `operator.licence is recorded and ${MAINNET_LICENSE_WAIVER}=true says none is needed: unset one of them`,
    );
  }

  problems.push(...legalDocumentProblems("Terms of Service", slots.terms));
  problems.push(...legalDocumentProblems("Privacy Policy", slots.privacy));

  const gate = slots.tosGatePoints;
  if (!gate || gate.length === 0 || gate.some((point) => !point.trim())) {
    problems.push("Terms acceptance dialog: counsel's summary (MAINNET_TOS_GATE_POINTS) has not been added");
  } else {
    const phrases = forbiddenMainnetPhrases(gate.join("\n"));
    if (phrases.length > 0) {
      problems.push(`Terms acceptance dialog: contains wording that must not reach mainnet (${phrases.join(", ")})`);
    }
  }

  const warning = slots.riskWarning;
  if (warning.status !== "counsel") {
    problems.push("Purchase risk warning: still engineering's draft (lib/legal/risk-warning.ts, status \"draft\")");
  }
  const warningPhrases = forbiddenMainnetPhrases(
    [warning.title, ...warning.points, warning.acknowledgement].join("\n"),
  );
  if (warningPhrases.length > 0) {
    problems.push(`Purchase risk warning: contains wording that must not reach mainnet (${warningPhrases.join(", ")})`);
  }
  return problems;
}
