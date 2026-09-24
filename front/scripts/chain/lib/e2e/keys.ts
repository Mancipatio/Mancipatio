/**
 * The e2e role keys (design-6.3 §E): ephemeral ed25519 keypairs in
 * `<E2E_DIR>/keys/<role>.json`, the 64-byte format the Solana CLI reads
 * (directory 700, files 600, written with `wx`). Only addresses ever reach
 * the output; byte buffers are zeroed after use, as in loadHotSigner.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  createKeyPairSignerFromBytes,
  createKeyPairSignerFromPrivateKeyBytes,
  getAddressEncoder,
  type KeyPairSigner,
} from "@solana/kit";
import { ChainGateError } from "../safety";

const ROLE_NAME = /^[a-zA-Z][a-zA-Z0-9-]{0,40}$/;

export function keysDir(e2eDir: string): string {
  return path.join(e2eDir, "keys");
}

function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

async function readKey(file: string, role: string): Promise<KeyPairSigner> {
  let bytes: Uint8Array | null = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 64) {
      throw new ChainGateError(`The e2e ${role} key file is not a 64-byte keypair`);
    }
    bytes = Uint8Array.from(parsed as number[]);
    (parsed as number[]).fill(0);
    return await createKeyPairSignerFromBytes(bytes);
  } catch (error) {
    if (error instanceof ChainGateError) throw error;
    throw new ChainGateError(`The e2e ${role} key file is unreadable or invalid (details withheld)`);
  } finally {
    bytes?.fill(0);
  }
}

/** Loads `<dir>/keys/<role>.json`, creating a fresh keypair on first use. */
export async function loadOrCreateRoleKey(e2eDir: string, role: string): Promise<KeyPairSigner> {
  if (!ROLE_NAME.test(role)) throw new ChainGateError(`Invalid e2e role name ${role}`);
  const dir = keysDir(e2eDir);
  ensurePrivateDir(dir);
  const file = path.join(dir, `${role}.json`);
  if (fs.existsSync(file)) return readKey(file, role);
  const seed = new Uint8Array(randomBytes(32));
  const full = new Uint8Array(64);
  try {
    const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
    full.set(seed, 0);
    full.set(getAddressEncoder().encode(signer.address), 32);
    fs.writeFileSync(file, `${JSON.stringify(Array.from(full))}\n`, { flag: "wx", mode: 0o600 });
    // Re-read so the signer used is exactly what the file holds.
    return await readKey(file, role);
  } finally {
    seed.fill(0);
    full.fill(0);
  }
}
