"use client";

// ToS interstitial (P1 item 3c).
//
// Mounted in the marketplace and portfolio layouts (NOT admin — admin routes
// are deliberately exempt). When a wallet is connected and has not accepted
// the current TOS_VERSION, a blocking modal covers the page until the user
// signs an acceptance via the signed /api/tos/accept route (W2-SD1's route;
// pinned action "tos.accept", params { version }).
//
// Test networks fail OPEN: if Supabase is unreachable ("unknown" check
// result) the gate stays closed and only logs — availability over
// enforcement. MAINNET fails CLOSED (lib/tos.ts tosGateFailsClosed): an
// unknown status blocks, a failed acceptance offers no "continue without
// accepting", and a wallet that cannot sign messages is asked to switch
// wallets. The dialog's summary is counsel's on mainnet
// (lib/legal/mainnet-copy.ts MAINNET_TOS_GATE_POINTS).

import Link from "next/link";
import { useEffect, useState } from "react";
import { useWalletConnection } from "@solana/react-hooks";
import { signedFetch } from "@/lib/siws-client";
import {
  hasAcceptedTos,
  markTosAccepted,
  tosGateFailsClosed,
  TOS_VERSION,
} from "@/lib/tos";
import { MAINNET_TOS_GATE_POINTS } from "@/lib/legal/mainnet-copy";
import { detectNetwork } from "@/lib/network";

/** Mainnet fails closed (see header). Fixed per build (NEXT_PUBLIC_NETWORK). */
const FAIL_CLOSED = tosGateFailsClosed();

/** The dialog's summary: counsel's on mainnet, the pilot's elsewhere. */
const GATE_POINTS: string[] =
  detectNetwork() === "mainnet"
    ? (MAINNET_TOS_GATE_POINTS ?? [])
    : [
        "Tokenized instruments on this platform are securities-like assets subject to KYC/eligibility checks and transfer restrictions.",
        "You are responsible for the wallet you connect and for compliance with the laws of your jurisdiction.",
        "Acceptance is recorded on our systems against your wallet address and the ToS version above.",
      ];

/** Whether an acceptance failure looks like a SERVER/infra error (safe to
 *  fail-open) rather than a user declining the wallet signature. */
