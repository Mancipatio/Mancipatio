// SERVER-ONLY — a read with its own time budget. Used where one slow table
// must not hold a response: the admin menu badges (lib/server/admin-badges.ts)
// and the "Needs review" annotation of the client directory
// (POST /api/clients/admin-list).

import "server-only";

/**
 * Runs `read` with its own abort signal (pass it to every query) and rejects
 * with "timed out" after `ms`, even if a query ignores the signal.
 */
export async function withTimeout<T>(ms: number, read: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("timed out"));
    }, ms);
  });
  try {
    return await Promise.race([read(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
