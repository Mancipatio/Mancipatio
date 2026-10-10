// KYC-only mode (lib/features.ts kycOnly): the one switch over everything but
// sign-up and the identity verification request (owner decision 2026-10-10).
// On mainnet it is ON unless NEXT_PUBLIC_FEATURE_KYC_ONLY reads as off (fail
// closed); elsewhere it is OFF unless it reads as on. While on, every pilot
// module is off whatever its own switch says, the core areas without a
// switch (primary sales, issuance) are off, their pages carry the notice or
// are replaced by it (lib/pilot-scope.ts KYC_ONLY_ROUTES), and their on-chain
// entries are refused before the wallet opens (lib/pause-gate.ts
// KYC_ONLY_FLOWS). Off, every code path is today's: the rest of the suite
// runs with the mode off (vitest.config.ts, project "default") and is the
// proof; the KYC-path and exit suites run again with it on (project
// "kyc-only-on"); this file stubs it ("" = unset). Last, the mode's own
// wording must hold under any version of the Terms: everything is "paused",
// and nothing it says claims which services the Terms offer.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ADD_SHARE_CLASS_DISCRIMINATOR,
  ADD_VESTING_POSITION_DISCRIMINATOR,
  APPROVE_HOLDER_DISCRIMINATOR,
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  AssetRegistryInstruction,
  BUY_DISCRIMINATOR,
  CANCEL_OFFER_DISCRIMINATOR,
  CLAIM_REFUND_DISCRIMINATOR,
  CLOSE_SALE_DISCRIMINATOR,
  CREATE_ASSET_DISCRIMINATOR,
  CREATE_OFFER_DISCRIMINATOR,
  DEPOSIT_TO_CUSTODY_VAULT_DISCRIMINATOR,
  DEPOSIT_TO_VESTING_ESCROW_DISCRIMINATOR,
  FINALIZE_VESTING_SERIES_DISCRIMINATOR,
  getOpenCustodyVaultInstructionDataEncoder,
  INITIALIZE_SHARE_CLASS_MINT_DISCRIMINATOR,
  MINT_TO_TREASURY_DISCRIMINATOR,
  OPEN_SALE_DISCRIMINATOR,
  REALIZE_CUSTODY_VAULT_DISCRIMINATOR,
  RealizeAction,
  REGISTER_ISSUER_DISCRIMINATOR,
  RETURN_CUSTODY_VAULT_DISCRIMINATOR,
  REVERT_CUSTODY_VAULT_DISCRIMINATOR,
  REVOKE_HOLDER_DISCRIMINATOR,
  SET_CONVERTIBLE_TO_DISCRIMINATOR,
  SET_PAUSE_FLAGS_DISCRIMINATOR,
  TRIGGER_CUSTODY_VAULT_DISCRIMINATOR,
  UPDATE_MINT_METADATA_DISCRIMINATOR,
  VaultType,
  VERIFY_ISSUER_KYB_DISCRIMINATOR,
} from "@/lib/generated/asset_registry";
import {
  KYC_ONLY_ENV,
  KYC_ONLY_MESSAGE,
  kycOnly,
  moduleDisabledMessage,
  moduleEnabled,
  PILOT_MODULE_ENV,
  PILOT_MODULES,
  pilotModules,
  scopeDisabledMessage,
  scopeEnabled,
  SCOPE_AREAS,
} from "@/lib/features";
import {
  KYC_ONLY_NAV_PREFIXES,
  KYC_ONLY_ROUTES,
  kycOnlyHides,
  kycOnlyRoute,
  MODULE_ROUTES,
  moduleNoticeText,
  moduleRouteState,
  navHrefVisible,
} from "@/lib/pilot-scope";
import {
  assertInstructionsInScope,
  KYC_ONLY_FLOWS,
  KycOnlyFlowError,
  kycOnlyInstruction,
  ModuleDisabledFlowError,
} from "@/lib/pause-gate";
import { explainSendError } from "@/lib/tx-error";
import { assertBuildFeatureFlags, FEATURE_FLAG_NAMES } from "@/next.config";
import { modulesFact } from "@/lib/module-facts";
import { legalDocumentText } from "@/lib/legal/document";
import { MAINNET_TERMS } from "@/lib/legal/mainnet-copy";

