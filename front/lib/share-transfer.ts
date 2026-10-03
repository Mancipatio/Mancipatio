// "Send to holder": an issuer authority (or a Manci Admin) moves share tokens
// of one class from its own wallet to one recipient wallet, for example a
// buyer who paid outside Manci. This is a treasury transfer only: there is no
// order book, price or listing anywhere in it, and the Terms' secondary-trading
// switch (lib/features secondaryTrading) is not involved.
//
// One transaction, two steps:
//   1. create the recipient's Token-2022 token account (idempotent: a no-op
//      when it exists; the sender pays its rent),
//   2. transfer_checked (decimals 0) with the transfer hook's accounts, built
//      from the owners' addresses (lib/hook-metas), never from the recipient's
//      token account data, so step 1 and step 2 fit in one transaction.
// The hook refuses a transfer to a wallet without an approved, unexpired
// passport in the class's KYC registry (KycGated), and any transfer out of a
// blocklisted wallet; shareTransferChecks says so in plain words before
// anything is signed, and the verified client's simulation gate re-checks the
// exact transaction.
//
// Node-safe on purpose (no React, no browser API, no lib/passport, no
// lib/supabase, no lib/siws-client): the devnet rehearsal script imports the
// same builder and checks.
import {
  fetchEncodedAccounts,
  isOffCurveAddress,
  type Address,
  type GetMultipleAccountsApi,
  type Instruction,
  type MaybeEncodedAccount,
  type ReadonlyUint8Array,
  type Rpc,
  type TransactionSigner,
} from "@solana/kit";
import {
  AccountState,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getMintDecoder,
  getTokenDecoder,
  getTransferCheckedInstruction,
} from "@solana-program/token-2022";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  findKycEntryPda,
  getKycEntryDecoder,
  getKycEntryDiscriminatorBytes,
  getKycRegistryDecoder,
  getKycRegistryDiscriminatorBytes,
  KycStatus,
} from "@/lib/generated/asset_registry";
import {
  findConfigPda,
  getTransferHookConfigDecoder,
  getTransferHookConfigDiscriminatorBytes,
  RestrictionMode,
  TRANSFER_HOOK_PROGRAM_ADDRESS,
} from "@/lib/generated/transfer_hook";
import { hookTransferMetasFor, type HookTailConfig } from "@/lib/hook-metas";
import { liveBlockEntry } from "@/lib/blocklist";
import { findBlockEntryPda } from "@/lib/pdas";
import { bitmapHasCode } from "@/lib/jurisdiction-bitmap";
import { countryName } from "@/lib/countries";

export const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" as Address;
const TOKEN_CLASSIC = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;
const SYSTEM_PROGRAM = "11111111111111111111111111111111" as Address;
const U64_MAX = BigInt("18446744073709551615");

// ── Builder ──────────────────────────────────────────────────────────────────

export type ShareTransferInput = {
  /** The class mint (Token-2022, decimals 0, the Manci transfer hook). */
  mint: Address;
  /** The sending wallet: owner of the source token account and the transfer's signer. */
  from: TransactionSigner;
  /** The recipient WALLET (its associated token account receives). */
  to: Address;
  /** Whole tokens (the mint has 0 decimals). */
  amount: bigint;
  decimals: number;
  /** The mint's hook config as read (null = none: the Open tail). */
  hookConfig: HookTailConfig | null;
  /** Pays the recipient account's rent; the sender when omitted. */
  payer?: TransactionSigner;
};

export type ShareTransfer = {
  /** [create recipient token account (idempotent), transfer_checked + hook accounts]. */
  instructions: Instruction[];
  sourceTokenAccount: Address;
  destinationTokenAccount: Address;
};

export async function tokenAccountOf(owner: Address, mint: Address): Promise<Address> {
  const [ata] = await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_2022 });
  return ata;
}

/**
 * The two instructions of a send, exactly as the wallet signs them. Refuses
 * (throws) a mint with decimals other than 0, an amount outside 1..u64 and a
 * send to the sender itself.
 */
