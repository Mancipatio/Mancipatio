import { afterEach, describe, expect, it, vi } from "vitest";
import type { GetGenesisHashApi, Rpc } from "@solana/kit";
import type { SolanaClient } from "@solana/client";
import {
  CLUSTER_GENESIS_HASHES,
  createNetworkVerifiedRpc,
  createNetworkVerifier,
  expectedGenesisHash,
} from "@/lib/network-identity";
import { detectNetwork } from "@/lib/network";
import { withVerifiedTransactions } from "@/lib/verified-solana-client";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function genesisRpc(value: string | Error) {
  const send = vi.fn(async () => {
    if (value instanceof Error) throw value;
    return value;
  });
  return {
    rpc: {
      getGenesisHash: () => ({ send }),
    } as unknown as Rpc<GetGenesisHashApi>,
    send,
  };
}

describe("network identity", () => {
  it("rejects an unknown explicit network instead of selecting devnet", () => {
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "mainent");
    expect(detectNetwork).toThrow("Invalid NEXT_PUBLIC_NETWORK");
  });

  it("pins public clusters and requires an explicit independent localnet hash", () => {
    expect(expectedGenesisHash("mainnet")).toBe(CLUSTER_GENESIS_HASHES.mainnet);
    expect(() =>
      expectedGenesisHash("mainnet", CLUSTER_GENESIS_HASHES.devnet),
    ).toThrow("conflicts");
    expect(() => expectedGenesisHash("localnet", "")).toThrow(
      "Localnet requires",
    );
    expect(() =>
      expectedGenesisHash("localnet", CLUSTER_GENESIS_HASHES.devnet),
    ).toThrow("Localnet requires");
    expect(
      expectedGenesisHash("localnet", "11111111111111111111111111111111"),
    ).toBe("11111111111111111111111111111111");
  });

  it("rejects mismatches and sanitizes transport errors", async () => {
    await expect(
      createNetworkVerifier(
        genesisRpc(CLUSTER_GENESIS_HASHES.devnet).rpc,
        "mainnet",
      )(),
    ).rejects.toThrow("Expected mainnet");
    const verify = createNetworkVerifier(
      genesisRpc(new Error("https://rpc.invalid/?api-key=secret")).rpc,
      "devnet",
    );
    await expect(verify()).rejects.toThrow("Cannot verify the Solana network");
    await expect(verify()).rejects.not.toThrow("api-key");
  });

  it("coalesces concurrent checks but does not cache failed verification", async () => {
    const { rpc, send } = genesisRpc(CLUSTER_GENESIS_HASHES.devnet);
    send.mockRejectedValueOnce(new Error("offline"));
    const verify = createNetworkVerifier(rpc, "devnet", { cacheMs: 30_000 });
    const failed = await Promise.allSettled([verify(), verify()]);
    expect(failed.every((r) => r.status === "rejected")).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    await Promise.all([verify(), verify()]);
    expect(send).toHaveBeenCalledTimes(2);
    await verify();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("gates actual server RPC account reads before authorization data is returned", async () => {
    const methods: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        methods.push(body.method);
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result:
              body.method === "getGenesisHash"
                ? CLUSTER_GENESIS_HASHES.devnet
                : { context: { slot: 1 }, value: null },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
    const rpc = createNetworkVerifiedRpc("https://rpc.invalid", "mainnet");
    await expect(
      rpc
        .getAccountInfo(
          "11111111111111111111111111111111" as Parameters<
            typeof rpc.getAccountInfo
          >[0],
        )
        .send(),
    ).rejects.toThrow("Expected mainnet");
    expect(methods).toEqual(["getGenesisHash"]);
    const valid = createNetworkVerifiedRpc("https://rpc.invalid", "devnet");
    await valid
      .getAccountInfo(
        "11111111111111111111111111111111" as Parameters<
          typeof valid.getAccountInfo
        >[0],
      )
      .send();
    expect(methods).toEqual([
      "getGenesisHash",
      "getGenesisHash",
      "getAccountInfo",
    ]);
  });
});

describe("transaction helper boundary", () => {
  function clientFor(hash: string) {
    const { rpc, send } = genesisRpc(hash);
    const transaction = {
      prepare: vi.fn(),
      sign: vi.fn(),
      toWire: vi.fn(),
      send: vi.fn(),
      prepareAndSend: vi.fn(),
    };
    const client = {
      runtime: { rpc },
      transaction,
      helpers: { transaction },
    } as unknown as SolanaClient;
    return {
      guarded: withVerifiedTransactions(client, "devnet"),
      transaction,
      send,
    };
  }

  it.each(["prepare", "sign", "toWire", "send", "prepareAndSend"] as const)(
    "blocks %s before the wallet/helper is invoked on the wrong cluster",
    async (method) => {
      const { guarded, transaction } = clientFor(
        CLUSTER_GENESIS_HASHES.mainnet,
      );
      const call = guarded.transaction[method] as (
        input: unknown,
      ) => Promise<unknown>;
      await expect(call({})).rejects.toThrow("Expected devnet");
      expect(transaction[method]).not.toHaveBeenCalled();
      expect(guarded.helpers.transaction).toBe(guarded.transaction);
    },
  );

  it("rechecks the network for every transaction attempt, including prepared sends", async () => {
    const { guarded, transaction, send } = clientFor(
      CLUSTER_GENESIS_HASHES.devnet,
    );
    await guarded.transaction.prepareAndSend({ instructions: [] });
    await guarded.transaction.send(
      {} as Parameters<typeof guarded.transaction.send>[0],
    );
    expect(transaction.prepareAndSend).toHaveBeenCalledOnce();
    expect(transaction.send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledTimes(2);
  });
});
