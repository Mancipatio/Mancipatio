// Token migration (V1) pure modules: the shared vocabulary
// (lib/token-migration/model.ts), the old-mint verdict (old-mint.ts), the
// row narrowing and public projection (rows.ts), the deterministic final
// report (report.ts) and the instructions the wallets sign
// (transactions.ts).
import { address, createNoopSigner, getAddressDecoder, isOffCurveAddress, none, some, type Address } from "@solana/kit";
import { AccountState, findAssociatedTokenPda, getMintEncoder, type Mint } from "@solana-program/token-2022";
import { describe, expect, it } from "vitest";
import { MEMO_PROGRAM_ADDRESS } from "@/lib/document-terms";
import {
  depositTransitionAllowed,
  IRREGULAR_REASONS,
  IRREGULAR_REASON_TEXT,
  migrationMemoText,
  migrationTransitionAllowed,
  MIGRATION_STATUSES,
  parseMigrationMemo,
  PUBLIC_REASON,
  TOKEN_PROGRAM_2022,
  TOKEN_PROGRAM_CLASSIC,
  validSlug,
  validWindow,
  windowStateAt,
  type MigrationStatus,
} from "@/lib/token-migration/model";
import { inspectOldMint, oldMintVerdict } from "@/lib/token-migration/old-mint";
import { parseDepositRow, parseMigrationRow, publicMigration, RowShapeError, type DepositRow, type MigrationRow } from "@/lib/token-migration/rows";
import { buildFinalReport, canonicalReportJson, sha256Hex } from "@/lib/token-migration/report";
import { associatedTokenAccount, buildBurnInstructions, buildDepositInstructions, buildOpenDepositAccount, buildRefundInstructions } from "@/lib/token-migration/transactions";

const key = (seed: number) => getAddressDecoder().decode(new Uint8Array(32).fill(seed)).toString();
const B = (v: number | string) => BigInt(v);
const MIGRATION = "3f2a9c1e-8b7d-4e6f-9a0b-1c2d3e4f5a6b";

describe("model", () => {
  it("writes and reads the deposit memo, and tells ours from others and from malformed ones", () => {
    const text = migrationMemoText(MIGRATION, B(12));
    expect(text).toBe(`manci:migration:v1:${MIGRATION}:12`);
    expect(parseMigrationMemo(text)).toEqual({ kind: "migration", migrationId: MIGRATION, lots: B(12) });
    expect(parseMigrationMemo("hello")).toEqual({ kind: "other" });
    for (const bad of [`manci:migration:v1:${MIGRATION}:0`, `manci:migration:v1:${MIGRATION}:-1`, `manci:migration:v1:${MIGRATION.toUpperCase()}:1`, `manci:migration:v1:${MIGRATION}:1:x`, "manci:migration:v1:"]) {
      expect(parseMigrationMemo(bad), bad).toEqual({ kind: "malformed" });
    }
    expect(() => migrationMemoText("not-a-uuid", B(1))).toThrow();
    expect(() => migrationMemoText(MIGRATION, B(0))).toThrow();
  });

  it("validates the window (60–90 days) and says where a moment falls", () => {
    expect(validWindow("2027-01-01T00:00:00Z", "2027-03-02T00:00:00Z")).toBe(true); // 60 days
    expect(validWindow("2027-01-01T00:00:00Z", "2027-04-01T00:00:00Z")).toBe(true); // 90 days
    expect(validWindow("2027-01-01T00:00:00Z", "2027-03-01T23:59:59Z")).toBe(false);
    expect(validWindow("2027-01-01T00:00:00Z", "2027-04-01T00:00:01Z")).toBe(false);
    expect(validWindow("nope", "2027-04-01T00:00:00Z")).toBe(false);
    const [o, c] = ["2027-01-01T00:00:00Z", "2027-03-17T00:00:00Z"];
    expect(windowStateAt(o, c, Date.parse("2026-12-31T23:59:59Z"))).toBe("not_yet");
    expect(windowStateAt(o, c, Date.parse(o))).toBe("open");
    expect(windowStateAt(o, c, Date.parse(c))).toBe("ended");
  });

  it("mirrors the 0085 lifecycle guards", () => {
    const allowed: Array<[MigrationStatus, MigrationStatus]> = [["draft", "open"], ["draft", "cancelled"], ["open", "closed"], ["open", "cancelled"], ["closed", "completed"], ["closed", "cancelled"]];
    for (const from of MIGRATION_STATUSES) {
      for (const to of MIGRATION_STATUSES) {
        expect(migrationTransitionAllowed(from, to), `${from} -> ${to}`).toBe(allowed.some(([f, t]) => f === from && t === to));
      }
    }
    expect(depositTransitionAllowed("accepted", "delivered", "open")).toBe(true);
    expect(depositTransitionAllowed("accepted", "refunded", "open")).toBe(false);
    expect(depositTransitionAllowed("accepted", "refunded", "cancelled")).toBe(true);
    expect(depositTransitionAllowed("irregular", "refunded", "closed")).toBe(true);
    expect(depositTransitionAllowed("irregular", "delivered", "open")).toBe(false);
    expect(depositTransitionAllowed("delivered", "refunded", "cancelled")).toBe(false);
  });

  it("names every irregular reason for the operator and for the public; a compliance hold says no more than 'held for review'", () => {
    for (const r of IRREGULAR_REASONS) {
      expect(IRREGULAR_REASON_TEXT[r].length).toBeGreaterThan(10);
      expect(PUBLIC_REASON[r].length).toBeGreaterThan(5);
    }
    expect(PUBLIC_REASON.compliance_hold).toBe("Held for review");
    expect(PUBLIC_REASON.compliance_hold).not.toMatch(/sanction/i);
  });

  it("accepts url-safe slugs only", () => {
    expect(validSlug("acme-2027")).toBe(true);
    for (const bad of ["ab", "Acme", "acme--x", "-acme", "acme_", "a".repeat(65)]) expect(validSlug(bad), bad).toBe(false);
  });
});

