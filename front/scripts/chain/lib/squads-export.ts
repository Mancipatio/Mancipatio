/**
 * Tool 4: Squads export (`chain:squads-export`), design-3.3 §7.
 *
 * Reads accounts and one `getLatestBlockhash`; never loads a keypair and
 * never sends. Refuses unless the Squads multisig decodes and exactly matches
 * the role map (`CHAIN_SQUADS_CONFIG_UNVERIFIED=1` is allowed off mainnet
 * only). Every exported transaction is unsigned, legacy, with the vault as
 * fee payer and only signer.
 *
 * CHAIN_SQUADS_OP selects one allowlisted operation; CHAIN_SQUADS_INPUT is the
 * path of its JSON input (the idl-update input is the prepare-export spec).
 */
import fs from "node:fs";
import { createNoopSigner, isAddress, type Address, type Instruction } from "@solana/kit";
import {
  getAcceptPlatformAdminInstructionAsync,
  getAddAdminInstructionAsync,
  getProposePlatformAdminInstructionAsync,
  getRemoveAdminInstructionAsync,
  getSetPauseFlagsInstructionAsync,
  getSetProtocolTreasuryInstructionAsync,
  findAdminRecordPda,
  fetchMaybePlatform,
  findPlatformPda,
} from "@/lib/generated/asset_registry";
import {
  buildInitializeBlocklistAuthorityInstruction,
  buildInitializePlatformInstruction,
} from "@/lib/program-bootstrap";
import { fetchRawAccount } from "./accounts";
import type { ToolContext, ToolStatus } from "./context";
import { PROGRAM_IDS, resolveIdlSources } from "./idl-plan";
import {
  LOADER_V3,
  MINIMUM_EXTEND_PROGRAM_BYTES,
  PROGRAMDATA_METADATA_SIZE,
  comparePayload,
  decodeLoaderBuffer,
  decodeProgramData,
  extendProgramCheckedInstruction,
  programDataAddress,
  setUpgradeAuthorityInstruction,
  upgradeInstruction,
} from "./loader-v3";
import {
  IDL_HEADER,
  PM_HEADER_LENGTH,
  PM_PROGRAM,
  decodeMetadataAccount,
  decodePmBufferAccount,
  findCanonicalMetadataPda,
  inflateIdl,
  pmClose,
  pmExtend,
  pmSetAuthority,
  pmSetData,
  pmTrim,
} from "./program-metadata";
import { loadRelease, releaseEvidence, type Release } from "./release";
import { MAX_PROGRAM_DATA_LEN, loadRoleMap, type RoleMap } from "./role-map";
import type { ChainRpc } from "./rpc";
import { ChainGateError, assertReleaseSource, readLocalIdl, sha256Hex, type ProgramName } from "./safety";
import {
  checkSquadsAccount,
  type SquadsCheck,
  describeInstruction,
  encodeVaultTransaction,
  inspectExternalTransaction,
  type ExternalInspection,
  splitBySize,
} from "./squads";
import type { LatestBlockhash } from "./tx";
import type { Network } from "@/lib/network";
import { describePausedAreas, formatPauseFlags } from "@/lib/pause-flags";

export const SQUADS_OPS = [
  "upgrade",
  "idl-update",
  "set-upgrade-authority",
  "extend-program",
  "metadata-set-authority",
  "registry-ix",
  "wrap-external",
] as const;
export type SquadsOp = (typeof SQUADS_OPS)[number];

export const REGISTRY_IXS = [
  "initialize_platform",
  "initialize_blocklist_authority",
  "propose_platform_admin",
  "accept_platform_admin",
  "add_admin",
  "remove_admin",
  "set_pause_flags",
  "set_protocol_treasury",
] as const;

export type OpPlan = {
  ixs: Instruction[];
  preconditions: string[];
  postconditions: string[];
  /** Keep this order across split transactions. */
  ordered: boolean;
};

type Json = Record<string, unknown>;

function programName(value: unknown): ProgramName {
  if (value === "asset_registry" || value === "transfer_hook") return value;
  throw new ChainGateError("program must be asset_registry or transfer_hook");
}

