import { AccountRole, createNoopSigner, getAddressEncoder, type Instruction } from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  LOADER_V3,
  LoaderTag,
  SYSVAR_CLOCK,
  SYSVAR_RENT,
  closeInstruction,
  comparePayload,
  decodeLoaderBuffer,
  decodeProgramAccount,
  decodeProgramData,
  programDataAddress,
  setBufferAuthorityInstruction,
  setUpgradeAuthorityInstruction,
  upgradeInstruction,
} from "@/scripts/chain/lib/loader-v3";
import { HOOK, key } from "./helpers/chain-fake";

const hex = (ix: Instruction) => Buffer.from(ix.data ?? new Uint8Array()).toString("hex");
const metas = (ix: Instruction) => (ix.accounts ?? []).map((a) => [a.address, a.role]);
const authority = createNoopSigner(key(7));

// solana-loader-v3-interface 6.1.1 (program/Cargo.lock), src/instruction.rs:
// bincode u32 LE enum tags and the account lists of upgrade(),
// set_upgrade_authority(), set_buffer_authority() and close_any(). No
// ExtendProgram encoder: loader-v3 refuses it through CPI (6.1 rehearsal).
describe("loader-v3 golden bytes (6.1.1)", () => {
  it("documents the enum tags", () => {
    expect(LoaderTag).toEqual({
      InitializeBuffer: 0,
      Write: 1,
      DeployWithMaxDataLen: 2,
      Upgrade: 3,
      SetAuthority: 4,
      Close: 5,
      ExtendProgram: 6,
      SetAuthorityChecked: 7,
      Migrate: 8,
      ExtendProgramChecked: 9,
    });
  });

  it("Upgrade = 03000000 with [programData w, program w, buffer w, spill w, rent, clock, authority s]", async () => {
    const ix = await upgradeInstruction({ program: HOOK, buffer: key(8), spill: key(9), authority });
    expect(ix.programAddress).toBe(LOADER_V3);
    expect(hex(ix)).toBe("03000000");
    expect(metas(ix)).toEqual([
      [await programDataAddress(HOOK), AccountRole.WRITABLE],
      [HOOK, AccountRole.WRITABLE],
      [key(8), AccountRole.WRITABLE],
      [key(9), AccountRole.WRITABLE],
      [SYSVAR_RENT, AccountRole.READONLY],
      [SYSVAR_CLOCK, AccountRole.READONLY],
      [key(7), AccountRole.READONLY_SIGNER],
    ]);
  });

  it("SetAuthority = 04000000; the new authority does not sign; none makes it immutable", async () => {
    const ix = await setUpgradeAuthorityInstruction({ program: HOOK, current: authority, next: key(10) });
    expect(hex(ix)).toBe("04000000");
    expect(metas(ix)).toEqual([
      [await programDataAddress(HOOK), AccountRole.WRITABLE],
      [key(7), AccountRole.READONLY_SIGNER],
      [key(10), AccountRole.READONLY],
    ]);
    const immutable = await setUpgradeAuthorityInstruction({ program: HOOK, current: authority, next: null });
    expect(metas(immutable)).toHaveLength(2);
    const buffer = setBufferAuthorityInstruction({ buffer: key(8), current: authority, next: key(10) });
    expect(hex(buffer)).toBe("04000000");
    expect(metas(buffer)[0]).toEqual([key(8), AccountRole.WRITABLE]);
  });

  it("Close = 05000000 with [account w, recipient w, authority s, program w?]", () => {
    const ix = closeInstruction({ account: key(8), recipient: key(9), authority });
    expect(hex(ix)).toBe("05000000");
    expect(metas(ix)).toEqual([
      [key(8), AccountRole.WRITABLE],
      [key(9), AccountRole.WRITABLE],
      [key(7), AccountRole.READONLY_SIGNER],
    ]);
  });
});

describe("loader-v3 decoders and buffer compare", () => {
  it("decodes Program, ProgramData and Buffer layouts", async () => {
    const pd = await programDataAddress(HOOK);
    const program = new Uint8Array(36);
    new DataView(program.buffer).setUint32(0, 2, true);
    program.set(getAddressEncoder().encode(pd), 4);
    expect(decodeProgramAccount(program)).toEqual({ programData: pd });
    expect(decodeProgramAccount(new Uint8Array(37))).toBeNull();

    const data = new Uint8Array(45 + 4);
    const view = new DataView(data.buffer);
    view.setUint32(0, 3, true);
    view.setBigUint64(4, BigInt(1234), true);
    data[12] = 1;
    data.set(getAddressEncoder().encode(key(7)), 13);
    data.set([1, 2, 0, 0], 45);
    const decoded = decodeProgramData(data)!;
    expect(decoded.slot).toBe(BigInt(1234));
    expect(decoded.upgradeAuthority).toBe(key(7));
    expect([...decoded.payload]).toEqual([1, 2, 0, 0]);
    data[12] = 0;
    expect(decodeProgramData(data)!.upgradeAuthority).toBeNull();
    data[12] = 2;
    expect(decodeProgramData(data)).toBeNull();

    const buffer = new Uint8Array(37 + 3);
    new DataView(buffer.buffer).setUint32(0, 1, true);
    buffer[4] = 1;
    buffer.set(getAddressEncoder().encode(key(9)), 5);
    buffer.set([5, 6, 7], 37);
    expect(decodeLoaderBuffer(buffer)).toMatchObject({ authority: key(9) });
  });

  it("compares Release bytes: exact prefix and zero tail", () => {
    const so = Uint8Array.of(1, 2, 3);
    expect(comparePayload(Uint8Array.of(1, 2, 3, 0, 0), so)).toEqual({ equal: true, capacity: 5, length: 3, headroom: 2 });
    expect(comparePayload(Uint8Array.of(1, 2, 3, 0, 9), so).equal).toBe(false);
    expect(comparePayload(Uint8Array.of(1, 2, 4, 0, 0), so).equal).toBe(false);
    expect(comparePayload(Uint8Array.of(1, 2), so).equal).toBe(false);
  });
});
