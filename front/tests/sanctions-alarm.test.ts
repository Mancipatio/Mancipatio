// The alarm worker's sanctions-list check (8.5, lib/server/alarm-checks.ts):
// the list the screened routes trust must be younger than 3 days and not
// empty. Mainnet: fail, high (the routes refuse without it). Elsewhere: hold
// (nothing opens), low. A database without migration 0078 reads as "never
// loaded", not as a check that could not run.
import { describe, expect, it, vi } from "vitest";
import { memorySupabase } from "./helpers/memory-supabase";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/rpc", () => ({ getServerRpc: () => ({}) }));

import { sanctionsListReport } from "@/lib/server/alarm-checks";
import { OFAC_SDN_SOURCE } from "@/lib/ofac-sdn";
import { SANCTIONS_MAX_LIST_AGE_MS } from "@/lib/server/sanctions";

const NOW = Date.parse("2026-09-28T12:00:00Z");
const signal = () => AbortSignal.timeout(5_000);

function withState(refreshedAt: number | null, addressCount = 4) {
  const db = memorySupabase();
  if (refreshedAt !== null) {
    db.rows("sanctions_list_state").push({
      source: OFAC_SDN_SOURCE, refreshed_at: new Date(refreshedAt).toISOString(), address_count: addressCount,
      published_on: "2026-09-23", last_attempt_at: new Date(refreshedAt).toISOString(), last_status: "ok", last_error: null,
    });
  }
  return db;
}

describe("sanctions-list incident", () => {
  it("passes on a fresh list", async () => {
    const report = await sanctionsListReport(withState(NOW - 3_600_000).client as never, "mainnet", NOW, signal());
    expect(report).toMatchObject({ check: "sanctions-list", state: "pass", severity: "high", source: "worker:sanctions-list" });
  });

  it("fails (high) on mainnet when stale, empty or never loaded; holds (low) elsewhere", async () => {
    for (const db of [withState(NOW - SANCTIONS_MAX_LIST_AGE_MS - 1), withState(NOW - 3_600_000, 0), withState(null)]) {
      expect(await sanctionsListReport(db.client as never, "mainnet", NOW, signal())).toMatchObject({ state: "fail", severity: "high" });
      expect(await sanctionsListReport(db.client as never, "devnet", NOW, signal())).toMatchObject({ state: "hold", severity: "low" });
    }
    const stale = await sanctionsListReport(withState(NOW - 4 * 24 * 3_600_000).client as never, "mainnet", NOW, signal());
    expect(stale?.summary).toBe("The sanctions screening list was last refreshed 96 hours ago: screened routes refuse on mainnet");
  });

  it("a database without 0078 is 'never loaded'; any other read error is a check that could not run", async () => {
    const missing = memorySupabase();
    missing.failReads.add("sanctions_list_state");
    missing.readErrorCodes.sanctions_list_state = "PGRST205";
    expect(await sanctionsListReport(missing.client as never, "devnet", NOW, signal())).toMatchObject({ state: "hold" });
    const broken = memorySupabase();
    broken.failReads.add("sanctions_list_state");
    expect(await sanctionsListReport(broken.client as never, "mainnet", NOW, signal())).toBeNull();
  });
});
