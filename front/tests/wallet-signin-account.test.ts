import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ verify: vi.fn(), profile: vi.fn() }));
vi.mock("@/lib/server/siws", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/siws")>()),
  verifySigned: mocks.verify,
}));
vi.mock("@/lib/server/account-profile", () => ({ getAccountProfile: mocks.profile }));

import { POST, DELETE } from "@/app/api/auth/session/route";
import { SiwsError } from "@/lib/server/siws";
import { MaintenanceError } from "@/lib/server/maintenance";

const origin = "https://manci.test";
const wallet = "11111111111111111111111111111111";
const request = () => new Request(`${origin}/api/auth/session`, {
  method: "POST", headers: { origin, "Content-Type": "application/json" },
  body: JSON.stringify({ payload: { origin } }),
});

beforeEach(() => {
  vi.stubEnv("SESSION_SECRET", "s".repeat(40));
  vi.stubEnv("NEXT_PUBLIC_NETWORK", "mainnet");
  mocks.verify.mockReset().mockResolvedValue({ wallet, params: {} });
  mocks.profile.mockReset().mockResolvedValue({ id: "existing-account" });
});
afterEach(() => vi.unstubAllEnvs());

describe("wallet sign-in registration", () => {
  it("records the verified wallet on the current network before issuing a session", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(mocks.verify).toHaveBeenCalledWith(expect.any(Request), "auth.session");
    expect(mocks.profile).toHaveBeenCalledExactlyOnceWith(wallet, "mainnet");
    expect(mocks.verify.mock.invocationCallOrder[0]).toBeLessThan(mocks.profile.mock.invocationCallOrder[0]);
    expect(await response.json()).toMatchObject({ ok: true, data: { wallet, network: "mainnet" } });
    expect(response.headers.get("set-cookie")).toMatch(/^manci_session=/);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("never records an unverified or refused signature", async () => {
    mocks.verify.mockRejectedValue(new SiwsError(401, "Invalid signature"));
    const response = await POST(request());
    expect(response.status).toBe(401);
    expect(mocks.profile).not.toHaveBeenCalled();
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("does not report successful sign-in if registration failed", async () => {
    mocks.profile.mockRejectedValue(new SiwsError(503, "Your account is temporarily unavailable."));
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("preserves read-only sign-in during maintenance for a wallet without a profile", async () => {
    mocks.profile.mockRejectedValue(new MaintenanceError("Maintenance"));
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toMatch(/^manci_session=/);
  });

  it("does not create an account when sessions are disabled or on sign-out", async () => {
    vi.stubEnv("SESSION_SECRET", "");
    expect((await POST(request())).status).toBe(503);
    expect(mocks.verify).not.toHaveBeenCalled();
    expect((await DELETE(request())).status).toBe(200);
    expect(mocks.profile).not.toHaveBeenCalled();
  });
});
