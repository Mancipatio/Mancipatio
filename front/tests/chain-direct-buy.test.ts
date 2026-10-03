// chain:direct-buy (T1): the DEVNET-ONLY test tool that buys from an Open
// sale by calling the program directly with a test key — no sign-in, no
// Terms — so the off-platform buy alarm (#58) can be verified. It must never
// run beyond devnet, must default to a dry run, must send only the reviewed
// plan with the typed-out key, and must build the sale page's own
// instructions (lib/purchase-builder).
import fs from "node:fs";
import path from "node:path";
import { address, getAddressDecoder, getAddressEncoder, type Address } from "@solana/kit";
import { getMintEncoder } from "@solana-program/token-2022";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fixtures = vi.hoisted(() => ({ share: null as unknown, asset: null as unknown, issuer: null as unknown }));
vi.mock("@/lib/generated/asset_registry", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  // The share class, asset and issuer the builder verifies (the sale itself is read from the fake cluster).
  fetchMaybeShareClass: async () => fixtures.share,
  fetchMaybeAsset: async () => fixtures.asset,
  fetchMaybeIssuer: async () => fixtures.issuer,
}));

import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  BUY_DISCRIMINATOR,
  KybStatus,
  RaiseType,
  SaleStatus,
  getSaleEncoder,
} from "@/lib/generated/asset_registry";
import { MEMO_PROGRAM_ADDRESS } from "@/lib/document-terms";
import { findSalePda } from "@/lib/pdas";
import { TOKEN_CLASSIC } from "@/lib/transaction-builders";
import { runTool } from "@/scripts/chain/lib/context";
import { directBuyTool, readDirectBuyRequest } from "@/scripts/chain/lib/direct-buy";
import { readChainConfig, repoRoot, type ChainEnv } from "@/scripts/chain/lib/safety";
import { FakeChain, instantTiming, tempDir, writeKeypair, type TestKeypair } from "./helpers/chain-fake";

const root = repoRoot();
const key = (n: number) => getAddressDecoder().decode(new Uint8Array(32).fill(n));
const SHARE_CLASS = key(2);
const MINT = key(3);
const PAYMENT = key(4);
const ASSET = key(6);
const ISSUER = key(7);
const SOL = BigInt(1_000_000_000);

type Setup = { chain: FakeChain; dir: string; buyer: TestKeypair; sale: Address; outputs: number };

async function setup(over: { status?: SaleStatus; sold?: bigint } = {}): Promise<Setup> {
  const chain = new FakeChain();
  const dir = tempDir("direct-buy-");
  const buyer = writeKeypair(dir, "buyer");
  const sale = await findSalePda(SHARE_CLASS, BigInt(4));
  const data = getSaleEncoder().encode({
    shareClass: SHARE_CLASS, mint: MINT, paymentMint: PAYMENT, proceeds: key(5), authority: key(8), saleId: 4,
    pricePerUnit: 1_000_000, totalForSale: 100, sold: over.sold ?? 10, startTs: 0, endTs: 0, status: over.status ?? SaleStatus.Open,
    raiseType: RaiseType.Mature, cliffMonths: 0, vestingMonths: 0, version: 1, bump: 255, saleApproval: key(9),
    applicationHash: new Uint8Array(32),
  });
  chain.set(sale, { owner: ASSET_REGISTRY_PROGRAM_ADDRESS, lamports: SOL, data: new Uint8Array(data) });
  const mint = getMintEncoder().encode({ mintAuthority: key(10), supply: BigInt(10), decimals: 6, isInitialized: true, freezeAuthority: null, extensions: null });
  chain.set(PAYMENT, { owner: TOKEN_CLASSIC, lamports: SOL, data: new Uint8Array(mint) });
  chain.fund(buyer.address, SOL);
  // The fake cannot run Token-2022 or the registry: simulations answer ok, sends land.
  chain.simulateOverride = () => ({ err: null, logs: ["Program log: ok"] });
  return { chain, dir, buyer, sale, outputs: 0 };
}