function mint(over: Partial<Mint> = {}): Mint {
  return { mintAuthority: none(), supply: B(1_000_000), decimals: 6, isInitialized: true, freezeAuthority: none(), extensions: none(), ...over };
}

describe("old-mint verdict", () => {
  it("accepts a plain classic SPL mint from its account bytes", () => {
    const data = getMintEncoder().encode({ mintAuthority: null, supply: B(5_000_000), decimals: 6, isInitialized: true, freezeAuthority: null, extensions: null });
    const verdict = inspectOldMint({ programAddress: TOKEN_PROGRAM_CLASSIC, data: new Uint8Array(data).subarray(0, 82) });
    expect(verdict).toMatchObject({ ok: true, tokenProgram: TOKEN_PROGRAM_CLASSIC, decimals: 6, supply: B(5_000_000), refusals: [], warnings: [] });
  });

  it("refuses a Token-2022 mint with a transfer fee, from its account bytes", () => {
    const fee = { epoch: B(0), maximumFee: B(10), transferFeeBasisPoints: 50 };
    const data = getMintEncoder().encode({
      mintAuthority: null, supply: B(5_000_000), decimals: 6, isInitialized: true, freezeAuthority: null,
      extensions: [{ __kind: "TransferFeeConfig", transferFeeConfigAuthority: address(key(1)), withdrawWithheldAuthority: address(key(2)), withheldAmount: B(0), olderTransferFee: fee, newerTransferFee: fee }],
    });
    const verdict = inspectOldMint({ programAddress: TOKEN_PROGRAM_2022, data: new Uint8Array(data) });
    expect(verdict.ok).toBe(false);
    expect(verdict.tokenProgram).toBe(TOKEN_PROGRAM_2022);
    expect(verdict.refusals.map((r) => r.extension)).toEqual(["TransferFeeConfig"]);
    expect(verdict.refusals[0].reason).toContain("transfer fee");
  });

  it("refuses an account that is not a mint, or a mint of another program", () => {
    expect(() => inspectOldMint({ programAddress: TOKEN_PROGRAM_CLASSIC, data: new Uint8Array(165) })).toThrow(/not an initialized token mint/);
    expect(() => inspectOldMint({ programAddress: key(9), data: new Uint8Array(82) })).toThrow(/supported token program/);
  });

  it.each([
    ["TransferHook", { __kind: "TransferHook", authority: address(key(1)), programId: address(key(2)) }, /transfer hook/],
    ["NonTransferable", { __kind: "NonTransferable" }, /non-transferable/],
    ["PermanentDelegate", { __kind: "PermanentDelegate", delegate: address(key(1)) }, /permanent delegate/],
    ["ConfidentialTransferMint", { __kind: "ConfidentialTransferMint", authority: none(), autoApproveNewAccounts: true, auditorElgamalPubkey: none() }, /on by default/],
    ["DefaultAccountState", { __kind: "DefaultAccountState", state: AccountState.Frozen }, /start frozen/],
    ["PausableConfig", { __kind: "PausableConfig", authority: some(address(key(1))), paused: false }, /pause authority/],
    ["ConfidentialMintBurn", { __kind: "ConfidentialMintBurn" }, /confidentially/],
  ])("refuses %s and says why", (kind, extension, reason) => {
    const verdict = oldMintVerdict(TOKEN_PROGRAM_2022, mint({ extensions: some([extension as never]) }));
    expect(verdict.ok).toBe(false);
    expect(verdict.refusals).toHaveLength(1);
    expect(verdict.refusals[0].extension).toBe(kind);
    expect(verdict.refusals[0].reason).toMatch(reason);
  });

  it("accepts descriptive extensions; warns about display scaling, opt-in confidential transfers and live authorities", () => {
    const verdict = oldMintVerdict(TOKEN_PROGRAM_2022, mint({
      mintAuthority: some(address(key(3))),
      freezeAuthority: some(address(key(4))),
      extensions: some([
        { __kind: "MetadataPointer", authority: none(), metadataAddress: none() },
        { __kind: "DefaultAccountState", state: AccountState.Initialized },
        { __kind: "ConfidentialTransferMint", authority: none(), autoApproveNewAccounts: false, auditorElgamalPubkey: none() },
        { __kind: "ScaledUiAmountConfig", authority: address(key(5)), multiplier: 1, newMultiplierEffectiveTimestamp: B(0), newMultiplier: 1 },
      ] as never),
    }));
    expect(verdict.ok).toBe(true);
    expect(verdict.warnings).toHaveLength(4);
    expect(verdict.warnings.join(" ")).toMatch(/freeze authority/);
    expect(verdict.warnings.join(" ")).toMatch(/supply can still grow/);
    expect(verdict.extensions).toEqual(["MetadataPointer", "DefaultAccountState", "ConfidentialTransferMint", "ScaledUiAmountConfig"]);
  });

  it("refuses a zero supply and more than 18 decimals", () => {
    expect(oldMintVerdict(TOKEN_PROGRAM_CLASSIC, mint({ supply: B(0) })).refusals.map((r) => r.extension)).toEqual(["supply"]);
    expect(oldMintVerdict(TOKEN_PROGRAM_CLASSIC, mint({ decimals: 19 })).refusals.map((r) => r.extension)).toEqual(["decimals"]);
  });
});

