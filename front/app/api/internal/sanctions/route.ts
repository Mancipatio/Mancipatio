import { NextResponse } from "next/server";
import { runSanctionsRefresh } from "@/lib/server/sanctions-refresh";
import { requireRetryWorkerAuthorization, RetryWorkerError } from "@/lib/server/retry-worker";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Scheduler contract (scripts/ops/sanctions-scheduler.sql): POST with Bearer
 * RETRY_WORKER_SECRET, once a day. The body is unused; deployment
 * configuration alone selects the network. Counts and codes only. */
export async function POST(request: Request) {
  try {
    requireRetryWorkerAuthorization(request.headers.get("authorization"));
    const data = await runSanctionsRefresh();
    return NextResponse.json({ ok: data.status === "processed", data }, {
      status: data.status === "processed" ? 200 : 503,
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    const status = error instanceof RetryWorkerError ? error.status : 503;
    const message = error instanceof RetryWorkerError ? error.message : "Sanctions refresh unavailable";
    return NextResponse.json({ ok: false, error: message }, {
      status, headers: { "Cache-Control": "private, no-store" },
    });
  }
}
