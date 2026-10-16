// Source-scan helpers of the admin-custody-*.test.ts suites: the custody page
// as text and the source of one of its top-level functions (plain or async).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";

export const custodyPageSource = (): string =>
  readFileSync(join(process.cwd(), "app/admin/custody/page.tsx"), "utf8");

/** The source of the top-level function `name`, up to the next top-level function. */
export function topLevelFunction(code: string, name: string): string {
  const starts = [`\nfunction ${name}(`, `\nasync function ${name}(`]
    .map((marker) => code.indexOf(marker))
    .filter((at) => at >= 0);
  expect(starts.length, name).toBeGreaterThan(0);
  const start = Math.min(...starts);
  const ends = ["\nfunction ", "\nasync function ", "\nexport default function "]
    .map((marker) => code.indexOf(marker, start + 1))
    .filter((at) => at >= 0);
  return code.slice(start, ends.length ? Math.min(...ends) : undefined);
}