function env(s: Setup, extra: ChainEnv = {}): ChainEnv {
  return {
    CHAIN_NETWORK: "devnet",
    CHAIN_RPC_URL: "https://rpc.example.test/",
    CHAIN_OUTPUT: path.join(s.dir, `evidence-${++s.outputs}.json`),
    CHAIN_STATE_DIR: path.join(s.dir, "state"),
    CHAIN_BUY_SALE: s.sale,
    CHAIN_BUY_UNITS: "3",
    CHAIN_BUY_BUYER: s.buyer.address,
    ...extra,
  };
}

const deps = (s: Setup, lines: string[] = []) => ({
  transport: s.chain.transport, rps: Infinity, timing: instantTiming(), root, log: (line: string) => lines.push(line),
});

beforeEach(() => {
  fixtures.share = { exists: true, programAddress: ASSET_REGISTRY_PROGRAM_ADDRESS, data: { mint: MINT, asset: ASSET } };
  fixtures.asset = { exists: true, programAddress: ASSET_REGISTRY_PROGRAM_ADDRESS, data: { issuer: ISSUER } };
  fixtures.issuer = { exists: true, programAddress: ASSET_REGISTRY_PROGRAM_ADDRESS, data: { kybStatus: KybStatus.Verified } };
});

describe("chain:direct-buy gates", () => {
  const base = { CHAIN_RPC_URL: "https://rpc.example.test/", CHAIN_OUTPUT: path.join(tempDir(), "e.json") };
  const config = (extra: ChainEnv) => readChainConfig("direct-buy", { ...base, ...extra }, { root });

  it("runs on devnet only: mainnet is refused hard, even with CHAIN_ALLOW_MAINNET=1; testnet and localnet too", () => {
    expect(config({ CHAIN_NETWORK: "devnet" }).network).toBe("devnet");
    expect(() => config({ CHAIN_NETWORK: "mainnet", CHAIN_ALLOW_MAINNET: "1" })).toThrow(/devnet test tool: it runs on devnet only, never on mainnet/);
    expect(() => config({ CHAIN_NETWORK: "mainnet" })).toThrow(/never on mainnet/);
    expect(() => config({ CHAIN_NETWORK: "testnet" })).toThrow(/never on testnet/);
    expect(() => config({ CHAIN_NETWORK: "localnet", CHAIN_GENESIS_HASH: "x" })).toThrow(/never on localnet/);
    // A devnet tool cannot be pointed at mainnet through the app's own network variable either.
    expect(() => config({ CHAIN_NETWORK: "devnet", NEXT_PUBLIC_NETWORK: "mainnet" })).toThrow(/conflicts with NEXT_PUBLIC_NETWORK/);
  });

  it("is a dry run by default; a send needs CHAIN_SEND=1, the key and the reviewed digest", () => {
    expect(config({ CHAIN_NETWORK: "devnet" }).send).toBe(false);
    expect(() => config({ CHAIN_NETWORK: "devnet", CHAIN_KEYPAIR: "k.json" })).toThrow(/only read in send mode/);
    expect(() => config({ CHAIN_NETWORK: "devnet", CHAIN_SEND: "1", CHAIN_KEYPAIR: "k.json" })).toThrow(/CHAIN_CONFIRM_PLAN/);
    expect(() => config({ CHAIN_NETWORK: "devnet", CHAIN_SEND: "1", CHAIN_CONFIRM_PLAN: "d" })).toThrow(/CHAIN_KEYPAIR/);
    expect(() => config({ CHAIN_NETWORK: "devnet", CHAIN_SIGNER: "usb://ledger" })).toThrow(/chain:emergency and chain:accept only/);
  });

  it("parses the sale, the units and the typed-out buyer", () => {
    const sale = key(11);
    const buyer = key(12);
    expect(readDirectBuyRequest({ CHAIN_BUY_SALE: sale, CHAIN_BUY_UNITS: "25", CHAIN_BUY_BUYER: buyer })).toEqual({ sale, units: BigInt(25), buyer, termsFile: null });
    expect(() => readDirectBuyRequest({ CHAIN_BUY_UNITS: "1", CHAIN_BUY_BUYER: buyer })).toThrow(/CHAIN_BUY_SALE/);
    for (const units of ["0", "-1", "1.5", "abc", "18446744073709551616", ""]) {
      expect(() => readDirectBuyRequest({ CHAIN_BUY_SALE: sale, CHAIN_BUY_UNITS: units, CHAIN_BUY_BUYER: buyer })).toThrow(/CHAIN_BUY_UNITS/);
    }
    expect(() => readDirectBuyRequest({ CHAIN_BUY_SALE: sale, CHAIN_BUY_UNITS: "1", CHAIN_BUY_BUYER: "11111111111111111111111111111111" })).toThrow(/CHAIN_BUY_BUYER/);
    expect(readDirectBuyRequest({ CHAIN_BUY_SALE: sale, CHAIN_BUY_UNITS: "1", CHAIN_BUY_BUYER: buyer, CHAIN_BUY_TERMS: "t.json" }).termsFile).toBe("t.json");
  });

  it("package.json exposes chain:direct-buy on its own runner config", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "front", "package.json"), "utf8"));
    expect(pkg.scripts["chain:direct-buy"]).toBe("vitest run --config scripts/chain/direct-buy.config.ts --reporter=verbose");
  });
});

