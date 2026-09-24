// Provenance of the candidate binaries the rollout inventory compares against.
// A verifiable-build artifact directory carries `hashes.txt` (source commit,
// base image, solana-verify hashes) and `sbf-sha256.txt` (sha256 of each .so).
// The git HEAD of the checkout that contains the directory says nothing about
// which commit produced the binaries, so the inventory records these instead.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const sha = value => createHash('sha256').update(value).digest('hex');
const COMMIT = /^[0-9a-f]{40}$/;
const HASH = /^[0-9a-f]{64}$/;

/** Parses `hashes.txt` (`key: value` lines). Unknown keys are ignored. */
export function parseHashesTxt(text, programs) {
  const fields = new Map();
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) fields.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  const errors = [];
  const commit = fields.get('commit') ?? null;
  if (!commit || !COMMIT.test(commit)) errors.push('commit missing or not a 40-hex sha');
  /** @type {Record<string, string | null>} */
  const verify_hashes = {};
  for (const name of programs) {
    const value = fields.get(name) ?? null;
    if (!value || !HASH.test(value)) errors.push(`${name}: solana-verify hash missing or not 64-hex`);
    verify_hashes[name] = value && HASH.test(value) ? value : null;
  }
  return {
    file_sha256: sha(text),
    commit: commit && COMMIT.test(commit) ? commit : null,
    base_image: fields.get('base image') ?? null,
    verify_hashes,
    errors,
  };
}

/** Parses `sbf-sha256.txt` (`<sha256>  target/deploy/<name>.so` lines). */
export function parseSbfSha256Txt(text, programs) {
  /** @type {Record<string, string>} */
  const entries = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([0-9a-f]{64})\s+\*?target\/deploy\/([a-z0-9_]+)\.so\s*$/);
    if (match && programs.includes(match[2])) entries[match[2]] = match[1];
  }
  const errors = programs.filter(name => !entries[name]).map(name => `${name}: sha256 missing`);
  return { file_sha256: sha(text), sha256: entries, errors };
}

/** Reads both provenance files from `dir`; a missing file is recorded as absent. */
export function readArtifactProvenance(dir, programs) {
  const read = (file, parse) => {
    const full = path.join(dir, file);
    if (!fs.existsSync(full)) return { present: false };
    return { present: true, ...parse(fs.readFileSync(full, 'utf8'), programs) };
  };
  return { hashes_txt: read('hashes.txt', parseHashesTxt), sbf_sha256_txt: read('sbf-sha256.txt', parseSbfSha256Txt) };
}

/**
 * true / false when `sbf-sha256.txt` lists the program, null when there is
 * nothing to compare (no file, no entry or no candidate binary).
 */
export function candidateMatchesArtifact(candidate, provenance, name) {
  const expected = provenance.sbf_sha256_txt.present ? provenance.sbf_sha256_txt.sha256[name] : undefined;
  if (!expected || !candidate || candidate.missing) return null;
  return candidate.sha256 === expected;
}
