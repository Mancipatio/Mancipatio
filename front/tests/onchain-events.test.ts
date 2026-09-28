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
  if (t.array && t.array[0] === "u8" && t.array[1] === 32) return "bytes32";
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
    expect(idl.types.find((t) => t.name === "PlatformAdminChangeKind")!.type.variants)
      .toEqual([{ name: "Rotation" }, { name: "Recovery" }]);
  });

  // v1.0.0-rc (8.3): the ten new events are all decoded.
  it("decodes the ten v1.0.0-rc events, the reason hash as hex and the change kind by name", () => {
    const v1 = ["IssuerProceedsFrozen", "IssuerProceedsUnfrozen", "AdminProposed", "AdminProposalCancelled", "AdminAdded",
      "AuthorityProposalCreated", "AuthorityProposalCancelled", "PlatformAdminChanged", "PlatformRecoveryProposed", "PlatformRecoveryCancelled"];
    for (const name of v1) {
      expect(EVENT_SPECS.map((s) => s.name), name).toContain(name);
      expect(decodeRegistryEvent(encodeEvent(name, {})), name).toMatchObject({ name, data: expect.any(Object) });
    }
    const reason = new Uint8Array(32).fill(0xab);
    expect(decodeRegistryEvent(encodeEvent("IssuerProceedsFrozen", { frozen_by: OTHER, frozen_at: 1_700_000_000, reason_hash: reason })))
      .toEqual({ name: "IssuerProceedsFrozen", data: { issuer: KEY, frozen_by: OTHER, frozen_at: "1700000000", reason_hash: "ab".repeat(32) } });
    expect(decodeRegistryEvent(encodeEvent("AdminProposed", { new_admin: OTHER, eta: 172_800, expires_at: 1_382_400, bootstrap_open: true })))
      .toMatchObject({ data: { new_admin: OTHER, eta: "172800", expires_at: "1382400", bootstrap_open: true } });
    expect(decodeRegistryEvent(encodeEvent("AuthorityProposalCreated", { kind: 1, new_authority: OTHER })))
      .toMatchObject({ data: { kind: 1, new_authority: OTHER } });
    expect(decodeRegistryEvent(encodeEvent("PlatformAdminChanged", { kind: 0 }))).toMatchObject({ data: { kind: "rotation" } });
    expect(decodeRegistryEvent(encodeEvent("PlatformAdminChanged", { kind: 1, new_admin: OTHER })))
      .toMatchObject({ data: { kind: "recovery", new_admin: OTHER } });
    const bad = encodeEvent("PlatformAdminChanged", {});
    bad[8 + 64] = 2;
    expect(decodeRegistryEvent(bad)).toEqual({ name: "PlatformAdminChanged", error: "LAYOUT" });
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
