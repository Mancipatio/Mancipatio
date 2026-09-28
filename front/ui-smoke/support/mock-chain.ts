// A deterministic JSON-RPC stand-in for the smoke (never a real cluster).
//
// The build under test points its browser RPC at a reserved `.invalid` host
// (ui-smoke/env.json); every request to it is answered here through
// page.route, from an in-memory account set a test fills with the generated
// encoders (support/chain-fixtures.ts). The PubSub endpoint is accepted and
// answers subscriptions, but never notifies. A method the mock does not know
// is answered with a JSON-RPC error and recorded in `unknownMethods`.
import type { Page, WebSocketRoute } from "@playwright/test";
export type SmokeNetwork = "localnet" | "mainnet";

export type MockAccount = {
  address: string;
  owner: string;
  data: Uint8Array;
  lamports?: bigint;
  executable?: boolean;
};

type JsonRpcRequest = { jsonrpc?: string; id?: unknown; method?: string; params?: unknown[] };
type Filter = { memcmp?: { offset: number; bytes: string; encoding?: string }; dataSize?: number };

const SLOT = 400_000_000;
const BLOCKHASH = "4sGjMW1sUnHzSxGspuhpqLDx6wiyjNtZAMdL4VZHirAn";
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Decode(text: string): Uint8Array {
  let value = BigInt(0);
  for (const char of text) {
    const digit = BASE58.indexOf(char);
    if (digit < 0) throw new Error(`not base58: ${text}`);
    value = value * BigInt(58) + BigInt(digit);
  }
  const bytes: number[] = [];
  while (value > BigInt(0)) {
    bytes.unshift(Number(value % BigInt(256)));
    value /= BigInt(256);
  }
  for (const char of text) {
    if (char !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

function context() {
  return { context: { slot: SLOT, apiVersion: "4.0.0" } };
}

export class MockChain {
  readonly accounts = new Map<string, MockAccount>();
  readonly methods: string[] = [];
  /** Every address read with getAccountInfo / getMultipleAccounts. */
  readonly reads = new Set<string>();
  readonly unknownMethods = new Set<string>();

  /** `genesisHash`: what getGenesisHash answers (the build's network identity). */
  constructor(readonly genesisHash: string) {}

  set(...accounts: MockAccount[]) {
    for (const account of accounts) this.accounts.set(account.address, account);
  }

  private encode(account: MockAccount | undefined) {
    if (!account) return null;
    return {
      data: [Buffer.from(account.data).toString("base64"), "base64"],
      executable: account.executable ?? false,
      lamports: Number(account.lamports ?? BigInt(10_000_000)),
      owner: account.owner,
      rentEpoch: 0,
      space: account.data.length,
    };
  }

  private matches(account: MockAccount, filters: Filter[] | undefined): boolean {
    for (const filter of filters ?? []) {
      if (filter.dataSize !== undefined && account.data.length !== filter.dataSize) return false;
      if (filter.memcmp) {
        const { offset, bytes, encoding } = filter.memcmp;
        const want = encoding === "base64" ? Buffer.from(bytes, "base64") : base58Decode(bytes);
        const have = account.data.subarray(offset, offset + want.length);
        if (have.length !== want.length || !Buffer.from(have).equals(Buffer.from(want))) return false;
      }
    }
    return true;
  }

  private result(method: string, params: unknown[]): unknown {
    const config = (params.at(-1) ?? {}) as { withContext?: boolean; filters?: Filter[] };
    switch (method) {
      case "getGenesisHash":
        return this.genesisHash;
      case "getAccountInfo":
        this.reads.add(params[0] as string);
        return { ...context(), value: this.encode(this.accounts.get(params[0] as string)) };
      case "getMultipleAccounts":
        (params[0] as string[]).forEach((a) => this.reads.add(a));
        return { ...context(), value: (params[0] as string[]).map((a) => this.encode(this.accounts.get(a))) };
      case "getProgramAccounts": {
        const list = [...this.accounts.values()]
          .filter((a) => a.owner === params[0] && this.matches(a, config.filters))
          .map((a) => ({ pubkey: a.address, account: this.encode(a) }));
        return config.withContext ? { ...context(), value: list } : list;
      }
      case "getBalance":
        return { ...context(), value: 2_500_000_000 };
      case "getSlot":
      case "getBlockHeight":
        return SLOT;
      case "getEpochInfo":
        return { absoluteSlot: SLOT, blockHeight: SLOT, epoch: 900, slotIndex: 0, slotsInEpoch: 432_000, transactionCount: 0 };
      case "getLatestBlockhash":
        return { ...context(), value: { blockhash: BLOCKHASH, lastValidBlockHeight: SLOT + 150 } };
      case "getHealth":
        return "ok";
      case "getVersion":
        return { "solana-core": "4.0.0", "feature-set": 0 };
      case "getBlockTime":
        return Math.floor(Date.now() / 1000);
      case "getMinimumBalanceForRentExemption":
        return 1_000_000;
      case "getTokenAccountsByOwner":
      case "getTokenLargestAccounts":
        return { ...context(), value: [] };
      case "getSignaturesForAddress":
      case "getRecentPrioritizationFees":
        return [];
      case "getSignatureStatuses":
        return { ...context(), value: (params[0] as string[]).map(() => null) };
      default:
        return undefined;
    }
  }

  /** One JSON-RPC request or a batch. */
  handle(body: unknown): unknown {
    if (Array.isArray(body)) return body.map((one) => this.handle(one));
    const request = body as JsonRpcRequest;
    const method = String(request.method);
    this.methods.push(method);
    const result = this.result(method, request.params ?? []);
    if (result === undefined) {
      this.unknownMethods.add(method);
      return { jsonrpc: "2.0", id: request.id, error: { code: -32601, message: `ui-smoke mock RPC: ${method} is not mocked` } };
    }
    return { jsonrpc: "2.0", id: request.id, result };
  }

  /** Answers the build's RPC and PubSub endpoints on `page`. */
  async attach(page: Page, endpoints: { rpc: string; ws: string }) {
    await page.route(`${endpoints.rpc.replace(/\/$/, "")}/**`, async (route) => {
      const request = route.request();
      if (request.method() === "OPTIONS") {
        return route.fulfill({ status: 204, headers: cors() });
      }
      const body = request.postDataJSON() as unknown;
      await route.fulfill({ status: 200, contentType: "application/json", headers: cors(), body: JSON.stringify(this.handle(body)) });
    });
    let nextSubscription = 1;
    await page.routeWebSocket(new RegExp(`^${escape(endpoints.ws.replace(/\/$/, ""))}(/.*)?$`), (ws: WebSocketRoute) => {
      ws.onMessage((message) => {
        const request = JSON.parse(String(message)) as JsonRpcRequest;
        const method = String(request.method);
        this.methods.push(method);
        const result = method.endsWith("Unsubscribe") ? true : nextSubscription++;
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
      });
    });
  }
}

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

function escape(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
