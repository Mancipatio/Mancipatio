// The "Ledger (USB)" wallet's questions to the user, as one observable state
// that components/ledger-usb-dialogs.tsx (mounted once in app/providers.tsx)
// renders: pick the account when connecting, connect the device (a click the
// browser's device chooser needs), and "confirm on your Ledger" while the
// device shows a request. One prompt at a time: the wallet serializes device
// access (lib/ledger-usb.ts).

import {
  ledgerRejection,
  LedgerUsbError,
  type LedgerAccountChoiceRequest,
  type LedgerAccountOption,
  type LedgerConfirmInfo,
  type LedgerUsbDevice,
  type LedgerUsbPrompts,
} from "@/lib/ledger-usb";

export type LedgerUsbPromptState =
  | { kind: "choose"; request: LedgerAccountChoiceRequest; choose(option: LedgerAccountOption): void; cancel(): void }
  | { kind: "access"; pending: boolean; grant(): void; cancel(): void }
  | { kind: "confirm"; info: LedgerConfirmInfo };

let state: LedgerUsbPromptState | null = null;
const listeners = new Set<() => void>();

function set(next: LedgerUsbPromptState | null) {
  state = next;
  for (const listener of [...listeners]) {
    try { listener(); } catch { /* a view must never break signing */ }
  }
}

/** useSyncExternalStore pair. */
export function subscribeLedgerUsbPrompt(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function ledgerUsbPromptSnapshot(): LedgerUsbPromptState | null {
  return state;
}

function requireView() {
  if (listeners.size === 0) {
    throw new LedgerUsbError("failed", "The Ledger (USB) dialogs are not available on this page. Reload the page and try again.");
  }
}

export const ledgerUsbPrompts: LedgerUsbPrompts = {
  chooseAccount(request) {
    try { requireView(); } catch (error) { return Promise.reject(error); }
    return new Promise<LedgerAccountOption>((resolve, reject) => {
      const prompt: LedgerUsbPromptState = {
        kind: "choose",
        request,
        choose(option) {
          if (state === prompt) set(null);
          resolve(option);
        },
        cancel() {
          if (state === prompt) set(null);
          reject(ledgerRejection("Connecting the Ledger was cancelled."));
        },
      };
      set(prompt);
    });
  },

  requestAccess(grant: () => Promise<LedgerUsbDevice>) {
    try { requireView(); } catch (error) { return Promise.reject(error); }
    return new Promise<LedgerUsbDevice>((resolve, reject) => {
      let settled = false;
      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        if (state && state.kind === "access") set(null);
        action();
      };
      const prompt: Extract<LedgerUsbPromptState, { kind: "access" }> = {
        kind: "access",
        pending: false,
        // Called from the Continue button's click handler: the device chooser
        // opens within that user gesture.
        grant() {
          if (settled || (state?.kind === "access" && state.pending)) return;
          set({ ...prompt, pending: true });
          grant().then(
            (device) => {
              if (settled) void device.close().catch(() => undefined); // cancelled meanwhile
              else finish(() => resolve(device));
            },
            (error) => finish(() => reject(error)),
          );
        },
        cancel() {
          finish(() => reject(ledgerRejection("Connecting the Ledger was cancelled.")));
        },
      };
      set(prompt);
    });
  },

  confirmOnDevice(info) {
    const prompt: LedgerUsbPromptState = { kind: "confirm", info };
    set(prompt);
    return () => { if (state === prompt) set(null); };
  },
};
