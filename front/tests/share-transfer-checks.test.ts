// lib/share-transfer: the checks "Send to holder" shows before anything is
// signed (a decision table over chain facts), and the loader that reads those
// facts in two getMultipleAccounts round trips. The checks mirror the
// transfer hook's process_execute (sender blocklist; KycGated: Approved,
// expiry > now, country approved and not blocked) plus what a sender must
// know that the hook does not check (self-send, a real wallet, the
// recipient's own blocklist entry, the amount). Unreadable means red.
import { describe, expect, it } from "vitest";
import { generateKeyPairSigner, type Address } from "@solana/kit";
import { AccountState, getMintEncoder, getTokenEncoder } from "@solana-program/token-2022";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  getKycEntryEncoder,
  getKycRegistryEncoder,
  findKycEntryPda,
  KycStatus,
} from "@/lib/generated/asset_registry";
import {
  findConfigPda,
  getBlockEntryEncoder,
  getTransferHookConfigEncoder,
  RestrictionMode,
  TRANSFER_HOOK_PROGRAM_ADDRESS,
} from "@/lib/generated/transfer_hook";
import { jurisdictionBitmap } from "@/lib/jurisdiction-bitmap";
import { findBlockEntryPda } from "@/lib/pdas";
import {
  formatExpiryDate,
  loadShareTransferFacts,
  ownershipPercent,
  shareTransferChecks,
  shareTransferSummary,
  tokenAccountOf,
  TOKEN_2022,
  type ShareTransferFacts,
} from "@/lib/share-transfer";

const MINT = "HRcahPjAhX9ssiY5WvNJxHmy5vuDL7Q6GF6J5gNGjgwC" as Address;
const REGISTRY = "5MofiJNCoCRkNg1f2Yd7368WkjiNxkZZmUTaQo7xLhku" as Address;
const SENDER = "6AnFbinF7X12mACTVEGfjWZyzYGAShEscAB5UgV3vHsP" as Address;
const RECIPIENT = "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2" as Address;
const SYSTEM = "11111111111111111111111111111111" as Address;
const SERBIA = 688;
const GERMANY = 276;

const NOW = Date.UTC(2026, 9, 3, 12) / 1000;
const EXPIRY = BigInt(Date.UTC(2027, 9, 3, 12) / 1000);

function facts(over: Partial<ShareTransferFacts> = {}): ShareTransferFacts {
  return {
    mint: MINT,
    sender: SENDER,
    recipient: RECIPIENT,
    hook: { kind: "kyc-gated", registry: REGISTRY },
    hookConfig: { restrictionMode: RestrictionMode.KycGated, kycRegistry: { __option: "Some", value: REGISTRY } },
    decimals: 0,
    senderTokenAccount: SYSTEM,
    senderBalance: BigInt(5_000),
    senderAccountFrozen: false,
    recipientTokenAccount: SYSTEM,
    recipientTokenAccountExists: false,
    recipientTokenAccountFrozen: false,
    recipientKind: "new-wallet",
    senderBlocked: false,
    recipientBlocked: false,
    passport: {
      registry: REGISTRY,
      registryState: "ok",
      approvedJurisdictions: jurisdictionBitmap([SERBIA, GERMANY - 1]),
      blockedJurisdictions: jurisdictionBitmap([]),
      entry: { status: KycStatus.Approved, expiry: EXPIRY, jurisdiction: SERBIA },
    },
    ...over,
  };
}

const passportWith = (entry: NonNullable<ShareTransferFacts["passport"]>["entry"], more: Partial<NonNullable<ShareTransferFacts["passport"]>> = {}) => ({
  passport: { ...facts().passport!, entry, ...more },
});

function run(f: ShareTransferFacts, amount: string | bigint = "5000") {
  const verdict = shareTransferChecks(f, { amount, nowSec: NOW });
  const row = (id: string) => verdict.checks.find((c) => c.id === id);
  const failed = verdict.checks.filter((c) => !c.ok).map((c) => c.id);
  return { verdict, row, failed };
}

