/**
 * Tool 2: canonical IDL (`chain:idl`), design-3.3 §5.
 *
 * Modes (CHAIN_IDL_MODE):
 * - check (default): in-sync | in-sync-canonical | update | init | immutable |
 *   foreign-format, plus the extra metadata authority;
 * - send: the UA (the deployer before handover) initializes or updates the
 *   canonical metadata account;
 * - prepare-export: the bufferWriter (UA = vault) funds and fills a buffer,
 *   hands it to the vault and writes the §7 `idl-update` export spec.
 */
import fs from "node:fs";
import path from "node:path";
import {
  createNoopSigner,
  generateKeyPairSigner,
  getAddressDecoder,
  type Address,
  type TransactionSigner,
} from "@solana/kit";
import { getCreateAccountInstruction, getTransferSolInstruction } from "@solana-program/system";
import { ASSET_REGISTRY_PROGRAM_ADDRESS } from "@/lib/generated/asset_registry";
import { TRANSFER_HOOK_PROGRAM_ADDRESS } from "@/lib/generated/transfer_hook";
import { fetchRawAccount, fetchRawAccounts, type RawAccount } from "./accounts";
import type { ToolContext, ToolStatus } from "./context";
import {
  comparePayload,
  decodeProgramAccount,
  decodeProgramData,
  programDataAddress,
} from "./loader-v3";
import {
  IDL_HEADER,
  IDL_SEED,
  PM_HEADER_LENGTH,
  PM_PROGRAM,
  PM_REALLOC_LIMIT,
  compressIdl,
  decodeMetadataAccount,
  decodePmBufferAccount,
  extendLengths,
  findCanonicalMetadataPda,
  inflateIdl,
  pmAllocate,
  pmInitialize,
  pmSetAuthority,
  pmSetData,
  pmClose,
  pmTrim,
  pmExtend,
  pmWrite,
  writeChunks,
  type MetadataAccount,
} from "./program-metadata";
import { idlAddress, loadRelease, releaseEvidence, type Release } from "./release";
import { loadRoleMap, type RoleMap } from "./role-map";
import type { ChainRpc } from "./rpc";
import {
  ChainGateError,
  ChainPlanError,
  IDL_PROGRAMS,
  assertOutputPath,
  assertReleaseSource,
  canonicalJson,
  dirtySourcePaths,
  loadHotSigner,
  readLocalIdl,
  sha256Hex,
  toJson,
  type ProgramName,
} from "./safety";
import {
  buildMessage,
  executePlan,
  planDigest,
  simulateUnsigned,
  summarizeSimulation,
  type PlanStep,
  type StepRecord,
} from "./tx";

export const PROGRAM_IDS: Record<ProgramName, Address> = {
  asset_registry: ASSET_REGISTRY_PROGRAM_ADDRESS,
  transfer_hook: TRANSFER_HOOK_PROGRAM_ADDRESS,
};

export type IdlStatus =
  | "in-sync"
  | "in-sync-canonical"
  | "update"
  | "init"
  | "init-resume"
  | "immutable"
  | "foreign-format";

export type IdlSource = { label: "release" | "head"; bytes: Uint8Array };

export type IdlProbe = {
  program: ProgramName;
  programAddress: Address;
  metadata: Address;
  status: IdlStatus;
  account: RawAccount | null;
  decoded: MetadataAccount | null;
  /** Inflated on-chain bytes (null when absent or undecodable). */
  onChain: Uint8Array | null;
  source: IdlSource;
  extraAuthority: Address | null;
  mutable: boolean | null;
  trimmed: boolean | null;
};

function canonicalEqual(a: Uint8Array, b: Uint8Array): boolean {
  try {
    return (
      canonicalJson(JSON.parse(Buffer.from(a).toString("utf8"))) ===
      canonicalJson(JSON.parse(Buffer.from(b).toString("utf8")))
    );
  } catch {
    return false;
  }
}

