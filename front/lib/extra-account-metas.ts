// A Token-2022 transfer hook's ExtraAccountMetaList (spl-tlv-account-resolution
// 0.11), decoded and resolved the way Token-2022 resolves it on chain.
//
// The app never reads this list to build a transfer: lib/hook-metas derives
// the hook accounts from the owners directly (so the recipient's token account
// can be created in the same transaction). This module exists to PROVE the two
// agree: tests resolve a list encoded from the program's `build_metas`, and
// the devnet rehearsal resolves the real 261-byte KycGated list of a mint and
// compares it with lib/share-transfer's output. Pure and node-safe.
//
// Layout (TLV, one entry): 8-byte Execute discriminator, u32 LE value length,
// u32 LE count, then `count` × 35-byte ExtraAccountMeta:
//   discriminator u8 (0 = fixed address; 1 = PDA of the hook program;
//                     128 + i = PDA of the program at account index i)
//   address_config [u8; 32] (the address, or the packed seeds)
//   is_signer u8, is_writable u8
// Packed seeds: 1 Literal {len u8, bytes}; 2 InstructionData {index u8, len u8};
// 3 AccountKey {index u8}; 4 AccountData {account index u8, data index u8,
// len u8}; 0 ends the list.
// Account indexes count [source, mint, destination, authority, this list,
// then every meta resolved so far].
import {
  getAddressDecoder,
  getAddressEncoder,
  getProgramDerivedAddress,
  type Address,
} from "@solana/kit";

/** sha256("spl-transfer-hook-interface:execute")[0..8]. */
export const EXECUTE_DISCRIMINATOR: readonly number[] = [0x69, 0x25, 0x65, 0xc5, 0x4b, 0xfb, 0x66, 0x1a];
export const EXTRA_ACCOUNT_META_SIZE = 35;
/** Header before the metas: discriminator, value length, count. */
export const EXTRA_ACCOUNT_META_LIST_HEADER = 16;

export type MetaSeed =
  | { kind: "literal"; bytes: Uint8Array }
  | { kind: "instructionData"; index: number; length: number }
  | { kind: "accountKey"; index: number }
  | { kind: "accountData"; accountIndex: number; dataIndex: number; length: number };

export type ExtraAccountMetaEntry = { isSigner: boolean; isWritable: boolean } & (
  | { kind: "fixed"; address: Address }
  /** `programIndex` null = the hook program itself (discriminator 1). */
  | { kind: "pda"; programIndex: number | null; seeds: MetaSeed[] }
);

function decodeSeeds(config: Uint8Array): MetaSeed[] {
  const seeds: MetaSeed[] = [];
  let i = 0;
  const need = (n: number) => {
    if (i + n > config.length) throw new Error("ExtraAccountMeta seed runs past its 32 bytes");
  };
  while (i < config.length) {
    const kind = config[i];
    i += 1;
    if (kind === 0) break;
    if (kind === 1) {
      need(1);
      const length = config[i];
      i += 1;
      need(length);
      seeds.push({ kind: "literal", bytes: config.slice(i, i + length) });
      i += length;
    } else if (kind === 2) {
      need(2);
      seeds.push({ kind: "instructionData", index: config[i], length: config[i + 1] });
      i += 2;
    } else if (kind === 3) {
      need(1);
      seeds.push({ kind: "accountKey", index: config[i] });
      i += 1;
    } else if (kind === 4) {
      need(3);
      seeds.push({ kind: "accountData", accountIndex: config[i], dataIndex: config[i + 1], length: config[i + 2] });
      i += 3;
    } else {
      throw new Error(`Unknown ExtraAccountMeta seed type ${kind}`);
    }
  }
  return seeds;
}

