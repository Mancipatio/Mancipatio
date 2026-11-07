export type AssistantMessage = { role: "user" | "assistant"; content: string };
export type AssistantSource = { title: string; href: string; section?: string };
export type AssistantAnswer = {
  answer: string;
  sources: AssistantSource[];
  mode: "claude" | "knowledge";
  knowledgeVersion: string;
};
export type AssistantInput = { messages: AssistantMessage[] };

/** Public input is data, never a caller-supplied system prompt or tool call. */
export function parseAssistantInput(raw: unknown): AssistantInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid question.");
  const body = raw as Record<string, unknown>;
  if (body.language !== undefined && body.language !== "en") throw new Error("The assistant currently answers in English.");
  if (!Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > 8) {
    throw new Error("Send a question with at most eight conversation messages.");
  }
  let size = 0;
  const messages = body.messages.map((item: unknown): AssistantMessage => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid message.");
    const value = item as Record<string, unknown>;
    if ((value.role !== "user" && value.role !== "assistant") || typeof value.content !== "string") throw new Error("Invalid message.");
    const content = value.content.trim();
    if (!content || content.length > (value.role === "user" ? 1200 : 6000)) throw new Error("Questions can contain up to 1,200 characters.");
    size += content.length;
    return { role: value.role, content };
  });
  if (messages.at(-1)?.role !== "user" || size > 16_000) throw new Error("Start a new conversation and send your question.");
  return { messages };
}