describe("chain:direct-buy dry run and send", () => {
  it("dry run: probes the sale, builds the site's buy, simulates, prints the digest and sends nothing", async () => {
    const s = await setup();
    const lines: string[] = [];
    const evidence = await runTool("direct-buy", env(s), directBuyTool, deps(s, lines));
    expect(evidence.error ?? null).toBeNull();
    expect(evidence.status).toBe("awaiting");
    expect(evidence.mode).toBe("dry-run");
    expect(evidence.request).toEqual({ sale: s.sale, units: "3", buyer: s.buyer.address, documentMemo: false });
    expect(evidence.sale).toMatchObject({ shareClass: SHARE_CLASS, paymentMint: PAYMENT, remaining: "90", costBaseUnits: "3000000" });
    expect(evidence.planDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(evidence.plan).toEqual([{ id: "buy", title: "buy 3 units directly (no site, no Terms)", preconditions: ["the sale is Open", "at least 3 units remain"] }]);
    expect(evidence.simulation).toEqual({ buy: expect.stringMatching(/^simulated ok/) });
    expect(s.chain.calls).toContain("simulateTransaction");
    expect(s.chain.sends).toEqual([]);
    expect(s.chain.calls).not.toContain("sendTransaction");
    expect(lines.join("\n")).toMatch(/dry run: nothing sent/);
    // A failing simulation (no payment tokens) stops the dry run with the reason.
    s.chain.simulateOverride = () => ({ err: { InstructionError: [3, { Custom: 1 }] }, logs: ["Program log: insufficient funds"] });
    const failed = await runTool("direct-buy", env(s), directBuyTool, deps(s));
    expect(failed.status).toBe("failed");
    expect(failed.error).toMatch(/failed simulation \(does the test key hold SOL and 3000000 base units of the payment mint\?\)/);
  });

  it("refuses a closed sale, too few units left, and an account that is not the sale", async () => {
    const closed = await setup({ status: SaleStatus.Closed });
    expect((await runTool("direct-buy", env(closed), directBuyTool, deps(closed))).error).toBe("The sale is not Open");
    const full = await setup({ sold: BigInt(99) });
    expect((await runTool("direct-buy", env(full), directBuyTool, deps(full))).error).toBe("Only 1 units remain in this sale");
    const s = await setup();
    expect((await runTool("direct-buy", env(s, { CHAIN_BUY_SALE: key(30) }), directBuyTool, deps(s))).error).toBe("No sale account at CHAIN_BUY_SALE on devnet");
  });

  it("send: the reviewed digest and the typed-out key only; journals, sends the site's buy, waits for finalized", async () => {
    const s = await setup();
    const plan = await runTool("direct-buy", env(s), directBuyTool, deps(s));
    const digest = plan.planDigest as string;
    // A wrong digest or another key is refused before anything is sent.
    expect((await runTool("direct-buy", env(s, { CHAIN_SEND: "1", CHAIN_CONFIRM_PLAN: "0".repeat(64), CHAIN_KEYPAIR: s.buyer.path }), directBuyTool, deps(s))).error)
      .toMatch(/CHAIN_CONFIRM_PLAN does not match/);
    const other = writeKeypair(s.dir, "other");
    expect((await runTool("direct-buy", env(s, { CHAIN_SEND: "1", CHAIN_CONFIRM_PLAN: digest, CHAIN_KEYPAIR: other.path }), directBuyTool, deps(s))).error)
      .toMatch(/test buyer keypair is not the expected key/);
    expect(s.chain.sends).toEqual([]);
    // The send (the fake lands every transaction).
    s.chain.execute = () => ({ err: null });
    const sent = await runTool("direct-buy", env(s, { CHAIN_SEND: "1", CHAIN_CONFIRM_PLAN: digest, CHAIN_KEYPAIR: s.buyer.path }), directBuyTool, deps(s));
    expect(sent.error ?? null).toBeNull();
    expect(sent.status).toBe("completed");
    expect(s.chain.sends).toHaveLength(1);
    expect(sent.buySignature).toBe(s.chain.sends[0].sig);
    expect(sent.steps).toEqual([expect.objectContaining({ id: "buy", status: "sent", outcome: "finalized", signerRole: "test buyer" })]);
    // The wire carries the program's `buy`, signed by the test key, and no memo without CHAIN_BUY_TERMS.
    const wire = Buffer.from(s.chain.sends[0].wire, "base64");
    expect(wire.includes(Buffer.from(BUY_DISCRIMINATOR))).toBe(true);
    expect(wire.includes(Buffer.from(getAddressEncoder().encode(s.buyer.address)))).toBe(true);
    expect(wire.includes(Buffer.from(getAddressEncoder().encode(address(MEMO_PROGRAM_ADDRESS))))).toBe(false);
    const journal = fs.readFileSync(path.join(s.dir, sent.journal as string), "utf8");
    expect(journal).toMatch(/"event":"plan"/);
    expect(journal).toMatch(/"event":"signed"/);
  });

  it("with CHAIN_BUY_TERMS the sale page's acceptance memo rides along; a terms file of another sale is refused", async () => {
    const s = await setup();
    const terms = {
      versionId: "10000000-0000-4000-8000-000000000001", sha256: "a".repeat(64), sale: s.sale, asset: ASSET,
      url: "https://devnet.manci.io/document", verifiedAt: "2026-10-01",
    };
    const file = path.join(s.dir, "terms.json");
    fs.writeFileSync(file, JSON.stringify({ ok: true, data: terms }));
    const evidence = await runTool("direct-buy", env(s, { CHAIN_BUY_TERMS: file }), directBuyTool, deps(s));
    expect(evidence.error ?? null).toBeNull();
    expect(evidence.request).toMatchObject({ documentMemo: true });
    const withMemo = evidence.planDigest;
    const bare = (await runTool("direct-buy", env(s), directBuyTool, deps(s))).planDigest;
    expect(withMemo).not.toBe(bare);
    fs.writeFileSync(file, JSON.stringify({ ...terms, sale: key(31) }));
    expect((await runTool("direct-buy", env(s, { CHAIN_BUY_TERMS: file }), directBuyTool, deps(s))).error).toBe("CHAIN_BUY_TERMS belongs to another sale");
    fs.writeFileSync(file, "{not json");
    expect((await runTool("direct-buy", env(s, { CHAIN_BUY_TERMS: file }), directBuyTool, deps(s))).error).toMatch(/not a readable JSON file \(path withheld\)/);
    // The memo program is the one the site uses.
    expect(MEMO_PROGRAM_ADDRESS).toBe(address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"));
  });
});
