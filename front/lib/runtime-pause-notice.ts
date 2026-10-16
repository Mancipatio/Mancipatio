import { PAUSE_CUSTODY_ENTRY, PAUSE_PRIMARY, PAUSE_SECONDARY } from "@/lib/pause-flags";

export type RuntimePauseFlow = "primary" | "secondary" | "conversion";
export type RuntimePauseNotice = { tone: "paused" | "unknown"; title: string; description: string; exits: string | null };

const ROUTES: readonly { prefix: string; flow: RuntimePauseFlow }[] = [
  { prefix: "/marketplace/launchpad", flow: "primary" },
  { prefix: "/issuer/launchpad", flow: "primary" },
  { prefix: "/marketplace/otc", flow: "secondary" },
  { prefix: "/markets/resell", flow: "secondary" },
  { prefix: "/portfolio/offers", flow: "secondary" },
  { prefix: "/portfolio/deals", flow: "secondary" },
  { prefix: "/portfolio/listings", flow: "secondary" },
  { prefix: "/portfolio/conversion", flow: "conversion" },
];

/** Whole path segments only; browsing assets is not itself a trading flow. */
export function runtimePauseFlow(path: string): RuntimePauseFlow | null {
  const pathname = path.split(/[?#]/, 1)[0].replace(/\/+$/, "") || "/";
  return ROUTES.find(({ prefix }) => pathname === prefix || pathname.startsWith(`${prefix}/`))?.flow ?? null;
}

/** The issuer overview and progress page cover the whole planned lifecycle. */
export function runtimePauseFlows(path: string): RuntimePauseFlow[] {
  const pathname = path.split(/[?#]/, 1)[0].replace(/\/+$/, "") || "/";
  if (pathname === "/issuer" || pathname === "/issuer/status") return ["primary", "secondary", "conversion"];
  const flow = runtimePauseFlow(path);
  return flow ? [flow] : [];
}

const FLOWS: Record<RuntimePauseFlow, { bit: number; title: string; description: string; exits: string }> = {
  primary: {
    bit: PAUSE_PRIMARY,
    title: "Primary sales are paused",
    description: "Opening new sales and buying tokens in primary sales are currently paused. You can still browse the available information.",
    exits: "Existing sale cancellations and refunds remain available under their usual conditions.",
  },
  secondary: {
    bit: PAUSE_SECONDARY,
    title: "Trading through Manci is paused",
    description: "Creating and funding OTC offers or deals, and taking offers, are currently paused. You can still browse the market.",
    exits: "Existing offers and deals remain accessible for eligible cancellations, expiry and refunds.",
  },
  conversion: {
    bit: PAUSE_CUSTODY_ENTRY,
    title: "Conversion escrow entry is paused",
    description: "Opening new conversion vaults and depositing tokens are currently paused. New conversions can proceed into escrow once this pause is lifted.",
    exits: "Existing requests remain accessible. Eligible token returns and completion of deposited conversions are not blocked by this pause.",
  },
};

/** A clear bit only means this pause is absent, never that a flow is ready
 * for business. Other eligibility checks and platform controls still apply. */
export function runtimePauseNotice(flow: RuntimePauseFlow, flags: number | null): RuntimePauseNotice | null {
  if (flags === null || !Number.isInteger(flags) || flags < 0 || flags > 255) {
    return {
      tone: "unknown",
      title: "Checking transaction availability",
      description: "The live platform pause status has not been confirmed yet.",
      exits: null,
    };
  }
  const current = FLOWS[flow];
  if ((flags & current.bit) === 0) return null;
  return { tone: "paused", title: current.title, description: current.description, exits: current.exits };
}

/** One concise banner for the currently offered parts of an issuer's flow. */
export function combinedRuntimePauseNotice(flows: readonly RuntimePauseFlow[], flags: number | null): RuntimePauseNotice | null {
  const notices = [...new Set(flows)].map((flow) => runtimePauseNotice(flow, flags)).filter((notice) => notice !== null);
  if (notices.length === 0) return null;
  if (notices.length === 1 || notices[0].tone === "unknown") return notices[0];
  const labels: Record<RuntimePauseFlow, string> = {
    primary: "primary sales", secondary: "secondary trading", conversion: "new conversion deposits",
  };
  const paused = [...new Set(flows)].filter((flow) => runtimePauseNotice(flow, flags)?.tone === "paused");
  return {
    tone: "paused",
    title: "Some platform transactions are paused",
    description: `Currently paused: ${paused.map((flow) => labels[flow]).join(", ")}. You can browse the platform, prepare verification and follow your review.`,
    exits: "Existing positions and eligible cancellations, refunds and token returns remain accessible.",
  };
}
