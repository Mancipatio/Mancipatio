/**
 * A devnet-shaped FakeChain world for the chain CLI tool tests: both programs
 * deployed with the deployer as UA, funded keys, a Squads multisig matching
 * the role map, and helpers to run the tools against it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";
import { expect } from "vitest";
import { CLUSTER_GENESIS_HASHES } from "@/lib/network-identity";
import { createChainRpc } from "@/scripts/chain/lib/rpc";
import { validateRoleMap, type RoleMap } from "@/scripts/chain/lib/role-map";
import { loadHotSigner, repoRoot, sha256Hex, type ChainEnv } from "@/scripts/chain/lib/safety";
import { buildMessage } from "@/scripts/chain/lib/tx";
import { IDL_HEADER, PM_HEADER_LENGTH, PM_PROGRAM, compressIdl, encodeSeed, findCanonicalMetadataPda } from "@/scripts/chain/lib/program-metadata";
import {
  FakeChain,
  HOOK,
  REGISTRY,
  defaultKeys,
  instantTiming,
  rent,
  roleMapJson,
  tempDir,
  writeKeypair,
  type MapKeys,
  type TestKeypair,
} from "./chain-fake";

export const root = repoRoot();
export const SOL = BigInt(1_000_000_000);
export const CAPACITY = { assetRegistry: 4096, transferHook: 2048 };

export type Roles = "deployer" | "superAdmin" | "blocklistAuthority" | "kycAuthority" | "bufferWriter";

export type World = {
  dir: string;
  chain: FakeChain;
  keys: MapKeys;
  pairs: Record<Roles, TestKeypair>;
  mapFile: string;
  map: RoleMap;
  outputs: number;
};

export async function world(mapOverrides: Record<string, unknown> = {}): Promise<World> {
  const dir = tempDir();
  const pairs = {
    deployer: writeKeypair(dir, "deployer"),
    superAdmin: writeKeypair(dir, "sa"),
    blocklistAuthority: writeKeypair(dir, "ba"),
    kycAuthority: writeKeypair(dir, "kyc"),
    bufferWriter: writeKeypair(dir, "writer"),
  };
  const keys = await defaultKeys({
    deployer: pairs.deployer.address,
    superAdmin: pairs.superAdmin.address,
    blocklistAuthority: pairs.blocklistAuthority.address,
    kycAuthority: pairs.kycAuthority.address,
    bufferWriter: pairs.bufferWriter.address,
  });
  const chain = new FakeChain();
  await chain.deployProgram(REGISTRY, { authority: keys.deployer, payload: new Uint8Array([1, 2, 3]), capacity: CAPACITY.assetRegistry });
  await chain.deployProgram(HOOK, { authority: keys.deployer, payload: new Uint8Array([4, 5, 6]), capacity: CAPACITY.transferHook });
  chain.fund(keys.deployer, BigInt(100) * SOL);
  chain.fund(keys.bufferWriter, BigInt(10) * SOL);
  for (const pair of [pairs.superAdmin, pairs.blocklistAuthority, pairs.kycAuthority]) chain.fund(pair.address, SOL);
  await chain.seedMultisig({ multisig: keys.multisig, threshold: 2, members: keys.members.map((k) => ({ key: k, mask: 7 })) });
  chain.fund(keys.vault, SOL);
  const json = await roleMapJson(keys, "devnet", CLUSTER_GENESIS_HASHES.devnet, { programDataMaxLen: CAPACITY, ...mapOverrides });
  const mapFile = path.join(dir, "role-map.json");
  fs.writeFileSync(mapFile, JSON.stringify(json));
  const { map } = await validateRoleMap(json, { network: "devnet", genesis: CLUSTER_GENESIS_HASHES.devnet });
  return { dir, chain, keys, pairs, mapFile, map, outputs: 0 };
}

export function env(w: World, extra: ChainEnv = {}): ChainEnv {
  return {
    CHAIN_NETWORK: "devnet",
    CHAIN_RPC_URL: "https://rpc.example.test/",
    CHAIN_OUTPUT: path.join(w.dir, `evidence-${++w.outputs}.json`),
    CHAIN_ROLE_MAP: w.mapFile,
    CHAIN_STATE_DIR: path.join(w.dir, "state"),
    ...extra,
  };
}

export function deps(w: World, lines: string[] = []) {
  return { transport: w.chain.transport, rps: Infinity, timing: instantTiming(), root, log: (line: string) => lines.push(line) };
}

export function sendEnv(w: World, digest: string, extra: ChainEnv = {}, role: Roles = "deployer"): ChainEnv {
  return env(w, { CHAIN_SEND: "1", CHAIN_KEYPAIR: w.pairs[role].path, CHAIN_CONFIRM_PLAN: digest, ...extra });
}

export function rpcFor(w: World) {
  return createChainRpc({
    url: "https://rpc.example.test/",
    network: "devnet",
    expectedGenesis: CLUSTER_GENESIS_HASHES.devnet,
    mode: "read",
    rps: Infinity,
    transport: w.chain.transport,
  }).rpc;
}

export async function signerOf(w: World, role: Roles) {
  return loadHotSigner(w.pairs[role].path, w.pairs[role].address, role);
}

/** A Ledger action on the operator front, emulated by signing directly. */
export async function ledger(w: World, signer: TransactionSigner, ixs: Instruction[]) {
  const blockhash = { blockhash: "11111111111111111111111111111111" as never, lastValidBlockHeight: BigInt(10_000) };
  const signed = await signTransactionMessageWithSigners(buildMessage({ feePayer: signer, ixs, blockhash }));
  w.chain.handle("sendTransaction", [getBase64EncodedWireTransaction(signed), {}]);
  const sig = w.chain.sends[w.chain.sends.length - 1].sig;
  expect(w.chain.statuses.get(sig)?.err ?? null).toBeNull();
}

