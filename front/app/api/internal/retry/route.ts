import { NextResponse } from "next/server";
import { requireRetryWorkerAuthorization, retryWorkerLimit, RetryWorkerError, runRetryWorker } from "@/lib/server/retry-worker";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Scheduler contract: POST with Bearer RETRY_WORKER_SECRET, optional ?limit=1..20.
 * The body is unused; deployment configuration alone selects the network. */
export async function POST(request: Request) {
  try {
    requireRetryWorkerAuthorization(request.headers.get("authorization"));
    const limit = retryWorkerLimit(new URL(request.url).searchParams.get("limit"));
    const data = await runRetryWorker(limit);
    return NextResponse.json({ ok: data.status !== "partial", data }, {
      status: data.status === "partial" ? 503 : 200,
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    const status = error instanceof RetryWorkerError ? error.status : 503;
    const message = error instanceof RetryWorkerError ? error.message : "Retry worker unavailable";
    return NextResponse.json({ ok: false, error: message }, {
      status, headers: { "Cache-Control": "private, no-store" },
    });
  }
}
