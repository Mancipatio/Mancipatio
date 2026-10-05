// Where a failed anchor send got, through the real send path: the panel's
// runDocumentAnchorFlow over lib/verified-solana-client over @solana/client
// (createTransactionHelper: sendWithExecutor signs with the wallet, THEN
// broadcasts with rpc.sendTransaction), a real Wallet Standard connector and
// the guarded session, as app/providers builds them. Only the RPC, the fee
// oracle, maintenance, the wallet policy and the genesis check are faked.
//
// A wallet with signTransaction (Phantom, Solflare, Backpack) never
// broadcasts: a refusal, or a wallet or account switch noticed when it
// returns, means nothing was sent. Once it handed back the signed
// transaction, a failed broadcast (transport, timeout) or a change noticed
// after the broadcast may have left the anchor on chain: the page says so,
// keeps the warning (with the transaction's id: the one broadcast) and blocks
// a new send. The error's class decides nothing: the same
// TransactionWalletChangedError is "nothing was sent" before the wallet
// returns and "may have been sent" after the broadcast. Pinned as well: the
// transaction graph's own check right after the wallet returns counts as
// "may have been sent" (the page cannot tell it from a failed broadcast), and
// a wallet that sends itself may have broadcast before it failed.
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
  getAddressEncoder,
  getBase58Decoder,
  getBase64Encoder,
  getTransactionDecoder,
  getTransactionEncoder,
} from "@solana/kit";
import type { Wallet } from "@wallet-standard/base";

const policy = vi.hoisted(() => ({ during: null as (() => void) | null }));
vi.mock("@/lib/maintenance", async (original) => ({
  ...(await original<typeof import("@/lib/maintenance")>()),
  assertSiteWritable: vi.fn(async () => {}),
}));
vi.mock("@/lib/transaction-wallet-policy", async (original) => ({
  ...(await original<typeof import("@/lib/transaction-wallet-policy")>()),
  requestTransactionWalletPolicy: vi.fn(async () => {
    policy.during?.();
  }),
}));
vi.mock("@/lib/network-identity", async (original) => ({
  ...(await original<typeof import("@/lib/network-identity")>()),
  createNetworkVerifier: () => async () => {},
}));

import { withVerifiedTransactions } from "@/lib/verified-solana-client";
import { resetPriorityFeeCache } from "@/lib/priority-fee";
import { walletConnectorOverrides } from "@/lib/wallet-chain";
import { guardWalletSession } from "@/lib/guarded-wallet-connectors";
import { clearWalletChange } from "@/lib/wallet-changes";
import { invalidateTransactionWalletPolicy, TransactionWalletChangedError } from "@/lib/transaction-wallet-policy";
import { documentAnchorInstruction } from "@/lib/document-anchor";
import {
  anchorBlocksNewSend,
  readPendingAnchor,
  readUncertainSend,
  runDocumentAnchorFlow,
  type UncertainAnchorSend,
} from "@/lib/document-anchor-client";

const WALLET = address("6AnFbinF7X12mACTVEGfjWZyzYGAShEscAB5UgV3vHsP");
const BLOCKHASH = "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k";
const RPC_SIGNATURE = getBase58Decoder().decode(new Uint8Array(64).fill(7));
const ANCHOR = { reference: "MANCI-2026-0001", sha256: "a2546dd318ea95b210a4eb62a45b84341d74fa065c3da1c1279fd62135f22bc7" };

type SignInput = { chain?: string; transaction: Uint8Array };
type Scenario = {
  /** The wallet: signs (default), refuses, or sees the account switch while its prompt is open. */
  wallet?: "signs" | "refuses" | "account-switch";
  /** The wallet policy check (before the wallet): nothing, or the account switches during it. */
  policy?: "ok" | "account-switch";
  /** While the wallet prompt is open, the primary wallet changes in another tab (the graph guard's check after it). */
  policyChangeDuringPrompt?: boolean;
  /** rpc.sendTransaction: accepts, fails in transport, times out, or accepts and the account switches right after. */
  broadcast?: "accepts" | "transport" | "timeout" | "accepts-then-switch";
  /** A wallet with only signAndSendTransaction (it broadcasts itself): it sends, or fails. */
  sendsItself?: "sends" | "fails";
};

