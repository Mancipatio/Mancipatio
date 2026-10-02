/**
 * Ledger signing for `chain:emergency` (Talas 8.2) and `chain:accept` (the
 * bootstrap steps a role key signs itself). The Solana CLI cannot sign
 * an arbitrary program instruction with `usb://ledger`, so the tool talks to
 * the Ledger Solana app itself through Ledger's Node packages. They are not
 * dependencies of the app (no native module reaches CI or Vercel) and never
 * go into front/node_modules: `front/scripts/chain/ledger/` pins them (exact
 * versions in package.json, every tarball's integrity in package-lock.json,
 * both under the mainnet source guard), and the operator installs them there
 * once with
 *   cd front/scripts/chain/ledger && npm ci --ignore-scripts
 * `--ignore-scripts` runs no install-time code on the machine that holds the
 * role keys: node-hid 3 ships its prebuilt binaries inside the (integrity-
 * checked) tarball, so nothing is downloaded or compiled. The loader refuses
 * an install whose versions differ from the lock. Tests inject a device.
 *
 * The device signs the serialized transaction message; a program it cannot
 * parse needs "Blind signing" enabled in the Solana app, and the tool prints
 * the message hash (base58 of its SHA-256) to compare with the device screen
 * before approving: a mismatch means something between the tool and the
 * device changed the message, so reject it on the device.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import {
  getAddressDecoder,
  getBase58Decoder,
  type Address,
  type SignatureBytes,
  type TransactionPartialSigner,
} from "@solana/kit";
import { ChainGateError, FRONT_DIR } from "./safety";

export type LedgerDevice = {
  /** The 32-byte public key at a hardened path such as `44'/501'/0'`. */
  getPublicKey(path: string): Promise<Uint8Array>;
  /** The Ed25519 signature over one serialized transaction message. */
  signMessage(path: string, message: Uint8Array): Promise<Uint8Array>;
  close(): Promise<void>;
};

export type LedgerOpener = () => Promise<LedgerDevice>;

/** The pinned package directory (package.json + package-lock.json). */
export const LEDGER_DIR = path.join(FRONT_DIR, "scripts", "chain", "ledger");
export const LEDGER_PACKAGES = ["@ledgerhq/hw-transport-node-hid-noevents", "@ledgerhq/hw-app-solana"] as const;
export const LEDGER_INSTALL_HINT = "cd front/scripts/chain/ledger && npm ci --ignore-scripts";

type TransportClass = { open(descriptor: string): Promise<{ close(): Promise<void> }> };
type SolanaApp = {
  getAddress(path: string): Promise<{ address: Uint8Array }>;
  signTransaction(path: string, message: Uint8Array): Promise<{ signature: Uint8Array }>;
};
type SolanaAppClass = new (transport: unknown) => SolanaApp;

/** The CommonJS builds export the class as `exports.default`. */
const unwrapDefault = (value: unknown): unknown =>
  value !== null && typeof value === "object" && "default" in value ? (value as { default: unknown }).default : value;

/**
 * Checks that `dir/node_modules` holds exactly the versions the lock pins
 * for the two direct packages (their dependencies are pinned by `npm ci`).
 */
export function assertPinnedLedgerInstall(dir: string): void {
  let lock: { packages?: Record<string, { version?: string }> };
  try {
    lock = JSON.parse(fs.readFileSync(path.join(dir, "package-lock.json"), "utf8"));
  } catch {
    throw new ChainGateError(`The Ledger package lock is missing or unreadable in ${dir}`);
  }
  for (const name of LEDGER_PACKAGES) {
    const pinned = lock.packages?.[`node_modules/${name}`]?.version;
    if (!pinned) throw new ChainGateError(`The Ledger package lock does not pin ${name}`);
    let installed: string | undefined;
    try {
      installed = (JSON.parse(fs.readFileSync(path.join(dir, "node_modules", name, "package.json"), "utf8")) as { version?: string }).version;
    } catch {
      throw new ChainGateError(`Ledger signing needs ${name}, which is not installed; on the operator machine run: ${LEDGER_INSTALL_HINT}`);
    }
    if (installed !== pinned) {
      throw new ChainGateError(`${name} ${installed ?? "?"} is installed but the lock pins ${pinned}; reinstall with: ${LEDGER_INSTALL_HINT}`);
    }
  }
}

/** Opens the first Ledger on USB through the pinned packages in `dir`. */
export function nodeHidLedgerOpener(dir: string = LEDGER_DIR): LedgerOpener {
  return async () => {
    assertPinnedLedgerInstall(dir);
    const load = createRequire(path.join(dir, "package.json"));
    let Transport: TransportClass;
    let Solana: SolanaAppClass;
    try {
      Transport = unwrapDefault(load(LEDGER_PACKAGES[0])) as TransportClass;
      Solana = unwrapDefault(load(LEDGER_PACKAGES[1])) as SolanaAppClass;
    } catch {
      throw new ChainGateError(`The Ledger packages in front/scripts/chain/ledger do not load; reinstall with: ${LEDGER_INSTALL_HINT}`);
    }
    let transport: Awaited<ReturnType<TransportClass["open"]>>;
    try {
      // "" opens the first Ledger found; hw-transport's create() fails for this
      // transport (its listen() completes synchronously).
      transport = await Transport.open("");
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
}

export const openNodeHidLedger: LedgerOpener = nodeHidLedgerOpener();

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
        log(`Ledger: compare the message hash on the device with ${messageHash(message)} before approving; reject on the device if they differ`);
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
