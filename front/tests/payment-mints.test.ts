// lib/payment-mints + the entry check in lib/transaction-builders (Talas 4.2
// §3.1-3.2): payment mints are classified from their account bytes, entry
// paths apply the plain-payment rule and (mainnet) the allowlist, and the
// network's USDC must look like USDC. The RPC is an in-memory stub.
import { describe, expect, it } from "vitest";
import { address, type Address } from "@solana/kit";
import { getMintEncoder, type ExtensionArgs } from "@solana-program/token-2022";
import { TRANSFER_HOOK_PROGRAM_ADDRESS } from "@/lib/generated/transfer_hook";
import {
  KNOWN_MINT_LAYOUT,
  MAINNET_PAYMENT_MINTS,
  NOT_ALLOWED_ON_MAINNET,
  TOKEN_2022,
  TOKEN_CLASSIC,
  USDC,
  assertKnownMintLayout,
  classifyMintAccount,
  defaultPaymentMint,
  isAllowedPaymentMint,
  paymentMintLabel,
  requiredFxKind,
} from "@/lib/payment-mints";
import {
  fetchMintTokenProgram,
  fetchPlainPaymentMintTokenProgram,
  inspectPaymentMint,
  loadSalePaymentDecimals,
} from "@/lib/transaction-builders";
import { paymentTokenLabel } from "@/lib/purchase-quote";

const AUTHORITY = address("7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2");
const OTHER_MINT = address("8sHgqRqBEXaSkhcyzXtY3vBSfGqBbTeR2SkVFDcxrfd9");
const MAINNET_USDC = USDC.mainnet!.mint;
const DEVNET_USDC = USDC.devnet!.mint;

function mintBytes(decimals = 6, extensions: ExtensionArgs[] | null = null, isInitialized = true): Uint8Array {
  return new Uint8Array(
    getMintEncoder().encode({ mintAuthority: AUTHORITY, supply: BigInt(0), decimals, isInitialized, freezeAuthority: null, extensions }),
  );
}
const hook: ExtensionArgs = { __kind: "TransferHook", authority: AUTHORITY, programId: AUTHORITY };
const manciHook: ExtensionArgs = { __kind: "TransferHook", authority: AUTHORITY, programId: TRANSFER_HOOK_PROGRAM_ADDRESS };
const delegate: ExtensionArgs = { __kind: "PermanentDelegate", delegate: AUTHORITY };
const closeAuthority: ExtensionArgs = { __kind: "MintCloseAuthority", closeAuthority: AUTHORITY };