function migrationRow(over: Partial<MigrationRow> = {}): MigrationRow {
  return {
    id: MIGRATION, network: "devnet", slug: "acme", status: "closed", company_name: "Acme d.o.o.",
    issuer_pda: key(1), asset_pda: key(2), share_class_pda: key(3), new_mint: key(4),
    old_chain: "solana", old_mint: key(5), old_token_program: TOKEN_PROGRAM_CLASSIC, old_decimals: 0, old_symbol: "OLD", old_name: "Old",
    old_total_supply: "1000000000", excluded_wallets: [key(7), key(6)], excluded_wallet_amount: "300000000", excluded_manual_amount: "100000000",
    excluded_amount: "400000000", excluded_note: "team vesting", supply_read_at: "2027-01-01T00:00:00.000Z",
    equity_bps: 1200, granularity: 1_000_000, lot_base_units: "5000", units_cap: "120000",
    source: "founder_transfer", unclaimed_policy: "return_to_source", deposit_owner: key(8), deposit_ata: key(9),
    window_opens_at: "2027-01-01T00:00:00.000Z", window_closes_at: "2027-03-17T00:00:00.000Z",
    terms_doc_sha256: "ab".repeat(32), terms_doc_url: "https://example.com/terms.pdf", treasury_wallet: key(10),
    final_report_sha256: null, old_tokens_burn_tx: null, old_tokens_burned: null, created_by: key(11),
    opened_at: "2027-01-01T00:00:00.000Z", closed_at: "2027-03-17T01:00:00.000Z", completed_at: null, cancelled_at: null,
    created_at: "2026-12-01T00:00:00.000Z", updated_at: "2027-03-17T01:00:00.000Z",
    ...over,
  };
}
function depositRow(over: Partial<DepositRow> = {}): DepositRow {
  return {
    id: "d1", migration_id: MIGRATION, network: "devnet", holder_wallet: key(12), deposit_tx: "5".repeat(88), deposit_slot: 10,
    block_time: "2027-02-01T00:00:00.000Z", amount_base: "10000", units_due: "2", status: "delivered", reason_code: null, reason: null,
    delivery_tx: "6".repeat(88), refund_tx: null, recorded_via: "holder", delivered_at: "2027-02-02T00:00:00.000Z", refunded_at: null,
    created_at: "2027-02-01T00:00:10.000Z",
    ...over,
  };
}