const BUILD = "phase-production-build";
const NETWORKS_OFF_BY_DEFAULT = ["devnet", "testnet", "localnet"] as const;
const ON_SPELLINGS = ["true", "1", "yes", "on", " ON "];
const OFF_SPELLINGS = ["false", "0", "no", "off", " Off "];

/** "" is unset (lib/features.ts parseFeatureFlag reads it as neither). */
function mode(value: string) {
  vi.stubEnv(KYC_ONLY_ENV, value);
}
function clearModules(on: Partial<Record<keyof typeof PILOT_MODULE_ENV, string>> = {}) {
  for (const [module, variable] of Object.entries(PILOT_MODULE_ENV)) {
    vi.stubEnv(variable, on[module as keyof typeof PILOT_MODULE_ENV] ?? "");
  }
}

beforeEach(() => clearModules());
afterEach(() => vi.unstubAllEnvs());

describe("kycOnly(): fail closed on mainnet, a rehearsal elsewhere", () => {
  it("mainnet: on when unset, on for every on spelling and for a typo; off only when it reads as off", () => {
    mode("");
    expect(kycOnly("mainnet")).toBe(true);
    vi.stubEnv(KYC_ONLY_ENV, undefined);
    expect(kycOnly("mainnet")).toBe(true);
    for (const value of ON_SPELLINGS) {
      mode(value);
      expect(kycOnly("mainnet"), value).toBe(true);
    }
    for (const value of OFF_SPELLINGS) {
      mode(value);
      expect(kycOnly("mainnet"), value).toBe(false);
    }
    mode("ture");
    expect(kycOnly("mainnet")).toBe(true);
  });

  it.each(NETWORKS_OFF_BY_DEFAULT)("%s: off when unset, on only for an on spelling", (network) => {
    mode("");
    expect(kycOnly(network)).toBe(false);
    for (const value of ON_SPELLINGS) {
      mode(value);
      expect(kycOnly(network), value).toBe(true);
    }
    for (const value of [...OFF_SPELLINGS, "ture", "maybe"]) {
      mode(value);
      expect(kycOnly(network), value).toBe(false);
    }
  });

  it("the build guard knows the variable and refuses a typo in it", () => {
    expect(FEATURE_FLAG_NAMES).toContain(KYC_ONLY_ENV);
    expect(() => assertBuildFeatureFlags(BUILD, { [KYC_ONLY_ENV]: "ture" })).toThrow(new RegExp(KYC_ONLY_ENV));
    for (const value of ["off", "true", ""]) {
      expect(() => assertBuildFeatureFlags(BUILD, { [KYC_ONLY_ENV]: value }), value).not.toThrow();
    }
  });
});

