import type { SolanaClient } from "@solana/client";
import type { Address } from "@solana/kit";
import { describe, expect, it, vi } from "vitest";
import { conversionBalances, latestConversionRead, loadConversionBalances, validConversionAmount } from "@/lib/conversion-holder";

const token = (account: string, mint: string, amount: string) => ({
  pubkey: account, account: { data: { parsed: { info: { mint, tokenAmount: { amount } } } } },
});

describe("holder conversion eligibility", () => {
  it("sums separate token accounts of one mint and excludes zero balances", () => {
    const balances = conversionBalances([
      token("ata", "equity", "12"), token("other-account", "equity", "8"),
      token("zero", "not-held", "0"), token("other-mint", "other", "2"),
    ]);
    expect([...balances]).toEqual([["equity", BigInt(20)], ["other", BigInt(2)]]);
  });

  it("does not count a repeated token account twice and preserves bigint precision", () => {
    const entry = token("account", "mint", "9007199254740993");
    expect(conversionBalances([entry, entry]).get("mint")).toBe(BigInt("9007199254740993"));
  });

  it.each(["-1", "1.5", "bad", ""])("fails closed on an unreadable token amount %j instead of returning a partial total", (amount) => {
    expect(() => conversionBalances([token("valid", "mint", "12"), token("invalid", "mint", amount)])).toThrow("Could not verify");
  });

  it("distinguishes an empty wallet from an RPC failure", async () => {
    const send = vi.fn().mockResolvedValue({ value: [] });
    const accounts = vi.fn(() => ({ send }));
    const rpc = { getTokenAccountsByOwner: accounts } as unknown as SolanaClient["runtime"]["rpc"];
    const owner = "11111111111111111111111111111111" as Address;
    expect((await loadConversionBalances(rpc, owner)).size).toBe(0);
    expect(accounts).toHaveBeenCalledWith(owner, { programId: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" }, { encoding: "jsonParsed" });
    send.mockRejectedValue(new Error("RPC unavailable"));
    await expect(loadConversionBalances(rpc, owner)).rejects.toThrow("RPC unavailable");
  });

  it("ignores an older ownership result after a newer refresh has started", async () => {
    const reads = latestConversionRead();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const first = reads.begin(() => true);
    let value = "loading";
    const oldResult = pending.then(() => { if (first()) value = "old holdings"; });
    const latest = reads.begin(() => true);
    if (latest()) value = "new holdings";
    release();
    await oldResult;
    expect(value).toBe("new holdings");
  });

  it("rejects a pending KYC/requests result after wallet or network changes, or unmount", () => {
    const reads = latestConversionRead();
    let current = "devnet:wallet-A";
    const result = reads.begin(() => current === "devnet:wallet-A");
    expect(result()).toBe(true);
    current = "devnet:wallet-B";
    expect(result()).toBe(false);
    current = "mainnet:wallet-A";
    expect(result()).toBe(false);
    current = "devnet:wallet-A";
    reads.invalidate();
    expect(result()).toBe(false);
  });

  it("accepts only positive safely representable amounts within the current balance", () => {
    expect(validConversionAmount("20", BigInt(20))).toBe(true);
    expect(validConversionAmount("21", BigInt(20))).toBe(false);
    for (const amount of ["", "0", "-1", "1.5", "1e2", "9007199254740992"]) {
      expect(validConversionAmount(amount, BigInt("9007199254740993"))).toBe(false);
    }
    expect(validConversionAmount(String(Number.MAX_SAFE_INTEGER), BigInt("9007199254740993"))).toBe(true);
  });
});
