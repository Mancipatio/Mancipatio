// 2C-1: every KYC registry instruction targets the registry BY ADDRESS; the
// IDL, the indexer and the tx-error hints agree.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import {
  address,
  generateKeyPairSigner,
  getAddressEncoder,
  getProgramDerivedAddress,
  getUtf8Encoder,
} from "@solana/kit";
import { ASSET_REGISTRY_PROGRAM_ADDRESS, findKycRegistryPda } from "@/lib/generated/asset_registry";
import {
  buildAcceptKycAuthority,
  buildCancelKycAuthorityTransfer,
  buildIssuePassport,
  buildProposeKycAuthority,
  buildRevokePassport,
  buildUpdateRegistryJurisdictions,
  findKycRegistryTransferPda,
  jurisdictionBitmap,
} from "@/lib/passport";
import { decodeIndexerAccount, INDEXER_ENTITIES, INDEXER_PROGRAM } from "@/lib/server/indexer-accounts";
import {
  explainSendError,
  INVALID_KYC_REGISTRY_HINT,
  KYC_REGISTRY_NOT_ALLOWED_HINT,
  KYC_REGISTRY_NOT_AUTHORITY_HINT,
  NO_PENDING_AUTHORITY_TRANSFER_HINT,
} from "@/lib/tx-error";
import { indexerFixtures } from "./helpers/indexer-fixtures";

const REGISTRY = address("5MofiJNCoCRkNg1f2Yd7368WkjiNxkZZmUTaQo7xLhku");
const HOLDER = address("So11111111111111111111111111111111111111112");

async function transferPda(registry: string) {
  const [pda] = await getProgramDerivedAddress({
    programAddress: ASSET_REGISTRY_PROGRAM_ADDRESS,
    seeds: [getUtf8Encoder().encode("authority_transfer"), getAddressEncoder().encode(address(registry))],
  });
  return pda;
}

describe("passport builders take the registry by address", () => {
  it("approve / revoke target the given registry, not the signer's seed PDA", async () => {
    const signer = await generateKeyPairSigner();
    const [seedPda] = await findKycRegistryPda({ authority: signer.address });
    const approve = await buildIssuePassport({
      authoritySigner: signer,
      registry: REGISTRY,
      holder: HOLDER,
      jurisdiction: 688,
      accreditationLevel: 0,
      expiry: BigInt(4_102_444_800),
      providerId: 0,
      externalRefHash: new Uint8Array(32),
    });
    const revoke = await buildRevokePassport({ authoritySigner: signer, registry: REGISTRY, holder: HOLDER });
    for (const ix of [approve, revoke]) {
      expect(ix.accounts[0].address).toBe(signer.address);
      expect(ix.accounts[1].address).toBe(REGISTRY);
      expect(ix.accounts[1].address).not.toBe(seedPda);
    }
  });

  it("propose / accept / cancel use ['authority_transfer', registry]", async () => {
    const signer = await generateKeyPairSigner();
    const expected = await transferPda(REGISTRY);
    expect(await findKycRegistryTransferPda(REGISTRY)).toBe(expected);
    const ixs = [
      await buildProposeKycAuthority({ authoritySigner: signer, registry: REGISTRY, newAuthority: HOLDER }),
      await buildAcceptKycAuthority({ newAuthoritySigner: signer, registry: REGISTRY }),
      await buildCancelKycAuthorityTransfer({ authoritySigner: signer, registry: REGISTRY }),
    ];
    for (const ix of ixs) {
      expect(ix.accounts[0].address).toBe(signer.address);
      expect(ix.accounts[1].address).toBe(REGISTRY);
      expect(ix.accounts[2].address).toBe(expected);
    }
  });

  it("jurisdiction update needs full 128-byte maps", async () => {
    const signer = await generateKeyPairSigner();
    const ix = await buildUpdateRegistryJurisdictions({
      authoritySigner: signer,
      registry: REGISTRY,
      approvedJurisdictions: jurisdictionBitmap([688]),
      blockedJurisdictions: jurisdictionBitmap([]),
    });
    expect(ix.accounts.map((a) => a.address)).toEqual([signer.address, REGISTRY]);
    await expect(
      buildUpdateRegistryJurisdictions({
        authoritySigner: signer,
        registry: REGISTRY,
        approvedJurisdictions: new Uint8Array(32),
        blockedJurisdictions: new Uint8Array(128),
      }),
    ).rejects.toThrow(/128 bytes/);
  });
});

