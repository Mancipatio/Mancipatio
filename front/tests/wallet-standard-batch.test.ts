// lib/wallet-standard-batch: N transactions signed with one call of the
// wallet's `solana:signTransaction` — the wallet and account behind the
// connected session only, the build's chain, the session asserted before and
// after the prompt; anything short of N signed transactions is "unsupported"
// (the verified client then asks once per transaction), and a refusal is
// passed on as it is.
import { describe, expect, it, vi } from "vitest";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import {
  BatchSigningUnsupportedError,
  connectorIdOf,
  findSessionWallet,
  isUserRejection,
  signTransactionsWithWallet,
} from "@/lib/wallet-standard-batch";

const ADDRESS = "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2";
const KEY = new Uint8Array(32).fill(3);

function account(over: Partial<WalletAccount> = {}): WalletAccount {
  return { address: ADDRESS, publicKey: KEY, chains: ["solana:devnet", "solana:mainnet"], features: [], ...over } as WalletAccount;
}

function fakeWallet(name: string, sign: (...inputs: { transaction: Uint8Array; chain?: string; account: WalletAccount }[]) => Promise<{ signedTransaction: Uint8Array }[]>, over: Partial<Wallet> = {}): Wallet {
  return {
    version: "1.0.0",
    name,
    icon: "data:image/svg+xml;base64,AA==",
    chains: ["solana:devnet", "solana:mainnet"],
    accounts: [account()],
    features: {
      "solana:signTransaction": { version: "1.0.0", supportedTransactionVersions: ["legacy", 0], signTransaction: sign },
    },
    ...over,
  } as unknown as Wallet;
}

const session = { account: { address: ADDRESS as never, publicKey: KEY }, connector: { id: "wallet-standard:phantom", name: "Phantom" } };
const txs = [Uint8Array.of(1), Uint8Array.of(2), Uint8Array.of(3)];

describe("finding the session's wallet", () => {
  it("matches the SDK's connector id and the account's address and public key", () => {
    expect(connectorIdOf({ name: "Phantom" })).toBe("wallet-standard:phantom");
    expect(connectorIdOf({ name: "Backpack Wallet!" })).toBe("wallet-standard:backpack-wallet-");
    const phantom = fakeWallet("Phantom", async () => []);
    const other = fakeWallet("Solflare", async () => []);
    expect(findSessionWallet(session, [other, phantom])?.wallet).toBe(phantom);
    expect(findSessionWallet(session, [fakeWallet("Phantom", async () => [], { accounts: [account({ publicKey: new Uint8Array(32) })] })])).toBeNull();
    expect(findSessionWallet(session, [other])).toBeNull();
  });
});

describe("signTransactionsWithWallet", () => {
  it("one call with N inputs on the build's chain, the session asserted before and after", async () => {
    const order: string[] = [];
    const sign = vi.fn(async (...inputs: { transaction: Uint8Array; chain?: string }[]) => {
      order.push(`sign(${inputs.length})`);
      expect(new Set(inputs.map((i) => i.chain))).toEqual(new Set(["solana:devnet"]));
      return inputs.map((i) => ({ signedTransaction: Uint8Array.of(i.transaction[0] + 100) }));
    });
    const out = await signTransactionsWithWallet({
      session,
      transactions: txs,
      version: 0,
      chain: "solana:devnet",
      assertCurrent: () => order.push("assert"),
      wallets: [fakeWallet("Phantom", sign)],
    });
    expect(sign).toHaveBeenCalledOnce();
    expect(order).toEqual(["assert", "sign(3)", "assert"]);
    expect(out.map((o) => o[0])).toEqual([101, 102, 103]);
  });

  it("fewer outputs, a missing feature, an unsupported version or chain: unsupported (the caller asks per transaction)", async () => {
    const base = { session, transactions: txs, version: 0 as const, chain: "solana:devnet" as const, assertCurrent: () => {} };
    await expect(
      signTransactionsWithWallet({ ...base, wallets: [fakeWallet("Phantom", async () => [{ signedTransaction: Uint8Array.of(1) }])] }),
    ).rejects.toThrow(/returned 1 of 3 transactions/);
    await expect(signTransactionsWithWallet({ ...base, wallets: [fakeWallet("Phantom", async () => [], { features: {} })] })).rejects.toBeInstanceOf(
      BatchSigningUnsupportedError,
    );
    await expect(signTransactionsWithWallet({ ...base, version: "legacy", wallets: [fakeWallet("Phantom", async () => [], {
      features: { "solana:signTransaction": { version: "1.0.0", supportedTransactionVersions: [0], signTransaction: async () => [] } },
    } as never)] })).rejects.toThrow(/does not sign legacy/);
    await expect(signTransactionsWithWallet({ ...base, chain: "solana:testnet", wallets: [fakeWallet("Phantom", async () => [])] })).rejects.toThrow(
      /does not list solana:testnet/,
    );
    await expect(signTransactionsWithWallet({ ...base, wallets: [] })).rejects.toBeInstanceOf(BatchSigningUnsupportedError);
    await expect(
      signTransactionsWithWallet({ ...base, wallets: [fakeWallet("Phantom", async () => { throw new Error("Method not implemented"); })] }),
    ).rejects.toBeInstanceOf(BatchSigningUnsupportedError);
  });

  it("the user's refusal is passed on as it is (no fallback prompts)", async () => {
    const refusal = Object.assign(new Error("User rejected the request."), { code: 4001 });
    await expect(
      signTransactionsWithWallet({
        session, transactions: txs, version: 0, chain: "solana:devnet", assertCurrent: () => {},
        wallets: [fakeWallet("Phantom", async () => { throw refusal; })],
      }),
    ).rejects.toBe(refusal);
    expect(isUserRejection(refusal)).toBe(true);
    expect(isUserRejection({ code: 4001 })).toBe(true);
    expect(isUserRejection(new Error("Transaction cancelled"))).toBe(true);
    expect(isUserRejection(new Error("Method not implemented"))).toBe(false);
    expect(isUserRejection(null)).toBe(false);
  });

  it("a wallet change during the prompt is caught after it", async () => {
    let calls = 0;
    await expect(
      signTransactionsWithWallet({
        session, transactions: txs, version: 0, chain: "solana:devnet",
        assertCurrent: () => {
          calls += 1;
          if (calls === 2) throw new Error("wallet changed");
        },
        wallets: [fakeWallet("Phantom", async (...inputs) => inputs.map(() => ({ signedTransaction: Uint8Array.of(0) })))],
      }),
    ).rejects.toThrow("wallet changed");
  });
});
