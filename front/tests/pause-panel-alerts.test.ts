// The admin overview's pause rows (components/alerts-card.tsx): the pilot
// mask set on purpose on mainnet is an info row, a bit paused outside it the
// critical "Emergency pause is on", and a mask bit that is clear a window to
// close (the custody-entry window after the holder's deposit, Primary
// issuance once no sale takes buys, Issuer proceeds after the close_sale) or
// a drift from what this build keeps off. Off mainnet the mask is 0, so the
// rows are today's. Pure functions (the vitest environment is node); the
// card's wiring is pinned from its source.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pauseAlerts, pilotPauseMask } from "@/components/alerts-card";
import { EMERGENCY_PAUSE_ANCHOR } from "@/lib/distribute-guidance";
import { PAUSE_EXITS_OPEN } from "@/lib/pause-flags";

const PANEL = `/admin/platform#${EMERGENCY_PAUSE_ANCHOR}`;
const PILOT = 0x7e;

afterEach(() => vi.unstubAllEnvs());

describe("pilotPauseMask: the bits set on purpose, from the switches every gate reads", () => {
  // The env is stubbed explicitly: the "kyc-only-on" vitest project sets KYC_ONLY=on.
  const mainnet = (kycOnly: string, modules: Record<string, string> = {}) => {
    vi.stubEnv("NEXT_PUBLIC_FEATURE_KYC_ONLY", kycOnly);
    for (const name of ["SECONDARY_TRADING", "DISTRIBUTIONS", "RIGHTS", "VESTING"]) {
      vi.stubEnv(`NEXT_PUBLIC_FEATURE_${name}`, modules[name] ?? "");
    }
    return pilotPauseMask("mainnet");
  };

  it("is 0x7F under KYC-only mode (unset = on on mainnet), 0x7E for the plain pilot, 0x7A with OTC on", () => {
    expect(mainnet("")).toBe(0x7f);
    expect(mainnet("off")).toBe(0x7e);
    expect(mainnet("off", { SECONDARY_TRADING: "on" })).toBe(0x7a);
    // Distributions (0x10) stays expected until one of distributions, rights or vesting is on.
    expect(mainnet("off", { DISTRIBUTIONS: "on" })).toBe(0x6e);
    expect(mainnet("off", { RIGHTS: "on" })).toBe(0x6e);
    expect(mainnet("off", { VESTING: "on" })).toBe(0x6e);
    // KYC-only mode overrides every module switch.
    expect(mainnet("on", { SECONDARY_TRADING: "on", DISTRIBUTIONS: "on" })).toBe(0x7f);
  });

  it("is 0 off mainnet: devnet keeps today's rows", () => {
    vi.stubEnv("NEXT_PUBLIC_FEATURE_KYC_ONLY", "");
    expect(pilotPauseMask("devnet")).toBe(0);
    expect(pilotPauseMask("localnet")).toBe(0);
  });
});