function addressInput(value: unknown, label: string): Address {
  if (typeof value !== "string" || !isAddress(value)) throw new ChainGateError(`${label} is not a valid address`);
  return value as Address;
}

/** The hot keys never receive an authority (D19). */
function refuseHotKey(target: Address, map: RoleMap, label: string) {
  if (target === map.deployer || target === map.bufferWriter) {
    throw new ChainGateError(`${label} ${target} is a hot key (deployer or bufferWriter); refused`);
  }
}

/**
 * A target outside `allowed` (the role-map keys for this role) needs an
 * explicit `confirmTarget` equal to it, so a typo cannot slip through.
 */
function mapTarget(value: unknown, label: string, map: RoleMap, allowed: Address[], confirm: unknown): Address {
  const target = addressInput(value, label);
  refuseHotKey(target, map, label);
  if (!allowed.includes(target) && confirm !== target) {
    throw new ChainGateError(`${label} ${target} is not the role-map key (${allowed.join(" / ") || "none"}); set confirmTarget to it to proceed`);
  }
  return target;
}

function maskInput(value: unknown, label: string): number {
  const mask = value ?? 0;
  if (typeof mask !== "number" || !Number.isInteger(mask) || mask < 0 || mask > 0xff) {
    throw new ChainGateError(`${label} must be an integer from 0 to 255`);
  }
  return mask;
}

async function uaIsVault(rpc: ChainRpc, name: ProgramName, vault: Address, preconditions: string[]) {
  const data = await fetchRawAccount(rpc, await programDataAddress(PROGRAM_IDS[name]));
  const decoded = data && data.owner === LOADER_V3 ? decodeProgramData(data.data) : null;
  if (!decoded) throw new ChainGateError(`${name}: ProgramData unavailable`);
  if (decoded.upgradeAuthority !== vault) {
    throw new ChainGateError(`${name}: upgrade authority is ${decoded.upgradeAuthority ?? "none"}, not the vault`);
  }
  preconditions.push(`${name}: upgrade authority = vault ${vault}`);
  return decoded;
}

