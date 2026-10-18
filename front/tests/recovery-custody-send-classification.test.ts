// F006, end to end: what becomes of a saved vault approval when its send
// fails, through the REAL send path — openCustodyOnce over
// lib/verified-solana-client over @solana/client (sign with the wallet, then
// broadcast with rpc.sendTransaction), a real Wallet Standard connector and
// the guarded session, as app/providers builds them — with
// custodySendNeverBroadcast as the classifier the hook passes. Only the RPC,
// the fee oracle, maintenance, the wallet policy, the pause/scope and gate
// account reads and the genesis check are faked (the harness of
// tests/document-anchor-send.test.ts). A wallet that refuses never signed:
// the intent it had just saved is forgotten and "Open vault" is back. A
// broadcast that fails after the wallet signed may have reached the network:
// the intent stays, stamped with the moment the send settled.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTransactionHelper,
  createWalletStandardConnector,
  createWalletTransactionSigner,
  type SolanaClient,
  type WalletSession,
} from "@solana/client";
import {
  address,
  getAddressDecoder,
  getAddressEncoder,
  getBase58Decoder,
  getTransactionDecoder,
  getTransactionEncoder,
} from "@solana/kit";
import type { Wallet } from "@wallet-standard/base";

vi.mock("@/lib/maintenance", async (original) => ({
  ...(await original<typeof import("@/lib/maintenance")>()),
  assertSiteWritable: vi.fn(async () => {}),
}));
vi.mock("@/lib/transaction-wallet-policy", async (original) => ({
  ...(await original<typeof import("@/lib/transaction-wallet-policy")>()),
  requestTransactionWalletPolicy: vi.fn(async () => {}),
}));
vi.mock("@/lib/network-identity", async (original) => ({
  ...(await original<typeof import("@/lib/network-identity")>()),
  createNetworkVerifier: () => async () => {},
}));
vi.mock("@/lib/pause-gate", async (original) => ({
  ...(await original<typeof import("@/lib/pause-gate")>()),
  assertInstructionsInScope: vi.fn(() => {}),
  assertInstructionsNotPaused: vi.fn(async () => {}),
}));
vi.mock("@/lib/proceeds-gate", async (original) => ({
  ...(await original<typeof import("@/lib/proceeds-gate")>()),
  assertGateAccountsUnset: vi.fn(async () => {}),
}));

import { withVerifiedTransactions } from "@/lib/verified-solana-client";
import { resetPriorityFeeCache } from "@/lib/priority-fee";
import { walletConnectorOverrides } from "@/lib/wallet-chain";
import { guardWalletSession } from "@/lib/guarded-wallet-connectors";
import { clearWalletChange } from "@/lib/wallet-changes";
import {
  getOpenCustodyVaultInstructionAsync,
  RealizeAction,
  VaultType,
} from "@/lib/generated/asset_registry";
import {
  custodySendNeverBroadcast,
  openCustodyOnce,
  readCustodyOpenIntent,
  type CustodyOpenScope,
} from "@/lib/custody-open-recovery";

const WALLET = address("6AnFbinF7X12mACTVEGfjWZyzYGAShEscAB5UgV3vHsP");
const BLOCKHASH = "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k";
const RPC_SIGNATURE = getBase58Decoder().decode(new Uint8Array(64).fill(7));
const key = (n: number) => getAddressDecoder().decode(new Uint8Array(32).fill(n));
const scope: CustodyOpenScope = { product: "conversion", requestId: "request-1", network: "devnet", wallet: WALLET };

type SignInput = { chain?: string; transaction: Uint8Array };
type Scenario = {
  /** The wallet: signs (default) or refuses. */
  wallet?: "signs" | "refuses";
  /** rpc.sendTransaction: accepts, or fails in transport after the wallet signed. */
  broadcast?: "accepts" | "transport";
};