/** Classifies an account (or its absence) against the source IDL bytes. */
export function classifyIdl(
  program: ProgramName,
  metadata: Address,
  account: RawAccount | null,
  source: IdlSource,
): IdlProbe {
  const programAddress = PROGRAM_IDS[program];
  const base = {
    program,
    programAddress,
    metadata,
    account,
    source,
    decoded: null,
    onChain: null,
    extraAuthority: null,
    mutable: null,
    trimmed: null,
  };
  if (!account || account.lamports === BigInt(0)) return { ...base, status: "init" };
  if (account.owner !== PM_PROGRAM) {
    // A funded but unallocated PDA (a crashed init after the rent transfer).
    return { ...base, status: account.data.length === 0 ? "init-resume" : "foreign-format" };
  }
  const buffer = decodePmBufferAccount(account.data);
  if (buffer) {
    // The canonical PDA allocated as a buffer: a crashed init before `initialize`.
    return { ...base, status: buffer.canonical ? "init-resume" : "foreign-format" };
  }
  const decoded = decodeMetadataAccount(account.data);
  if (
    !decoded ||
    decoded.program !== programAddress ||
    !decoded.canonical ||
    decoded.seed !== IDL_SEED ||
    decoded.encoding !== IDL_HEADER.encoding ||
    decoded.compression !== IDL_HEADER.compression ||
    decoded.format !== IDL_HEADER.format ||
    decoded.dataSource !== IDL_HEADER.dataSource
  ) {
    return { ...base, decoded, status: "foreign-format" };
  }
  const onChain = inflateIdl(decoded.data);
  const common = {
    ...base,
    decoded,
    onChain,
    extraAuthority: decoded.authority,
    mutable: decoded.mutable,
    trimmed: decoded.accountLength === PM_HEADER_LENGTH + decoded.dataLength,
  };
  if (!onChain) return { ...common, status: "foreign-format" };
  if (Buffer.from(onChain).equals(Buffer.from(source.bytes))) return { ...common, status: "in-sync" };
  if (!decoded.mutable) return { ...common, status: "immutable" };
  if (canonicalEqual(onChain, source.bytes)) return { ...common, status: "in-sync-canonical" };
  return { ...common, status: "update" };
}

export async function probeIdl(rpc: ChainRpc, program: ProgramName, source: IdlSource): Promise<IdlProbe> {
  const metadata = await findCanonicalMetadataPda(PROGRAM_IDS[program]);
  return classifyIdl(program, metadata, await fetchRawAccount(rpc, metadata), source);
}

export function idlProbeEvidence(probe: IdlProbe) {
  return {
    program: probe.program,
    metadata: probe.metadata,
    status: probe.status,
    source: probe.source.label,
    sourceSha256: sha256Hex(probe.source.bytes),
    onChainSha256: probe.onChain ? sha256Hex(probe.onChain) : null,
    extraAuthority: probe.extraAuthority,
    mutable: probe.mutable,
    trimmed: probe.trimmed,
    dataLength: probe.decoded?.dataLength ?? null,
    accountLength: probe.account?.data.length ?? null,
  };
}

/** Post-send verification (design §5 "Verify"). Returns the failures. */
export function verifyIdl(probe: IdlProbe): string[] {
  const failures: string[] = [];
  const d = probe.decoded;
  if (!d) return [`${probe.program}: metadata account missing or not a Metadata account`];
  if (!d.canonical) failures.push(`${probe.program}: metadata is not canonical`);
  if (
    d.encoding !== IDL_HEADER.encoding ||
    d.compression !== IDL_HEADER.compression ||
    d.format !== IDL_HEADER.format ||
    d.dataSource !== IDL_HEADER.dataSource
  ) {
    failures.push(`${probe.program}: header enums differ from Utf8/Zlib/Json/Direct`);
  }
  if (d.accountLength !== PM_HEADER_LENGTH + d.dataLength) failures.push(`${probe.program}: account is not trimmed`);
  if (!probe.onChain || !Buffer.from(probe.onChain).equals(Buffer.from(probe.source.bytes))) {
    failures.push(`${probe.program}: inflated bytes differ from the source`);
  }
  return failures;
}

// ── Planning ────────────────────────────────────────────────────────────────

export type IdlState = Map<Address, RawAccount | null>;

export type IdlPlanInput = {
  probe: IdlProbe;
  signer: TransactionSigner;
  signerRole: string;
  programData: Address;
  rent: (size: number) => Promise<bigint>;
  /** send: the UA signs PM instructions; prepare-export: the vault will. */
  mode: "send" | "prepare-export";
  vault?: Address;
  newBuffer: TransactionSigner;
  resumeBuffer?: RawAccount | null;
};

export type IdlPlan = {
  steps: PlanStep<IdlState>[];
  watched: Address[];
  placeholders: Map<string, string>;
  bufferAddress: Address | null;
  exportSpec: IdlExportSpec | null;
  notes: string[];
};

