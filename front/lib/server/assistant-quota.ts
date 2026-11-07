import "server-only";

import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import { getSupabaseAdmin } from "@/lib/supabase-server";

export type AssistantQuotaResult = "allowed" | "limited" | "unavailable";

function limit(raw: string | undefined, fallback: number, max: number): number {
  if (!raw?.trim()) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(max, Math.trunc(parsed))) : fallback;
}

function clientIp(request: Request): string {
  // Vercel sets x-real-ip. Otherwise use the last proxy hop, never the
  // caller-controlled leftmost forwarded value. Unusable IPs share one bucket.
  const realIp = request.headers.get("x-real-ip")?.trim();
  const forwarded = request.headers.get("x-forwarded-for")
    ?.split(",").map((hop) => hop.trim()).filter(Boolean).at(-1);
  const value = realIp || forwarded || "";
  return isIP(value) ? value.toLowerCase() : "unknown";
}

/** Reserve both durable limits before any paid model call; fail closed. */
export async function reserveAssistantQuota(request: Request): Promise<AssistantQuotaResult> {
  const secret = process.env.ANTHROPIC_API_KEY?.trim();
  if (!secret) return "unavailable";

  try {
    const keyHash = createHmac("sha256", secret).update(clientIp(request)).digest("hex");
    const signal = AbortSignal.timeout(3_000);
    const { data, error } = await getSupabaseAdmin(signal)
      .rpc("consume_assistant_quota", {
        p_key_hash: keyHash,
        p_minute_limit: limit(process.env.MANCI_ASSISTANT_RATE_LIMIT_PER_MINUTE, 8, 60),
        p_daily_limit: limit(process.env.MANCI_ASSISTANT_DAILY_LIMIT, 500, 10_000),
      })
      .abortSignal(signal);
    if (error || typeof data !== "boolean") return "unavailable";
    return data ? "allowed" : "limited";
  } catch {
    // Missing configuration/migration, timeout and network errors use the
    // local knowledge fallback. Never log the key, IP, question or response.
    return "unavailable";
  }
}
