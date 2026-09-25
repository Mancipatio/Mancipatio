/**
 * BPF upgradeable loader (loader-v3) decoders and instruction encoders.
 *
 * Source of truth: solana-loader-v3-interface 6.1.1 (the version pinned in
 * program/Cargo.lock), `src/instruction.rs` and `src/state.rs`:
 * - instructions are bincode enums with a u32 LE tag: InitializeBuffer=0,
 *   Write=1, DeployWithMaxDataLen=2, Upgrade=3, SetAuthority=4, Close=5,
 *   ExtendProgram=6, SetAuthorityChecked=7, Migrate=8, ExtendProgramChecked=9;
 * - account state is the bincode `UpgradeableLoaderState` enum: Buffer=1
 *   (37-byte header), Program=2 (36 bytes), ProgramData=3 (45-byte header).
 */
import {
  AccountRole,
  address,
  getAddressDecoder,
  getAddressEncoder,
  getProgramDerivedAddress,
  type AccountMeta,
  type AccountSignerMeta,
  type Address,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";

export const LOADER_V3 = address("BPFLoaderUpgradeab1e11111111111111111111111");
export const SYSVAR_RENT = address("SysvarRent111111111111111111111111111111111");
export const SYSVAR_CLOCK = address("SysvarC1ock11111111111111111111111111111111");
export const SYSTEM_PROGRAM = address("11111111111111111111111111111111");

export const LoaderTag = {
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
} as const;

export const BUFFER_METADATA_SIZE = 37;
export const PROGRAM_SIZE = 36;
export const PROGRAMDATA_METADATA_SIZE = 45;
/**
 * SIMD-0431 (active on mainnet since slot 432864000): an ExtendProgram must add
 * at least this many bytes (or reach the maximum size). The chain CLI never
 * builds ExtendProgram: loader-v3 refuses it through CPI (so a Squads vault
 * cannot extend), and the unchecked instruction needs no authority, so the
 * operator extends with `solana program extend` (runbook §9.3).
 */
export const MINIMUM_EXTEND_PROGRAM_BYTES = 10_240;

const addressDecoder = getAddressDecoder();
const addressEncoder = getAddressEncoder();

function u32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

export async function programDataAddress(program: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: LOADER_V3,
    seeds: [addressEncoder.encode(program)],
  });
  return pda;
}

// ── Decoders ─────────────────────────────────────────────────────────────────

export type DecodedProgram = { programData: Address };
export type DecodedProgramData = {
  slot: bigint;
  upgradeAuthority: Address | null;
  /** Bytes after the 45-byte header (capacity = payload.length). */
  payload: Uint8Array;
};
export type DecodedLoaderBuffer = { authority: Address | null; payload: Uint8Array };

export function decodeProgramAccount(data: Uint8Array): DecodedProgram | null {
  if (data.length !== PROGRAM_SIZE || u32(data, 0) !== 2) return null;
  return { programData: addressDecoder.decode(data.subarray(4, 36)) };
}

export function decodeProgramData(data: Uint8Array): DecodedProgramData | null {
  if (data.length < PROGRAMDATA_METADATA_SIZE || u32(data, 0) !== 3 || data[12] > 1) return null;
  return {
    slot: new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(4, true),
    upgradeAuthority: data[12] === 1 ? addressDecoder.decode(data.subarray(13, 45)) : null,
    payload: data.subarray(PROGRAMDATA_METADATA_SIZE),
  };
}

export function decodeLoaderBuffer(data: Uint8Array): DecodedLoaderBuffer | null {
  if (data.length < BUFFER_METADATA_SIZE || u32(data, 0) !== 1 || data[4] > 1) return null;
  return {
    authority: data[4] === 1 ? addressDecoder.decode(data.subarray(5, 37)) : null,
    payload: data.subarray(BUFFER_METADATA_SIZE),
  };
}

/**
 * Release bytes against an on-chain payload (ProgramData or buffer): the
 * `.so` must be an exact prefix and every byte after it must be zero.
 */