describe("rows", () => {
  it("narrows rows with big amounts as decimal strings and refuses an unsafe number", () => {
    const raw = { ...migrationRow(), old_total_supply: "18446744073709551615", granularity: "1000000" };
    expect(parseMigrationRow(raw).old_total_supply).toBe("18446744073709551615");
    expect(parseMigrationRow(raw).granularity).toBe(1_000_000);
    expect(parseMigrationRow({ ...migrationRow(), units_cap: 120000 }).units_cap).toBe("120000");
    expect(() => parseMigrationRow({ ...migrationRow(), old_total_supply: 2 ** 60 })).toThrow(RowShapeError);
    expect(() => parseMigrationRow({ ...migrationRow(), status: "paused" })).toThrow(RowShapeError);
    expect(() => parseDepositRow({ ...depositRow(), reason_code: "because" })).toThrow(RowShapeError);
    expect(parseDepositRow(depositRow()).amount_base).toBe("10000");
  });

  it("publishes the campaign without the operator wallet, in chain order, with public reasons only", () => {
    const deposits = [
      depositRow({ id: "d2", deposit_slot: 20, deposit_tx: "7".repeat(88), status: "irregular", units_due: "0", delivery_tx: null, reason_code: "compliance_hold", reason: "Sanctions screening hit" }),
      depositRow(),
      depositRow({ id: "d3", deposit_slot: 15, deposit_tx: "8".repeat(88), status: "accepted", delivery_tx: null, units_due: "3", amount_base: "15000" }),
    ];
    const view = publicMigration(migrationRow(), deposits);
    expect(view).not.toHaveProperty("created_by");
    expect(view).not.toHaveProperty("network");
    expect(view.deposits.map((d) => d.deposit_tx[0])).toEqual(["5", "8", "7"]);
    expect(view.deposits[2]).toMatchObject({ status: "irregular", reason: "Held for review" });
    expect(JSON.stringify(view)).not.toMatch(/Sanctions/);
    expect(view.progress).toEqual({ depositedBase: "25000", unitsDue: "3", unitsDelivered: "2", holders: 1, deposits: 3, refundsDue: 1, refundedBase: "0" });
  });
});

