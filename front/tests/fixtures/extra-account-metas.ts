// An ExtraAccountMetaList encoder that mirrors the transfer hook's
// `build_metas` (program/programs/transfer_hook/src/lib.rs) seed for seed, so
// the tests can resolve the list the program writes and compare it with what
// lib/hook-metas / lib/share-transfer put in a transfer.
//
// Fidelity: the Open encoding must equal the real devnet list byte for byte
// (tests/share-transfer-builder.test.ts pins the 51-byte hex read from
// E98RYAUp5NTCgSBzoJeYa1eXbLarLYUiYKo7DmvaB6e). No KycGated list existed on
// chain when this was written; once the rehearsal switches a devnet mint to
// KycGated, its real 261 bytes join as a second fixture.
import { getAddressEncoder, type Address } from "@solana/kit";
import { EXECUTE_DISCRIMINATOR, EXTRA_ACCOUNT_META_SIZE } from "@/lib/extra-account-metas";

/** transfer_hook `ASSET_REGISTRY_PROGRAM` (the program's own constant, pinned here). */
export const PROGRAM_ASSET_REGISTRY = "FJs1EM1ND89L9sUXaS8VBKYXjmoXCkkVSJKRE19hmYxS" as Address;

type Seed =
  | { literal: string }
  | { accountKey: number }
  | { accountData: [accountIndex: number, dataIndex: number, length: number] };

type Meta =
  | { fixed: Address }
  | { pda: Seed[]; externalProgramIndex?: number };

function packSeeds(seeds: Seed[]): Uint8Array {
  const out = new Uint8Array(32);
  let i = 0;
  for (const seed of seeds) {
    if ("literal" in seed) {
      const bytes = new TextEncoder().encode(seed.literal);
      out[i] = 1;
      out[i + 1] = bytes.length;
      out.set(bytes, i + 2);
      i += 2 + bytes.length;
    } else if ("accountKey" in seed) {
      out[i] = 3;
      out[i + 1] = seed.accountKey;
      i += 2;
    } else {
      out[i] = 4;
      out.set(seed.accountData, i + 1);
      i += 4;
    }
  }
  if (i > 32) throw new Error("seeds do not fit 32 bytes");
  return out;
}

/** spl-tlv-account-resolution's ExtraAccountMetaList account data for `metas` (all read-only, unsigned). */
export function encodeExtraAccountMetaList(metas: Meta[]): Uint8Array {
  const out = new Uint8Array(16 + metas.length * EXTRA_ACCOUNT_META_SIZE);
  const view = new DataView(out.buffer);
  out.set(EXECUTE_DISCRIMINATOR, 0);
  view.setUint32(8, 4 + metas.length * EXTRA_ACCOUNT_META_SIZE, true);
  view.setUint32(12, metas.length, true);
  metas.forEach((meta, n) => {
    const at = 16 + n * EXTRA_ACCOUNT_META_SIZE;
    if ("fixed" in meta) {
      out[at] = 0;
      out.set(getAddressEncoder().encode(meta.fixed), at + 1);
    } else {
      out[at] = meta.externalProgramIndex === undefined ? 1 : 128 + meta.externalProgramIndex;
      out.set(packSeeds(meta.pda), at + 1);
    }
    // is_signer, is_writable: false for every hook meta.
  });
  return out;
}

/** `build_metas(mode, kyc_registry)`, meta for meta. */
export function buildMetasFixture(mode: "open" | "kyc-gated", registry?: Address): Uint8Array {
  // idx 5 — source BlockEntry: ["blocked", source owner (account 0, data 32..64)]
  const metas: Meta[] = [{ pda: [{ literal: "blocked" }, { accountData: [0, 32, 32] }] }];
  if (mode === "kyc-gated") {
    if (!registry) throw new Error("KycGated needs a registry");
    metas.push(
      // idx 6 — hook config: ["hook_cfg", mint (account 1)]
      { pda: [{ literal: "hook_cfg" }, { accountKey: 1 }] },
      // idx 7 — the KYC registry, fixed
      { fixed: registry },
      // idx 8 — the asset_registry program, fixed
      { fixed: PROGRAM_ASSET_REGISTRY },
      // idx 9 — receiver KycEntry under program idx 8: ["kyc", registry (7), destination owner (account 2, data 32..64)]
      { pda: [{ literal: "kyc" }, { accountKey: 7 }, { accountData: [2, 32, 32] }], externalProgramIndex: 8 },
      // idx 10 — destination-owner EscrowMarker under idx 8
      { pda: [{ literal: "escrow_marker" }, { accountData: [2, 32, 32] }], externalProgramIndex: 8 },
      // idx 11 — source-owner EscrowMarker under idx 8
      { pda: [{ literal: "escrow_marker" }, { accountData: [0, 32, 32] }], externalProgramIndex: 8 },
    );
  }
  return encodeExtraAccountMetaList(metas);
}

/** A 165-byte SPL token account body with `mint` and `owner` (only the owner at 32..64 matters to the seeds). */
export function fakeTokenAccountData(mint: Address, owner: Address): Uint8Array {
  const data = new Uint8Array(165);
  data.set(getAddressEncoder().encode(mint), 0);
  data.set(getAddressEncoder().encode(owner), 32);
  data[108] = 1; // AccountState::Initialized
  return data;
}

export const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
