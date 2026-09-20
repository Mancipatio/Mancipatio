import { describe, expect, it, vi } from "vitest";
import { createWalletStandardConnector, type WalletConnector, type WalletSession } from "@solana/client";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import type { Address } from "@solana/kit";
import { guardWalletConnectors, guardWalletSession } from "@/lib/guarded-wallet-connectors";

const WALLET = "11111111111111111111111111111111" as Address;
const OTHER = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" as Address;
type Accounts = Parameters<Parameters<NonNullable<WalletSession["onAccountsChanged"]>>[0]>[0];

function fixture() {
  let notify: (accounts: Accounts) => void = () => {};
  let current: WalletSession | undefined;
  const off = vi.fn();
  const source: WalletSession = {
    account: { address: WALLET, publicKey: new Uint8Array(32) },
    connector: { id: "fixture", name: "Fixture" },
    disconnect: vi.fn(async () => {}),
    onAccountsChanged: vi.fn((listener) => { notify = listener; return off; }),
    signMessage: vi.fn(async () => new Uint8Array(64)),
    signTransaction: vi.fn(async (transaction) => transaction),
    sendTransaction: vi.fn(async () => "signature" as Awaited<ReturnType<NonNullable<WalletSession["sendTransaction"]>>>),
  };
  const guarded = guardWalletSession(source, () => current);
  current = guarded;
  const listener = vi.fn();
  const unsubscribe = guarded.onAccountsChanged!(listener);
  return { source, guarded, listener, off, unsubscribe,
    notify: (accounts: Accounts) => notify(accounts),
    setCurrent: (value: WalletSession | undefined) => { current = value; },
  };
}

describe("wallet session account changes", () => {
  it("does not sign while creating the connector/session wrapper", () => {
    const f = fixture();
    expect(f.source.signMessage).not.toHaveBeenCalled();
    expect(f.source.signTransaction).not.toHaveBeenCalled();
    expect(f.source.sendTransaction).not.toHaveBeenCalled();
  });

  it("preserves a same-account event without manufacturing another session address", async () => {
    const f = fixture();
    f.notify([{ address: WALLET, publicKey: new Uint8Array(32) }]);
    expect(f.listener).toHaveBeenCalledWith([{ address: WALLET, publicKey: new Uint8Array(32) }]);
    await f.guarded.signMessage!(new Uint8Array([1]));
    expect(f.source.signMessage).toHaveBeenCalledOnce();
    expect(f.guarded.account.address).toBe(WALLET);
  });

  it.each(["address", "key", "empty"])("invalidates and emits disconnect for a changed %s", async (kind) => {
    const f = fixture();
    f.notify(kind === "empty" ? [] : [{ address: kind === "address" ? OTHER : WALLET,
      publicKey: kind === "key" ? new Uint8Array(32).fill(1) : new Uint8Array(32) }]);
    expect(f.listener).toHaveBeenCalledExactlyOnceWith([]);
    expect(f.off).toHaveBeenCalledOnce();
    expect(f.guarded.account.address).toBe(WALLET);
    await expect(f.guarded.signMessage!(new Uint8Array())).rejects.toThrow("changed");
    expect(f.source.signMessage).not.toHaveBeenCalled();
  });

  it.each(["signMessage", "signTransaction", "sendTransaction"] as const)("guards %s before calling a superseded session", async (method) => {
    const f = fixture();
    f.setCurrent({ ...f.guarded });
    const call = f.guarded[method] as (input: unknown) => Promise<unknown>;
    await expect(call(new Uint8Array())).rejects.toThrow("changed");
    expect(f.source[method]).not.toHaveBeenCalled();
  });

  it("withholds a result when the extension switches its hidden account during approval", async () => {
    const f = fixture();
    vi.mocked(f.source.signMessage!).mockImplementation(async () => {
      f.notify([{ address: OTHER, publicKey: new Uint8Array(32) }]);
      return new Uint8Array(64);
    });
    await expect(f.guarded.signMessage!(new Uint8Array())).rejects.toThrow("changed");
    expect(f.listener).toHaveBeenCalledWith([]);
  });

  it("keeps a retained signer invalid after the SDK unsubscribes during reconnect", async () => {
    const f = fixture();
    f.unsubscribe();
    await expect(f.guarded.signMessage!(new Uint8Array())).rejects.toThrow("changed");
    expect(f.source.signMessage).not.toHaveBeenCalled();
    expect(f.off).toHaveBeenCalledOnce();
  });

  it("disconnect invalidates immediately while the extension is still closing", async () => {
    const f = fixture();
    let finish!: () => void;
    vi.mocked(f.source.disconnect).mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const pending = f.guarded.disconnect();
    await expect(f.guarded.signMessage!(new Uint8Array())).rejects.toThrow("changed");
    finish(); await pending;
    expect(f.source.disconnect).toHaveBeenCalledOnce();
  });

  it("wraps every discovered connector and preserves the explicit connection options", async () => {
    const f = fixture();
    const connect = vi.fn(async () => f.source);
    const connector: WalletConnector = { id: "fixture", name: "Fixture", connect,
      disconnect: vi.fn(async () => {}), isSupported: () => true };
    const [wrapped] = guardWalletConnectors([connector], () => undefined);
    const options = { autoConnect: false, allowInteractiveFallback: true };
    const connected = await wrapped.connect(options);
    expect(connect).toHaveBeenCalledExactlyOnceWith(options);
    expect(connected).not.toBe(f.source);
    expect(connected.account.address).toBe(f.source.account.address);
    expect(wrapped.id).toBe(connector.id);
  });

  it("blocks the installed Wallet Standard adapter's hidden signer switch", async () => {
    const first: WalletAccount = { address: WALLET, publicKey: new Uint8Array(32),
      chains: ["solana:devnet"], features: ["solana:signMessage"] };
    const second: WalletAccount = { ...first, address: OTHER, publicKey: new Uint8Array(32).fill(1) };
    let onChange: (event: { accounts: WalletAccount[] }) => void = () => {};
    const signMessage = vi.fn(async (input: { account: WalletAccount }) => [{ signature: new Uint8Array(64), account: input.account }]);
    const wallet = {
      version: "1.0.0", name: "Actual adapter fixture", icon: "data:image/svg+xml;base64,PHN2Zy8+",
      chains: ["solana:devnet"], accounts: [first],
      features: {
        "standard:connect": { version: "1.0.0", connect: async () => ({ accounts: [first] }) },
        "standard:events": { version: "1.0.0", on: (_event: string, listener: typeof onChange) => { onChange = listener; return () => {}; } },
        "solana:signMessage": { version: "1.0.0", signMessage },
      },
    } as unknown as Wallet;
    let current: WalletSession | undefined;
    const [connector] = guardWalletConnectors([createWalletStandardConnector(wallet)], () => current);
    current = await connector.connect();
    const connected = current;
    const disconnect = vi.fn(() => { current = undefined; });
    connected.onAccountsChanged!((accounts) => { if (!accounts.length) disconnect(); });
    await connected.signMessage!(new Uint8Array([1]));
    expect(signMessage.mock.calls[0][0]).toMatchObject({ account: { address: WALLET } });
    // The real SDK changes its closure's currentAccount to second here while
    // returning the original account object from connected.account.
    onChange({ accounts: [second] });
    expect(connected.account.address).toBe(WALLET);
    expect(disconnect).toHaveBeenCalledOnce();
    await expect(connected.signMessage!(new Uint8Array([2]))).rejects.toThrow("changed");
    expect(signMessage).toHaveBeenCalledOnce();
  });
});
