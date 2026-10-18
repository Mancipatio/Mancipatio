// The page notice for a switched-off pilot-scope module (lib/pilot-scope.ts).
// Rendered by AppShell for every page of a module; the resell board (a
// marketing page) renders it itself. No hooks: the switches are build-time
// NEXT_PUBLIC_* values, identical on the server and in the browser.
import { kycOnly } from "@/lib/features";
import { detectNetwork } from "@/lib/network";
import { MODULE_EXITS_OPEN, moduleNoticeText, type ModuleRouteState } from "@/lib/pilot-scope";

export function PilotModuleNotice({ state, gate = false }: { state: ModuleRouteState; gate?: boolean }) {
  const network = detectNetwork();
  const text = moduleNoticeText(state, network);
  if (!text) return null;
  return (
    <div
      role="status"
      data-pilot-module-notice
      className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
    >
      {/* KYC-only mode (lib/features.ts): every page it pauses, a module's
          included, is "Paused.", which holds whatever the Terms offer. */}
      <strong className="font-semibold">{kycOnly(network) ? "Paused." : network === "mainnet" ? "Not available." : "Switched off."}</strong>{" "}
      <span>{text}</span>
      {!gate && <span className="mt-1 block text-amber-800">{MODULE_EXITS_OPEN}</span>}
    </div>
  );
}
