/**
 * Release directory reader (design-3.3 §3.2, §8).
 *
 * Two layouts are accepted:
 * - flat: a downloaded GitHub Release (`*.so`, `*.json` IDLs, hashes.txt,
 *   sbf-sha256.txt, SHA256SUMS);
 * - target/deploy: the raw `verifiable-programs-<sha>` CI artifact
 *   (`target/deploy/*.so`, hashes.txt, sbf-sha256.txt; no IDL, no SHA256SUMS).
 *
 * When SHA256SUMS is present it is verified first; a mainnet run requires it.
 *
 * v1.0.0-rc Releases also carry the incident build (design 8.3 §7.4):
 * `<name>-incident.so` (flat) or `target/deploy-incident/<name>.so`, with
 * `<name>-incident:` lines in hashes.txt and `target/deploy-incident/` lines
 * in sbf-sha256.txt. It is deployed only during an incident; the inventory
 * blocks while it is live. Older Releases have none (`incident: null`).
 */
import fs from "node:fs";
import path from "node:path";
import {
  parseHashesTxt,
  parseSbfSha256Txt,
} from "@/scripts/ops/artifact-provenance.mjs";
import { sbpfVersionOf } from "./network-gates";
import { ChainGateError, IDL_PROGRAMS, sha256Hex, type ProgramName } from "./safety";

export type ReleaseLayout = "flat" | "target-deploy";

export type Release = {
  layout: ReleaseLayout;
  so: Record<ProgramName, Uint8Array>;
  idl: Record<ProgramName, Uint8Array> | null;
  commit: string | null;
  baseImage: string | null;
  /**
   * The `solana-verify build --arch` of the Release: hashes.txt `arch:`
   * (v0.0.0-rc.2 on: "v3"), or "v0" when the line is absent (solana-verify's
   * default; the rc.1 Release). A verify PDA must carry the same `--arch`, or
   * OtterSec's rebuild does not reproduce the hash.
   */
  arch: string;
  verifyHashes: Record<string, string | null>;
  verifyHashMatches: Record<ProgramName, boolean | null>;
  sbfSha256: Record<string, string>;
  sha256Sums: { present: boolean; fileSha256: string | null; files: string[] };
  /** The incident artifacts and their solana-verify hashes, or null (rc.x Releases). */
  incident: { so: Record<ProgramName, Uint8Array>; verifyHashes: Record<ProgramName, string | null> } | null;
};

/** Files a GitHub Release must list in SHA256SUMS (design §8). */
export const RELEASE_FILES = [
  "asset_registry.so",
  "transfer_hook.so",
  "asset_registry.json",
  "transfer_hook.json",
  "hashes.txt",
  "sbf-sha256.txt",
];

/** The incident build of a v1.0.0-rc Release (flat layout); optional for older Releases. */
export const INCIDENT_RELEASE_FILES = ["asset_registry-incident.so", "transfer_hook-incident.so"];

const HEX64 = /^[0-9a-f]{64}$/;

/** `<name>-incident: <hash>` lines of hashes.txt. */
function incidentVerifyHashes(text: string): Record<ProgramName, string | null> {
  const out = {} as Record<ProgramName, string | null>;
  for (const name of IDL_PROGRAMS) {
    const line = text.split(/\r?\n/).find((l) => l.startsWith(`${name}-incident:`));
    const value = line ? line.slice(line.indexOf(":") + 1).trim() : null;
    out[name] = value && HEX64.test(value) ? value : null;
  }
  return out;
}

/** `<sha256>  target/deploy-incident/<name>.so` lines of sbf-sha256.txt. */
function incidentSbfSha256(text: string): Partial<Record<ProgramName, string>> {
  const out: Partial<Record<ProgramName, string>> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([0-9a-f]{64})\s+\*?target\/deploy-incident\/([a-z0-9_]+)\.so\s*$/);
    if (match && (IDL_PROGRAMS as readonly string[]).includes(match[2])) out[match[2] as ProgramName] = match[1];
  }
  return out;
}