function isServerFailure(message: string): boolean {
  const m = message.toLowerCase();
  // Wallet-rejection style messages must NOT count as server failures.
  if (/reject|declin|denied|cancell|user/.test(m)) return false;
  return /\b(5\d\d|database|service|unavailable|unreachable|failed \()/.test(m);
}

export function TosGate() {
  const conn = useWalletConnection();
  const session = conn.wallet;
  const walletAddress = session?.account.address.toString() ?? null;
  // A wallet that cannot sign messages can NEVER satisfy the gate — blocking it
  // would permanently lock it out of the marketplace/portfolio. signMessage is
  // optional on WalletSession, so guard on it.
  const canSign = typeof session?.signMessage === "function";

  const [blocked, setBlocked] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!walletAddress || !canSign) {
      if (walletAddress && !canSign && !FAIL_CLOSED) {
        console.warn(
          "[tos] connected wallet cannot sign messages — skipping ToS gate (fail open)",
        );
      }
      // Mainnet: a wallet that cannot sign can never accept, so it is
      // blocked (and offered a disconnect) rather than let through.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setBlocked(Boolean(walletAddress) && FAIL_CLOSED);
      return;
    }
    void (async () => {
      const result = await hasAcceptedTos(walletAddress);
      if (cancelled) return;
      // "unknown" (Supabase down/unconfigured) → allow on test networks
      // (already logged), block on mainnet.
      setBlocked(result === "not_accepted" || (result === "unknown" && FAIL_CLOSED));
    })();
    return () => {
      cancelled = true;
    };
  }, [walletAddress, canSign]);

  if (!walletAddress || !blocked) return null;

  if (!canSign) {
    // Only reachable on mainnet (FAIL_CLOSED): see the effect above.
    return (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-slate-900/60 p-4 backdrop-blur-sm"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tos-gate-title"
      >
        <div className="mx-auto w-full max-w-lg overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl">
          <div className="border-b border-slate-100 px-5 py-4">
            <p
              id="tos-gate-title"
              className="text-sm font-semibold uppercase tracking-wide text-slate-700"
            >
              Terms of Service
            </p>
          </div>
          <div className="space-y-3 px-5 py-4 text-sm leading-relaxed text-slate-700">
            <p>
              This wallet cannot sign messages, so it cannot accept the Terms
              of Service (v{TOS_VERSION}). Connect a wallet that supports
              message signing to use the marketplace and portfolio.
            </p>
          </div>
          <div className="flex justify-end border-t border-slate-100 bg-slate-50 px-5 py-3">
            <button
              type="button"
              onClick={() => void conn.disconnect()}
              className="rounded-md bg-slate-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-slate-800"
            >
              Disconnect wallet
            </button>
          </div>
        </div>
      </div>
    );
  }

  async function accept() {
    if (!session || !walletAddress) return;
    setAccepting(true);
    setError(null);
    try {
      await signedFetch(session, "/api/tos/accept", "tos.accept", {
        version: TOS_VERSION,
      });
      markTosAccepted(walletAddress);
      setBlocked(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAccepting(false);
    }
  }

  // Fail-open escape: if acceptance cannot be recorded (server 500 — e.g. the
  // 0029 migration not yet applied, SUPABASE_SERVICE_ROLE_KEY unset, or the
  // wallet rejecting the signature), the user must not be permanently bricked
  // out of pages that worked before P1. Only offered AFTER a failed attempt, so
  // it never becomes a one-click bypass of a working gate — and never on
  // mainnet (FAIL_CLOSED).
  function dismiss() {
    console.warn("[tos] acceptance could not be recorded — dismissing gate (fail open)");
    setBlocked(false);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-slate-900/60 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="tos-gate-title"
    >
      <div className="mx-auto w-full max-w-lg overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl">
        <div className="border-b border-slate-100 px-5 py-4">
          <p
            id="tos-gate-title"
            className="text-sm font-semibold uppercase tracking-wide text-slate-700"
          >
            Terms of Service
          </p>
        </div>
        <div className="space-y-3 px-5 py-4 text-sm leading-relaxed text-slate-700">
          <p>
            To use the Manci marketplace and portfolio with this wallet,
            you must accept the current Terms of Service (v{TOS_VERSION}).
          </p>
          <ul className="list-disc space-y-1 pl-5 text-xs text-slate-600">
            {GATE_POINTS.map((point) => (
              <li key={point}>{point}</li>
            ))}
          </ul>
          <p className="text-xs text-slate-500">
            Read the full document:{" "}
            <Link
              href="/legal/terms"
              target="_blank"
              className="font-semibold text-slate-700 underline underline-offset-2"
            >
              Terms of Service ↗
            </Link>
          </p>
          {error && (
            <div className="space-y-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              <p>Could not record acceptance: {error}</p>
              {/*
                The fail-open bypass is ONLY for genuine SERVER/infra failures
                (500 / DB / service). A user DECLINING the wallet signature is
                not an infra failure and must not unlock a one-click bypass of a
                working gate — they simply retry.
              */}
              {FAIL_CLOSED ? (
                <p className="text-red-600">
                  Please try again. The Terms must be accepted before you can
                  continue.
                </p>
              ) : isServerFailure(error) ? (
                <button
                  type="button"
                  onClick={dismiss}
                  className="font-semibold text-red-800 underline underline-offset-2 hover:text-red-900"
                >
                  Continue without accepting →
                </button>
              ) : (
                <p className="text-red-600">
                  Please approve the signature request to continue.
                </p>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-slate-100 bg-slate-50 px-5 py-3">
          <p className="text-[11px] text-slate-400">
            Accepting asks your wallet for a signature (no transaction, no
            fee).
          </p>
          <button
            type="button"
            onClick={() => void accept()}
            disabled={accepting}
            className="rounded-md bg-slate-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {accepting ? "Signing…" : `Accept v${TOS_VERSION}`}
          </button>
        </div>
      </div>
    </div>
  );
}
