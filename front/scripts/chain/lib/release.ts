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
 */
import fs from "node:fs";
import path from "node:path";
import {
  parseHashesTxt,
  parseSbfSha256Txt,
} from "@/scripts/ops/artifact-provenance.mjs";
import { ChainGateError, IDL_PROGRAMS, sha256Hex, type ProgramName } from "./safety";

export type ReleaseLayout = "flat" | "target-deploy";

export type Release = {
  layout: ReleaseLayout;
  so: Record<ProgramName, Uint8Array>;
  idl: Record<ProgramName, Uint8Array> | null;
  commit: string | null;
  baseImage: string | null;
  verifyHashes: Record<string, string | null>;
  verifyHashMatches: Record<ProgramName, boolean | null>;
  sbfSha256: Record<string, string>;
  sha256Sums: { present: boolean; fileSha256: string | null; files: string[] };
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
  const sbfText = Buffer.from(readRequired(path.join(dir, "sbf-sha256.txt"), "sbf-sha256.txt")).toString("utf8");
  const sbf = parseSbfSha256Txt(sbfText, [...IDL_PROGRAMS]);
  if (sbf.errors.length) throw new ChainGateError(`The Release sbf-sha256.txt is invalid: ${sbf.errors.join("; ")}`);
  for (const name of IDL_PROGRAMS) {
    if (sbf.sha256[name] !== sha256Hex(so[name])) {
      throw new ChainGateError(`${name}.so does not match sbf-sha256.txt`);
    }
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
    verifyHashes: hashes.verify_hashes,
    verifyHashMatches,
    sbfSha256: sbf.sha256,
    sha256Sums: { present: sumsPresent, fileSha256: sumsSha, files: listed },
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
    verifyHashes: release.verifyHashes,
    verifyHashMatches: release.verifyHashMatches,
    soSha256: Object.fromEntries(IDL_PROGRAMS.map((name) => [name, sha256Hex(release.so[name])])),
    idlSha256: release.idl
      ? Object.fromEntries(IDL_PROGRAMS.map((name) => [name, sha256Hex(release.idl![name])]))
      : null,
    sha256Sums: release.sha256Sums,
  };
}
