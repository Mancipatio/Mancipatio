// "Send to wallets": what is read from chain for a whole list, and the checks
// each row shows before anything is signed (design §3, "Per-row checks").
//
// Reads: the class (hook config, mint), the sender (token account, blocklist
// entry) once, and per row the wallet account, its token account and its
// blocklist entry — 4 + 3 per row addresses in getMultipleAccounts calls of
// at most 100 accounts (32 rows in the first call, 33 after). A KycGated
// class adds each row's KycEntry and the registry once.
//
// Checks: the class and sender pieces of lib/share-transfer (class readable,
// 0 decimals, sender not blocklisted or frozen) once; per row the recipient
// pieces (not the sender, a wallet and not a PDA / token account / program /
// nonce account, its token account not frozen, not blocklisted) and, on a
// KycGated class, the passport. A program address (a Squads vault is one)
// passes only after an explicit confirmation, and only when it holds no
// program's data. The sanctions screen (/api/compliance/screen-recipients)
// is applied on top: a hit blocks that row.
//
// Node-safe (no React, no browser API): tests/distribution-checks.test.ts.
import {
  fetchEncodedAccounts,
  type Address,
  type GetMultipleAccountsApi,
  type MaybeEncodedAccount,
  type Rpc,
} from "@solana/kit";
import { getMintDecoder } from "@solana-program/token-2022";
import { findKycEntryPda } from "@/lib/generated/asset_registry";
import { findConfigPda } from "@/lib/generated/transfer_hook";
import type { HookTailConfig } from "@/lib/hook-metas";
import { liveBlockEntry } from "@/lib/blocklist";
import { findBlockEntryPda } from "@/lib/pdas";
import {
  TOKEN_2022,
  RECIPIENT_KIND_TEXT,
  classChecks,
  classifyRecipient,
  passportChecks,
  readHook,
  readPassport,
  readTokenAccount,
  recipientBlocklistCheck,
  recipientChecks,
  senderBlocklistCheck,
  tokenAccountOf,
  type HookState,
  type PassportFacts,
  type RecipientKind,
  type ShareTransferCheck,
} from "@/lib/share-transfer";

/** getMultipleAccounts takes at most 100 accounts per call. */
export const MAX_ACCOUNTS_PER_CALL = 100;
const SYSTEM_PROGRAM = "11111111111111111111111111111111";

/** RecipientKind plus "vault": a program address that holds no program's data (a Squads vault is one). */
export type DistributionRecipientKind = RecipientKind | "vault";

export type DistributionRowFacts = {
  recipient: Address;
  recipientTokenAccount: Address;
  recipientTokenAccountExists: boolean;
  recipientTokenAccountFrozen: boolean;
  /** Tokens of the mint the recipient already holds (shown, and asked about before paying it again). */
  recipientBalance: bigint;
  recipientKind: DistributionRecipientKind;
  recipientBlocked: boolean;
  passport: PassportFacts | null;
};

export type DistributionFacts = {
  mint: Address;
  sender: Address;
  hook: HookState;
  hookConfig: HookTailConfig | null;
  decimals: number | null;
  senderTokenAccount: Address;
  senderBalance: bigint;
  senderAccountExists: boolean;
  senderAccountFrozen: boolean;
  senderBlocked: boolean;
  /** By recipient wallet. */
  rows: Map<string, DistributionRowFacts>;
};

/** The addresses in chunks of at most `size` (one getMultipleAccounts each), in order. */
export async function fetchChunked(
  rpc: Rpc<GetMultipleAccountsApi>,
  addresses: readonly Address[],
  size = MAX_ACCOUNTS_PER_CALL,
): Promise<MaybeEncodedAccount[]> {
  const out: MaybeEncodedAccount[] = [];
  for (let i = 0; i < addresses.length; i += size) {
    out.push(...(await fetchEncodedAccounts(rpc, addresses.slice(i, i + size), { commitment: "confirmed" })));
  }
  return out;
}

