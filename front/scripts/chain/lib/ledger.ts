/**
 * Ledger signing for `chain:emergency` (Talas 8.2). The Solana CLI cannot sign
 * an arbitrary program instruction with `usb://ledger`, so the tool talks to
 * the Ledger Solana app itself through Ledger's Node packages. They are not
 * dependencies of the app (no native module reaches CI or Vercel): the
 * operator installs them once on the operator machine with
 *   npm install --no-save @ledgerhq/hw-transport-node-hid @ledgerhq/hw-app-solana
 * which leaves package.json and package-lock.json clean (the mainnet
 * source-integrity guard stays green). Tests inject a device instead.
 *
 * The device signs the serialized transaction message; a program it cannot
 * parse needs "Blind signing" enabled in the Solana app, and the tool prints
 * the message hash (base58 of its SHA-256) to compare with the device screen.
 */
import { createHash } from "node:crypto";
import {
  getAddressDecoder,
  getBase58Decoder,
  type Address,
  type SignatureBytes,
  type TransactionPartialSigner,
} from "@solana/kit";
import { ChainGateError } from "./safety";

export type LedgerDevice = {
  /** The 32-byte public key at a hardened path such as `44'/501'/0'`. */
  getPublicKey(path: string): Promise<Uint8Array>;
  /** The Ed25519 signature over one serialized transaction message. */
  signMessage(path: string, message: Uint8Array): Promise<Uint8Array>;
  close(): Promise<void>;
};

export type LedgerOpener = () => Promise<LedgerDevice>;

export const LEDGER_PACKAGES = ["@ledgerhq/hw-transport-node-hid", "@ledgerhq/hw-app-solana"] as const;
export const LEDGER_INSTALL_HINT = `npm install --no-save ${LEDGER_PACKAGES.join(" ")}`;

type TransportClass = { create(): Promise<{ close(): Promise<void> }> };
type SolanaApp = {
  getAddress(path: string): Promise<{ address: Uint8Array }>;
  signTransaction(path: string, message: Uint8Array): Promise<{ signature: Uint8Array }>;
};
type SolanaAppClass = new (transport: unknown) => SolanaApp;

async function loadOptional(name: string): Promise<unknown> {
  try {
    const loaded = (await import(/* @vite-ignore */ name)) as { default?: unknown };
    return loaded.default ?? loaded;
  } catch {
    throw new ChainGateError(`Ledger signing needs ${name}, which is not installed; on the operator machine run: ${LEDGER_INSTALL_HINT}`);
  }
}

/** Opens the first Ledger on USB through the optional Ledger packages. */
export const openNodeHidLedger: LedgerOpener = async () => {
  const Transport = (await loadOptional(LEDGER_PACKAGES[0])) as TransportClass;
  const Solana = (await loadOptional(LEDGER_PACKAGES[1])) as SolanaAppClass;
  let transport: Awaited<ReturnType<TransportClass["create"]>>;
  try {
    transport = await Transport.create();
  } catch {
    throw new ChainGateError("No Ledger answered on USB: connect it, unlock it and open the Solana app");
  }
  const app = new Solana(transport);
  return {
    getPublicKey: async (path) => new Uint8Array((await app.getAddress(path)).address),
    signMessage: async (path, message) => new Uint8Array((await app.signTransaction(path, Buffer.from(message))).signature),
    close: () => transport.close(),
  };
};

/** base58(SHA-256(message)): what the Solana app shows when it blind-signs. */
export function messageHash(message: Uint8Array): string {
  return getBase58Decoder().decode(createHash("sha256").update(message).digest());
}

/**
 * A partial signer backed by the device. The device's key at `path` must be
 * `expected`; every signature is checked for length here and verified again
 * by the signed simulation (sigVerify) before anything is sent.
 */
export async function ledgerSigner(input: {
  device: LedgerDevice;
  path: string;
  expected: Address;
  log: (line: string) => void;
}): Promise<TransactionPartialSigner> {
  const { device, path, expected, log } = input;
  let key: Uint8Array;
  try {
    key = await device.getPublicKey(path);
  } catch {
    throw new ChainGateError(`The Ledger did not return a key for ${path}: unlock it and open the Solana app`);
  }
  if (key.length !== 32) throw new ChainGateError("The Ledger returned a malformed public key");
  const address = getAddressDecoder().decode(key);
  if (address !== expected) throw new ChainGateError(`The Ledger key at ${path} is ${address}, not the expected signer ${expected}`);
  return {
    address,
    signTransactions: async (transactions) => {
      const out = [];
      for (const transaction of transactions) {
        const message = new Uint8Array(transaction.messageBytes);
        log(`Ledger: review and approve on the device (message hash ${messageHash(message)})`);
        let signature: Uint8Array;
        try {
          signature = await device.signMessage(path, message);
        } catch {
          throw new ChainGateError("The Ledger did not sign (rejected on the device, locked, or blind signing is off)");
        }
        if (signature.length !== 64) throw new ChainGateError("The Ledger returned a malformed signature");
        out.push(Object.freeze({ [address]: signature as SignatureBytes }));
      }
      return out;
    },
  };
}
