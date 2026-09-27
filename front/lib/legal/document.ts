// Legal documents as data: the shape counsel's mainnet Terms of Service and
// Privacy Policy are pasted into (lib/legal/mainnet-copy.ts), and the checks
// a mainnet build runs on them (lib/legal/readiness.ts).
//
// Directive-free and import-free: next.config.ts loads it through
// lib/legal/readiness.ts, and server and client pages render it
// (components/legal-document.tsx).

/**
 * One block of a clause: a paragraph or a bulleted list. Plain text only (no
 * links, no emphasis), so counsel's wording renders exactly as delivered.
 */
export type LegalBlock =
  | { kind: "paragraph"; text: string }
  | { kind: "list"; items: string[] };

/** A numbered clause: its heading (numbering included) and its blocks. */
export type LegalClause = { title: string; blocks: LegalBlock[] };

export type LegalDocument = {
  /**
   * yyyy-mm-dd. For the Terms this is the version every wallet accepts
   * (TOS_VERSION, lib/tos-version.ts): change it for any edit that needs
   * re-acceptance.
   */
  version: string;
  /** yyyy-mm-dd, shown as "Last updated". */
  lastUpdated: string;
  /** Optional paragraph under the page title. */
  lede?: string;
  clauses: LegalClause[];
};

/** A real calendar date written yyyy-mm-dd. */
export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * Wording that must not reach a mainnet page: test-network statements ("runs
 * on devnet", "no real assets") and drafting leftovers. Matched
 * case-insensitively; the short markers only as whole words.
 */
const MAINNET_FORBIDDEN: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "devnet", pattern: /devnet/i },
  { label: "testnet", pattern: /testnet/i },
  { label: "localnet", pattern: /localnet/i },
  { label: "no real assets", pattern: /no real assets?/i },
  { label: "no economic value", pattern: /no economic value/i },
  { label: "to be confirmed", pattern: /to be confirmed/i },
  { label: "before mainnet launch", pattern: /before (the )?mainnet launch/i },
  { label: "placeholder", pattern: /placeholder/i },
  { label: "lorem ipsum", pattern: /lorem ipsum/i },
  { label: "TODO", pattern: /\bTODO\b/i },
  { label: "TBD", pattern: /\bTBD\b/i },
  { label: "XXX", pattern: /\bXXX\b/i },
];

/** The forbidden phrases `text` contains (labels, deduplicated). */
export function forbiddenMainnetPhrases(text: string): string[] {
  return MAINNET_FORBIDDEN.filter(({ pattern }) => pattern.test(text)).map(({ label }) => label);
}

/** Every string of a document, for scanning. */
export function legalDocumentText(doc: LegalDocument): string {
  const parts: string[] = [doc.lede ?? ""];
  for (const clause of doc.clauses) {
    parts.push(clause.title);
    for (const block of clause.blocks) {
      if (block.kind === "paragraph") parts.push(block.text);
      else parts.push(...block.items);
    }
  }
  return parts.join("\n");
}

/**
 * What stops `doc` from being published on mainnet, as sentences naming the
 * document (`label`). Empty when it is ready.
 */
export function legalDocumentProblems(label: string, doc: LegalDocument | null): string[] {
  if (!doc) return [`${label}: counsel's mainnet text has not been added (lib/legal/mainnet-copy.ts)`];
  const problems: string[] = [];
  if (!isIsoDate(doc.version)) problems.push(`${label}: version must be a yyyy-mm-dd date`);
  if (!isIsoDate(doc.lastUpdated)) problems.push(`${label}: lastUpdated must be a yyyy-mm-dd date`);
  if (doc.clauses.length === 0) problems.push(`${label}: has no clauses`);
  const empty = doc.clauses.some(
    (clause) =>
      !clause.title.trim() ||
      clause.blocks.length === 0 ||
      clause.blocks.some((block) =>
        block.kind === "paragraph"
          ? !block.text.trim()
          : block.items.length === 0 || block.items.some((item) => !item.trim()),
      ),
  );
  if (empty) problems.push(`${label}: has an empty clause, paragraph or list item`);
  const phrases = forbiddenMainnetPhrases(legalDocumentText(doc));
  if (phrases.length > 0) {
    problems.push(`${label}: contains wording that must not reach mainnet (${phrases.join(", ")})`);
  }
  return problems;
}
