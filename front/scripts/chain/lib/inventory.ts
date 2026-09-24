/**
 * Tool 3: inventory (`chain:inventory`), read-only on any network
 * (design-3.3 §6). Collects programs, canonical IDL, platform, admins,
 * blocklist authority, KYC registries, authority transfers, issuer
 * recoveries, role drift, leftover buffers, the Squads multisig and its
 * proposals that are not final, then
 * classifies findings per phase (`in-progress | pre-handover | handed-over`).
 *
 * `F/scripts/ops/devnet-rollout-inventory.mjs` is unchanged; this tool is
 * the mainnet-capable, role-map-aware inventory.
 */
import fs from "node:fs";
import { getAddressEncoder, type Address } from "@solana/kit";
import {
  ADMIN_DISCRIMINATOR,
  AUTHORITY_TRANSFER_DISCRIMINATOR,
  ASSET_DISCRIMINATOR,
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  CUSTODY_VAULT_DISCRIMINATOR,
  ISSUER_DISCRIMINATOR,
  ISSUER_RECOVERY_DISCRIMINATOR,
  KYC_REGISTRY_DISCRIMINATOR,
  PAYOUT_VAULT_DISCRIMINATOR,
  PLATFORM_DISCRIMINATOR,
  RIGHTS_ISSUANCE_DISCRIMINATOR,
  SALE_DISCRIMINATOR,
  SHARE_CLASS_DISCRIMINATOR,
  findAcceptPlatformAdminTransferPda,
  findPlatformPda,
  getAdminDecoder,
  getAssetDecoder,
  getAuthorityTransferDecoder,
  getCustodyVaultDecoder,
  getIssuerDecoder,
  getIssuerRecoveryDecoder,
  getKycRegistryDecoder,
  getPayoutVaultDecoder,
  getPlatformDecoder,
  getRightsIssuanceDecoder,
  getSaleDecoder,
  getShareClassDecoder,
} from "@/lib/generated/asset_registry";
import {
  BLOCKLIST_AUTHORITY_DISCRIMINATOR,
  BLOCKLIST_AUTHORITY_TRANSFER_DISCRIMINATOR,
  TRANSFER_HOOK_PROGRAM_ADDRESS,
  findBlocklistAuthorityPda,
  findTransferPda,
  getBlocklistAuthorityDecoder,
  getBlocklistAuthorityTransferDecoder,
} from "@/lib/generated/transfer_hook";
import { formatPauseFlags, unknownPauseBits } from "@/lib/pause-flags";
import {
  fetchProgramAccounts,
  fetchRawAccount,
  fetchRawAccounts,
  hasDiscriminator,
  type RawAccount,
} from "./accounts";
import type { ToolContext, ToolStatus } from "./context";
import { PROGRAM_IDS, idlProbeEvidence, probeIdl, resolveIdlSources, type IdlProbe } from "./idl-plan";
import { lockPath } from "./journal";
import {
  LOADER_V3,
  comparePayload,
  decodeProgramAccount,
  decodeProgramData,
  programDataAddress,
} from "./loader-v3";
import { PM_BUFFER_AUTHORITY_OFFSET, PM_PROGRAM } from "./program-metadata";
import { executableHash, loadRelease, releaseEvidence, type Release } from "./release";
import { loadRoleMap, mapKeys, type RoleMap } from "./role-map";
import type { ChainRpc } from "./rpc";
import { ChainGateError, IDL_PROGRAMS, sha256Hex, type ProgramName } from "./safety";
import { checkSquadsAccount, scanOpenProposals, type ProposalScan, type SquadsCheck } from "./squads";

export type InventoryPhase = "in-progress" | "pre-handover" | "handed-over";
export const PHASES: InventoryPhase[] = ["in-progress", "pre-handover", "handed-over"];
export type Severity = "blocker" | "warning" | "info";
export type Finding = { severity: Severity; code: string; message: string };

/** Headroom below which a warning is raised (design §6.1). */
export const HEADROOM_WARN: Record<ProgramName, number> = {
  asset_registry: 8 * 1024,
  transfer_hook: 2 * 1024,
};

export type ProgramInventory = {
  name: ProgramName;
  address: Address;
  deployed: boolean;
  programData: Address;
  upgradeAuthority: Address | null;
  deploySlot: string | null;
  capacity: number | null;
  payloadExecutableHash: string | null;
  release: { equal: boolean; length: number; headroom: number; verifyHash: string | null } | null;
};