/**
 * A recipient address, refined for a distribution: a program address
 * (off-curve) is a "vault" — sendable after confirmation — only while it
 * has no account or a system-owned one without data (what a Squads vault
 * is); one that holds a program's data (a multisig's config account, a
 * registry PDA) stays "program-owned".
 */
export function classifyDistributionRecipient(recipient: Address, account: MaybeEncodedAccount): DistributionRecipientKind {
  const kind = classifyRecipient(recipient, account);
  if (kind !== "pda") return kind;
  if (!account.exists) return "vault";
  return account.programAddress === SYSTEM_PROGRAM && account.data.length === 0 ? "vault" : "program-owned";
}

/**
 * Everything the checks need for a list, in getMultipleAccounts calls of at
 * most 100 accounts. RPC failures throw: the panel then offers no send (fail
 * closed).
 */
export async function loadDistributionFacts(
  rpc: Rpc<GetMultipleAccountsApi>,
  input: { mint: Address; sender: Address; recipients: readonly Address[] },
): Promise<DistributionFacts> {
  const { mint, sender } = input;
  const recipients = [...new Set(input.recipients)];
  const [configPda] = await findConfigPda({ mint });
  const senderTokenAccount = await tokenAccountOf(sender, mint);
  const senderBlockPda = await findBlockEntryPda(sender);
  const perRow = await Promise.all(
    recipients.map(async (recipient) => ({
      recipient,
      ata: await tokenAccountOf(recipient, mint),
      block: await findBlockEntryPda(recipient),
    })),
  );
  const addresses: Address[] = [configPda, mint, senderTokenAccount, senderBlockPda];
  for (const r of perRow) addresses.push(r.recipient, r.ata, r.block);
  const accounts = await fetchChunked(rpc, addresses);
  const [configAccount, mintAccount, senderAta, senderBlock] = accounts;

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

  // KycGated: each recipient's KycEntry in the registry the CONFIG names, and the registry once.
  const passports = new Map<string, PassportFacts>();
  if (hook.kind === "kyc-gated" && hook.registry) {
    const registry = hook.registry;
    const entries = await Promise.all(
      perRow.map(async (r) => (await findKycEntryPda({ kycRegistry: registry, holder: r.recipient }))[0]),
    );
    const read = await fetchChunked(rpc, [registry, ...entries]);
    const registryAccount = read[0];
    perRow.forEach((r, i) => passports.set(r.recipient, readPassport(registry, registryAccount, read[i + 1])));
  }

  const rows = new Map<string, DistributionRowFacts>();
  perRow.forEach((r, i) => {
    const [walletAccount, ataAccount, blockAccount] = accounts.slice(4 + i * 3, 7 + i * 3);
    const holding = readTokenAccount(ataAccount, mint);
    rows.set(r.recipient, {
      recipient: r.recipient,
      recipientTokenAccount: r.ata,
      recipientTokenAccountExists: ataAccount.exists,
      recipientTokenAccountFrozen: holding?.frozen ?? false,
      recipientBalance: holding?.amount ?? BigInt(0),
      recipientKind: classifyDistributionRecipient(r.recipient, walletAccount),
      recipientBlocked: liveBlockEntry(blockAccount, r.recipient) !== null,
      passport: passports.get(r.recipient) ?? null,
    });
  });

  return {
    mint,
    sender,
    hook,
    hookConfig: config,
    decimals,
    senderTokenAccount,
    senderBalance: senderHolding?.amount ?? BigInt(0),
    senderAccountExists: senderAta.exists,
    senderAccountFrozen: senderHolding?.frozen ?? false,
    senderBlocked: liveBlockEntry(senderBlock, sender) !== null,
    rows,
  };
}

// ── Checks (pure) ────────────────────────────────────────────────────────────

