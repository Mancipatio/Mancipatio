import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ admin: vi.fn(), rpc: vi.fn(), abort: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseAdmin: mocks.admin }));
import { reserveAssistantQuota } from "@/lib/server/assistant-quota";

const KEY = "synthetic-test-key";
const hash = (ip: string) => createHmac("sha256", KEY).update(ip).digest("hex");
const request = (headers: HeadersInit = {}) => new Request("https://mancipatio.example/api/assistant", {
  method: "POST", headers, body: JSON.stringify({ message: "private test question" }),
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("ANTHROPIC_API_KEY", KEY);
  vi.stubEnv("MANCI_ASSISTANT_DAILY_LIMIT", undefined);
  vi.stubEnv("MANCI_ASSISTANT_RATE_LIMIT_PER_MINUTE", undefined);
  mocks.admin.mockReturnValue({ rpc: mocks.rpc });
  mocks.rpc.mockReturnValue({ abortSignal: mocks.abort });
  mocks.abort.mockResolvedValue({ data: true, error: null });
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("durable public-assistant quota reservation", () => {
  it("sends only the keyed hash and server limits, preferring Vercel's real IP", async () => {
    const input = request({ "x-real-ip": "192.0.2.10", "x-forwarded-for": "198.51.100.1, 203.0.113.2" });
    expect(await reserveAssistantQuota(input)).toBe("allowed");
    expect(mocks.rpc).toHaveBeenCalledWith("consume_assistant_quota", {
      p_key_hash: hash("192.0.2.10"), p_minute_limit: 8, p_daily_limit: 500,
    });
    expect(input.bodyUsed).toBe(false);
    expect(JSON.stringify(mocks.rpc.mock.calls)).not.toContain("192.0.2.10");
    expect(JSON.stringify(mocks.rpc.mock.calls)).not.toContain(KEY);
  });

  it("uses only the rightmost forwarded hop", async () => {
    await reserveAssistantQuota(request({ "x-forwarded-for": "198.51.100.1, 203.0.113.2" }));
    expect(mocks.rpc.mock.calls[0][1].p_key_hash).toBe(hash("203.0.113.2"));
  });

  it.each([{}, { "x-real-ip": "invalid" }, { "x-forwarded-for": "garbage" }] as HeadersInit[])(
    "shares one unknown bucket when no usable address is available: %j", async (headers) => {
      await reserveAssistantQuota(request(headers));
      expect(mocks.rpc.mock.calls[0][1].p_key_hash).toBe(hash("unknown"));
    },
  );

  it("normalizes IPv6 casing", async () => {
    await reserveAssistantQuota(request({ "x-real-ip": "2001:DB8::ABCD" }));
    expect(mocks.rpc.mock.calls[0][1].p_key_hash).toBe(hash("2001:db8::abcd"));
  });

  it.each([
    ["999999", "999999", 60, 10_000],
    ["-5", "0", 1, 1],
    ["NaN", "Infinity", 8, 500],
    ["4", "90", 4, 90],
  ])("bounds configured limits %s / %s", async (minute, daily, expectedMinute, expectedDaily) => {
    vi.stubEnv("MANCI_ASSISTANT_RATE_LIMIT_PER_MINUTE", minute);
    vi.stubEnv("MANCI_ASSISTANT_DAILY_LIMIT", daily);
    await reserveAssistantQuota(request());
    expect(mocks.rpc.mock.calls[0][1]).toMatchObject({ p_minute_limit: expectedMinute, p_daily_limit: expectedDaily });
  });

  it("shares a three-second abort signal across the admin client and RPC", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    await reserveAssistantQuota(request());
    expect(timeout).toHaveBeenCalledWith(3_000);
    expect(mocks.abort).toHaveBeenCalledWith(mocks.admin.mock.calls[0][0]);
    expect(mocks.abort.mock.calls[0][0]).toBeInstanceOf(AbortSignal);
  });

  it("returns limited only for an explicit false response", async () => {
    mocks.abort.mockResolvedValue({ data: false, error: null });
    expect(await reserveAssistantQuota(request())).toBe("limited");
  });

  it.each([null, "true", [], { allowed: true }])("fails closed on malformed RPC data %j", async (data) => {
    mocks.abort.mockResolvedValue({ data, error: null });
    expect(await reserveAssistantQuota(request())).toBe("unavailable");
  });

  it("fails closed on missing migration, missing Supabase configuration and timeout without logging", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.abort.mockResolvedValueOnce({ data: null, error: { message: "migration unavailable" } });
    expect(await reserveAssistantQuota(request())).toBe("unavailable");
    mocks.admin.mockImplementationOnce(() => { throw new Error("missing configuration"); });
    expect(await reserveAssistantQuota(request())).toBe("unavailable");
    mocks.abort.mockRejectedValueOnce(new DOMException("timeout", "TimeoutError"));
    expect(await reserveAssistantQuota(request())).toBe("unavailable");
    expect(log).not.toHaveBeenCalled();
  });

  it.each([undefined, "", " "])("does not reserve without a configured API key (%s)", async (secret) => {
    vi.stubEnv("ANTHROPIC_API_KEY", secret);
    expect(await reserveAssistantQuota(request())).toBe("unavailable");
    expect(mocks.admin).not.toHaveBeenCalled();
  });
});
