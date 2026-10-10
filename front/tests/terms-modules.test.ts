// The module flags follow the mainnet Terms (next.config.ts
// assertBuildMainnetModules): a mainnet production build refuses a
// NEXT_PUBLIC_FEATURE_* module flag that is on while its module is not in
// MAINNET_TERMS.offeredModules (lib/legal/mainnet-copy.ts). One-way: a module
// the Terms offer may have its flag off, so a rollback that switches a module
// off builds without a new version of the Terms. The end-to-end cases (the
// guard wired into `next build`) are in scripts/ci/mainnet-build.sh.
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FEATURE_FLAG_NAMES,
  FEATURE_FLAG_VALUES,
  TERMS_MODULE_FLAGS,
  assertBuildMainnetModules,
  featureFlagOn,
} from "@/next.config";
import { TERMS_MODULES, type TermsModule } from "@/lib/legal/document";
import { MAINNET_TERMS } from "@/lib/legal/mainnet-copy";
import { PILOT_MODULE_ENV, PILOT_MODULES, features, parseFeatureFlag, pilotModules, type PilotModule } from "@/lib/features";

const BUILD = "phase-production-build";
const DEV = "phase-development-server";
const MAINNET = { NEXT_PUBLIC_NETWORK: "mainnet" };
const ON_VALUES = ["true", "1", "yes", "on", " ON ", "True"];
const OFF_VALUES = ["false", "0", "no", "off", " OFF ", ""];
const offering = (...offeredModules: TermsModule[]) => ({ offeredModules });

afterEach(() => vi.unstubAllEnvs());

describe("TERMS_MODULES and their flags", () => {
  it("cover every pilot module, plus payout airdrops and Startup raises, with the variables lib/features.ts reads", () => {
    expect([...TERMS_MODULES].sort()).toEqual(Object.keys(TERMS_MODULE_FLAGS).sort());
    for (const name of PILOT_MODULES) {
      expect(TERMS_MODULES).toContain(name);
      expect(TERMS_MODULE_FLAGS[name], name).toBe(PILOT_MODULE_ENV[name]);
    }
    expect(TERMS_MODULE_FLAGS.payoutAirdrop).toBe("NEXT_PUBLIC_FEATURE_PAYOUT_AIRDROP");
    expect(TERMS_MODULE_FLAGS.startupRaises).toBe("NEXT_PUBLIC_FEATURE_STARTUP_RAISES");
  });

  it("leave out only the operational flags: a new flag needs a decision here", () => {
    for (const flag of Object.values(TERMS_MODULE_FLAGS)) expect(FEATURE_FLAG_NAMES).toContain(flag);
    const notModules = FEATURE_FLAG_NAMES.filter((name) => !Object.values(TERMS_MODULE_FLAGS).includes(name));
    expect(notModules.sort()).toEqual(["NEXT_PUBLIC_FEATURE_ISSUER_ROTATION", "NEXT_PUBLIC_FEATURE_PASSPORT_CLOSE"]);
    const otherFeatures = Object.keys(features("mainnet")).filter((name) => !(TERMS_MODULES as readonly string[]).includes(name));
    expect(otherFeatures.sort()).toEqual(["issuerRotation", "passportClose"]);
  });

  it("featureFlagOn reads a value as lib/features.ts does", () => {
    for (const value of [...FEATURE_FLAG_VALUES, ...ON_VALUES, ...OFF_VALUES, "ture", "enabled", undefined]) {
      expect(featureFlagOn(value), String(value)).toBe(parseFeatureFlag(value) === true);
    }
  });

  it("a flag the build reads as on switches its module on at runtime on mainnet, and only then", () => {
    const runtime = (name: TermsModule): boolean =>
      (PILOT_MODULES as readonly string[]).includes(name)
        ? pilotModules("mainnet")[name as PilotModule]
        : features("mainnet")[name as "payoutAirdrop" | "startupRaises"];
    for (const name of TERMS_MODULES) {
      for (const value of [...ON_VALUES, ...OFF_VALUES]) {
        for (const flag of Object.values(TERMS_MODULE_FLAGS)) vi.stubEnv(flag, "");
        vi.stubEnv(TERMS_MODULE_FLAGS[name], value);
        expect(runtime(name), `${name}=${value}`).toBe(featureFlagOn(value));
      }
    }
  });
});

