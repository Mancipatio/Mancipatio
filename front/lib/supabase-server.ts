// SERVER-ONLY — never import this from a client component.
// Uses the SUPABASE_SERVICE_ROLE_KEY which bypasses RLS.

import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

let cached: SupabaseClient | null = null;

/**
 * Server-only admin client.
 *
 * Use this inside:
 * - Next.js Route Handlers (`app/api/.../route.ts`)
 * - Server Components
 * - Supabase Edge Functions (with the same env var)
 *
 * Never reach this from client components — TypeScript and the
 * `server-only` import will both fail the build if you try.
 *
 * Throws if env is unset, since misuse here is much worse than a silent
 * skip (writes would silently no-op).
 */
export function getSupabaseAdmin(abortSignal?: AbortSignal): SupabaseClient {
  if (!url) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL is not set");
  }
  if (!serviceRoleKey) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  }
  // A request budget also covers Storage calls, which do not expose the
  // PostgREST query builder's abortSignal method. Never cache a scoped signal.
  if (abortSignal)
    return createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        fetch: (input, init) =>
          fetch(input, {
            ...init,
            signal: init?.signal
              ? AbortSignal.any([abortSignal, init.signal])
              : abortSignal,
          }),
      },
    });
  if (cached) return cached;
  cached = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}