describe("modules and core areas under the mode", () => {
  const ALL_ON = Object.fromEntries(PILOT_MODULES.map((m) => [m, "true"]));

  it("mainnet default: every module is off whatever its switch says; pilotModules() reports the switches", () => {
    mode("");
    clearModules(ALL_ON);
    for (const name of PILOT_MODULES) expect(moduleEnabled(name, "mainnet"), name).toBe(false);
    expect(Object.values(pilotModules("mainnet")).every(Boolean)).toBe(true);
  });

  it("mainnet with the mode off and only conversion on: today's scope", () => {
    mode("off");
    clearModules({ custodyConversion: "true" });
    for (const name of PILOT_MODULES) expect(moduleEnabled(name, "mainnet"), name).toBe(name === "custodyConversion");
  });

  it("devnet: every module on by default, every module off in a rehearsal", () => {
    mode("");
    for (const name of PILOT_MODULES) expect(moduleEnabled(name, "devnet"), name).toBe(true);
    mode("on");
    for (const name of PILOT_MODULES) expect(moduleEnabled(name, "devnet"), name).toBe(false);
  });

  it("the refusal is the one KYC-only sentence while the mode is on, today's text when it is off", () => {
    mode("");
    for (const name of PILOT_MODULES) expect(moduleDisabledMessage(name, "mainnet")).toBe(KYC_ONLY_MESSAGE);
    mode("off");
    expect(moduleDisabledMessage("secondaryTrading", "mainnet")).toBe(
      "Secondary trading (OTC deals, offers and the resell board): not available on Solana mainnet.",
    );
  });

  it("primary sales and issuance are off exactly while the mode is on", () => {
    for (const [network, value] of [["mainnet", ""], ["mainnet", "off"], ["devnet", ""], ["devnet", "on"]] as const) {
      mode(value);
      for (const area of ["primarySales", "issuance"] as const) {
        expect(scopeEnabled(area, network), `${network}=${value} ${area}`).toBe(!kycOnly(network));
      }
    }
  });

  it("the About page names everything but sign-up and verification as paused", () => {
    mode("");
    expect(modulesFact("mainnet")).toBe(
      "Sign-up and identity verification open; launchpad, issuer applications, OTC settlement, governance and vesting paused for now",
    );
  });
});

describe("pages while the mode is on (mainnet default)", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "mainnet");
    mode("");
  });

  it("the paused areas: gate or notice, by the most specific entry", () => {
    const expected: Array<[string, "gate" | "notice"]> = [
      ["/marketplace/launchpad", "gate"],
      ["/marketplace/launchpad/Sale111", "notice"],
      ["/apply", "gate"],
      ["/issuer", "notice"],
      ["/issuer/onboarding", "gate"],
      ["/issuer/assets", "notice"],
      ["/issuer/assets/abc", "notice"],
      ["/issuer/assets/tokenize", "gate"],
      ["/issuer/share-classes", "gate"],
      ["/issuer/launchpad", "notice"],
      ["/issuer/payouts", "notice"],
    ];
    for (const [path, kind] of expected) {
      const state = moduleRouteState(path, "mainnet");
      expect(state, path).toMatchObject({ disabled: true, route: { mode: kind } });
      expect(kycOnlyRoute(path), path).toBe(state!.route);
      expect(moduleNoticeText(state!, "mainnet"), path).toBe(KYC_ONLY_MESSAGE);
      expect(navHrefVisible(path, "mainnet"), path).toBe(false);
    }
    expect(navHrefVisible("/issuer/assets/tokenize?asset=x", "mainnet")).toBe(false);
    expect(kycOnlyRoute("/issuer/assets/tokenize/x")?.mode).toBe("gate");
  });

  it("module pages stay module pages, off even with their switch on, with the same sentence", () => {
    clearModules({ custodyConversion: "true" });
    for (const path of ["/portfolio/conversion", "/issuer/vesting-series"]) {
      const state = moduleRouteState(path, "mainnet");
      expect(state, path).toMatchObject({ disabled: true, route: { mode: "notice" } });
      expect(MODULE_ROUTES, path).toContain(state!.route);
      expect(moduleNoticeText(state!, "mainnet")).toBe(KYC_ONLY_MESSAGE);
    }
  });

  it("sign-in, the verification request, the portfolio, browsing and the admin console stay", () => {
    for (const path of [
      "/issuer/authority", "/issuer/recovery", "/issuer/rotation",
      "/verify", "/account", "/account/verify", "/login", "/onboarding/x",
      "/portfolio", "/portfolio/history", "/", "/marketplace", "/markets/types", "/contact", "/docs",
      "/admin/kyc", "/admin/clients", "/admin/platform",
    ]) {
      expect(moduleRouteState(path, "mainnet"), path).toBeNull();
      expect(navHrefVisible(path, "mainnet"), path).toBe(true);
    }
  });

  it("the guides of the paused areas leave the menus; shared links filter through kycOnlyHides", () => {
    for (const prefix of KYC_ONLY_NAV_PREFIXES) {
      expect(navHrefVisible(prefix, "mainnet"), prefix).toBe(false);
      expect(moduleRouteState(prefix, "mainnet"), prefix).toBeNull();
    }
    expect(kycOnlyHides("/apply", "mainnet")).toBe(true);
    expect(kycOnlyHides("/verify", "mainnet")).toBe(false);
  });
});