describe("pauseAlerts: red means a deviation from the pilot mask", () => {
  it("the steady state (0x7E under 0x7E) is one info row, never the critical one", () => {
    const rows = pauseAlerts(PILOT, PILOT, 0);
    expect(rows).toEqual([{
      level: "info",
      title: "Pilot pause mask active (0x7e)",
      description: `Closed on purpose (Terms and module switches), not an emergency: Primary issuance, Trading through Manci, Custody entry, Distributions, Issuer proceeds, Payout modules. ${PAUSE_EXITS_OPEN}`,
      href: PANEL,
    }]);
  });

  it("an open custody-entry window (0x08 clear) is a warning that says to close it after the deposit", () => {
    const rows = pauseAlerts(0x76, PILOT, 0);
    expect(rows.map((r) => r.level)).toEqual(["info", "warning"]);
    expect(rows[0].title).toBe("Pilot pause mask active (0x76)");
    expect(rows[1]).toMatchObject({ title: "Custody entry window is open — close it after the deposit", href: PANEL });
    expect(rows[1].description).toMatch(/holders can deposit/);
    expect(rows[1].description).toMatch(/Pause custody entry again as soon as the holder's deposit has landed/);
    expect(rows.some((r) => r.level === "critical")).toBe(false);
  });

  it("Primary issuance open (0x02 clear): info while a sale takes buys, a warning with none; Issuer proceeds open is a warning", () => {
    const live = pauseAlerts(0x7c, PILOT, 1);
    expect(live[1]).toMatchObject({ level: "info", title: "Primary issuance is open for 1 live sale", href: "/admin/launchpad" });
    expect(pauseAlerts(0x7c, PILOT, 2)[1].title).toBe("Primary issuance is open for 2 live sales");
    const idle = pauseAlerts(0x7c, PILOT, 0);
    expect(idle[1]).toMatchObject({ level: "warning", title: "Primary issuance is open with no sale taking buys", href: "/admin/launchpad" });
    const proceeds = pauseAlerts(0x5e, PILOT, 0);
    expect(proceeds[1]).toMatchObject({ level: "warning", title: "Issuer proceeds is open (0x20)", href: "/admin/launchpad" });
  });

  it("a bit paused outside the mask is the critical row (same text and link as before), beside the mask's info row", () => {
    const rows = pauseAlerts(0x7f, 0x7a, 0);
    expect(rows[0]).toEqual({
      level: "critical",
      title: "Emergency pause is on",
      description: `Paused: Onboarding, Trading through Manci. ${PAUSE_EXITS_OPEN}`,
      href: "/admin/platform",
    });
    expect(rows[1]).toMatchObject({ level: "info", title: "Pilot pause mask active (0x7a)" });
    expect(rows).toHaveLength(2);
  });

  it("a non-window bit the build keeps off but the chain has open is a warning (today's 0x7E under KYC-only mode: Onboarding)", () => {
    const onboarding = pauseAlerts(PILOT, 0x7f, 0);
    expect(onboarding.map((r) => r.level)).toEqual(["info", "warning"]);
    expect(onboarding[1]).toMatchObject({ title: "Onboarding: open on-chain, off on this site", href: PANEL });
    expect(onboarding[1].description).toMatch(/KYC-only mode or its module switch/);
    // The payout modules switched on under the mainnet mask (the server alarm is the critical one).
    const payout = pauseAlerts(0x3e, PILOT, 0);
    expect(payout[1]).toMatchObject({ level: "warning", title: "Payout modules: open on-chain, off on this site" });
    // Every open window and drift at once, in bit order after the windows.
    expect(pauseAlerts(0x40, 0x7f, 0).map((r) => r.title)).toEqual([
      "Pilot pause mask active (0x40)",
      "Custody entry window is open — close it after the deposit",
      "Primary issuance is open with no sale taking buys",
      "Issuer proceeds is open (0x20)",
      "Onboarding: open on-chain, off on this site",
      "Trading through Manci: open on-chain, off on this site",
      "Distributions: open on-chain, off on this site",
    ]);
  });

  it("with no mask (devnet) the rows are today's: any paused emergency area is critical, 0x40 alone is nothing", () => {
    expect(pauseAlerts(0x0c, 0, 0)).toEqual([{
      level: "critical",
      title: "Emergency pause is on",
      description: `Paused: Trading through Manci, Custody entry. ${PAUSE_EXITS_OPEN}`,
      href: "/admin/platform",
    }]);
    expect(pauseAlerts(0x40, 0, 0)).toEqual([]);
    expect(pauseAlerts(0, 0, 0)).toEqual([]);
    expect(pauseAlerts(null, 0, 0)).toEqual([]);
    expect(pauseAlerts(null, PILOT, 0)).toEqual([]);
  });

  it("the card reads the live flags (re-read every 30 s) and the pilot mask", () => {
    const src = readFileSync(join(process.cwd(), "components/alerts-card.tsx"), "utf8");
    expect(src).toContain("const liveFlags = usePauseFlags();");
    expect(src).toContain("platformPaused: platformInitialized ? (liveFlags ?? platformPaused) : null");
    expect(src).toContain("expected: pilotPauseMask()");
    expect(src).toContain("alerts.push(...pauseAlerts(platformPaused, expected, liveSales));");
    expect(src).not.toMatch(/level: "critical",\s*title: "Emergency pause is on"[\s\S]*level: "critical",\s*title: "Emergency pause is on"/);
  });
});