/** Decodes the account's data (the TLV entry at offset 0). Throws on anything malformed. */
export function decodeExtraAccountMetaList(data: Uint8Array): ExtraAccountMetaEntry[] {
  if (data.length < EXTRA_ACCOUNT_META_LIST_HEADER) throw new Error("ExtraAccountMetaList is shorter than its header");
  for (let i = 0; i < 8; i += 1) {
    if (data[i] !== EXECUTE_DISCRIMINATOR[i]) throw new Error("ExtraAccountMetaList does not start with the Execute discriminator");
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const length = view.getUint32(8, true);
  const count = view.getUint32(12, true);
  if (length !== 4 + count * EXTRA_ACCOUNT_META_SIZE) throw new Error(`ExtraAccountMetaList length ${length} does not match ${count} metas`);
  if (data.length < EXTRA_ACCOUNT_META_LIST_HEADER + count * EXTRA_ACCOUNT_META_SIZE) throw new Error("ExtraAccountMetaList is truncated");
  const out: ExtraAccountMetaEntry[] = [];
  for (let n = 0; n < count; n += 1) {
    const at = EXTRA_ACCOUNT_META_LIST_HEADER + n * EXTRA_ACCOUNT_META_SIZE;
    const discriminator = data[at];
    const config = data.slice(at + 1, at + 33);
    const isSigner = data[at + 33] !== 0;
    const isWritable = data[at + 34] !== 0;
    if (discriminator === 0) {
      out.push({ kind: "fixed", address: getAddressDecoder().decode(config), isSigner, isWritable });
    } else if (discriminator === 1) {
      out.push({ kind: "pda", programIndex: null, seeds: decodeSeeds(config), isSigner, isWritable });
    } else if (discriminator >= 128) {
      out.push({ kind: "pda", programIndex: discriminator - 128, seeds: decodeSeeds(config), isSigner, isWritable });
    } else {
      throw new Error(`Unsupported ExtraAccountMeta discriminator ${discriminator}`);
    }
  }
  return out;
}

export type MetaResolutionContext = {
  /** The hook program (owner of discriminator-1 PDAs). */
  hookProgram: Address;
  /** [source, mint, destination, authority, ExtraAccountMetaList]. */
  accounts: readonly [Address, Address, Address, Address, Address];
  /** Account data by address (for AccountData seeds); null = no such account. */
  accountData: (address: Address) => Uint8Array | null;
  /** The Execute instruction data (InstructionData seeds); none of ours uses it. */
  instructionData?: Uint8Array;
};

/**
 * Resolves every meta to its address, in order, as Token-2022 does: each
 * resolved meta joins the index space the later ones read. Throws where the
 * on-chain resolver would fail (an AccountData seed on an account that does
 * not exist or is too short).
 */
export async function resolveExtraAccountMetas(
  metas: readonly ExtraAccountMetaEntry[],
  context: MetaResolutionContext,
): Promise<Address[]> {
  const encoder = getAddressEncoder();
  const accounts: Address[] = [...context.accounts];
  const resolved: Address[] = [];
  for (const meta of metas) {
    let address: Address;
    if (meta.kind === "fixed") {
      address = meta.address;
    } else {
      const seeds: Uint8Array[] = [];
      for (const seed of meta.seeds) {
        if (seed.kind === "literal") seeds.push(seed.bytes);
        else if (seed.kind === "accountKey") {
          const key = accounts[seed.index];
          if (!key) throw new Error(`AccountKey seed names account ${seed.index}, which is not resolved yet`);
          seeds.push(new Uint8Array(encoder.encode(key)));
        } else if (seed.kind === "accountData") {
          const key = accounts[seed.accountIndex];
          const data = key ? context.accountData(key) : null;
          if (!data) throw new Error(`AccountData seed reads account ${seed.accountIndex}, which does not exist`);
          if (seed.dataIndex + seed.length > data.length) throw new Error(`AccountData seed reads past account ${seed.accountIndex}'s data`);
          seeds.push(data.slice(seed.dataIndex, seed.dataIndex + seed.length));
        } else {
          const data = context.instructionData;
          if (!data || seed.index + seed.length > data.length) throw new Error("InstructionData seed reads past the instruction data");
          seeds.push(data.slice(seed.index, seed.index + seed.length));
        }
      }
      const programAddress = meta.programIndex === null ? context.hookProgram : accounts[meta.programIndex];
      if (!programAddress) throw new Error(`External PDA names program account ${meta.programIndex}, which is not resolved yet`);
      [address] = await getProgramDerivedAddress({ programAddress, seeds });
    }
    accounts.push(address);
    resolved.push(address);
  }
  return resolved;
}