type Rpc = Parameters<typeof inspectPaymentMint>[0];
function rpcFor(accounts: Record<string, { owner: Address; data: Uint8Array }>): Rpc {
  return {
    getAccountInfo: (key: Address) => ({
      send: async () => {
        const account = accounts[key];
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
  } as unknown as Rpc;
}

describe("classifyMintAccount", () => {
  it("accepts an 82-byte SPL Token mint and reads its decimals", () => {
    const got = classifyMintAccount({ programAddress: TOKEN_CLASSIC, data: mintBytes(9) }, { plainPayment: true });
    expect(got.owner).toBe(TOKEN_CLASSIC);
    expect(got.decimals).toBe(9);
  });

  it("accepts a Token-2022 mint, base or with the Mint account type byte and benign extensions", () => {
    expect(classifyMintAccount({ programAddress: TOKEN_2022, data: mintBytes(6) }, { plainPayment: true }).owner).toBe(TOKEN_2022);
    const extended = mintBytes(2, [closeAuthority]);
    expect(extended.length).toBeGreaterThan(166);
    expect(extended[165]).toBe(1);
    expect(classifyMintAccount({ programAddress: TOKEN_2022, data: extended }, { plainPayment: true }).decimals).toBe(2);
  });

  it("refuses an 83-byte account, a 165-byte token account and an uninitialized mint", () => {
    const data83 = new Uint8Array(83);
    data83.set(mintBytes());
    expect(() => classifyMintAccount({ programAddress: TOKEN_CLASSIC, data: data83 }, { plainPayment: false })).toThrow(
      /not an initialized token mint/,
    );
    const tokenAccount = new Uint8Array(165);
    expect(() => classifyMintAccount({ programAddress: TOKEN_2022, data: tokenAccount }, { plainPayment: false })).toThrow(
      /not an initialized token mint/,
    );
    const typed = new Uint8Array(170);
    typed[165] = 2; // Account, not Mint
    expect(() => classifyMintAccount({ programAddress: TOKEN_2022, data: typed }, { plainPayment: false })).toThrow(
      /not an initialized token mint/,
    );
    expect(() => classifyMintAccount({ programAddress: TOKEN_CLASSIC, data: mintBytes(6, null, false) }, { plainPayment: false })).toThrow(
      /not an initialized token mint/,
    );
    // An extended layout is only a Token-2022 mint.
    expect(() => classifyMintAccount({ programAddress: TOKEN_CLASSIC, data: mintBytes(6, [closeAuthority]) }, { plainPayment: false })).toThrow(
      /not an initialized token mint/,
    );
  });

  it("refuses a foreign owner", () => {
    expect(() => classifyMintAccount({ programAddress: AUTHORITY, data: mintBytes() }, { plainPayment: false })).toThrow(
      /not owned by a supported token program/,
    );
  });

  it("the plain-payment rule refuses a transfer hook (even Manci's), a permanent delegate and other extensions", () => {
    for (const extensions of [[hook], [manciHook], [delegate], [manciHook, delegate]]) {
      expect(() => classifyMintAccount({ programAddress: TOKEN_2022, data: mintBytes(6, extensions) }, { plainPayment: true })).toThrow(
        /without a transfer hook or permanent delegate/,
      );
    }
    expect(() =>
      classifyMintAccount({ programAddress: TOKEN_2022, data: mintBytes(6, [{ __kind: "NonTransferable" }]) }, { plainPayment: true }),
    ).toThrow(/does not support the mint extension NonTransferable/);
    // Without the rule (the permissive exit check) they classify.
    expect(classifyMintAccount({ programAddress: TOKEN_2022, data: mintBytes(6, [hook, delegate]) }, { plainPayment: false }).owner).toBe(
      TOKEN_2022,
    );
  });
});

describe("known layout, allowlist, FX kind and labels", () => {
  it("the network's USDC must be an SPL Token mint with 6 decimals (wrong cluster or RPC otherwise)", () => {
    expect(KNOWN_MINT_LAYOUT).toEqual({ tokenProgram: TOKEN_CLASSIC, decimals: 6 });
    expect(() => assertKnownMintLayout("mainnet", MAINNET_USDC, { owner: TOKEN_CLASSIC, decimals: 6 })).not.toThrow();
    expect(() => assertKnownMintLayout("mainnet", MAINNET_USDC, { owner: TOKEN_2022, decimals: 6 })).toThrow(/wrong cluster or RPC/);
    expect(() => assertKnownMintLayout("devnet", DEVNET_USDC, { owner: TOKEN_CLASSIC, decimals: 9 })).toThrow(/wrong cluster or RPC/);
    // Other mints and networks are not constrained here.
    expect(() => assertKnownMintLayout("devnet", MAINNET_USDC, { owner: TOKEN_2022, decimals: 2 })).not.toThrow();
    expect(() => assertKnownMintLayout("localnet", OTHER_MINT, { owner: TOKEN_2022, decimals: 0 })).not.toThrow();
  });

  it("mainnet allows only the allowlist (USDC, kind rate); other networks allow any mint and fix no kind", () => {
    expect(Object.keys(MAINNET_PAYMENT_MINTS)).toEqual([MAINNET_USDC]);
    expect(isAllowedPaymentMint("mainnet", MAINNET_USDC)).toBe(true);
    expect(isAllowedPaymentMint("mainnet", DEVNET_USDC)).toBe(false);
    expect(isAllowedPaymentMint("mainnet", "toString")).toBe(false);
    expect(isAllowedPaymentMint("devnet", OTHER_MINT)).toBe(true);
    expect(requiredFxKind("mainnet", MAINNET_USDC)).toBe("rate");
    expect(requiredFxKind("mainnet", OTHER_MINT)).toBeNull();
    expect(requiredFxKind("devnet", DEVNET_USDC)).toBeNull();
  });

  it("defaults and labels (display only)", () => {
    expect(defaultPaymentMint("mainnet")).toBe(MAINNET_USDC);
    expect(defaultPaymentMint("devnet")).toBe(DEVNET_USDC);
    expect(defaultPaymentMint("testnet")).toBeNull();
    expect(defaultPaymentMint("localnet")).toBeNull();
    expect(paymentMintLabel(MAINNET_USDC, "mainnet")).toBe("USDC");
    expect(paymentMintLabel(DEVNET_USDC, "devnet")).toBe("test USDC");
    expect(paymentMintLabel(DEVNET_USDC, "mainnet")).toBe("payment tokens");
    expect(paymentMintLabel(OTHER_MINT, "devnet")).toBe("payment tokens");
    expect(paymentTokenLabel(MAINNET_USDC, "mainnet")).toBe("USDC");
  });
});

describe("entry and exit checks against the chain", () => {
  const rpc = rpcFor({
    [MAINNET_USDC]: { owner: TOKEN_CLASSIC, data: mintBytes(6) },
    [DEVNET_USDC]: { owner: TOKEN_CLASSIC, data: mintBytes(6) },
    [OTHER_MINT]: { owner: TOKEN_2022, data: mintBytes(8, [closeAuthority]) },
    [AUTHORITY]: { owner: TOKEN_2022, data: mintBytes(6, [hook]) },
  });

  it("inspectPaymentMint returns the actual program and decimals, Token-2022 included", async () => {
    await expect(inspectPaymentMint(rpc, OTHER_MINT, "devnet")).resolves.toEqual({ owner: TOKEN_2022, decimals: 8 });
    await expect(inspectPaymentMint(rpc, DEVNET_USDC, "devnet")).resolves.toEqual({ owner: TOKEN_CLASSIC, decimals: 6 });
    await expect(inspectPaymentMint(rpc, MAINNET_USDC, "mainnet")).resolves.toEqual({ owner: TOKEN_CLASSIC, decimals: 6 });
  });

  it("inspectPaymentMint refuses a hook mint, a missing mint and (mainnet) a non-allowlisted mint", async () => {
    await expect(inspectPaymentMint(rpc, AUTHORITY, "devnet")).rejects.toThrow(/transfer hook/);
    await expect(inspectPaymentMint(rpc, address("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"), "devnet")).rejects.toThrow();
    await expect(inspectPaymentMint(rpc, OTHER_MINT, "mainnet")).rejects.toThrow(NOT_ALLOWED_ON_MAINNET);
  });

  it("a USDC that does not look like USDC means the wrong cluster", async () => {
    const wrong = rpcFor({ [DEVNET_USDC]: { owner: TOKEN_CLASSIC, data: mintBytes(9) } });
    await expect(inspectPaymentMint(wrong, DEVNET_USDC, "devnet")).rejects.toThrow(/wrong cluster or RPC/);
  });

  it("the exit check stays permissive; the plain check keeps its rule", async () => {
    await expect(fetchMintTokenProgram(rpc, AUTHORITY)).resolves.toBe(TOKEN_2022);
    await expect(fetchPlainPaymentMintTokenProgram(rpc, AUTHORITY)).rejects.toThrow(/transfer hook/);
    await expect(fetchPlainPaymentMintTokenProgram(rpc, OTHER_MINT)).resolves.toBe(TOKEN_2022);
  });

  it("loadSalePaymentDecimals works with a Token-2022 payment mint (Buy is no longer blocked)", async () => {
    await expect(loadSalePaymentDecimals(rpc, OTHER_MINT, "devnet")).resolves.toBe(8);
    await expect(loadSalePaymentDecimals(rpc, AUTHORITY, "devnet")).rejects.toThrow(/transfer hook/);
    const wide = rpcFor({ [OTHER_MINT]: { owner: TOKEN_2022, data: mintBytes(19) } });
    await expect(loadSalePaymentDecimals(wide, OTHER_MINT, "devnet")).rejects.toThrow(/18 decimals/);
  });
});