describe("IDL guard (2C-1)", () => {
  type Ix = { name: string; accounts: { name: string; pda?: unknown; signer?: boolean; optional?: boolean }[] };
  const idl = (name: string) =>
    JSON.parse(readFileSync(path.join(__dirname, "..", "idl", `${name}.json`), "utf8")) as {
      instructions: Ix[];
      errors: { code: number; name: string }[];
    };
  const registry = idl("asset_registry");
  const hook = idl("transfer_hook");
  const ix = (name: string, from = registry) => from.instructions.find((i) => i.name === name)!;

  it("approve / revoke take kyc_registry by address (no pda)", () => {
    for (const name of ["approve_holder", "revoke_holder"]) {
      const account = ix(name).accounts.find((a) => a.name === "kyc_registry")!;
      expect(account.pda).toBeUndefined();
    }
  });

  it("the 4 new instructions exist with a single expected signer", () => {
    const signers = (name: string) => ix(name).accounts.filter((a) => a.signer).map((a) => a.name);
    expect(signers("propose_kyc_registry_authority")).toEqual(["authority"]);
    expect(signers("accept_kyc_registry_authority")).toEqual(["new_authority"]);
    expect(signers("cancel_kyc_registry_authority_transfer")).toEqual(["authority"]);
    expect(signers("update_kyc_registry_jurisdictions")).toEqual(["authority"]);
  });

  it("the hook's update ends with an optional kyc_registry_account and appends 6016", () => {
    const accounts = ix("update_transfer_hook_config", hook).accounts;
    expect(accounts.at(-1)).toMatchObject({ name: "kyc_registry_account", optional: true });
    expect(hook.errors.at(-1)).toEqual(expect.objectContaining({ code: 6016, name: "KycRegistryNotAllowed" }));
  });
});

describe("indexer keys kyc_registries by snapshot address", () => {
  it("accepts a registry whose address is not derivable from its authority", async () => {
    const f = indexerFixtures().find((x) => x.table === "kyc_registries")!;
    const result = await decodeIndexerAccount(REGISTRY, INDEXER_PROGRAM, f.bytes);
    expect(result).toMatchObject({ table: "kyc_registries", row: { pda: REGISTRY } });
  });

  it("has no seed fallback: a decode without the snapshot address throws", async () => {
    const f = indexerFixtures().find((x) => x.table === "kyc_registries")!;
    const entity = INDEXER_ENTITIES.find((e) => e.table === "kyc_registries")!;
    await expect(entity.decode(f.bytes, null)).rejects.toThrow(/snapshot address/);
    await expect(entity.decode(f.bytes, REGISTRY)).resolves.toMatchObject({ pda: REGISTRY });
  });

  it("still rejects a wrong PDA for derived entities", async () => {
    const f = indexerFixtures().find((x) => x.table === "share_classes")!;
    await expect(decodeIndexerAccount(REGISTRY, INDEXER_PROGRAM, f.bytes)).rejects.toThrow(/PDA/);
  });
});

describe("KYC registry tx-error hints", () => {
  const withLogs = (logs: string[]) => Object.assign(new Error("Transaction simulation failed"), { context: { logs } });

  it("names the account for the codes shared across programs", () => {
    expect(
      explainSendError(
        withLogs([
          "Program log: AnchorError caused by account: kyc_registry. Error Code: Unauthorized. Error Number: 6001. Error Message: Unauthorized.",
        ]),
      ),
    ).toBe(KYC_REGISTRY_NOT_AUTHORITY_HINT);
    expect(
      explainSendError(
        withLogs([
          "Program log: AnchorError caused by account: transfer. Error Code: AccountNotInitialized. Error Number: 3012. Error Message: The program expected this account to be already initialized.",
        ]),
      ),
    ).toBe(NO_PENDING_AUTHORITY_TRANSFER_HINT);
    expect(
      explainSendError(withLogs(["Program log: AnchorError occurred. Error Code: KycRegistryNotAllowed. Error Number: 6016."])),
    ).toBe(KYC_REGISTRY_NOT_ALLOWED_HINT);
    expect(
      explainSendError(withLogs(["Program log: AnchorError occurred. Error Code: InvalidKycRegistry. Error Number: 6009."])),
    ).toBe(INVALID_KYC_REGISTRY_HINT);
  });

  it("gives the same neutral InvalidKycRegistry hint for asset_registry's buy / clawback", () => {
    // asset_registry's own InvalidKycRegistry (6072), e.g. buy's receiver
    // check or clawback_from_holder with a registry the hook config does not
    // name — the name matches the hook's 6009 deliberately.
    const hint = explainSendError(
      withLogs([
        "Program FJs1EM1ND89L9sUXaS8VBKYXjmoXCkkVSJKRE19hmYxS invoke [1]",
        "Program log: AnchorError thrown in programs/asset_registry/src/util.rs:700. Error Code: InvalidKycRegistry. Error Number: 6072. Error Message: KYC registry account is malformed, truncated, or unexpected.",
      ]),
    );
    expect(hint).toBe(INVALID_KYC_REGISTRY_HINT);
    expect(hint).toMatch(/hook config names/);
    expect(hint).not.toMatch(/registry named \(/);
  });

  it("explains 6112 / 6113 by hex", () => {
    const hint = (code: number) =>
      explainSendError(withLogs([`Program x failed: custom program error: 0x${code.toString(16)}`]));
    expect(hint(6112)).toMatch(/InvalidProposedAuthority/);
    expect(hint(6113)).toMatch(/InvalidAuthorityTransfer/);
  });
});
