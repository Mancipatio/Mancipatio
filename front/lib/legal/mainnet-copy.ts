// THE SLOT for counsel's mainnet legal texts. The devnet pilot's Terms and
// Privacy Policy stay where they are (app/(marketing)/legal/*/devnet-*.tsx);
// a mainnet build renders these instead, through components/legal-document.tsx.
//
// How to add counsel's text:
//   - Paste each document as a LegalDocument (lib/legal/document.ts): plain
//     paragraphs and bulleted lists under numbered clauses.
//   - Leave out who the operator is, the governing law, the competent court
//     and the contact addresses: the pages render them from
//     lib/legal/operator.ts, so they cannot drift from the footer and
//     /legal/company.
//   - MAINNET_TERMS.version becomes the Terms version every wallet accepts
//     (TOS_VERSION); give any later material change a new version.
//   - MAINNET_TOS_GATE_POINTS: the short summary shown in the acceptance
//     dialog (components/tos-gate.tsx).
//   - Then `npx vitest run tests/legal-slots.test.ts --silent=false`: the
//     "mainnet legal slots" report must say complete. A mainnet build refuses
//     anything else, including text that still says devnet or "no real assets".
//
// Directive-free and import-free apart from a type (next.config.ts loads it).

import type { LegalDocument } from "./document";

/** Counsel's mainnet Terms of Service. null until delivered. */
export const MAINNET_TERMS: LegalDocument | null = null;

/** Counsel's mainnet Privacy Policy. null until delivered. */
export const MAINNET_PRIVACY: LegalDocument | null = null;

/** Counsel's summary for the Terms acceptance dialog. null until delivered. */
export const MAINNET_TOS_GATE_POINTS: string[] | null = null;
