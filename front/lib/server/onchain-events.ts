// Pure: fixed-size decoders for the asset_registry events the alarms read.
//
// Layouts and discriminators come from idl/asset_registry.json (a test pins
// every one field by field), hand-written here so lib/generated stays
// codegen-only. A decoder accepts only the exact length: a different size is
// IDL drift and returns { error: "LAYOUT" } (an onchain:decode alarm), never
// a guess.

import { getBase58Decoder } from "@solana/kit";
import {
  ClawbackReason,
  IssuerAuthorityChangeKind,
  getClawbackReasonDecoder,
  getIssuerAuthorityChangeKindDecoder,
} from "@/lib/generated/asset_registry";

export type FieldType = "u8" | "bool" | "pubkey" | "u64" | "i64" | "bytes128" | "ClawbackReason" | "IssuerAuthorityChangeKind";

export type EventSpec = {
  name: string;
  discriminator: readonly number[];
  fields: readonly (readonly [string, FieldType])[];
};

const SIZES: Record<FieldType, number> = {
  u8: 1, bool: 1, pubkey: 32, u64: 8, i64: 8, bytes128: 128, ClawbackReason: 1, IssuerAuthorityChangeKind: 1,
};

export const EVENT_SPECS: readonly EventSpec[] = [
  { name: "PauseFlagsChanged", discriminator: [56, 73, 67, 44, 237, 239, 68, 124],
    fields: [["old", "u8"], ["new", "u8"], ["by", "pubkey"]] },
  { name: "ProtocolTreasuryChanged", discriminator: [198, 130, 237, 240, 185, 150, 215, 36],
    fields: [["old", "pubkey"], ["new", "pubkey"], ["by", "pubkey"]] },
  { name: "BlocklistClawback", discriminator: [97, 42, 115, 107, 117, 180, 2, 87],
    fields: [["share_class", "pubkey"], ["mint", "pubkey"], ["holder", "pubkey"], ["block_entry", "pubkey"],
      ["blocked_by", "pubkey"], ["admin", "pubkey"], ["destination", "pubkey"], ["custody_vault", "pubkey"],
      ["kyc_gated", "bool"], ["amount", "u64"]] },
  { name: "HolderClawback", discriminator: [193, 140, 184, 75, 243, 142, 7, 113],
    fields: [["share_class", "pubkey"], ["mint", "pubkey"], ["registry", "pubkey"], ["holder", "pubkey"],
      ["destination", "pubkey"], ["custody_vault", "pubkey"], ["reason", "ClawbackReason"], ["amount", "u64"]] },
  { name: "RentReclaimed", discriminator: [148, 54, 67, 236, 53, 252, 14, 165],
    fields: [["kind", "u8"], ["target", "pubkey"], ["owner", "pubkey"], ["lamports", "u64"]] },
  { name: "IssuerAuthorityProposed", discriminator: [215, 101, 142, 231, 24, 242, 59, 44],
    fields: [["issuer", "pubkey"], ["current_authority", "pubkey"], ["new_authority", "pubkey"]] },
  { name: "IssuerAuthorityChanged", discriminator: [26, 127, 49, 9, 50, 234, 135, 197],
    fields: [["issuer", "pubkey"], ["old_authority", "pubkey"], ["new_authority", "pubkey"],
      ["kind", "IssuerAuthorityChangeKind"], ["capabilities_carried", "u8"], ["old_grant_closed", "bool"]] },
  { name: "IssuerAuthorityProposalCancelled", discriminator: [43, 135, 248, 83, 159, 243, 107, 102],
    fields: [["issuer", "pubkey"], ["authority", "pubkey"], ["cancelled_new_authority", "pubkey"]] },
  { name: "IssuerRecoveryProposed", discriminator: [117, 196, 141, 157, 240, 61, 3, 207],
    fields: [["issuer", "pubkey"], ["current_authority", "pubkey"], ["new_authority", "pubkey"],
      ["proposed_by", "pubkey"], ["eta", "i64"], ["expires_at", "i64"]] },
  { name: "IssuerRecoveryCancelled", discriminator: [156, 183, 144, 42, 148, 88, 111, 180],
    fields: [["issuer", "pubkey"], ["cancelled_by", "pubkey"], ["new_authority", "pubkey"]] },
  { name: "KycRegistryCreated", discriminator: [134, 229, 228, 219, 88, 129, 152, 142],
    fields: [["registry", "pubkey"], ["authority", "pubkey"]] },
  { name: "KycRegistryAuthorityProposed", discriminator: [1, 251, 13, 136, 237, 219, 150, 172],
    fields: [["registry", "pubkey"], ["current_authority", "pubkey"], ["new_authority", "pubkey"]] },
  { name: "KycRegistryAuthorityChanged", discriminator: [5, 85, 28, 227, 222, 212, 79, 152],
    fields: [["registry", "pubkey"], ["old_authority", "pubkey"], ["new_authority", "pubkey"]] },
  { name: "KycRegistryAuthorityProposalCancelled", discriminator: [34, 245, 0, 88, 180, 169, 40, 22],
    fields: [["registry", "pubkey"], ["authority", "pubkey"], ["cancelled_new_authority", "pubkey"]] },
  { name: "KycRegistryJurisdictionsUpdated", discriminator: [201, 253, 149, 20, 244, 170, 112, 47],
    fields: [["registry", "pubkey"], ["authority", "pubkey"], ["approved_jurisdictions", "bytes128"],
      ["blocked_jurisdictions", "bytes128"]] },
  { name: "TreasuryMinted", discriminator: [135, 209, 252, 211, 119, 103, 189, 6],
    fields: [["share_class", "pubkey"], ["mint", "pubkey"], ["destination", "pubkey"], ["destination_owner", "pubkey"],
      ["amount", "u64"]] },
];