describe("MAINNET_TERMS.offeredModules (committed)", () => {
  it("offers trading through Manci and conversion in version 2026-10-10, as clause 2 does", () => {
    expect(MAINNET_TERMS?.version).toBe("2026-10-10");
    expect(MAINNET_TERMS?.offeredModules).toEqual(["secondaryTrading", "custodyConversion"]);
    // Clause 2: the "currently offers" list names both modules (clauses 7A and
    // 7B); the list of what is not available names neither.
    const scope = MAINNET_TERMS!.clauses.find((c) => c.title === "2. Scope of the Service")!;
    const listAfter = (lead: string) => {
      const at = scope.blocks.findIndex((b) => b.kind === "paragraph" && b.text === lead);
      const block = scope.blocks[at + 1];
      return block?.kind === "list" ? block.items.join("\n") : "";
    };
    const offered = listAfter("The Service currently offers the following:");
    const off = listAfter("The following are not available at present, and the pages that carry them say so:");
    expect(offered).toMatch(/^Trading through Manci: .*\(clause 7A\)/m);
    expect(offered).toMatch(/^Conversion of tokens into company shares, where the issuer offers it\..*7B\)/m);
    expect(off).not.toMatch(/trading through Manci|conver/i);
    for (const named of ["Vested (Startup) raises", "physical delivery", "distributions", "vesting", "governance", "Rights-Token"]) {
      expect(off, named).toContain(named);
    }
  });

  it("names modules only, each once", () => {
    const offered = MAINNET_TERMS?.offeredModules ?? [];
    for (const name of offered) expect(TERMS_MODULES).toContain(name);
    expect(new Set(offered).size).toBe(offered.length);
  });

  it("is what the guard reads by default: a flag on passes only for an offered module", () => {
    const offered = MAINNET_TERMS?.offeredModules ?? [];
    for (const name of TERMS_MODULES) {
      const build = () => assertBuildMainnetModules(BUILD, { ...MAINNET, [TERMS_MODULE_FLAGS[name]]: "true" });
      if (offered.includes(name)) expect(build, name).not.toThrow();
      else expect(build, name).toThrow(new RegExp(`switches on ${name}, which the mainnet Terms do not offer`));
    }
    expect(() => assertBuildMainnetModules(BUILD, MAINNET)).not.toThrow();
  });

  it("builds the committed Terms with trading and conversion on, either one off (a rollback), and refuses delivery", () => {
    const env = (trading: string, conversion: string) => ({
      ...MAINNET,
      NEXT_PUBLIC_FEATURE_SECONDARY_TRADING: trading,
      NEXT_PUBLIC_FEATURE_CUSTODY_CONVERSION: conversion,
    });
    expect(() => assertBuildMainnetModules(BUILD, env("true", "true"))).not.toThrow();
    expect(() => assertBuildMainnetModules(BUILD, env("false", "true"))).not.toThrow();
    expect(() => assertBuildMainnetModules(BUILD, env("true", ""))).not.toThrow();
    // Conversion runs through a delivery-type escrow, but the Terms do not offer physical delivery.
    expect(() => assertBuildMainnetModules(BUILD, { ...env("true", "true"), NEXT_PUBLIC_FEATURE_CUSTODY_DELIVERY: "true" }))
      .toThrow(/switches on custodyDelivery, which the mainnet Terms do not offer/);
  });
});