describe("shareTransferChecks", () => {
  it("all green: an approved, unexpired passport in an allowed country, with its expiry date", () => {
    const { verdict, row, failed } = run(facts());
    expect(failed).toEqual([]);
    expect(verdict.ok).toBe(true);
    expect(verdict.amount).toBe(BigInt(5_000));
    expect(verdict.passportExpiry).toBe(EXPIRY);
    expect(row("passport")!.text).toBe("The recipient has an approved investor passport, valid until 3 October 2027.");
    expect(row("jurisdiction")!.text).toBe("The passport country, Serbia, is allowed.");
    expect(row("amount")!.text).toBe("You hold 5,000 tokens; 5,000 will be sent.");
    expect(verdict.checks.map((c) => c.id)).toEqual([
      "recipient-self", "recipient-wallet", "amount", "sender-blocklist", "recipient-blocklist", "passport", "jurisdiction",
    ]);
  });

  it("no passport", () => {
    const { verdict, row, failed } = run(facts(passportWith("none")));
    expect(verdict.ok).toBe(false);
    expect(failed).toEqual(["passport"]);
    expect(row("passport")!.text).toBe("The recipient has no investor passport in this class's KYC registry (5Mof…Lhku). Issue one first.");
  });

  it("pending and revoked passports", () => {
    expect(run(facts(passportWith({ status: KycStatus.Pending, expiry: EXPIRY, jurisdiction: SERBIA })))).toMatchObject({ failed: ["passport"] });
    expect(run(facts(passportWith({ status: KycStatus.Pending, expiry: EXPIRY, jurisdiction: SERBIA }))).row("passport")!.text).toMatch(/pending/);
    expect(run(facts(passportWith({ status: KycStatus.Revoked, expiry: EXPIRY, jurisdiction: SERBIA }))).row("passport")!.text).toMatch(/revoked/);
    expect(run(facts(passportWith({ status: KycStatus.Expired, expiry: EXPIRY, jurisdiction: SERBIA }))).row("passport")!.text).toMatch(/marked expired/);
  });

  it("expired: expiry at now (the hook needs expiry > now), and expiry 0", () => {
    const atNow = run(facts(passportWith({ status: KycStatus.Approved, expiry: BigInt(NOW), jurisdiction: SERBIA })));
    expect(atNow.failed).toEqual(["passport"]);
    expect(atNow.row("passport")!.text).toBe("The recipient's investor passport expired on 3 October 2026. It must be renewed first.");
    const zero = run(facts(passportWith({ status: KycStatus.Approved, expiry: BigInt(0), jurisdiction: SERBIA })));
    expect(zero.failed).toEqual(["passport"]);
    expect(zero.row("passport")!.text).toMatch(/no expiry date, which counts as expired/);
    expect(run(facts(passportWith({ status: KycStatus.Approved, expiry: BigInt(NOW + 1), jurisdiction: SERBIA }))).verdict.ok).toBe(true);
  });

  it("country: the approved bit missing, and the blocked bit set", () => {
    const missing = run(facts(passportWith({ status: KycStatus.Approved, expiry: EXPIRY, jurisdiction: GERMANY })));
    expect(missing.failed).toEqual(["jurisdiction"]);
    expect(missing.row("jurisdiction")!.text).toBe("The passport country, Germany, is not on this class's approved list.");
    const blocked = run(facts(passportWith(
      { status: KycStatus.Approved, expiry: EXPIRY, jurisdiction: SERBIA },
      { blockedJurisdictions: jurisdictionBitmap([SERBIA]) },
    )));
    expect(blocked.failed).toEqual(["jurisdiction"]);
    expect(blocked.row("jurisdiction")!.text).toBe("The passport country, Serbia, is blocked by this class's KYC registry.");
  });

  it("the sender on the blocklist (the hook refuses it), and the recipient on it (ours)", () => {
    const sender = run(facts({ senderBlocked: true }));
    expect(sender.failed).toEqual(["sender-blocklist"]);
    expect(sender.row("sender-blocklist")!.text).toMatch(/refuses every transfer out of it/);
    expect(run(facts({ recipientBlocked: true })).failed).toEqual(["recipient-blocklist"]);
  });

  it("a send to oneself", () => {
    const { failed, row } = run(facts({ recipient: SENDER }));
    expect(failed).toContain("recipient-self");
    expect(row("recipient-self")!.text).toBe("That is your own wallet. Enter the recipient's wallet address.");
  });

  it("only a wallet may receive: PDA, token account, program, program-owned and nonce accounts are refused", () => {
    for (const [kind, pattern] of [
      ["pda", /program address \(PDA\), not a wallet/],
      ["token-account", /token account, not a wallet/],
      ["program", /a program, not a wallet/],
      ["program-owned", /belongs to a program/],
      ["system-data", /nonce account/],
    ] as const) {
      const { failed, row } = run(facts({ recipientKind: kind }));
      expect(failed, kind).toEqual(["recipient-wallet"]);
      expect(row("recipient-wallet")!.text).toMatch(pattern);
    }
    expect(run(facts({ recipientKind: "wallet" })).verdict.ok).toBe(true);
    expect(run(facts({ recipientKind: "new-wallet" })).row("recipient-wallet")!.text).toMatch(/no SOL yet/);
  });

  it("the amount: 0, more than held, not a whole number", () => {
    expect(run(facts(), "0").row("amount")!.text).toBe("Enter at least 1 token.");
    expect(run(facts(), "5001").row("amount")!.text).toBe("You hold 5,000 tokens of this class, fewer than 5,001.");
    for (const raw of ["1.5", "abc", "-1", "", "1e3", "5 000"]) {
      const { failed, verdict } = run(facts(), raw);
      expect(failed, raw).toEqual(["amount"]);
      expect(verdict.amount, raw).toBeNull();
    }
    expect(run(facts(), " 1 ").verdict.ok).toBe(true);
  });

  it("an Open class needs no passport", () => {
    const { verdict, row } = run(facts({ hook: { kind: "open" }, passport: null }));
    expect(verdict.ok).toBe(true);
    expect(row("passport")!.text).toBe("Open class: no investor passport needed.");
    expect(row("jurisdiction")).toBeUndefined();
  });

  it("fails closed: an unreadable registry, a passport record that cannot be read, a gated class without a registry", () => {
    const unreadable = run(facts(passportWith({ status: KycStatus.Approved, expiry: EXPIRY, jurisdiction: SERBIA }, { registryState: "unreadable" })));
    expect(unreadable.failed).toEqual(["passport"]);
    expect(unreadable.row("passport")!.text).toMatch(/Could not read this class's KYC registry/);
    expect(run(facts(passportWith({ status: KycStatus.Approved, expiry: EXPIRY, jurisdiction: SERBIA }, { registryState: "missing" }))).failed).toEqual(["passport"]);
    expect(run(facts(passportWith("unreadable"))).failed).toEqual(["passport"]);
    expect(run(facts({ hook: { kind: "kyc-gated", registry: null }, passport: null })).failed).toEqual(["passport"]);
  });

  it("a legacy mint without hook config, an unreadable one, and a mint with decimals", () => {
    expect(run(facts({ hook: { kind: "missing" }, passport: null })).failed).toEqual(["class"]);
    expect(run(facts({ hook: { kind: "unreadable" }, passport: null })).failed).toEqual(["class"]);
    expect(run(facts({ decimals: 6 })).failed).toEqual(["mint"]);
    expect(run(facts({ decimals: null })).failed).toEqual(["mint"]);
  });

  it("frozen token accounts", () => {
    expect(run(facts({ senderAccountFrozen: true })).failed).toEqual(["sender-account"]);
    expect(run(facts({ recipientTokenAccountFrozen: true })).failed).toEqual(["recipient-account"]);
  });
});

describe("the summary before signing", () => {
  it("names the amount, the share of the company when the total is known, and the short address", () => {
    expect(shareTransferSummary({ amount: BigInt(5_000), recipient: RECIPIENT, percent: ownershipPercent(BigInt(5_000), 5_000), company: "Mancipatio d.o.o." }))
      .toBe("Send 5,000 tokens (= 100 % of Mancipatio d.o.o.) to 7Np4…T4K2.");
    expect(shareTransferSummary({ amount: BigInt(1), recipient: RECIPIENT })).toBe("Send 1 token to 7Np4…T4K2.");
    expect(ownershipPercent(BigInt(1), 3)).toBe("33.33");
    expect(ownershipPercent(BigInt(1), null)).toBeNull();
    expect(ownershipPercent(BigInt(1), 0)).toBeNull();
    expect(formatExpiryDate(EXPIRY)).toBe("3 October 2027");
  });
});

// ── The loader, against a getMultipleAccounts stub ──────────────────────────

type Stored = { owner: Address; data: Uint8Array; executable?: boolean };

function stubRpc(accounts: Map<string, Stored>, calls: Address[][]) {
  return {
    getMultipleAccounts: (addresses: Address[]) => ({
      send: async () => {
        calls.push(addresses);
        return {
          context: { slot: BigInt(1) },
          value: addresses.map((a) => {
            const stored = accounts.get(a);
            return stored
              ? {
                  data: [Buffer.from(stored.data).toString("base64"), "base64"],
                  owner: stored.owner,
                  executable: stored.executable ?? false,
                  lamports: BigInt(1),
                  space: BigInt(stored.data.length),
                  rentEpoch: BigInt(0),
                }
              : null;
          }),
        };
      },
    }),
  } as unknown as Parameters<typeof loadShareTransferFacts>[0];
}

const bytes = (encoded: ArrayLike<number>) => Uint8Array.from(Array.from({ length: encoded.length }, (_, i) => encoded[i]));

async function world(recipient: Address, recipientAccount: Stored | null, opts: { blocked?: Address[]; entry?: boolean } = {}) {
  const accounts = new Map<string, Stored>();
  const [config] = await findConfigPda({ mint: MINT });
  accounts.set(config, {
    owner: TRANSFER_HOOK_PROGRAM_ADDRESS,
    data: bytes(getTransferHookConfigEncoder().encode({
      mint: MINT, shareClass: MINT, blocklist: MINT,
      restrictionMode: RestrictionMode.KycGated, kycRegistry: REGISTRY, version: 1, bump: 255,
    })),
  });
  accounts.set(MINT, {
    owner: TOKEN_2022,
    data: bytes(getMintEncoder().encode({
      mintAuthority: { __option: "None" }, supply: BigInt(5_000), decimals: 0, isInitialized: true,
      freezeAuthority: { __option: "None" }, extensions: { __option: "None" },
    })),
  });
  accounts.set(await tokenAccountOf(SENDER, MINT), {
    owner: TOKEN_2022,
    data: bytes(getTokenEncoder().encode({
      mint: MINT, owner: SENDER, amount: BigInt(5_000), delegate: { __option: "None" }, state: AccountState.Initialized,
      isNative: { __option: "None" }, delegatedAmount: BigInt(0), closeAuthority: { __option: "None" }, extensions: { __option: "None" },
    })),
  });
  if (recipientAccount) accounts.set(recipient, recipientAccount);
  for (const wallet of opts.blocked ?? []) {
    accounts.set(await findBlockEntryPda(wallet), {
      owner: TRANSFER_HOOK_PROGRAM_ADDRESS,
      data: bytes(getBlockEntryEncoder().encode({ wallet, addedBy: SYSTEM, bump: 255 })),
    });
  }
  accounts.set(REGISTRY, {
    owner: ASSET_REGISTRY_PROGRAM_ADDRESS,
    data: bytes(getKycRegistryEncoder().encode({
      authority: SENDER, approvedJurisdictions: jurisdictionBitmap([SERBIA]), blockedJurisdictions: jurisdictionBitmap([]),
      entriesCount: 1, version: 1, bump: 255,
    })),
  });
  if (opts.entry !== false) {
    const [entryPda] = await findKycEntryPda({ kycRegistry: REGISTRY, holder: recipient });
    accounts.set(entryPda, {
      owner: ASSET_REGISTRY_PROGRAM_ADDRESS,
      data: bytes(getKycEntryEncoder().encode({
        registry: REGISTRY, holder: recipient, status: KycStatus.Approved, jurisdiction: SERBIA, accreditationLevel: 0,
        expiry: EXPIRY, providerId: 0, externalRefHash: new Uint8Array(32), version: 1, bump: 255,
      })),
    });
  }
  return accounts;
}

describe("loadShareTransferFacts", () => {
  it("reads everything in two round trips: the config's registry, not a pin", async () => {
    const calls: Address[][] = [];
    const recipient = (await generateKeyPairSigner()).address;
    const rpc = stubRpc(await world(recipient, { owner: SYSTEM, data: new Uint8Array() }), calls);
    const f = await loadShareTransferFacts(rpc, { mint: MINT, sender: SENDER, recipient });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toHaveLength(7);
    expect(calls[1]).toEqual([(await findKycEntryPda({ kycRegistry: REGISTRY, holder: recipient }))[0], REGISTRY]);
    expect(f).toMatchObject({
      hook: { kind: "kyc-gated", registry: REGISTRY },
      decimals: 0,
      senderBalance: BigInt(5_000),
      recipientKind: "wallet",
      recipientTokenAccountExists: false,
      senderBlocked: false,
      recipientBlocked: false,
    });
    expect(f.passport!.entry).toEqual({ status: KycStatus.Approved, expiry: EXPIRY, jurisdiction: SERBIA });
    expect(shareTransferChecks(f, { amount: "5000", nowSec: NOW }).ok).toBe(true);
  });

  it("classifies the recipient address: no account, PDA, token account, program, nonce account", async () => {
    const calls: Address[][] = [];
    const wallet = (await generateKeyPairSigner()).address;
    const kindOf = async (recipient: Address, stored: Stored | null) =>
      (await loadShareTransferFacts(stubRpc(await world(recipient, stored), calls), { mint: MINT, sender: SENDER, recipient })).recipientKind;
    expect(await kindOf(wallet, null)).toBe("new-wallet");
    const [pda] = await findConfigPda({ mint: MINT });
    expect(await kindOf(pda, null)).toBe("pda");
    expect(await kindOf(wallet, { owner: TOKEN_2022, data: new Uint8Array(165) })).toBe("token-account");
    expect(await kindOf(wallet, { owner: "BPFLoaderUpgradeab1e11111111111111111111111" as Address, data: new Uint8Array(36), executable: true })).toBe("program");
    expect(await kindOf(wallet, { owner: ASSET_REGISTRY_PROGRAM_ADDRESS, data: new Uint8Array(8) })).toBe("program-owned");
    expect(await kindOf(wallet, { owner: SYSTEM, data: new Uint8Array(80) })).toBe("system-data");
  });

  it("reads both blocklist entries and a missing passport", async () => {
    const calls: Address[][] = [];
    const recipient = (await generateKeyPairSigner()).address;
    const rpc = stubRpc(await world(recipient, null, { blocked: [SENDER, recipient], entry: false }), calls);
    const f = await loadShareTransferFacts(rpc, { mint: MINT, sender: SENDER, recipient });
    expect([f.senderBlocked, f.recipientBlocked]).toEqual([true, true]);
    expect(f.passport!.entry).toBe("none");
    const { checks } = shareTransferChecks(f, { amount: "1", nowSec: NOW });
    expect(checks.filter((c) => !c.ok).map((c) => c.id)).toEqual(["sender-blocklist", "recipient-blocklist", "passport"]);
  });

  it("an RPC failure throws (the panel then offers no send)", async () => {
    const rpc = {
      getMultipleAccounts: () => ({ send: async () => { throw new Error("429 Too Many Requests"); } }),
    } as unknown as Parameters<typeof loadShareTransferFacts>[0];
    await expect(loadShareTransferFacts(rpc, { mint: MINT, sender: SENDER, recipient: RECIPIENT })).rejects.toThrow("429");
  });
});
