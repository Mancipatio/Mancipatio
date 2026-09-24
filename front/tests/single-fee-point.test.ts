// Talas 4.2 §1.1 / D3: one priority-fee point. Read from the sources, so a
// later page that sets its own price (or builds its own SetComputeUnitPrice)
// fails here instead of silently bypassing the policy and its cap.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const SCANNED = ["app", "components", "lib", "scripts/chain"];

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(ROOT, dir))) {
    const path = join(dir, name);
    if (statSync(join(ROOT, path)).isDirectory()) out.push(...sources(path));
    else if (/\.(ts|tsx|mts)$/.test(name)) out.push(path);
  }
  return out;
}

const files = SCANNED.flatMap(sources).map((path) => ({
  path: relative(ROOT, join(ROOT, path)),
  text: readFileSync(join(ROOT, path), "utf8"),
}));

function filesMatching(pattern: RegExp): string[] {
  return files.filter((f) => pattern.test(f.text)).map((f) => f.path).sort();
}

describe("one priority-fee point", () => {
  it("scans the app, components, lib and the chain CLI", () => {
    expect(files.length).toBeGreaterThan(200);
    expect(files.some((f) => f.path === "lib/verified-solana-client.ts")).toBe(true);
    expect(files.some((f) => f.path === "scripts/chain/lib/tx.ts")).toBe(true);
  });

  it("only the verified client sets computeUnitPrice on a send request", () => {
    const allowed = ["lib/priority-fee.ts", "lib/verified-solana-client.ts"];
    const offenders = filesMatching(/\bcomputeUnitPrice\s*:/).filter((p) => !allowed.includes(p));
    expect(offenders).toEqual([]);
    expect(filesMatching(/\bcomputeUnitPrice\s*:/)).toContain("lib/verified-solana-client.ts");
  });

  it("SetComputeUnitPrice is built only by the fee point, the size placeholders and the co-signed envelopes", () => {
    const allowed = [
      "lib/compute-budget.ts",
      "lib/priority-fee.ts",
      "lib/issuer-authority.ts",
      "lib/vesting-creation.ts",
      "lib/issuer-recovery.ts",
      "lib/kyc-registry-creation.ts",
      "scripts/chain/lib/tx.ts",
    ];
    const offenders = filesMatching(/\b(setComputeUnitPriceInstruction|getSetComputeUnitPriceInstruction)\b/).filter(
      (p) => !allowed.includes(p),
    );
    expect(offenders).toEqual([]);
  });

  it("nothing builds compute-budget bytes from another package", () => {
    expect(filesMatching(/@solana-program\/compute-budget/)).toEqual([]);
  });
});
