// "Send to wallets" per-row checks (lib/distribution-checks): the chain facts
// of a whole list read in getMultipleAccounts calls of at most 100 accounts,
// and the table of checks each row shows — the single send's recipient,
// blocklist and passport pieces, a vault only after confirmation, and the
// sanctions screen.
import { describe, expect, it } from "vitest";
import { generateKeyPairSigner, type Address } from "@solana/kit";
import { AccountState, getMintEncoder, getTokenEncoder } from "@solana-program/token-2022";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  findKycEntryPda,
  getKycEntryEncoder,
  getKycRegistryEncoder,
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
import { tokenAccountOf, TOKEN_2022 } from "@/lib/share-transfer";
import {
  MAX_ACCOUNTS_PER_CALL,
  SCREENING_HIT_TEXT,
  SCREENING_PENDING_TEXT,
  distributionClassChecks,
  distributionRowChecks,
  loadDistributionFacts,
} from "@/lib/distribution-checks";

const MINT = "HRcahPjAhX9ssiY5WvNJxHmy5vuDL7Q6GF6J5gNGjgwC" as Address;
const SENDER = "6AnFbinF7X12mACTVEGfjWZyzYGAShEscAB5UgV3vHsP" as Address;
const REGISTRY = "5MofiJNCoCRkNg1f2Yd7368WkjiNxkZZmUTaQo7xLhku" as Address;
const SYSTEM = "11111111111111111111111111111111" as Address;
const NOW = Date.UTC(2026, 9, 3, 12) / 1000;
const SERBIA = 688;

type Stored = { owner: Address; data: Uint8Array; executable?: boolean };
const bytes = (encoded: ArrayLike<number>) => Uint8Array.from(Array.from({ length: encoded.length }, (_, i) => encoded[i]));

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
  } as unknown as Parameters<typeof loadDistributionFacts>[0];
}

async function world(opts: { mode?: RestrictionMode; blocked?: Address[]; frozen?: Address[]; existing?: Address[]; holding?: [Address, number][]; accounts?: [Address, Stored][]; passports?: Address[] } = {}) {
  const accounts = new Map<string, Stored>();
  const [config] = await findConfigPda({ mint: MINT });
  accounts.set(config, {
    owner: TRANSFER_HOOK_PROGRAM_ADDRESS,
    data: bytes(getTransferHookConfigEncoder().encode({
      mint: MINT, shareClass: MINT, blocklist: MINT,
      restrictionMode: opts.mode ?? RestrictionMode.Open,
      kycRegistry: opts.mode === RestrictionMode.KycGated ? REGISTRY : null, version: 1, bump: 255,
    })),
  });
  accounts.set(MINT, {
    owner: TOKEN_2022,
    data: bytes(getMintEncoder().encode({
      mintAuthority: { __option: "None" }, supply: BigInt(5_000), decimals: 0, isInitialized: true,
      freezeAuthority: { __option: "None" }, extensions: { __option: "None" },
    })),
  });
  const token = (owner: Address, amount: number, frozen = false) => ({
    owner: TOKEN_2022,
    data: bytes(getTokenEncoder().encode({
      mint: MINT, owner, amount: BigInt(amount), delegate: { __option: "None" },
      state: frozen ? AccountState.Frozen : AccountState.Initialized,
      isNative: { __option: "None" }, delegatedAmount: BigInt(0), closeAuthority: { __option: "None" }, extensions: { __option: "None" },
    })),
  });
  accounts.set(await tokenAccountOf(SENDER, MINT), token(SENDER, 1_000));
  for (const w of opts.existing ?? []) accounts.set(await tokenAccountOf(w, MINT), token(w, 0, (opts.frozen ?? []).includes(w)));
  for (const [w, amount] of opts.holding ?? []) accounts.set(await tokenAccountOf(w, MINT), token(w, amount));
  for (const w of opts.blocked ?? []) {
    accounts.set(await findBlockEntryPda(w), {
      owner: TRANSFER_HOOK_PROGRAM_ADDRESS,
      data: bytes(getBlockEntryEncoder().encode({ wallet: w, addedBy: SYSTEM, bump: 255 })),
    });
  }
  for (const [a, stored] of opts.accounts ?? []) accounts.set(a, stored);
  accounts.set(REGISTRY, {
    owner: ASSET_REGISTRY_PROGRAM_ADDRESS,
    data: bytes(getKycRegistryEncoder().encode({
      authority: SENDER, approvedJurisdictions: jurisdictionBitmap([SERBIA]), blockedJurisdictions: jurisdictionBitmap([]),
      entriesCount: 1, version: 1, bump: 255,
    })),
  });
  for (const holder of opts.passports ?? []) {
    const [entry] = await findKycEntryPda({ kycRegistry: REGISTRY, holder });
    accounts.set(entry, {
      owner: ASSET_REGISTRY_PROGRAM_ADDRESS,
      data: bytes(getKycEntryEncoder().encode({
        registry: REGISTRY, holder, status: KycStatus.Approved, jurisdiction: SERBIA, accreditationLevel: 0,
        expiry: BigInt(NOW + 86_400), providerId: 0, externalRefHash: new Uint8Array(32), version: 1, bump: 255,
      })),
    });
  }
  return accounts;
}

