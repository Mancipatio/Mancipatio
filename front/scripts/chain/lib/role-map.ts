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

/**
 * The operational roles one key may hold together only when the role map
 * acknowledges it (Talas 8.2, "company wallet for all roles").
 * `protocolTreasury` counts only when it is not the Squads vault.
 */
export const OVERLAP_ROLES = [
  "superAdmin",
  "admin",
  "kyc.authority",
  "blocklistAuthority",
  "protocolTreasury",
  "squads.member",
] as const;
export type OverlapRole = (typeof OVERLAP_ROLES)[number];

/** One key the map gives two or more operational roles. */
export type RoleOverlap = { key: Address; roles: OverlapRole[] };

/** `acknowledgedRoleOverlaps[]`: the exact role set of one shared key, and why. */
export type RoleOverlapAck = { key: Address; roles: OverlapRole[]; reason: string };

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
  /** True with the flag, or when an acknowledged overlap gives kyc.authority an Admin record. */
  allowKycAdmin: boolean;
  /** Shared keys the operator accepted, each with its full role set (Talas 8.2). */
  acknowledgedRoleOverlaps: RoleOverlapAck[];
  /** The Squads vault (both upgrade authorities) executes with one approval. */
  acknowledgedSingleKeyUpgradeAuthority: boolean;
};

const ROLE_ORDER = new Map<OverlapRole, number>(OVERLAP_ROLES.map((role, i) => [role, i]));
const sortRoles = (roles: Iterable<OverlapRole>) =>
  [...new Set(roles)].sort((a, b) => ROLE_ORDER.get(a)! - ROLE_ORDER.get(b)!);

/**
 * Every key that holds two or more operational roles in `map` (the deployer,
 * the bufferWriter and the Squads accounts have their own isolation rules).
 */
export function roleOverlapsOf(map: {
  superAdmin: Address;
  admins: Address[];
  blocklistAuthority: Address;
  kyc: { authority: Address };
  protocolTreasury: Address;
  squads: { vault: Address; members: { key: Address }[] };
}): RoleOverlap[] {
  const byKey = new Map<Address, OverlapRole[]>();
  const add = (key: Address, role: OverlapRole) => byKey.set(key, [...(byKey.get(key) ?? []), role]);
  add(map.superAdmin, "superAdmin");
  for (const admin of map.admins) add(admin, "admin");
  add(map.kyc.authority, "kyc.authority");
  add(map.blocklistAuthority, "blocklistAuthority");
  if (map.protocolTreasury !== map.squads.vault) add(map.protocolTreasury, "protocolTreasury");
  for (const member of map.squads.members) add(member.key, "squads.member");
  return [...byKey]
    .map(([key, roles]) => ({ key, roles: sortRoles(roles) }))
    .filter((overlap) => overlap.roles.length > 1);
}

const has = (roles: readonly OverlapRole[], ...wanted: OverlapRole[]) => wanted.every((role) => roles.includes(role));

/** What one key holding `roles` together means, for the loud warning (Talas 8.2). */
export function overlapConsequences(roles: readonly OverlapRole[]): string[] {
  const out = [
    "one lost or compromised key affects every listed role at once, and no second signature stands between that key and any of their actions",
  ];
  const admin = roles.includes("admin") || roles.includes("superAdmin");
  if (has(roles, "superAdmin", "blocklistAuthority")) {
    out.push("the key can clear every pause bit and also block wallets and switch classes between Open and KycGated, and there is no on-chain recovery of the SA or the BA (a lost key needs a program upgrade through Squads)");
  }
  if (roles.includes("blocklistAuthority") && admin) {
    out.push("blocklist and clawback with one key: it can block a holder and claw back that holder's units (clawback_blocklisted_holder) alone");
  }
  if (roles.includes("kyc.authority") && admin) {
    out.push("KYC decisions and their enforcement are not separated: the key issues and revokes passports and, as an Admin, claws back revoked KycGated holders");
  }
  if (has(roles, "kyc.authority", "blocklistAuthority")) {
    out.push("the key controls both the KYC registry and the hook's registry pin (update_transfer_hook_config can re-point every KycGated class)");
  }
  if (has(roles, "superAdmin", "kyc.authority")) out.push("KYB (Super Admin only) and KYC decisions sit with the same key");
  if (roles.includes("protocolTreasury")) {
    out.push("protocol fees land on an operational key instead of the Squads vault; a compromised key receives them and, as SA, can also redirect the treasury");
  }
  if (roles.includes("squads.member")) {
    out.push("the operational key also approves upgrades: the multisig no longer separates code changes from day-to-day operations");
  }
  return out;
}

