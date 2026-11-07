import type { AssistantInput, AssistantMessage } from "./types";

/** The server uses prior questions, never prior answers, as follow-up context.
 * Keep complete answers in the UI even when a published procedure is longer
 * than the API's per-message history limit. Eight UI questions fit its budget. */
export function assistantRequestForTranscript(transcript: readonly AssistantMessage[]): AssistantInput {
  return {
    messages: transcript.filter((message) => message.role === "user").slice(-8)
      .map(({ role, content }) => ({ role, content })),
  };
}