async function setup(scenario: Scenario = {}) {
  const signed: SignInput[] = [];
  const sent: string[] = [];
  let current: WalletSession | undefined;
  const otherSession = { account: { address: WALLET } } as unknown as WalletSession;
  const switchAccount = () => {
    current = otherSession;
  };

  const account = {
    address: WALLET,
    publicKey: new Uint8Array(getAddressEncoder().encode(WALLET)),
    chains: ["solana:mainnet", "solana:devnet"] as const,
    features: [scenario.sendsItself ? "solana:signAndSendTransaction" : "solana:signTransaction"] as const,
  };
  function sign(input: SignInput): Uint8Array {
    signed.push(input);
    const tx = getTransactionDecoder().decode(input.transaction);
    const withSignature = { messageBytes: tx.messageBytes, signatures: { ...tx.signatures, [WALLET]: new Uint8Array(64).fill(1) } };
    return new Uint8Array(getTransactionEncoder().encode(withSignature as never));
  }
  const signing = scenario.sendsItself
    ? {
        "solana:signAndSendTransaction": {
          version: "1.0.0",
          supportedTransactionVersions: ["legacy", 0],
          signAndSendTransaction: async (...inputs: SignInput[]) =>
            inputs.map((input) => {
              sign(input);
              if (scenario.sendsItself === "fails") throw new Error("The wallet could not send the transaction.");
              return { signature: new Uint8Array(64).fill(1) };
            }),
        },
      }
    : {
        "solana:signTransaction": {
          version: "1.0.0",
          supportedTransactionVersions: ["legacy", 0],
          signTransaction: async (...inputs: SignInput[]) => {
            if (scenario.wallet === "refuses") throw new Error("User rejected the request.");
            if (scenario.wallet === "account-switch") switchAccount();
            if (scenario.policyChangeDuringPrompt) invalidateTransactionWalletPolicy();
            return inputs.map((input) => ({ signedTransaction: sign(input) }));
          },
        },
      };
  const wallet = {
    version: "1.0.0",
    name: "Fake",
    icon: "data:image/svg+xml;base64,PHN2Zy8+",
    chains: ["solana:mainnet", "solana:devnet"],
    accounts: [account],
    features: {
      "standard:connect": { version: "1.0.0", connect: async () => ({ accounts: [account] }) },
      "standard:events": { version: "1.0.0", on: () => () => {} },
      ...signing,
    },
  } as unknown as Wallet;

  const connector = createWalletStandardConnector(wallet, walletConnectorOverrides("devnet")(wallet));
  // As in app/providers: the guarded session, checked against the store's current one.
  const session: WalletSession = guardWalletSession(await connector.connect(), () => current);
  current = session;
  policy.during = scenario.policy === "account-switch" ? switchAccount : null;

  const rpc = {
    getLatestBlockhash: () => ({ send: async () => ({ value: { blockhash: BLOCKHASH, lastValidBlockHeight: BigInt(100) } }) }),
    simulateTransaction: () => ({ send: async () => ({ value: { unitsConsumed: BigInt(5_000), err: null, logs: [] } }) }),
    sendTransaction: (wire: string) => ({
      send: async () => {
        sent.push(wire);
        if (scenario.broadcast === "transport") throw new TypeError("fetch failed");
        if (scenario.broadcast === "timeout") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
        if (scenario.broadcast === "accepts-then-switch") switchAccount();
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
    store: { getState: () => ({ wallet: { status: "connected", session: current } }) },
  } as unknown as SolanaClient;
  const verified = withVerifiedTransactions(client, "devnet");

  const errors: { err: unknown; uncertain: UncertainAnchorSend | null }[] = [];
  const waited: string[] = [];
  const run = () =>
    runDocumentAnchorFlow(ANCHOR, { network: "devnet", signer: WALLET }, {
      // As the panel: the tracked signer is the memo's signer and the fee
      // payer; useSendTransaction adds the session as the authority.
      send: (track) => {
        const signer = track(createWalletTransactionSigner(session).signer);
        return verified.transaction.prepareAndSend({
          instructions: [documentAnchorInstruction({ ...ANCHOR, signer })],
          feePayer: signer,
          authority: session,
        });
      },
      onSendError: (err, uncertain) => errors.push({ err, uncertain }),
      onSent: () => {},
      wait: async (signature) => {
        waited.push(signature);
        return "confirmed";
      },
      onOutcome: () => {},
      record: async () => {},
    });
  return { run, signed, sent, errors, waited };
}

/** A TransactionWalletChangedError, itself or as the cause of the SDK's error. */
function walletChanged(err: unknown): boolean {
  for (let cursor = err, depth = 0; cursor instanceof Error && depth < 4; cursor = cursor.cause, depth++) {
    if (cursor instanceof TransactionWalletChangedError) return true;
  }
  return false;
}

/** The id of the transaction that went to rpc.sendTransaction: its fee payer's signature. */
function broadcastId(wire: string): string {
  const tx = getTransactionDecoder().decode(getBase64Encoder().encode(wire));
  return getBase58Decoder().decode(Object.values(tx.signatures)[0] as Uint8Array);
}

beforeEach(() => {
  resetPriorityFeeCache();
  vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
  const store = new Map<string, string>();
  vi.stubGlobal("window", {
    dispatchEvent: () => true,
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ ok: true, network: "devnet", microLamports: "5000", source: "helius", level: "High" })),
  );
});
afterEach(() => {
  policy.during = null;
  clearWalletChange();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a failed anchor send, by where it failed (the real send path)", () => {
  it("sent: the flow goes on to the network with the RPC's signature; no warning is kept", async () => {
    const f = await setup();
    await expect(f.run()).resolves.toBe("confirmed");
    expect(f.sent).toHaveLength(1);
    expect(f.errors).toEqual([]);
    expect(f.waited).toEqual([RPC_SIGNATURE]);
    expect(readPendingAnchor("devnet", WALLET)?.signature).toBe(RPC_SIGNATURE);
    expect(readUncertainSend("devnet", WALLET)).toBeNull();
  });

  it("the wallet refuses: nothing was sent", async () => {
    const f = await setup({ wallet: "refuses" });
    await expect(f.run()).resolves.toBe("not-sent");
    expect(f.sent).toHaveLength(0);
    expect(f.errors).toHaveLength(1);
    expect(f.errors[0].uncertain).toBeNull();
    expect(readUncertainSend("devnet", WALLET)).toBeNull();
    expect(readPendingAnchor("devnet", WALLET)).toBeNull();
  });

  it("the account switches while the wallet prompt is open: the guarded session refuses what the wallet returns, nothing was sent", async () => {
    const f = await setup({ wallet: "account-switch" });
    await expect(f.run()).resolves.toBe("not-sent");
    // Inside the SDK's plan executor: its SolanaError carries the check's error as the cause.
    expect(walletChanged(f.errors[0].err)).toBe(true);
    expect(f.errors[0].uncertain).toBeNull();
    expect(f.sent).toHaveLength(0);
    expect(readUncertainSend("devnet", WALLET)).toBeNull();
  });

  it("the account switches before the prompt (during the wallet-policy check): the wallet is never asked, nothing was sent", async () => {
    const f = await setup({ policy: "account-switch" });
    await expect(f.run()).resolves.toBe("not-sent");
    expect(walletChanged(f.errors[0].err)).toBe(true);
    expect(f.errors[0].uncertain).toBeNull();
    expect(f.signed).toHaveLength(0);
    expect(f.sent).toHaveLength(0);
  });

  it.each(["transport", "timeout"] as const)(
    "the broadcast fails after the wallet signed (%s): may have been sent; the warning is kept with the broadcast transaction's id",
    async (broadcast) => {
      const f = await setup({ broadcast });
      await expect(f.run()).resolves.toBe("uncertain");
      expect(f.sent).toHaveLength(1);
      const { uncertain } = f.errors[0];
      expect(uncertain).toMatchObject({ ...ANCHOR, network: "devnet", signer: WALLET, signature: broadcastId(f.sent[0]) });
      expect(uncertain?.signature).toBe(getBase58Decoder().decode(new Uint8Array(64).fill(1)));
      expect(readUncertainSend("devnet", WALLET)).toEqual(uncertain);
      expect(anchorBlocksNewSend(null, readUncertainSend("devnet", WALLET))).toBe(true);
      // Nothing is waited for or recorded: the page cannot tell whether it left.
      expect(f.waited).toEqual([]);
      expect(readPendingAnchor("devnet", WALLET)).toBeNull();
    },
  );

  it("the account switches right after the node accepted it: the same TransactionWalletChangedError now means may have been sent", async () => {
    const f = await setup({ broadcast: "accepts-then-switch" });
    await expect(f.run()).resolves.toBe("uncertain");
    expect(walletChanged(f.errors[0].err)).toBe(true);
    expect(f.sent).toHaveLength(1);
    expect(f.errors[0].uncertain?.signature).toBe(broadcastId(f.sent[0]));
    expect(readUncertainSend("devnet", WALLET)?.signature).toBe(broadcastId(f.sent[0]));
  });

  it("the transaction graph's own check after the wallet returned (the wallet policy changed during the prompt) is reported as may have been sent: the page cannot tell it from a failed broadcast", async () => {
    // Nothing went out here, but this check runs after the wallet handed the
    // signed transaction back, where a later failure may follow the broadcast:
    // the page errs on the side of "check the explorer".
    const f = await setup({ policyChangeDuringPrompt: true });
    await expect(f.run()).resolves.toBe("uncertain");
    expect(walletChanged(f.errors[0].err)).toBe(true);
    expect(f.sent).toHaveLength(0);
    expect(f.errors[0].uncertain?.signature).toBe(getBase58Decoder().decode(new Uint8Array(64).fill(1)));
  });

  it("a wallet that sends itself: its signature is the send's; failing, it may already have broadcast (no signature known)", async () => {
    const ok = await setup({ sendsItself: "sends" });
    await expect(ok.run()).resolves.toBe("confirmed");
    expect(ok.sent).toHaveLength(0);
    expect(ok.waited).toEqual([getBase58Decoder().decode(new Uint8Array(64).fill(1))]);

    const failing = await setup({ sendsItself: "fails" });
    await expect(failing.run()).resolves.toBe("uncertain");
    expect(failing.signed).toHaveLength(1);
    expect(failing.errors[0].uncertain).toMatchObject({ ...ANCHOR, signature: null });
    expect(readUncertainSend("devnet", WALLET)?.signature).toBeNull();
  });
});