describe("assertBuildMainnetModules", () => {
  it("refuses every module flag that reads as on while the Terms offer no module", () => {
    for (const name of TERMS_MODULES) {
      const flag = TERMS_MODULE_FLAGS[name];
      for (const value of ON_VALUES) {
        expect(() => assertBuildMainnetModules(BUILD, { ...MAINNET, [flag]: value }, offering()), `${flag}=${value}`).toThrow(
          `${flag}="${value}" switches on ${name}, which the mainnet Terms do not offer`,
        );
      }
    }
  });

  it("names every refused flag at once, and what the Terms offer", () => {
    const env = {
      ...MAINNET,
      NEXT_PUBLIC_FEATURE_SECONDARY_TRADING: "true",
      NEXT_PUBLIC_FEATURE_CUSTODY_CONVERSION: "1",
    };
    let message = "";
    try {
      assertBuildMainnetModules(BUILD, env, offering());
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/^Refusing a mainnet build: a module flag is on that the mainnet Terms do not offer/);
    expect(message).toContain('NEXT_PUBLIC_FEATURE_SECONDARY_TRADING="true" switches on secondaryTrading');
    expect(message).toContain('NEXT_PUBLIC_FEATURE_CUSTODY_CONVERSION="1" switches on custodyConversion');
    expect(message).toContain("The Terms offer: no module.");
  });

  it("passes flags that are off or unset", () => {
    for (const value of [...OFF_VALUES, undefined]) {
      const env = { ...MAINNET, ...Object.fromEntries(Object.values(TERMS_MODULE_FLAGS).map((flag) => [flag, value])) };
      expect(() => assertBuildMainnetModules(BUILD, env, offering()), String(value)).not.toThrow();
    }
  });

  it("is one-way: an offered module passes with its flag on or off (a rollback builds)", () => {
    const terms = offering("secondaryTrading", "custodyConversion");
    const env = (trading: string, conversion: string) => ({
      ...MAINNET,
      NEXT_PUBLIC_FEATURE_SECONDARY_TRADING: trading,
      NEXT_PUBLIC_FEATURE_CUSTODY_CONVERSION: conversion,
    });
    expect(() => assertBuildMainnetModules(BUILD, env("true", "true"), terms)).not.toThrow();
    expect(() => assertBuildMainnetModules(BUILD, env("false", "true"), terms)).not.toThrow();
    expect(() => assertBuildMainnetModules(BUILD, env("true", ""), terms)).not.toThrow();
    expect(() => assertBuildMainnetModules(BUILD, env("off", "0"), terms)).not.toThrow();
    // A module these Terms do not offer stays refused.
    expect(() => assertBuildMainnetModules(BUILD, { ...env("true", "true"), NEXT_PUBLIC_FEATURE_CUSTODY_DELIVERY: "true" }, terms))
      .toThrow(/NEXT_PUBLIC_FEATURE_CUSTODY_DELIVERY="true" switches on custodyDelivery/);
    expect(() => assertBuildMainnetModules(BUILD, { ...MAINNET, NEXT_PUBLIC_FEATURE_GOVERNANCE: "on" }, terms))
      .toThrow(/The Terms offer: secondaryTrading, custodyConversion\./);
  });

  it("refuses an offeredModules entry that is no module", () => {
    expect(() => assertBuildMainnetModules(BUILD, MAINNET, { offeredModules: ["secondaryTrade"] as never }))
      .toThrow(/MAINNET_TERMS\.offeredModules .* names no module: secondaryTrade/);
  });

  it("treats Terms that are not in the slot as offering no module", () => {
    expect(() => assertBuildMainnetModules(BUILD, MAINNET, null)).not.toThrow();
    expect(() => assertBuildMainnetModules(BUILD, { ...MAINNET, NEXT_PUBLIC_FEATURE_SECONDARY_TRADING: "true" }, null))
      .toThrow(/switches on secondaryTrading/);
  });

  it("checks mainnet production builds only, including one whose RPC URL makes it mainnet", () => {
    const allOn = Object.fromEntries(Object.values(TERMS_MODULE_FLAGS).map((flag) => [flag, "true"]));
    for (const network of ["devnet", "testnet", "localnet"]) {
      expect(() => assertBuildMainnetModules(BUILD, { ...allOn, NEXT_PUBLIC_NETWORK: network }, offering()), network).not.toThrow();
    }
    expect(() => assertBuildMainnetModules(DEV, { ...allOn, ...MAINNET }, offering())).not.toThrow();
    expect(() => assertBuildMainnetModules(BUILD, { ...allOn, NEXT_PUBLIC_SOLANA_RPC_URL: "https://rpc.mainnet.example" }, offering()))
      .toThrow(/Refusing a mainnet build/);
  });
});