describe("the mode off is today's", () => {
  for (const [network, value] of [["mainnet", "off"], ["devnet", ""]] as const) {
    it(`${network} (${value || "unset"}): no KYC-only page, guide or link filter`, () => {
      vi.stubEnv("NEXT_PUBLIC_NETWORK", network);
      mode(value);
      expect(kycOnly(network)).toBe(false);
      for (const { prefix } of KYC_ONLY_ROUTES) {
        for (const path of [prefix, `${prefix}/x`]) {
          expect(moduleRouteState(path, network), path).toBeNull();
          // /issuer/payouts follows its own menu rule (NAV_ROUTES: distributions or
          // Startup raises), off on mainnet by default, as before.
          const today = !(network === "mainnet" && path.startsWith("/issuer/payouts"));
          expect(navHrefVisible(path, network), path).toBe(today);
        }
      }
      for (const prefix of KYC_ONLY_NAV_PREFIXES) expect(navHrefVisible(prefix, network), prefix).toBe(true);
      for (const href of [...KYC_ONLY_ROUTES.map((r) => r.prefix), ...KYC_ONLY_NAV_PREFIXES, ...MODULE_ROUTES.map((r) => r.prefix)]) {
        expect(kycOnlyHides(href, network), href).toBe(false);
      }
    });
  }

  it("a module page on mainnet is unchanged", () => {
    mode("off");
    expect(moduleRouteState("/portfolio/offers", "mainnet")).toMatchObject({ disabled: true, route: { mode: "notice" } });
    expect(moduleNoticeText(moduleRouteState("/portfolio/offers", "mainnet")!, "mainnet")).toBe(
      "Secondary trading (OTC deals, offers and the resell board): not available on Solana mainnet.",
    );
  });
});

describe("every gate reads moduleEnabled(), never the raw switches", () => {
  function sources(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) out.push(...sources(path));
      else if (/\.(ts|tsx)$/.test(entry)) out.push(path);
    }
    return out;
  }

  it("no app code calls pilotModules( outside lib/features.ts", () => {
    const root = process.cwd();
    const offenders = ["app", "components", "lib"]
      .flatMap((dir) => sources(join(root, dir)))
      .filter((file) => !file.endsWith(join("lib", "features.ts")) && !file.includes(`${join("lib", "generated")}`))
      .filter((file) => readFileSync(file, "utf8").includes("pilotModules("));
    expect(offenders).toEqual([]);
  });
});

