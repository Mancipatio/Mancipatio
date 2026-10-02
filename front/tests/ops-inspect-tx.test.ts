// `npm run ops:inspect-tx` (scripts/ops/inspect-tx.ts): the independent check
// of a transaction a Ledger blind-signs through the "Ledger (USB)" wallet.
// Messages are built with the committed IDL clients, compiled by @solana/kit
// as the front compiles them, and decoded back offline.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  compressTransactionMessageUsingAddressLookupTables,
  createNoopSigner,
  createTransactionMessage,
  getBase58Decoder,
  getBase64Decoder,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Blockhash,
  type Instruction,
} from "@solana/kit";
import { describe, expect, it } from "vitest";
import { ASSET_REGISTRY_PROGRAM_ADDRESS, getSetPauseFlagsInstruction } from "@/lib/generated/asset_registry";
import { inspectTransactionMessage, roleMapLabels, runInspectTx } from "@/scripts/ops/inspect-tx";

const SUPER_ADMIN = address("8TEmJBkcoBsUjRPftZ3kdWb9NmZDy7Zy3a7GqFCK5Nx9");
const PLATFORM = address("C1nBL5ufPcQvjkmj6hAmRgoLntHonMuf5WdxVxJenJaE");
const ADMIN_RECORD = address("CMNf3bEiM6u4SD2GHBoMt4fA1gLp9gLksYyEnrXeWyBm");
const blockhash = getBase58Decoder().decode(new Uint8Array(32).fill(5)) as Blockhash;

const computeUnitLimit = (units: number): Instruction => ({
  programAddress: address("ComputeBudget111111111111111111111111111111"),
  data: Uint8Array.from([2, units & 0xff, (units >> 8) & 0xff, (units >> 16) & 0xff, units >>> 24]),
});

function messageOf(instructions: Instruction[], signer: Address = SUPER_ADMIN) {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(createNoopSigner(signer), m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight: BigInt(1) }, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  return new Uint8Array(compileTransaction(message).messageBytes);
}

const base64 = (bytes: Uint8Array) => getBase64Decoder().decode(bytes);
const sha256base58 = (bytes: Uint8Array) => getBase58Decoder().decode(createHash("sha256").update(bytes).digest());

// S5c: the super admin closes the bootstrap window (set_pause_flags(0, 0x80)).
const closeWindow = () => getSetPauseFlagsInstruction({
  authority: createNoopSigner(SUPER_ADMIN),
  adminRecord: ADMIN_RECORD,
  platform: PLATFORM,
  setMask: 0,
  clearMask: 0x80,
});