export type EventValue = string | number | boolean;
export type DecodedEvent =
  | { name: string; data: Record<string, EventValue> }
  | { name: "unknown" }
  | { name: string; error: "LAYOUT" };

export function eventSize(spec: EventSpec): number {
  return 8 + spec.fields.reduce((sum, [, type]) => sum + SIZES[type], 0);
}

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** Decodes one `Program data:` payload. Exact length only. */
export function decodeRegistryEvent(bytes: Uint8Array): DecodedEvent {
  if (bytes.length < 8) return { name: "unknown" };
  const spec = EVENT_SPECS.find((s) => s.discriminator.every((b, i) => bytes[i] === b));
  if (!spec) return { name: "unknown" };
  if (bytes.length !== eventSize(spec)) return { name: spec.name, error: "LAYOUT" };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const base58 = getBase58Decoder();
  const data: Record<string, EventValue> = {};
  let offset = 8;
  for (const [field, type] of spec.fields) {
    switch (type) {
      case "u8":
        data[field] = bytes[offset];
        break;
      case "bool":
        if (bytes[offset] > 1) return { name: spec.name, error: "LAYOUT" };
        data[field] = bytes[offset] === 1;
        break;
      case "pubkey":
        data[field] = base58.decode(bytes.subarray(offset, offset + 32));
        break;
      case "u64":
        data[field] = view.getBigUint64(offset, true).toString();
        break;
      case "i64":
        data[field] = view.getBigInt64(offset, true).toString();
        break;
      case "bytes128":
        data[field] = hex(bytes.subarray(offset, offset + 128));
        break;
      case "ClawbackReason": {
        if (bytes[offset] > 1) return { name: spec.name, error: "LAYOUT" };
        const reason = getClawbackReasonDecoder().decode(bytes.subarray(offset, offset + 1));
        data[field] = reason === ClawbackReason.Expired ? "expired" : "revoked";
        break;
      }
      case "IssuerAuthorityChangeKind": {
        if (bytes[offset] > 2) return { name: spec.name, error: "LAYOUT" };
        const kind = getIssuerAuthorityChangeKindDecoder().decode(bytes.subarray(offset, offset + 1));
        data[field] = kind === IssuerAuthorityChangeKind.Rotation ? "rotation"
          : kind === IssuerAuthorityChangeKind.TimelockedRecovery ? "timelocked_recovery" : "registration_recovery";
        break;
      }
    }
    offset += SIZES[type];
  }
  return { name: spec.name, data };
}