describe("before the wallet (KYC_ONLY_FLOWS)", () => {
  const ix = (discriminator: Uint8Array, programAddress: string = ASSET_REGISTRY_PROGRAM_ADDRESS) => ({
    programAddress,
    data: new Uint8Array([...discriminator, ...new Uint8Array(64)]),
  });
  const quarantineVault = () => ({
    programAddress: ASSET_REGISTRY_PROGRAM_ADDRESS,
    data: new Uint8Array(getOpenCustodyVaultInstructionDataEncoder().encode({
      vaultId: BigInt(1), vaultType: VaultType.RedemptionQueue, realizeAction: RealizeAction.BurnAndAttest, amount: BigInt(1),
      deadline: BigInt(0), metadataHash: new Uint8Array(32), beneficiary: "11111111111111111111111111111111" as never,
    })),
  });
  const thrown = (instructions: Array<ReturnType<typeof ix>>, network: "mainnet" | "devnet") => {
    try {
      assertInstructionsInScope(instructions, network);
    } catch (err) {
      return err;
    }
    return null;
  };
  const REFUSED: Array<[string, Uint8Array]> = [
    ["BUY", BUY_DISCRIMINATOR],
    ["OPEN_SALE", OPEN_SALE_DISCRIMINATOR],
    ["MINT_TO_TREASURY", MINT_TO_TREASURY_DISCRIMINATOR],
    ["REGISTER_ISSUER", REGISTER_ISSUER_DISCRIMINATOR],
    ["CREATE_ASSET", CREATE_ASSET_DISCRIMINATOR],
    ["ADD_SHARE_CLASS", ADD_SHARE_CLASS_DISCRIMINATOR],
    ["INITIALIZE_SHARE_CLASS_MINT", INITIALIZE_SHARE_CLASS_MINT_DISCRIMINATOR],
    ["DEPOSIT_TO_CUSTODY_VAULT", DEPOSIT_TO_CUSTODY_VAULT_DISCRIMINATOR],
    ["ADD_VESTING_POSITION", ADD_VESTING_POSITION_DISCRIMINATOR],
    ["FINALIZE_VESTING_SERIES", FINALIZE_VESTING_SERIES_DISCRIMINATOR],
    ["DEPOSIT_TO_VESTING_ESCROW", DEPOSIT_TO_VESTING_ESCROW_DISCRIMINATOR],
  ];
  const OPEN: Array<[string, Uint8Array]> = [
    ["APPROVE_HOLDER", APPROVE_HOLDER_DISCRIMINATOR],
    ["REVOKE_HOLDER", REVOKE_HOLDER_DISCRIMINATOR],
    ["VERIFY_ISSUER_KYB", VERIFY_ISSUER_KYB_DISCRIMINATOR],
    ["SET_PAUSE_FLAGS", SET_PAUSE_FLAGS_DISCRIMINATOR],
    ["TRIGGER_CUSTODY_VAULT", TRIGGER_CUSTODY_VAULT_DISCRIMINATOR],
    ["REALIZE_CUSTODY_VAULT", REALIZE_CUSTODY_VAULT_DISCRIMINATOR],
    ["RETURN_CUSTODY_VAULT", RETURN_CUSTODY_VAULT_DISCRIMINATOR],
    ["REVERT_CUSTODY_VAULT", REVERT_CUSTODY_VAULT_DISCRIMINATOR],
    ["CLAIM_REFUND", CLAIM_REFUND_DISCRIMINATOR],
    ["CLOSE_SALE", CLOSE_SALE_DISCRIMINATOR],
    ["CANCEL_OFFER", CANCEL_OFFER_DISCRIMINATOR],
    ["UPDATE_MINT_METADATA", UPDATE_MINT_METADATA_DISCRIMINATOR],
    ["SET_CONVERTIBLE_TO", SET_CONVERTIBLE_TO_DISCRIMINATOR],
  ];
  const REFUSAL = `${KYC_ONLY_MESSAGE} Nothing was sent to your wallet.`;

  it("lists entries only: no exit, and no finalization but the vesting series'", () => {
    for (const instruction of KYC_ONLY_FLOWS) {
      const name = AssetRegistryInstruction[instruction];
      expect(name).not.toMatch(/^(Cancel|Expire|Claim|Withdraw|Return|Reclaim|Revert|Close|Release|Recover|Push|Disable)/);
      if (name.startsWith("Finalize")) expect(name).toBe("FinalizeVestingSeries");
    }
  });

  for (const [network, value] of [["mainnet", ""], ["devnet", "on"]] as const) {
    it(`${network} (${value || "unset"}): the paused entries are refused with the one sentence`, () => {
      mode(value);
      for (const [name, discriminator] of REFUSED) {
        const err = thrown([ix(discriminator)], network);
        expect(err, name).toBeInstanceOf(KycOnlyFlowError);
        expect((err as Error).message, name).toBe(REFUSAL);
        expect(explainSendError(new Error("x", { cause: err })), name).toBe(REFUSAL);
      }
      // A module entry: refused by its module, with the same sentence.
      clearModules({ secondaryTrading: "true" });
      const offer = thrown([ix(CREATE_OFFER_DISCRIMINATOR)], network);
      expect(offer).toBeInstanceOf(ModuleDisabledFlowError);
      expect((offer as Error).message).toBe(REFUSAL);
    });

    it(`${network} (${value || "unset"}): KYC registry, KYB, the pause, custody recording and exits pass`, () => {
      mode(value);
      for (const [name, discriminator] of OPEN) expect(thrown([ix(discriminator)], network), name).toBeNull();
      expect(thrown([quarantineVault()], network)).toBeNull();
      expect(thrown([ix(BUY_DISCRIMINATOR, "11111111111111111111111111111111")], network)).toBeNull();
    });
  }

  it("mainnet with the mode off: a primary buy passes, as today", () => {
    mode("off");
    expect(thrown([ix(BUY_DISCRIMINATOR)], "mainnet")).toBeNull();
    expect(kycOnlyInstruction([ix(BUY_DISCRIMINATOR)], "mainnet")).toBeNull();
  });
});