describe("ops:inspect-tx", () => {
  it("decodes a Manci instruction by the IDL client, names its accounts and arguments, and prints the hash of exactly those bytes", () => {
    const bytes = messageOf([computeUnitLimit(200_000), closeWindow()]);
    const labels = roleMapLabels({ superAdmin: SUPER_ADMIN, blocklistAuthority: SUPER_ADMIN, admins: [ADMIN_RECORD], kyc: { authority: SUPER_ADMIN } });
    const result = inspectTransactionMessage(base64(bytes), labels);
    expect(result.hash).toBe(sha256base58(bytes));
    expect(result.warnings).toEqual([]);
    expect(result.lines).toEqual([
      "Transaction message (v0), 1 signature(s) required",
      `  fee payer: ${SUPER_ADMIN} [superAdmin, blocklistAuthority, kyc.authority]`,
      `  signer: ${SUPER_ADMIN} [superAdmin, blocklistAuthority, kyc.authority] (signer, writable)`,
      `  lifetime: ${blockhash} (a recent blockhash or a durable nonce)`,
      "Instructions:",
      "  #1 ComputeBudget: SetComputeUnitLimit 200000",
      "  #2 asset_registry: SetPauseFlags",
      `       authority: ${SUPER_ADMIN} [superAdmin, blocklistAuthority, kyc.authority] (signer, writable)`,
      `       adminRecord: ${ADMIN_RECORD} [admins[0]] (readonly)`,
      `       platform: ${PLATFORM} (writable)`,
      '       args: {"setMask":0,"clearMask":128}',
    ]);
  });

  it("warns about an unknown program, an undecodable Manci instruction and lookup tables", () => {
    const unknown: Instruction = {
      programAddress: address("BPFLoaderUpgradeab1e11111111111111111111111"),
      accounts: [{ address: PLATFORM, role: AccountRole.WRITABLE }],
      data: Uint8Array.from([3, 0, 0, 0]),
    };
    const garbage: Instruction = { programAddress: ASSET_REGISTRY_PROGRAM_ADDRESS, data: Uint8Array.from([1, 2, 3]) };
    const result = inspectTransactionMessage(base64(messageOf([unknown, garbage])));
    expect(result.lines).toContain(`  #1 UNKNOWN PROGRAM BPFLoaderUpgradeab1e11111111111111111111111: data 0x03000000`);
    expect(result.lines).toContain(`       account 0: ${PLATFORM} (writable)`);
    expect(result.lines.find((line) => line.startsWith("  #2 asset_registry: could not be decoded"))).toBeTruthy();
    expect(result.warnings).toEqual([
      expect.stringMatching(/^Instruction #1 calls a program this tool does not know/),
      expect.stringMatching(/^Instruction #2 \(asset_registry\) does not decode/),
    ]);

    const table = address("AddressLookupTab1e1111111111111111111111111");
    const compressed = compressTransactionMessageUsingAddressLookupTables(
      pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayerSigner(createNoopSigner(SUPER_ADMIN), m),
        (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight: BigInt(1) }, m),
        (m) => appendTransactionMessageInstructions([closeWindow()], m),
      ),
      { [table]: [PLATFORM] },
    );
    const viaTable = inspectTransactionMessage(base64(new Uint8Array(compileTransaction(compressed).messageBytes)));
    expect(viaTable.warnings[0]).toMatch(/address lookup table.*do not approve/);
    expect(viaTable.warnings[1]).toMatch(/^Instruction #1 \(asset_registry\) does not decode/);
  });

  it("refuses input that is not exactly one transaction message", () => {
    const bytes = messageOf([closeWindow()]);
    expect(() => inspectTransactionMessage("not base64!")).toThrow(/not base64/);
    // slice, not subarray: kit's Node base64 decoder reads a view's whole buffer.
    expect(() => inspectTransactionMessage(base64(bytes.slice(0, 40)))).toThrow(/not a transaction message/);
    expect(() => inspectTransactionMessage(base64(Uint8Array.from([...bytes, 0])))).toThrow(/1 byte\(s\) after the transaction message/);
    // Line breaks from a terminal paste are ignored.
    const wrapped = base64(bytes).replace(/(.{60})/g, "$1\n");
    expect(inspectTransactionMessage(wrapped).hash).toBe(sha256base58(bytes));
  });

  it("the runner reads INSPECT_TX_MESSAGE and, for labels, INSPECT_ROLE_MAP", () => {
    const bytes = messageOf([closeWindow()]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inspect-tx-"));
    const map = path.join(dir, "role-map.json");
    fs.writeFileSync(map, JSON.stringify({ superAdmin: SUPER_ADMIN }));
    const out: string[] = [];
    runInspectTx({ INSPECT_TX_MESSAGE: base64(bytes), INSPECT_ROLE_MAP: map }, (line) => out.push(line));
    expect(out).toContain(`       authority: ${SUPER_ADMIN} [superAdmin] (signer, writable)`);
    expect(out).toContain(`Message hash (the Ledger must show exactly this): ${sha256base58(bytes)}`);
    expect(() => runInspectTx({}, () => undefined)).toThrow(/INSPECT_TX_MESSAGE/);
  });
});