export async function buildShareTransfer(input: ShareTransferInput): Promise<ShareTransfer> {
  const { mint, from, to, amount, decimals } = input;
  if (decimals !== 0) throw new Error(`Share tokens have 0 decimals; this mint has ${decimals}.`);
  if (typeof amount !== "bigint" || amount < BigInt(1) || amount > U64_MAX) throw new Error("The amount must be a whole number of tokens, at least 1.");
  if (to === from.address) throw new Error("The recipient is the sending wallet itself.");
  const sourceTokenAccount = await tokenAccountOf(from.address, mint);
  const destinationTokenAccount = await tokenAccountOf(to, mint);
  const createRecipientAccount = await getCreateAssociatedTokenIdempotentInstructionAsync({
    payer: input.payer ?? from,
    owner: to,
    mint,
    tokenProgram: TOKEN_2022,
  });
  const transfer = getTransferCheckedInstruction(
    { source: sourceTokenAccount, mint, destination: destinationTokenAccount, authority: from, amount, decimals },
    { programAddress: TOKEN_2022 },
  );
  const tail = await hookTransferMetasFor(input.hookConfig, mint, {
    sourceTokenAccount,
    destTokenAccount: destinationTokenAccount,
    sourceOwner: from.address,
    transferAuthority: from.address,
    destOwner: to,
  });
  return {
    instructions: [createRecipientAccount, { ...transfer, accounts: [...transfer.accounts, ...tail] }],
    sourceTokenAccount,
    destinationTokenAccount,
  };
}

// ── Facts read from chain ────────────────────────────────────────────────────

/** What the recipient address is, from its account (or its absence). */
export type RecipientKind =
  | "wallet" // system-owned, no data
  | "new-wallet" // no account yet (no SOL): still a wallet address
  | "pda" // off the ed25519 curve: a program address (only its program signs), not a personal wallet
  | "token-account" // owned by a token program: the buyer pasted a token account (often their ATA, itself a PDA)
  | "program" // executable
  | "program-owned" // owned by another program
  | "system-data"; // system-owned with data (a nonce account)

export type HookState =
  | { kind: "missing" }
  | { kind: "unreadable" }
  | { kind: "open" }
  | { kind: "kyc-gated"; registry: Address | null };

export type PassportFacts = {
  registry: Address;
  registryState: "ok" | "missing" | "unreadable";
  approvedJurisdictions: ArrayLike<number> | null;
  blockedJurisdictions: ArrayLike<number> | null;
  entry: "none" | "unreadable" | { status: KycStatus; expiry: bigint; jurisdiction: number };
};

export type ShareTransferFacts = {
  mint: Address;
  sender: Address;
  recipient: Address;
  hook: HookState;
  /** The config as the builder takes it (null when missing or unreadable). */
  hookConfig: HookTailConfig | null;
  /** The mint's decimals, or null when the mint could not be read. */
  decimals: number | null;
  senderTokenAccount: Address;
  /** 0 when the sender has no token account for this mint. */
  senderBalance: bigint;
  senderAccountFrozen: boolean;
  recipientTokenAccount: Address;
  recipientTokenAccountExists: boolean;
  recipientTokenAccountFrozen: boolean;
  recipientKind: RecipientKind;
  senderBlocked: boolean;
  recipientBlocked: boolean;
  /** KycGated with a registry: the recipient's passport and the registry; otherwise null. */
  passport: PassportFacts | null;
};

function startsWith(data: ReadonlyUint8Array, prefix: ReadonlyUint8Array): boolean {
  if (data.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i += 1) if (data[i] !== prefix[i]) return false;
  return true;
}