describe("the mode's wording holds whatever the Terms in force offer", () => {
  // Terms versions differ in what clause 2 offers (a later version may offer
  // trading and conversion). So nothing the mode says claims which services
  // are or are not offered: every notice is labelled "Paused."
  // (components/pilot-module-notice.tsx, tests/kyc-only-ui.test.ts) and
  // every sentence says "paused for now", which the emergency-pause clause
  // covers for what the Terms offer and is true of what they do not.
  const terms = () => legalDocumentText(MAINNET_TERMS!);
  const SCOPE_CLAIM = /not available|not offered|switched off|on Solana mainnet/i;

  it("the Terms in force let the operator pause primary sales, and a pause never blocks exits", () => {
    expect(terms()).toMatch(/Emergency pause\. Any administrator can pause one or more areas of platform-mediated activity: onboarding, primary sales/);
    expect(terms()).toContain("A pause never blocks exits");
  });

  it("every notice, 403, wallet refusal and the About line: paused, no claim of what is offered, no date", () => {
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "mainnet");
    mode("");
    // Switches that a later Terms version could offer, set on: still paused.
    clearModules({ secondaryTrading: "true", custodyConversion: "true" });
    const sentences: Array<[string, string]> = [
      ["KYC_ONLY_MESSAGE", KYC_ONLY_MESSAGE],
      ...PILOT_MODULES.map((m): [string, string] => [m, moduleDisabledMessage(m, "mainnet")]),
      ...SCOPE_AREAS.map((a): [string, string] => [a, scopeDisabledMessage(a, "mainnet")]),
      ...[...MODULE_ROUTES, ...KYC_ONLY_ROUTES].map((r): [string, string] => {
        const state = moduleRouteState(r.prefix, "mainnet");
        return [r.prefix, state ? moduleNoticeText(state, "mainnet") : ""];
      }),
      ["KycOnlyFlowError", new KycOnlyFlowError(AssetRegistryInstruction.Buy).message],
      ["modulesFact", modulesFact("mainnet")],
    ];
    for (const [name, sentence] of sentences) {
      expect(sentence, name).toMatch(/paused for now/);
      expect(sentence, name).not.toMatch(SCOPE_CLAIM);
      expect(sentence, name).not.toMatch(/\b(later|soon|will|shortly)\b/i);
    }
  });

  it("the About line names nothing as live or shipped while the mode is on", () => {
    mode("");
    expect(modulesFact("mainnet")).not.toMatch(/\b(live|shipped)\b/);
  });
});
