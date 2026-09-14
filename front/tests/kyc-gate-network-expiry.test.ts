// The shared off-chain KYC gate must be bound to the active network AND to a
// live kyc_expires_at.
//
// The stub is an isolated harness: a PostgREST-like builder
// that applies every .eq() predicate over an in-memory `clients` table and
// projects the selected columns — so a gate that forgets to filter by
// network, or to select kyc_expires_at, is caught here rather than in
// production. No network access: fetch throws.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { lookupClientKyc, requireVerifiedClient } from "@/lib/server/kyc-gate";

const wallet = "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2";
const FUTURE = "2099-01-01T00:00:00Z";
const PAST = "2000-01-01T00:00:00Z";

type Row = {
  id: string;
  wallet: string;
  network: string;
  kyc_status: string | null;
  kyc_expires_at: string | null;
  created_at?: string;
};

function sb(rows: Row[]) {
  const predicates: Array<[string, unknown]> = [];
  let fields: string[] = [];
  const query = {
    select(value: string) {
      fields = value.split(",").map((x) => x.trim());
      return query;
    },
    eq(field: string, value: unknown) {
      predicates.push([field, value]);
      return query;
    },
    order() {
      return query;
    },
    then(
      resolve: (value: { data: Record<string, unknown>[]; error: null }) => unknown,
      reject?: (reason: unknown) => unknown,
    ) {
      const data = rows
        .filter((row) =>
          predicates.every(([k, v]) => row[k as keyof Row] === v),
        )
        .map((row) =>
          Object.fromEntries(fields.map((k) => [k, row[k as keyof Row]])),
        );
      return Promise.resolve({ data, error: null }).then(resolve, reject);
    },
  };
  const client = {
    from(table: string) {
      if (table !== "clients") throw new Error("Unexpected table");
      return query;
    },
  };
  return client as unknown as Parameters<typeof requireVerifiedClient>[0];
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
  vi.stubGlobal("fetch", () => {
    throw new Error("Network access forbidden in isolated review");
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("KYC gate — network + expiry binding", () => {
  it("rejects a single verified dossier from another network at devnet intake", async () => {
    const client = sb([
      { id: "synthetic-mainnet-only", wallet, network: "mainnet", kyc_status: "verified", kyc_expires_at: FUTURE },
    ]);
    await expect(requireVerifiedClient(client, wallet)).rejects.toMatchObject({ status: 403 });
    // The unsigned eligibility shape must agree: no dossier on this network.
    await expect(lookupClientKyc(client, wallet)).resolves.toMatchObject({
      hasClient: false,
      eligible: false,
    });
  });

  it("rejects verified status when its explicit verification expiry is past", async () => {
    const client = sb([
      { id: "synthetic-expired", wallet, network: "devnet", kyc_status: "verified", kyc_expires_at: PAST },
    ]);
    await expect(requireVerifiedClient(client, wallet)).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining("expired on 2000-01-01"),
    });
    await expect(lookupClientKyc(client, wallet)).resolves.toMatchObject({
      hasClient: true,
      kycStatus: "verified",
      expired: true,
      eligible: false,
    });
  });

  it("rejects verified status when no verification expiry was ever recorded (fail closed)", async () => {
    const client = sb([
      { id: "synthetic-no-expiry", wallet, network: "devnet", kyc_status: "verified", kyc_expires_at: null },
    ]);
    await expect(requireVerifiedClient(client, wallet)).rejects.toMatchObject({ status: 403 });
  });

  it("accepts a verified, unexpired dossier of the active network", async () => {
    const client = sb([
      { id: "synthetic-current", wallet, network: "devnet", kyc_status: "verified", kyc_expires_at: FUTURE },
    ]);
    await expect(requireVerifiedClient(client, wallet)).resolves.toEqual({
      clientId: "synthetic-current",
    });
  });

  it("follows the deployment network, not a hard-coded cluster", async () => {
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "mainnet");
    const client = sb([
      { id: "synthetic-mainnet", wallet, network: "mainnet", kyc_status: "verified", kyc_expires_at: FUTURE },
      { id: "synthetic-devnet", wallet, network: "devnet", kyc_status: "verified", kyc_expires_at: FUTURE },
    ]);
    await expect(requireVerifiedClient(client, wallet)).resolves.toEqual({
      clientId: "synthetic-mainnet",
    });
  });

  it("does not let a historical terminal row from another network deny current-network intake", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = sb([
      { id: "synthetic-current", wallet, network: "devnet", kyc_status: "verified", kyc_expires_at: FUTURE },
      { id: "synthetic-other", wallet, network: "mainnet", kyc_status: "suspended", kyc_expires_at: null },
    ]);
    await expect(requireVerifiedClient(client, wallet)).resolves.toEqual({
      clientId: "synthetic-current",
    });
  });

  it("still lets a terminal duplicate ON THE SAME network win over a verified one", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = sb([
      { id: "old", wallet, network: "devnet", kyc_status: "verified", kyc_expires_at: FUTURE },
      { id: "new", wallet, network: "devnet", kyc_status: "suspended", kyc_expires_at: null },
    ]);
    await expect(requireVerifiedClient(client, wallet)).rejects.toMatchObject({ status: 403 });
  });
});
