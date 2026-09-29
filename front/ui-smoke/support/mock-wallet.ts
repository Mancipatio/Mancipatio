// A Wallet Standard wallet for the smoke only. It lives in ui-smoke/, which
// no app module imports, so it never reaches a production bundle; it is
// injected into the test browser with page.addInitScript before the app's
// own scripts run (autoDiscover reads the registered wallets once, at load).
//
// It signs in the browser with a TEST keypair derived from a fixed label
// (WebCrypto Ed25519): the key is public by construction and never holds
// anything. `solana:signMessage` is the only signing feature: the smoke
// signs SIWS messages and never sends a transaction.
import { createHash, createPrivateKey, createPublicKey, verify } from "node:crypto";
import type { Page } from "@playwright/test";
import { getAddressDecoder, type Address } from "@solana/kit";

// PKCS#8 header of an Ed25519 private key (RFC 8410), followed by the seed.
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export type TestWallet = {
  address: Address;
  publicKey: Uint8Array;
  pkcs8: Uint8Array;
};

export function testWallet(label = "wallet"): TestWallet {
  const seed = createHash("sha256").update(`manci-ui-smoke:test-keypair:${label}`).digest();
  const pkcs8 = Buffer.concat([PKCS8_ED25519_PREFIX, seed]);
  const spki = createPublicKey(createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" })).export({ format: "der", type: "spki" });
  const publicKey = Uint8Array.from(spki.subarray(spki.length - 32));
  return { address: getAddressDecoder().decode(publicKey), publicKey, pkcs8: Uint8Array.from(pkcs8) };
}

/** Node-side check of a signature the browser wallet produced. */
export function verifiesFor(wallet: TestWallet, message: Uint8Array, signature: Uint8Array): boolean {
  const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
  const key = createPublicKey({ key: Buffer.concat([spkiPrefix, wallet.publicKey]), format: "der", type: "spki" });
  return verify(null, message, key, signature);
}

export const MOCK_WALLET_NAME = "Manci UI Smoke Wallet";

type InstallArgs = { name: string; address: string; publicKey: number[]; pkcs8: number[]; chains: string[] };

/** Runs in the browser, before the page's scripts. Must be self-contained. */
function installInBrowser(args: InstallArgs) {
  type Listener = (properties: { accounts?: unknown[] }) => void;
  const keyPromise = crypto.subtle.importKey("pkcs8", new Uint8Array(args.pkcs8), { name: "Ed25519" }, false, ["sign"]);
  const signed: { message: number[]; signature: number[] }[] = [];
  const features = ["solana:signMessage"] as const;
  const account = Object.freeze({
    address: args.address,
    publicKey: new Uint8Array(args.publicKey),
    chains: args.chains,
    features,
    label: args.name,
  });
  let accounts: (typeof account)[] = [];
  const listeners = new Set<Listener>();
  const emit = () => listeners.forEach((listener) => listener({ accounts }));
  const wallet = {
    version: "1.0.0" as const,
    name: args.name,
    icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxIDEiLz4=",
    chains: args.chains,
    get accounts() {
      return accounts;
    },
    features: {
      "standard:connect": {
        version: "1.0.0",
        connect: async () => {
          accounts = [account];
          emit();
          return { accounts };
        },
      },
      "standard:disconnect": {
        version: "1.0.0",
        disconnect: async () => {
          accounts = [];
          emit();
        },
      },
      "standard:events": {
        version: "1.0.0",
        on: (event: string, listener: Listener) => {
          if (event !== "change") return () => {};
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      "solana:signMessage": {
        version: "1.1.0",
        signMessage: async (...inputs: { message: Uint8Array }[]) =>
          Promise.all(
            inputs.map(async ({ message }) => {
              const signature = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, await keyPromise, new Uint8Array(message)));
              signed.push({ message: [...message], signature: [...signature] });
              return { signedMessage: message, signature };
            }),
          ),
      },
    },
  };
  (window as unknown as { __uiSmokeWallet: unknown }).__uiSmokeWallet = { signed };
  // Wallet Standard registration, both orders: the app is not there yet
  // (app-ready arrives later) or it already listens (register-wallet).
  const callback = ({ register }: { register: (w: unknown) => unknown }) => register(wallet);
  window.addEventListener("wallet-standard:app-ready", (event) => callback((event as CustomEvent).detail));
  window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: callback }));
}

export async function installMockWallet(page: Page, wallet: TestWallet) {
  await page.addInitScript(installInBrowser, {
    name: MOCK_WALLET_NAME,
    address: wallet.address,
    publicKey: [...wallet.publicKey],
    pkcs8: [...wallet.pkcs8],
    chains: ["solana:devnet", "solana:mainnet", "solana:testnet", "solana:localnet"],
  } satisfies InstallArgs);
}

/** The messages the browser wallet signed so far, in order, on the current
 *  document: the record lives in the page, so a navigation starts a new one. */
export async function signedMessages(page: Page): Promise<{ message: Uint8Array; signature: Uint8Array }[]> {
  const raw = await page.evaluate(
    () => (window as unknown as { __uiSmokeWallet?: { signed: { message: number[]; signature: number[] }[] } }).__uiSmokeWallet?.signed ?? [],
  );
  return raw.map((entry) => ({ message: Uint8Array.from(entry.message), signature: Uint8Array.from(entry.signature) }));
}
