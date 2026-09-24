/**
 * Role map v2: parse and validate (pure apart from PDA derivation).
 * Design-3.3 §4.1. Public keys only; a role map never holds secrets.
 */
import fs from "node:fs";
import path from "node:path";
import { isAddress, type Address } from "@solana/kit";
import { ASSET_REGISTRY_PROGRAM_ADDRESS } from "@/lib/generated/asset_registry";
import { TRANSFER_HOOK_PROGRAM_ADDRESS } from "@/lib/generated/transfer_hook";
import type { Network } from "@/lib/network";
import {
  DEFAULT_APPROVED_JURISDICTIONS,
  getRegistryPda,
  isJurisdictionRepresentable,
} from "@/lib/passport";
import { FRONT_DIR, ChainGateError, sha256Hex } from "./safety";
import { PERMISSION_NAMES, squadsVaultPda, type SquadsMapConfig } from "./squads";

export const ROLE_MAP_SCHEMA = "mancipatio-role-map-v2";
export const DEFAULT_ADDRESS = "11111111111111111111111111111111";
export const MAX_PROGRAM_DATA_LEN = 10 * 1024 * 1024;
export const MAX_FEE_BPS = 1000;

export type RoleMap = {
  schema: typeof ROLE_MAP_SCHEMA;
  network: Network;
  genesisHash: string;
  programs: { assetRegistry: Address; transferHook: Address };
  programDataMaxLen: { assetRegistry: number; transferHook: number };
  deployer: Address;
  bufferWriter: Address;
  superAdmin: Address;
  admins: Address[];
  blocklistAuthority: Address;
  kyc: {
    authority: Address;
    registry: Address | null;
    approvedJurisdictions: number[];
    approvedJurisdictionsDefault: boolean;
    blockedJurisdictions: number[];
    tempAdminGrant: boolean;
  };
  protocolTreasury: Address;
  protocolFeeBps: number;
  squads: SquadsMapConfig;
  unpauseBy: "superAdmin" | "deployer";
  /** D6: an extra canonical-metadata authority; none by default. */
  metadataAuthority: Address | null;
  allowNonZeroFee: boolean;
  k4Fallback: boolean;
  allowTempKycAdmin: boolean;
  allowKycAdmin: boolean;
};

export type RoleMapContext = {
  network: Network;
  genesis: string;
  /** IDL `address` per program; defaults to front/idl/*.json. */
  idlAddresses?: { assetRegistry: string | null; transferHook: string | null };
};

export type LoadedRoleMap = { map: RoleMap; warnings: string[]; sha256: string };

function idlAddressFromDisk(name: string): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(FRONT_DIR, "idl", `${name}.json`), "utf8"));
    return typeof parsed.address === "string" ? parsed.address : null;
  } catch {
    return null;
  }
}

