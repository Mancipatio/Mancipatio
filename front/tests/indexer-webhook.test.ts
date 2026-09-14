import { describe, expect, it, vi } from "vitest";
import { handleIndexerWebhook } from "../supabase/functions/_shared/indexer-webhook";
const secret = "a".repeat(40);
const account = "11111111111111111111111111111111";
const event = { signature: "2".repeat(88), slot: 123, timestamp: 1_700_000_000, accountData: [{ account }] };
const request = (value: unknown, auth = secret) => new Request("https://example.test/webhook", { method: "POST", headers: { authorization: auth }, body: JSON.stringify(value) });
function config() { return { secret, network: "devnet", enqueue: vi.fn(async (events: unknown[]) => events.length) }; }
describe("durable Helius receiver", () => {
  it("acknowledges only after atomic batch commit, including duplicate events", async () => {
    const c = config(); let release!: (n: number) => void;
    c.enqueue.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const pending = handleIndexerWebhook(request([event, event], `Bearer ${secret}`), c);
    await vi.waitFor(() => expect(c.enqueue).toHaveBeenCalledOnce());
    let done = false; void pending.then(() => { done = true; }); await Promise.resolve(); expect(done).toBe(false);
    release(2); expect((await pending).status).toBe(202);
    expect(c.enqueue.mock.calls[0][0]).toEqual([expect.objectContaining({ wallets: [account], slot: 123 }), expect.any(Object)]);
  });
  it.each(["wrong", "", `bearer ${secret}`])("denies invalid authorization %s before parsing", async (auth) => {
    const c = config(); expect((await handleIndexerWebhook(request("bad", auth), c)).status).toBe(401); expect(c.enqueue).not.toHaveBeenCalled();
  });
  it.each([{ secret: "short" }, { network: "unknown" }, { network: "" }])("fails closed with missing/invalid configuration", async (override) => {
    const c = { ...config(), ...override }; expect((await handleIndexerWebhook(request([event]), c)).status).toBe(503); expect(c.enqueue).not.toHaveBeenCalled();
  });
  it.each([[], {}, [event, { ...event, slot: -1 }], [{ ...event, accountData: [] }], [{ ...event, signature: "bad" }], [{ ...event, accountData: [{ account: "bad" }] }]].map((value) => [value]))("rejects the complete malformed batch before writing", async (body: unknown) => {
    const c = config(); expect((await handleIndexerWebhook(request(body), c)).status).toBe(400); expect(c.enqueue).not.toHaveBeenCalled();
  });
  it("enforces streamed body size", async () => {
    const c = config(); expect((await handleIndexerWebhook(request("x".repeat(2 * 1024 * 1024)), c)).status).toBe(413); expect(c.enqueue).not.toHaveBeenCalled();
  });
  it("leaves HTTP failures retryable when migration/DB/ack is unavailable", async () => {
    const c = config(); c.enqueue.mockRejectedValue(new Error("42P01 internal secret"));
    const response = await handleIndexerWebhook(request([event]), c); expect(response.status).toBe(503); expect(await response.text()).not.toContain("internal secret");
    c.enqueue.mockResolvedValue(0); expect((await handleIndexerWebhook(request([event]), c)).status).toBe(503);
  });
  it("includes CPI instruction accounts and deduplicates accountData", async () => {
    const c = config(); const second = "3".repeat(32);
    const e = { ...event, instructions: [{ programId: account, innerInstructions: [{ programId: "FJs1EM1ND89L9sUXaS8VBKYXjmoXCkkVSJKRE19hmYxS", accounts: [account, second] }] }] };
    expect((await handleIndexerWebhook(request([e]), c)).status).toBe(202);
    expect(c.enqueue.mock.calls[0][0][0]).toMatchObject({ wallets: [account, second] });
  });
});
