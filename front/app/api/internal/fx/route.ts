import { NextResponse } from "next/server";
import { runFxRefresh } from "@/lib/server/fx-refresh";
import { requireRetryWorkerAuthorization, RetryWorkerError } from "@/lib/server/retry-worker";

export const runtime = "nodejs";
export const maxDuration = 30;

/** Scheduler contract (scripts/ops/fx-scheduler.sql): POST with Bearer
 * RETRY_WORKER_SECRET, once a minute. The body is unused; deployment
 * configuration alone selects the network and the mint. A run that decided
 * (accepted, refused) or had nothing to do (skipped: no mint on this
 * network, or rate limited) answers 200; one that could not record its
 * decision answers 503. Public prices, fixed codes and counts only. */
export async function POST(request: Request) {
  try {
    requireRetryWorkerAuthorization(request.headers.get("authorization"));
    const data = await runFxRefresh();
    const ok = data.status !== "failed";
    return NextResponse.json({ ok, data }, {
      status: ok ? 200 : 503,
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    const status = error instanceof RetryWorkerError ? error.status : 503;
    const message = error instanceof RetryWorkerError ? error.message : "FX refresh unavailable";
    return NextResponse.json({ ok: false, error: message }, {
      status, headers: { "Cache-Control": "private, no-store" },
    });
  }
}
