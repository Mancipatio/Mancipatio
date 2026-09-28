// v1.0.0-rc (8.3): the rc.x AuthorityTransfer / BlocklistAuthorityTransfer
// left the IDL. One pinned definition (lib/legacy-accounts.ts) serves the
// chain inventory and the indexer; the plain-Node ops twin must agree.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LEGACY_ACCOUNT_TYPES,
  LEGACY_AUTHORITY_TRANSFER,
  LEGACY_BLOCKLIST_AUTHORITY_TRANSFER,
  legacyAccountType,
} from "@/lib/legacy-accounts";
import * as inventory from "../scripts/chain/lib/inventory";
import { LEGACY_ACCOUNTS, legacyAccountType as opsLegacyAccountType } from "../scripts/ops/legacy-accounts.mjs";
import { ASSET_REGISTRY_PROGRAM_ADDRESS } from "@/lib/generated/asset_registry";
import { TRANSFER_HOOK_PROGRAM_ADDRESS } from "@/lib/generated/transfer_hook";

const anchorDiscriminator = (name: string) => [...createHash("sha256").update(`account:${name}`).digest().subarray(0, 8)];
const idl = (name: string) => JSON.parse(readFileSync(join(process.cwd(), "idl", `${name}.json`), "utf8")) as { accounts: { name: string }[] };
const account = (l: { discriminator: Uint8Array; size: number }, size = l.size) => {
  const bytes = new Uint8Array(size);
  bytes.set(l.discriminator);
  return bytes;
};

describe("legacy rc.x account layouts", () => {
  it("pin each discriminator to its Anchor name and each size to the program's own assert", () => {
    expect(LEGACY_ACCOUNT_TYPES).toEqual([LEGACY_AUTHORITY_TRANSFER, LEGACY_BLOCKLIST_AUTHORITY_TRANSFER]);
    for (const legacy of LEGACY_ACCOUNT_TYPES) expect([...legacy.discriminator], legacy.name).toEqual(anchorDiscriminator(legacy.name));
    const registryTest = readFileSync(join(process.cwd(), "../program/programs/asset_registry/tests/test_issuer_rotation.rs"), "utf8");
    const hookTest = readFileSync(join(process.cwd(), "../program/programs/transfer_hook/tests/test_blocklist_recovery.rs"), "utf8");
    expect(registryTest).toContain(`assert_eq!(8 + AuthorityTransfer::INIT_SPACE, ${LEGACY_AUTHORITY_TRANSFER.size});`);
    expect(hookTest).toContain(`assert_eq!(8 + BlocklistAuthorityTransfer::INIT_SPACE, ${LEGACY_BLOCKLIST_AUTHORITY_TRANSFER.size});`);
    expect(LEGACY_AUTHORITY_TRANSFER.programAddress).toBe(ASSET_REGISTRY_PROGRAM_ADDRESS);
    expect(LEGACY_BLOCKLIST_AUTHORITY_TRANSFER.programAddress).toBe(TRANSFER_HOOK_PROGRAM_ADDRESS);
  });

  it("are gone from the IDL, which now has their v1 replacements", () => {
    const registry = idl("asset_registry").accounts.map((a) => a.name);
    const hook = idl("transfer_hook").accounts.map((a) => a.name);
    expect(registry).not.toContain("AuthorityTransfer");
    expect(hook).not.toContain("BlocklistAuthorityTransfer");
    expect(registry).toContain("AuthorityProposal");
    expect(hook).toContain("BlocklistAuthorityProposal");
  });

  it("match only the right owner, the discriminator and the exact size", () => {
    expect(legacyAccountType(ASSET_REGISTRY_PROGRAM_ADDRESS, account(LEGACY_AUTHORITY_TRANSFER))).toBe(LEGACY_AUTHORITY_TRANSFER);
    expect(legacyAccountType(TRANSFER_HOOK_PROGRAM_ADDRESS, account(LEGACY_BLOCKLIST_AUTHORITY_TRANSFER))).toBe(LEGACY_BLOCKLIST_AUTHORITY_TRANSFER);
    expect(legacyAccountType(TRANSFER_HOOK_PROGRAM_ADDRESS, account(LEGACY_AUTHORITY_TRANSFER))).toBeNull();
    expect(legacyAccountType(ASSET_REGISTRY_PROGRAM_ADDRESS, account(LEGACY_AUTHORITY_TRANSFER, 163))).toBeNull();
    expect(legacyAccountType(ASSET_REGISTRY_PROGRAM_ADDRESS, new Uint8Array(137))).toBeNull();
  });

  it("are the same objects the chain inventory uses", () => {
    expect(inventory.LEGACY_AUTHORITY_TRANSFER).toBe(LEGACY_AUTHORITY_TRANSFER);
    expect(inventory.LEGACY_BLOCKLIST_AUTHORITY_TRANSFER).toBe(LEGACY_BLOCKLIST_AUTHORITY_TRANSFER);
  });

  it("agree with the plain-Node twin of the devnet rollout inventory", () => {
    expect(LEGACY_ACCOUNTS.map((l) => [l.name, l.program, l.seed, l.size, [...l.discriminator]]))
      .toEqual(LEGACY_ACCOUNT_TYPES.map((l) => [l.name, l.program, l.seed, l.size, [...l.discriminator]]));
    expect(opsLegacyAccountType("asset_registry", account(LEGACY_AUTHORITY_TRANSFER))?.name).toBe("AuthorityTransfer");
    expect(opsLegacyAccountType("transfer_hook", account(LEGACY_BLOCKLIST_AUTHORITY_TRANSFER))?.name).toBe("BlocklistAuthorityTransfer");
    expect(opsLegacyAccountType("transfer_hook", account(LEGACY_AUTHORITY_TRANSFER))).toBeNull();
    expect(opsLegacyAccountType("asset_registry", account(LEGACY_AUTHORITY_TRANSFER, 138))).toBeNull();
    // The rollout inventory classifies them before the "Unknown layout" blocker.
    const script = readFileSync(join(process.cwd(), "scripts/ops/devnet-rollout-inventory.mjs"), "utf8");
    expect(script.indexOf("legacyAccountType(programName, account.data)")).toBeGreaterThan(0);
    expect(script.indexOf("legacyAccountType(programName, account.data)")).toBeLessThan(script.indexOf("Unknown ${programName} account layout"));
  });
});
