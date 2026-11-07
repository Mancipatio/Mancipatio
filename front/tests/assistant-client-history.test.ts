import { describe, expect, it } from "vitest";
import { assistantRequestForTranscript } from "@/lib/assistant/client-history";
import { parseAssistantInput, type AssistantMessage } from "@/lib/assistant/types";

describe("assistant question history", () => {
  it("accepts a follow-up after a full-length published procedure without truncating the displayed text", () => {
    const transcript: AssistantMessage[] = [
      { role: "user", content: "How does conversion work?" },
      { role: "assistant", content: "x".repeat(12_000) },
      { role: "user", content: "How do I start that process?" },
    ];
    const request = assistantRequestForTranscript(transcript);
    expect(parseAssistantInput(request)).toEqual(request);
    expect(request.messages).toEqual([transcript[0], transcript[2]]);
    expect(transcript[1].content).toHaveLength(12_000);
  });

  it("keeps the latest eight questions within the request budget and excludes answer text", () => {
    const transcript: AssistantMessage[] = Array.from({ length: 10 }, (_, index) => [
      { role: "user" as const, content: `${index}:`.padEnd(1_200, "?") },
      { role: "assistant" as const, content: "Response text must not become factual context." },
    ]).flat();
    const request = assistantRequestForTranscript(transcript);
    expect(parseAssistantInput(request).messages).toHaveLength(8);
    expect(request.messages[0].content.startsWith("2:")).toBe(true);
    expect(request.messages.at(-1)?.content.startsWith("9:")).toBe(true);
    expect(request.messages.every((message) => message.role === "user")).toBe(true);
  });
});
