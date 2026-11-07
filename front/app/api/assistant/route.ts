import { NextResponse } from "next/server";
import { parseAssistantInput } from "@/lib/assistant/types";
import { knowledgeAnswer, retrieveKnowledge } from "@/lib/assistant/retrieval";
import { answerWithClaude } from "@/lib/server/manci-assistant";
import { reserveAssistantQuota } from "@/lib/server/assistant-quota";
import { boundedRequest } from "@/lib/server/bounded-request";
import { loadPublishedAssistantKnowledge } from "@/lib/server/assistant-knowledge";
import { publishedKnowledgeVersion } from "@/lib/assistant/version";

export const runtime = "nodejs";
export const maxDuration = 30;
const headers = { "Cache-Control": "no-store" };

function allowedOrigin(request: Request) {
  if (request.headers.get("sec-fetch-site") === "cross-site") return false;
  const origin = request.headers.get("origin");
  if (!origin) return true; // Public API; quota still applies to non-browser clients.
  const url = new URL(request.url);
  const allowed = new Set<string>();
  if (process.env.NEXT_PUBLIC_SITE_URL) {
    try { allowed.add(new URL(process.env.NEXT_PUBLIC_SITE_URL).origin); } catch { return false; }
  }
  const loopbacks = ["localhost", "127.0.0.1", "[::1]"];
  if (process.env.NODE_ENV !== "production") allowed.add(url.origin);
  // Next may canonicalize a loopback request to localhost even when the
  // browser uses 127.0.0.1. Keep the port and protocol bound to this server.
  if (loopbacks.includes(url.hostname)) {
    for (const host of loopbacks) allowed.add(`${url.protocol}//${host}${url.port ? `:${url.port}` : ""}`);
  }
  return allowed.has(origin);
}

export async function POST(request: Request) {
  if (!allowedOrigin(request)) return NextResponse.json({ ok: false, error: "Open the assistant on the Manci website." }, { status: 403, headers });
  if (!request.headers.get("content-type")?.includes("application/json")) return NextResponse.json({ ok: false, error: "Send a JSON question." }, { status: 415, headers });
  let input;
  try {
    const body = await boundedRequest(request, 40_000);
    input = parseAssistantInput(await body.json());
  } catch {
    return NextResponse.json({ ok: false, error: "Send a question of up to 1,200 characters. Start a new conversation if the history is too long." }, { status: 400, headers });
  }
  let corpus;
  try {
    corpus = await loadPublishedAssistantKnowledge();
  } catch {
    // Never fall back to an old copy of an article an editor has unpublished.
    return NextResponse.json({ ok: false, error: "Our answer library is temporarily unavailable. Please try again shortly or contact the Manci team." }, { status: 503, headers });
  }
  const entries = retrieveKnowledge(input, corpus);
  const knowledgeVersion = publishedKnowledgeVersion(corpus);
  // No key, no source or unavailable quota store: no paid request is made.
  if (!process.env.ANTHROPIC_API_KEY?.trim() || !entries.length) return NextResponse.json({ ok: true, data: { ...knowledgeAnswer(entries), knowledgeVersion } }, { headers });
  const quota = await reserveAssistantQuota(request);
  if (quota === "limited") return NextResponse.json({ ok: false, error: "The current question limit has been reached. Try again later or browse the Manci answer library." }, { status: 429, headers: { ...headers, "Retry-After": "60" } });
  const data = quota === "allowed"
    ? await answerWithClaude(input, entries, request.signal)
    : knowledgeAnswer(entries);
  return NextResponse.json({ ok: true, data: { ...data, knowledgeVersion } }, { headers });
}
