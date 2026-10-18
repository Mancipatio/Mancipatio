// After a burn (r2g6-04) the vault directory on /admin/custody must not show
// the realized vault as Active with Trigger and Return buttons: the indexer
// mirror lags the realize by up to a minute, so the mirror's live-state rows
// are re-read from the chain, the burn is confirmed before anything reads it
// back, and the open detail is keyed by the vault, not by its position. The
// custody-entry window (r2g3-14) is shown where the requests are.
import { describe, expect, it } from "vitest";
import { custodyPageSource, topLevelFunction } from "./admin-custody-source.test.helpers";

const page = custodyPageSource();
const functionSource = (name: string) => topLevelFunction(page, name);

describe("the vault directory after a burn", () => {
  it("overlays the chain on the mirror's live rows, drops tombstones and keeps unreadable rows", () => {
    const overlay = functionSource("withLiveVaultStates");
    expect(overlay).toContain("vault.state !== VaultState.Active &&\n        vault.state !== VaultState.Triggered");
    expect(overlay).toContain("abortSignal: AbortSignal.timeout(VAULT_READ_TIMEOUT_MS)");
    expect(overlay).toContain("if (live.exists) return live.data;");
    expect(overlay).toContain("return live.closed ? null : vault;");
    expect(overlay).toContain("} catch {\n        return vault;");
    const ops = functionSource("CustodyOps");
    expect(ops).toContain("const vaults = await withLiveVaultStates(client.runtime.rpc, fromIndexer);");
    expect(ops).toContain("if (current()) setCustomVaults(vaults);");
    // The latest load wins (refreshAll and a detail's onRefresh both reload).
    expect(ops).toContain("const current = vaultsGate.begin();");
  });

  it("selects the detail by the vault's identity and offers a Refresh", () => {
    const ops = functionSource("CustodyOps");
    expect(ops).not.toContain("selectedIdx");
    expect(ops).not.toContain("originalIndex");
    expect(ops).toContain("const [selectedKey, setSelectedKey] = useState<string | null>(null);");
    expect(ops).toContain("key={selectedRow.key}");
    expect(ops).toContain("onClose={() => setSelectedKey(null)}");
    expect(ops).toContain("void refresh();\n            void loadVaults();");
    expect(functionSource("vaultKey")).toContain("`${vault.shareClass}-${vault.vaultId}`");
  });
});

describe("the custody-entry window (r2g3-14)", () => {
  it("is read with the display gate and shown at the top of the conversion queue, with no on-chain action", () => {
    expect(page).toContain('import { isPaused, PAUSE_CUSTODY_ENTRY } from "@/lib/pause-flags";');
    expect(page).toContain('import { usePauseFlags } from "@/lib/use-pause-flags";');
    const queue = functionSource("ConversionRequestsSection");
    expect(queue).toContain("const pauseFlags = usePauseFlags();");
    expect(queue).toContain("isPaused(pauseFlags, PAUSE_CUSTODY_ENTRY)");
    expect(queue.indexOf("<CustodyEntryWindow\n")).toBeLessThan(queue.indexOf("Conversion requests\n"));
    expect(queue).toContain("entryOn={conversionOn}");
    expect(queue).toContain("waiting={entryWaiting}");
    const strip = functionSource("CustodyEntryWindow");
    expect(strip).toContain('href="/admin/platform"');
    // Hidden while conversion is off; paused with nothing waiting is the idle
    // state, neutral — never a nudge to resume platform-wide.
    expect(strip).toContain("if (paused === null || !entryOn) return null;");
    expect(strip).toContain("const idle = paused && !waiting;");
    expect(strip).toContain('"border-slate-200 bg-slate-50 text-slate-600"');
    expect(strip).not.toMatch(/getSetPauseFlagsInstruction|tx\.send|recordAudit/);
    expect(page.match(/CUSTODY_ENTRY_PAUSED_HINT/g)).toHaveLength(2);
    // The delivery queue does not read it (no new identifier there).
    expect(functionSource("DeliveryRequestsSection")).not.toContain("usePauseFlags");
  });

  it("an approval tells the operator to close the window once the deposit lands", () => {
    for (const name of ["ApproveConversionModal", "ApproveDeliveryModal"])
      expect(functionSource(name)).toContain("Pause custody entry (0x08) on /admin/platform once the deposit lands.");
  });
});
