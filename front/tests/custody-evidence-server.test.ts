import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ query: vi.fn(), vault: vi.fn(), closed: vi.fn(), deposit: vi.fn(), passport: vi.fn(), transaction: vi.fn(), verify: vi.fn(), admin: vi.fn(), filters: [] as unknown[][], updates: [] as Record<string, unknown>[] }));
vi.mock("@/lib/network", () => ({ detectNetwork: () => "devnet" }));
vi.mock("@/lib/server/rpc", () => ({ getServerRpc: () => ({ getTransaction: (...args: unknown[]) => ({ send: (options: unknown) => mocks.transaction(...args, options) }) }) }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseAdmin: () => ({ from: (table: string) => {
  let mutation = false; const filters: unknown[][] = [];
  const q = { select: () => q, abortSignal: () => q, update: (patch: Record<string, unknown>) => { mutation = true; mocks.updates.push(patch); return q; },
    eq: (...args: unknown[]) => { filters.push(args); mocks.filters.push([table, ...args]); return q; },
    maybeSingle: () => mocks.query(table, mutation, filters) }; return q;
} }) }));
vi.mock("@/lib/server/chain-evidence", async (original) => ({ ...await original<typeof import("@/lib/server/chain-evidence")>(), requireRequestVault: mocks.vault, closedRequestVault: mocks.closed, requireDepositEvidence: mocks.deposit, requireBeneficiaryPassport: mocks.passport }));
vi.mock("@/lib/server/siws", async (original) => ({ ...await original<typeof import("@/lib/server/siws")>(), verifySigned: mocks.verify }));
vi.mock("@/lib/server/admin-gate", () => ({ requireAdmin: mocks.admin }));
import { address, createNoopSigner, getAddressDecoder, getBase58Decoder, type Instruction, type ReadonlyUint8Array } from "@solana/kit";
import { getReturnCustodyVaultInstruction, getRealizeCustodyVaultInstruction, VaultState } from "@/lib/generated/asset_registry";
import { TOKEN_2022_PROGRAM, type ChainTransaction } from "@/lib/chain-evidence";
import { recordCustodyReturn, recordCustodyDeposit, validateCustodyUpdate } from "@/lib/server/custody-evidence";
import { SiwsError } from "@/lib/server/siws";
import { ClosedCustodyVaultError } from "@/lib/server/chain-evidence";
import { POST as deliveryReclaim } from "@/app/api/delivery/reclaim/route";
import { POST as conversionReclaim } from "@/app/api/conversion/reclaim/route";
import { POST as deliveryAdmin } from "@/app/api/delivery/admin-update/route";
import { POST as conversionAdmin } from "@/app/api/conversion/admin-update/route";
const key = (n: number) => getAddressDecoder().decode(new Uint8Array(32).fill(n));
const holder = key(1), other = key(2), vault = key(3), shareClass = key(4), mint = key(5), escrow = key(6), destination = key(7);
const signature = getBase58Decoder().decode(new Uint8Array(64).fill(9));
let row: Record<string, unknown>;
const req = () => new Request("https://app.test/api/custody", { method: "POST", body: "{}" });
function evidence(kind: "return" | "realize" = "return") {
  const keys: string[] = [holder]; const at = (value: string) => { let index = keys.indexOf(value); if (index < 0) { index = keys.length; keys.push(value); } return index; };
  const compiled = (program: string, accounts: string[], data: ReadonlyUint8Array) => ({ programIdIndex: at(program), accounts: accounts.map(at), data: getBase58Decoder().decode(data) });
  const compile = (ix: Instruction & { data: ReadonlyUint8Array }) => compiled(ix.programAddress, (ix.accounts ?? []).map((a) => a.address), ix.data);
  const top = kind === "return" ? getReturnCustodyVaultInstruction({ signer: createNoopSigner(holder), shareClass, custodyVault: vault, mint, escrow, beneficiaryTokenAccount: destination, escrowMarker: escrow, tokenProgram: address(TOKEN_2022_PROGRAM), authorityAdminRecord: holder })
    : getRealizeCustodyVaultInstruction({ authority: createNoopSigner(holder), shareClass, custodyVault: vault, mint, escrow, escrowMarker: escrow, tokenProgram: address(TOKEN_2022_PROGRAM), authorityAdminRecord: holder });
  const instruction = compile(top); const data = new Uint8Array(kind === "return" ? 10 : 9); data[0] = kind === "return" ? 12 : 8; new DataView(data.buffer).setBigUint64(1, BigInt(3), true);
  const inner = compiled(TOKEN_2022_PROGRAM, kind === "return" ? [escrow, mint, destination, vault] : [escrow, mint, vault], data);
  const balanceIndex = at(kind === "return" ? destination : escrow); const owner = kind === "return" ? holder : vault;
  const tx: ChainTransaction = { slot: 123, transaction: { signatures: [signature], message: { header: { numRequiredSignatures: 1 }, accountKeys: keys, instructions: [instruction] } },
    meta: { err: null, innerInstructions: [{ index: 0, instructions: [inner] }], preTokenBalances: [{ accountIndex: balanceIndex, mint, owner, uiTokenAmount: { amount: kind === "return" ? "5" : "3", decimals: 0 } }], postTokenBalances: [{ accountIndex: balanceIndex, mint, owner, uiTokenAmount: { amount: kind === "return" ? "8" : "0", decimals: 0 } }] } };
  return tx;
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.filters.length = 0; mocks.updates.length = 0;
  row = { id: "request-id", network: "devnet", holder_wallet: holder, share_class_pda: shareClass, mint, vault_pda: vault, amount: 3, status: "deposited", deposit_tx: "original", deposit_evidence: { signature: "original", vault } };
  mocks.query.mockImplementation(async (_table, update) => ({ data: update ? { id: row.id, status: "returned" } : { ...row }, error: null }));
  mocks.vault.mockResolvedValue({ vault: { escrow, deposited: BigInt(0), state: VaultState.Active }, escrow: { amount: BigInt(7) } });
  mocks.transaction.mockResolvedValue(evidence()); mocks.deposit.mockResolvedValue({ instructionIndex: 0, slot: "122", amountAtomic: "3" });
  mocks.verify.mockResolvedValue({ wallet: holder, params: { id: row.id, outcome_tx: signature, status: "returned", holder_wallet: other } }); mocks.admin.mockResolvedValue(undefined);
});
describe("holder custody evidence and recoverable recording", () => {
  it.each([deliveryReclaim, conversionReclaim])("uses only the verified holder and exact network, with actual CPI and holder balance evidence", async (route) => {
    const response = await route(req()); expect(response.status).toBe(200);
    expect(mocks.updates[0]).toMatchObject({ status: "returned", outcome_tx: signature, outcome_evidence: { signature, vault, amountAtomic: "3", surplusRemaining: "7" } });
    expect(mocks.filters.some((f) => f[1] === "network" && f[2] === "devnet")).toBe(true);
    expect(mocks.filters.some((f) => f[1] === "status" && f[2] === "deposited")).toBe(true);
    expect(mocks.vault.mock.calls[0][1]).toBe(123);
  });
  it("rejects a different wallet before RPC or writes", async () => {
    await expect(recordCustodyReturn("delivery_requests", "request-id", other, signature)).rejects.toMatchObject({ status: 403 }); expect(mocks.transaction).not.toHaveBeenCalled(); expect(mocks.updates).toEqual([]);
  });
  it.each(["missing-cpi", "wrong-holder-delta", "failed-transaction", "unreturned-ledger"])("rejects %s before recording a return", async (kind) => {
    const tx = evidence();
    if (kind === "missing-cpi") tx.meta!.innerInstructions = [];
    if (kind === "wrong-holder-delta") tx.meta!.postTokenBalances![0].uiTokenAmount.amount = "7";
    if (kind === "failed-transaction") tx.meta!.err = { failed: true };
    if (kind === "unreturned-ledger") mocks.vault.mockResolvedValue({ vault: { escrow, deposited: BigInt(1) }, escrow: { amount: BigInt(7) } });
    mocks.transaction.mockResolvedValue(tx);
    await expect(recordCustodyReturn("delivery_requests", "request-id", holder, signature)).rejects.toMatchObject({ status: kind === "unreturned-ledger" ? 409 : 400 }); expect(mocks.updates).toEqual([]);
  });
  it("retries a verified identical return without another RPC or state change", async () => {
    Object.assign(row, { status: "returned", outcome_tx: signature, outcome_evidence: { signature, vault, amountAtomic: "3" } });
    await expect(recordCustodyReturn("delivery_requests", "request-id", holder, signature)).resolves.toEqual({ id: "request-id", status: "returned" }); expect(mocks.transaction).not.toHaveBeenCalled(); expect(mocks.updates).toEqual([]);
  });
  it("repairs an old terminal record lacking verified evidence instead of granting an unchecked fast path", async () => {
    Object.assign(row, { status: "returned", outcome_tx: signature, outcome_evidence: null });
    await expect(recordCustodyReturn("delivery_requests", "request-id", holder, signature)).resolves.toEqual({ id: "request-id", status: "returned" }); expect(mocks.transaction).toHaveBeenCalled(); expect(mocks.updates[0].outcome_evidence).toMatchObject({ signature, vault });
  });
  it("accepts return evidence when the original deposit acknowledgement was lost", async () => {
    Object.assign(row, { status: "vault_opened", deposit_tx: null, deposit_evidence: null });
    await expect(recordCustodyReturn("conversion_requests", "request-id", holder, signature)).resolves.toMatchObject({ status: "returned" });
    expect(mocks.filters).toContainEqual(["conversion_requests", "status", "vault_opened"]);
  });
  it("reports DB failures as retry-recording errors and refuses to overwrite a concurrent state change", async () => {
    mocks.query.mockImplementation(async (_table, update) => ({ data: update ? null : row, error: update ? { message: "unavailable" } : null }));
    await expect(recordCustodyReturn("delivery_requests", "request-id", holder, signature)).rejects.toMatchObject({ status: 503, message: expect.stringMatching(/without another transaction/) });
    mocks.query.mockImplementation(async (_table, update) => ({ data: update ? null : row, error: null }));
    await expect(recordCustodyReturn("delivery_requests", "request-id", holder, signature)).rejects.toMatchObject({ status: 409 });
  });
  it("does not revive deposited status when its receipt is retried after a verified return", async () => {
    Object.assign(row, { status: "returned", deposit_tx: signature });
    await expect(recordCustodyDeposit("delivery_requests", "request-id", holder, signature)).resolves.toMatchObject({ status: "returned" }); expect(mocks.deposit).not.toHaveBeenCalled(); expect(mocks.updates).toEqual([]);
  });
});
describe("admin custody lifecycle proofs", () => {
  it.each(["deadline", "attestation"])("rejects a newly linked vault without a meaningful %s", async (field) => {
    Object.assign(row, { status: "requested", vault_pda: null });
    mocks.vault.mockResolvedValue({ vault: { escrow, deposited: BigInt(0), state: VaultState.Active, deadline: field === "deadline" ? BigInt(0) : BigInt(999), metadataHash: new Uint8Array(32).fill(field === "attestation" ? 0 : 1) }, escrow: { amount: BigInt(0) } });
    await expect(validateCustodyUpdate("delivery_requests", "request-id", { status: "vault_opened", vault_pda: vault })).rejects.toMatchObject({ status: 409 });
  });
  it("accepts meaningful new linkage while preserving recovery of already-linked legacy terms", async () => {
    Object.assign(row, { status: "requested", vault_pda: null });
    mocks.vault.mockResolvedValue({ vault: { escrow, deposited: BigInt(0), state: VaultState.Active, deadline: BigInt(999), metadataHash: new Uint8Array(32).fill(1) }, escrow: { amount: BigInt(0) } });
    await expect(validateCustodyUpdate("delivery_requests", "request-id", { status: "vault_opened", vault_pda: vault })).resolves.toBe("requested");
    Object.assign(row, { status: "vault_opened", vault_pda: vault });
    mocks.vault.mockResolvedValue({ vault: { escrow, deposited: BigInt(0), state: VaultState.Active, deadline: BigInt(0), metadataHash: new Uint8Array(32) }, escrow: { amount: BigInt(0) } });
    await expect(validateCustodyUpdate("delivery_requests", "request-id", { admin_note: "Legacy recovery remains available" })).resolves.toBe("vault_opened");
  });
  it.each([deliveryAdmin, conversionAdmin])("denies a non-admin before reading requests", async (route) => {
    mocks.admin.mockRejectedValue(new SiwsError(403, "Admin required")); expect((await route(req())).status).toBe(403); expect(mocks.query).not.toHaveBeenCalled();
  });
  it.each(["delivery_requests", "conversion_requests"] as const)("requires an actual full escrow burn for %s", async (table) => {
    mocks.vault.mockResolvedValue({ vault: { escrow, deposited: BigInt(0), state: VaultState.Realized }, escrow: { amount: BigInt(0) } });
    mocks.transaction.mockResolvedValue(evidence("realize")); const patch = { status: table === "delivery_requests" ? "delivered" : "converted", outcome_tx: signature };
    await validateCustodyUpdate(table, "request-id", patch); expect(patch).toMatchObject({ outcome_evidence: { signature, vault, amountAtomic: "3" } });
    const fake = evidence("realize"); fake.meta!.innerInstructions = []; mocks.transaction.mockResolvedValue(fake);
    await expect(validateCustodyUpdate(table, "request-id", patch)).rejects.toMatchObject({ status: 400 });
  });
  it("binds only the link step to the current platform KYC registry pin", async () => {
    Object.assign(row, { status: "requested", vault_pda: null });
    mocks.vault.mockResolvedValue({ vault: { escrow, deposited: BigInt(0), state: VaultState.Active, deadline: BigInt(999), metadataHash: new Uint8Array(32).fill(1) }, escrow: { amount: BigInt(0) } });
    await validateCustodyUpdate("delivery_requests", "request-id", { status: "vault_opened", vault_pda: vault });
    expect(mocks.vault.mock.calls.at(-1)?.[2]).toEqual({ requirePlatformPin: true });
    Object.assign(row, { status: "deposited", vault_pda: vault });
    mocks.vault.mockResolvedValue({ vault: { escrow, deposited: BigInt(0), state: VaultState.Returned }, escrow: { amount: BigInt(0) } });
    await validateCustodyUpdate("delivery_requests", "request-id", { status: "returned", outcome_tx: signature });
    expect(mocks.vault.mock.calls.every((call, i) => i === 0 || !(call[2] as { requirePlatformPin?: boolean } | undefined)?.requirePlatformPin)).toBe(true);
    await expect(recordCustodyReturn("delivery_requests", "request-id", holder, signature)).resolves.toMatchObject({ status: "returned" });
    expect(mocks.vault.mock.calls.at(-1)?.[2]).toBeUndefined();
  });
  it("gates the physical handover (deposited → in_delivery) on the holder's passport", async () => {
    mocks.vault.mockResolvedValue({ vault: { escrow, deposited: BigInt(3), state: VaultState.Active, beneficiary: holder, kycRegistry: other }, escrow: { amount: BigInt(3) } });
    mocks.passport.mockRejectedValueOnce(new SiwsError(409, "The holder's investor passport is revoked."));
    await expect(validateCustodyUpdate("delivery_requests", "request-id", { status: "in_delivery" })).rejects.toMatchObject({ status: 409 });
    expect(mocks.passport).toHaveBeenCalledWith({ beneficiary: holder, kycRegistry: other });
    await expect(validateCustodyUpdate("delivery_requests", "request-id", { status: "in_delivery" })).resolves.toBe("deposited");
    mocks.passport.mockClear(); Object.assign(row, { status: "in_delivery" });
    await expect(validateCustodyUpdate("delivery_requests", "request-id", { admin_note: "Courier booked" })).resolves.toBe("in_delivery");
    expect(mocks.passport).not.toHaveBeenCalled();
  });
  it("refuses stale deposited or in-delivery status after tokens have left custody", async () => {
    mocks.vault.mockResolvedValue({ vault: { escrow, deposited: BigInt(0), state: VaultState.Returned }, escrow: { amount: BigInt(0) } });
    await expect(validateCustodyUpdate("delivery_requests", "request-id", { status: "deposited" })).rejects.toMatchObject({ status: 409 });
    await expect(validateCustodyUpdate("delivery_requests", "request-id", { status: "in_delivery" })).rejects.toMatchObject({ status: 409 });
  });
});
describe("2D: custody evidence once the vault was tombstoned by reclaim_rent", () => {
  beforeEach(() => {
    mocks.vault.mockRejectedValue(new ClosedCustodyVaultError());
    mocks.closed.mockResolvedValue({ escrow });
  });
  it.each(["delivery_requests", "conversion_requests"] as const)("records a realization for %s from the transaction alone", async (table) => {
    Object.assign(row, { status: "in_delivery" });
    mocks.transaction.mockResolvedValue(evidence("realize"));
    const patch = { status: table === "delivery_requests" ? "delivered" : "converted", outcome_tx: signature };
    await expect(validateCustodyUpdate(table, "request-id", patch)).resolves.toBe("in_delivery");
    expect(patch).toMatchObject({ outcome_evidence: { signature, vault, amountAtomic: "3" } });
    expect(mocks.closed).toHaveBeenCalled();
  });
  it("records a return with no surplus left and without the live deposit ledger", async () => {
    await expect(recordCustodyReturn("delivery_requests", "request-id", holder, signature)).resolves.toEqual({ id: "request-id", status: "returned" });
    expect(mocks.updates[0]).toMatchObject({ status: "returned", outcome_evidence: { signature, vault, amountAtomic: "3", surplusRemaining: "0" } });
  });
  it("allows cancelling only a request that was never funded", async () => {
    await expect(validateCustodyUpdate("delivery_requests", "request-id", { status: "cancelled" })).rejects.toMatchObject({ status: 409 });
    Object.assign(row, { status: "vault_opened", deposit_tx: null, deposit_evidence: null });
    await expect(validateCustodyUpdate("delivery_requests", "request-id", { status: "cancelled" })).resolves.toBe("vault_opened");
  });
  it.each(["vault_opened", "deposited", "in_delivery"])("refuses a move to %s: it needs live vault state", async (status) => {
    Object.assign(row, { status: status === "vault_opened" ? "requested" : "vault_opened", deposit_evidence: null });
    mocks.deposit.mockRejectedValue(new ClosedCustodyVaultError());
    const patch = status === "deposited" ? { status, deposit_tx: signature } : { status };
    await expect(validateCustodyUpdate("delivery_requests", "request-id", patch)).rejects.toMatchObject({ status: 409, message: "Custody vault was closed after settlement" });
  });
  it("refuses linking a tombstoned vault", async () => {
    Object.assign(row, { status: "requested", vault_pda: null });
    await expect(validateCustodyUpdate("delivery_requests", "request-id", { status: "vault_opened", vault_pda: vault })).rejects.toMatchObject({ status: 409 });
    expect(mocks.closed).not.toHaveBeenCalled();
  });
  it("lets a note-only patch pass", async () => {
    Object.assign(row, { status: "delivered", outcome_tx: signature, outcome_evidence: { signature, vault } });
    await expect(validateCustodyUpdate("delivery_requests", "request-id", { admin_note: "Archived" })).resolves.toBe("delivered");
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
