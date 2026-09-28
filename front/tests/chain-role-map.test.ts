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

/** The same map on localnet, where an unacknowledged overlap only warns (Talas 8.2 review). */
function onLocalnet(json: Record<string, unknown>): [Record<string, unknown>, RoleMapContext] {
  return [{ ...json, network: "localnet" }, { network: "localnet", genesis: json.genesisHash as string }];
}

describe("role map v2 validation", () => {
  it("kyc.authority may not get an Admin record (in admins, or as the SA) unless allowKycAdmin", async () => {
    const { keys, json } = await map();
    expect(await rejects({ ...json, admins: [...keys.admins, keys.kycAuthority] })).toMatch(/kyc.authority must not be in admins/);
    const kycIsSa = { ...json, superAdmin: keys.kycAuthority };
    expect(await rejects(kycIsSa)).toMatch(/kyc.authority must not be the superAdmin/);
    // allowKycAdmin lifts that rule; the shared key still needs its overlap
    // acknowledged off localnet (Talas 8.2), so the flag is checked on localnet.
    await expect(validateRoleMap(...onLocalnet({ ...kycIsSa, allowKycAdmin: true }))).resolves.toBeTruthy();
    await expect(validateRoleMap(...onLocalnet({ ...json, admins: [...keys.admins, keys.kycAuthority], allowKycAdmin: true }))).resolves.toBeTruthy();
    expect(await rejects({ ...kycIsSa, allowKycAdmin: true })).toMatch(/role overlap not acknowledged: kyc\.authority == superAdmin/);
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

  it("unpauseMask: the emergency areas by default, never the payout modules or the bootstrap marker (8.3)", async () => {
    const { json } = await map({}, "mainnet");
    expect((await validateRoleMap(json, mainnet)).map.unpauseMask).toBe(0x3f);
    expect((await validateRoleMap({ ...json, unpauseMask: 0x03 }, mainnet)).map.unpauseMask).toBe(0x03);
    for (const bad of [0, 0x40, 0x7f, 0x80, 0xbf, "0x3f", 1.5]) {
      expect(await rejects({ ...json, unpauseMask: bad }, mainnet)).toMatch(/unpauseMask must be a non-empty subset of the emergency pause bits 0x3f/);
    }
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
    // BA == SA: a warning on localnet, refused elsewhere without an acknowledgement.
    const same = await validateRoleMap(...onLocalnet({ ...json, blocklistAuthority: keys.superAdmin }));
    expect(same.warnings.join(" ")).toMatch(/blocklistAuthority == superAdmin/);
    expect(await rejects({ ...json, blocklistAuthority: keys.superAdmin })).toMatch(/role overlap not acknowledged: blocklistAuthority == superAdmin/);
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

  it("the committed company-wallet example validates on mainnet, with a loud acknowledged-overlap warning", async () => {
    const example = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../scripts/chain/role-map.company.example.json"), "utf8"));
    const { map: parsed, warnings } = await validateRoleMap(example, mainnet);
    expect(parsed.superAdmin).toBe(parsed.blocklistAuthority);
    expect(parsed.kyc.authority).toBe(parsed.superAdmin);
    expect(parsed.protocolTreasury).toBe(parsed.superAdmin);
    expect(parsed.allowKycAdmin).toBe(true);
    expect(parsed.acknowledgedSingleKeyUpgradeAuthority).toBe(false);
    // v1.0.0-rc: the first unpause opens only the pilot areas (0x23); 0x1c and 0x40 stay set.
    expect(parsed.unpauseMask).toBe(0x23);
    expect(parsed.kyc.registry).toBe(await getRegistryPda(parsed.deployer));
    const text = warnings.join("\n");
    expect(text).toMatch(/ROLE OVERLAP \(acknowledged\): \S+ is superAdmin \+ kyc\.authority \+ blocklistAuthority \+ protocolTreasury/);
    expect(text).toMatch(/no second signature/);
    expect(text).toMatch(/claw back/);
    // v1.0.0-rc (D4): a lost SA / BA key is recovered only by the upgrade authority after 7 days.
    expect(text).toMatch(/recovered only by the program upgrade authority .* 7-day timelock/);
    expect(text).toMatch(/reason: "Licensed operator/);
    // It keeps a second Admin record (another person's Ledger) for the pause.
    expect(parsed.admins).toHaveLength(1);
    expect(parsed.admins[0]).not.toBe(parsed.superAdmin);
    expect(text).not.toMatch(/NO SECOND ADMIN/);
    expect(JSON.stringify(example)).not.toMatch(/\[\s*\d+\s*,\s*\d+\s*,\s*\d+/);
  });

  it("refuses an unacknowledged role overlap on mainnet and devnet; only localnet warns", async () => {
    const { json } = await map({}, "mainnet");
    expect(await rejects({ ...json, blocklistAuthority: json.superAdmin }, mainnet)).toMatch(
      /role overlap not acknowledged: blocklistAuthority == superAdmin/,
    );
    const dev = (await map()).json;
    expect(await rejects({ ...dev, blocklistAuthority: dev.superAdmin })).toMatch(/role overlap not acknowledged: blocklistAuthority == superAdmin/);
    const { warnings } = await validateRoleMap(...onLocalnet({ ...dev, blocklistAuthority: dev.superAdmin }));
    expect(warnings.join(" ")).toMatch(/acknowledge it in acknowledgedRoleOverlaps/);
  });

  it("the company wallet model without a second Admin record warns that nobody could pause after a loss", async () => {
    const { keys, json } = await map({}, "mainnet");
    const sa = keys.superAdmin;
    const company = {
      ...json,
      admins: [],
      blocklistAuthority: sa,
      acknowledgedRoleOverlaps: [{ key: sa, roles: ["superAdmin", "blocklistAuthority"], reason: "one company wallet" }],
    };
    const alone = await validateRoleMap(company, mainnet);
    expect(alone.warnings.join("\n")).toMatch(/NO SECOND ADMIN: \S+ is superAdmin \+ blocklistAuthority .* no pause-only role/);
    const second = await validateRoleMap({ ...company, admins: [keys.admins[0]] }, mainnet);
    expect(second.warnings.join("\n")).not.toMatch(/NO SECOND ADMIN/);
  });

  it("an acknowledgement names the key's exact role set and a reason, and cannot go stale", async () => {
    const { keys, json } = await map({}, "mainnet");
    const sa = keys.superAdmin;
    const overlap = { ...json, blocklistAuthority: sa, kyc: { ...(json.kyc as object), authority: sa } };
    const ack = (roles: string[], reason: unknown = "one company wallet", key: string = sa) => ({ key, roles, reason });
    await expect(
      validateRoleMap({ ...overlap, acknowledgedRoleOverlaps: [ack(["superAdmin", "kyc.authority", "blocklistAuthority"])] }, mainnet),
    ).resolves.toBeTruthy();
    // Order does not matter; a missing role does.
    await expect(
      validateRoleMap({ ...overlap, acknowledgedRoleOverlaps: [ack(["blocklistAuthority", "superAdmin", "kyc.authority"])] }, mainnet),
    ).resolves.toBeTruthy();
    expect(await rejects({ ...overlap, acknowledgedRoleOverlaps: [ack(["superAdmin", "blocklistAuthority"])] }, mainnet)).toMatch(
      /holds superAdmin \+ kyc\.authority \+ blocklistAuthority, not superAdmin \+ blocklistAuthority/,
    );
    expect(await rejects({ ...json, acknowledgedRoleOverlaps: [ack(["superAdmin", "blocklistAuthority"])] }, mainnet)).toMatch(
      /stale acknowledgement/,
    );
    const roles = ["superAdmin", "kyc.authority", "blocklistAuthority"];
    expect(await rejects({ ...overlap, acknowledgedRoleOverlaps: [ack(roles, "  ")] }, mainnet)).toMatch(/reason must say why/);
    expect(await rejects({ ...overlap, acknowledgedRoleOverlaps: [ack([...roles, "owner"])] }, mainnet)).toMatch(/at least two distinct roles/);
    expect(await rejects({ ...overlap, acknowledgedRoleOverlaps: [ack(roles), ack(roles)] }, mainnet)).toMatch(/lists a key twice/);
    expect(await rejects({ ...overlap, acknowledgedRoleOverlaps: "all" }, mainnet)).toMatch(/must be an array/);
  });

  it("the treasury leaves the vault only as an acknowledged role key, never a hot key", async () => {
    const { keys, json } = await map();
    expect(await rejects({ ...json, protocolTreasury: keys.superAdmin })).toMatch(/protocolTreasury must be the Squads vault \(D5\), or a role key/);
    expect(await rejects({ ...json, protocolTreasury: key(98) })).toMatch(/protocolTreasury must be the Squads vault/);
    const acked = {
      ...json,
      protocolTreasury: keys.superAdmin,
      acknowledgedRoleOverlaps: [{ key: keys.superAdmin, roles: ["superAdmin", "protocolTreasury"], reason: "fees to the company" }],
    };
    const { map: parsed, warnings } = await validateRoleMap(acked, devnet);
    expect(parsed.protocolTreasury).toBe(keys.superAdmin);
    expect(warnings.join(" ")).toMatch(/protocol fees land on an operational key/);
    expect(await rejects({ ...json, protocolTreasury: keys.deployer })).toMatch(/deployer must hold no final role \(it is protocolTreasury\)/);
    expect(await rejects({ ...json, protocolTreasury: keys.multisig })).toMatch(/must not be the Squads multisig account/);
  });

  it("an operational key that is also a Squads member is an overlap", async () => {
    const { keys, json } = await map({}, "mainnet");
    const squads = json.squads as { members: { key: string; permissions: string[] }[] };
    const withSa = { ...json, squads: { ...squads, members: [...squads.members, { key: keys.superAdmin, permissions: ["vote"] }] } };
    expect(await rejects(withSa, mainnet)).toMatch(/role overlap not acknowledged: squads\.member == superAdmin/);
    const acked = { ...withSa, acknowledgedRoleOverlaps: [{ key: keys.superAdmin, roles: ["superAdmin", "squads.member"], reason: "one director" }] };
    const { warnings } = await validateRoleMap(acked, mainnet);
    expect(warnings.join(" ")).toMatch(/also approves upgrades/);
  });

  it("a single-key upgrade authority (1-of-N vault) needs its own acknowledgement bound to the multisig", async () => {
    const { keys, json } = await map({}, "mainnet");
    const squads = json.squads as Record<string, unknown>;
    const single = { ...json, squads: { ...squads, threshold: 1 } };
    expect(await rejects(single, mainnet)).toMatch(/at least 2 on mainnet \(D12\), or acknowledge a single-key upgrade authority/);
    const { map: parsed, warnings } = await validateRoleMap({ ...single, acknowledgedSingleKeyUpgradeAuthority: keys.multisig }, mainnet);
    expect(parsed.acknowledgedSingleKeyUpgradeAuthority).toBe(true);
    expect(warnings.join(" ")).toMatch(/SINGLE-KEY UPGRADE AUTHORITY \(acknowledged\).*one key can replace the program code/);
    expect(await rejects({ ...single, acknowledgedSingleKeyUpgradeAuthority: keys.vault }, mainnet)).toMatch(/must be the squads\.multisig address/);
    expect(await rejects({ ...json, acknowledgedSingleKeyUpgradeAuthority: keys.multisig }, mainnet)).toMatch(/is stale: squads\.threshold is at least 2/);
  });

  it("an acknowledged KYC + SA overlap stands in for allowKycAdmin", async () => {
    const { keys, json } = await map();
    const kycIsSa = { ...json, superAdmin: keys.kycAuthority };
    expect(await rejects(kycIsSa)).toMatch(/kyc.authority must not be the superAdmin/);
    const acked = { ...kycIsSa, acknowledgedRoleOverlaps: [{ key: keys.kycAuthority, roles: ["superAdmin", "kyc.authority"], reason: "company" }] };
    const { map: parsed } = await validateRoleMap(acked, devnet);
    expect(parsed.allowKycAdmin).toBe(true);
  });

  it("rejects unrepresentable or empty jurisdiction sets", async () => {
    const { json } = await map();
    expect(await rejects({ ...json, kyc: { ...(json.kyc as object), approvedJurisdictions: [] } })).toMatch(/freeze every KycGated receiver/);
    expect(await rejects({ ...json, kyc: { ...(json.kyc as object), approvedJurisdictions: [5000] } })).toMatch(/does not fit/);
  });
});
