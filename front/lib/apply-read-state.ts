// /apply signed self-read — phase tracking and failure classification.
//
// The applicant's own applications are read through a SIWS-signed request, so
// "loading" really is two very different waits: the wallet prompt (the user
// must act) and the network round-trip (nothing to do). And a failed read is
// NOT an empty list — a declined signature or an unreachable API must be
// shown as such, with a retry, never as "you have no applications".
// These helpers are framework-free so the page's behaviour is unit-testable.

import { OffchainMessageLimitError } from "@/lib/siws-offchain";
import { HardwareWalletSigningError } from "@/lib/siws-signing";

/** What the page is waiting on while the private read is in flight. */
export type ApplicationReadPhase = "signing" | "loading" | "ready" | "error";

export type ApplicationReadFailureKind =
  | "signature_rejected"
  | "signing_unsupported"
  | "hardware_wallet"
  | "transport"
  | "server";

export type ApplicationReadFailure = {
  kind: ApplicationReadFailureKind;
  /** Short, user-facing explanation (no raw stack). */
  message: string;
  /** Underlying error text, for the details line. */
  detail: string;
};

type SignMessage = (message: Uint8Array) => Promise<Uint8Array>;

type SigningSession = { signMessage?: SignMessage };

export type SigningObserver = {
  /** Called right before the wallet prompt opens. */
  onSignStart: () => void;
  /** Called when the prompt closes — approved OR rejected. */
  onSignEnd: () => void;
};

/**
 * Wrap a wallet session so every `signMessage` call reports when the wallet
 * prompt opens and closes. Returns a copy that keeps the session's prototype
 * and every own property (symbols and accessors included) and replaces only
 * `signMessage`; the original is invoked with the session as `this` in case
 * the adapter relies on it.
 *
 * Not a Proxy: wallet sessions can be frozen, and a Proxy `get` trap may not
 * report a different value for a non-writable, non-configurable property —
 * the engine throws a TypeError on every read of `signMessage`.
 */
export function withSigningObserver<S extends SigningSession | null | undefined>(
  session: S,
  observer: SigningObserver,
): S {
  if (!session || typeof session.signMessage !== "function") return session;
  const original = session.signMessage;
  const wrapped: SignMessage = async (message) => {
    observer.onSignStart();
    try {
      return await original.call(session, message);
    } finally {
      observer.onSignEnd();
    }
  };
  const descriptors: PropertyDescriptorMap = Object.getOwnPropertyDescriptors(session);
  delete descriptors.signMessage;
  const observed = Object.create(Object.getPrototypeOf(session), {
    ...descriptors,
    signMessage: { value: wrapped, enumerable: true, writable: false, configurable: false },
  }) as S;
  return Object.isFrozen(session) ? Object.freeze(observed) : observed;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error)
    return String((error as { message: unknown }).message);
  return String(error);
}

const REJECTION_RE =
  /user rejected|user declined|rejected the request|request rejected|declined|cancell?ed by user|signature request denied/i;
const TRANSPORT_RE =
  /failed to fetch|networkerror|network request failed|load failed|fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT/i;

/** Map any error from the signed read into a user-facing failure. */
export function classifyApplicationReadError(
  error: unknown,
): ApplicationReadFailure {
  const detail = errorText(error);
  // The wallet or its Ledger could not produce a usable signature; the
  // message says what to do (retrying unchanged will not help a limit error).
  if (error instanceof HardwareWalletSigningError || error instanceof OffchainMessageLimitError) {
    return { kind: "hardware_wallet", message: error.message, detail };
  }
  if (error && typeof error === "object") {
    const code = (error as { code?: unknown }).code;
    if (code === 4001 || code === "WALLET_REJECTED") {
      return {
        kind: "signature_rejected",
        message:
          "The wallet request was declined. Nothing was submitted — approve the read to see your existing applications.",
        detail,
      };
    }
  }
  if (/does not support message signing/i.test(detail)) {
    return {
      kind: "signing_unsupported",
      message:
        "This wallet cannot sign messages, which is required to read your applications privately. Connect a wallet that supports message signing.",
      detail,
    };
  }
  if (REJECTION_RE.test(detail)) {
    return {
      kind: "signature_rejected",
      message:
        "The wallet request was declined. Nothing was submitted — approve the read to see your existing applications.",
      detail,
    };
  }
  if (error instanceof TypeError || TRANSPORT_RE.test(detail)) {
    return {
      kind: "transport",
      message:
        "We could not reach the application service. Your applications may exist — check your connection and retry.",
      detail,
    };
  }
  return {
    kind: "server",
    message:
      "Your applications could not be read right now. This is not confirmation that you have none — retry in a moment.",
    detail,
  };
}

/** Copy for the interim screen, keyed by phase. */
export function applicationReadStatusCopy(
  phase: Exclude<ApplicationReadPhase, "ready" | "error">,
): string {
  return phase === "signing"
    ? "Waiting for your wallet — approve the signature request to read your applications. No transaction is sent and nothing is charged."
    : "Checking your applications…";
}
