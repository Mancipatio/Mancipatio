import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CLUSTER_GENESIS_HASHES } from "@/lib/network-identity";
import { getRegistryPda } from "@/lib/passport";
import { validateRoleMap, type RoleMapContext } from "@/scripts/chain/lib/role-map";
import { ChainGateError } from "@/scripts/chain/lib/safety";
import { defaultKeys, key, roleMapJson } from "./helpers/chain-fake";

const devnet: RoleMapContext = { network: "devnet", genesis: CLUSTER_GENESIS_HASHES.devnet };
const mainnet: RoleMapContext = { network: "mainnet", genesis: CLUSTER_GENESIS_HASHES.mainnet };

async function map(overrides: Record<string, unknown> = {}, network: "devnet" | "mainnet" = "devnet") {
  const keys = await defaultKeys();
  const genesis = network === "mainnet" ? CLUSTER_GENESIS_HASHES.mainnet : CLUSTER_GENESIS_HASHES.devnet;
  return { keys, json: await roleMapJson(keys, network, genesis, overrides) };
}

async function rejects(json: unknown, ctx: RoleMapContext = devnet): Promise<string> {
  try {
    await validateRoleMap(json, ctx);
  } catch (error) {
    expect(error).toBeInstanceOf(ChainGateError);
    return (error as Error).message;
  }
  throw new Error("expected the role map to be rejected");
}

