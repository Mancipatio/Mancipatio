import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RELEASE_FILES, executableHash, loadRelease, parseSha256Sums } from "@/scripts/chain/lib/release";
import { ChainGateError, sha256Hex } from "@/scripts/chain/lib/safety";
import { releaseDir, root } from "./helpers/chain-world";

const refuse = (fn: () => unknown, pattern: RegExp) => {
  expect(fn).toThrow(ChainGateError);
  expect(fn).toThrow(pattern);
};

/** Rewrites SHA256SUMS over `files` (the workflow's `sha256sum … > SHA256SUMS`). */
function writeSums(dir: string, files = RELEASE_FILES, extra = "") {
  const lines = files.map((file) => `${sha256Hex(fs.readFileSync(path.join(dir, file)))}  ${file}`);
  fs.writeFileSync(path.join(dir, "SHA256SUMS"), `${lines.join("\n")}\n${extra}`);
}

/** The raw `verifiable-programs-<sha>` CI artifact: target/deploy/*.so, no IDL, no SHA256SUMS. */
function artifactDir() {
  const flat = releaseDir();
  const dir = fs.mkdtempSync(path.join(path.dirname(flat), "artifact-"));
  fs.mkdirSync(path.join(dir, "target", "deploy"), { recursive: true });
  for (const name of ["asset_registry", "transfer_hook"]) {
    fs.copyFileSync(path.join(flat, `${name}.so`), path.join(dir, "target", "deploy", `${name}.so`));
  }
  for (const file of ["hashes.txt", "sbf-sha256.txt"]) fs.copyFileSync(path.join(flat, file), path.join(dir, file));
  return dir;
}

describe("loadRelease", () => {
  it("reads a flat Release: SHA256SUMS first, then commit, base image and the solana-verify hashes", () => {
    const release = loadRelease(releaseDir(), { requireSums: true });
    expect(release.layout).toBe("flat");
    expect(release.commit).toBe("a".repeat(40));
    expect(release.baseImage).toBe("solanafoundation/solana-verifiable-build:3.1.13");
    expect(release.sha256Sums.files).toEqual([...RELEASE_FILES].sort());
    expect(release.idl).not.toBeNull();
    // The fixture's hashes.txt holds sha256(.so), which equals the executable
    // hash only when the bytes have no trailing zeros.
    expect(release.verifyHashMatches).toEqual({ asset_registry: true, transfer_hook: true });
    expect(executableHash(new Uint8Array([1, 2, 0, 0]))).toBe(sha256Hex(new Uint8Array([1, 2])));
  });

  it("reads the target/deploy CI artifact (no IDL), which a mainnet run refuses", () => {
    const dir = artifactDir();
    const release = loadRelease(dir, { requireSums: false });
    expect(release.layout).toBe("target-deploy");
    expect(release.idl).toBeNull();
    expect(release.sha256Sums.present).toBe(false);
    refuse(() => loadRelease(dir, { requireSums: true }), /no SHA256SUMS/);
    // SHA256SUMS belongs to the flat layout only.
    fs.writeFileSync(path.join(dir, "SHA256SUMS"), "");
    refuse(() => loadRelease(dir, { requireSums: false }), /belongs to the flat Release layout/);
  });

  it("refuses a .so that does not match sbf-sha256.txt (even with a consistent SHA256SUMS)", () => {
    const dir = releaseDir();
    fs.writeFileSync(path.join(dir, "transfer_hook.so"), new Uint8Array([9, 9, 9]));
    writeSums(dir);
    refuse(() => loadRelease(dir, { requireSums: true }), /transfer_hook.so does not match sbf-sha256.txt/);
  });

  it("refuses a SHA256SUMS that omits a Release file, or has malformed, duplicate or path entries", () => {
    for (const missing of RELEASE_FILES) {
      const dir = releaseDir();
      writeSums(dir, RELEASE_FILES.filter((file) => file !== missing));
      refuse(() => loadRelease(dir, { requireSums: true }), new RegExp(`does not list ${missing.replace(".", "\\.")}`));
    }
    const hash = "0".repeat(64);
    refuse(() => parseSha256Sums(`${hash}  a.so\n${hash}  a.so\n`), /malformed or duplicate/);
    refuse(() => parseSha256Sums(`${hash}  target/deploy/a.so\n`), /malformed or duplicate/);
    refuse(() => parseSha256Sums(`${hash}  ..\\a.so\n`), /malformed or duplicate/);
    refuse(() => parseSha256Sums(`${hash.slice(1)}  a.so\n`), /malformed or duplicate/);
    refuse(() => parseSha256Sums(`${"AB".repeat(32)}  a.so\n`), /malformed or duplicate/);
    expect(parseSha256Sums(`${hash} *a.so\n\n`).get("a.so")).toBe(hash);
    // An extra listed file must also match.
    const dir = releaseDir();
    fs.writeFileSync(path.join(dir, "notes.txt"), "x");
    writeSums(dir, RELEASE_FILES, `${hash}  notes.txt\n`);
    refuse(() => loadRelease(dir, { requireSums: true }), /SHA256SUMS mismatch for notes.txt/);
  });

  it("refuses a flat Release without its IDL files, and invalid provenance files", () => {
    const noIdl = releaseDir();
    fs.rmSync(path.join(noIdl, "SHA256SUMS"));
    fs.rmSync(path.join(noIdl, "asset_registry.json"));
    refuse(() => loadRelease(noIdl, { requireSums: false }), /missing its IDL files/);
    const badHashes = releaseDir();
    fs.writeFileSync(path.join(badHashes, "hashes.txt"), "commit: nope\n");
    writeSums(badHashes);
    refuse(() => loadRelease(badHashes, { requireSums: true }), /hashes.txt is invalid: commit missing/);
    const badIdl = releaseDir({ transfer_hook: new Uint8Array(Buffer.from("{not json")) });
    refuse(() => loadRelease(badIdl, { requireSums: true }), /transfer_hook.json is not valid JSON/);
  });
});