async function wallets(count: number): Promise<Address[]> {
  return Promise.all(Array.from({ length: count }, async () => (await generateKeyPairSigner()).address));
}

describe("loadDistributionFacts", () => {
  it("reads 4 shared + 3 per row accounts in calls of at most 100 (32 rows in the first)", async () => {
    const calls: Address[][] = [];
    const recipients = await wallets(70);
    const facts = await loadDistributionFacts(stubRpc(await world(), calls), { mint: MINT, sender: SENDER, recipients });
    expect(calls.map((c) => c.length)).toEqual([100, 100, 14]);
    expect(calls.every((c) => c.length <= MAX_ACCOUNTS_PER_CALL)).toBe(true);
    expect(facts.rows.size).toBe(70);
    expect(facts).toMatchObject({ hook: { kind: "open" }, decimals: 0, senderBalance: BigInt(1_000), senderBlocked: false });
  });

  it("a KycGated class adds each row's passport and the registry once", async () => {
    const calls: Address[][] = [];
    const [ok, none] = await wallets(2);
    const facts = await loadDistributionFacts(stubRpc(await world({ mode: RestrictionMode.KycGated, passports: [ok] }), calls), {
      mint: MINT, sender: SENDER, recipients: [ok, none],
    });
    expect(calls.map((c) => c.length)).toEqual([10, 3]);
    expect(calls[1][0]).toBe(REGISTRY);
    const pass = (w: Address) => distributionRowChecks(facts, { wallet: w, amount: BigInt(1) }, { nowSec: NOW, screening: "clear" });
    expect(pass(ok).ok).toBe(true);
    expect(pass(none).checks.find((c) => c.id === "passport")?.ok).toBe(false);
  });

  it("keeps each recipient's balance of the mint (the panel asks before paying a holder again)", async () => {
    const [holder, empty, fresh] = await wallets(3);
    const facts = await loadDistributionFacts(stubRpc(await world({ holding: [[holder, 40]], existing: [empty] }), []), {
      mint: MINT, sender: SENDER, recipients: [holder, empty, fresh],
    });
    expect(facts.rows.get(holder)?.recipientBalance).toBe(BigInt(40));
    expect(facts.rows.get(empty)?.recipientBalance).toBe(BigInt(0));
    expect(facts.rows.get(fresh)).toMatchObject({ recipientBalance: BigInt(0), recipientTokenAccountExists: false });
  });
});

