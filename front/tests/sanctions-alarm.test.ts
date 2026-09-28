// The alarm worker's sanctions-list check (8.5, lib/server/alarm-checks.ts):
// the list the screened routes trust must be younger than 3 days and not
// empty. Mainnet: fail, high (the routes refuse without it); before that a
// failed refresh or a list older than 36 hours fails as medium (the early
// warning). Elsewhere: hold (nothing opens), low. A database without
// migration 0078 reads as "never loaded", not as a check that could not run.
import { describe, expect, it, vi } from "vitest";
import { memorySupabase } from "./helpers/memory-supabase";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/rpc", () => ({ getServerRpc: () => ({}) }));

import { sanctionsListReport } from "@/lib/server/alarm-checks";
import { OFAC_SDN_SOURCE } from "@/lib/ofac-sdn";
import { SANCTIONS_MAX_LIST_AGE_MS } from "@/lib/server/sanctions";

const NOW = Date.parse("2026-09-28T12:00:00Z");
const signal = () => AbortSignal.timeout(5_000);

function withState(refreshedAt: number | null, addressCount = 4, lastAttempt: { status: string; error: string | null } = { status: "ok", error: null }) {
  const db = memorySupabase();
  if (refreshedAt !== null) {
    db.rows("sanctions_list_state").push({
      source: OFAC_SDN_SOURCE, refreshed_at: new Date(refreshedAt).toISOString(), address_count: addressCount,
      published_on: "2026-09-23", last_attempt_at: new Date(refreshedAt).toISOString(), last_status: lastAttempt.status,
      last_error: lastAttempt.error,
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

  it("warns early (medium) on mainnet while the list still works: a failed refresh, or older than 36 hours", async () => {
    const failed = await sanctionsListReport(
      withState(NOW - 20 * 3_600_000, 4, { status: "failed", error: "RECORD_COUNT_MISMATCH" }).client as never, "mainnet", NOW, signal(),
    );
    expect(failed).toMatchObject({ state: "fail", severity: "medium", evidence: { problem: null, warning: "LAST_REFRESH_FAILED" } });
    expect(failed?.summary).toBe(
      "The sanctions screening list did not refresh (last attempt failed: RECORD_COUNT_MISMATCH): screened routes refuse on mainnet in about 52 hours",
    );
    const late = await sanctionsListReport(withState(NOW - 40 * 3_600_000).client as never, "mainnet", NOW, signal());
    expect(late).toMatchObject({ state: "fail", severity: "medium", evidence: { warning: "LIST_LATE" } });
    expect(late?.summary).toBe("The sanctions screening list was last refreshed 40 hours ago: screened routes refuse on mainnet in about 32 hours");
    // A list younger than 36 hours with a good last refresh passes; devnet only holds.
    expect(await sanctionsListReport(withState(NOW - 30 * 3_600_000).client as never, "mainnet", NOW, signal())).toMatchObject({ state: "pass" });
    expect(await sanctionsListReport(withState(NOW - 40 * 3_600_000).client as never, "devnet", NOW, signal())).toMatchObject({ state: "hold", severity: "low" });
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
