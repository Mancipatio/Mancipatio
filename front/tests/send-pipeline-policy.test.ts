// r2g4-07 / r2g4-06: the account check before the wallet
// (lib/transaction-wallet-policy) fails in Manci's own words — only a declined
// sign-in message asks the user to approve it — announces that message on
// lib/send-stage when the wallet is asked for it, and waits for Manci's answer
// at most TRANSACTION_WALLET_POLICY_TIMEOUT_MS outside the wallet's prompt.
// The boundary with the verified client, the policy's validation and the
// session guard are covered by tests/transaction-wallet-policy.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WalletSession } from "@solana/client";
import type { Address } from "@solana/kit";

const remote = vi.hoisted(() => ({ signedFetch: vi.fn() }));
vi.mock("@/lib/siws-client", () => ({ signedFetch: remote.signedFetch }));

import {
  PrimaryWalletRequiredError,
  requestTransactionWalletPolicy,
  TRANSACTION_WALLET_POLICY_TIMEOUT_MS,
  TransactionWalletPolicyError,
} from "@/lib/transaction-wallet-policy";
import { emitSendStage, onSendStage, type SendStage } from "@/lib/send-stage";
import { explainSendError } from "@/lib/tx-error";

const WALLET = "11111111111111111111111111111111" as Address;
const OTHER = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" as Address;
const ACCOUNT = "10000000-0000-4000-8000-000000000001";
const policy = () => ({ wallet: WALLET, network: "devnet", account_id: ACCOUNT, primary_wallet: WALLET });
const current = () => undefined;
const PREFIX = "We could not verify your primary transaction wallet";

function session(): WalletSession {
  return {
    account: { address: WALLET, publicKey: new Uint8Array(32) },
    connector: { id: "test-wallet", name: "Test wallet" },
    disconnect: vi.fn(async () => {}),
    signMessage: vi.fn(async () => new Uint8Array(64)),
  };
}

const failure = async (): Promise<TransactionWalletPolicyError> => {
  const err = await requestTransactionWalletPolicy(session(), "devnet", current).then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(TransactionWalletPolicyError);
  return err as TransactionWalletPolicyError;
};

beforeEach(() => {
  remote.signedFetch.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  emitSendStage({ kind: "done" });
});

describe("the failures, in Manci's words", () => {
  it("a server failure is Manci's: never the server's text, never 'approve the wallet verification'", async () => {
    for (const message of ["database unavailable: secret-token", "Your account is temporarily unavailable. Please try again.", "Request failed (502 Bad Gateway)"]) {
      remote.signedFetch.mockRejectedValueOnce(new Error(message));
      const err = await failure();
      expect(err.reason).toBe("server");
      expect(err.message).toBe(`${PREFIX}: Manci could not confirm your account right now. Nothing was sent — try again.`);
      expect(err.message).not.toMatch(/secret|Approve the wallet verification|502/);
      expect(err.cause).toBeUndefined();
      expect(explainSendError(err)).toBe(err.message);
    }
  });

  it("no answer at all (fetch's own TypeError)", async () => {
    remote.signedFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const err = await failure();
    expect(err.reason).toBe("no-answer");
    expect(err.message).toBe(`${PREFIX}: Manci could not be reached. Nothing was sent — check your connection and try again.`);
  });

  it("only the user's refusal of the sign-in message asks to approve it", async () => {
    for (const refusal of [Object.assign(new Error("User rejected the request."), { code: 4001 }), new Error("User rejected request"), Object.assign(new Error("x"), { code: "WALLET_REJECTED" })]) {
      remote.signedFetch.mockRejectedValueOnce(refusal);
      const err = await failure();
      expect(err.reason).toBe("rejected");
      expect(err.message).toBe(`${PREFIX}. Approve the wallet verification and try again.`);
    }
  });

  it("an answer that is not a policy for this wallet, and a non-primary wallet, keep their words", async () => {
    remote.signedFetch.mockResolvedValueOnce({ ...policy(), network: "mainnet" });
    const misbound = await failure();
    expect(misbound.reason).toBe("misbound");
    expect(misbound.message).toBe(`${PREFIX}. Open Your account and try again.`);
    remote.signedFetch.mockResolvedValueOnce({ ...policy(), primary_wallet: OTHER });
    await expect(requestTransactionWalletPolicy(session(), "devnet", current)).rejects.toBeInstanceOf(PrimaryWalletRequiredError);
  });
});

describe("the sign-in message is announced", () => {
  it("as a message, not a transaction, only when the wallet is asked for it", async () => {
    const stages: SendStage[] = [];
    const stop = onSendStage((stage) => stages.push(stage));
    try {
      // No live 12 h session: lib/siws-client asks the wallet to sign the sign-in message first.
      remote.signedFetch.mockImplementationOnce(async (wallet: WalletSession) => {
        await wallet.signMessage!(new Uint8Array([1]));
        return policy();
      });
      await expect(requestTransactionWalletPolicy(session(), "devnet", current)).resolves.toEqual(policy());
      expect(stages).toEqual([{ kind: "account", signIn: true }]);
      // A live session: no prompt, and nothing announced here (the client announces the check itself).
      stages.length = 0;
      remote.signedFetch.mockResolvedValueOnce(policy());
      await requestTransactionWalletPolicy(session(), "devnet", current);
      expect(stages).toEqual([]);
    } finally {
      stop();
    }
  });
});

describe("the wait for Manci's answer is bounded, the wallet's prompt is not", () => {
  it("times out after TRANSACTION_WALLET_POLICY_TIMEOUT_MS outside the prompt, however long the prompt took", async () => {
    vi.useFakeTimers();
    expect(TRANSACTION_WALLET_POLICY_TIMEOUT_MS).toBe(15_000);
    // The user takes 40 s over the sign-in message; Manci then never answers.
    let closePrompt: () => void = () => {};
    const wallet = session();
    vi.mocked(wallet.signMessage!).mockImplementation(
      () =>
        new Promise<Uint8Array>((resolve) => {
          closePrompt = () => resolve(new Uint8Array(64));
        }),
    );
    remote.signedFetch.mockImplementationOnce(async (guarded: WalletSession) => {
      await guarded.signMessage!(new Uint8Array([1]));
      return new Promise(() => {});
    });
    let outcome: unknown = "pending";
    const call = requestTransactionWalletPolicy(wallet, "devnet", current).then(
      () => (outcome = "resolved"),
      (err: unknown) => (outcome = err),
    );
    await vi.advanceTimersByTimeAsync(40_000);
    expect(outcome).toBe("pending");
    closePrompt();
    await vi.advanceTimersByTimeAsync(TRANSACTION_WALLET_POLICY_TIMEOUT_MS - 10);
    expect(outcome).toBe("pending");
    await vi.advanceTimersByTimeAsync(20);
    await call;
    expect(outcome).toBeInstanceOf(TransactionWalletPolicyError);
    expect((outcome as TransactionWalletPolicyError).reason).toBe("timeout");
    expect((outcome as Error).message).toBe(`${PREFIX}: Manci did not answer in time. Nothing was sent — try again.`);
  });

  it("an answer in time leaves no timer behind", async () => {
    vi.useFakeTimers();
    remote.signedFetch.mockResolvedValueOnce(policy());
    await expect(requestTransactionWalletPolicy(session(), "devnet", current)).resolves.toEqual(policy());
    expect(vi.getTimerCount()).toBe(0);
  });
});
