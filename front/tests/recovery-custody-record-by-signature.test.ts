// F077 (server capability): once a browser receipt is lost, the admin can
// still record a deposit, a burn or a return by its bare signature through
// the existing evidence routes — verified on chain exactly as a first-time
// record is — and a funded vault can never be cancelled "no deposit". The
// harness mirrors tests/custody-evidence-server.test.ts.
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
import { getRealizeCustodyVaultInstruction, getReturnCustodyVaultInstruction, VaultState } from "@/lib/generated/asset_registry";
import { TOKEN_2022_PROGRAM, type ChainTransaction } from "@/lib/chain-evidence";
import { validateCustodyUpdate } from "@/lib/server/custody-evidence";
import { POST as conversionAdmin } from "@/app/api/conversion/admin-update/route";
import { POST as deliveryAdmin } from "@/app/api/delivery/admin-update/route";
const key = (n: number) => getAddressDecoder().decode(new Uint8Array(32).fill(n));
const holder = key(1), admin = key(2), vault = key(3), shareClass = key(4), mint = key(5), escrow = key(6), destination = key(7);
const signature = getBase58Decoder().decode(new Uint8Array(64).fill(9));
let row: Record<string, unknown>;
const req = () => new Request("https://app.test/api/custody", { method: "POST", body: "{}" });
function evidence(kind: "return" | "realize") {
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
const funded = { vault: { escrow, deposited: BigInt(3), state: VaultState.Active, beneficiary: holder, kycRegistry: admin }, escrow: { amount: BigInt(3) } };
beforeEach(() => {
  vi.clearAllMocks(); mocks.filters.length = 0; mocks.updates.length = 0;
  // A vault the holder funded from another device: the row never left vault_opened.
  row = { id: "request-id", network: "devnet", holder_wallet: holder, share_class_pda: shareClass, mint, vault_pda: vault, vault_id: 7, amount: 3, status: "vault_opened", deposit_tx: null, deposit_evidence: null, outcome_tx: null, outcome_evidence: null };
  mocks.query.mockImplementation(async (_table, update) => ({ data: update ? { id: row.id, status: "recorded" } : { ...row }, error: null }));
  mocks.vault.mockResolvedValue(funded);
  mocks.deposit.mockResolvedValue({ instructionIndex: 0, slot: "122", amountAtomic: "3" });
  mocks.admin.mockResolvedValue(undefined);
});
describe("recording a lost deposit, burn or return by signature (admin-update)", () => {
  it.each([
    ["conversion", conversionAdmin, "conversion_requests"],
    ["delivery", deliveryAdmin, "delivery_requests"],
  ] as const)("%s: an admin records the holder's on-chain deposit from vault_opened with its bare signature", async (product, route, table) => {
    mocks.verify.mockResolvedValue({ wallet: admin, params: { id: row.id, status: "deposited", deposit_tx: signature } });
    const response = await route(req());
    expect(response.status).toBe(200);
    expect(mocks.deposit).toHaveBeenCalledWith(signature, expect.objectContaining({ vault_pda: vault, holder_wallet: holder }));
    expect(mocks.updates[0]).toMatchObject({ status: "deposited", deposit_tx: signature, deposit_evidence: { signature, vault, amountAtomic: "3" } });
    expect(mocks.filters).toContainEqual([table, "status", "vault_opened"]);
    expect(mocks.filters).toContainEqual([table, "network", "devnet"]);
    void product;
  });
  it("an admin records a burn from vault_opened once the vault is Realized (the realize transaction is verified as usual)", async () => {
    mocks.vault.mockResolvedValue({ vault: { escrow, deposited: BigInt(0), state: VaultState.Realized }, escrow: { amount: BigInt(0) } });
    mocks.transaction.mockResolvedValue(evidence("realize"));
    const patch = { status: "converted", outcome_tx: signature };
    await expect(validateCustodyUpdate("conversion_requests", "request-id", patch)).resolves.toBe("vault_opened");
    expect(patch).toMatchObject({ outcome_evidence: { signature, vault, amountAtomic: "3" } });
    mocks.verify.mockResolvedValue({ wallet: admin, params: { id: row.id, status: "converted", outcome_tx: signature } });
    const response = await conversionAdmin(req());
    expect(response.status).toBe(200);
    expect(mocks.filters).toContainEqual(["conversion_requests", "status", "vault_opened"]);
    expect(mocks.updates.at(-1)).toMatchObject({ status: "converted", outcome_tx: signature });
  });
  it("an admin records a return from vault_opened by its signature", async () => {
    mocks.vault.mockResolvedValue({ vault: { escrow, deposited: BigInt(0), state: VaultState.Returned }, escrow: { amount: BigInt(7) } });
    mocks.transaction.mockResolvedValue(evidence("return"));
    const patch = { status: "returned", outcome_tx: signature };
    await expect(validateCustodyUpdate("delivery_requests", "request-id", patch)).resolves.toBe("vault_opened");
    expect(patch).toMatchObject({ outcome_evidence: { signature, vault, amountAtomic: "3", surplusRemaining: "7" } });
  });
  it("a wrong signature is refused, nothing written", async () => {
    mocks.verify.mockResolvedValue({ wallet: admin, params: { id: row.id, status: "deposited", deposit_tx: "not-a-signature" } });
    mocks.deposit.mockReset();
    const response = await conversionAdmin(req());
    expect(response.status).toBe(400);
    expect(mocks.updates).toEqual([]);
  });
});
describe("a funded vault cannot be cancelled 'no deposit'", () => {
  it("refuses the cancel of a vault_opened row whose live vault holds the deposit (409), through the route and the validator", async () => {
    await expect(validateCustodyUpdate("conversion_requests", "request-id", { status: "cancelled" })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/Funded custody/) });
    mocks.verify.mockResolvedValue({ wallet: admin, params: { id: row.id, status: "cancelled", admin_note: "no deposit", decide: true } });
    const response = await conversionAdmin(req());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ ok: false, error: expect.stringMatching(/Funded custody/) });
    expect(mocks.updates).toEqual([]);
  });
  it("allows it once the escrow and the deposit ledger are empty", async () => {
    mocks.vault.mockResolvedValue({ vault: { escrow, deposited: BigInt(0), state: VaultState.Returned }, escrow: { amount: BigInt(0) } });
    await expect(validateCustodyUpdate("conversion_requests", "request-id", { status: "cancelled" })).resolves.toBe("vault_opened");
  });
});