/** Builds the instructions of one op and checks its on-chain preconditions. */
export async function planSquadsOp(input: {
  op: SquadsOp;
  params: Json | Json[];
  rpc: ChainRpc;
  map: RoleMap;
  release: Release | null;
  idlSources: Record<ProgramName, { label: string; bytes: Uint8Array }> | null;
}): Promise<OpPlan> {
  const { op, rpc, map, release } = input;
  const vault = map.squads.vault;
  const vaultSigner = createNoopSigner(vault);
  const params = input.params as Json;
  const preconditions: string[] = [];
  const postconditions: string[] = [];
  const ixs: Instruction[] = [];

  if (op === "upgrade") {
    if (!release) throw new ChainGateError("op=upgrade needs CHAIN_RELEASE_DIR");
    const buffers = (params.buffers ?? {}) as Json;
    const requested: [ProgramName, unknown][] = [
      ["transfer_hook", buffers.transferHook],
      ["asset_registry", buffers.assetRegistry],
    ];
    const chosen = requested.filter(([, value]) => value !== undefined && value !== null);
    if (!chosen.length) throw new ChainGateError("op=upgrade needs buffers.transferHook and/or buffers.assetRegistry");
    for (const [name, raw] of chosen) {
      const buffer = addressInput(raw, `buffers.${name}`);
      const programData = await uaIsVault(rpc, name, vault, preconditions);
      const account = await fetchRawAccount(rpc, buffer);
      const decoded = account && account.owner === LOADER_V3 ? decodeLoaderBuffer(account.data) : null;
      if (!decoded) throw new ChainGateError(`${name}: buffer ${buffer} is not a loader-v3 buffer`);
      if (decoded.authority !== vault) throw new ChainGateError(`${name}: buffer authority is ${decoded.authority ?? "none"}, not the vault`);
      if (!comparePayload(decoded.payload, release.so[name]).equal) {
        throw new ChainGateError(`${name}: buffer bytes differ from the Release .so`);
      }
      if (programData.payload.length < release.so[name].length) {
        throw new ChainGateError(`${name}: ProgramData capacity ${programData.payload.length} B < Release .so ${release.so[name].length} B; export extend-program first`);
      }
      preconditions.push(`${name}: buffer ${buffer} owned by the loader, authority = vault, bytes = Release .so (sha256 ${sha256Hex(release.so[name])})`);
      preconditions.push(`${name}: ProgramData capacity ${programData.payload.length} B ≥ ${release.so[name].length} B`);
      ixs.push(await upgradeInstruction({ program: PROGRAM_IDS[name], buffer, spill: map.bufferWriter, authority: vaultSigner }));
      postconditions.push(`${name}: ProgramData equals the Release .so (chain:inventory with CHAIN_RELEASE_DIR)`);
    }
    postconditions.push("buffer rent goes to the spill account (bufferWriter)");
    return { ixs, preconditions, postconditions, ordered: true };
  }

  if (op === "idl-update") {
    const specs = (Array.isArray(input.params) ? input.params : [input.params]) as Json[];
    for (const spec of specs) {
      if (spec.schema !== "mancipatio-idl-export-spec-v1") throw new ChainGateError("idl-update input must be a prepare-export spec");
      const name = programName(spec.program);
      const metadata = await findCanonicalMetadataPda(PROGRAM_IDS[name]);
      const programData = await programDataAddress(PROGRAM_IDS[name]);
      if (spec.vault !== vault || spec.spill !== map.bufferWriter || spec.metadata !== metadata || spec.programData !== programData) {
        throw new ChainGateError(`${name}: the export spec does not match the role map / canonical accounts`);
      }
      await uaIsVault(rpc, name, vault, preconditions);
      if (spec.buffer === null) {
        // Trim-only: the IDL is already in sync, the account is longer than it.
        const source = input.idlSources?.[name];
        const metadataAccount = await fetchRawAccount(rpc, metadata);
        const decoded = metadataAccount ? decodeMetadataAccount(metadataAccount.data) : null;
        const inflated = decoded ? inflateIdl(decoded.data) : null;
        if (
          spec.trim !== true ||
          !decoded ||
          !inflated ||
          !source ||
          !Buffer.from(inflated).equals(Buffer.from(source.bytes)) ||
          sha256Hex(inflated) !== spec.sourceSha256 ||
          decoded.dataLength !== spec.oldDataLength
        ) {
          throw new ChainGateError(`${name}: a trim-only spec needs the canonical IDL in sync with the ${source?.label ?? "source"} IDL`);
        }
        if (decoded.accountLength === PM_HEADER_LENGTH + decoded.dataLength) {
          throw new ChainGateError(`${name}: the metadata account is already trimmed`);
        }
        preconditions.push(`${name}: canonical IDL in sync (sha256 ${spec.sourceSha256}), account not trimmed`);
        ixs.push(pmTrim({ account: metadata, authority: vaultSigner, program: PROGRAM_IDS[name], programData, destination: map.bufferWriter }));
        postconditions.push(`${name}: chain:idl check reports in-sync and trimmed`);
        continue;
      }
      const buffer = addressInput(spec.buffer, "spec.buffer");
      const bufferAccount = await fetchRawAccount(rpc, buffer);
      const decodedBuffer = bufferAccount && bufferAccount.owner === PM_PROGRAM ? decodePmBufferAccount(bufferAccount.data) : null;
      if (!decodedBuffer || decodedBuffer.authority !== vault) throw new ChainGateError(`${name}: IDL buffer is not a PM buffer held by the vault`);
      const inflated = inflateIdl(decodedBuffer.data);
      const source = input.idlSources?.[name];
      if (!inflated || !source || !Buffer.from(inflated).equals(Buffer.from(source.bytes)) || sha256Hex(inflated) !== spec.sourceSha256) {
        throw new ChainGateError(`${name}: IDL buffer content differs from the ${source?.label ?? "source"} IDL`);
      }
      const metadataAccount = await fetchRawAccount(rpc, metadata);
      const decoded = metadataAccount ? decodeMetadataAccount(metadataAccount.data) : null;
      if (!decoded || decoded.dataLength !== spec.oldDataLength) {
        throw new ChainGateError(`${name}: the metadata account changed since prepare-export`);
      }
      preconditions.push(`${name}: IDL buffer ${buffer} held by the vault, inflated sha256 ${spec.sourceSha256}`);
      const lengths = Array.isArray(spec.extendLengths) ? (spec.extendLengths as number[]) : [];
      for (const length of lengths) {
        ixs.push(pmExtend({ account: metadata, authority: vaultSigner, program: PROGRAM_IDS[name], programData, length }));
      }
      ixs.push(pmSetData({ metadata, authority: vaultSigner, buffer, program: PROGRAM_IDS[name], programData, ...IDL_HEADER, data: null }));
      ixs.push(pmClose({ account: buffer, authority: vaultSigner, destination: map.bufferWriter }));
      if (spec.trim === true) {
        ixs.push(pmTrim({ account: metadata, authority: vaultSigner, program: PROGRAM_IDS[name], programData, destination: map.bufferWriter }));
      }
      postconditions.push(`${name}: chain:idl check reports in-sync`);
    }
    return { ixs, preconditions, postconditions, ordered: true };
  }

  if (op === "set-upgrade-authority") {
    const programs = Array.isArray(params.programs) ? params.programs.map(programName) : [];
    if (!programs.length) throw new ChainGateError("set-upgrade-authority needs programs");
    const next = params.newAuthority === null ? null : addressInput(params.newAuthority, "newAuthority");
    if (next === null && params.confirmImmutable !== true) {
      throw new ChainGateError("newAuthority null makes the program immutable; it needs confirmImmutable: true");
    }
    if (next !== null) {
      refuseHotKey(next, map, "newAuthority");
      if (next === vault) throw new ChainGateError("newAuthority is already the vault; nothing to export");
      // A new upgrade authority is irreversible from the vault's side: retype it.
      if (params.confirmNewAuthority !== next) {
        throw new ChainGateError("newAuthority needs confirmNewAuthority set to the same address");
      }
      preconditions.push(`new upgrade authority ${next} confirmed (not a hot key)`);
    }
    for (const name of programs) {
      await uaIsVault(rpc, name, vault, preconditions);
      ixs.push(await setUpgradeAuthorityInstruction({ program: PROGRAM_IDS[name], current: vaultSigner, next }));
      postconditions.push(`${name}: upgrade authority = ${next ?? "none (immutable)"}`);
    }
    return { ixs, preconditions, postconditions, ordered: false };
  }

  if (op === "extend-program") {
    const name = programName(params.program);
    const bytes = params.bytes;
    if (typeof bytes !== "number" || !Number.isInteger(bytes) || bytes < MINIMUM_EXTEND_PROGRAM_BYTES) {
      throw new ChainGateError(`extend-program bytes must be an integer ≥ ${MINIMUM_EXTEND_PROGRAM_BYTES} (SIMD-0431)`);
    }
    const programData = await uaIsVault(rpc, name, vault, preconditions);
    const room = MAX_PROGRAM_DATA_LEN - PROGRAMDATA_METADATA_SIZE - programData.payload.length;
    if (bytes > room) {
      throw new ChainGateError(`extend-program bytes ${bytes} exceed the ${room} B left under the 10 MiB account limit`);
    }
    ixs.push(
      await extendProgramCheckedInstruction({ program: PROGRAM_IDS[name], authority: vaultSigner, payer: vaultSigner, additionalBytes: bytes }),
    );
    postconditions.push(`${name}: ProgramData capacity ${programData.payload.length + bytes} B`);
    postconditions.push("the vault pays the extra rent (fund it first)");
    return { ixs, preconditions, postconditions, ordered: false };
  }

  if (op === "metadata-set-authority") {
    const name = programName(params.program);
    const next = params.newAuthority === null ? null : addressInput(params.newAuthority, "newAuthority");
    if (next !== null) {
      refuseHotKey(next, map, "newAuthority");
      if (next !== map.metadataAuthority && params.confirmNewAuthority !== next) {
        throw new ChainGateError("newAuthority is not the role-map metadataAuthority (D6); set confirmNewAuthority to it to proceed");
      }
      preconditions.push(`new extra metadata authority ${next}${next === map.metadataAuthority ? " = role-map metadataAuthority" : " (confirmed)"}`);
    }
    await uaIsVault(rpc, name, vault, preconditions);
    const metadata = await findCanonicalMetadataPda(PROGRAM_IDS[name]);
    const account = await fetchRawAccount(rpc, metadata);
    if (!account || !decodeMetadataAccount(account.data)) throw new ChainGateError(`${name}: canonical metadata account missing`);
    ixs.push(
      pmSetAuthority({
        account: metadata,
        authority: vaultSigner,
        program: PROGRAM_IDS[name],
        programData: await programDataAddress(PROGRAM_IDS[name]),
        newAuthority: next,
      }),
    );
    postconditions.push(`${name}: extra metadata authority = ${next ?? "none"} (D6)`);
    return { ixs, preconditions, postconditions, ordered: false };
  }

  if (op === "registry-ix") {
    const name = params.instruction;
    const args = (params.args ?? {}) as Json;
    if (!REGISTRY_IXS.includes(name as (typeof REGISTRY_IXS)[number])) {
      throw new ChainGateError(`registry-ix instruction must be one of ${REGISTRY_IXS.join(", ")}`);
    }
    const [platformAddress] = await findPlatformPda();
    const platform = await fetchMaybePlatform(rpc, platformAddress, { commitment: "finalized" });
    const confirm = params.confirmTarget;
    switch (name) {
      case "initialize_platform": {
        const treasury = addressInput(args.protocolTreasury ?? map.protocolTreasury, "args.protocolTreasury");
        if (treasury !== map.protocolTreasury) throw new ChainGateError(`args.protocolTreasury must be the role-map treasury ${map.protocolTreasury} (D5)`);
        const fee = args.protocolFeeBps ?? map.protocolFeeBps;
        if (typeof fee !== "number" || !Number.isInteger(fee) || fee !== map.protocolFeeBps) {
          throw new ChainGateError(`args.protocolFeeBps must equal the role-map protocolFeeBps ${map.protocolFeeBps} (the fee has no setter)`);
        }
        ixs.push(
          await buildInitializePlatformInstruction(rpc, {
            admin: vaultSigner,
            upgradeAuthority: vaultSigner,
            protocolTreasury: treasury,
            protocolFeeBps: fee,
          }),
        );
        preconditions.push(`treasury ${treasury} = role map; protocol fee ${fee} bps = role map`);
        break;
      }
      case "initialize_blocklist_authority": {
        // Irreversible: only the BA itself can ever propose a successor.
        const authority = mapTarget(args.authority ?? map.blocklistAuthority, "args.authority", map, [map.blocklistAuthority], confirm);
        ixs.push(await buildInitializeBlocklistAuthorityInstruction(rpc, { payer: vaultSigner, upgradeAuthority: vaultSigner, authority }));
        preconditions.push(`blocklist authority ${authority}${authority === map.blocklistAuthority ? " = role map" : " (confirmed)"}`);
        break;
      }
      case "propose_platform_admin": {
        const newAdmin = mapTarget(args.newAdmin, "args.newAdmin", map, [map.superAdmin, vault], confirm);
        ixs.push(await getProposePlatformAdminInstructionAsync({ authority: vaultSigner, newAdmin }));
        preconditions.push(`proposed platform admin ${newAdmin}${newAdmin === map.superAdmin ? " = role-map superAdmin" : newAdmin === vault ? " = the vault" : " (confirmed)"}`);
        break;
      }
      case "accept_platform_admin": {
        if (!platform.exists) throw new ChainGateError("accept_platform_admin: Platform missing");
        const [oldAdminRecord] = await findAdminRecordPda({ authority: platform.data.admin });
        ixs.push(await getAcceptPlatformAdminInstructionAsync({ newAdmin: vaultSigner, oldAdminRecord }));
        break;
      }
      case "add_admin": {
        const newAdmin = mapTarget(args.newAdmin, "args.newAdmin", map, map.admins, confirm);
        if (newAdmin === map.kyc.authority && !map.allowKycAdmin) {
          throw new ChainGateError("args.newAdmin is kyc.authority; an Admin record for it needs allowKycAdmin in the role map");
        }
        ixs.push(await getAddAdminInstructionAsync({ superAdmin: vaultSigner, newAdmin }));
        preconditions.push(`new Admin ${newAdmin}${map.admins.includes(newAdmin) ? " is in role-map admins" : " (confirmed)"}`);
        break;
      }
      case "remove_admin": {
        // Any Admin record may be removed (also one outside the map); a wrong
        // key only fails on-chain, it grants nothing.
        const admin = addressInput(args.admin, "args.admin");
        ixs.push(await getRemoveAdminInstructionAsync({ superAdmin: vaultSigner, admin }));
        preconditions.push(`remove the Admin record of ${admin}`);
        break;
      }
      case "set_pause_flags": {
        const setMask = maskInput(args.setMask, "args.setMask");
        const clearMask = maskInput(args.clearMask, "args.clearMask");
        if (setMask === 0 && clearMask === 0) throw new ChainGateError("set_pause_flags with both masks 0 changes nothing");
        ixs.push(await getSetPauseFlagsInstructionAsync({ authority: vaultSigner, setMask, clearMask }));
        preconditions.push(
          `pause set ${formatPauseFlags(setMask)} (${describePausedAreas(setMask) || "no defined area"}), clear ${formatPauseFlags(clearMask)} (${describePausedAreas(clearMask) || "no defined area"})`,
        );
        break;
      }
      case "set_protocol_treasury": {
        const newTreasury = mapTarget(args.newTreasury, "args.newTreasury", map, [vault], confirm);
        ixs.push(await getSetProtocolTreasuryInstructionAsync({ superAdmin: vaultSigner, newTreasury }));
        preconditions.push(`new treasury ${newTreasury}${newTreasury === vault ? " = the vault (D5)" : " (confirmed)"}`);
        break;
      }
    }
    preconditions.push(`registry-ix ${String(name)} signed by the vault ${vault}`);
    return { ixs, preconditions, postconditions, ordered: false };
  }

  // wrap-external
  const base58 = params.transactionBase58;
  if (typeof base58 !== "string") throw new ChainGateError("wrap-external needs transactionBase58 (solana-verify export-pda-tx output)");
  let external: ExternalInspection;
  try {
    external = await inspectExternalTransaction(base58, vault, Object.values(PROGRAM_IDS));
  } catch (error) {
    throw new ChainGateError((error as Error).message);
  }
  preconditions.push(
    `external transaction: verify instructions signed by the vault for ${external.programs.join(", ")}; the vault is the only signer`,
  );
  preconditions.push(
    `verify PDA(s) ("otter_verify", vault, program), accounts limited to the vault, program, PDA, ProgramData and System: ${external.pdas.map((p) => `${p.program} → ${p.pda}`).join("; ")}`,
  );
  preconditions.push(
    external.transfers.length
      ? `System transfers only into the derived verify PDA: ${external.transfers.map((t) => `${t.lamports} lamports → ${t.destination} (PDA of ${t.program})`).join("; ")}`
      : "no top-level System instruction",
  );
  postconditions.push("the verify PDA names the vault as uploader (EXTERNAL #5)");
  return { ixs: external.instructions, preconditions, postconditions, ordered: true };
}

