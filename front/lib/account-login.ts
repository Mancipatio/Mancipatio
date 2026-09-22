"use client";

// Browser half of the wallet-less sign-in (email link / Google) and of the
// account-session requests. The session itself is an httpOnly cookie; this
// module only mirrors "who is signed in" for the UI and sends requests that
// the server authorizes with that cookie.

import { useSyncExternalStore } from "react";
import { detectNetwork } from "@/lib/network";

export type SignedInAccount = { id: string; email: string | null; display_name: string; primary_wallet: string | null };
type State = { status: "loading" | "signed_out" | "signed_in"; account: SignedInAccount | null };

let state: State = { status: "loading", account: null };
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();
const SERVER_STATE: State = { status: "loading", account: null };

function set(next: State) { state = next; listeners.forEach((l) => l()); }

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    cache: "no-store", credentials: "same-origin",
  });
  const json = (await res.json().catch(() => null)) as { ok?: boolean; data?: T; error?: string } | null;
  if (!res.ok || !json || json.ok !== true) throw new Error(json?.error ?? `Request failed (${res.status})`);
  return json.data as T;
}

/** Re-read who is signed in (after sign-in, sign-out or a Google return). */
export function refreshSignedInAccount(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  loading = post<{ account: SignedInAccount | null }>("/api/auth/me", {})
    .then((d) => set(d.account ? { status: "signed_in", account: d.account } : { status: "signed_out", account: null }))
    .catch(() => set({ status: "signed_out", account: null }))
    .finally(() => { loading = null; });
  return loading;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (state.status === "loading" && !loading) void refreshSignedInAccount();
  return () => listeners.delete(listener);
}

/** The email/Google account signed in on this browser, if any. */
export function useSignedInAccount(): State {
  return useSyncExternalStore(subscribe, () => state, () => SERVER_STATE);
}

export function startEmailSignIn(email: string) {
  return post<{ sent: boolean }>("/api/auth/email/start", { email });
}

export async function completeEmailSignIn(token: string) {
  const data = await post<{ account_id: string }>("/api/auth/email/verify", { token });
  await refreshSignedInAccount();
  return data;
}

/** Sign in with Google, or connect Google to the signed-in account ("link"). */
export async function startGoogleSignIn(mode: "login" | "link" = "login") {
  const { url } = await post<{ url: string }>("/api/auth/google/start", { mode });
  const destination = new URL(url);
  if (destination.protocol !== "https:" || destination.hostname !== "accounts.google.com") throw new Error("Google sign-in is unavailable");
  window.location.assign(destination.href);
}

export async function signOutAccount() {
  await post("/api/auth/logout", {});
  set({ status: "signed_out", account: null });
}

/** POST an account-session request (no wallet signature). */
export async function accountFetch<T = unknown>(path: string, action: string, params: Record<string, unknown> = {}): Promise<T> {
  const payload = {
    v: 2, origin: window.location.origin, network: detectNetwork(), action,
    ts: new Date().toISOString(), nonce: crypto.randomUUID(), params,
  };
  return post<T>(path, { payload, account: true });
}
