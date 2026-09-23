// Next.js instrumentation: server errors (render, route handlers, server
// actions) are reported as one PII-scrubbed structured log line, and to
// Sentry's HTTP envelope endpoint only when SENTRY_DSN is set. No SDK — see
// lib/request-error-report.ts for exactly what is and is not sent. Next's own
// console.error of the original error still happens and is not scrubbed.

import type { Instrumentation } from "next";
import { reportRequestError } from "@/lib/request-error-report";

export const onRequestError: Instrumentation.onRequestError = (error, request, context) =>
  reportRequestError(error, request, context);
