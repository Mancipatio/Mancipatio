// Talas 4.4b: the hand-written event decoders are pinned to the IDL field by
// field, and accept only the exact length (a different size is IDL drift).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EVENT_SPECS, decodeRegistryEvent, type FieldType } from "@/lib/server/onchain-events";
import { encodeEvent, KEY } from "./helpers/chain-tx";

type IdlType = string | { defined?: { name: string }; array?: [string, number] };
const idl = JSON.parse(readFileSync(join(process.cwd(), "idl/asset_registry.json"), "utf8")) as {
  events: { name: string; discriminator: number[] }[];
  types: { name: string; type: { kind: string; fields?: { name: string; type: IdlType }[]; variants?: unknown[] } }[];
};
const idlType = (t: IdlType): FieldType => {
  if (typeof t === "string") return t as FieldType;
  if (t.defined) return t.defined.name as FieldType;
  if (t.array && t.array[0] === "u8" && t.array[1] === 128) return "bytes128";
  throw new Error(`Unexpected IDL type ${JSON.stringify(t)}`);
};

const OTHER = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

describe("asset_registry event decoders", () => {
  it("pins every decoder's discriminator, field order and types to idl/asset_registry.json", () => {
    for (const spec of EVENT_SPECS) {
      const event = idl.events.find((e) => e.name === spec.name);
      expect(event, spec.name).toBeDefined();
      expect([...spec.discriminator], spec.name).toEqual(event!.discriminator);
      const type = idl.types.find((t) => t.name === spec.name)!;
      expect(spec.fields.map(([n, t]) => [n, t]), spec.name).toEqual(type.type.fields!.map((f) => [f.name, idlType(f.type)]));
    }
    // The enums the decoders read keep their variant order.
    expect(idl.types.find((t) => t.name === "ClawbackReason")!.type.variants).toEqual([{ name: "Revoked" }, { name: "Expired" }]);
    expect(idl.types.find((t) => t.name === "IssuerAuthorityChangeKind")!.type.variants)
      .toEqual([{ name: "Rotation" }, { name: "TimelockedRecovery" }, { name: "RegistrationRecovery" }]);
  });

  it("decodes values and pubkeys at the exact length", () => {
    expect(decodeRegistryEvent(encodeEvent("PauseFlagsChanged", { old: 0x01, new: 0x3f, by: KEY })))
      .toEqual({ name: "PauseFlagsChanged", data: { old: 1, new: 0x3f, by: KEY } });
    expect(decodeRegistryEvent(encodeEvent("BlocklistClawback", { blocked_by: KEY, admin: OTHER, kyc_gated: true, amount: 42 })))
      .toMatchObject({ name: "BlocklistClawback", data: { blocked_by: KEY, admin: OTHER, kyc_gated: true, amount: "42" } });
    expect(decodeRegistryEvent(encodeEvent("HolderClawback", { reason: 1 }))).toMatchObject({ data: { reason: "expired" } });
    expect(decodeRegistryEvent(encodeEvent("IssuerAuthorityChanged", { kind: 2, capabilities_carried: 3 })))
      .toMatchObject({ data: { kind: "registration_recovery", capabilities_carried: 3 } });
    expect(decodeRegistryEvent(encodeEvent("IssuerRecoveryProposed", { eta: -5 }))).toMatchObject({ data: { eta: "-5" } });
    const jurisdictions = decodeRegistryEvent(encodeEvent("KycRegistryJurisdictionsUpdated", {}));
    expect((jurisdictions as { data: Record<string, string> }).data.approved_jurisdictions).toBe("00".repeat(128));
  });

  it("refuses any other length as LAYOUT (IDL drift), and an out-of-range enum or bool", () => {
    const pause = encodeEvent("PauseFlagsChanged", {});
    expect(decodeRegistryEvent(pause.slice(0, pause.length - 1))).toEqual({ name: "PauseFlagsChanged", error: "LAYOUT" });
    expect(decodeRegistryEvent(new Uint8Array([...pause, 0]))).toEqual({ name: "PauseFlagsChanged", error: "LAYOUT" });
    const reason = encodeEvent("HolderClawback", {});
    reason[8 + 32 * 6] = 7;
    expect(decodeRegistryEvent(reason)).toEqual({ name: "HolderClawback", error: "LAYOUT" });
    const bool = encodeEvent("BlocklistClawback", {});
    bool[8 + 32 * 8] = 2;
    expect(decodeRegistryEvent(bool)).toEqual({ name: "BlocklistClawback", error: "LAYOUT" });
  });

  it("an unknown discriminator or a short buffer is unknown, never a guess", () => {
    expect(decodeRegistryEvent(new Uint8Array(8))).toEqual({ name: "unknown" });
    expect(decodeRegistryEvent(new Uint8Array(3))).toEqual({ name: "unknown" });
  });
});