export type IdlExportSpec = {
  schema: "mancipatio-idl-export-spec-v1";
  program: ProgramName;
  programAddress: Address;
  programData: Address;
  metadata: Address;
  buffer: Address;
  vault: Address;
  spill: Address;
  oldDataLength: number;
  newDataLength: number;
  extendLengths: number[];
  trim: boolean;
  sourceSha256: string;
  compressedSha256: string;
};

const lamportsOf = (state: IdlState, key: Address) => state.get(key)?.lamports ?? BigInt(0);
const lengthOf = (state: IdlState, key: Address) => state.get(key)?.data.length ?? 0;

function chunkLanded(state: IdlState, key: Address, offset: number, chunk: Uint8Array): boolean {
  const account = state.get(key);
  if (!account || account.owner !== PM_PROGRAM) return false;
  const start = PM_HEADER_LENGTH + offset;
  if (account.data.length < start + chunk.length) return false;
  return Buffer.from(account.data.subarray(start, start + chunk.length)).equals(Buffer.from(chunk));
}

/** Builds the send or prepare-export steps for one program. */
export async function planIdl(input: IdlPlanInput): Promise<IdlPlan> {
  const { probe, signer, mode } = input;
  const M = probe.metadata;
  const P = probe.programAddress;
  const PD = input.programData;
  const compressed = compressIdl(probe.source.bytes);
  const L = compressed.length;
  const steps: PlanStep<IdlState>[] = [];
  const notes: string[] = [];
  const placeholders = new Map<string, string>();
  const id = (suffix: string) => `${probe.program}:${suffix}`;
  const base = { signer, signerRole: input.signerRole, simulate: "at-send" as const };
  const target = PM_HEADER_LENGTH + L;
  const rentTarget = await input.rent(target);
  const currentLamports = probe.account?.lamports ?? BigInt(0);

  if (probe.status === "immutable" || probe.status === "foreign-format") {
    throw new ChainPlanError(`${probe.program}: canonical IDL is ${probe.status}; the tool stops`);
  }
  if (probe.status === "in-sync") {
    return { steps, watched: [M], placeholders, bufferAddress: null, exportSpec: null, notes: ["in sync; nothing to send"] };
  }

  if (probe.status === "init" || probe.status === "init-resume") {
    if (mode !== "send") throw new ChainPlanError(`${probe.program}: IDL init needs the UA (before handover); prepare-export only updates`);
    const allocated = probe.account?.owner === PM_PROGRAM;
    if (currentLamports < rentTarget) {
      steps.push({
        ...base,
        id: id("fund"),
        title: `fund the canonical metadata account (${rentTarget - currentLamports} lamports)`,
        ixs: [getTransferSolInstruction({ source: signer, destination: M, amount: rentTarget - currentLamports })],
        preconditions: [{ label: `lamports(${M})=${currentLamports}`, holds: (s) => lamportsOf(s, M) === currentLamports }],
        skip: (s) => lamportsOf(s, M) >= rentTarget,
        idempotency: "non-idempotent",
        required: "finalized",
      });
    }
    if (!allocated) {
      steps.push({
        ...base,
        id: id("allocate"),
        title: "allocate the canonical metadata PDA",
        ixs: [pmAllocate({ buffer: M, authority: signer, program: P, programData: PD, seed: IDL_SEED })],
        preconditions: [],
        skip: (s) => s.get(M)?.owner === PM_PROGRAM,
        idempotency: "replay-safe",
        required: "finalized",
      });
    }
    if (L > PM_REALLOC_LIMIT) {
      let cumulative = allocated ? Math.max(0, (probe.account?.data.length ?? 0) - PM_HEADER_LENGTH) : 0;
      extendLengths(Math.max(0, L - cumulative)).forEach((length, i) => {
        cumulative += length;
        const reach = PM_HEADER_LENGTH + cumulative;
        steps.push({
          ...base,
          id: id(`extend:${i + 1}`),
          title: `extend the metadata account by ${length} B`,
          ixs: [pmExtend({ account: M, authority: signer, program: P, programData: PD, length })],
          preconditions: [],
          skip: (s) => lengthOf(s, M) >= reach,
          idempotency: "non-idempotent",
          required: "finalized",
        });
      });
    }
    const current = new Map<Address, RawAccount | null>([[M, probe.account]]);
    const chunks = writeChunks(compressed).filter(([offset, chunk]) => !chunkLanded(current, M, offset, chunk));
    chunks.forEach(([offset, chunk], i) => {
      steps.push({
        ...base,
        id: id(`write:${offset}`),
        title: `write ${chunk.length} B at ${offset}`,
        ixs: [pmWrite({ buffer: M, authority: signer, offset, data: chunk })],
        preconditions: [],
        skip: (s) => chunkLanded(s, M, offset, chunk),
        idempotency: "replay-safe",
        required: i === chunks.length - 1 ? "finalized" : "confirmed",
      });
    });
    steps.push({
      ...base,
      id: id("initialize"),
      title: "initialize the canonical IDL (Utf8, Zlib, Json, Direct)",
      ixs: [
        pmInitialize({
          metadata: M,
          authority: signer,
          program: P,
          programData: PD,
          system: PM_PROGRAM,
          seed: IDL_SEED,
          ...IDL_HEADER,
          data: null,
        }),
      ],
      preconditions: [],
      skip: (s) => {
        const account = s.get(M);
        return Boolean(account && decodeMetadataAccount(account.data));
      },
      idempotency: "replay-safe",
      required: "finalized",
      postCheck: (s) => {
        const account = s.get(M) ?? null;
        return verifyIdl(classifyIdl(probe.program, M, account, probe.source)).length === 0;
      },
    });
    return { steps, watched: [M], placeholders, bufferAddress: null, exportSpec: null, notes };
  }

  // update / in-sync-canonical → a buffer, then setData.
  const decoded = probe.decoded!;
  const oldLength = decoded.dataLength;
  const delta = L - oldLength;
  const resume = input.resumeBuffer ?? null;
  const buffer = resume ? resume.address : input.newBuffer.address;
  if (!resume) placeholders.set(input.newBuffer.address, `<idl-buffer:${probe.program}>`);
  const bufferAuthority = signer.address;
  if (probe.status === "in-sync-canonical") notes.push("in sync canonically; the bytes differ and will be replaced");

  if (delta > 0 && currentLamports < rentTarget) {
    steps.push({
      ...base,
      id: id("top-up"),
      title: `top up metadata rent (${rentTarget - currentLamports} lamports)`,
      ixs: [getTransferSolInstruction({ source: signer, destination: M, amount: rentTarget - currentLamports })],
      preconditions: [{ label: `lamports(${M})=${currentLamports}`, holds: (s) => lamportsOf(s, M) === currentLamports }],
      skip: (s) => lamportsOf(s, M) >= rentTarget,
      idempotency: "non-idempotent",
      required: "finalized",
    });
  }
  const extendSteps = delta > PM_REALLOC_LIMIT ? extendLengths(delta) : [];
  if (mode === "send") {
    let reach = PM_HEADER_LENGTH + oldLength;
    extendSteps.forEach((length, i) => {
      reach += length;
      const target = reach;
      steps.push({
        ...base,
        id: id(`extend:${i + 1}`),
        title: `extend the metadata account by ${length} B`,
        ixs: [pmExtend({ account: M, authority: signer, program: P, programData: PD, length })],
        preconditions: [],
        skip: (s) => lengthOf(s, M) >= target,
        idempotency: "non-idempotent",
        required: "finalized",
      });
    });
  }
  if (resume) {
    const decodedBuffer = decodePmBufferAccount(resume.data);
    if (!decodedBuffer || resume.owner !== PM_PROGRAM || decodedBuffer.authority !== bufferAuthority) {
      throw new ChainGateError("CHAIN_IDL_RESUME_BUFFER is not a PM buffer owned by the signer");
    }
    if (resume.data.length !== PM_HEADER_LENGTH + L) {
      throw new ChainGateError("CHAIN_IDL_RESUME_BUFFER has a different size than the source IDL");
    }
    notes.push(`resuming buffer ${resume.address}`);
  } else {
    const bufferRent = await input.rent(PM_HEADER_LENGTH + L);
    steps.push({
      ...base,
      id: id("buffer"),
      title: "create the IDL buffer (createAccount + allocate + setAuthority)",
      ixs: [
        getCreateAccountInstruction({
          payer: signer,
          newAccount: input.newBuffer,
          lamports: bufferRent,
          space: BigInt(PM_HEADER_LENGTH + L),
          programAddress: PM_PROGRAM,
        }),
        pmAllocate({ buffer, authority: input.newBuffer }),
        pmSetAuthority({ account: buffer, authority: input.newBuffer, newAuthority: bufferAuthority }),
      ],
      preconditions: [],
      skip: (s) => Boolean(s.get(buffer)),
      idempotency: "non-idempotent",
      required: "finalized",
    });
  }
  const known = new Map<Address, RawAccount | null>([[buffer, resume]]);
  const chunks = writeChunks(compressed).filter(([offset, chunk]) => !chunkLanded(known, buffer, offset, chunk));
  chunks.forEach(([offset, chunk], i) => {
    steps.push({
      ...base,
      id: id(`write:${offset}`),
      title: `write ${chunk.length} B at ${offset}`,
      ixs: [pmWrite({ buffer, authority: signer, offset, data: chunk })],
      preconditions: [],
      skip: (s) => chunkLanded(s, buffer, offset, chunk),
      idempotency: "replay-safe",
      required: i === chunks.length - 1 ? "finalized" : "confirmed",
    });
  });

  if (mode === "prepare-export") {
    if (!input.vault) throw new ChainGateError("prepare-export needs the Squads vault from the role map");
    steps.push({
      ...base,
      id: id("buffer-to-vault"),
      title: "hand the buffer to the vault (setAuthority)",
      ixs: [pmSetAuthority({ account: buffer, authority: signer, newAuthority: input.vault })],
      preconditions: [],
      skip: (s) => {
        const account = s.get(buffer);
        return Boolean(account && decodePmBufferAccount(account.data)?.authority === input.vault);
      },
      idempotency: "replay-safe",
      required: "finalized",
    });
    return {
      steps,
      watched: [M, buffer],
      placeholders,
      bufferAddress: buffer,
      notes,
      exportSpec: {
        schema: "mancipatio-idl-export-spec-v1",
        program: probe.program,
        programAddress: P,
        programData: PD,
        metadata: M,
        buffer,
        vault: input.vault,
        spill: signer.address,
        oldDataLength: oldLength,
        newDataLength: L,
        extendLengths: extendSteps,
        trim: delta < 0,
        sourceSha256: sha256Hex(probe.source.bytes),
        compressedSha256: sha256Hex(compressed),
      },
    };
  }

  steps.push({
    ...base,
    id: id("set-data"),
    title: "setData from the buffer",
    ixs: [pmSetData({ metadata: M, authority: signer, buffer, program: P, programData: PD, ...IDL_HEADER, data: null })],
    preconditions: [],
    skip: (s) => {
      const account = s.get(M) ?? null;
      const now = classifyIdl(probe.program, M, account, probe.source);
      return now.status === "in-sync";
    },
    idempotency: "replay-safe",
    required: "finalized",
  });
  steps.push({
    ...base,
    id: id("close-buffer"),
    title: "close the buffer (rent back to the signer)",
    ixs: [pmClose({ account: buffer, authority: signer, destination: signer.address })],
    preconditions: [],
    skip: (s) => !s.get(buffer),
    idempotency: "replay-safe",
    required: "finalized",
  });
  if (delta < 0) {
    steps.push({
      ...base,
      id: id("trim"),
      title: "trim the metadata account",
      ixs: [pmTrim({ account: M, authority: signer, program: P, programData: PD, destination: signer.address })],
      preconditions: [],
      skip: (s) => lengthOf(s, M) === PM_HEADER_LENGTH + L,
      idempotency: "replay-safe",
      required: "finalized",
    });
  }
  const last = steps[steps.length - 1];
  last.postCheck = (s) => verifyIdl(classifyIdl(probe.program, M, s.get(M) ?? null, probe.source)).length === 0;
  return { steps, watched: [M, buffer], placeholders, bufferAddress: buffer, exportSpec: null, notes };
}