/** Writes a canonical Metadata account holding `content` (zlib, Utf8/Json/Direct). */
export async function seedIdl(
  w: World,
  program: Address,
  content: Uint8Array,
  options: { mutable?: boolean; authority?: Address | null; extraBytes?: number; compressed?: Uint8Array } = {},
) {
  const metadata = await findCanonicalMetadataPda(program);
  const compressed = options.compressed ?? compressIdl(content);
  const data = new Uint8Array(PM_HEADER_LENGTH + compressed.length + (options.extraBytes ?? 0));
  data[0] = 2;
  data.set(getAddressEncoder().encode(program), 1);
  if (options.authority) data.set(getAddressEncoder().encode(options.authority), 33);
  data[65] = options.mutable === false ? 0 : 1;
  data[66] = 1;
  data.set(encodeSeed("idl"), 67);
  data[83] = IDL_HEADER.encoding;
  data[84] = IDL_HEADER.compression;
  data[85] = IDL_HEADER.format;
  data[86] = IDL_HEADER.dataSource;
  new DataView(data.buffer).setUint32(87, compressed.length, true);
  data.set(compressed, PM_HEADER_LENGTH);
  w.chain.set(metadata, { owner: PM_PROGRAM, lamports: rent(data.length), data });
  return metadata;
}

export function localIdl(name: "asset_registry" | "transfer_hook"): Uint8Array {
  return new Uint8Array(fs.readFileSync(path.join(root, "front", "idl", `${name}.json`)));
}

/** A flat GitHub-Release-shaped directory (the CI release job layout). */
export function releaseDir(
  overrides: Partial<Record<"asset_registry" | "transfer_hook", Uint8Array>> = {},
  soOverrides: Partial<Record<"asset_registry" | "transfer_hook", Uint8Array>> = {},
) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "release-"));
  const so = { asset_registry: new Uint8Array([1, 2, 3]), transfer_hook: new Uint8Array([4, 5, 6]), ...soOverrides };
  const idl = { asset_registry: localIdl("asset_registry"), transfer_hook: localIdl("transfer_hook"), ...overrides };
  for (const name of ["asset_registry", "transfer_hook"] as const) {
    fs.writeFileSync(path.join(dir, `${name}.so`), so[name]);
    fs.writeFileSync(path.join(dir, `${name}.json`), idl[name]);
  }
  fs.writeFileSync(
    path.join(dir, "hashes.txt"),
    `base image: solanafoundation/solana-verifiable-build:3.1.13\ncommit: ${"a".repeat(40)}\nasset_registry: ${sha256Hex(so.asset_registry)}\ntransfer_hook: ${sha256Hex(so.transfer_hook)}\n`,
  );
  fs.writeFileSync(
    path.join(dir, "sbf-sha256.txt"),
    `${sha256Hex(so.asset_registry)}  target/deploy/asset_registry.so\n${sha256Hex(so.transfer_hook)}  target/deploy/transfer_hook.so\n`,
  );
  const files = ["asset_registry.so", "transfer_hook.so", "asset_registry.json", "transfer_hook.json", "hashes.txt", "sbf-sha256.txt"];
  fs.writeFileSync(
    path.join(dir, "SHA256SUMS"),
    files.map((file) => `${sha256Hex(fs.readFileSync(path.join(dir, file)))}  ${file}`).join("\n") + "\n",
  );
  return dir;
}