export async function loadRoleMap(file: string, ctx: RoleMapContext): Promise<LoadedRoleMap> {
  let raw: Buffer;
  try {
    raw = fs.readFileSync(file);
  } catch {
    throw new ChainGateError("CHAIN_ROLE_MAP is unreadable (path withheld)");
  }
  let json: unknown;
  try {
    json = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new ChainGateError("CHAIN_ROLE_MAP is not valid JSON");
  }
  const { map, warnings } = await validateRoleMap(json, ctx);
  return { map, warnings, sha256: sha256Hex(raw) };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Validates every rule of design §4.1 and returns the typed map plus
 * warnings. Throws one ChainGateError that lists every violation.
 */
export async function validateRoleMap(
  input: unknown,
  ctx: RoleMapContext,
): Promise<{ map: RoleMap; warnings: string[] }> {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isObj(input)) throw new ChainGateError("Role map: not a JSON object");
  const mainnet = ctx.network === "mainnet";

  const addr = (value: unknown, label: string): Address => {
    if (typeof value !== "string" || !isAddress(value)) {
      errors.push(`${label} is not a valid address`);
      return DEFAULT_ADDRESS as Address;
    }
    if (value === DEFAULT_ADDRESS) errors.push(`${label} is the default key`);
    return value as Address;
  };
  const optAddr = (value: unknown, label: string): Address | null =>
    value === null || value === undefined ? null : addr(value, label);
  const bool = (value: unknown, label: string): boolean => {
    if (value === undefined) return false;
    if (typeof value !== "boolean") errors.push(`${label} must be a boolean`);
    return value === true;
  };
  const int = (value: unknown, label: string, min: number, max: number): number => {
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
      errors.push(`${label} must be an integer from ${min} to ${max}`);
      return min;
    }
    return value;
  };

  if (input.schema !== ROLE_MAP_SCHEMA) errors.push(`schema must be ${ROLE_MAP_SCHEMA}`);
  if (input.network !== ctx.network) errors.push(`network must be ${ctx.network}`);
  if (input.genesisHash !== ctx.genesis) errors.push("genesisHash does not match the pinned genesis");

  const programs = isObj(input.programs) ? input.programs : {};
  const assetRegistry = addr(programs.assetRegistry, "programs.assetRegistry");
  const transferHook = addr(programs.transferHook, "programs.transferHook");
  const idl = ctx.idlAddresses ?? {
    assetRegistry: idlAddressFromDisk("asset_registry"),
    transferHook: idlAddressFromDisk("transfer_hook"),
  };
  if (assetRegistry !== ASSET_REGISTRY_PROGRAM_ADDRESS || assetRegistry !== idl.assetRegistry) {
    errors.push("programs.assetRegistry differs from the generated SDK / IDL address");
  }
  if (transferHook !== TRANSFER_HOOK_PROGRAM_ADDRESS || transferHook !== idl.transferHook) {
    errors.push("programs.transferHook differs from the generated SDK / IDL address");
  }
  const maxLen = isObj(input.programDataMaxLen) ? input.programDataMaxLen : {};
  const programDataMaxLen = {
    assetRegistry: int(maxLen.assetRegistry, "programDataMaxLen.assetRegistry", 1, MAX_PROGRAM_DATA_LEN),
    transferHook: int(maxLen.transferHook, "programDataMaxLen.transferHook", 1, MAX_PROGRAM_DATA_LEN),
  };

  const deployer = addr(input.deployer, "deployer");
  const bufferWriter = addr(input.bufferWriter, "bufferWriter");
  const superAdmin = addr(input.superAdmin, "superAdmin");
  const blocklistAuthority = addr(input.blocklistAuthority, "blocklistAuthority");
  const admins: Address[] = [];
  if (!Array.isArray(input.admins)) errors.push("admins must be an array");
  else input.admins.forEach((value, i) => admins.push(addr(value, `admins[${i}]`)));
  if (new Set(admins).size !== admins.length) errors.push("admins has duplicates");
  if (admins.includes(superAdmin)) {
    errors.push("admins must not list the superAdmin (accept_platform_admin creates its Admin record)");
  }

  const kycRaw = isObj(input.kyc) ? input.kyc : {};
  const kycAuthority = addr(kycRaw.authority, "kyc.authority");
  const kycRegistry = optAddr(kycRaw.registry, "kyc.registry");
  let approved: number[] = [];
  const approvedDefault = kycRaw.approvedJurisdictions === "default";
  if (approvedDefault) approved = [...DEFAULT_APPROVED_JURISDICTIONS];
  else if (Array.isArray(kycRaw.approvedJurisdictions)) {
    approved = kycRaw.approvedJurisdictions.map((code, i) =>
      int(code, `kyc.approvedJurisdictions[${i}]`, 0, 65_535),
    );
  } else errors.push('kyc.approvedJurisdictions must be "default" or an array of ISO numeric codes');
  const blocked = Array.isArray(kycRaw.blockedJurisdictions)
    ? kycRaw.blockedJurisdictions.map((code, i) => int(code, `kyc.blockedJurisdictions[${i}]`, 0, 65_535))
    : (errors.push("kyc.blockedJurisdictions must be an array"), []);
  for (const code of [...approved, ...blocked]) {
    if (!isJurisdictionRepresentable(code)) errors.push(`jurisdiction ${code} does not fit the on-chain bitmap`);
  }
  if (!approved.length) errors.push("kyc.approvedJurisdictions is empty (it would freeze every KycGated receiver)");
  const tempAdminGrant = bool(kycRaw.tempAdminGrant, "kyc.tempAdminGrant");

  const protocolTreasury = addr(input.protocolTreasury, "protocolTreasury");
  const protocolFeeBps = int(input.protocolFeeBps, "protocolFeeBps", 0, MAX_FEE_BPS);
  const allowNonZeroFee = bool(input.allowNonZeroFee, "allowNonZeroFee");
  if (protocolFeeBps !== 0 && !allowNonZeroFee) {
    errors.push("protocolFeeBps must be 0 unless allowNonZeroFee (the fee has no setter)");
  }
  const k4Fallback = bool(input.k4Fallback, "k4Fallback");
  const allowTempKycAdmin = bool(input.allowTempKycAdmin, "allowTempKycAdmin");
  const allowKycAdmin = bool(input.allowKycAdmin, "allowKycAdmin");
  const metadataAuthority = optAddr(input.metadataAuthority, "metadataAuthority");

  const squadsRaw = isObj(input.squads) ? input.squads : {};
  const multisig = addr(squadsRaw.multisig, "squads.multisig");
  const vaultIndex = int(squadsRaw.vaultIndex, "squads.vaultIndex", 0, 255);
  const vault = addr(squadsRaw.vault, "squads.vault");
  const threshold = int(squadsRaw.threshold, "squads.threshold", 1, 65_535);
  const timeLock = int(squadsRaw.timeLock, "squads.timeLock", 0, 0xffffffff);
  const configAuthority = optAddr(squadsRaw.configAuthority, "squads.configAuthority");
  if (!("configAuthority" in squadsRaw)) errors.push("squads.configAuthority must be present (null for none)");
  const members: { key: Address; permissions: string[] }[] = [];
  if (!Array.isArray(squadsRaw.members) || !squadsRaw.members.length) errors.push("squads.members must be a non-empty array");
  else {
    squadsRaw.members.forEach((member, i) => {
      if (!isObj(member)) {
        errors.push(`squads.members[${i}] is not an object`);
        return;
      }
      const key = addr(member.key, `squads.members[${i}].key`);
      const permissions = Array.isArray(member.permissions) ? member.permissions : [];
      if (
        !permissions.length ||
        !permissions.every((p) => typeof p === "string" && (PERMISSION_NAMES as string[]).includes(p)) ||
        new Set(permissions).size !== permissions.length
      ) {
        errors.push(`squads.members[${i}].permissions must be a non-empty subset of initiate, vote, execute`);
      }
      members.push({ key, permissions: permissions as string[] });
    });
  }
  if (new Set(members.map((m) => m.key)).size !== members.length) errors.push("squads.members has duplicate keys");
  const voters = members.filter((m) => m.permissions.includes("vote")).length;
  if (threshold > voters) errors.push(`squads.threshold ${threshold} exceeds the ${voters} members with vote`);
  if (!members.some((m) => m.permissions.includes("initiate"))) errors.push("no Squads member can initiate");
  if (!members.some((m) => m.permissions.includes("execute"))) errors.push("no Squads member can execute");
  if (mainnet && threshold < 2) errors.push("squads.threshold must be at least 2 on mainnet (D12)");
  if (mainnet && configAuthority !== null) errors.push("squads.configAuthority must be null on mainnet (D12)");
  if (isAddress(multisig) && (await squadsVaultPda(multisig, vaultIndex)) !== vault) {
    errors.push("squads.vault is not PDA([multisig, multisig, vault, vaultIndex], SQDS4)");
  }
  if (protocolTreasury !== vault) errors.push("protocolTreasury must be the Squads vault (D5)");

  const unpauseBy = input.unpauseBy === undefined ? "superAdmin" : input.unpauseBy;
  if (unpauseBy !== "superAdmin" && unpauseBy !== "deployer") errors.push('unpauseBy must be "superAdmin" or "deployer"');
  if (mainnet && unpauseBy !== "superAdmin") errors.push("unpauseBy must be superAdmin on mainnet (D4)");

  // Role isolation.
  const memberKeys = new Set<string>(members.map((m) => m.key));
  const squadsKeys = new Set<string>([vault, multisig]);
  const finalRoles = new Map<string, string>([
    [blocklistAuthority, "blocklistAuthority"],
    [kycAuthority, "kyc.authority"],
    [vault, "squads vault / treasury"],
    [multisig, "squads multisig"],
    ...admins.map((a) => [a, "admin"] as [string, string]),
  ]);
  const deployerRole = finalRoles.get(deployer);
  if (deployerRole) errors.push(`deployer must hold no final role (it is ${deployerRole})`);
  if (memberKeys.has(deployer)) errors.push("deployer must not be a Squads member");
  if (deployer === superAdmin) {
    if (mainnet) errors.push("deployer must not be the superAdmin on mainnet");
    else warnings.push("deployer == superAdmin (off mainnet): S5 and X1 are skipped");
  }
  if (bufferWriter === superAdmin || finalRoles.has(bufferWriter)) errors.push("bufferWriter must hold no role (D19)");
  if (memberKeys.has(bufferWriter)) errors.push("bufferWriter must not be a Squads member (D19)");
  if (bufferWriter === deployer) {
    if (mainnet) errors.push("bufferWriter must differ from the deployer on mainnet (D19)");
    else warnings.push("bufferWriter == deployer (off mainnet)");
  }
  if (squadsKeys.has(blocklistAuthority)) errors.push("blocklistAuthority must not be the Squads vault or multisig");
  if (squadsKeys.has(kycAuthority)) errors.push("kyc.authority must not be the Squads vault or multisig");
  if (blocklistAuthority === superAdmin) warnings.push("blocklistAuthority == superAdmin (one Ledger holds both roles)");
  if (squadsKeys.has(superAdmin) && !k4Fallback) errors.push("superAdmin must not be the Squads vault or multisig (unless k4Fallback)");

  // KYC registry pin (D3).
  const expectedRegistry =
    isAddress(deployer) && deployer !== DEFAULT_ADDRESS ? await getRegistryPda(deployer) : null;
  if (mainnet && !kycRegistry) errors.push("kyc.registry is required on mainnet (PDA(deployer), pinned in NEXT_PUBLIC_KYC_REGISTRY)");
  if (kycRegistry && expectedRegistry && kycRegistry !== expectedRegistry) {
    errors.push("kyc.registry must equal the KycRegistry PDA of the deployer");
  }
  if (tempAdminGrant) {
    warnings.push("kyc.tempAdminGrant: 3.1 kycProvider gate missing; the deployer grants and later removes a temporary Admin record");
    if (mainnet && !allowTempKycAdmin) errors.push("kyc.tempAdminGrant on mainnet needs allowTempKycAdmin (D17)");
  }

  if (errors.length) throw new ChainGateError(`Role map rejected: ${errors.join("; ")}`);
  return {
    map: {
      schema: ROLE_MAP_SCHEMA,
      network: ctx.network,
      genesisHash: ctx.genesis,
      programs: { assetRegistry, transferHook },
      programDataMaxLen,
      deployer,
      bufferWriter,
      superAdmin,
      admins,
      blocklistAuthority,
      kyc: {
        authority: kycAuthority,
        registry: kycRegistry ?? expectedRegistry,
        approvedJurisdictions: approved,
        approvedJurisdictionsDefault: approvedDefault,
        blockedJurisdictions: blocked,
        tempAdminGrant,
      },
      protocolTreasury,
      protocolFeeBps,
      squads: { multisig, vaultIndex, vault, threshold, timeLock, configAuthority, members },
      unpauseBy: unpauseBy as RoleMap["unpauseBy"],
      metadataAuthority,
      allowNonZeroFee,
      k4Fallback,
      allowTempKycAdmin,
      allowKycAdmin,
    },
    warnings,
  };
}

/** Every key the map names, with its role (inventory "not in the map" checks). */
export function mapKeys(map: RoleMap): Map<string, string> {
  const keys = new Map<string, string>([
    [map.deployer, "deployer"],
    [map.bufferWriter, "bufferWriter"],
    [map.superAdmin, "superAdmin"],
    [map.blocklistAuthority, "blocklistAuthority"],
    [map.kyc.authority, "kyc.authority"],
    [map.squads.vault, "squads.vault"],
    [map.squads.multisig, "squads.multisig"],
  ]);
  for (const admin of map.admins) keys.set(admin, "admin");
  return keys;
}
