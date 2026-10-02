// The "Ledger (USB)" browser glue: the WebHID opener (lib/ledger-usb-webhid.ts)
// over a mocked @ledgerhq/hw-transport-webhid whose transport is the APDU
// simulation of the Solana app (the real @ledgerhq/hw-app-solana on top), and
// where the connector is offered (lib/ledger-usb-connector.ts).
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { LEDGER_DERIVATION_PATHS, LEDGER_USB_CONNECTOR_ID, LEDGER_USB_WALLET_NAME } from "@/lib/ledger-usb";
import { SolanaAppSim, simKeys, type SimKey } from "./helpers/ledger-solana-sim";

const webhid = vi.hoisted(() => ({ openConnected: vi.fn(), open: vi.fn() }));
vi.mock("@ledgerhq/hw-transport-webhid", () => ({ default: webhid }));

import { openWebHidLedger } from "@/lib/ledger-usb-webhid";
import { ledgerUsbConnectors } from "@/lib/ledger-usb-connector";

let keys: Map<string, SimKey>;
beforeAll(async () => { keys = await simKeys(LEDGER_DERIVATION_PATHS); });
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  webhid.openConnected.mockReset();
  webhid.open.mockReset();
});

describe("openWebHidLedger", () => {
  it("refuses a browser without WebHID", async () => {
    vi.stubGlobal("navigator", {});
    await expect(openWebHidLedger({ interactive: true })).rejects.toMatchObject({ name: "LedgerUsbError", reason: "unsupported" });
  });

  it("opens a permitted Ledger without any browser prompt, and talks to its Solana app", async () => {
    const requestDevice = vi.fn();
    vi.stubGlobal("navigator", { hid: { requestDevice } });
    const sim = new SolanaAppSim(keys);
    webhid.openConnected.mockResolvedValue(sim);
    const device = await openWebHidLedger({ interactive: false });
    const key = await device.getAddress("44'/501'/0'");
    expect(key).toBeInstanceOf(Uint8Array);
    expect([...key]).toEqual([...keys.get("44'/501'/0'")!.publicKey]);
    await expect(device.getAppConfiguration()).resolves.toMatchObject({ version: "1.16.0", blindSigningEnabled: true });
    const signature = await device.signTransaction("44'/501'/0'", Uint8Array.from([1, 2, 3]));
    expect(signature).toHaveLength(64);
    expect(sim.signed).toEqual([{ ins: 0x06, path: "44'/501'/0'", message: Buffer.from([1, 2, 3]) }]);
    await device.close();
    expect(sim.closed).toBe(1);
    expect(requestDevice).not.toHaveBeenCalled();
  });

  it("without a permitted Ledger: no_access when it may not prompt, the browser's chooser when it may", async () => {
    const chosen = { productId: 0x5011 };
    const requestDevice = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([chosen]);
    vi.stubGlobal("navigator", { hid: { requestDevice } });
    webhid.openConnected.mockResolvedValue(null);
    await expect(openWebHidLedger({ interactive: false })).rejects.toMatchObject({ reason: "no_access" });
    expect(requestDevice).not.toHaveBeenCalled();
    // The user closes the chooser: a user rejection.
    await expect(openWebHidLedger({ interactive: true })).rejects.toMatchObject({ code: 4001, message: "No Ledger was selected." });
    webhid.open.mockResolvedValue(new SolanaAppSim(keys));
    await openWebHidLedger({ interactive: true });
    expect(requestDevice).toHaveBeenLastCalledWith({ filters: [{ vendorId: 0x2c97 }] });
    expect(webhid.open).toHaveBeenCalledWith(chosen);
  });
});

describe("ledgerUsbConnectors", () => {
  it("offers Ledger (USB) only in a browser with WebHID, on every network, unless the kill switch is off", () => {
    vi.stubGlobal("window", { localStorage: null });
    vi.stubGlobal("navigator", {});
    expect(ledgerUsbConnectors("mainnet")).toEqual([]);

    vi.stubGlobal("navigator", { hid: {} });
    for (const network of ["mainnet", "devnet"] as const) {
      const [connector, ...rest] = ledgerUsbConnectors(network);
      expect(rest).toEqual([]);
      expect(connector).toMatchObject({ id: LEDGER_USB_CONNECTOR_ID, name: LEDGER_USB_WALLET_NAME, kind: "wallet-standard" });
      expect(connector.icon).toMatch(/^data:image\/svg\+xml;base64,/);
    }

    vi.stubEnv("NEXT_PUBLIC_FEATURE_LEDGER_USB", "false");
    expect(ledgerUsbConnectors("mainnet")).toEqual([]);
  });
});