// ── Tool ────────────────────────────────────────────────────────────────────

type IdlMode = "check" | "send" | "prepare-export";

function readIdlMode(ctx: ToolContext): IdlMode {
  const raw = ctx.env.CHAIN_IDL_MODE?.trim() || "check";
  if (raw !== "check" && raw !== "send" && raw !== "prepare-export") {
    throw new ChainGateError("CHAIN_IDL_MODE must be check, send or prepare-export");
  }
  // send / prepare-export without CHAIN_SEND=1 is a dry run: plan + digest.
  if (raw === "check" && ctx.config.send) throw new ChainGateError("CHAIN_IDL_MODE=check never sends; set send or prepare-export");
  return raw;
}

function selectedPrograms(ctx: ToolContext): ProgramName[] {
  const raw = ctx.env.CHAIN_IDL_PROGRAM?.trim();
  if (!raw) return ["transfer_hook", "asset_registry"];
  if (!(IDL_PROGRAMS as readonly string[]).includes(raw)) {
    throw new ChainGateError("CHAIN_IDL_PROGRAM must be asset_registry or transfer_hook");
  }
  return [raw as ProgramName];
}

/** Source bytes per program (design §5 "Source"). */
export function resolveIdlSources(
  ctx: Pick<ToolContext, "env" | "config" | "frontDir">,
  release: Release | null,
  options: { prefer?: "release" | "head"; inventory?: boolean } = {},
): Record<ProgramName, IdlSource> {
  const want =
    options.prefer ?? (ctx.env.CHAIN_IDL_SOURCE?.trim() || (ctx.config.network === "mainnet" ? "" : "head"));
  if (ctx.config.network === "mainnet" && want !== "release" && !options.inventory) {
    throw new ChainGateError("A mainnet IDL run needs CHAIN_IDL_SOURCE=release");
  }
  if (want !== "release" && want !== "head") throw new ChainGateError("CHAIN_IDL_SOURCE must be release or head");
  if (want === "release") {
    if (!release?.idl) throw new ChainGateError("CHAIN_IDL_SOURCE=release needs a CHAIN_RELEASE_DIR with IDL files");
    const out = {} as Record<ProgramName, IdlSource>;
    for (const name of IDL_PROGRAMS) {
      if (idlAddress(release.idl[name]) !== PROGRAM_IDS[name]) {
        throw new ChainGateError(`The Release ${name}.json address is not the program ID`);
      }
      out[name] = { label: "release", bytes: release.idl[name] };
    }
    return out;
  }
  const local = readLocalIdl(ctx.frontDir);
  const out = {} as Record<ProgramName, IdlSource>;
  for (const name of IDL_PROGRAMS) {
    if (idlAddress(local[name]) !== PROGRAM_IDS[name]) throw new ChainGateError(`front/idl/${name}.json address is not the program ID`);
    out[name] = { label: "head", bytes: local[name] };
  }
  return out;
}

