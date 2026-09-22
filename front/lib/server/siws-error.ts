// SERVER-ONLY — the status-carrying error of the signed routes. It lives on
// its own so lib/server/maintenance.ts can extend it without an import cycle
// with lib/server/siws.ts, which re-exports it (import it from there).

import "server-only";

/** Error carrying an HTTP status; `siwsErrorResponse` maps it to JSON. */
export class SiwsError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "SiwsError";
    this.status = status;
  }
}