/** The checks that hold for the whole list: the class and the sending wallet. */
export function distributionClassChecks(facts: DistributionFacts): ShareTransferCheck[] {
  const checks = [...classChecks(facts)];
  if (facts.senderAccountFrozen) checks.push({ id: "sender-account", ok: false, text: "Your token account for this class is frozen." });
  checks.push(senderBlocklistCheck(facts.senderBlocked));
  return checks;
}

const VAULT_TEXT = {
  unconfirmed: {
    ok: false,
    text: "This is a program address (for example a Squads vault), not a personal wallet. Send only after you confirm it below.",
  },
  confirmed: { ok: true, text: "A program address you confirmed as a vault (for example a Squads vault)." },
};

const PROGRAM_OWNED_TEXT = {
  ok: false,
  text: "That address belongs to a program, not to a wallet. For a Squads multisig, use its vault address, not the multisig account.",
};

/** The sanctions screen's answer for one wallet. */
export type ScreeningState = "clear" | "hit" | "unknown";

export type RowVerdict = {
  wallet: Address;
  amount: bigint;
  checks: ShareTransferCheck[];
  /** Every check passed, the screen included. */
  ok: boolean;
  /** The first failed check's words (or the screen still to run), for the row. */
  problem: string | null;
  /** A program address the issuer may still confirm (a Squads vault). */
  confirmableVault: boolean;
  /** The recipient's token account must be created (about 0.002 SOL). */
  createsAccount: boolean;
};

export const SCREENING_HIT_TEXT = "This wallet cannot receive tokens through Manci — contact the compliance team.";
export const SCREENING_PENDING_TEXT = "Sanctions screening runs when you send.";

/**
 * One row's checks, in order: the recipient pieces of the single send, the
 * blocklist, the passport (KycGated), then the sanctions screen. Missing
 * chain facts fail closed.
 */
export function distributionRowChecks(
  facts: DistributionFacts,
  row: { wallet: Address; amount: bigint },
  opts: { nowSec: number; screening: ScreeningState; vaultConfirmed?: boolean },
): RowVerdict {
  const rf = facts.rows.get(row.wallet);
  if (!rf) {
    const text = "This wallet was not read from the network yet. Check again.";
    return {
      wallet: row.wallet,
      amount: row.amount,
      checks: [{ id: "facts", ok: false, text }],
      ok: false,
      problem: text,
      confirmableVault: false,
      createsAccount: false,
    };
  }
  const kindText =
    rf.recipientKind === "vault"
      ? opts.vaultConfirmed
        ? VAULT_TEXT.confirmed
        : VAULT_TEXT.unconfirmed
      : rf.recipientKind === "program-owned"
        ? PROGRAM_OWNED_TEXT
        : RECIPIENT_KIND_TEXT[rf.recipientKind];
  const checks: ShareTransferCheck[] = [
    ...recipientChecks({ ...rf, sender: facts.sender, recipientKind: rf.recipientKind === "vault" ? "pda" : rf.recipientKind }, kindText),
    recipientBlocklistCheck(rf.recipientBlocked),
  ];
  if (facts.hook.kind === "kyc-gated") checks.push(...passportChecks(facts.hook, rf.passport, opts.nowSec).checks);
  if (opts.screening === "hit") checks.push({ id: "sanctions", ok: false, text: SCREENING_HIT_TEXT });
  else if (opts.screening === "clear") checks.push({ id: "sanctions", ok: true, text: "Sanctions screening: clear." });
  const failed = checks.find((c) => !c.ok);
  return {
    wallet: row.wallet,
    amount: row.amount,
    checks,
    ok: !failed && opts.screening === "clear",
    problem: failed?.text ?? (opts.screening === "unknown" ? SCREENING_PENDING_TEXT : null),
    confirmableVault: rf.recipientKind === "vault" && !opts.vaultConfirmed,
    createsAccount: !rf.recipientTokenAccountExists,
  };
}