export function comparePayload(payload: Uint8Array, so: Uint8Array) {
  const fits = so.length <= payload.length;
  let prefix = fits;
  for (let i = 0; prefix && i < so.length; i++) if (payload[i] !== so[i]) prefix = false;
  let zeroTail = fits;
  for (let i = so.length; zeroTail && i < payload.length; i++) if (payload[i] !== 0) zeroTail = false;
  return {
    equal: prefix && zeroTail,
    capacity: payload.length,
    length: so.length,
    headroom: payload.length - so.length,
  };
}

// ── Encoders ─────────────────────────────────────────────────────────────────

function tagData(tag: number, extraU32?: number): Uint8Array {
  const data = new Uint8Array(extraU32 === undefined ? 4 : 8);
  const view = new DataView(data.buffer);
  view.setUint32(0, tag, true);
  if (extraU32 !== undefined) view.setUint32(4, extraU32, true);
  return data;
}

const meta = (addr: Address, role: AccountRole): AccountMeta => ({ address: addr, role });
const signerMeta = (signer: TransactionSigner, writable = false): AccountSignerMeta => ({
  address: signer.address,
  role: writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER,
  signer,
});

/** `upgrade`: [programData w, program w, buffer w, spill w, rent, clock, authority s]. */
export async function upgradeInstruction(input: {
  program: Address;
  buffer: Address;
  spill: Address;
  authority: TransactionSigner;
}): Promise<Instruction> {
  return {
    programAddress: LOADER_V3,
    accounts: [
      meta(await programDataAddress(input.program), AccountRole.WRITABLE),
      meta(input.program, AccountRole.WRITABLE),
      meta(input.buffer, AccountRole.WRITABLE),
      meta(input.spill, AccountRole.WRITABLE),
      meta(SYSVAR_RENT, AccountRole.READONLY),
      meta(SYSVAR_CLOCK, AccountRole.READONLY),
      signerMeta(input.authority),
    ],
    data: tagData(LoaderTag.Upgrade),
  };
}

/**
 * `set_upgrade_authority` (unchecked, tag 4): [programData w, current s,
 * new?]. The new authority does not sign, so a Squads vault PDA can receive
 * it. `null` makes the program immutable.
 */
export async function setUpgradeAuthorityInstruction(input: {
  program: Address;
  current: TransactionSigner;
  next: Address | null;
}): Promise<Instruction> {
  const accounts: (AccountMeta | AccountSignerMeta)[] = [
    meta(await programDataAddress(input.program), AccountRole.WRITABLE),
    signerMeta(input.current),
  ];
  if (input.next) accounts.push(meta(input.next, AccountRole.READONLY));
  return { programAddress: LOADER_V3, accounts, data: tagData(LoaderTag.SetAuthority) };
}

/** `set_buffer_authority` (tag 4): [buffer w, current s, new]. */
export function setBufferAuthorityInstruction(input: {
  buffer: Address;
  current: TransactionSigner;
  next: Address;
}): Instruction {
  return {
    programAddress: LOADER_V3,
    accounts: [
      meta(input.buffer, AccountRole.WRITABLE),
      signerMeta(input.current),
      meta(input.next, AccountRole.READONLY),
    ],
    data: tagData(LoaderTag.SetAuthority),
  };
}

/** `close` (tag 5): [account w, recipient w, authority s?, program w?]. */
export function closeInstruction(input: {
  account: Address;
  recipient: Address;
  authority: TransactionSigner;
  program?: Address;
}): Instruction {
  const accounts: (AccountMeta | AccountSignerMeta)[] = [
    meta(input.account, AccountRole.WRITABLE),
    meta(input.recipient, AccountRole.WRITABLE),
    signerMeta(input.authority),
  ];
  if (input.program) accounts.push(meta(input.program, AccountRole.WRITABLE));
  return { programAddress: LOADER_V3, accounts, data: tagData(LoaderTag.Close) };
}

export function loaderTagOf(data: Uint8Array): number | null {
  return data.length >= 4 ? u32(data, 0) : null;
}