describe("final report", () => {
  const deposits = [
    depositRow(),
    depositRow({ id: "d2", deposit_slot: 5, deposit_tx: "4".repeat(88), status: "refunded", units_due: "0", delivery_tx: null, refund_tx: "9".repeat(88), reason_code: "outside_window", amount_base: "7" }),
  ];
  const at = "2027-04-01T00:00:00.000Z";

  it("is deterministic: same rows, same bytes, sorted keys, chain order, amounts as strings", async () => {
    const text = buildFinalReport(migrationRow(), deposits, at);
    expect(buildFinalReport(migrationRow(), [...deposits].reverse(), at)).toBe(text);
    const report = JSON.parse(text);
    expect(canonicalReportJson(report)).toBe(text);
    expect(report.kind).toBe("manci.token-migration.final-report");
    expect(report.deposits.map((d: { slot: number }) => d.slot)).toEqual([5, 10]);
    expect(report.totals).toEqual({
      deposits: 2, holders: 1, old_tokens_exchanged: "10000", units_delivered: "2", units_unclaimed: "119998",
      delivered_equity_percent: "0.0002", old_tokens_refunded: "7",
    });
    expect(report.ratio).toMatchObject({ lot_base_units: "5000", units_cap: "120000", qualified_supply: "600000000", cap_equity_percent: "12.0000" });
    expect(report.old_token.excluded_wallets).toEqual([key(6), key(7)].sort());
    // No formatting whitespace (strings keep theirs: "team vesting").
    expect(text).not.toMatch(/\n|": |, "/);
    expect(await sha256Hex(text)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses an unsettled campaign and a deposit of another campaign", () => {
    expect(() => buildFinalReport(migrationRow(), [depositRow({ status: "accepted", delivery_tx: null })], at)).toThrow(/delivered or refunded/);
    expect(() => buildFinalReport(migrationRow(), [depositRow({ status: "irregular", units_due: "0", delivery_tx: null, reason_code: "over_cap" })], at)).toThrow(/delivered or refunded/);
    expect(() => buildFinalReport(migrationRow(), [depositRow({ migration_id: "other" })], at)).toThrow(/another campaign/);
  });

  it("hashes with SHA-256 (known vector)", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("transactions", () => {
  const holder = createNoopSigner(address(key(20)));
  const oldMint = address(key(21));

  it("builds the deposit as [create the deposit account, the memo, TransferChecked], memo signed by the holder, to a Squads-style off-curve owner", async () => {
    const [vaultPda] = await findAssociatedTokenPda({ owner: address(key(22)), mint: oldMint, tokenProgram: address(TOKEN_PROGRAM_CLASSIC) });
    expect(isOffCurveAddress(vaultPda)).toBe(true);
    const built = await buildDepositInstructions({
      holder, depositOwner: vaultPda, oldMint, oldTokenProgram: TOKEN_PROGRAM_CLASSIC, decimals: 6, migrationId: MIGRATION, lots: B(2), amount: B(10_000),
    });
    expect(built.destination).toBe(await associatedTokenAccount(vaultPda, oldMint, TOKEN_PROGRAM_CLASSIC));
    expect(built.source).toBe(await associatedTokenAccount(holder.address, oldMint, TOKEN_PROGRAM_CLASSIC));
    const [create, memo, transfer] = built.instructions;
    expect(create.programAddress).toBe("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
    expect(Array.from(create.data ?? [])).toEqual([1]);
    expect(memo.programAddress).toBe(MEMO_PROGRAM_ADDRESS);
    expect(new TextDecoder().decode(memo.data)).toBe(`manci:migration:v1:${MIGRATION}:2`);
    expect(memo.accounts?.[0]).toMatchObject({ address: holder.address, role: 2 });
    expect(transfer.programAddress).toBe(TOKEN_PROGRAM_CLASSIC);
    const data = transfer.data!;
    expect(data[0]).toBe(12);
    expect(new DataView(data.buffer, data.byteOffset).getBigUint64(1, true)).toBe(B(10_000));
    expect(data[9]).toBe(6);
    expect(transfer.accounts?.map((a) => a.address)).toEqual([built.source, oldMint, built.destination, holder.address]);
  });

  it("builds under Token-2022 too, and refuses another program or a zero amount", async () => {
    const built = await buildDepositInstructions({
      holder, depositOwner: key(22), oldMint, oldTokenProgram: TOKEN_PROGRAM_2022, decimals: 9, migrationId: MIGRATION, lots: B(1), amount: B(1),
    });
    expect(built.instructions[2].programAddress).toBe(TOKEN_PROGRAM_2022);
    await expect(buildDepositInstructions({ holder, depositOwner: key(22), oldMint, oldTokenProgram: key(23), decimals: 9, migrationId: MIGRATION, lots: B(1), amount: B(1) })).rejects.toThrow(/SPL Token or Token-2022/);
    await expect(buildDepositInstructions({ holder, depositOwner: key(22), oldMint, oldTokenProgram: TOKEN_PROGRAM_2022, decimals: 9, migrationId: MIGRATION, lots: B(1), amount: B(0) })).rejects.toThrow(/between 1/);
  });

  it("builds the opening, a refund and the burn", async () => {
    const owner = createNoopSigner(address(key(24)) as Address);
    const [open] = await buildOpenDepositAccount({ payer: holder, depositOwner: owner.address, oldMint, oldTokenProgram: TOKEN_PROGRAM_CLASSIC });
    expect(open.accounts?.[1].address).toBe(await associatedTokenAccount(owner.address, oldMint, TOKEN_PROGRAM_CLASSIC));
    const [create, back] = await buildRefundInstructions({ depositOwner: owner, holder: holder.address, oldMint, oldTokenProgram: TOKEN_PROGRAM_CLASSIC, decimals: 6, amount: B(7) });
    expect(create.accounts?.[0].address).toBe(owner.address);
    expect(back.accounts?.map((a) => a.address)).toEqual([
      await associatedTokenAccount(owner.address, oldMint, TOKEN_PROGRAM_CLASSIC), oldMint,
      await associatedTokenAccount(holder.address, oldMint, TOKEN_PROGRAM_CLASSIC), owner.address,
    ]);
    const [burn] = await buildBurnInstructions({ depositOwner: owner, oldMint, oldTokenProgram: TOKEN_PROGRAM_CLASSIC, decimals: 6, amount: B(20_000) });
    expect(burn.data?.[0]).toBe(15);
    expect(burn.accounts?.[0].address).toBe(await associatedTokenAccount(owner.address, oldMint, TOKEN_PROGRAM_CLASSIC));
  });
});
