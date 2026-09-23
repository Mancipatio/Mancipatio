// Network-derived UI helpers: explorer links, the WebSocket endpoint, the
// stage label and the indexing policy (robots.txt + robots meta) all follow
// NEXT_PUBLIC_NETWORK instead of a hardcoded "devnet".
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  explorerAddressUrl,
  explorerTxUrl,
  isTestNetwork,
  networkLabel,
  wsUrl,
} from "@/lib/network";
import { indexingAllowed } from "@/lib/indexing";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("explorer links", () => {
  it("carry ?cluster only off mainnet", () => {
    expect(explorerTxUrl("SIG", "mainnet")).toBe("https://explorer.solana.com/tx/SIG");
    expect(explorerAddressUrl("ADDR", "mainnet")).toBe(
      "https://explorer.solana.com/address/ADDR",
    );
    expect(explorerTxUrl("SIG", "devnet")).toBe(
      "https://explorer.solana.com/tx/SIG?cluster=devnet",
    );
    expect(explorerAddressUrl("ADDR", "testnet")).toBe(
      "https://explorer.solana.com/address/ADDR?cluster=testnet",
    );
    expect(explorerTxUrl("SIG", "localnet")).toBe(
      "https://explorer.solana.com/tx/SIG?cluster=custom",
    );
  });
});

describe("network copy helpers", () => {
  it("labels networks and flags the test ones", () => {
    expect(networkLabel("mainnet")).toBe("Mainnet");
    expect(networkLabel("devnet")).toBe("Devnet");
    expect(isTestNetwork("mainnet")).toBe(false);
    expect(isTestNetwork("devnet")).toBe(true);
    expect(isTestNetwork("testnet")).toBe(true);
    expect(isTestNetwork("localnet")).toBe(true);
  });

  it("derives the marketing stage badge from the build's network", async () => {
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "mainnet");
    const mainnet = await import("@/components/mx/nav");
    expect(mainnet.MX_STAGE_LABEL).toBe("Solana mainnet · v0.1");
    expect(mainnet.mxStageLabel("devnet")).toBe("Solana devnet · v0.1");

    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
    const devnet = await import("@/components/mx/nav");
    expect(devnet.MX_STAGE_LABEL).toBe("Solana devnet · v0.1");
  });
});

describe("wsUrl()", () => {
  it("prefers NEXT_PUBLIC_SOLANA_WS_URL", () => {
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "mainnet");
    vi.stubEnv("NEXT_PUBLIC_SOLANA_RPC_URL", "https://rpc.example.com/?key=1");
    vi.stubEnv("NEXT_PUBLIC_SOLANA_WS_URL", "wss://ws.example.com/?key=2");
    expect(wsUrl()).toBe("wss://ws.example.com/?key=2");
  });

  it("swaps only the scheme of the RPC URL", () => {
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "mainnet");
    vi.stubEnv("NEXT_PUBLIC_SOLANA_WS_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SOLANA_RPC_URL", "https://rpc.example.com/https://x");
    expect(wsUrl()).toBe("wss://rpc.example.com/https://x");
    vi.stubEnv("NEXT_PUBLIC_SOLANA_RPC_URL", "http://10.0.0.5:8899");
    expect(wsUrl()).toBe("ws://10.0.0.5:8899");
  });

  it("falls back to the network's public endpoint", () => {
    vi.stubEnv("NEXT_PUBLIC_SOLANA_WS_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SOLANA_RPC_URL", "");
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "mainnet");
    expect(wsUrl()).toBe("wss://api.mainnet-beta.solana.com");
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
    expect(wsUrl()).toBe("wss://api.devnet.solana.com");
    // solana-test-validator serves WebSockets on RPC port + 1.
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "localnet");
    expect(wsUrl()).toBe("ws://127.0.0.1:8900");
  });
});

describe("indexing policy", () => {
  it("allows indexing only on mainnet with the explicit opt-in", () => {
    expect(indexingAllowed("mainnet", "true")).toBe(true);
    expect(indexingAllowed("mainnet", undefined)).toBe(false);
    expect(indexingAllowed("mainnet", "")).toBe(false);
    expect(indexingAllowed("mainnet", "1")).toBe(false);
    expect(indexingAllowed("mainnet", "TRUE")).toBe(false);
    expect(indexingAllowed("devnet", "true")).toBe(false);
    expect(indexingAllowed("testnet", "true")).toBe(false);
    expect(indexingAllowed("localnet", "true")).toBe(false);
  });

  it("robots.txt disallows everything by default", async () => {
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
    vi.stubEnv("NEXT_PUBLIC_ALLOW_INDEXING", "true");
    const { default: robots } = await import("@/app/robots");
    expect(robots()).toEqual({ rules: { userAgent: "*", disallow: "/" } });

    vi.stubEnv("NEXT_PUBLIC_NETWORK", "mainnet");
    vi.stubEnv("NEXT_PUBLIC_ALLOW_INDEXING", "");
    expect(robots()).toEqual({ rules: { userAgent: "*", disallow: "/" } });
  });

  it("robots.txt opens the public site on an opted-in mainnet build", async () => {
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "mainnet");
    vi.stubEnv("NEXT_PUBLIC_ALLOW_INDEXING", "true");
    const { default: robots } = await import("@/app/robots");
    const out = robots();
    expect(out.rules).toMatchObject({ userAgent: "*", allow: "/" });
    const disallow = (out.rules as { disallow: string[] }).disallow;
    expect(disallow).toEqual(expect.arrayContaining(["/account", "/admin", "/api/"]));
    expect(disallow).not.toContain("/");
  });
});