export type TransferRow = {
  address: Address;
  target: Address;
  kind: "platform" | "kyc-registry" | "custody" | "issuer" | "unknown";
  currentAuthority: Address;
  newAuthority: Address;
  proposedBy: Address;
  stale: boolean;
};

export type Inventory = {
  programs: ProgramInventory[];
  idl: IdlProbe[];
  idlComparedAgainst: "release" | "head";
  platform: {
    address: Address;
    admin: Address;
    protocolTreasury: Address;
    protocolFeeBps: number;
    pauseFlags: number;
    pauseFlagsHex: string;
    unknownPauseBits: number;
    proposed: Address | null;
  } | null;
  admins: { record: Address; admin: Address; addedBy: Address }[];
  blocklist: { authority: Address; proposed: Address | null } | null;
  kycRegistries: { address: Address; authority: Address; entriesCount: string; proposed: Address | null }[];
  kycPin: { address: Address; live: boolean } | null;
  authorityTransfers: TransferRow[];
  issuerRecoveries: { address: Address; issuer: Address; newAuthority: Address; proposedBy: Address; eta: string; expiresAt: string }[];
  drift: {
    custodyWithoutAdmin: { vault: Address; authority: Address }[];
    rightsWithoutAdmin: { issuance: Address; authority: Address }[];
    saleAuthorityDrift: { sale: Address; authority: Address; issuerAuthority: Address | null }[];
    payoutFounderDrift: { payoutVault: Address; founder: Address; issuerAuthority: Address | null }[];
  };
  buffers: {
    loader: { address: Address; authority: Address | null; holder: string }[];
    pm: { address: Address; authority: Address | null; holder: string }[];
    scanErrors: string[];
  };
  squads: SquadsCheck | null;
  /** Proposals of the multisig that are not Executed, Rejected or Cancelled. */
  squadsProposals: ProposalScan | null;
  lockPresent: boolean;
  decodeErrors: string[];
};

type Decoder<T> = { decode: (bytes: Uint8Array) => T };

function decodeAll<T>(rows: RawAccount[], decoder: Decoder<T>, label: string, errors: string[]) {
  const out: { address: Address; value: T }[] = [];
  for (const row of rows) {
    try {
      out.push({ address: row.address, value: decoder.decode(row.data) });
    } catch {
      errors.push(`${label} ${row.address}: decode failed`);
    }
  }
  return out;
}

async function scanByDiscriminator<T>(
  rpc: ChainRpc,
  program: Address,
  discriminator: Uint8Array,
  decoder: Decoder<T>,
  label: string,
  errors: string[],
) {
  const rows = await fetchProgramAccounts(rpc, program, [{ offset: 0, bytes: discriminator }]);
  return decodeAll(rows.filter((r) => r.owner === program), decoder, label, errors);
}

export type CollectInput = {
  map: RoleMap | null;
  release: Release | null;
  idlSources: Record<ProgramName, { label: "release" | "head"; bytes: Uint8Array }>;
  lockPresent: boolean;
  kycPin: Address | null;
  scanBuffers: boolean;
};