describe("per-row checks", () => {
  it("one table: self, wallet kind, frozen account, blocklist, screen", async () => {
    const [fine, existing, frozen, blocked, tokenAccountOwner] = await wallets(5);
    const ata = await tokenAccountOf(tokenAccountOwner, MINT);
    const program = (await generateKeyPairSigner()).address;
    const [vault] = await findConfigPda({ mint: SENDER }); // an off-curve address with no account: a vault candidate
    const [squadsConfig] = await findConfigPda({ mint: fine }); // off-curve and owned by a program
    const world0 = await world({
      existing: [existing, frozen],
      frozen: [frozen],
      blocked: [blocked],
      accounts: [
        [ata, { owner: TOKEN_2022, data: new Uint8Array(165) }],
        [program, { owner: "BPFLoaderUpgradeab1e11111111111111111111111" as Address, data: new Uint8Array(36), executable: true }],
        [squadsConfig, { owner: ASSET_REGISTRY_PROGRAM_ADDRESS, data: new Uint8Array(8) }],
      ],
    });
    const recipients = [fine, existing, frozen, blocked, ata, program, vault, squadsConfig, SENDER];
    const facts = await loadDistributionFacts(stubRpc(world0, []), { mint: MINT, sender: SENDER, recipients });
    const verdict = (w: Address, screening: "clear" | "hit" | "unknown" = "clear", vaultConfirmed = false) =>
      distributionRowChecks(facts, { wallet: w, amount: BigInt(10) }, { nowSec: NOW, screening, vaultConfirmed });

    expect(verdict(fine)).toMatchObject({ ok: true, problem: null, createsAccount: true, confirmableVault: false });
    expect(verdict(existing)).toMatchObject({ ok: true, createsAccount: false });
    expect(verdict(frozen).problem).toBe("The recipient's token account for this class is frozen.");
    expect(verdict(blocked).problem).toBe("The recipient wallet is on the Manci blocklist. Do not send tokens to it.");
    expect(verdict(ata).problem).toMatch(/^That address is a token account, not a wallet/);
    expect(verdict(program).problem).toBe("That address is a program, not a wallet.");
    expect(verdict(SENDER).problem).toBe("That is your own wallet. Enter the recipient's wallet address.");
    // A program address with no data: a vault (Squads), only after an explicit confirmation.
    expect(verdict(vault)).toMatchObject({ ok: false, confirmableVault: true });
    expect(verdict(vault).problem).toMatch(/Send only after you confirm it below/);
    expect(verdict(vault, "clear", true)).toMatchObject({ ok: true, confirmableVault: false });
    // A program address that holds a program's data (a multisig's config account) stays refused.
    expect(verdict(squadsConfig, "clear", true).problem).toMatch(/use its vault address, not the multisig account/);
    // The screen: a hit blocks the row; not screened yet is not "ok" but not a failed check either.
    expect(verdict(fine, "hit")).toMatchObject({ ok: false, problem: SCREENING_HIT_TEXT });
    expect(verdict(fine, "unknown")).toMatchObject({ ok: false, problem: SCREENING_PENDING_TEXT });
    expect(verdict(fine, "unknown").checks.every((c) => c.ok)).toBe(true);
  });

  it("the class and the sender are checked once for the list", async () => {
    const facts = await loadDistributionFacts(stubRpc(await world({ blocked: [SENDER] }), []), { mint: MINT, sender: SENDER, recipients: [] });
    expect(distributionClassChecks(facts).filter((c) => !c.ok).map((c) => c.id)).toEqual(["sender-blocklist"]);
    const missing = await loadDistributionFacts(stubRpc(new Map(), []), { mint: MINT, sender: SENDER, recipients: [] });
    expect(distributionClassChecks(missing).filter((c) => !c.ok).map((c) => c.id)).toEqual(["class", "mint"]);
  });

  it("a row the loader did not read fails closed", async () => {
    const facts = await loadDistributionFacts(stubRpc(await world(), []), { mint: MINT, sender: SENDER, recipients: [] });
    const [other] = await wallets(1);
    expect(distributionRowChecks(facts, { wallet: other, amount: BigInt(1) }, { nowSec: NOW, screening: "clear" })).toMatchObject({ ok: false });
  });
});