function readHook(account: MaybeEncodedAccount): { hook: HookState; config: HookTailConfig | null } {
  if (!account.exists) return { hook: { kind: "missing" }, config: null };
  if (account.programAddress !== TRANSFER_HOOK_PROGRAM_ADDRESS || !startsWith(account.data, getTransferHookConfigDiscriminatorBytes())) {
    return { hook: { kind: "unreadable" }, config: null };
  }
  try {
    const config = getTransferHookConfigDecoder().decode(account.data);
    if (config.restrictionMode === RestrictionMode.KycGated) {
      const registry = config.kycRegistry.__option === "Some" ? config.kycRegistry.value : null;
      return { hook: { kind: "kyc-gated", registry }, config };
    }
    return { hook: { kind: "open" }, config };
  } catch {
    return { hook: { kind: "unreadable" }, config: null };
  }
}

function readTokenAccount(account: MaybeEncodedAccount, mint: Address) {
  if (!account.exists || account.programAddress !== TOKEN_2022) return null;
  try {
    const decoded = getTokenDecoder().decode(account.data);
    if (decoded.mint !== mint) return null;
    return { amount: decoded.amount, frozen: decoded.state === AccountState.Frozen };
  } catch {
    return null;
  }
}

/**
 * The owner program first: an associated token account is itself off the
 * curve, so a pasted ATA must read as a token account (the fix the sender can
 * act on), not as a generic program address. Then the curve, then the rest.
 */
function classifyRecipient(recipient: Address, account: MaybeEncodedAccount): RecipientKind {
  if (account.exists) {
    if (account.programAddress === TOKEN_2022 || account.programAddress === TOKEN_CLASSIC) return "token-account";
    if (account.executable) return "program";
  }
  if (isOffCurveAddress(recipient)) return "pda";
  if (!account.exists) return "new-wallet";
  if (account.programAddress !== SYSTEM_PROGRAM) return "program-owned";
  return account.data.length > 0 ? "system-data" : "wallet";
}

/**
 * Reads everything the checks need in two getMultipleAccounts round trips:
 * the hook config, the mint, both token accounts, the recipient account and
 * both BlockEntry PDAs; then, for a KycGated class, the recipient's KycEntry
 * in the registry the CONFIG names (not the app's pin: the hook reads the
 * config's) and that registry. RPC failures throw: the caller shows the
 * checks as unknown and does not offer the send (fail closed).
 */