/** Collects every inventory section at finalized commitment. */
export async function collectInventory(rpc: ChainRpc, input: CollectInput): Promise<Inventory> {
  const decodeErrors: string[] = [];
  const { map, release } = input;

  // 1. Programs.
  const programs: ProgramInventory[] = [];
  for (const name of IDL_PROGRAMS) {
    const address = PROGRAM_IDS[name];
    const programData = await programDataAddress(address);
    const program = (await fetchRawAccounts(rpc, [address])).get(address) ?? null;
    const link = program && program.owner === LOADER_V3 ? decodeProgramAccount(program.data) : null;
    const dataAccount = await fetchRawAccount(rpc, programData);
    const decoded = dataAccount && dataAccount.owner === LOADER_V3 ? decodeProgramData(dataAccount.data) : null;
    const compare = decoded && release ? comparePayload(decoded.payload, release.so[name]) : null;
    programs.push({
      name,
      address,
      deployed: Boolean(program?.executable && link?.programData === programData && decoded),
      programData,
      upgradeAuthority: decoded?.upgradeAuthority ?? null,
      deploySlot: decoded ? decoded.slot.toString() : null,
      capacity: decoded ? decoded.payload.length : null,
      payloadExecutableHash: decoded ? executableHash(decoded.payload) : null,
      release: compare
        ? { equal: compare.equal, length: compare.length, headroom: compare.headroom, verifyHash: release!.verifyHashes[name] ?? null }
        : null,
    });
  }

  // 2. Canonical IDL.
  const idl: IdlProbe[] = [];
  for (const name of IDL_PROGRAMS) idl.push(await probeIdl(rpc, name, input.idlSources[name]));

  // 3. Platform + proposal.
  const [platformAddress] = await findPlatformPda();
  const [platformTransfer] = await findAcceptPlatformAdminTransferPda({ platform: platformAddress });
  const [blocklistAddress] = await findBlocklistAuthorityPda();
  const [blocklistTransfer] = await findTransferPda();
  const singles = await fetchRawAccounts(rpc, [platformAddress, platformTransfer, blocklistAddress, blocklistTransfer]);
  let platform: Inventory["platform"] = null;
  const platformRaw = singles.get(platformAddress);
  if (platformRaw && platformRaw.owner === ASSET_REGISTRY_PROGRAM_ADDRESS && hasDiscriminator(platformRaw.data, PLATFORM_DISCRIMINATOR)) {
    const value = getPlatformDecoder().decode(platformRaw.data);
    const transferRaw = singles.get(platformTransfer);
    let proposed: Address | null = null;
    if (transferRaw && transferRaw.owner === ASSET_REGISTRY_PROGRAM_ADDRESS && hasDiscriminator(transferRaw.data, AUTHORITY_TRANSFER_DISCRIMINATOR)) {
      proposed = getAuthorityTransferDecoder().decode(transferRaw.data).newAuthority;
    }
    platform = {
      address: platformAddress,
      admin: value.admin,
      protocolTreasury: value.protocolTreasury,
      protocolFeeBps: value.protocolFeeBps,
      pauseFlags: value.pauseFlags,
      pauseFlagsHex: formatPauseFlags(value.pauseFlags),
      unknownPauseBits: unknownPauseBits(value.pauseFlags),
      proposed,
    };
  } else if (platformRaw) decodeErrors.push("Platform: account at the PDA does not decode");

  // 5. Blocklist authority.
  let blocklist: Inventory["blocklist"] = null;
  const baRaw = singles.get(blocklistAddress);
  if (baRaw && baRaw.owner === TRANSFER_HOOK_PROGRAM_ADDRESS && hasDiscriminator(baRaw.data, BLOCKLIST_AUTHORITY_DISCRIMINATOR)) {
    const value = getBlocklistAuthorityDecoder().decode(baRaw.data);
    const transferRaw = singles.get(blocklistTransfer);
    let proposed: Address | null = null;
    if (
      transferRaw &&
      transferRaw.owner === TRANSFER_HOOK_PROGRAM_ADDRESS &&
      hasDiscriminator(transferRaw.data, BLOCKLIST_AUTHORITY_TRANSFER_DISCRIMINATOR)
    ) {
      const transfer = getBlocklistAuthorityTransferDecoder().decode(transferRaw.data);
      proposed = transfer.currentAuthority === value.authority ? transfer.newAuthority : null;
      if (!proposed) decodeErrors.push("BlocklistAuthorityTransfer is stale (current authority moved)");
    }
    blocklist = { authority: value.authority, proposed };
  } else if (baRaw) decodeErrors.push("BlocklistAuthority: account at the PDA does not decode");

  // 4, 6, 7, 8: registry-owned scans.
  const AR = ASSET_REGISTRY_PROGRAM_ADDRESS;
  const admins = (await scanByDiscriminator(rpc, AR, ADMIN_DISCRIMINATOR, getAdminDecoder(), "Admin", decodeErrors)).map(
    ({ address, value }) => ({ record: address, admin: value.admin, addedBy: value.addedBy }),
  );
  const adminSet = new Set<string>(admins.map((a) => a.admin));
  const registries = await scanByDiscriminator(rpc, AR, KYC_REGISTRY_DISCRIMINATOR, getKycRegistryDecoder(), "KycRegistry", decodeErrors);
  const transfers = await scanByDiscriminator(rpc, AR, AUTHORITY_TRANSFER_DISCRIMINATOR, getAuthorityTransferDecoder(), "AuthorityTransfer", decodeErrors);
  const recoveries = await scanByDiscriminator(rpc, AR, ISSUER_RECOVERY_DISCRIMINATOR, getIssuerRecoveryDecoder(), "IssuerRecovery", decodeErrors);
  const custody = await scanByDiscriminator(rpc, AR, CUSTODY_VAULT_DISCRIMINATOR, getCustodyVaultDecoder(), "CustodyVault", decodeErrors);
  const rights = await scanByDiscriminator(rpc, AR, RIGHTS_ISSUANCE_DISCRIMINATOR, getRightsIssuanceDecoder(), "RightsIssuance", decodeErrors);
  const sales = await scanByDiscriminator(rpc, AR, SALE_DISCRIMINATOR, getSaleDecoder(), "Sale", decodeErrors);
  const payouts = await scanByDiscriminator(rpc, AR, PAYOUT_VAULT_DISCRIMINATOR, getPayoutVaultDecoder(), "PayoutVault", decodeErrors);
  const shareClasses = await scanByDiscriminator(rpc, AR, SHARE_CLASS_DISCRIMINATOR, getShareClassDecoder(), "ShareClass", decodeErrors);
  const assets = await scanByDiscriminator(rpc, AR, ASSET_DISCRIMINATOR, getAssetDecoder(), "Asset", decodeErrors);
  const issuers = await scanByDiscriminator(rpc, AR, ISSUER_DISCRIMINATOR, getIssuerDecoder(), "Issuer", decodeErrors);

  const registryAuthority = new Map<string, Address>(registries.map((r) => [r.address, r.value.authority]));
  const custodyAuthority = new Map<string, Address>(custody.map((c) => [c.address, c.value.authority]));
  const issuerAuthority = new Map<string, Address>(issuers.map((i) => [i.address, i.value.authority]));
  const authorityTransfers: TransferRow[] = transfers.map(({ address, value }) => {
    let kind: TransferRow["kind"] = "unknown";
    let current: Address | undefined;
    if (value.target === platformAddress && platform) {
      kind = "platform";
      current = platform.admin;
    } else if (registryAuthority.has(value.target)) {
      kind = "kyc-registry";
      current = registryAuthority.get(value.target);
    } else if (custodyAuthority.has(value.target)) {
      kind = "custody";
      current = custodyAuthority.get(value.target);
    } else if (issuerAuthority.has(value.target)) {
      kind = "issuer";
      current = issuerAuthority.get(value.target);
    }
    return {
      address,
      target: value.target,
      kind,
      currentAuthority: value.currentAuthority,
      newAuthority: value.newAuthority,
      proposedBy: value.proposedBy,
      stale: current === undefined || current !== value.currentAuthority,
    };
  });
  const pendingByTarget = new Map<string, TransferRow>(authorityTransfers.filter((t) => !t.stale).map((t) => [t.target, t]));
  const kycRegistries = registries.map(({ address, value }) => {
    const pending = pendingByTarget.get(address);
    return {
      address,
      authority: value.authority,
      entriesCount: value.entriesCount.toString(),
      proposed: pending ? pending.newAuthority : null,
    };
  });
  const kycPin = input.kycPin
    ? { address: input.kycPin, live: registryAuthority.has(input.kycPin) }
    : null;

  // Issuer resolution: share class → asset → issuer.
  const assetIssuer = new Map<string, Address>(assets.map((a) => [a.address, a.value.issuer]));
  const classIssuer = (shareClass: Address): Address | null => {
    const sc = shareClasses.find((c) => c.address === shareClass);
    const issuer = sc ? assetIssuer.get(sc.value.asset) : undefined;
    return issuer ? issuerAuthority.get(issuer) ?? null : null;
  };
  const saleIssuer = new Map<string, Address | null>(sales.map((s) => [s.address, classIssuer(s.value.shareClass)]));
  const drift: Inventory["drift"] = {
    custodyWithoutAdmin: custody
      .filter((c) => !adminSet.has(c.value.authority))
      .map((c) => ({ vault: c.address, authority: c.value.authority })),
    rightsWithoutAdmin: rights
      .filter((r) => !adminSet.has(r.value.authority))
      .map((r) => ({ issuance: r.address, authority: r.value.authority })),
    saleAuthorityDrift: sales
      .map((s) => ({ sale: s.address, authority: s.value.authority, issuerAuthority: saleIssuer.get(s.address) ?? null }))
      .filter((row) => row.issuerAuthority !== row.authority),
    payoutFounderDrift: payouts
      .map((p) => ({
        payoutVault: p.address,
        founder: p.value.founder,
        issuerAuthority: saleIssuer.get(p.value.sale) ?? classIssuer(p.value.shareClass),
      }))
      .filter((row) => row.issuerAuthority !== row.founder),
  };

  // 9. Leftover buffers (best effort).
  const buffers: Inventory["buffers"] = { loader: [], pm: [], scanErrors: [] };
  if (input.scanBuffers && map) {
    const holders: [string, Address][] = [
      ["deployer", map.deployer],
      ["bufferWriter", map.bufferWriter],
      ["vault", map.squads.vault],
      ["superAdmin", map.superAdmin],
    ];
    for (const [holder, key] of holders) {
      const keyBytes = new Uint8Array(getAddressEncoder().encode(key));
      try {
        const rows = await fetchProgramAccounts(
          rpc,
          LOADER_V3,
          [
            { offset: 0, bytes: Uint8Array.of(1, 0, 0, 0) },
            { offset: 4, bytes: Uint8Array.of(1, ...keyBytes) },
          ],
          { offset: 0, length: 37 },
        );
        for (const row of rows) buffers.loader.push({ address: row.address, authority: key, holder });
      } catch {
        buffers.scanErrors.push(`loader buffer scan for ${holder} refused by the RPC`);
      }
      try {
        const rows = await fetchProgramAccounts(
          rpc,
          PM_PROGRAM,
          [
            { offset: 0, bytes: Uint8Array.of(1) },
            { offset: PM_BUFFER_AUTHORITY_OFFSET, bytes: keyBytes },
          ],
          { offset: 0, length: 96 },
        );
        for (const row of rows) buffers.pm.push({ address: row.address, authority: key, holder });
      } catch {
        buffers.scanErrors.push(`PM buffer scan for ${holder} refused by the RPC`);
      }
    }
  }

  // 10. Squads.
  let squads: SquadsCheck | null = null;
  if (map) {
    const account = await fetchRawAccount(rpc, map.squads.multisig);
    squads = await checkSquadsAccount(account ? { owner: account.owner, data: account.data } : null, map.squads);
  }
  let squadsProposals: ProposalScan | null = null;
  if (map && squads?.decoded) {
    squadsProposals = await scanOpenProposals(map.squads.multisig, squads.decoded, (addresses) => fetchRawAccounts(rpc, addresses));
  }

  return {
    programs,
    idl,
    idlComparedAgainst: input.idlSources.asset_registry.label,
    platform,
    admins,
    blocklist,
    kycRegistries,
    kycPin,
    authorityTransfers,
    issuerRecoveries: recoveries.map(({ address, value }) => ({
      address,
      issuer: value.issuer,
      newAuthority: value.newAuthority,
      proposedBy: value.proposedBy,
      eta: value.eta.toString(),
      expiresAt: value.expiresAt.toString(),
    })),
    drift,
    buffers,
    squads,
    squadsProposals,
    lockPresent: input.lockPresent,
    decodeErrors,
  };
}

