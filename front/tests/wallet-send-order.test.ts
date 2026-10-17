// Regression (24.9., "Grant admin" refused in preflight with no logs): what a
// Wallet Standard wallet is actually handed by the real @solana/client send
// path behind lib/verified-solana-client. The wallet must be told the build's
// chain (not its first, mainnet) and must see the compute budget first,
// [SetComputeUnitLimit, SetComputeUnitPrice, ...app], so it has no reason to
// add its own. Only the RPC, maintenance, the wallet policy and the genesis
// check are faked; the SDK helper, the connector and the session are real.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTransactionHelper,
  createWalletStandardConnector,
  createWalletTransactionSigner,
  type SolanaClient,
  type WalletSession,
} from "@solana/client";
import {
  AccountRole,
  address,
  getAddressEncoder,
  getBase58Decoder,
  getBase64Decoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
  getSolanaErrorFromJsonRpcError,
  getTransactionDecoder,
  getTransactionEncoder,
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
  SolanaError,
  type Instruction,
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

import { withVerifiedTransactions } from "@/lib/verified-solana-client";
import { resetPriorityFeeCache } from "@/lib/priority-fee";
import { COMPUTE_BUDGET_PROGRAM_ADDRESS, decodeComputeBudgetInstruction } from "@/lib/compute-budget";
import { walletConnectorOverrides } from "@/lib/wallet-chain";
import { guardWalletSession } from "@/lib/guarded-wallet-connectors";
import { clearWalletChange, recentWalletChange } from "@/lib/wallet-changes";
import { explainSendError } from "@/lib/tx-error";
import { setComputeUnitLimitInstruction } from "@/lib/compute-budget";
import { requestTransactionWalletPolicy } from "@/lib/transaction-wallet-policy";
import { SimulationRefusedError } from "@/lib/simulation-gate";

const WALLET = address("6AnFbinF7X12mACTVEGfjWZyzYGAShEscAB5UgV3vHsP");
const PROGRAM = address("FJs1EM1ND89L9sUXaS8VBKYXjmoXCkkVSJKRE19hmYxS");
const BLOCKHASH = "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k";
const SIGNATURE = getBase58Decoder().decode(new Uint8Array(64).fill(7));

type SignInput = { chain?: string; transaction: Uint8Array };
type WalletMode = { sendsItself?: boolean; modify?: (messageBytes: Uint8Array) => Uint8Array };

function fakeWallet(signed: SignInput[], mode: WalletMode = {}): Wallet {
  const account = {
    address: WALLET,
    publicKey: new Uint8Array(getAddressEncoder().encode(WALLET)),
    chains: ["solana:mainnet", "solana:devnet"] as const,
    features: [mode.sendsItself ? "solana:signAndSendTransaction" : "solana:signTransaction"] as const,
  };
  function sign(input: SignInput): Uint8Array {
    signed.push(input);
    const tx = getTransactionDecoder().decode(input.transaction);
    const messageBytes = mode.modify ? mode.modify(new Uint8Array(tx.messageBytes)) : tx.messageBytes;
    const withSignature = { messageBytes, signatures: { ...tx.signatures, [WALLET]: new Uint8Array(64).fill(1) } };
    return new Uint8Array(getTransactionEncoder().encode(withSignature as never));
  }
  const features = mode.sendsItself
    ? {
        "solana:signAndSendTransaction": {
          version: "1.0.0",
          supportedTransactionVersions: ["legacy", 0],
          signAndSendTransaction: async (...inputs: SignInput[]) =>
            inputs.map((input) => {
              sign(input);
              return { signature: new Uint8Array(64).fill(7) };
            }),
        },
      }
    : {
        "solana:signTransaction": {
          version: "1.0.0",
          supportedTransactionVersions: ["legacy", 0],
          signTransaction: async (...inputs: SignInput[]) => inputs.map((input) => ({ signedTransaction: sign(input) })),
        },
      };
  return {
    version: "1.0.0",
    name: "Fake",
    icon: "data:image/svg+xml;base64,PHN2Zy8+",
    chains: ["solana:mainnet", "solana:devnet"],
    accounts: [account],
    features: {
      "standard:connect": { version: "1.0.0", connect: async () => ({ accounts: [account] }) },
      "standard:events": { version: "1.0.0", on: () => () => {} },
      ...features,
    },
  } as unknown as Wallet;
}

type RpcFaults = {
  simulationErr?: unknown;
  simulationLogs?: string[];
  preflightErr?: unknown;
  /** Thrown by getLatestBlockhash (made at call time, so a test's NODE_ENV applies to the message). */
  blockhashErr?: () => unknown;
  /** Thrown by sendTransaction, likewise. */
  sendErr?: () => unknown;
};

function fakeRpc(unitsConsumed: bigint, faults: RpcFaults = {}) {
  const simulated: string[] = [];
  const simulateConfigs: unknown[] = [];
  const sent: string[] = [];
  const blockhashes = { count: 0, signals: [] as (AbortSignal | undefined)[] };
  const rpc = {
    getLatestBlockhash: () => ({
      send: async (options?: { abortSignal?: AbortSignal }) => {
        blockhashes.count += 1;
        blockhashes.signals.push(options?.abortSignal);
        if (faults.blockhashErr) throw faults.blockhashErr();
        return { value: { blockhash: BLOCKHASH, lastValidBlockHeight: BigInt(100) } };
      },
    }),
    simulateTransaction: (wire: string, config: unknown) => ({
      send: async () => {
        simulated.push(wire);
        simulateConfigs.push(config);
        return { value: { unitsConsumed, err: faults.simulationErr ?? null, logs: faults.simulationLogs ?? [] } };
      },
    }),
    sendTransaction: (wire: string) => ({
      send: async () => {
        sent.push(wire);
        if (faults.sendErr) throw faults.sendErr();
        if (faults.preflightErr) {
          // What kit makes of the RPC's -32002 answer.
          throw getSolanaErrorFromJsonRpcError({
            code: -32002,
            message: "Transaction simulation failed",
            data: { accounts: null, err: faults.preflightErr, logs: [], unitsConsumed: 0, loadedAccountsDataSize: 0 },
          });
        }
        return SIGNATURE;
      },
    }),
  };
  return { rpc, simulated, simulateConfigs, sent, blockhashes };
}

function instructionsOf(wire: string): string[] {
  const tx = getTransactionDecoder().decode(getBase64Encoder().encode(wire));
  const message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  return message.instructions.map((ix) => {
    const program = message.staticAccounts[ix.programAddressIndex];
    if (program !== COMPUTE_BUDGET_PROGRAM_ADDRESS) return program;
    const decoded = decodeComputeBudgetInstruction({ programAddress: program, data: ix.data });
    return decoded?.kind === "limit" ? `limit:${decoded.units}` : decoded?.kind === "price" ? `price:${decoded.microLamports}` : "cb:?";
  });
}

type Setup = RpcFaults & { withOverrides?: boolean; wallet?: WalletMode };

async function setup(unitsConsumed: bigint, options: Setup = {}) {
  const signed: SignInput[] = [];
  const wallet = fakeWallet(signed, options.wallet);
  const connector = createWalletStandardConnector(
    wallet,
    options.withOverrides === false ? undefined : walletConnectorOverrides("devnet")(wallet),
  );
  // As in app/providers: every session is the guarded one.
  const session: WalletSession = guardWalletSession(await connector.connect(), () => session);
  const { rpc, simulated, simulateConfigs, sent, blockhashes } = fakeRpc(unitsConsumed, options);
  const runtime = { rpc, rpcSubscriptions: {} } as unknown as SolanaClient["runtime"];
  const transaction = createTransactionHelper(runtime, () => "confirmed");
  const client = {
    runtime,
    transaction,
    helpers: { transaction },
    store: { getState: () => ({ wallet: { status: "connected", session } }) },
  } as unknown as SolanaClient;
  const guarded = withVerifiedTransactions(client, "devnet");
  const { signer } = createWalletTransactionSigner(session);
  // Shaped like add_admin: the wallet signs the instruction and pays.
  const ix: Instruction = {
    programAddress: PROGRAM,
    accounts: [{ address: WALLET, role: AccountRole.WRITABLE_SIGNER, signer } as never],
    data: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
  };
  // What useSendTransaction passes: the session as authority, our signer as fee payer.
  const send = () => guarded.transaction.prepareAndSend({ instructions: [ix], feePayer: signer, authority: session });
  return { send, signed, simulated, simulateConfigs, sent, blockhashes };
}

beforeEach(() => {
  resetPriorityFeeCache();
  vi.mocked(requestTransactionWalletPolicy).mockClear();
  vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
  vi.stubGlobal("window", { dispatchEvent: () => true });
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

describe("what the wallet is handed on a send", () => {
  it("is told solana:devnet, not its first chain", async () => {
    const f = await setup(BigInt(10_000));
    await f.send();
    expect(f.signed).toHaveLength(1);
    expect(f.signed[0].chain).toBe("solana:devnet");
  });

  it("without the override the SDK would name the wallet's first chain (the bug)", async () => {
    const f = await setup(BigInt(10_000), { withOverrides: false });
    await f.send();
    expect(f.signed[0].chain).toBe("solana:mainnet");
  });

  it("gets the compute budget first: [limit, price, app]", async () => {
    const f = await setup(BigInt(10_000));
    await expect(f.send()).resolves.toBe(SIGNATURE);
    expect(f.sent).toHaveLength(1);
    // A small transaction gets the SDK's 200k minimum.
    expect(instructionsOf(f.sent[0])).toEqual(["limit:200000", "price:5000", PROGRAM]);
  });

  it("the limit is re-estimated in place from a simulation of the placeholder", async () => {
    const f = await setup(BigInt(300_000));
    await f.send();
    expect(f.simulated).toHaveLength(1);
    expect(instructionsOf(f.simulated[0])).toEqual(["limit:1400000", "price:5000", PROGRAM]);
    // ceil(300_000 × 1.1)
    expect(instructionsOf(f.sent[0])).toEqual(["limit:330000", "price:5000", PROGRAM]);
  });

  it("the gate is that one simulation: unsigned, at the node's blockhash, and one blockhash fetch for the send", async () => {
    const f = await setup(BigInt(300_000));
    await f.send();
    expect(f.simulateConfigs).toEqual([
      { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" },
    ]);
    expect(f.blockhashes.count).toBe(1);
    expect(f.signed).toHaveLength(1);
  });

  it("sends the message the wallet signed, and nothing is noted when it is unchanged", async () => {
    const f = await setup(BigInt(10_000));
    await f.send();
    const handed = getTransactionDecoder().decode(f.signed[0].transaction).messageBytes;
    const sent = getTransactionDecoder().decode(getBase64Encoder().encode(f.sent[0])).messageBytes;
    expect(Array.from(sent)).toEqual(Array.from(handed));
    expect(recentWalletChange()).toBeNull();
  });

  it("a wallet that changes the message: its version is sent, and a refusal names the change", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // The wallet re-compiles the message with its own limit in front, which
    // the network refuses before execution (DuplicateInstruction).
    const modify = (messageBytes: Uint8Array) => {
      const message = getCompiledTransactionMessageDecoder().decode(messageBytes);
      const budget = message.staticAccounts.indexOf(COMPUTE_BUDGET_PROGRAM_ADDRESS);
      const extra = { programAddressIndex: budget, data: setComputeUnitLimitInstruction(50_000).data };
      return new Uint8Array(
        getCompiledTransactionMessageEncoder().encode({ ...message, instructions: [extra, ...message.instructions] } as never),
      );
    };
    const f = await setup(BigInt(10_000), { wallet: { modify }, preflightErr: { DuplicateInstruction: 1 } });
    const failure = await f.send().then(
      () => null,
      (err: unknown) => err,
    );
    expect(failure).not.toBeNull();
    expect(instructionsOf(f.sent[0])).toEqual(["limit:50000", "limit:200000", "price:5000", PROGRAM]);
    const change =
      "the wallet changed its instructions [SetComputeUnitLimit(200000), SetComputeUnitPrice(5000), FJs1…mYxS] → " +
      "[SetComputeUnitLimit(50000), SetComputeUnitLimit(200000), SetComputeUnitPrice(5000), FJs1…mYxS] before signing";
    expect(warn).toHaveBeenCalledWith(`[wallet] ${change}`);
    expect(explainSendError(failure)).toBe(
      "The transaction carries the same compute-budget instruction twice (DuplicateInstruction), usually because the wallet added its own priority fee to the app's. " +
        `Note: ${change}.`,
    );
    // Read once: the next explanation does not repeat it.
    expect(recentWalletChange()).toBeNull();
  });

  it("a successful send leaves no note behind", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const modify = (messageBytes: Uint8Array) => Uint8Array.from(messageBytes, (b, i) => (i === messageBytes.length - 1 ? b ^ 1 : b));
    const f = await setup(BigInt(10_000), { wallet: { modify } });
    await expect(f.send()).resolves.toBe(SIGNATURE);
    expect(recentWalletChange()).toBeNull();
  });

  it("a sign-and-send wallet is told solana:devnet and sent [limit, price, app]", async () => {
    const f = await setup(BigInt(10_000), { wallet: { sendsItself: true } });
    await f.send();
    expect(f.sent).toHaveLength(0);
    expect(f.signed).toHaveLength(1);
    expect(f.signed[0].chain).toBe("solana:devnet");
    const handed = getBase64Decoder().decode(f.signed[0].transaction);
    expect(instructionsOf(handed)).toEqual(["limit:200000", "price:5000", PROGRAM]);
  });

  // Before the gate, a failed estimate fell back to the SDK's 200k floor and
  // the wallet opened anyway; a payer that cannot cover the placeholder's fee
  // is now refused before the wallet.
  it("InsufficientFundsForFee is refused before the wallet", async () => {
    const f = await setup(BigInt(0), { simulationErr: "InsufficientFundsForFee" });
    const failure = await f.send().then(() => null, (err: unknown) => err);
    expect(failure).toBeInstanceOf(SimulationRefusedError);
    expect(f.signed).toHaveLength(0);
    expect(f.sent).toHaveLength(0);
    expect(requestTransactionWalletPolicy).not.toHaveBeenCalled();
    expect(explainSendError(failure)).toBe(
      "This transaction would fail, so your wallet was not opened. The paying wallet does not have enough SOL on devnet for the network fee (InsufficientFundsForFee).",
    );
  });

  it("an instruction the program refuses never reaches the wallet, and the refusal names it", async () => {
    const logs = [
      `Program ${PROGRAM} invoke [1]`,
      "Program log: AnchorError caused by account: platform. Error Code: PartyBlocklisted. Error Number: 6144. Error Message: A party is blocklisted.",
      `Program ${PROGRAM} failed: custom program error: 0x1800`,
    ];
    const f = await setup(BigInt(5_000), { simulationErr: { InstructionError: [2, { Custom: BigInt(6144) }] }, simulationLogs: logs });
    const failure = await f.send().then(() => null, (err: unknown) => err);
    expect(failure).toBeInstanceOf(SimulationRefusedError);
    expect(f.signed).toHaveLength(0);
    expect(f.sent).toHaveLength(0);
    expect(requestTransactionWalletPolicy).not.toHaveBeenCalled();
    // [limit, price, app]: message index 2 is the app's only step.
    expect((failure as SimulationRefusedError).instructionIndex).toBe(0);
    expect(explainSendError(failure)).toMatch(
      /^This transaction would fail, so your wallet was not opened\. Step 1 of 1 \(.+\) was refused by the Manci registry program: A wallet in this transaction .+ \(PartyBlocklisted\)\.$/,
    );
  });
});

// r2g4-03 / r2g4-06, against the real SDK: where an RPC refusal lands in its
// error tree decides the wording — a blockhash fetch comes before the wallet,
// sendTransaction after it signed — and a production build's message ("Solana
// error #8100002; Decode this error by running npx …") never reaches the user.
describe("an RPC that refuses the request, before and after the wallet", () => {
  const http = (statusCode: number) => new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, { headers: new Headers(), message: "HTTP", statusCode });

  it("the blockhash fetch carries the request's own cut-off, and a 429 there means nothing was sent", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const f = await setup(BigInt(10_000), { blockhashErr: () => http(429) });
    const failure = await f.send().then(() => null, (err: unknown) => err);
    expect(failure).not.toBeNull();
    expect(f.signed).toHaveLength(0);
    expect(f.sent).toHaveLength(0);
    expect(f.blockhashes.signals).toHaveLength(1);
    expect(f.blockhashes.signals[0]).toBeInstanceOf(AbortSignal);
    expect(explainSendError(failure)).toBe("The Solana RPC refused the request (HTTP 429). Nothing was sent — try again in a moment.");
  });

  it("a 503 on sendTransaction, after the wallet signed: the outcome is unknown, never 'nothing was sent', never the decode text", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const f = await setup(BigInt(10_000), { sendErr: () => http(503) });
    const failure = await f.send().then(() => null, (err: unknown) => err);
    expect(failure).not.toBeNull();
    expect(f.signed).toHaveLength(1);
    expect(f.sent).toHaveLength(1);
    const text = explainSendError(failure);
    expect(text).toBe(
      "The Solana RPC refused the request (HTTP 503) after your wallet signed. The transaction may not have been broadcast; check it in the explorer before retrying.",
    );
    expect(text).not.toMatch(/npx|Nothing was sent/);
  });

  it("no answer from the RPC on sendTransaction reads the same way", async () => {
    const f = await setup(BigInt(10_000), { sendErr: () => new TypeError("Failed to fetch") });
    const failure = await f.send().then(() => null, (err: unknown) => err);
    expect(f.signed).toHaveLength(1);
    expect(explainSendError(failure)).toBe(
      "The Solana RPC did not answer after your wallet signed. The transaction may not have been broadcast; check it in the explorer before retrying.",
    );
  });
});
