// lib/pdas: positional wrappers over the GENERATED PDA helpers for the
// v1.0.0-rc (8.3) accounts. The seeds come from the IDL only; these tests pin
// that Codama's per-instruction helpers for one seed agree, and that the
// wrappers return exactly what the generated helpers derive.
import { address, getAddressEncoder, getProgramDerivedAddress } from "@solana/kit";
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  findAcceptIssuerAuthorityTransferPda,
  findAcceptKycRegistryAuthorityTransferPda,
  findAcceptPlatformAdminRecoveryPda,
  findAcceptPlatformAdminTransferPda,
  findIssuerFreezePda as generatedIssuerFreeze,
  findPendingAdminPda as generatedPendingAdmin,
  findPlatformPda,
  findTransferPda as findCustodyTransferPda,
} from "@/lib/generated/asset_registry";
import {
  TRANSFER_HOOK_PROGRAM_ADDRESS,
  findBlockEntryPda as generatedBlockEntry,
  findRecoveryPda,
  findTransferPda,
} from "@/lib/generated/transfer_hook";
import {
  findAuthorityProposalPda,
  findBlockEntryPda,
  findBlocklistAuthorityProposalPda,
  findBlocklistRecoveryPda,
  findIssuerFreezePda,
  findPendingAdminPda,
  findPlatformRecoveryPda,
  findProgramDataPda,
} from "@/lib/pdas";
import { programDataAddresses } from "@/lib/server/onchain-alarms";

const TARGET = address("SysvarRent111111111111111111111111111111111");
const WALLET = address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

describe("v1 PDA wrappers derive through the generated helpers", () => {
  it("every generated helper of the ['authority_proposal', target] seed agrees with findAuthorityProposalPda", async () => {
    const want = await findAuthorityProposalPda(TARGET);
    expect((await findAcceptPlatformAdminTransferPda({ platform: TARGET }))[0]).toBe(want);
    expect((await findAcceptIssuerAuthorityTransferPda({ issuer: TARGET }))[0]).toBe(want);
    expect((await findAcceptKycRegistryAuthorityTransferPda({ kycRegistry: TARGET }))[0]).toBe(want);
    expect((await findCustodyTransferPda({ custodyVault: TARGET }))[0]).toBe(want);
    // And it is the seed the program uses (not rc.x's "authority_transfer").
    const [raw] = await getProgramDerivedAddress({
      programAddress: ASSET_REGISTRY_PROGRAM_ADDRESS,
      seeds: [new TextEncoder().encode("authority_proposal"), getAddressEncoder().encode(TARGET)],
    });
    expect(want).toBe(raw);
  });

  it("the other wrappers return the generated derivations", async () => {
    const [platform] = await findPlatformPda();
    expect(await findPendingAdminPda(WALLET)).toBe((await generatedPendingAdmin({ newAdmin: WALLET }))[0]);
    expect(await findPlatformRecoveryPda()).toBe((await findAcceptPlatformAdminRecoveryPda({ platform }))[0]);
    expect(await findIssuerFreezePda(TARGET)).toBe((await generatedIssuerFreeze({ issuer: TARGET }))[0]);
    expect(await findBlockEntryPda(WALLET)).toBe((await generatedBlockEntry({ wallet: WALLET }))[0]);
    expect(await findBlocklistAuthorityProposalPda()).toBe((await findTransferPda())[0]);
    expect(await findBlocklistRecoveryPda()).toBe((await findRecoveryPda())[0]);
  });

  it("ProgramData is the loader's PDA, the one the alarms watch", async () => {
    const watched = await programDataAddresses();
    expect(await findProgramDataPda()).toBe(watched.assetRegistry);
    expect(await findProgramDataPda(TRANSFER_HOOK_PROGRAM_ADDRESS)).toBe(watched.transferHook);
  });
});
