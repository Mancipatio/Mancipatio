import { isWalletSession, type WalletSession } from "@solana/client";
import { TransactionWalletChangedError } from "@/lib/transaction-wallet-policy";

const SIGN_METHODS = new Set([
  "signTransaction", "sendTransaction", "signTransactions", "modifyAndSignTransactions", "signAndSendTransactions",
]);

/** Preserve repeated signer references while adding checks at the actual
 * signing boundary, including awaits inside the SDK's prepareAndSend helper.
 * This does not replace a signer, its address, or any instruction authority. */
export function guardTransactionGraph<T>(value: T, session: WalletSession, assertCurrent: () => void): T {
  const copies = new WeakMap<object, unknown>();
  function copy(input: unknown): unknown {
    if (!input || typeof input !== "object") return input;
    if (copies.has(input)) return copies.get(input);
    if (input instanceof Uint8Array) return Uint8Array.from(input);
    if (Array.isArray(input)) {
      const result: unknown[] = [];
      copies.set(input, result);
      result.push(...input.map(copy));
      return Object.freeze(result);
    }
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) return input;
    if (isWalletSession(input) && input !== session) throw new TransactionWalletChangedError();
    const result: Record<string, unknown> = {};
    copies.set(input, result);
    for (const [key, entry] of Object.entries(input)) {
      result[key] = SIGN_METHODS.has(key) && typeof entry === "function"
        ? async (...args: unknown[]) => {
          assertCurrent();
          const output = await Reflect.apply(entry, input, args);
          assertCurrent();
          return output;
        }
        : copy(entry);
    }
    return Object.freeze(result);
  }
  return copy(value) as T;
}
