import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient, createWalletTransactionSigner, type SolanaClient, type TransactionPrepared, type TransactionPrepareRequest, type WalletSession } from "@solana/client";
import { generateKeyPairSigner, getBase64Encoder, getSignatureFromTransaction, getTransactionDecoder, isFullySignedTransaction, partiallySignTransaction, type Address, type Transaction, type TransactionSigner } from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { CLUSTER_GENESIS_HASHES } from "@/lib/network-identity";
import { withVerifiedTransactions } from "@/lib/verified-solana-client";
import { invalidateTransactionWalletPolicy, requestTransactionWalletPolicy } from "@/lib/transaction-wallet-policy";
import { guardWalletSession } from "@/lib/guarded-wallet-connectors";

const remote = vi.hoisted(() => ({ signedFetch: vi.fn() }));
vi.mock("@/lib/siws-client", () => ({ signedFetch: remote.signedFetch }));

const WALLET = "11111111111111111111111111111111" as Address;
const OTHER = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" as Address;
const ACCOUNT = "10000000-0000-4000-8000-000000000001";
const policy = () => ({ wallet: WALLET, network: "devnet", account_id: ACCOUNT, primary_wallet: WALLET });

function session(wallet: Address = WALLET): WalletSession {
  return {
    account: { address: wallet, publicKey: new Uint8Array(32) },
    connector: { id: "test-wallet", name: "Test wallet" },
    disconnect: vi.fn(async () => {}),
    signMessage: vi.fn(async () => new Uint8Array(64)),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  let current: WalletSession | undefined = session();
  const initialSession = current;
  const genesis = vi.fn(async (): Promise<string> => CLUSTER_GENESIS_HASHES.devnet);
  const rpc = { getGenesisHash: () => ({ send: genesis }) };
  const signature = vi.fn(async () => [{}]);
  const signer = { address: WALLET, signTransactions: signature } as unknown as TransactionSigner;
  const submitted = vi.fn();
  let beforeSign = async () => {};
  const request = {
    feePayer: signer,
    instructions: [{ programAddress: WALLET, accounts: [{ address: WALLET, role: 3, signer }] }],
  } as unknown as TransactionPrepareRequest;
  const prepare = vi.fn(async (input: TransactionPrepareRequest) => ({
    feePayer: WALLET, instructions: input.instructions,
    message: { feePayer: { address: WALLET }, instructions: input.instructions },
  } as unknown as TransactionPrepared));
  async function signInput(input: TransactionPrepareRequest | TransactionPrepared) {
    await beforeSign();
    const embedded = input.instructions[0].accounts![0] as unknown as { signer: { signTransactions: () => Promise<unknown> } };
    await embedded.signer.signTransactions();
  }
  const transaction = {
    prepare,
    sign: vi.fn(async (input: TransactionPrepared) => { await signInput(input); return {}; }),
    toWire: vi.fn(async (input: TransactionPrepared) => { await signInput(input); return "wire"; }),
    send: vi.fn(async (input: TransactionPrepared) => { await signInput(input); submitted(); return "signature"; }),
    prepareAndSend: vi.fn(async (input: TransactionPrepareRequest) => { await signInput(input); submitted(); return "signature"; }),
  };
  const runtime = { rpc: rpc as unknown as SolanaClient["runtime"]["rpc"] };
  const client = {
    runtime, transaction, helpers: { transaction },
    store: { getState: () => ({ wallet: current ? { status: "connected", session: current } : { status: "disconnected" } }) },
  } as unknown as SolanaClient;
  return {
    client, guarded: withVerifiedTransactions(client, "devnet"), request, transaction,
    initialSession, genesis, signer, signature, submitted,
    setSession: (value: WalletSession | undefined) => { current = value; },
    replaceRpc: () => { runtime.rpc = {} as SolanaClient["runtime"]["rpc"]; },
    setBeforeSign: (callback: () => Promise<void>) => { beforeSign = callback; },
  };
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
  remote.signedFetch.mockReset();
  remote.signedFetch.mockImplementation(async (wallet: WalletSession) => {
    await wallet.signMessage!(new Uint8Array([1, 2, 3]));
    return policy();
  });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("primary wallet policy at the transaction boundary", () => {
  it("never asks for a signature on construction or read-only preparation", async () => {
    const f = fixture();
    await f.guarded.transaction.prepare(f.request);
    expect(remote.signedFetch).not.toHaveBeenCalled();
    expect(f.initialSession.signMessage).not.toHaveBeenCalled();
    expect(f.signature).not.toHaveBeenCalled();
  });

  it("fetches the current server preference once for an explicit transaction", async () => {
    const f = fixture();
    await f.guarded.transaction.prepareAndSend(f.request);
    expect(remote.signedFetch).toHaveBeenCalledExactlyOnceWith(expect.any(Object), "/api/account/wallets/transaction", "account.wallets.transaction", {});
    expect(f.initialSession.signMessage).toHaveBeenCalledOnce();
    expect(f.signature).toHaveBeenCalledOnce();
    expect(f.submitted).toHaveBeenCalledOnce();
    const passed = f.transaction.prepareAndSend.mock.calls[0][0];
    expect((passed.instructions[0].accounts![0] as unknown as { signer: unknown }).signer).toBe(passed.feePayer);
    expect(passed.feePayer).not.toBe(f.signer);
    expect((passed.feePayer as TransactionSigner).address).toBe(WALLET);
  });

  it("blocks a linked non-primary wallet before any transaction signing/submission", async () => {
    const f = fixture();
    remote.signedFetch.mockResolvedValue({ ...policy(), primary_wallet: OTHER });
    await expect(f.guarded.transaction.prepareAndSend(f.request)).rejects.toThrow("Connect your primary wallet");
    expect(f.transaction.prepareAndSend).not.toHaveBeenCalled();
    expect(f.signature).not.toHaveBeenCalled();
    expect(f.submitted).not.toHaveBeenCalled();
  });

  it.each([
    null, {}, { ...policy(), wallet: OTHER }, { ...policy(), network: "mainnet" },
    { ...policy(), account_id: "not-an-account" }, { ...policy(), primary_wallet: "invalid address" },
  ])("fails closed for a missing or misbound server policy %j", async (response) => {
    const f = fixture(); remote.signedFetch.mockResolvedValue(response);
    await expect(f.guarded.transaction.prepareAndSend(f.request)).rejects.toThrow("could not verify");
    expect(f.transaction.prepareAndSend).not.toHaveBeenCalled();
  });

  it.each(["User rejected request", "database unavailable: secret-token"])("fails closed when policy cannot be read: %s", async (message) => {
    const f = fixture(); remote.signedFetch.mockRejectedValue(new Error(message));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(f.guarded.transaction.prepareAndSend(f.request)).rejects.toThrow("could not verify");
    expect(f.signature).not.toHaveBeenCalled();
    expect(f.submitted).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("does not fall back to an unsigned browser preference for wallets without signMessage", async () => {
    const f = fixture();
    f.setSession({ ...session(), signMessage: undefined });
    await expect(f.guarded.transaction.prepareAndSend(f.request)).rejects.toThrow("supports message signing");
    expect(remote.signedFetch).not.toHaveBeenCalled();
    expect(f.signature).not.toHaveBeenCalled();
  });

  it("does not cache a formerly-primary preference for the next transaction", async () => {
    const f = fixture();
    await f.guarded.transaction.prepareAndSend(f.request);
    remote.signedFetch.mockResolvedValue({ ...policy(), primary_wallet: OTHER });
    await expect(f.guarded.transaction.prepareAndSend(f.request)).rejects.toThrow("Connect your primary wallet");
    expect(remote.signedFetch).toHaveBeenCalledTimes(2);
    expect(f.submitted).toHaveBeenCalledTimes(1);
  });

  it.each(["feePayer", "authority"] as const)("refuses an explicit %s belonging to a different wallet", async (field) => {
    const f = fixture();
    const input = { ...f.request, [field]: field === "feePayer" ? OTHER : session(OTHER) };
    await expect(f.guarded.transaction.prepareAndSend(input)).rejects.toThrow(field === "feePayer" ? "another wallet" : "changed");
    expect(remote.signedFetch).not.toHaveBeenCalled();
    expect(f.signature).not.toHaveBeenCalled();
  });
});

describe("transaction session and prepared-message provenance", () => {
  it.each(["wallet", "rpc"])("rejects a %s switch while network verification is pending", async (change) => {
    const f = fixture();
    const gate = deferred<string>(); f.genesis.mockReturnValue(gate.promise);
    const pending = f.guarded.transaction.prepareAndSend(f.request);
    if (change === "wallet") f.setSession(session());
    else f.replaceRpc();
    gate.resolve(CLUSTER_GENESIS_HASHES.devnet);
    await expect(pending).rejects.toThrow("changed");
    expect(remote.signedFetch).not.toHaveBeenCalled();
    expect(f.signature).not.toHaveBeenCalled();
  });

  it.each(["session", "network", "preference"])("rejects a %s change during the account policy signature", async (change) => {
    const f = fixture();
    remote.signedFetch.mockImplementation(async (wallet: WalletSession) => {
      await wallet.signMessage!(new Uint8Array());
      if (change === "session") f.setSession(session());
      if (change === "network") vi.stubEnv("NEXT_PUBLIC_NETWORK", "mainnet");
      if (change === "preference") invalidateTransactionWalletPolicy();
      return policy();
    });
    await expect(f.guarded.transaction.prepareAndSend(f.request)).rejects.toThrow("changed");
    expect(f.signature).not.toHaveBeenCalled();
  });

  it("blocks a switched wallet before calling the transaction signer inside the SDK helper", async () => {
    const f = fixture();
    f.setBeforeSign(async () => { f.setSession(session(OTHER)); });
    await expect(f.guarded.transaction.prepareAndSend(f.request)).rejects.toThrow("changed");
    expect(f.transaction.prepareAndSend).toHaveBeenCalledOnce();
    expect(f.signature).not.toHaveBeenCalled();
    expect(f.submitted).not.toHaveBeenCalled();
  });

  it.each(["session", "rpc", "preference"])("withholds a signed result from submission after a %s change in the wallet prompt", async (change) => {
    const f = fixture();
    f.signature.mockImplementation(async () => {
      if (change === "session") f.setSession(session());
      if (change === "rpc") f.replaceRpc();
      if (change === "preference") invalidateTransactionWalletPolicy();
      return [{}];
    });
    await expect(f.guarded.transaction.prepareAndSend(f.request)).rejects.toThrow("changed");
    expect(f.signature).toHaveBeenCalledOnce();
    expect(f.submitted).not.toHaveBeenCalled();
  });

  it("prepares and sends through the pool with a single policy read at send time", async () => {
    const f = fixture();
    const prepared = await f.guarded.transaction.prepare(f.request);
    await f.guarded.transaction.send(prepared);
    expect(remote.signedFetch).toHaveBeenCalledOnce();
    expect(f.genesis).toHaveBeenCalledTimes(2);
    expect(f.submitted).toHaveBeenCalledOnce();
  });

  it.each(["sign", "toWire", "send"] as const)("refuses stale prepared %s after reconnecting the same address", async (method) => {
    const f = fixture();
    const prepared = await f.guarded.transaction.prepare(f.request);
    f.setSession(session());
    await expect(f.guarded.transaction[method](prepared)).rejects.toThrow("changed");
    expect(remote.signedFetch).not.toHaveBeenCalled();
    expect(f.signature).not.toHaveBeenCalled();
  });

  it("rejects prepared objects without captured session provenance", async () => {
    const f = fixture();
    const prepared = await f.transaction.prepare(f.request);
    await expect(f.guarded.transaction.send(prepared)).rejects.toThrow("prepare the transaction again");
    expect(remote.signedFetch).not.toHaveBeenCalled();
    expect(f.signature).not.toHaveBeenCalled();
  });

  it("rejects a prepared message whose actual fee payer differs from its metadata", async () => {
    const f = fixture();
    f.transaction.prepare.mockResolvedValue({ feePayer: WALLET, instructions: [], message: { feePayer: { address: OTHER } } } as unknown as TransactionPrepared);
    await expect(f.guarded.transaction.prepare(f.request)).rejects.toThrow("another wallet");
    expect(remote.signedFetch).not.toHaveBeenCalled();
  });

  it("rejects a stale WalletSession supplied as authority even if its address is unchanged", async () => {
    const f = fixture();
    await expect(f.guarded.transaction.prepareAndSend({ ...f.request, authority: session() })).rejects.toThrow("changed");
    expect(f.signature).not.toHaveBeenCalled();
  });
});

describe("policy message signature session guard", () => {
  it("does not submit a signed policy request if the wallet changed during message approval", async () => {
    const wallet = session();
    let current = true;
    vi.mocked(wallet.signMessage!).mockImplementation(async () => { current = false; return new Uint8Array(64); });
    const submitted = vi.fn();
    remote.signedFetch.mockImplementation(async (guarded: WalletSession) => {
      await guarded.signMessage!(new Uint8Array());
      submitted();
      return policy();
    });
    await expect(requestTransactionWalletPolicy(wallet, "devnet", () => { if (!current) throw new Error("session changed"); }))
      .rejects.toThrow("session changed");
    expect(submitted).not.toHaveBeenCalled();
  });
});

describe("installed Solana client integration with a local signer and mocked RPC", () => {
  async function sdkFixture(sendOnly = false) {
    // createClient warms up the cluster immediately. Handle that one request
    // locally; all subsequent transaction RPC methods use the stub below.
    const warmupFetch = vi.fn(async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body.method).toBe("getLatestBlockhash");
      return Response.json({ jsonrpc: "2.0", id: body.id,
        result: { context: { slot: 1 }, value: { blockhash: WALLET, lastValidBlockHeight: 1000 } } });
    });
    vi.stubGlobal("fetch", warmupFetch);
    const key = await generateKeyPairSigner();
    const client = createClient({ endpoint: "https://rpc.invalid", walletConnectors: [] });
    const wireTransactions: Transaction[] = [];
    const walletTransactions: Transaction[] = [];
    const submit = vi.fn((wire: string) => ({ send: async () => {
      const transaction = getTransactionDecoder().decode(getBase64Encoder().encode(wire));
      wireTransactions.push(transaction);
      return getSignatureFromTransaction(transaction);
    } }));
    const simulate = vi.fn(() => ({ send: async () => ({ value: { err: null, unitsConsumed: 5000 } }) }));
    // The SDK itself replaces this runtime property when changing clusters.
    const mutableRuntime = client.runtime as { rpc: SolanaClient["runtime"]["rpc"] };
    mutableRuntime.rpc = {
      getGenesisHash: () => ({ send: async () => CLUSTER_GENESIS_HASHES.devnet }),
      getLatestBlockhash: () => ({ send: async () => ({ value: { blockhash: WALLET, lastValidBlockHeight: BigInt(1000) } }) }),
      simulateTransaction: simulate,
      sendTransaction: submit,
    } as unknown as SolanaClient["runtime"]["rpc"];
    const source: WalletSession = {
      account: { address: key.address, publicKey: new Uint8Array(await crypto.subtle.exportKey("raw", key.keyPair.publicKey)) },
      connector: { id: "local-only", name: "Local test signer" },
      disconnect: vi.fn(async () => {}),
      signMessage: vi.fn(async () => new Uint8Array(64)),
      ...(sendOnly ? {
        sendTransaction: vi.fn(async (transaction) => {
          const signed = await partiallySignTransaction([key.keyPair], transaction);
          walletTransactions.push(signed);
          return getSignatureFromTransaction(signed);
        }),
      } : {
        signTransaction: vi.fn(async (transaction) => partiallySignTransaction([key.keyPair], transaction)),
      }),
    };
    const active = guardWalletSession(source, () => {
      const wallet = client.store.getState().wallet;
      return wallet.status === "connected" ? wallet.session : undefined;
    });
    client.store.setState({ wallet: { status: "connected", session: active, connectorId: "local-only" } });
    const signer = createWalletTransactionSigner(active).signer;
    const instruction = getTransferSolInstruction({ source: signer, destination: OTHER, amount: BigInt(1) });
    const request = { feePayer: signer, authority: active, instructions: [instruction] };
    remote.signedFetch.mockImplementation(async (wallet: WalletSession) => {
      await wallet.signMessage!(new Uint8Array([1]));
      return { ...policy(), wallet: key.address, primary_wallet: key.address };
    });
    return { client, guarded: withVerifiedTransactions(client, "devnet"), request, source, key,
      submit, simulate, wireTransactions, walletTransactions, warmupFetch };
  }

  async function verifyTransaction(transaction: Transaction, key: Awaited<ReturnType<typeof generateKeyPairSigner>>) {
    expect(isFullySignedTransaction(transaction)).toBe(true);
    const signature = transaction.signatures[key.address];
    expect(signature).toBeTruthy();
    expect(await crypto.subtle.verify("Ed25519", key.keyPair.publicKey,
      Uint8Array.from(signature!), Uint8Array.from(transaction.messageBytes))).toBe(true);
  }

  it("runs actual preparation, simulation, shared signer resolution, signing and wire submission", async () => {
    const f = await sdkFixture();
    const signature = await f.guarded.transaction.prepareAndSend(f.request);
    expect(signature).toBe(getSignatureFromTransaction(f.wireTransactions[0]));
    expect(f.simulate).toHaveBeenCalledOnce();
    expect(f.source.signTransaction).toHaveBeenCalledOnce();
    expect(f.submit).toHaveBeenCalledOnce();
    expect(remote.signedFetch).toHaveBeenCalledOnce();
    expect(f.warmupFetch).toHaveBeenCalledOnce();
    await verifyTransaction(f.wireTransactions[0], f.key);
  });

  it("preserves frozen prepared messages and plan signers across separate prepare/send calls", async () => {
    const f = await sdkFixture();
    const prepared = await f.guarded.transaction.prepare(f.request);
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(remote.signedFetch).not.toHaveBeenCalled();
    await f.guarded.transaction.send(prepared);
    expect(f.source.signTransaction).toHaveBeenCalledOnce();
    expect(f.submit).toHaveBeenCalledOnce();
    expect(remote.signedFetch).toHaveBeenCalledOnce();
    expect(f.warmupFetch).toHaveBeenCalledOnce();
    await verifyTransaction(f.wireTransactions[0], f.key);
  });

  it("keeps the actual sign-and-send wallet path behind the same primary policy", async () => {
    const f = await sdkFixture(true);
    await f.guarded.transaction.prepareAndSend(f.request);
    expect(f.source.sendTransaction).toHaveBeenCalledOnce();
    expect(f.submit).not.toHaveBeenCalled();
    expect(remote.signedFetch).toHaveBeenCalledOnce();
    expect(f.warmupFetch).toHaveBeenCalledOnce();
    await verifyTransaction(f.walletTransactions[0], f.key);
  });
});
