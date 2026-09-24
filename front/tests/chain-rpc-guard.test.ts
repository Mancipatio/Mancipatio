import {
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
  SolanaError,
  type Address,
  type RpcTransport,
} from "@solana/kit";
import { afterEach, describe, expect, it } from "vitest";
import { CLUSTER_GENESIS_HASHES, NetworkIdentityError } from "@/lib/network-identity";
import { createChainRpc } from "@/scripts/chain/lib/rpc";
import { ChainAbortError, ChainGateError, ChainRpcError, readChainConfig, repoRoot } from "@/scripts/chain/lib/safety";
import { FakeChain, key, tempDir } from "./helpers/chain-fake";

const fastSleep = async () => {};
function clients(chain: FakeChain, mode: "read" | "send" = "read", extra: Partial<Parameters<typeof createChainRpc>[0]> = {}) {
  return createChainRpc({
    url: "https://rpc.example.test/SECRET-API-KEY",
    network: "devnet",
    expectedGenesis: CLUSTER_GENESIS_HASHES.devnet,
    mode,
    rps: Infinity,
    transport: chain.transport,
    sleep: fastSleep,
    retryDelayMs: 0,
    genesisCacheMs: 0,
    ...extra,
  });
}

describe("RPC guard", () => {
  const saved = process.env.NEXT_PUBLIC_SOLANA_GENESIS_HASH;
  afterEach(() => {
    if (saved === undefined) delete process.env.NEXT_PUBLIC_SOLANA_GENESIS_HASH;
    else process.env.NEXT_PUBLIC_SOLANA_GENESIS_HASH = saved;
  });

  it("a genesis mismatch aborts before any other method is called", async () => {
    const chain = new FakeChain();
    chain.genesis = CLUSTER_GENESIS_HASHES.mainnet;
    const { rpc } = clients(chain);
    await expect(rpc.getBalance(key(1)).send()).rejects.toBeInstanceOf(NetworkIdentityError);
    expect(chain.calls).toEqual(["getGenesisHash"]);
  });

  it("verifies the genesis before every call when the cache is off", async () => {
    const chain = new FakeChain();
    const { rpc } = clients(chain);
    await rpc.getSlot().send();
    await rpc.getSlot().send();
    expect(chain.calls).toEqual(["getGenesisHash", "getSlot", "getGenesisHash", "getSlot"]);
  });

  it("a dry run (read mode) refuses sendTransaction; send mode allows it", async () => {
    const chain = new FakeChain();
    const read = clients(chain).rpc;
    await expect(read.sendTransaction("AA==" as never, { encoding: "base64" }).send()).rejects.toThrow(ChainGateError);
    await expect(read.sendTransaction("AA==" as never, { encoding: "base64" }).send()).rejects.toThrow(/not allowed in read mode/);
    expect(chain.calls.filter((m) => m === "sendTransaction")).toEqual([]);
    const send = clients(chain, "send").rpc;
    // Allowed by the guard (the fake then fails to decode the bogus bytes).
    await expect(send.sendTransaction("AA==" as never, { encoding: "base64" }).send()).rejects.toThrow(ChainRpcError);
    expect(chain.calls).toContain("sendTransaction");
  });

  it("refuses methods outside the allowlist", async () => {
    const chain = new FakeChain();
    const { rpc } = clients(chain);
    await expect(rpc.requestAirdrop(key(1), BigInt(1) as never).send()).rejects.toThrow(/requestAirdrop is not allowed/);
  });

  it("JSON-RPC errors never carry the provider text or the URL", async () => {
    const chain = new FakeChain();
    chain.failMethods.add("getAccountInfo");
    const { rpc } = clients(chain);
    try {
      await rpc.getAccountInfo(key(1) as Address).send();
      throw new Error("not refused");
    } catch (error) {
      expect(error).toBeInstanceOf(ChainRpcError);
      const message = (error as Error).message;
      expect(message).toBe("RPC getAccountInfo failed; details withheld");
      expect(message).not.toMatch(/secret|SECRET|api-key|example/);
      expect(JSON.stringify(error)).not.toMatch(/secret|SECRET/);
    }
  });

  it("retries reads 3 times on 429/5xx, never retries sendTransaction", async () => {
    const chain = new FakeChain();
    let failures = 2;
    const flaky: RpcTransport = (async (config: Parameters<RpcTransport>[0]) => {
      const method = (config.payload as { method: string }).method;
      if (method === "getSlot" && failures-- > 0) {
        throw new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, {
          headers: new Headers(),
          message: "Too Many Requests https://user:pw@x",
          statusCode: 429,
        });
      }
      return chain.transport(config);
    }) as RpcTransport;
    const { rpc, calls } = clients(chain, "read", { transport: flaky });
    expect(await rpc.getSlot().send()).toBe(BigInt(5000));
    expect(calls.filter((c) => c.method === "getSlot").map((c) => c.ok)).toEqual([false, false, true]);

    let sendAttempts = 0;
    const failingSend: RpcTransport = (async (config: Parameters<RpcTransport>[0]) => {
      if ((config.payload as { method: string }).method === "sendTransaction") {
        sendAttempts++;
        throw new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, { headers: new Headers(), message: "x", statusCode: 503 });
      }
      return chain.transport(config);
    }) as RpcTransport;
    const send = clients(chain, "send", { transport: failingSend }).rpc;
    await expect(send.sendTransaction("AA==" as never, { encoding: "base64" }).send()).rejects.toThrow(ChainRpcError);
    expect(sendAttempts).toBe(1);
  });

  it("NEXT_PUBLIC_SOLANA_GENESIS_HASH=evil has no effect: the CLI always passes the expected hash", async () => {
    process.env.NEXT_PUBLIC_SOLANA_GENESIS_HASH = "evil";
    const chain = new FakeChain();
    const { assertNetwork } = clients(chain);
    await expect(assertNetwork()).resolves.toBeUndefined();
    chain.genesis = "4sGjMW1sUnHzSxGspuhpqLDx6wiyjNtZAMdL4VZHirAn";
    const second = clients(chain);
    await expect(second.assertNetwork()).rejects.toBeInstanceOf(NetworkIdentityError);
  });

  it("the run's abort signal reaches every call; the drain client keeps working", async () => {
    const chain = new FakeChain();
    const controller = new AbortController();
    const { rpc, drainRpc } = clients(chain, "read", { signal: controller.signal });
    controller.abort();
    await expect(rpc.getSlot().send()).rejects.toBeInstanceOf(ChainAbortError);
    expect(await drainRpc.getSlot().send()).toBe(BigInt(5000));
  });

  it("a per-call signal (a caller's timeout) is an RPC failure of that call, not an abort of the run", async () => {
    const chain = new FakeChain();
    const run = new AbortController();
    const { rpc, drainRpc } = clients(chain, "read", { signal: run.signal });
    await rpc.getSlot().send(); // proves the genesis first
    const before = new AbortController();
    before.abort();
    await expect(rpc.getSlot().send({ abortSignal: before.signal })).rejects.toBeInstanceOf(ChainRpcError);
    await expect(drainRpc.getSlot().send({ abortSignal: before.signal })).rejects.toBeInstanceOf(ChainRpcError);

    // Aborted mid-request: the transport rejects once the call's signal fires.
    const hanging: RpcTransport = async <T>(config: Parameters<RpcTransport>[0]): Promise<T> => {
      const method = (config.payload as { method: string }).method;
      if (method === "getGenesisHash") return chain.transport<T>(config);
      return new Promise<T>((_, reject) => config.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    };
    const slow = createChainRpc({
      url: "https://rpc.example.test/",
      network: "devnet",
      expectedGenesis: CLUSTER_GENESIS_HASHES.devnet,
      mode: "read",
      rps: Infinity,
      transport: hanging,
      sleep: fastSleep,
      retryDelayMs: 0,
      signal: run.signal,
    });
    const call = new AbortController();
    const pending = slow.rpc.getSlot().send({ abortSignal: call.signal });
    setTimeout(() => call.abort(), 5);
    await expect(pending).rejects.toSatisfy((e) => e instanceof ChainRpcError && !(e instanceof ChainAbortError));

    // The run's own signal stays an abort, even with a per-call signal present.
    const stuck = slow.rpc.getSlot().send({ abortSignal: new AbortController().signal });
    setTimeout(() => run.abort(), 5);
    await expect(stuck).rejects.toBeInstanceOf(ChainAbortError);
  });

  it("mainnet needs the explicit flag before any RPC exists", () => {
    const dir = tempDir();
    expect(() =>
      readChainConfig(
        "inventory",
        { CHAIN_NETWORK: "mainnet", CHAIN_RPC_URL: "https://rpc.example.test/", CHAIN_OUTPUT: `${dir}/e.json` },
        { root: repoRoot(), home: dir },
      ),
    ).toThrow(/CHAIN_ALLOW_MAINNET=1/);
  });
});