export type FindingOptions = {
  handoverWhilePaused?: boolean;
};

/** Classifies the inventory (design §6 findings table). */
export function inventoryFindings(
  inv: Inventory,
  map: RoleMap | null,
  phase: InventoryPhase,
  options: FindingOptions = {},
): Finding[] {
  const out: Finding[] = [];
  const add = (severity: Severity, code: string, message: string) => out.push({ severity, code, message });
  const atHandover = phase !== "in-progress";
  const gate = (code: string, message: string) => add(atHandover ? "blocker" : "warning", code, message);

  for (const p of inv.programs) {
    if (!p.deployed) gate("program-missing", `${p.name}: program or ProgramData missing or invalid`);
    if (map && phase === "handed-over" && p.upgradeAuthority !== map.squads.vault) {
      add("blocker", "ua-not-vault", `${p.name}: upgrade authority ${p.upgradeAuthority ?? "none"} is not the vault`);
    }
    if (map && phase === "pre-handover" && p.upgradeAuthority !== map.deployer && p.upgradeAuthority !== map.squads.vault) {
      add("blocker", "ua-unexpected", `${p.name}: upgrade authority ${p.upgradeAuthority ?? "none"} is neither the deployer nor the vault`);
    }
    if (p.release && !p.release.equal) gate("release-bytes", `${p.name}: ProgramData differs from the Release .so`);
    if (p.release && p.release.headroom < HEADROOM_WARN[p.name]) {
      add("warning", "headroom", `${p.name}: ${p.release.headroom} B headroom over the Release .so`);
    }
    if (p.release?.verifyHash && p.payloadExecutableHash && p.release.verifyHash !== p.payloadExecutableHash) {
      add("info", "verify-hash", `${p.name}: on-chain executable hash differs from hashes.txt`);
    }
    if (map && p.capacity !== null) {
      const want = p.name === "asset_registry" ? map.programDataMaxLen.assetRegistry : map.programDataMaxLen.transferHook;
      if (p.capacity < want) gate("capacity", `${p.name}: ProgramData capacity ${p.capacity} B is below programDataMaxLen ${want} B`);
    }
  }

  for (const probe of inv.idl) {
    if (probe.status !== "in-sync" || probe.trimmed === false) {
      gate("idl", `${probe.program}: canonical IDL ${probe.status}${probe.trimmed === false ? " (not trimmed)" : ""} against ${probe.source.label}`);
    }
    if (probe.extraAuthority && probe.extraAuthority !== map?.metadataAuthority) {
      add("blocker", "metadata-authority", `${probe.program}: extra metadata authority ${probe.extraAuthority} is not in the role map`);
    }
  }

  if (!inv.platform) gate("platform-missing", "Platform is not initialized");
  if (!inv.blocklist) gate("blocklist-missing", "BlocklistAuthority is not initialized");
  if (inv.platform && inv.platform.pauseFlags !== 0) {
    if (atHandover && !options.handoverWhilePaused) add("blocker", "paused", `pause flags ${inv.platform.pauseFlagsHex} at handover`);
    else add("info", "paused", `pause flags ${inv.platform.pauseFlagsHex}`);
  }
  if (inv.lockPresent) add("warning", "lock", "a chain lock is present for this network (resolve with CHAIN_RECOVER=1)");
  for (const error of inv.decodeErrors) add("warning", "decode", error);
  for (const error of inv.buffers.scanErrors) add("warning", "buffer-scan", error);
  for (const t of inv.authorityTransfers) if (t.stale) add("warning", "stale-transfer", `${t.kind} transfer ${t.address} is stale`);
  for (const r of inv.drift.custodyWithoutAdmin) add("warning", "k10-custody", `custody vault ${r.vault}: authority ${r.authority} has no Admin record`);
  for (const r of inv.drift.rightsWithoutAdmin) add("warning", "k19-rights", `rights issuance ${r.issuance}: authority ${r.authority} has no Admin record`);
  for (const r of inv.drift.saleAuthorityDrift) add("warning", "k14-sale", `sale ${r.sale}: authority ${r.authority} ≠ issuer authority ${r.issuerAuthority ?? "unknown"}`);
  for (const r of inv.drift.payoutFounderDrift) add("warning", "k14-payout", `payout vault ${r.payoutVault}: founder ${r.founder} ≠ issuer authority ${r.issuerAuthority ?? "unknown"}`);
  for (const b of [...inv.buffers.loader, ...inv.buffers.pm]) add("warning", "buffer", `leftover buffer ${b.address} held by ${b.holder}`);

  if (!map) {
    if (inv.blocklist && inv.platform && inv.blocklist.authority === inv.platform.admin) add("warning", "ba-is-sa", "blocklist authority == super admin");
    return out;
  }

  // Role checks against the map.
  const adminKeys = new Set<string>(inv.admins.map((a) => a.admin));
  const known = mapKeys(map);
  const roleHolder = (key: Address) => {
    const roles: string[] = [];
    if (inv.platform?.admin === key) roles.push("platform admin");
    if (inv.platform?.proposed === key) roles.push("proposed platform admin");
    if (inv.blocklist?.authority === key) roles.push("blocklist authority");
    if (inv.blocklist?.proposed === key) roles.push("proposed blocklist authority");
    if (inv.platform?.protocolTreasury === key) roles.push("treasury");
    for (const r of inv.kycRegistries) {
      if (r.authority === key) roles.push(`KYC registry ${r.address} authority`);
      if (r.proposed === key) roles.push(`proposed KYC registry ${r.address} authority`);
    }
    for (const t of inv.authorityTransfers) if (!t.stale && t.newAuthority === key && t.kind === "custody") roles.push("proposed custody authority");
    for (const probe of inv.idl) if (probe.extraAuthority === key) roles.push(`${probe.program} metadata authority`);
    if (adminKeys.has(key)) roles.push("Admin record");
    return roles;
  };
  const deployerRoles = roleHolder(map.deployer);
  const deployerUa = inv.programs.filter((p) => p.upgradeAuthority === map.deployer).map((p) => `${p.name} upgrade authority`);
  if (deployerRoles.length) {
    add(atHandover ? "blocker" : "info", "deployer-role", `deployer holds ${deployerRoles.join(", ")}`);
  }
  if (deployerUa.length) add(phase === "handed-over" ? "blocker" : "info", "deployer-ua", `deployer holds ${deployerUa.join(", ")}`);
  const writerRoles = [
    ...roleHolder(map.bufferWriter),
    ...inv.programs.filter((p) => p.upgradeAuthority === map.bufferWriter).map((p) => `${p.name} upgrade authority`),
  ];
  if (writerRoles.length) add("blocker", "bufferwriter-role", `bufferWriter holds ${writerRoles.join(", ")}`);
  if (adminKeys.has(map.kyc.authority)) {
    add(atHandover && !map.allowKycAdmin ? "blocker" : "warning", "kyc-admin", "kyc.authority holds an Admin record");
  }
  // Any other Admin can pause and run Admin instructions: only the map's
  // admins and the SA may hold a record at handover (the deployer,
  // bufferWriter and kyc.authority have their own findings above).
  const expectedAdmins = new Set<string>([...map.admins, map.superAdmin, map.deployer, map.bufferWriter, map.kyc.authority]);
  for (const record of inv.admins) {
    if (!expectedAdmins.has(record.admin)) {
      gate("admin-unknown", `Admin record ${record.record} belongs to ${record.admin}, which is not in the role map`);
    }
  }
  if (inv.platform && inv.platform.admin !== map.superAdmin && adminKeys.has(map.superAdmin)) {
    add("warning", "sa-early-admin", "superAdmin has an Admin record before accepting the platform (K10 premise is out of date)");
  }
  if (inv.platform) {
    if (inv.platform.admin !== map.superAdmin) gate("sa", `platform admin ${inv.platform.admin} is not the map superAdmin`);
    if (inv.platform.protocolTreasury !== map.protocolTreasury) gate("treasury", `protocol treasury ${inv.platform.protocolTreasury} is not the vault`);
    if (inv.platform.protocolFeeBps !== map.protocolFeeBps) add("blocker", "fee", `protocol fee ${inv.platform.protocolFeeBps} bps ≠ map ${map.protocolFeeBps} (no setter)`);
    if (inv.platform.proposed && !known.has(inv.platform.proposed)) add("blocker", "foreign-proposal", `platform admin proposal to ${inv.platform.proposed}, not in the map`);
    if (inv.platform.proposed && atHandover) add("blocker", "pending-platform", "a platform admin proposal is still pending");
  }
  if (inv.blocklist) {
    if (inv.blocklist.authority !== map.blocklistAuthority) gate("ba", `blocklist authority ${inv.blocklist.authority} is not the map key`);
    if (inv.blocklist.proposed && !known.has(inv.blocklist.proposed)) add("blocker", "foreign-proposal", `blocklist proposal to ${inv.blocklist.proposed}, not in the map`);
    if (inv.blocklist.proposed && atHandover) add("blocker", "pending-ba", "a blocklist authority proposal is still pending");
  }
  if (map.blocklistAuthority === map.superAdmin) add("warning", "ba-is-sa", "blocklist authority == super admin");
  const pin = inv.kycRegistries.find((r) => r.address === map.kyc.registry);
  if (!pin) gate("kyc-registry", `KYC registry ${map.kyc.registry} does not exist`);
  else {
    if (pin.authority !== map.kyc.authority) gate("kyc-authority", `KYC registry authority ${pin.authority} is not kyc.authority`);
    if (pin.proposed && !known.has(pin.proposed)) add("blocker", "foreign-proposal", `KYC registry proposal to ${pin.proposed}, not in the map`);
    if (pin.proposed && atHandover) add("blocker", "pending-kyc", "a KYC registry proposal is still pending");
  }
  if (inv.kycPin && !inv.kycPin.live) gate("kyc-pin", `NEXT_PUBLIC_KYC_REGISTRY ${inv.kycPin.address} is not a live registry`);
  if (inv.kycPin && inv.kycPin.address !== map.kyc.registry) add("blocker", "kyc-pin", "NEXT_PUBLIC_KYC_REGISTRY differs from the role map registry");
  for (const admin of map.admins) if (!adminKeys.has(admin)) gate("admin-missing", `admin ${admin} has no Admin record`);
  if (inv.squads && !inv.squads.ok) {
    for (const error of inv.squads.errors) gate("squads", `Squads: ${error}`);
  }
  // A proposal whose execution failed stays Approved, and any member with
  // Execute can still run it later (also once stale): cancel it. A stale
  // Draft/Active one can no longer be approved and is only listed in the
  // evidence.
  if (inv.squadsProposals) {
    for (const error of inv.squadsProposals.errors) add("warning", "squads-proposal", `Squads ${error}`);
    for (const p of inv.squadsProposals.open) {
      const text = `Squads proposal #${p.transactionIndex} ${p.proposal} is ${p.status} (${p.approvals} approvals)`;
      if (p.status === "Approved" || p.status === "Executing") gate("squads-proposal", `${text} and can still be executed: cancel it`);
      else if (!p.stale) add("warning", "squads-proposal", `${text}: reject it or finish it`);
    }
  }
  return out;
}

