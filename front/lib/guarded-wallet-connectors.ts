import type { WalletConnector, WalletSession } from "@solana/client";
import { TransactionWalletChangedError } from "@/lib/transaction-wallet-policy";

type AccountsListener = Parameters<NonNullable<WalletSession["onAccountsChanged"]>>[0];

/** The installed Wallet Standard adapter changes its internal signing account
 * on an accounts event but leaves session.account unchanged. Pin each session
 * and notify the client of a disconnect instead of allowing a hidden switch. */
export function guardWalletSession(
  source: WalletSession,
  getCurrentSession: () => WalletSession | undefined,
): WalletSession {
  const expectedAddress = source.account.address.toString();
  const expectedKey = Uint8Array.from(source.account.publicKey);
  let valid = true;
  let unsubscribe: (() => void) | undefined;
  const listeners = new Set<AccountsListener>();

  function assertCurrent() {
    if (!valid || getCurrentSession() !== guarded) throw new TransactionWalletChangedError();
  }

  function invalidate() {
    if (!valid) return;
    valid = false;
    unsubscribe?.();
    unsubscribe = undefined;
    // The client's existing empty-accounts handler disconnects its store and
    // connector. Marking invalid first blocks signing during that async work.
    for (const listener of [...listeners]) listener([]);
  }

  const guarded: WalletSession = {
    ...source,
    account: Object.freeze({ ...source.account, publicKey: Uint8Array.from(expectedKey) }),
    async disconnect() {
      valid = false;
      unsubscribe?.();
      unsubscribe = undefined;
      await source.disconnect();
    },
    onAccountsChanged(listener) {
      listeners.add(listener);
      if (!valid) queueMicrotask(() => { if (listeners.has(listener)) listener([]); });
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          // The SDK removes this subscription before replacing/disconnecting
          // a session. A retained signer from that session must stay unusable.
          valid = false;
          unsubscribe?.();
          unsubscribe = undefined;
        }
      };
    },
    ...(source.signMessage ? { async signMessage(message: Uint8Array) {
      assertCurrent();
      const result = await source.signMessage!.call(source, message);
      assertCurrent();
      return result;
    } } : {}),
    ...(source.signTransaction ? { async signTransaction(...args: Parameters<NonNullable<WalletSession["signTransaction"]>>) {
      assertCurrent();
      const result = await source.signTransaction!.apply(source, args);
      assertCurrent();
      return result;
    } } : {}),
    ...(source.sendTransaction ? { async sendTransaction(...args: Parameters<NonNullable<WalletSession["sendTransaction"]>>) {
      assertCurrent();
      const result = await source.sendTransaction!.apply(source, args);
      assertCurrent();
      return result;
    } } : {}),
  };
  unsubscribe = source.onAccountsChanged?.((accounts) => {
    const first = accounts[0];
    if (!first || first.address.toString() !== expectedAddress || first.publicKey.length !== expectedKey.length ||
        first.publicKey.some((byte, index) => byte !== expectedKey[index])) {
      invalidate();
      return;
    }
    if (valid) for (const listener of [...listeners]) listener(accounts);
  });
  return Object.freeze(guarded);
}

export function guardWalletConnectors(
  connectors: readonly WalletConnector[],
  getCurrentSession: () => WalletSession | undefined,
): readonly WalletConnector[] {
  return connectors.map((connector) => ({
    ...connector,
    async connect(options) {
      return guardWalletSession(await connector.connect(options), getCurrentSession);
    },
  }));
}
