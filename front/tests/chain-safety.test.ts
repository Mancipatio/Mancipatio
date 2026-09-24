import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CLUSTER_GENESIS_HASHES } from "@/lib/network-identity";
import {
  ChainGateError,
  SOURCE_INTEGRITY_PATHS,
  assertOutputPath,
  assertReleaseSource,
  installFetchGuard,
  loadHotSigner,
  readChainConfig,
  repoRoot,
  type ChainEnv,
} from "@/scripts/chain/lib/safety";
import { key, tempDir, writeKeypair } from "./helpers/chain-fake";

const root = repoRoot();
const dir = tempDir();
let counter = 0;
const fresh = () => path.join(dir, `evidence-${++counter}.json`);
const base = (extra: ChainEnv = {}): ChainEnv => ({
  CHAIN_NETWORK: "devnet",
  CHAIN_RPC_URL: "https://rpc.example.test/key-in-path",
  CHAIN_OUTPUT: fresh(),
  ...extra,
});
const config = (tool: Parameters<typeof readChainConfig>[0], env: ChainEnv) => readChainConfig(tool, env, { root, home: dir });
const refuse = (fn: () => unknown, pattern: RegExp) => {
  expect(fn).toThrow(ChainGateError);
  expect(fn).toThrow(pattern);
};

