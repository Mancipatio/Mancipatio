import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { answerWithClaude } from "@/lib/server/manci-assistant";
import { knowledgeAnswer, retrieveKnowledge } from "@/lib/assistant/retrieval";
import type { AssistantInput } from "@/lib/assistant/types";

const KEY = "synthetic-private-provider-key";
const QUESTION = "Does buying a token make me a company owner? Private visitor detail.";
const RAW = "private provider body and request identifier";
const input: AssistantInput = { messages: [{ role: "user", content: QUESTION }] };
const entries = retrieveKnowledge(input);
const sensitive = `${KEY} ${QUESTION} ${RAW}`;

beforeEach(() => {
  vi.stubEnv("ANTHROPIC_API_KEY", KEY);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  const logs = JSON.stringify([
    ...vi.mocked(console.warn).mock.calls,
    ...vi.mocked(console.error).mock.calls,
    ...vi.mocked(console.log).mock.calls,
  ]);
  for (const value of [KEY, QUESTION, RAW]) expect(logs).not.toContain(value);
  vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

async function expectFallback(diagnostic: Record<string, unknown>) {
  expect(await answerWithClaude(input, entries)).toEqual(knowledgeAnswer(entries));
  expect(console.warn).toHaveBeenCalledExactlyOnceWith("[assistant] provider_failure", diagnostic);
  expect(console.error).not.toHaveBeenCalled();
  expect(console.log).not.toHaveBeenCalled();
}

describe("sanitized Claude diagnostics", () => {
  it.each([
    [401, "authentication_error"], [403, "permission_error"], [404, "not_found_error"],
    [400, "invalid_request_error"], [429, "rate_limit_error"], [529, "overloaded_error"],
  ] as const)("logs only HTTP status and an allowlisted type for %s", async (status, type) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { type, message: sensitive }, request_id: RAW,
    }), { status })));
    await expectFallback({ reason: "provider_http", status, type });
  });

  it("distinguishes low API credits with a fixed category, without logging the message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: {
      type: "invalid_request_error", message: `Your credit balance is too low to access the Anthropic API. ${sensitive}`,
    } }), { status: 400 })));
    await expectFallback({ reason: "provider_billing", status: 400, type: "invalid_request_error" });
  });

  it("does not emit unrecognized error types", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { type: sensitive, message: sensitive },
    }), { status: 400 })));
    await expectFallback({ reason: "provider_http", status: 400, type: "unknown" });
  });

  it("keeps status diagnostics when the provider error body is not JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(sensitive, { status: 503 })));
    await expectFallback({ reason: "provider_http", status: 503, type: "unknown" });
  });

  it.each([
    [new Error(sensitive), "provider_network"],
    [new DOMException(sensitive, "TimeoutError"), "provider_timeout"],
    [new DOMException(sensitive, "AbortError"), "provider_aborted"],
  ] as const)("uses a fixed category for transport failures", async (error, reason) => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(error));
    await expectFallback({ reason });
  });

  it.each([
    sensitive,
    JSON.stringify({ stop_reason: "end_turn", content: [null] }),
    JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({
      answer: sensitive, sourceIds: [RAW], covered: true,
    }) }] }),
  ])("never logs invalid provider output or parser error text", async (body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body)));
    await expectFallback({ reason: "provider_invalid_output" });
  });
});