export function inventoryEvidence(inv: Inventory) {
  return {
    ...inv,
    idl: inv.idl.map(idlProbeEvidence),
  };
}

export function readPhase(value: string | undefined): InventoryPhase {
  const phase = (value?.trim() || "in-progress") as InventoryPhase;
  if (!PHASES.includes(phase)) throw new ChainGateError("CHAIN_PHASE must be in-progress, pre-handover or handed-over");
  return phase;
}

export function lockIsPresent(stateDir: string, network: string, genesis: string): boolean {
  return fs.existsSync(lockPath(stateDir, network, genesis));
}

/** Loads the inputs the inventory needs from the tool context. */
export async function inventoryInputs(ctx: ToolContext) {
  const { config } = ctx;
  const release = config.releaseDir ? loadRelease(config.releaseDir, { requireSums: config.network === "mainnet" }) : null;
  const loaded = config.roleMapPath
    ? await loadRoleMap(config.roleMapPath, { network: config.network, genesis: config.expectedGenesis })
    : null;
  // Against the Release whose .so is live when given, otherwise HEAD (labelled).
  const idlSources = resolveIdlSources(ctx, release, { prefer: release?.idl ? "release" : "head", inventory: true });
  const pinRaw = ctx.env.NEXT_PUBLIC_KYC_REGISTRY?.trim() || null;
  return { release, loaded, idlSources, pin: (pinRaw as Address | null) ?? null };
}