export async function loadShareTransferFacts(
  rpc: Rpc<GetMultipleAccountsApi>,
  input: { mint: Address; sender: Address; recipient: Address },
): Promise<ShareTransferFacts> {
  const { mint, sender, recipient } = input;
  const [configPda] = await findConfigPda({ mint });
  const senderTokenAccount = await tokenAccountOf(sender, mint);
  const recipientTokenAccount = await tokenAccountOf(recipient, mint);
  const senderBlockPda = await findBlockEntryPda(sender);
  const recipientBlockPda = await findBlockEntryPda(recipient);
  const [configAccount, mintAccount, senderAta, recipientAta, recipientAccount, senderBlock, recipientBlock] =
    await fetchEncodedAccounts(
      rpc,
      [configPda, mint, senderTokenAccount, recipientTokenAccount, recipient, senderBlockPda, recipientBlockPda],
      { commitment: "confirmed" },
    );

  const { hook, config } = readHook(configAccount);
  let decimals: number | null = null;
  if (mintAccount.exists && mintAccount.programAddress === TOKEN_2022) {
    try {
      decimals = getMintDecoder().decode(mintAccount.data).decimals;
    } catch {
      decimals = null;
    }
  }
  const senderHolding = readTokenAccount(senderAta, mint);
  const recipientHolding = readTokenAccount(recipientAta, mint);

  let passport: PassportFacts | null = null;
  if (hook.kind === "kyc-gated" && hook.registry) {
    const registry = hook.registry;
    const [entryPda] = await findKycEntryPda({ kycRegistry: registry, holder: recipient });
    const [entryAccount, registryAccount] = await fetchEncodedAccounts(rpc, [entryPda, registry], { commitment: "confirmed" });
    let registryState: PassportFacts["registryState"] = "missing";
    let approvedJurisdictions: ArrayLike<number> | null = null;
    let blockedJurisdictions: ArrayLike<number> | null = null;
    if (registryAccount.exists) {
      registryState = "unreadable";
      if (registryAccount.programAddress === ASSET_REGISTRY_PROGRAM_ADDRESS && startsWith(registryAccount.data, getKycRegistryDiscriminatorBytes())) {
        try {
          const decoded = getKycRegistryDecoder().decode(registryAccount.data);
          approvedJurisdictions = Uint8Array.from(decoded.approvedJurisdictions);
          blockedJurisdictions = Uint8Array.from(decoded.blockedJurisdictions);
          registryState = "ok";
        } catch {
          registryState = "unreadable";
        }
      }
    }
    let entry: PassportFacts["entry"] = "none";
    // The hook: an entry not owned by asset_registry, or empty, is "no KYC".
    if (entryAccount.exists && entryAccount.programAddress === ASSET_REGISTRY_PROGRAM_ADDRESS && entryAccount.data.length > 0) {
      entry = "unreadable";
      if (startsWith(entryAccount.data, getKycEntryDiscriminatorBytes())) {
        try {
          const decoded = getKycEntryDecoder().decode(entryAccount.data);
          entry = { status: decoded.status, expiry: decoded.expiry, jurisdiction: decoded.jurisdiction };
        } catch {
          entry = "unreadable";
        }
      }
    }
    passport = { registry, registryState, approvedJurisdictions, blockedJurisdictions, entry };
  }

  return {
    mint,
    sender,
    recipient,
    hook,
    hookConfig: config,
    decimals,
    senderTokenAccount,
    senderBalance: senderHolding?.amount ?? BigInt(0),
    senderAccountFrozen: senderHolding?.frozen ?? false,
    recipientTokenAccount,
    recipientTokenAccountExists: recipientAta.exists,
    recipientTokenAccountFrozen: recipientHolding?.frozen ?? false,
    recipientKind: classifyRecipient(recipient, recipientAccount),
    senderBlocked: liveBlockEntry(senderBlock, sender) !== null,
    recipientBlocked: liveBlockEntry(recipientBlock, recipient) !== null,
    passport,
  };
}

// ── Checks (pure) ────────────────────────────────────────────────────────────

export type ShareTransferCheck = { id: string; ok: boolean; text: string };

export type ShareTransferVerdict = {
  /** True only when every check passed. */
  ok: boolean;
  checks: ShareTransferCheck[];
  /** The parsed amount, or null when it is not a valid whole number. */
  amount: bigint | null;
  /** The recipient passport's expiry (unix seconds) when there is one. */
  passportExpiry: bigint | null;
};

