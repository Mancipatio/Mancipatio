// What the public token migration pages share: the module notice (shown
// above the campaigns while the module is off, which never hides a
// campaign's proof), the plain-words ratio and the "how it works" steps.
import { PilotModuleNotice } from "@/components/pilot-module-notice";
import { Steps } from "@/components/mx";
import { moduleEnabled } from "@/lib/features";
import type { ModuleRouteState } from "@/lib/pilot-scope";
import { ratioSentence } from "@/lib/token-migration/model";
import { formatBaseUnits, percentClause, unitPercent } from "@/lib/token-migration/ratio";

const OFF_STATE: ModuleRouteState = {
  route: { prefix: "/migrations", modules: ["tokenMigration"], mode: "gate" },
  off: ["tokenMigration"],
  disabled: true,
};

/** The module notice, or nothing while the module is on. */
export function MigrationModuleNotice() {
  if (moduleEnabled("tokenMigration")) return null;
  return <PilotModuleNotice state={OFF_STATE} gate />;
}

/** "1 Manci unit for every 5,000 OLD; 1 unit = 0.0001 % of Acme d.o.o." ("≈" when the share is rounded). */
export function ratioWords(m: { lot_base_units: string; old_decimals: number; old_symbol: string; granularity: number; company_name: string }): string {
  return `${ratioSentence(formatBaseUnits(BigInt(m.lot_base_units), m.old_decimals), m.old_symbol)}; 1 unit ${percentClause(unitPercent(BigInt(m.granularity)))} of ${m.company_name}`;
}

export function dateText(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", { dateStyle: "long", timeStyle: "short", timeZone: "UTC" }) + " UTC";
}

export function HowItWorks() {
  return (
    <Steps
      className="mt-6 max-w-[820px]"
      items={[
        {
          title: "The company decides",
          body: "Its shareholders decide what share of the company goes to the token's holders, and the Swap Terms set the ratio, the opt-in window and what happens to units nobody claims. The document's SHA-256 is published with the campaign.",
        },
        {
          title: "Holders deposit whole lots",
          body: "During the window, a holder sends exact multiples of the lot from its own wallet to the campaign's deposit account, with a memo naming the campaign. Each deposit is checked on chain once it is final.",
        },
        {
          title: "Manci delivers the units",
          body: "Manci's operator sends each holder its units of the company's share class from the treasury wallet. A deposit that breaks the campaign's rules (not a whole number of lots, outside the window, over the cap) is refunded to the wallet it came from.",
        },
        {
          title: "The campaign closes with a report",
          body: "After the window, the collected old tokens are burned as the Swap Terms provide, and a final report lists every deposit, delivery and refund. Its SHA-256 is published, so anyone can check the file they download.",
        },
      ]}
    />
  );
}