export async function inventoryTool(ctx: ToolContext): Promise<ToolStatus> {
  const { config, evidence } = ctx;
  const phase = readPhase(ctx.env.CHAIN_PHASE);
  evidence.phase = phase;
  ctx.phase = "inputs";
  const { release, loaded, idlSources, pin } = await inventoryInputs(ctx);
  evidence.release = releaseEvidence(release);
  evidence.roleMapSha256 = loaded?.sha256 ?? null;
  evidence.roleMapWarnings = loaded?.warnings ?? [];
  ctx.phase = "collect";
  const inv = await collectInventory(ctx.rpc, {
    map: loaded?.map ?? null,
    release,
    idlSources,
    lockPresent: lockIsPresent(config.stateDir, config.network, config.expectedGenesis),
    kycPin: pin,
    scanBuffers: ctx.env.CHAIN_SCAN_BUFFERS?.trim() !== "0",
  });
  const findings = inventoryFindings(inv, loaded?.map ?? null, phase, {
    handoverWhilePaused: ctx.env.CHAIN_HANDOVER_WHILE_PAUSED?.trim() === "1",
  });
  evidence.inventory = inventoryEvidence(inv);
  evidence.findings = findings;
  const blockers = findings.filter((f) => f.severity === "blocker");
  evidence.blockers = blockers.length;
  evidence.inventorySha256 = sha256Hex(JSON.stringify(findings));
  for (const finding of findings) ctx.log(`${finding.severity.padEnd(8)} ${finding.code.padEnd(20)} ${finding.message}`);
  ctx.log(`${blockers.length} blockers, ${findings.length - blockers.length} other findings (phase ${phase})`);
  return "completed";
}
