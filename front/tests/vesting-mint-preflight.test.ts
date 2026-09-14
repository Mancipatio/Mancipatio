// lib/vesting-mint-preflight.ts — the "New vesting series" form must reject
// an unsupported mint while the issuer is typing it, with the same rules
// prepare-creation applies after approval (F05).
import { describe, expect, it } from "vitest";
import type { Address } from "@solana/kit";
import { getMintEncoder } from "@solana-program/token-2022";
import { TOKEN_2022, TOKEN_CLASSIC } from "@/lib/transaction-builders";
import {
  describeVestingMintError,
  preflightVestingMint,
  tokenProgramLabel,
} from "@/lib/vesting-mint-preflight";

const AUTHORITY = "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2" as Address;
const CLASSIC_MINT = "8sHgqRqBEXaSkhcyzXtY3vBSfGqBbTeR2SkVFDcxrfd9" as Address;
const T22_MINT = "6D6TgUKrYY6dJrCUZ6LcJKt5EGGdCUgHtVeUKmRZbUJ2" as Address;
const NON_TRANSFERABLE = "4KcVAsHCdcCPpDxYPHV7ZLcTU1sfKZBLZTz3H1B5mMhx" as Address;
const FOREIGN_OWNED = "5MZBGE68wKvzAiRnh9BLcxWzWZ9EGDgvS39mgLDLKTsy" as Address;
const MISSING = "3n1mQ6zsrVpQyzFCkr9qFVGgU3qHiHQeAvGtaVJk9oNr" as Address;

const base = {
  mintAuthority: AUTHORITY,
  supply: BigInt(10),
  decimals: 6,
  isInitialized: true,
  freezeAuthority: null,
};

function stubRpc(
  accounts: Record<string, { owner: Address; data: Uint8Array }>,
  fail?: Error,
) {
  return {
    getAccountInfo: (address: Address) => ({
      send: async () => {
        if (fail) throw fail;
        const account = accounts[address.toString()];
        return {
          context: { slot: BigInt(1) },
          value: account
            ? {
                data: [Buffer.from(account.data).toString("base64"), "base64"],
                owner: account.owner,
                executable: false,
                lamports: BigInt(1),
                space: BigInt(account.data.length),
                rentEpoch: BigInt(0),
              }
            : null,
        };
      },
    }),
  } as unknown as Parameters<typeof preflightVestingMint>[0];
}

const plainMint = () =>
  new Uint8Array(getMintEncoder().encode({ ...base, extensions: null }));
const rpc = stubRpc({
  [CLASSIC_MINT]: { owner: TOKEN_CLASSIC, data: plainMint() },
  [T22_MINT]: { owner: TOKEN_2022, data: plainMint() },
  [NON_TRANSFERABLE]: {
    owner: TOKEN_2022,
    data: new Uint8Array(
      getMintEncoder().encode({
        ...base,
        extensions: [{ __kind: "NonTransferable" }],
      }),
    ),
  },
  [FOREIGN_OWNED]: { owner: AUTHORITY, data: plainMint() },
});

describe("preflightVestingMint", () => {
  it("rejects a malformed address without touching the RPC", async () => {
    let calls = 0;
    const counting = {
      getAccountInfo: () => {
        calls += 1;
        return { send: async () => ({ context: { slot: BigInt(1) }, value: null }) };
      },
    } as unknown as Parameters<typeof preflightVestingMint>[0];
    const result = await preflightVestingMint(counting, "not-a-mint");
    expect(result).toEqual({
      ok: false,
      reason: "Token mint must be a base58 address.",
      retryable: false,
    });
    expect(calls).toBe(0);
  });

  it("accepts plain mints under either supported token program", async () => {
    expect(await preflightVestingMint(rpc, ` ${CLASSIC_MINT} `)).toEqual({
      ok: true,
      tokenProgram: TOKEN_CLASSIC,
      programLabel: "Token program",
    });
    expect(await preflightVestingMint(rpc, T22_MINT)).toEqual({
      ok: true,
      tokenProgram: TOKEN_2022,
      programLabel: "Token-2022",
    });
  });

  it("rejects a Token-2022 mint with a forbidden extension, naming it", async () => {
    const result = await preflightVestingMint(rpc, NON_TRANSFERABLE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/NonTransferable/);
    expect(result.reason).toMatch(/choose a mint without that extension/);
    expect(result.retryable).toBe(false);
  });

  it("rejects accounts not owned by a token program and missing accounts", async () => {
    const foreign = await preflightVestingMint(rpc, FOREIGN_OWNED);
    expect(foreign).toMatchObject({ ok: false, retryable: false });
    expect(!foreign.ok && foreign.reason).toMatch(/not a token mint/);
    const missing = await preflightVestingMint(rpc, MISSING);
    expect(missing).toMatchObject({ ok: false, retryable: false });
    expect(!missing.ok && missing.reason).toMatch(/No account exists at this address/);
  });

  it("marks RPC transport trouble as retryable instead of blaming the mint", async () => {
    const flaky = stubRpc({}, new TypeError("Failed to fetch"));
    const result = await preflightVestingMint(flaky, CLASSIC_MINT);
    expect(result).toMatchObject({ ok: false, retryable: true });
    expect(!result.ok && result.reason).toMatch(/Could not verify the mint/);
  });
});

describe("describeVestingMintError / tokenProgramLabel", () => {
  it("translates each builder failure into form copy", () => {
    expect(
      describeVestingMintError(
        new Error("The selected account is not an initialized token mint."),
      ),
    ).toMatchObject({ retryable: false });
    expect(
      describeVestingMintError(
        new Error("The hook is not bound to this registry share class"),
      ).reason,
    ).toMatch(/registry-issued share-class mints/);
    expect(describeVestingMintError("weird")).toEqual({
      reason: "Could not verify the mint: weird",
      retryable: true,
    });
  });

  it("labels the two supported programs", () => {
    expect(tokenProgramLabel(TOKEN_CLASSIC)).toBe("Token program");
    expect(tokenProgramLabel(TOKEN_2022)).toBe("Token-2022");
    expect(tokenProgramLabel(AUTHORITY)).toBe(AUTHORITY);
  });
});