export function parseSha256Sums(text: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = line.match(/^([0-9a-f]{64}) [ *](.+)$/);
    if (!match || match[2].includes("/") || match[2].includes("\\") || entries.has(match[2])) {
      throw new ChainGateError("SHA256SUMS has a malformed or duplicate line");
    }
    entries.set(match[2], match[1]);
  }
  return entries;
}

function readRequired(file: string, label: string): Uint8Array {
  if (!fs.existsSync(file)) throw new ChainGateError(`The Release is missing ${label}`);
  return new Uint8Array(fs.readFileSync(file));
}

export function loadRelease(dir: string, options: { requireSums: boolean }): Release {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new ChainGateError("CHAIN_RELEASE_DIR is not a directory (path withheld)");
  }
  const flat = fs.existsSync(path.join(dir, "asset_registry.so"));
  const layout: ReleaseLayout = flat ? "flat" : "target-deploy";
  const soDir = flat ? dir : path.join(dir, "target", "deploy");

  const sumsFile = path.join(dir, "SHA256SUMS");
  const sumsPresent = fs.existsSync(sumsFile);
  if (options.requireSums && !sumsPresent) {
    throw new ChainGateError("The Release has no SHA256SUMS; a mainnet run needs a GitHub Release directory");
  }
  let sumsSha: string | null = null;
  let listed: string[] = [];
  if (sumsPresent) {
    if (!flat) throw new ChainGateError("SHA256SUMS belongs to the flat Release layout");
    const text = fs.readFileSync(sumsFile, "utf8");
    sumsSha = sha256Hex(text);
    const entries = parseSha256Sums(text);
    for (const required of RELEASE_FILES) {
      if (!entries.has(required)) throw new ChainGateError(`SHA256SUMS does not list ${required}`);
    }
    for (const [name, expected] of entries) {
      const actual = sha256Hex(readRequired(path.join(dir, name), name));
      if (actual !== expected) throw new ChainGateError(`SHA256SUMS mismatch for ${name}`);
    }
    listed = [...entries.keys()].sort();
  }

  const so = Object.fromEntries(
    IDL_PROGRAMS.map((name) => [name, readRequired(path.join(soDir, `${name}.so`), `${name}.so`)]),
  ) as Record<ProgramName, Uint8Array>;
  const idlPresent = IDL_PROGRAMS.every((name) => fs.existsSync(path.join(dir, `${name}.json`)));
  const idl = idlPresent
    ? (Object.fromEntries(
        IDL_PROGRAMS.map((name) => [name, readRequired(path.join(dir, `${name}.json`), `${name}.json`)]),
      ) as Record<ProgramName, Uint8Array>)
    : null;
  if (flat && !idl) throw new ChainGateError("The Release is missing its IDL files");

  const hashesText = Buffer.from(readRequired(path.join(dir, "hashes.txt"), "hashes.txt")).toString("utf8");
  const hashes = parseHashesTxt(hashesText, [...IDL_PROGRAMS]);
  if (hashes.errors.length) throw new ChainGateError(`The Release hashes.txt is invalid: ${hashes.errors.join("; ")}`);
  const arch = hashes.arch ?? "v0";
  // The recorded arch must be the one the .so files were built for (ELF
  // e_flags), since it becomes the verify PDA's --arch.
  for (const name of IDL_PROGRAMS) {
    const info = sbpfVersionOf(name, so[name]);
    if (info.version !== null && `v${info.version}` !== arch) {
      throw new ChainGateError(
        `The Release hashes.txt says arch ${arch}${hashes.arch ? "" : " (no arch line)"}, but ${name}.so is SBPF v${info.version} (e_flags ${info.eFlags})`,
      );
    }
  }
  const sbfText = Buffer.from(readRequired(path.join(dir, "sbf-sha256.txt"), "sbf-sha256.txt")).toString("utf8");
  const sbf = parseSbfSha256Txt(sbfText, [...IDL_PROGRAMS]);
  if (sbf.errors.length) throw new ChainGateError(`The Release sbf-sha256.txt is invalid: ${sbf.errors.join("; ")}`);
  for (const name of IDL_PROGRAMS) {
    if (sbf.sha256[name] !== sha256Hex(so[name])) {
      throw new ChainGateError(`${name}.so does not match sbf-sha256.txt`);
    }
  }
  // The incident build: all or nothing, bound by sbf-sha256.txt like the release bytes.
  const incidentPaths = IDL_PROGRAMS.map((name) =>
    flat ? path.join(dir, `${name}-incident.so`) : path.join(dir, "target", "deploy-incident", `${name}.so`),
  );
  const incidentPresent = incidentPaths.filter((file) => fs.existsSync(file)).length;
  let incident: Release["incident"] = null;
  if (incidentPresent) {
    if (incidentPresent !== IDL_PROGRAMS.length) throw new ChainGateError("The Release has only some of its incident artifacts");
    const incidentSo = Object.fromEntries(
      IDL_PROGRAMS.map((name, i) => [name, readRequired(incidentPaths[i], `${name}-incident.so`)]),
    ) as Record<ProgramName, Uint8Array>;
    const recorded = incidentSbfSha256(sbfText);
    for (const name of IDL_PROGRAMS) {
      if (recorded[name] !== sha256Hex(incidentSo[name])) {
        throw new ChainGateError(`${name}-incident.so does not match sbf-sha256.txt`);
      }
      if (sha256Hex(incidentSo[name]) === sha256Hex(so[name])) {
        throw new ChainGateError(`${name}-incident.so equals the release ${name}.so`);
      }
    }
    incident = { so: incidentSo, verifyHashes: incidentVerifyHashes(hashesText) };
  }
  // Recorded, not enforced: sbf-sha256.txt already binds the .so bytes, and
  // the solana-verify hash definition (sha256 without trailing zeros) is only
  // re-checked here as evidence.
  const verifyHashMatches = Object.fromEntries(
    IDL_PROGRAMS.map((name) => {
      const verify = hashes.verify_hashes[name];
      return [name, verify ? verify === executableHash(so[name]) : null];
    }),
  ) as Record<ProgramName, boolean | null>;
  if (idl) {
    for (const name of IDL_PROGRAMS) {
      let parsed: { address?: unknown };
      try {
        parsed = JSON.parse(Buffer.from(idl[name]).toString("utf8"));
      } catch {
        throw new ChainGateError(`The Release ${name}.json is not valid JSON`);
      }
      if (typeof parsed.address !== "string") throw new ChainGateError(`The Release ${name}.json has no address`);
    }
  }
  return {
    layout,
    so,
    idl,
    commit: hashes.commit,
    baseImage: hashes.base_image,
    arch,
    verifyHashes: hashes.verify_hashes,
    verifyHashMatches,
    sbfSha256: sbf.sha256,
    sha256Sums: { present: sumsPresent, fileSha256: sumsSha, files: listed },
    incident,
  };
}