/** "1,234,567" (en-US grouping, the rest of the UI's style). */
export function formatTokens(amount: bigint): string {
  return amount.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** "8xYz…AbCd". */
export function shortAddress(address: string): string {
  return address.length > 10 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;
}

/** "3 October 2027" (UTC, so the same everywhere). */
export function formatExpiryDate(expiry: bigint | number): string {
  return new Date(Number(expiry) * 1000).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** A whole number of tokens from the input box: digits only (share tokens have 0 decimals). */
export function parseTokenAmount(raw: string | bigint): bigint | null {
  if (typeof raw === "bigint") return raw;
  const value = raw.trim();
  if (!/^\d+$/.test(value)) return null;
  const amount = BigInt(value);
  return amount > U64_MAX ? null : amount;
}

/**
 * The share of the company `amount` tokens are, as "100", "33.33", "< 0.01"
 * or "> 99.99", when the total is known. Only an amount equal to the total
 * reads "100" and only 0 reads "0": a partial amount that rounds to either
 * end is shown as "< 0.01" or "> 99.99", never as all or nothing.
 */
export function ownershipPercent(amount: bigint, totalShares: number | null | undefined): string | null {
  if (!totalShares || !Number.isFinite(totalShares) || totalShares <= 0) return null;
  const percent = (Number(amount) / totalShares) * 100;
  if (!Number.isFinite(percent)) return null;
  const whole = Number.isSafeInteger(totalShares) ? amount === BigInt(totalShares) : Number(amount) === totalShares;
  if (amount <= BigInt(0) || whole || percent > 100) return percent.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (percent < 0.01) return "< 0.01";
  if (percent > 99.99) return "> 99.99";
  // Strictly inside [0.01, 99.99]: two decimals can no longer round to "0" or "100".
  return percent.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/** "Send 5,000 tokens (= 100 % of ACME d.o.o.) to 8xYz…AbCd." ("(< 0.01 % of …)" for a bound). */
export function shareTransferSummary(input: { amount: bigint; recipient: string; percent?: string | null; company?: string | null }): string {
  const tokens = `${formatTokens(input.amount)} ${input.amount === BigInt(1) ? "token" : "tokens"}`;
  const relation = input.percent && /^[<>]/.test(input.percent) ? "" : "= ";
  const share = input.percent && input.company ? ` (${relation}${input.percent} % of ${input.company})` : "";
  return `Send ${tokens}${share} to ${shortAddress(input.recipient)}.`;
}

const RECIPIENT_KIND_TEXT: Record<RecipientKind, { ok: boolean; text: string }> = {
  wallet: { ok: true, text: "The recipient address is a wallet." },
  "new-wallet": {
    ok: true,
    text: "The recipient address is a wallet with no SOL yet. That is fine: receiving tokens needs none.",
  },
  pda: {
    ok: false,
    text: "This is a program address, not a personal wallet; sending here is not supported in this screen.",
  },
  "token-account": {
    ok: false,
    text: "That address is a token account, not a wallet. Ask the recipient for their wallet address (the one their wallet app shows).",
  },
  program: { ok: false, text: "That address is a program, not a wallet." },
  "program-owned": {
    ok: false,
    text: "That address belongs to a program, not to a wallet. Ask the recipient for their wallet address.",
  },
  "system-data": {
    ok: false,
    text: "That address is a system account holding data (for example a nonce account), not a wallet.",
  },
};

function country(code: number): string {
  return countryName(String(code).padStart(3, "0"));
}

/**
 * The checks shown before signing, in order, each in plain words. Mirrors
 * the transfer hook (`process_execute`): the sender must not be blocklisted;
 * on a KycGated class the recipient needs an Approved KycEntry in the
 * config's registry whose expiry is still ahead (expiry ≤ now, including 0,
 * is expired) and whose country is approved and not blocked. Adds what the
 * hook does not check but a sender must know: the recipient is a different
 * wallet, a real wallet (not a PDA or a token account), not blocklisted
 * itself, and the amount is a whole number the sender holds. Fails closed:
 * anything unreadable is a failed check.
 */
export function shareTransferChecks(
  facts: ShareTransferFacts,
  input: { amount: string | bigint; nowSec: number },
): ShareTransferVerdict {
  const checks: ShareTransferCheck[] = [];
  const add = (id: string, ok: boolean, text: string) => checks.push({ id, ok, text });

  if (facts.hook.kind === "missing") {
    add("class", false, "This share class has no transfer-hook config (a legacy mint), so its tokens cannot be transferred.");
  } else if (facts.hook.kind === "unreadable") {
    add("class", false, "Could not read this share class's transfer-hook config. Try again.");
  }
  if (facts.decimals === null) {
    add("mint", false, "Could not read this share class's mint. Try again.");
  } else if (facts.decimals !== 0) {
    add("mint", false, `This mint has ${facts.decimals} decimals; only whole share tokens (0 decimals) can be sent here.`);
  }

  // The recipient.
  if (facts.recipient === facts.sender) {
    add("recipient-self", false, "That is your own wallet. Enter the recipient's wallet address.");
  } else {
    add("recipient-self", true, "The recipient is a different wallet from yours.");
  }
  const kind = RECIPIENT_KIND_TEXT[facts.recipientKind];
  add("recipient-wallet", kind.ok, kind.text);
  if (facts.recipientTokenAccountFrozen) {
    add("recipient-account", false, "The recipient's token account for this class is frozen.");
  }

  // The amount.
  const amount = parseTokenAmount(input.amount);
  const held = `${formatTokens(facts.senderBalance)} ${facts.senderBalance === BigInt(1) ? "token" : "tokens"}`;
  if (amount === null) {
    add("amount", false, "Enter the amount as a whole number of tokens (digits only).");
  } else if (amount < BigInt(1)) {
    add("amount", false, "Enter at least 1 token.");
  } else if (amount > facts.senderBalance) {
    add("amount", false, `You hold ${held} of this class, fewer than ${formatTokens(amount)}.`);
  } else {
    add("amount", true, `You hold ${held}; ${formatTokens(amount)} will be sent.`);
  }
  if (facts.senderAccountFrozen) add("sender-account", false, "Your token account for this class is frozen.");

  // The blocklist (the hook checks the sender only; the recipient is our check).
  add(
    "sender-blocklist",
    !facts.senderBlocked,
    facts.senderBlocked
      ? "Your wallet is on the Manci blocklist, so the transfer hook refuses every transfer out of it."
      : "Your wallet is not on the Manci blocklist.",
  );
  add(
    "recipient-blocklist",
    !facts.recipientBlocked,
    facts.recipientBlocked
      ? "The recipient wallet is on the Manci blocklist. Do not send tokens to it."
      : "The recipient wallet is not on the Manci blocklist.",
  );

  // The passport.
  let passportExpiry: bigint | null = null;
  if (facts.hook.kind === "open") {
    add("passport", true, "Open class: no investor passport needed.");
  } else if (facts.hook.kind === "kyc-gated") {
    const p = facts.passport;
    if (!facts.hook.registry || !p) {
      add("passport", false, "This class is KYC-gated but names no KYC registry, so no transfer can pass. Ask the Blocklist Authority to set the registry.");
    } else if (p.registryState !== "ok") {
      add("passport", false, `Could not read this class's KYC registry (${shortAddress(p.registry)}), so the passport cannot be checked. Try again.`);
    } else if (p.entry === "none") {
      add("passport", false, `The recipient has no investor passport in this class's KYC registry (${shortAddress(p.registry)}). Issue one first.`);
    } else if (p.entry === "unreadable") {
      add("passport", false, "The recipient's investor passport record could not be read.");
    } else {
      const { status, expiry, jurisdiction } = p.entry;
      passportExpiry = expiry;
      if (status === KycStatus.Pending) {
        add("passport", false, "The recipient's investor passport is still pending approval.");
      } else if (status === KycStatus.Revoked) {
        add("passport", false, "The recipient's investor passport was revoked.");
      } else if (status !== KycStatus.Approved) {
        add("passport", false, "The recipient's investor passport is marked expired. It must be renewed first.");
      } else if (expiry <= BigInt(0)) {
        add("passport", false, "The recipient's investor passport has no expiry date, which counts as expired. It must be renewed first.");
      } else if (expiry <= BigInt(input.nowSec)) {
        add("passport", false, `The recipient's investor passport expired on ${formatExpiryDate(expiry)}. It must be renewed first.`);
      } else {
        add("passport", true, `The recipient has an approved investor passport, valid until ${formatExpiryDate(expiry)}.`);
      }
      const approved = p.approvedJurisdictions !== null && bitmapHasCode(p.approvedJurisdictions, jurisdiction);
      const blocked = p.blockedJurisdictions !== null && bitmapHasCode(p.blockedJurisdictions, jurisdiction);
      if (blocked) {
        add("jurisdiction", false, `The passport country, ${country(jurisdiction)}, is blocked by this class's KYC registry.`);
      } else if (!approved) {
        add("jurisdiction", false, `The passport country, ${country(jurisdiction)}, is not on this class's approved list.`);
      } else {
        add("jurisdiction", true, `The passport country, ${country(jurisdiction)}, is allowed.`);
      }
    }
  }

  return { ok: checks.every((c) => c.ok), checks, amount, passportExpiry };
}
