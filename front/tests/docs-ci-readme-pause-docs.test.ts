// Documents that must agree with the code and with the live network (review
// findings F089–F093): the README's status and transfer-hook sentence, the
// pause-mask table of runbook §8 and the KYC-only / conversion prerequisites
// of ops/env-vars.md. Each guard reads the tracked file, as
// tests/legal-slots.test.ts reads the program sources; CI checks out the
// whole repository (front-ci.yml), so ../README.md and ../ops are present.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SECURITY_AUDIT } from "@/lib/legal/audit";
import {
  PAUSE_CUSTODY_ENTRY,
  PAUSE_FLAGS,
  PAUSE_FLAGS_ALL,
  PAUSE_ISSUER_PROCEEDS,
  PAUSE_ONBOARDING,
  PAUSE_PRIMARY,
  PAUSE_SECONDARY,
} from "@/lib/pause-flags";
import { KYC_ONLY_ENV } from "@/lib/features";
import { ASSET_REGISTRY_PROGRAM_ADDRESS } from "@/lib/generated/asset_registry";
import { TRANSFER_HOOK_PROGRAM_ADDRESS } from "@/lib/generated/transfer_hook";

const ROOT = join(process.cwd(), "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const readme = read("README.md");
const envVars = read("ops/env-vars.md");
const runbook = read("ops/runbook-mainnet.md");

/** The text of one `## <n>.` section of the runbook, up to the next `## ` heading. */
function runbookSection(n: number): string {
  const start = runbook.indexOf(`\n## ${n}. `);
  expect(start, `runbook §${n}`).toBeGreaterThan(-1);
  const end = runbook.indexOf("\n## ", start + 1);
  return runbook.slice(start, end === -1 ? undefined : end);
}

/** The text of one `### ` section of env-vars.md. */
function envVarsSection(heading: string): string {
  const start = envVars.indexOf(`\n### ${heading}`);
  expect(start, heading).toBeGreaterThan(-1);
  const end = envVars.indexOf("\n### ", start + 1);
  return envVars.slice(start, end === -1 ? undefined : end);
}

/** `0x7F`-style (upper-case hex digits), as the documents write masks. */
const mask = (bits: number) => `0x${(bits & 0xff).toString(16).toUpperCase().padStart(2, "0")}`;

describe("README status (F091)", () => {
  it("says the programs are live on mainnet, not devnet only", () => {
    expect(readme).not.toMatch(/devnet only|Nothing here is live on mainnet/i);
    expect(readme).toMatch(/live on Solana mainnet since 2026-10-02/);
    expect(readme).toContain("v1.0.0-rc.1");
  });

  it("lists the mainnet programs under the addresses the SDK is generated for, each with its executable hash", () => {
    const row = (name: string, address: string) =>
      new RegExp(`^\\| \`${name}\` \\| \`${address}\` \\| \`[0-9a-f]{64}\` \\|$`, "m");
    expect(readme).toMatch(row("asset_registry", ASSET_REGISTRY_PROGRAM_ADDRESS));
    expect(readme).toMatch(row("transfer_hook", TRANSFER_HOOK_PROGRAM_ADDRESS));
    expect(readme).toMatch(/\*\*Upgrade authority\*\*: a Squads vault\n\s+\(`[1-9A-HJ-NP-Za-km-z]{32,44}`\)/);
    expect(readme).toMatch(/\*\*Devnet\*\* runs the same program addresses/);
  });

  it("states KYC-only mode and links the env inventory sections it names", () => {
    expect(readme).toMatch(/\*\*KYC-only mode\*\*/);
    expect(readme).toContain("[`ops/env-vars.md`](ops/env-vars.md)");
    expect(envVars).toContain("### Pilot scope (module switches)");
    expect(envVars).toContain("### KYC-only mode and offered asset classes");
    expect(readme).toContain("[`ops/release-checklist.md`](ops/release-checklist.md)");
    expect(() => read("ops/release-checklist.md")).not.toThrow();
  });

  it("claims no external audit until one is recorded (SECURITY_AUDIT)", () => {
    expect(readme).toContain("SECURITY_AUDIT");
    if (SECURITY_AUDIT === null) expect(readme).toMatch(/\*\*Not audited\*\*/);
    else expect(readme).not.toMatch(/\*\*Not audited\*\*/);
    expect(readme).not.toMatch(/\baudited by\b/i);
  });
});

describe("README transfer hook sentence (F090)", () => {
  it("limits receiver KYC to KYC-gated classes: share classes are Open bearer instruments by default", () => {
    expect(readme).not.toMatch(/KYC[^)]*every transfer/);
    expect(readme).toMatch(/blocklist check on\s+the sender of every transfer/);
    expect(readme).toMatch(/receiver KYC and jurisdiction checks only on\s+KYC-gated classes/);
  });
});