async function setup(scenario: Scenario = {}) {
  const signed: SignInput[] = [];
  const sent: string[] = [];
  // The store's current session, read by the guarded session and the client.
  const store: { current?: WalletSession } = {};
  const account = {
    address: WALLET,
    publicKey: new Uint8Array(getAddressEncoder().encode(WALLET)),
    chains: ["solana:mainnet", "solana:devnet"] as const,
    features: ["solana:signTransaction"] as const,
  };
  function sign(input: SignInput): Uint8Array {
    signed.push(input);
    const tx = getTransactionDecoder().decode(input.transaction);
    const withSignature = { messageBytes: tx.messageBytes, signatures: { ...tx.signatures, [WALLET]: new Uint8Array(64).fill(1) } };
    return new Uint8Array(getTransactionEncoder().encode(withSignature as never));
  }
  const wallet = {
    version: "1.0.0",
    name: "Fake",
    icon: "data:image/svg+xml;base64,PHN2Zy8+",
    chains: ["solana:mainnet", "solana:devnet"],
    accounts: [account],
    features: {
      "standard:connect": { version: "1.0.0", connect: async () => ({ accounts: [account] }) },
      "standard:events": { version: "1.0.0", on: () => () => {} },
      "solana:signTransaction": {
        version: "1.0.0",
        supportedTransactionVersions: ["legacy", 0],
        signTransaction: async (...inputs: SignInput[]) => {
          if (scenario.wallet === "refuses") throw new Error("User rejected the request.");
          return inputs.map((input) => ({ signedTransaction: sign(input) }));
        },
      },
    },
  } as unknown as Wallet;
  const connector = createWalletStandardConnector(wallet, walletConnectorOverrides("devnet")(wallet));
  const session: WalletSession = guardWalletSession(await connector.connect(), () => store.current);
  store.current = session;
  const rpc = {
    getLatestBlockhash: () => ({ send: async () => ({ value: { blockhash: BLOCKHASH, lastValidBlockHeight: BigInt(100) } }) }),
    simulateTransaction: () => ({ send: async () => ({ value: { unitsConsumed: BigInt(5_000), err: null, logs: [] } }) }),
    sendTransaction: (wire: string) => ({
      send: async () => {
        sent.push(wire);
        if (scenario.broadcast === "transport") throw new TypeError("fetch failed");
        return RPC_SIGNATURE;
      },
    }),
  };
  const runtime = { rpc, rpcSubscriptions: {} } as unknown as SolanaClient["runtime"];
  const transaction = createTransactionHelper(runtime, () => "confirmed");
  const client = {
    runtime,
    transaction,
    helpers: { transaction },
    store: { getState: () => ({ wallet: { status: "connected", session: store.current } }) },

  } as unknown as SolanaClient;
  const verified = withVerifiedTransactions(client, "devnet");
  const signer = createWalletTransactionSigner(session).signer;
  const link = vi.fn(async () => {});
  const onIntent = vi.fn();
  const run = () =>
    openCustodyOnce({
      scope,
      shareClass: key(2),
      vaultId: "42",
      assertUnoccupied: async () => {},
      build: () =>
        getOpenCustodyVaultInstructionAsync({
          authority: signer,
          shareClass: key(2),
          mint: key(3),
          tokenProgram: address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"),
          vaultId: BigInt(42),
          vaultType: VaultType.DeliveryEscrow,
          realizeAction: RealizeAction.BurnAndAttest,
          amount: BigInt(7),
          deadline: BigInt(2_000_000_000),
          metadataHash: new Uint8Array(32).fill(9),
          beneficiary: key(4),
          kycRegistry: key(5),
        }),
      // As the admin page's `(ix) => tx.send({ instructions: [ix], feePayer: signer })` over the verified client.
      send: (ix) => verified.transaction.prepareAndSend({ instructions: [ix], feePayer: signer, authority: session }),
      link,
      notSent: custodySendNeverBroadcast,
      onIntent,
    });
  return { run, signed, sent, link, onIntent };
}

beforeEach(() => {
  resetPriorityFeeCache();
  vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
  const store = new Map<string, string>();
  vi.stubGlobal("window", {
    dispatchEvent: () => true,
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, value: string) => void store.set(k, value),
      removeItem: (k: string) => void store.delete(k),
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ ok: true, network: "devnet", microLamports: "5000", source: "helius", level: "High" })),
  );
});
afterEach(() => {
  clearWalletChange();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a failed vault approval send, by where it failed (the real send path)", () => {
  it("sent: the intent carries the RPC's signature and the moment it returned, and is linked", async () => {
    const f = await setup();
    const intent = await f.run();
    expect(f.sent).toHaveLength(1);
    expect(intent.signature).toBe(RPC_SIGNATURE);
    expect(Number.isFinite(Date.parse(intent.attemptedAt ?? ""))).toBe(true);
    expect(f.link).toHaveBeenCalledWith(expect.objectContaining({ signature: RPC_SIGNATURE }));
    expect(readCustodyOpenIntent(scope)).toMatchObject({ signature: RPC_SIGNATURE, recordedAt: expect.any(String) });
  });

  it("the wallet refuses: nothing was signed or sent, the intent it had just saved is forgotten", async () => {
    const f = await setup({ wallet: "refuses" });
    await expect(f.run()).rejects.toThrow();
    expect(f.signed).toHaveLength(0);
    expect(f.sent).toHaveLength(0);
    expect(f.link).not.toHaveBeenCalled();
    // Saved before the wallet (the first call), forgotten after its refusal (the last).
    expect(f.onIntent).toHaveBeenCalledTimes(2);
    expect(f.onIntent.mock.calls[0][0]).toMatchObject({ signature: null, attemptedAt: null });
    expect(f.onIntent.mock.lastCall?.[0]).toBeNull();
    expect(readCustodyOpenIntent(scope)).toBeNull();
    // The same approval can be built and sent again.
    const again = await setup();
    await expect(again.run()).resolves.toMatchObject({ signature: RPC_SIGNATURE });
  });

  it("the broadcast fails after the wallet signed: may have been sent — the intent stays, stamped with the moment the send settled", async () => {
    const f = await setup({ broadcast: "transport" });
    await expect(f.run()).rejects.toThrow();
    expect(f.signed).toHaveLength(1);
    expect(f.sent).toHaveLength(1);
    expect(f.link).not.toHaveBeenCalled();
    const kept = readCustodyOpenIntent(scope);
    expect(kept).toMatchObject({ signature: null, recordedAt: null });
    expect(Number.isFinite(Date.parse(kept?.attemptedAt ?? ""))).toBe(true);
    expect(f.onIntent.mock.lastCall?.[0]).toEqual(kept);
    // Another approval of the request takes the API-only branch: no second vault.
    const again = await setup();
    await expect(again.run()).resolves.toMatchObject({ signature: null, vaultPda: kept?.vaultPda });
    expect(again.sent).toHaveLength(0);
    expect(again.link).toHaveBeenCalledOnce();
  });
});