describe("environment gates (runner contract §3.1)", () => {
  it("parses a minimal devnet dry run and pins the cluster genesis", () => {
    const parsed = config("inventory", base());
    expect(parsed.expectedGenesis).toBe(CLUSTER_GENESIS_HASHES.devnet);
    expect(parsed.rpcHost).toBe("rpc.example.test");
    expect(parsed.send).toBe(false);
    expect(parsed.rps).toBe(2);
    expect(parsed.deadlineMin).toBe(20);
    expect(parsed.stateDir).toBe(path.join(dir, ".mancipatio", "chain"));
  });

  it("CHAIN_NETWORK must equal NEXT_PUBLIC_NETWORK when that is set", () => {
    refuse(() => config("inventory", base({ NEXT_PUBLIC_NETWORK: "mainnet" })), /conflicts with NEXT_PUBLIC_NETWORK/);
    expect(config("inventory", base({ NEXT_PUBLIC_NETWORK: "devnet" })).network).toBe("devnet");
  });

  it("mainnet needs CHAIN_ALLOW_MAINNET=1, a Release for non-inventory tools and a CU price to send", () => {
    const mainnet = { CHAIN_NETWORK: "mainnet" };
    refuse(() => config("inventory", base(mainnet)), /CHAIN_ALLOW_MAINNET=1/);
    expect(config("inventory", base({ ...mainnet, CHAIN_ALLOW_MAINNET: "1" })).expectedGenesis).toBe(CLUSTER_GENESIS_HASHES.mainnet);
    refuse(() => config("idl", base({ ...mainnet, CHAIN_ALLOW_MAINNET: "1" })), /CHAIN_RELEASE_DIR is required/);
    refuse(
      () =>
        config(
          "bootstrap",
          base({
            ...mainnet,
            CHAIN_ALLOW_MAINNET: "1",
            CHAIN_ROLE_MAP: "map.json",
            CHAIN_RELEASE_DIR: dir,
            CHAIN_SEND: "1",
            CHAIN_KEYPAIR: "k.json",
            CHAIN_CONFIRM_PLAN: "x",
          }),
        ),
      /CHAIN_CU_PRICE is required/,
    );
  });

  it("RPC URL: https only (http loopback on localnet), no userinfo, and never echoed", () => {
    const secret = "https://user:hunter2@rpc.example.test/";
    try {
      config("inventory", base({ CHAIN_RPC_URL: secret }));
      throw new Error("not refused");
    } catch (error) {
      expect((error as Error).message).toMatch(/userinfo/);
      expect((error as Error).message).not.toContain("hunter2");
    }
    refuse(() => config("inventory", base({ CHAIN_RPC_URL: "http://rpc.example.test/" })), /must use https/);
    refuse(() => config("inventory", base({ CHAIN_RPC_URL: "http://127.0.0.1:8899" })), /must use https/);
    const localGenesis = "4sGjMW1sUnHzSxGspuhpqLDx6wiyjNtZAMdL4VZHirAn";
    expect(
      config("inventory", base({ CHAIN_NETWORK: "localnet", CHAIN_RPC_URL: "http://127.0.0.1:8899", CHAIN_GENESIS_HASH: localGenesis })).expectedGenesis,
    ).toBe(localGenesis);
  });

  it("localnet requires its own genesis; other networks refuse a conflicting one", () => {
    refuse(() => config("inventory", base({ CHAIN_NETWORK: "localnet" })), /CHAIN_GENESIS_HASH is required on localnet/);
    refuse(
      () => config("inventory", base({ CHAIN_NETWORK: "localnet", CHAIN_GENESIS_HASH: CLUSTER_GENESIS_HASHES.devnet })),
      /not a public cluster/,
    );
    refuse(() => config("inventory", base({ CHAIN_GENESIS_HASH: CLUSTER_GENESIS_HASHES.mainnet })), /conflicts with the devnet genesis/);
  });

  it("send mode needs the keypair and the reviewed digest; read-only tools refuse it", () => {
    refuse(() => config("bootstrap", base({ CHAIN_ROLE_MAP: "m.json", CHAIN_SEND: "1" })), /CHAIN_SEND=1, CHAIN_KEYPAIR and CHAIN_CONFIRM_PLAN/);
    refuse(() => config("inventory", base({ CHAIN_SEND: "1", CHAIN_KEYPAIR: "k", CHAIN_CONFIRM_PLAN: "d" })), /never sends/);
    refuse(() => config("squads-export", base({ CHAIN_ROLE_MAP: "m", CHAIN_SEND: "1" })), /never sends/);
    refuse(() => config("bootstrap", base({ CHAIN_ROLE_MAP: "m.json", CHAIN_KEYPAIR: "k.json" })), /only read in send mode/);
    refuse(() => config("bootstrap", base()), /CHAIN_ROLE_MAP is required/);
  });

  it("caps CHAIN_CU_PRICE, CHAIN_RPS and CHAIN_DEADLINE_MIN", () => {
    refuse(() => config("inventory", base({ CHAIN_CU_PRICE: "2000001" })), /capped at 2,000,000/);
    expect(config("inventory", base({ CHAIN_CU_PRICE: "2000000" })).cuPrice).toBe(BigInt(2_000_000));
    refuse(() => config("inventory", base({ CHAIN_RPS: "21" })), /CHAIN_RPS/);
    refuse(() => config("inventory", base({ CHAIN_RPS: "0" })), /CHAIN_RPS/);
    refuse(() => config("inventory", base({ CHAIN_DEADLINE_MIN: "300" })), /CHAIN_DEADLINE_MIN/);
  });

  it("rehearsal signers are refused on mainnet (and testnet)", () => {
    refuse(
      () =>
        config(
          "inventory",
          base({ CHAIN_NETWORK: "mainnet", CHAIN_ALLOW_MAINNET: "1", CHAIN_REHEARSAL_SIGNERS: "superAdmin=/tmp/sa.json" }),
        ),
      /localnet and devnet only/,
    );
    refuse(() => config("inventory", base({ CHAIN_NETWORK: "testnet", CHAIN_REHEARSAL_SIGNERS: "superAdmin=/x" })), /localnet and devnet only/);
    expect(config("inventory", base({ CHAIN_REHEARSAL_SIGNERS: "superAdmin=/a.json,kycAuthority=/b.json" })).rehearsalSigners).toEqual({
      superAdmin: "/a.json",
      kycAuthority: "/b.json",
    });
    refuse(() => config("inventory", base({ CHAIN_REHEARSAL_SIGNERS: "deployer=/a.json" })), /role=keypair pairs/);
  });
});

describe("output-path guard", () => {
  it("refuses to overwrite an existing file", () => {
    const file = fresh();
    fs.writeFileSync(file, "{}");
    refuse(() => assertOutputPath(file, root, "CHAIN_OUTPUT"), /already exists/);
  });

  it("refuses a path inside the repository that git does not ignore", () => {
    refuse(() => assertOutputPath(path.join(root, "front", "chain-evidence-test.json"), root, "CHAIN_OUTPUT"), /not git-ignored/);
    // docs/ is git-ignored: allowed. Outside the repository: allowed.
    expect(() => assertOutputPath(path.join(root, "docs", "chain-evidence-test.json"), root, "CHAIN_OUTPUT")).not.toThrow();
    expect(() => assertOutputPath(fresh(), root, "CHAIN_OUTPUT")).not.toThrow();
  });
});

