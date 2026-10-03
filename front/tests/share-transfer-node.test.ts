// The builder, the checks, the simulation gate and the error tables must load
// in plain Node (no window, no React): the devnet rehearsal script imports
// them as they are. This suite imports them here (vitest runs in Node) and
// walks their app imports transitively, refusing React, Next, the wallet UI
// hooks and the browser-session modules (lib/supabase, lib/passport,
// lib/siws-client).
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const ENTRY_POINTS = ["lib/share-transfer.ts", "lib/simulation-gate.ts", "lib/program-errors.ts", "lib/extra-account-metas.ts"];
const FORBIDDEN_MODULES = ["lib/supabase", "lib/passport", "lib/siws-client", "lib/toast", "lib/auth"];
const FORBIDDEN_PACKAGES = [/^react($|\/|-dom)/, /^next($|\/)/, /^@solana\/react-hooks/];

function resolve(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = spec.slice(2);
  else if (spec.startsWith(".")) base = join(from, "..", spec);
  else return null;
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(join(ROOT, candidate))) return candidate;
  }
  throw new Error(`cannot resolve ${spec} from ${from}`);
}

function importsOf(file: string): string[] {
  const source = readFileSync(join(ROOT, file), "utf8");
  const specs: string[] = [];
  for (const match of source.matchAll(/(?:import|export)\s[^;]*?from\s+"([^"]+)"/g)) specs.push(match[1]);
  for (const match of source.matchAll(/import\(\s*"([^"]+)"\s*\)/g)) specs.push(match[1]);
  return specs;
}

function closure(): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = [...ENTRY_POINTS];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (files.has(file)) continue;
    files.add(file);
    for (const spec of importsOf(file)) {
      const target = resolve(file, spec);
      if (target) queue.push(target);
      else packages.add(spec);
    }
  }
  return { files, packages };
}

describe("node-safe modules", () => {
  it("import in Node without a window", async () => {
    expect(typeof (globalThis as { window?: unknown }).window).toBe("undefined");
    const transfer = await import("@/lib/share-transfer");
    const gate = await import("@/lib/simulation-gate");
    const errors = await import("@/lib/program-errors");
    const metas = await import("@/lib/extra-account-metas");
    expect(typeof transfer.buildShareTransfer).toBe("function");
    expect(typeof transfer.loadShareTransferFacts).toBe("function");
    expect(typeof transfer.shareTransferChecks).toBe("function");
    expect(typeof gate.simulateMessage).toBe("function");
    expect(typeof errors.classifyFailure).toBe("function");
    expect(typeof metas.resolveExtraAccountMetas).toBe("function");
  });

  it("pull in no React, Next, wallet-UI or browser-session module, at any depth", () => {
    const { files, packages } = closure();
    expect(files.size).toBeGreaterThan(ENTRY_POINTS.length);
    for (const forbidden of FORBIDDEN_MODULES) {
      expect([...files].filter((f) => f === `${forbidden}.ts` || f === `${forbidden}.tsx`), forbidden).toEqual([]);
    }
    for (const pkg of packages) {
      for (const pattern of FORBIDDEN_PACKAGES) expect(pattern.test(pkg), `${pkg}`).toBe(false);
    }
  });
});