/** UA of both programs and the release-bytes equality (mainnet gate). */
export async function probePrograms(rpc: ChainRpc, release: Release | null) {
  const out = {} as Record<
    ProgramName,
    { programData: Address; authority: Address | null; deployed: boolean; releaseEqual: boolean | null; capacity: number | null }
  >;
  for (const name of IDL_PROGRAMS) {
    const programData = await programDataAddress(PROGRAM_IDS[name]);
    const accounts = await fetchRawAccounts(rpc, [PROGRAM_IDS[name]]);
    const program = accounts.get(PROGRAM_IDS[name]);
    const link = program ? decodeProgramAccount(program.data) : null;
    const data = await fetchRawAccount(rpc, programData);
    const decoded = data ? decodeProgramData(data.data) : null;
    out[name] = {
      programData,
      authority: decoded?.upgradeAuthority ?? null,
      deployed: Boolean(program?.executable && link?.programData === programData && decoded),
      releaseEqual: release && decoded ? comparePayload(decoded.payload, release.so[name]).equal : null,
      capacity: decoded?.payload.length ?? null,
    };
  }
  return out;
}

export async function idlTool(ctx: ToolContext): Promise<ToolStatus> {
  const { config, env, evidence } = ctx;
  const mode = readIdlMode(ctx);
  evidence.idlMode = mode;
  ctx.phase = "release";
  const release = config.releaseDir ? loadRelease(config.releaseDir, { requireSums: config.network === "mainnet" }) : null;
  evidence.release = releaseEvidence(release);
  const sources = resolveIdlSources(ctx, release);
  if (config.network === "mainnet") {
    assertReleaseSource({
      network: config.network,
      root: ctx.root,
      localIdl: readLocalIdl(ctx.frontDir),
      releaseIdl: release?.idl ?? null,
    });
  } else if (mode !== "check" && sources.asset_registry.label === "head" && dirtySourcePaths(ctx.root).some((line) => line.includes("front/idl"))) {
    throw new ChainGateError("front/idl has uncommitted changes; commit them or use CHAIN_IDL_SOURCE=release");
  }
  let map: RoleMap | null = null;
  if (config.roleMapPath) {
    const loaded = await loadRoleMap(config.roleMapPath, { network: config.network, genesis: config.expectedGenesis });
    map = loaded.map;
    evidence.roleMapSha256 = loaded.sha256;
    evidence.roleMapWarnings = loaded.warnings;
  } else if (mode !== "check") {
    throw new ChainGateError(`CHAIN_ROLE_MAP is required for CHAIN_IDL_MODE=${mode}`);
  }

  ctx.phase = "probe";
  const programs = await probePrograms(ctx.rpc, release);
  evidence.programs = programs;
  if (release) {
    for (const name of IDL_PROGRAMS) {
      if (programs[name].releaseEqual === false && config.network === "mainnet") {
        throw new ChainGateError(`${name}: the Release .so differs from the live ProgramData`);
      }
    }
  }
  const names = selectedPrograms(ctx);
  const probes = await Promise.all(names.map((name) => probeIdl(ctx.rpc, name, sources[name])));
  evidence.idl = probes.map(idlProbeEvidence);
  for (const probe of probes) {
    ctx.log(`${probe.program}: ${probe.status}${probe.extraAuthority ? ` (extra authority ${probe.extraAuthority})` : ""}`);
    if (map && probe.extraAuthority && probe.extraAuthority !== map.metadataAuthority) {
      ctx.log(`${probe.program}: WARNING extra metadata authority ${probe.extraAuthority} is not in the role map`);
    }
  }
  if (mode === "check") {
    evidence.inSync = probes.every((p) => p.status === "in-sync");
    return "completed";
  }

  // send / prepare-export
  ctx.phase = "plan";
  const expectedUa = mode === "send" ? map!.deployer : map!.squads.vault;
  const signerKey = mode === "send" ? map!.deployer : map!.bufferWriter;
  for (const name of names) {
    if (programs[name].authority !== expectedUa) {
      throw new ChainGateError(
        `${name}: upgrade authority is ${programs[name].authority ?? "none"}; ${mode} needs ${mode === "send" ? "the deployer" : "the vault"}`,
      );
    }
  }
  const signer = config.send
    ? await loadHotSigner(config.keypairPath!, signerKey, mode === "send" ? "deployer" : "bufferWriter")
    : createNoopSigner(signerKey);
  const rentCache = new Map<number, bigint>();
  const rent = async (size: number) => {
    if (!rentCache.has(size)) {
      rentCache.set(size, await ctx.rpc.getMinimumBalanceForRentExemption(BigInt(size), { commitment: "finalized" }).send());
    }
    return rentCache.get(size)!;
  };
  const resumeAddress = env.CHAIN_IDL_RESUME_BUFFER?.trim() || null;
  if (resumeAddress && names.length !== 1) throw new ChainGateError("CHAIN_IDL_RESUME_BUFFER needs CHAIN_IDL_PROGRAM");
  const resumeAccount = resumeAddress ? await fetchRawAccount(ctx.rpc, resumeAddress as Address) : null;
  if (resumeAddress && !resumeAccount) throw new ChainGateError("CHAIN_IDL_RESUME_BUFFER does not exist");

  const plans: IdlPlan[] = [];
  for (const probe of probes) {
    plans.push(
      await planIdl({
        probe,
        signer,
        signerRole: mode === "send" ? "deployer" : "bufferWriter",
        programData: programs[probe.program].programData,
        rent,
        mode,
        vault: map!.squads.vault,
        newBuffer: config.send ? await generateKeyPairSigner() : createNoopSigner(placeholderBuffer(probe.program)),
        resumeBuffer: resumeAccount,
      }),
    );
  }
  // Each program's first transaction depends on nothing earlier in the plan,
  // so the dry run simulates it now; the rest are simulated at send time.
  for (const plan of plans) if (plan.steps.length) plan.steps[0].simulate = "now";
  const steps = plans.flatMap((plan) => plan.steps);
  const placeholders = new Map<string, string>();
  for (const plan of plans) for (const [k, v] of plan.placeholders) placeholders.set(k, v);
  const digest = planDigest({
    network: config.network,
    genesis: config.expectedGenesis,
    roleMapSha256: (evidence.roleMapSha256 as string) ?? null,
    releaseSha256Sums: release?.sha256Sums.fileSha256 ?? null,
    steps,
    placeholders,
  });
  evidence.planDigest = digest;
  evidence.plan = steps.map((s) => ({ id: s.id, title: s.title, idempotency: s.idempotency, required: s.required }));
  evidence.notes = plans.flatMap((p) => p.notes);
  ctx.log(`plan: ${steps.length} transactions, digest ${digest}`);
  for (const step of steps) ctx.log(`  ${step.id.padEnd(34)} ${step.title}`);
  if (!steps.length) return "completed";
  if (!config.send) {
    const blockhash = (await ctx.rpc.getLatestBlockhash({ commitment: "confirmed" }).send()).value;
    const simulations: Record<string, string> = {};
    for (const step of steps.filter((s) => s.simulate === "now")) {
      const result = await simulateUnsigned(
        ctx.rpc,
        buildMessage({ feePayer: step.signer, ixs: step.ixs, blockhash, cuLimit: 1_400_000, cuPrice: config.cuPrice }),
      );
      simulations[step.id] = result.ok ? `simulated ok, ${result.unitsConsumed ?? "?"} CU` : `SIMULATION FAILED ${summarizeSimulation(result)}`;
      ctx.log(`  ${step.id}: ${simulations[step.id]}`);
    }
    evidence.simulations = simulations;
    if (Object.values(simulations).some((line) => line.startsWith("SIMULATION FAILED"))) {
      throw new ChainPlanError("a transaction that can run now failed simulation; see the plan output");
    }
    ctx.log("dry run: nothing sent. Review the plan, then send with CHAIN_SEND=1 CHAIN_CONFIRM_PLAN=<digest>.");
    return "awaiting";
  }
  if (config.confirmPlan !== digest) throw new ChainPlanError("CHAIN_CONFIRM_PLAN does not match the recomputed plan digest");

  // Snapshot of the inflated pre-state (no overwrite).
  const snapshotDir = env.CHAIN_SNAPSHOT_DIR?.trim();
  for (const probe of probes) {
    if (!probe.onChain) continue;
    if (!snapshotDir) {
      // send replaces the IDL now; prepare-export only stages a buffer.
      if (mode === "send") throw new ChainGateError("CHAIN_SNAPSHOT_DIR is required when an existing IDL is replaced");
      continue;
    }
    const file = path.resolve(snapshotDir, `${probe.program}-idl-pre.json`);
    assertOutputPath(file, ctx.root, "the IDL snapshot");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, probe.onChain, { flag: "wx", mode: 0o600 });
  }

  ctx.phase = "send";
  const journal = ctx.beginSend();
  journal.append({ event: "plan", digest, steps: steps.map((s) => s.id) });
  // The fresh buffer address is journalled before its createAccount is sent,
  // so a crash never loses it (its keypair is never persisted; the same
  // transaction hands the buffer to the signer).
  for (const plan of plans) {
    if (plan.bufferAddress) journal.append({ event: "buffer", address: plan.bufferAddress, status: "planned" });
  }
  const watched = [...new Set(plans.flatMap((p) => p.watched))];
  const records: StepRecord[] = [];
  evidence.steps = records;
  const announced = new Set<string>();
  await executePlan(steps, {
    rpc: ctx.rpc,
    drainRpc: ctx.drainRpc,
    journal,
    cuPrice: config.cuPrice,
    signal: ctx.signal,
    timing: ctx.timing,
    log: ctx.log,
    records,
    probe: async () => {
      const state = await fetchRawAccounts(ctx.rpc, watched);
      for (const plan of plans) {
        if (plan.bufferAddress && state.get(plan.bufferAddress) && !announced.has(plan.bufferAddress)) {
          announced.add(plan.bufferAddress);
          journal.append({ event: "buffer", address: plan.bufferAddress, status: "exists" });
        }
      }
      return state;
    },
  });

  ctx.phase = "verify";
  const after = await Promise.all(names.map((name) => probeIdl(ctx.rpc, name, sources[name])));
  evidence.idlAfter = after.map(idlProbeEvidence);
  if (mode === "send") {
    const failures = after.flatMap(verifyIdl);
    evidence.verifyFailures = failures;
    if (failures.length) throw new ChainPlanError(`IDL verification failed: ${failures.join("; ")}`);
    return "completed";
  }
  const specs = plans.map((p) => p.exportSpec).filter(Boolean);
  const specFile = `${config.output}.idl-export.json`;
  assertOutputPath(specFile, ctx.root, "the IDL export spec");
  fs.writeFileSync(specFile, `${toJson(specs)}\n`, { flag: "wx", mode: 0o600 });
  evidence.exportSpec = path.basename(specFile);
  ctx.log(`export spec written: ${path.basename(specFile)} (use with chain:squads-export op=idl-update)`);
  return "awaiting";
}

/** A fixed, recognisable placeholder address for the dry-run buffer (never a key anyone holds). */
export function placeholderBuffer(program: ProgramName): Address {
  return getAddressDecoder().decode(new Uint8Array(32).fill(program === "asset_registry" ? 0xb1 : 0xb2));
}

