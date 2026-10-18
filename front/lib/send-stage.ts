// What the wallet send in progress is waiting for, for one site-wide notice
// (components/send-progress-notice.tsx, mounted in app/providers next to the
// hardware-wallet signing notice).
//
// Between a click and the wallet sheet, lib/verified-solana-client runs the
// network check, the pause and gate reads, the priority fee, the maintenance
// flag, the wait for this tab's previous send, the simulation gate and the
// account policy check (which may open a sign-in message prompt). Each page
// shows only its own "Working…" meanwhile. The client emits a stage at each
// step here instead, so every wallet button says what it is waiting for
// without a page edit. Modelled on lib/siws-signing's signing events: one
// listener set, each listener called in a try/catch, so a notice can never
// break a send.
//
// One stage at a time (the app has one wallet, and the client waits for the
// previous send before the next). "done" and "failed" end the send: the
// current stage becomes null and the notice hides.
import { useSyncExternalStore } from "react";

export type SendStage =
  /** The network, pause and gate reads, the priority fee and the maintenance flag. */
  | { kind: "checking" }
  /** This tab's previous send is waited for (at most `maxSeconds`) before anything is simulated or signed. */
  | { kind: "waiting-previous"; count: number; maxSeconds: number }
  /** The simulation gate. */
  | { kind: "testing" }
  /**
   * The account policy check (lib/transaction-wallet-policy); `signIn` once
   * the wallet is asked to sign the Manci sign-in message (a session without
   * a live 12 h session), a message and not a transaction.
   */
  | { kind: "account"; signIn?: boolean }
  /** The wallet is being asked (the blockhash fetch just before it included). */
  | { kind: "wallet" }
  /** Signed; being broadcast (the batch path: the single path's send is inside the SDK's wallet step). */
  | { kind: "sending" }
  | { kind: "done" }
  | { kind: "failed" };

export type SendStageKind = SendStage["kind"];

type Listener = (stage: SendStage) => void;

const listeners = new Set<Listener>();
let current: SendStage | null = null;

/** Called with every stage of every send; returns the unsubscribe. */
export function onSendStage(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The stage the send in progress is in, or null between sends. */
export function currentSendStage(): SendStage | null {
  return current;
}

/** Records `stage` (null after "done" / "failed") and tells every listener; a listener that throws is skipped. */
export function emitSendStage(stage: SendStage): void {
  current = stage.kind === "done" || stage.kind === "failed" ? null : stage;
  for (const listener of [...listeners]) {
    try {
      listener(stage);
    } catch {
      // A notice must never break a send.
    }
  }
}

/** The notice's one line for `stage`, or null when there is nothing to show (idle, done, failed). */
export function sendStageLabel(stage: SendStage | null): string | null {
  if (!stage) return null;
  switch (stage.kind) {
    case "checking":
      return "Checking the network…";
    case "waiting-previous":
      return `Waiting for your previous ${stage.count === 1 ? "transaction" : `${stage.count} transactions`} to confirm (up to ${stage.maxSeconds} s)…`;
    case "testing":
      return "Testing the transaction…";
    case "account":
      return stage.signIn ? "Confirming your Manci sign-in (a message, not a transaction)…" : "Confirming your account…";
    case "wallet":
      return "Waiting for your wallet…";
    case "sending":
      return "Sending…";
    case "done":
    case "failed":
      return null;
  }
}

const subscribe = (notify: () => void) => onSendStage(notify);
const serverSnapshot = () => null;

/** The stage of the send in progress (null between sends), for a client component. */
export function useSendStage(): SendStage | null {
  return useSyncExternalStore(subscribe, currentSendStage, serverSnapshot);
}
