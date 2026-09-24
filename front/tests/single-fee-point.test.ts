// Talas 4.2 §1.1 / D3: one priority-fee point. Read from the sources, so a
// later page that sets its own price (or builds its own SetComputeUnitPrice)
// fails here instead of silently bypassing the policy and its cap. The scan
// is deliberately broad (any mention of the identifier, in TS and JS
// sources); forms it cannot see (a name built at runtime) still meet the
// runtime backstop: priceForRequest refuses a request that carries a price.
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
    else if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(name)) out.push(path);
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
    // Any mention: `computeUnitPrice: x`, shorthand `{ computeUnitPrice }`,
    // quoted or computed keys, assignments and destructuring alike.
    const offenders = filesMatching(/\bcomputeUnitPrice\b/).filter((p) => !allowed.includes(p));
    expect(offenders).toEqual([]);
    expect(filesMatching(/\bcomputeUnitPrice\s*:/)).toContain("lib/verified-solana-client.ts");
  });

  it("the broad pattern catches every way of writing the key", () => {
    const pattern = /\bcomputeUnitPrice\b/;
    for (const source of [
      "tx.send({ instructions, computeUnitPrice: 5n })",
      "const computeUnitPrice = 5n; tx.send({ instructions, computeUnitPrice })",
      'tx.send({ instructions, "computeUnitPrice": 5n })',
      "tx.send({ instructions, ['computeUnitPrice']: 5n })",
      "request.computeUnitPrice = 5n",
    ]) {
      expect(pattern.test(source)).toBe(true);
    }
    // A different identifier (the envelopes' own field) is not a match.
    expect(pattern.test("computeUnitPriceMicroLamports: price")).toBe(false);
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
