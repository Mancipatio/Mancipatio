// v1.0.0-rc (8.3): the freeze / blocklist gate accounts are read before any
// wallet prompt (lib/proceeds-gate.ts), with the indices pinned to the IDL.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { address, type Address } from "@solana/kit";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  AssetRegistryInstruction,
  getBuyInstructionDataEncoder,
  getExpireOtcDealInstructionDataEncoder,
  getSetPauseFlagsInstructionDataEncoder,
} from "@/lib/generated/asset_registry";
import { GATE_ACCOUNTS, GateAccountSetError, assertGateAccountsUnset, gateAccountsOf } from "@/lib/proceeds-gate";
import { ISSUER_PROCEEDS_FROZEN_HINT, PARTY_BLOCKLISTED_HINT, explainSendError } from "@/lib/tx-error";

const snake = (name: string) => name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`).replace(/^_/, "");
const key = (n: number) => address(["Stake11111111111111111111111111111111111111", "Vote111111111111111111111111111111111111111", "Config1111111111111111111111111111111111111", "SysvarRent111111111111111111111111111111111", "SysvarC1ock11111111111111111111111111111111", "ComputeBudget111111111111111111111111111111", "AddressLookupTab1e1111111111111111111111111", "BPFLoaderUpgradeab1e11111111111111111111111", "SysvarS1otHashes111111111111111111111111111", "SysvarStakeHistory1111111111111111111111111", "SysvarRecentB1ockHashes11111111111111111111", "Sysvar1nstructions1111111111111111111111111", "SysvarEpochSchedu1e111111111111111111111111", "SysvarFees111111111111111111111111111111111", "SysvarRewards111111111111111111111111111111", "Secp256k1SigVerify1111111111111111111111111"][n]);
const accounts = (n: number) => Array.from({ length: n }, (_, i) => ({ address: key(i) as Address }));
const buy = { programAddress: ASSET_REGISTRY_PROGRAM_ADDRESS, accounts: accounts(16), data: new Uint8Array(getBuyInstructionDataEncoder().encode({ amount: 1 })) };

describe("gate accounts", () => {
  it("every index names an unset gate account of the IDL (issuer_freeze or *_block_entry)", () => {
    const idl = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "idl", "asset_registry.json"), "utf8")) as { instructions: { name: string; accounts: { name: string }[] }[] };
    for (const [instruction, gates] of GATE_ACCOUNTS) {
      const name = snake(AssetRegistryInstruction[instruction]);
      const ix = idl.instructions.find((i) => i.name === name);
      expect(ix, name).toBeDefined();
      for (const gate of gates) {
        const account = ix!.accounts[gate.index].name;
        expect(account, `${name}#${gate.index}`).toBe(gate.kind === "freeze" ? "issuer_freeze" : account.endsWith("_block_entry") ? account : "?");
      }
      // Every gate account of the instruction is listed.
      const all = ix!.accounts.filter((a) => a.name === "issuer_freeze" || a.name.endsWith("_block_entry"));
      expect(gates.length, name).toBe(all.length);
    }
  });

  it("picks the gate accounts of the gated instructions only", () => {
    expect(gateAccountsOf([buy]).map((g) => [g.address, g.kind])).toEqual([[key(13), "block"], [key(14), "freeze"]]);
    const pause = { programAddress: ASSET_REGISTRY_PROGRAM_ADDRESS, accounts: accounts(3), data: new Uint8Array(getSetPauseFlagsInstructionDataEncoder().encode({ setMask: 1, clearMask: 0 })) };
    expect(gateAccountsOf([pause])).toEqual([]);
    expect(gateAccountsOf([{ ...buy, programAddress: key(0) }])).toEqual([]);
  });

  it("refuses before the wallet: a frozen issuer (6143 words) wins over a blocked party (6144); fails open on a read error", async () => {
    const read = vi.fn(async (addresses: string[]) => addresses.map((a) => a === key(14)));
    await expect(assertGateAccountsUnset(null, [buy], { read })).rejects.toThrow(ISSUER_PROCEEDS_FROZEN_HINT);
    const both = vi.fn(async (addresses: string[]) => addresses.map(() => true));
    const error = await assertGateAccountsUnset(null, [buy], { read: both }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GateAccountSetError);
    expect((error as GateAccountSetError).kind).toBe("freeze");
    expect(explainSendError(new Error("wrapped", { cause: error }))).toBe((error as Error).message);
    // An expire of a deal whose buyer is blocked: the Admin-cancel hint.
    const expire = { programAddress: ASSET_REGISTRY_PROGRAM_ADDRESS, accounts: accounts(14), data: new Uint8Array(getExpireOtcDealInstructionDataEncoder().encode({})) };
    await expect(assertGateAccountsUnset(null, [expire], { read: async (a) => a.map((x) => x === key(11)) })).rejects.toThrow(PARTY_BLOCKLISTED_HINT);
    await expect(assertGateAccountsUnset(null, [buy], { read: async (a) => a.map(() => false) })).resolves.toBeUndefined();
    await expect(assertGateAccountsUnset(null, [buy], { read: async () => { throw new Error("rpc down"); } })).resolves.toBeUndefined();
    const none = vi.fn();
    await assertGateAccountsUnset(null, [], { read: none });
    expect(none).not.toHaveBeenCalled();
  });

  it("the verified client runs it before any wallet prompt, next to the pause gate", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "lib", "verified-solana-client.ts"), "utf8");
    // prepare, prepareAndSend and prepareAndSendAll (once per transaction of a batch).
    expect(src.match(/await assertGateAccountsUnset\(context\.rpc, input\.instructions\);/g)).toHaveLength(3);
  });
});