/** The loud warning printed for an acknowledged overlap. */
export function describeOverlap(overlap: RoleOverlap, reason: string | null): string {
  const head = `ROLE OVERLAP ${reason === null ? "(not acknowledged)" : "(acknowledged)"}: ${overlap.key} is ${overlap.roles.join(" + ")}`;
  const why = reason === null ? "" : `; reason: "${reason}"`;
  return `${head}. Consequences: ${overlapConsequences(overlap.roles).join("; ")}${why}`;
}

const MAX_REASON_LENGTH = 500;

function parseOverlapAcks(value: unknown, errors: string[]): RoleOverlapAck[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push("acknowledgedRoleOverlaps must be an array");
    return [];
  }
  const out: RoleOverlapAck[] = [];
  value.forEach((entry, i) => {
    const label = `acknowledgedRoleOverlaps[${i}]`;
    if (!isObj(entry)) {
      errors.push(`${label} is not an object`);
      return;
    }
    if (typeof entry.key !== "string" || !isAddress(entry.key) || entry.key === DEFAULT_ADDRESS) {
      errors.push(`${label}.key is not a valid address`);
      return;
    }
    const roles = Array.isArray(entry.roles) ? entry.roles : [];
    if (
      roles.length < 2 ||
      !roles.every((role) => typeof role === "string" && (OVERLAP_ROLES as readonly string[]).includes(role)) ||
      new Set(roles).size !== roles.length
    ) {
      errors.push(`${label}.roles must list at least two distinct roles of ${OVERLAP_ROLES.join(", ")}`);
      return;
    }
    const reason = typeof entry.reason === "string" ? entry.reason.trim() : "";
    if (!reason || reason.length > MAX_REASON_LENGTH) {
      errors.push(`${label}.reason must say why (1-${MAX_REASON_LENGTH} characters)`);
      return;
    }
    out.push({ key: entry.key as Address, roles: sortRoles(roles as OverlapRole[]), reason });
  });
  if (new Set(out.map((ack) => ack.key)).size !== out.length) errors.push("acknowledgedRoleOverlaps lists a key twice");
  return out;
}

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
  // D12: the upgrade authority is always the Squads vault; a vault that one
  // approval executes is a single-key upgrade authority and needs its own
  // acknowledgement, bound to this multisig (Talas 8.2).
  const singleKeyAck = input.acknowledgedSingleKeyUpgradeAuthority;
  const singleKeyUa = threshold < 2;
  if (singleKeyAck !== undefined && singleKeyAck !== multisig) {
    errors.push("acknowledgedSingleKeyUpgradeAuthority must be the squads.multisig address it acknowledges");
  }
  const singleKeyAcknowledged = singleKeyAck !== undefined && singleKeyAck === multisig;
  if (singleKeyAcknowledged && !singleKeyUa) {
    errors.push("acknowledgedSingleKeyUpgradeAuthority is stale: squads.threshold is at least 2");
  }
  if (mainnet && singleKeyUa && !singleKeyAcknowledged) {
    errors.push("squads.threshold must be at least 2 on mainnet (D12), or acknowledge a single-key upgrade authority");
  }
  if (singleKeyUa && singleKeyAcknowledged) {
    warnings.push(
      `SINGLE-KEY UPGRADE AUTHORITY (acknowledged): the Squads vault ${vault} holds both upgrade authorities and the IDL authority and executes with ${threshold} approval: one key can replace the program code. Raise the threshold with a Squads config transaction once more members exist`,
    );
  }
  if (mainnet && configAuthority !== null) errors.push("squads.configAuthority must be null on mainnet (D12)");
  if (isAddress(multisig) && (await squadsVaultPda(multisig, vaultIndex)) !== vault) {
    errors.push("squads.vault is not PDA([multisig, multisig, vault, vaultIndex], SQDS4)");
  }

  // Role overlaps (Talas 8.2): one key may hold several operational roles
  // only when `acknowledgedRoleOverlaps` names that key with its exact role
  // set. On mainnet an unacknowledged overlap is an error; elsewhere a warning.
  const acks = parseOverlapAcks(input.acknowledgedRoleOverlaps, errors);
  const overlaps = roleOverlapsOf({ superAdmin, admins, blocklistAuthority, kyc: { authority: kycAuthority }, protocolTreasury, squads: { vault, members } });
  const ackByKey = new Map<string, RoleOverlapAck>(acks.map((ack) => [ack.key, ack]));
  const acknowledged = new Set<string>();
  acks.forEach((ack, i) => {
    const overlap = overlaps.find((o) => o.key === ack.key);
    if (!overlap) errors.push(`acknowledgedRoleOverlaps[${i}]: ${ack.key} holds fewer than two operational roles (stale acknowledgement)`);
    else if (overlap.roles.join() !== ack.roles.join()) {
      errors.push(`acknowledgedRoleOverlaps[${i}]: ${ack.key} holds ${overlap.roles.join(" + ")}, not ${ack.roles.join(" + ")}`);
    } else acknowledged.add(ack.key);
  });
  for (const overlap of overlaps) {
    const ack = ackByKey.get(overlap.key);
    if (acknowledged.has(overlap.key)) warnings.push(describeOverlap(overlap, ack!.reason));
    else if (!ack) {
      const pair = overlap.roles.length === 2 ? `${overlap.roles[1]} == ${overlap.roles[0]}` : overlap.roles.join(" + ");
      const text = `${pair} (one key holds ${overlap.roles.length} roles; acknowledge it in acknowledgedRoleOverlaps)`;
      if (mainnet) errors.push(`role overlap not acknowledged: ${text}`);
      else warnings.push(text);
    }
  }
  const kycAdminAcknowledged = overlaps.some(
    (o) => acknowledged.has(o.key) && o.roles.includes("kyc.authority") && (o.roles.includes("admin") || o.roles.includes("superAdmin")),
  );
  const treasuryAcknowledged = overlaps.some((o) => acknowledged.has(o.key) && o.roles.includes("protocolTreasury"));
  if (protocolTreasury !== vault && !treasuryAcknowledged) {
    errors.push("protocolTreasury must be the Squads vault (D5), or a role key acknowledged in acknowledgedRoleOverlaps");
  }

  const unpauseBy = input.unpauseBy === undefined ? "superAdmin" : input.unpauseBy;
  if (unpauseBy !== "superAdmin" && unpauseBy !== "deployer") errors.push('unpauseBy must be "superAdmin" or "deployer"');
  if (mainnet && unpauseBy !== "superAdmin") errors.push("unpauseBy must be superAdmin on mainnet (D4)");

  // Role isolation.
  const memberKeys = new Set<string>(members.map((m) => m.key));
  const squadsKeys = new Set<string>([vault, multisig]);
  const finalRoles = new Map<string, string>([
    [blocklistAuthority, "blocklistAuthority"],
    [kycAuthority, "kyc.authority"],
    [protocolTreasury, "protocolTreasury"],
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
  // Either layout gives kyc.authority an Admin record (S3, or accept_platform_admin),
  // which the S7 handover gate blocks unless allowKycAdmin (or an acknowledged
  // overlap, which implies it): refuse it up front.
  const kycAdminAllowed = allowKycAdmin || kycAdminAcknowledged;
  if (!kycAdminAllowed && admins.includes(kycAuthority)) {
    errors.push("kyc.authority must not be in admins (its Admin record blocks the handover unless allowKycAdmin)");
  }
  if (!kycAdminAllowed && kycAuthority === superAdmin) {
    errors.push("kyc.authority must not be the superAdmin (its Admin record blocks the handover unless allowKycAdmin)");
  }
  if (squadsKeys.has(superAdmin) && !k4Fallback) errors.push("superAdmin must not be the Squads vault or multisig (unless k4Fallback)");
  if (squadsKeys.has(protocolTreasury) && protocolTreasury !== vault) errors.push("protocolTreasury must not be the Squads multisig account (use the vault)");

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
      allowKycAdmin: kycAdminAllowed,
      acknowledgedRoleOverlaps: acks,
      acknowledgedSingleKeyUpgradeAuthority: singleKeyAcknowledged,
    },
    warnings,
  };
}

/** Every key the map names, with its role (inventory "not in the map" checks). */
export function mapKeys(map: RoleMap): Map<string, string> {
  const keys = new Map<string, string>([
    [map.deployer, "deployer"],
    [map.bufferWriter, "bufferWriter"],
    [map.protocolTreasury, "protocolTreasury"],
    [map.squads.vault, "squads.vault"],
    [map.squads.multisig, "squads.multisig"],
    [map.blocklistAuthority, "blocklistAuthority"],
    [map.kyc.authority, "kyc.authority"],
    [map.superAdmin, "superAdmin"],
  ]);
  for (const admin of map.admins) if (!keys.has(admin)) keys.set(admin, "admin");
  return keys;
}