export type ExportedTransaction = {
  index: number;
  executeOrder: string;
  messageBytes: number;
  instructions: ReturnType<typeof describeInstruction>[];
  transactionBase58: string;
  transactionBase64: string;
};

export function exportTransactions(plan: OpPlan, vault: Address, blockhash: LatestBlockhash): ExportedTransaction[] {
  const groups = splitBySize(plan.ixs, vault, blockhash);
  return groups.map((ixs, index) => {
    const encoded = encodeVaultTransaction({ vault, ixs, blockhash });
    return {
      index,
      executeOrder:
        groups.length > 1
          ? `transaction ${index + 1} of ${groups.length}: execute strictly in order`
          : "single transaction",
      messageBytes: encoded.messageBytes,
      instructions: ixs.map(describeInstruction),
      transactionBase58: encoded.transactionBase58,
      transactionBase64: encoded.transactionBase64,
    };
  });
}

/** Refuses an unverified Squads config; the override exists off mainnet only. */
export function assertSquadsVerified(check: SquadsCheck, network: Network, unverified: boolean): "verified" | "unverified" {
  if (check.ok) return "verified";
  if (!unverified || network === "mainnet") {
    throw new ChainGateError(`The Squads multisig does not match the role map: ${check.errors.join("; ")}`);
  }
  return "unverified";
}

