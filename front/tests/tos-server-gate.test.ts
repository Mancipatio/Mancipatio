// Terms-of-Service acceptance on the server (gap 2026-09-28
// pravo-compliance-9): on mainnet /api/launchpad/commit, /api/otc/create and
// /api/resell/create require a tos_acceptances row for (signing wallet,
// TOS_VERSION) and fail closed; test networks keep today's behaviour unless
// TOS_SERVER_GATE=enforce. The client gate (components/tos-gate.tsx) fails
// closed on mainnet too (lib/tos.ts tosGateFailsClosed).
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({ network: "devnet" as "devnet" | "mainnet" }));
vi.mock("@/lib/network", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/network")>()),
  detectNetwork: () => state.network,
}));

import { requireAcceptedTos, tosServerGateEnforced } from "@/lib/server/tos-gate";
import { tosGateFailsClosed } from "@/lib/tos";
import { TOS_VERSION } from "@/lib/tos-version";

const WALLET = "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2";

/** A tos_acceptances reader answering `result`, recording the filters. */
function fakeSb(result: { data: unknown[] | null; error: { message: string } | null } | "throw") {
  const filters: Array<[string, unknown]> = [];
  let reads = 0;
  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: (column: string, value: unknown) => {
      filters.push([column, value]);
      return builder;
    },
    limit: () => (result === "throw" ? Promise.reject(new Error("fetch failed")) : Promise.resolve(result)),
  };
  const sb = {
    from: (table: string) => {
      expect(table).toBe("tos_acceptances");
      reads += 1;
      return builder;
    },
  };
  return { sb: sb as never, filters, reads: () => reads };
}

afterEach(() => {
  state.network = "devnet";
  vi.unstubAllEnvs();
});

describe("tosServerGateEnforced", () => {
  it("is on for mainnet, off for test networks unless TOS_SERVER_GATE=enforce", () => {
    expect(tosServerGateEnforced("mainnet", {})).toBe(true);
    for (const network of ["devnet", "testnet", "localnet"] as const) {
      expect(tosServerGateEnforced(network, {})).toBe(false);
      expect(tosServerGateEnforced(network, { TOS_SERVER_GATE: " enforce " })).toBe(true);
      expect(tosServerGateEnforced(network, { TOS_SERVER_GATE: "true" })).toBe(false);
    }
  });
});

describe("requireAcceptedTos", () => {
  it("devnet: reads nothing and lets the request through (unchanged)", async () => {
    const fake = fakeSb({ data: [], error: null });
    await expect(requireAcceptedTos(fake.sb, WALLET, "committing to a raise")).resolves.toBeUndefined();
    expect(fake.reads()).toBe(0);
  });

  it("mainnet: passes with an acceptance of the version in force", async () => {
    state.network = "mainnet";
    const fake = fakeSb({ data: [{ id: "row-1" }], error: null });
    await expect(requireAcceptedTos(fake.sb, WALLET, "committing to a raise")).resolves.toBeUndefined();
    expect(fake.filters).toEqual([["wallet", WALLET], ["version", TOS_VERSION]]);
  });

  it("mainnet: 409 without an acceptance, 503 when it cannot be checked (fail closed)", async () => {
    state.network = "mainnet";
    await expect(requireAcceptedTos(fakeSb({ data: [], error: null }).sb, WALLET, "posting a resell listing"))
      .rejects.toMatchObject({ status: 409, message: expect.stringMatching(/Accept the current Terms of Service .* before posting a resell listing/) });
    await expect(requireAcceptedTos(fakeSb({ data: null, error: { message: "down" } }).sb, WALLET, "x"))
      .rejects.toMatchObject({ status: 503 });
    await expect(requireAcceptedTos(fakeSb("throw").sb, WALLET, "x")).rejects.toMatchObject({ status: 503 });
  });

  it("devnet with TOS_SERVER_GATE=enforce behaves like mainnet (rehearsal)", async () => {
    vi.stubEnv("TOS_SERVER_GATE", "enforce");
    await expect(requireAcceptedTos(fakeSb({ data: [], error: null }).sb, WALLET, "x")).rejects.toMatchObject({ status: 409 });
  });
});

describe("client gate policy", () => {
  it("fails closed only on mainnet", () => {
    expect(tosGateFailsClosed("mainnet")).toBe(true);
    for (const network of ["devnet", "testnet", "localnet"] as const) {
      expect(tosGateFailsClosed(network)).toBe(false);
    }
  });
});