describe("role map v2 validation", () => {
  it("kyc.authority may not get an Admin record (in admins, or as the SA) unless allowKycAdmin", async () => {
    const { keys, json } = await map();
    expect(await rejects({ ...json, admins: [...keys.admins, keys.kycAuthority] })).toMatch(/kyc.authority must not be in admins/);
    const kycIsSa = { ...json, superAdmin: keys.kycAuthority };
    expect(await rejects(kycIsSa)).toMatch(/kyc.authority must not be the superAdmin/);
    await expect(validateRoleMap({ ...kycIsSa, allowKycAdmin: true }, devnet)).resolves.toBeTruthy();
    await expect(validateRoleMap({ ...json, admins: [...keys.admins, keys.kycAuthority], allowKycAdmin: true }, devnet)).resolves.toBeTruthy();
  });


  it("accepts a complete devnet map and derives the registry pin", async () => {
    const { keys, json } = await map();
    const { map: parsed, warnings } = await validateRoleMap(json, devnet);
    expect(parsed.kyc.registry).toBe(await getRegistryPda(keys.deployer));
    expect(parsed.kyc.approvedJurisdictions.length).toBeGreaterThan(10);
    expect(parsed.squads.configAuthority).toBeNull();
    expect(warnings).toEqual([]);
  });

  it("pins network, genesis, schema and the program IDs", async () => {
    const { json } = await map();
    expect(await rejects({ ...json, network: "testnet" })).toMatch(/network must be devnet/);
    expect(await rejects({ ...json, genesisHash: CLUSTER_GENESIS_HASHES.mainnet })).toMatch(/genesisHash/);
    expect(await rejects({ ...json, schema: "v1" })).toMatch(/schema/);
    expect(await rejects({ ...json, programs: { ...json.programs, assetRegistry: key(3) } })).toMatch(/programs.assetRegistry/);
    expect(await rejects(json, mainnet)).toMatch(/network must be mainnet/);
  });

  it("rejects invalid and default addresses", async () => {
    const { json } = await map();
    expect(await rejects({ ...json, deployer: "not-a-key" })).toMatch(/deployer is not a valid address/);
    expect(await rejects({ ...json, superAdmin: "11111111111111111111111111111111" })).toMatch(/superAdmin is the default key/);
  });

  it("enforces the Squads rules: vault derivation, treasury, members, threshold", async () => {
    const { json } = await map();
    const squads = json.squads as Record<string, unknown>;
    expect(await rejects({ ...json, squads: { ...squads, vault: key(99) }, protocolTreasury: key(99) })).toMatch(/squads.vault is not PDA/);
    expect(await rejects({ ...json, protocolTreasury: key(98) })).toMatch(/protocolTreasury must be the Squads vault/);
    expect(await rejects({ ...json, squads: { ...squads, threshold: 4 } })).toMatch(/exceeds the 3 members with vote/);
    const dup = [{ key: key(31), permissions: ["vote"] }, { key: key(31), permissions: ["initiate", "execute"] }];
    expect(await rejects({ ...json, squads: { ...squads, threshold: 1, members: dup } })).toMatch(/duplicate keys/);
    expect(await rejects({ ...json, squads: { ...squads, members: [{ key: key(31), permissions: ["admin"] }] } })).toMatch(/subset of initiate, vote, execute/);
    const { configAuthority: _omit, ...withoutConfig } = squads;
    void _omit;
    expect(await rejects({ ...json, squads: withoutConfig })).toMatch(/configAuthority must be present/);
  });

  it("on mainnet requires threshold ≥ 2, no config authority, the registry pin and a distinct bufferWriter", async () => {
    const { json } = await map({}, "mainnet");
    await expect(validateRoleMap(json, mainnet)).resolves.toBeTruthy();
    const squads = json.squads as Record<string, unknown>;
    expect(await rejects({ ...json, squads: { ...squads, threshold: 1 } }, mainnet)).toMatch(/at least 2 on mainnet/);
    expect(await rejects({ ...json, squads: { ...squads, configAuthority: key(50) } }, mainnet)).toMatch(/configAuthority must be null on mainnet/);
    expect(await rejects({ ...json, kyc: { ...(json.kyc as object), registry: null } }, mainnet)).toMatch(/kyc.registry is required on mainnet/);
    expect(await rejects({ ...json, bufferWriter: json.deployer }, mainnet)).toMatch(/bufferWriter must differ from the deployer on mainnet/);
    expect(await rejects({ ...json, superAdmin: json.deployer }, mainnet)).toMatch(/deployer must not be the superAdmin on mainnet/);
    expect(await rejects({ ...json, unpauseBy: "deployer" }, mainnet)).toMatch(/unpauseBy must be superAdmin on mainnet/);
  });

  it("isolates the deployer and the bufferWriter", async () => {
    const { keys, json } = await map();
    expect(await rejects({ ...json, blocklistAuthority: keys.deployer })).toMatch(/deployer must hold no final role/);
    expect(await rejects({ ...json, admins: [keys.deployer] })).toMatch(/deployer must hold no final role/);
    const squads = json.squads as { members: { key: string; permissions: string[] }[] };
    const withDeployer = { ...squads, members: [...squads.members, { key: keys.deployer, permissions: ["vote"] }] };
    expect(await rejects({ ...json, squads: withDeployer })).toMatch(/deployer must not be a Squads member/);
    expect(await rejects({ ...json, bufferWriter: keys.blocklistAuthority })).toMatch(/bufferWriter must hold no role/);
    const withWriter = { ...squads, members: [...squads.members, { key: keys.bufferWriter, permissions: ["vote"] }] };
    expect(await rejects({ ...json, squads: withWriter })).toMatch(/bufferWriter must not be a Squads member/);
    // Off mainnet the deployer may be the SA and the bufferWriter (warnings).
    const deployerIsSa = await validateRoleMap({ ...json, superAdmin: keys.deployer }, devnet);
    expect(deployerIsSa.warnings.join(" ")).toMatch(/S5 and X1 are skipped/);
    const writerIsDeployer = await validateRoleMap({ ...json, bufferWriter: keys.deployer }, devnet);
    expect(writerIsDeployer.warnings.join(" ")).toMatch(/bufferWriter == deployer/);
    // The bufferWriter may never be the SA, even when the deployer is.
    expect(await rejects({ ...json, superAdmin: keys.deployer, bufferWriter: keys.deployer })).toMatch(/bufferWriter must hold no role/);
  });

  it("keeps BA, KYC and SA off the Squads accounts; BA == SA is a warning", async () => {
    const { keys, json } = await map();
    expect(await rejects({ ...json, blocklistAuthority: keys.vault })).toMatch(/blocklistAuthority must not be the Squads vault/);
    expect(await rejects({ ...json, kyc: { ...(json.kyc as object), authority: keys.multisig } })).toMatch(/kyc.authority must not be the Squads/);
    expect(await rejects({ ...json, superAdmin: keys.vault })).toMatch(/superAdmin must not be the Squads vault/);
    await expect(validateRoleMap({ ...json, superAdmin: keys.vault, k4Fallback: true }, devnet)).resolves.toBeTruthy();
    const same = await validateRoleMap({ ...json, blocklistAuthority: keys.superAdmin }, devnet);
    expect(same.warnings.join(" ")).toMatch(/blocklistAuthority == superAdmin/);
  });

  it("never lists the SA in admins[] (accept_platform_admin creates its record)", async () => {
    const { keys, json } = await map();
    expect(await rejects({ ...json, admins: [keys.superAdmin] })).toMatch(/must not list the superAdmin/);
  });

  it("requires the registry pin to be PDA(deployer)", async () => {
    const { json } = await map();
    expect(await rejects({ ...json, kyc: { ...(json.kyc as object), registry: key(77) } })).toMatch(/KycRegistry PDA of the deployer/);
  });

  it("fee must be 0 unless allowNonZeroFee", async () => {
    const { json } = await map();
    expect(await rejects({ ...json, protocolFeeBps: 50 })).toMatch(/protocolFeeBps must be 0/);
    await expect(validateRoleMap({ ...json, protocolFeeBps: 50, allowNonZeroFee: true }, devnet)).resolves.toBeTruthy();
    expect(await rejects({ ...json, protocolFeeBps: 1001, allowNonZeroFee: true })).toMatch(/protocolFeeBps/);
  });

  it("tempAdminGrant warns, and on mainnet needs allowTempKycAdmin (D17)", async () => {
    const { json } = await map();
    const temp = await validateRoleMap({ ...json, kyc: { ...(json.kyc as object), tempAdminGrant: true } }, devnet);
    expect(temp.warnings.join(" ")).toMatch(/kycProvider gate missing/);
    const main = (await map({}, "mainnet")).json;
    const kyc = { ...(main.kyc as object), tempAdminGrant: true };
    expect(await rejects({ ...main, kyc }, mainnet)).toMatch(/needs allowTempKycAdmin/);
    await expect(validateRoleMap({ ...main, kyc, allowTempKycAdmin: true }, mainnet)).resolves.toBeTruthy();
  });

  it("the committed localnet example (public keys only) validates", async () => {
    const example = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../scripts/chain/role-map.example.json"), "utf8"));
    const { map: parsed } = await validateRoleMap(example, { network: "localnet", genesis: example.genesisHash });
    expect(parsed.kyc.registry).toBe(await getRegistryPda(parsed.deployer));
    expect(JSON.stringify(example)).not.toMatch(/\[\s*\d+\s*,\s*\d+\s*,\s*\d+/);
  });

  it("rejects unrepresentable or empty jurisdiction sets", async () => {
    const { json } = await map();
    expect(await rejects({ ...json, kyc: { ...(json.kyc as object), approvedJurisdictions: [] } })).toMatch(/freeze every KycGated receiver/);
    expect(await rejects({ ...json, kyc: { ...(json.kyc as object), approvedJurisdictions: [5000] } })).toMatch(/does not fit/);
  });
});