function readOp(value: string | undefined): SquadsOp {
  const op = value?.trim() as SquadsOp | undefined;
  if (!op || !SQUADS_OPS.includes(op)) throw new ChainGateError(`CHAIN_SQUADS_OP must be one of ${SQUADS_OPS.join(", ")}`);
  return op;
}

export async function squadsExportTool(ctx: ToolContext): Promise<ToolStatus> {
  const { config, env, evidence } = ctx;
  const op = readOp(env.CHAIN_SQUADS_OP);
  evidence.op = op;
  ctx.phase = "inputs";
  const loaded = await loadRoleMap(config.roleMapPath!, { network: config.network, genesis: config.expectedGenesis });
  const map = loaded.map;
  evidence.roleMapSha256 = loaded.sha256;
  const release = config.releaseDir ? loadRelease(config.releaseDir, { requireSums: config.network === "mainnet" }) : null;
  evidence.release = releaseEvidence(release);
  assertReleaseSource({ network: config.network, root: ctx.root, localIdl: readLocalIdl(ctx.frontDir), releaseIdl: release?.idl ?? null });
  const inputPath = env.CHAIN_SQUADS_INPUT?.trim();
  let params: Json | Json[] = {};
  if (inputPath) {
    try {
      params = JSON.parse(fs.readFileSync(inputPath, "utf8"));
    } catch {
      throw new ChainGateError("CHAIN_SQUADS_INPUT is unreadable or not JSON (path withheld)");
    }
  } else if (op !== "registry-ix") {
    throw new ChainGateError(`CHAIN_SQUADS_INPUT is required for op=${op}`);
  }

  ctx.phase = "squads";
  const multisig = await fetchRawAccount(ctx.rpc, map.squads.multisig);
  const check = await checkSquadsAccount(multisig ? { owner: multisig.owner, data: multisig.data } : null, map.squads);
  evidence.squads = check;
  if (assertSquadsVerified(check, config.network, env.CHAIN_SQUADS_CONFIG_UNVERIFIED?.trim() === "1") === "unverified") {
    ctx.log("warning: CHAIN_SQUADS_CONFIG_UNVERIFIED=1 — exporting without a verified Squads config (off mainnet only)");
  }

  ctx.phase = "plan";
  const idlSources =
    op === "idl-update" ? resolveIdlSources(ctx, release, { prefer: release?.idl ? "release" : "head" }) : null;
  const plan = await planSquadsOp({ op, params, rpc: ctx.rpc, map, release, idlSources });
  const blockhash = (await ctx.rpc.getLatestBlockhash({ commitment: "finalized" }).send()).value;
  const transactions = exportTransactions(plan, map.squads.vault, blockhash);
  evidence.export = {
    header: {
      op,
      vault: map.squads.vault,
      multisig: map.squads.multisig,
      feePayer: map.squads.vault,
      blockhash: blockhash.blockhash,
      lastValidBlockHeight: blockhash.lastValidBlockHeight.toString(),
      preconditions: plan.preconditions,
      postconditions: plan.postconditions,
      ordered: plan.ordered,
      note: "Unsigned legacy transactions for the Squads Transaction Builder (EXTERNAL #1: import format). Import, approve and execute them in index order.",
    },
    transactions,
  };
  for (const tx of transactions) ctx.log(`tx ${tx.index + 1}/${transactions.length}: ${tx.instructions.length} instructions, ${tx.messageBytes} B message`);
  for (const line of plan.preconditions) ctx.log(`pre:  ${line}`);
  for (const line of plan.postconditions) ctx.log(`post: ${line}`);
  return "completed";
}