/** solana-verify's executable hash: sha256 of the bytes with trailing zeros removed. */
export function executableHash(bytes: Uint8Array): string {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  return sha256Hex(bytes.subarray(0, end));
}

/** The `address` field of an IDL file. */
export function idlAddress(bytes: Uint8Array): string | null {
  try {
    const parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as { address?: unknown };
    return typeof parsed.address === "string" ? parsed.address : null;
  } catch {
    return null;
  }
}

/** Evidence view of a Release (no local path). */
export function releaseEvidence(release: Release | null) {
  if (!release) return null;
  return {
    layout: release.layout,
    commit: release.commit,
    baseImage: release.baseImage,
    arch: release.arch,
    verifyHashes: release.verifyHashes,
    verifyHashMatches: release.verifyHashMatches,
    soSha256: Object.fromEntries(IDL_PROGRAMS.map((name) => [name, sha256Hex(release.so[name])])),
    idlSha256: release.idl
      ? Object.fromEntries(IDL_PROGRAMS.map((name) => [name, sha256Hex(release.idl![name])]))
      : null,
    sha256Sums: release.sha256Sums,
    incidentSoSha256: release.incident
      ? Object.fromEntries(IDL_PROGRAMS.map((name) => [name, sha256Hex(release.incident!.so[name])]))
      : null,
    incidentVerifyHashes: release.incident?.verifyHashes ?? null,
  };
}