describe("verifiable-build.yml produces exactly what loadRelease reads", () => {
  const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "verifiable-build.yml"), "utf8");

  it("the Release file list (SHA256SUMS, cp, uploaded .so) equals RELEASE_FILES", () => {
    // SHA256SUMS covers *.so *.json hashes.txt sbf-sha256.txt of dist/.
    expect(workflow).toContain("(cd dist && sha256sum *.so *.json hashes.txt sbf-sha256.txt > SHA256SUMS)");
    // dist/*.so comes from the build artifact, dist/*.json from the committed IDLs.
    const uploadedSo = [...workflow.matchAll(/program\/target\/deploy\/([a-z_]+\.so)/g)].map((m) => m[1]);
    const copied = workflow.match(/cp art\/target\/deploy\/\*\.so art\/hashes\.txt art\/sbf-sha256\.txt dist\//);
    expect(copied).not.toBeNull();
    const idlLine = workflow.match(/cp ((?:front\/idl\/[a-z_]+\.json ?)+) dist\//);
    expect(idlLine).not.toBeNull();
    const json = idlLine![1].trim().split(/\s+/).map((file) => path.basename(file));
    const produced = [...new Set(uploadedSo), ...json, "hashes.txt", "sbf-sha256.txt"].sort();
    expect(produced).toEqual([...RELEASE_FILES].sort());
    // Every IDL the Release ships is committed.
    for (const file of json) expect(fs.existsSync(path.join(root, "front", "idl", file))).toBe(true);
  });

  it("only a tag push publishes; manual runs keep the bundle as release-dry-<sha>", () => {
    expect(workflow).toMatch(/tags: \["v\[0-9\]\*"\]/);
    const publish = workflow.slice(workflow.indexOf("\n  publish:"));
    expect(publish).toMatch(/if: github.event_name == 'push' && startsWith\(github.ref, 'refs\/tags\/v'\)/);
    expect(publish).toContain("attestations: write");
    const bundle = workflow.slice(workflow.indexOf("\n  bundle:"), workflow.indexOf("\n  publish:"));
    expect(bundle).toMatch(/permissions:\n\s+contents: read\n/);
    expect(bundle).not.toMatch(/write/);
    expect(bundle).toContain("format('release-dry-{0}', github.sha)");
    expect(workflow.match(/persist-credentials: false/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