describe("env-vars.md: conversion prerequisites and pause masks (F093, F089)", () => {
  const pilot = envVarsSection("Pilot scope (module switches)");
  const kycOnly = envVarsSection("KYC-only mode and offered asset classes");

  it("names every prerequisite of a conversion: KYC-only off, the conversion switch, Terms, and 0x08 for the open and the deposit", () => {
    expect(pilot).toContain("NEXT_PUBLIC_FEATURE_CUSTODY_CONVERSION=true");
    expect(pilot).toContain(`${KYC_ONLY_ENV}=false`);
    expect(pilot).toContain("open_custody_vault");
    expect(pilot).toContain("deposit_to_custody_vault");
    expect(pilot).toContain("KYC_ONLY_FLOWS");
    expect(pilot).toMatch(/both\*?\*? the vault open and the holder's deposit/);
    expect(pilot).toContain("Pause mask by mode");
    expect(pilot).not.toMatch(/one issuer's\s+Mature class/);
  });

  it("gives one steady state, 0x7F, and records 0x7E as what the chain held", () => {
    expect(envVars).not.toMatch(/0x1c|0x5c/i);
    expect(kycOnly).toContain(`needs ${mask(PAUSE_FLAGS_ALL)} on-chain`);
    expect(kycOnly).toContain(mask(PAUSE_FLAGS_ALL & ~PAUSE_ONBOARDING));
    expect(kycOnly).toMatch(/any Admin sets bits/);
    expect(kycOnly).toMatch(/Admin → Platform shows 0x7F/);
  });

  it("leaving the mode redeploys first, clears only a row's bits as each window starts, and updates the README", () => {
    const leaving = kycOnly.slice(kycOnly.indexOf("Leaving KYC-only mode later:"));
    expect(leaving).toMatch(/3\. There set `NEXT_PUBLIC_FEATURE_KYC_ONLY=false` and Redeploy/);
    expect(leaving).toMatch(/5\. Only then, as each window starts, clear the pause bits[\s\S]*Pause\s+mask by mode/);
    expect(leaving).toMatch(/never as a\s+steady state/);
    expect(leaving).toMatch(/6\. Update the Status paragraph of `README\.md`/);
  });
});

describe("runbook §8 pause mask by mode (F089)", () => {
  const s8 = runbookSection(8);

  it("has one table of modes whose masks follow lib/pause-flags.ts", () => {
    expect(s8).toContain("**Pause mask by mode (8.5).**");
    for (const flag of PAUSE_FLAGS) expect(s8).toContain(flag.label);
    expect(s8).toContain(`| **${mask(PAUSE_FLAGS_ALL)}** |`);
    expect(s8).toContain(`| ${mask(PAUSE_FLAGS_ALL & ~PAUSE_ONBOARDING)} |`);
    expect(s8).toContain(`| ${mask(PAUSE_FLAGS_ALL & ~PAUSE_PRIMARY)} |`);
    // mint_to_treasury, open_sale and buy are in KYC_ONLY_FLOWS: both 0x7D rows need the mode off.
    expect(s8).toMatch(/\| Direct mint \(`mint_to_treasury`; KYC-only off\) \| 0x7D \|/);
    expect(s8).toMatch(/\| Public sale window \(KYC-only off\) \| 0x7D \|/);
    expect(s8).toContain(`| ${mask(PAUSE_FLAGS_ALL & ~PAUSE_ISSUER_PROCEEDS)} |`);
    expect(s8).toContain(`the mode's mask minus ${mask(PAUSE_CUSTODY_ENTRY)}`);
    expect(s8).toContain(`the mode's mask minus ${mask(PAUSE_SECONDARY)}`);
    expect(s8).toMatch(/held the pilot's 0x7E on 2026-10-10/);
    expect(s8).toMatch(/0x7F is the target/);
  });

  it("never resumes everything on mainnet and expects the inventory blocker in KYC-only mode", () => {
    expect(s8).toMatch(/never use\s+"Resume everything" or `chain:emergency unpause all`/);
    expect(s8).toContain("CHAIN_HANDOVER_WHILE_PAUSED=1");
    expect(s8).toMatch(/`unpauseMask`\s+1/);
    expect(s8).not.toMatch(/0x1c|0x5c/i);
  });

  it("keeps the 0x1c / 0x5c arithmetic only as the company example of §5", () => {
    const outsideS5 = runbook.replace(runbookSection(5), "");
    expect(outsideS5).not.toMatch(/0x1c|0x5c/i);
    expect(runbook).not.toMatch(/set 0x1c again|pilot mask/);
    expect(runbookSection(5)).toMatch(/restore the mode's mask, §8/);
  });

  it("answers the primary-open-idle alarm and names the areas, never `all`, for a mainnet unpause", () => {
    const s15 = runbookSection(15);
    expect(s15).toMatch(/\| `onchain:primary-open-idle`[^|]*\| [^|]*sets 0x02 again/);
    expect(runbookSection(11)).toMatch(/On mainnet name the areas of the §8 row, never `all`/);
  });
});
