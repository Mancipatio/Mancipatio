// The "Ledger (USB)" wallet's device: Ledger's own browser packages, pinned
// exactly (package.json; the same @ledgerhq/hw-app-solana 7.11.0 as the
// chain:emergency CLI), loaded only when a Ledger is first used. WebHID is in
// Chrome and Edge (not Firefox or Safari); app/providers.tsx offers the
// wallet only where navigator.hid exists. Ledger's packages use the Node
// `Buffer` global, which is provided here from the bundler's `buffer` polyfill
// when the page has none.

import { ledgerRejection, LedgerUsbError, type LedgerUsbDevice, type LedgerUsbOpen } from "@/lib/ledger-usb";

/** Ledger's USB vendor id (@ledgerhq/devices ledgerUSBVendorId). */
const LEDGER_USB_VENDOR_ID = 0x2c97;

/** @ledgerhq/hw-transport's Transport: `close`, and its "disconnect" event
 * (hw-transport-webhid emits it when navigator.hid reports this device gone). */
type Transport = {
  close(): Promise<void>;
  on?(event: "disconnect", listener: (error?: unknown) => void): void;
  off?(event: "disconnect", listener: (error?: unknown) => void): void;
};
type TransportClass = {
  /** A permitted, connected Ledger, without any browser prompt; null when none. */
  openConnected(): Promise<Transport | null>;
  open(device: unknown): Promise<Transport>;
};
type Hid = { requestDevice(options: { filters: { vendorId: number }[] }): Promise<unknown[]> };
/** The @ledgerhq/hw-app-solana 7.11.0 methods the wallet uses. */
export type SolanaApp = {
  getAddress(path: string, display?: boolean): Promise<{ address: Uint8Array }>;
  getAppConfiguration(): Promise<{ version: string; blindSigningEnabled: boolean }>;
  signOffchainMessage(path: string, message: Buffer): Promise<{ signature: Uint8Array }>;
  signTransaction(path: string, message: Buffer): Promise<{ signature: Uint8Array }>;
};
type SolanaAppClass = new (transport: Transport) => SolanaApp;

/** The wallet's device over a Solana app instance: bytes go in as `Buffer`
 * (what the Ledger packages expect), come out as plain Uint8Array.
 *
 * A Ledger unplugged while it waits for the user's approval never answers,
 * and hw-transport-webhid 6.36.0 never rejects that read (it only emits
 * "disconnect"; its close() then waits for the lost exchange too). So every
 * call races the transport's "disconnect" event, and after a disconnect
 * close() does not wait: the wallet's queue (lib/ledger-usb.ts) and the
 * "confirm on your Ledger" notice are released with a "disconnected" error. */
export function solanaAppDevice(app: SolanaApp, transport: Transport, BufferClass: typeof Buffer): LedgerUsbDevice {
  let lost: Error | null = null;
  let rejectLost: (error: Error) => void = () => undefined;
  const disconnected = new Promise<never>((_, reject) => { rejectLost = reject; });
  disconnected.catch(() => undefined); // only observed through the races below
  const onDisconnect = () => {
    if (lost) return;
    // Named as @ledgerhq/errors names it: ledgerUsbError maps it to "disconnected".
    lost = Object.assign(new Error("The Ledger was disconnected during the request."), { name: "DisconnectedDeviceDuringOperation" });
    rejectLost(lost);
  };
  transport.on?.("disconnect", onDisconnect);
  const call = <T>(task: () => Promise<T>): Promise<T> => (lost ? Promise.reject(lost) : Promise.race([task(), disconnected]));

  return {
    getAddress: (path, display = false) => call(async () => new Uint8Array((await app.getAddress(path, display)).address)),
    getAppConfiguration: () => call(() => app.getAppConfiguration()),
    signOffchainMessage: (path, message) =>
      call(async () => new Uint8Array((await app.signOffchainMessage(path, BufferClass.from(message))).signature)),
    signTransaction: (path, message) =>
      call(async () => new Uint8Array((await app.signTransaction(path, BufferClass.from(message))).signature)),
    close: async () => {
      transport.off?.("disconnect", onDisconnect);
      if (!lost) return transport.close();
      // Gone: release what can be released, never wait for the lost exchange.
      void transport.close().catch(() => undefined);
    },
  };
}

/** True in a browser with WebHID (Chrome, Edge on desktop). */
export function hasWebHid(): boolean {
  return typeof navigator !== "undefined" && !!(navigator as Navigator & { hid?: unknown }).hid;
}

let modules: Promise<{ Transport: TransportClass; Solana: SolanaAppClass; BufferClass: typeof Buffer }> | null = null;

function loadModules() {
  modules ??= (async () => {
    const [{ Buffer: BufferClass }, transport, app] = await Promise.all([
      import("buffer"),
      import("@ledgerhq/hw-transport-webhid"),
      import("@ledgerhq/hw-app-solana"),
    ]);
    if (typeof globalThis.Buffer === "undefined") globalThis.Buffer = BufferClass;
    return {
      Transport: transport.default as unknown as TransportClass,
      Solana: app.default as unknown as SolanaAppClass,
      BufferClass,
    };
  })().catch((error) => {
    modules = null;
    throw new LedgerUsbError("failed", "The Ledger support could not be loaded. Check the connection and reload the page.", { cause: error });
  });
  return modules;
}

export const openWebHidLedger: LedgerUsbOpen = async ({ interactive }) => {
  if (!hasWebHid()) {
    throw new LedgerUsbError("unsupported", "This browser cannot reach a Ledger over USB. Use Chrome or Edge on a computer.");
  }
  const { Transport, Solana, BufferClass } = await loadModules();
  let transport = await Transport.openConnected();
  if (!transport) {
    if (!interactive) throw new LedgerUsbError("no_access", "No Ledger this site may use is connected.");
    // The browser's device chooser (needs a user gesture; a SecurityError
    // otherwise). It resolves with no device when the user closes it.
    const hid = (navigator as Navigator & { hid: Hid }).hid;
    const [device] = await hid.requestDevice({ filters: [{ vendorId: LEDGER_USB_VENDOR_ID }] });
    if (!device) throw ledgerRejection("No Ledger was selected.");
    transport = await Transport.open(device);
  }
  return solanaAppDevice(new Solana(transport), transport, BufferClass);
};