describe("hot signer", () => {
  it("loads the expected key and refuses another one without leaking the path or bytes", async () => {
    const pair = writeKeypair(dir, "deployer");
    const signer = await loadHotSigner(pair.path, pair.address, "deployer");
    expect(signer.address).toBe(pair.address);
    const bytes = JSON.parse(fs.readFileSync(pair.path, "utf8")) as number[];
    try {
      await loadHotSigner(pair.path, key(5), "deployer");
      throw new Error("not refused");
    } catch (error) {
      const message = (error as Error).message;
      expect(error).toBeInstanceOf(ChainGateError);
      expect(message).toMatch(/not the expected key/);
      expect(message).not.toContain(pair.path);
      expect(message).not.toContain(path.basename(pair.path));
      expect(message).not.toContain(bytes.slice(0, 8).join(","));
    }
    const broken = path.join(dir, "broken.json");
    fs.writeFileSync(broken, "[1,2,3]");
    await expect(loadHotSigner(broken, key(5), "deployer")).rejects.toThrow(/not a 64-byte keypair \(path withheld\)/);
    await expect(loadHotSigner(path.join(dir, "missing.json"), key(5), "deployer")).rejects.toThrow(/unreadable \(path withheld\)/);
  });
});

describe("fetch guard", () => {
  let restore: (() => void) | null = null;
  afterEach(() => restore?.());

  it("only the RPC origin and path are reachable; restore puts fetch back", async () => {
    const original = globalThis.fetch;
    restore = installFetchGuard("https://rpc.example.test/key-in-path");
    await expect(fetch("https://evil.example/")).rejects.toThrow(/only the configured RPC endpoint/);
    await expect(fetch("https://rpc.example.test/other-path")).rejects.toThrow(/only the configured RPC endpoint/);
    restore();
    restore = null;
    expect(globalThis.fetch).toBe(original);
  });
});

describe("source-integrity paths", () => {
  it("cover every module the chain lib imports outside scripts/chain, and the dependency pins", () => {
    const libDir = path.join(root, "front", "scripts", "chain");
    const files = fs.readdirSync(libDir, { recursive: true }).map(String).filter((f) => f.endsWith(".ts"));
    const imported = new Set<string>();
    for (const file of files) {
      const text = fs.readFileSync(path.join(libDir, file), "utf8");
      for (const match of text.matchAll(/from "@\/([^"]+)"/g)) imported.add(`front/${match[1]}`);
    }
    for (const target of imported) {
      expect(SOURCE_INTEGRITY_PATHS.some((p) => target === p || target.startsWith(`${p}/`)), target).toBe(true);
    }
    expect(SOURCE_INTEGRITY_PATHS).toEqual(expect.arrayContaining(["front/package.json", "front/package-lock.json"]));
  });
});

describe("release-source guard (mainnet, C10)", () => {
  const idl = { asset_registry: new Uint8Array([1, 2]), transfer_hook: new Uint8Array([3]) };

  it("refuses IDL bytes that differ from the Release, and a dirty source tree", () => {
    refuse(
      () =>
        assertReleaseSource({
          network: "mainnet",
          root,
          localIdl: idl,
          releaseIdl: { ...idl, transfer_hook: new Uint8Array([4]) },
          dirty: [],
        }),
      /front\/idl\/transfer_hook.json differs from the Release IDL/,
    );
    refuse(
      () => assertReleaseSource({ network: "mainnet", root, localIdl: idl, releaseIdl: idl, dirty: [" M front/lib/passport.ts"] }),
      /uncommitted changes/,
    );
    refuse(() => assertReleaseSource({ network: "mainnet", root, localIdl: idl, releaseIdl: null, dirty: [] }), /no IDL files/);
    expect(() => assertReleaseSource({ network: "mainnet", root, localIdl: idl, releaseIdl: idl, dirty: [] })).not.toThrow();
    // Off mainnet it is not enforced.
    expect(() => assertReleaseSource({ network: "devnet", root, localIdl: idl, releaseIdl: null, dirty: ["x"] })).not.toThrow();
  });
});
