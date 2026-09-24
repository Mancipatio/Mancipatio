import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
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
    // SHA256SUMS covers *.so *.json hashes.txt sbf-sha256.txt of dist/
    // (`--`, not `./*.so`: SHA256SUMS lines must stay bare file names).
    expect(workflow).toContain("(cd dist && sha256sum -- *.so *.json hashes.txt sbf-sha256.txt > SHA256SUMS)");
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

/**
 * Runs the workflow's own shell steps (extracted from verifiable-build.yml,
 * not copied) on a synthetic runner workspace: the build job's sbf-sha256 and
 * hashes.txt lines, the upload/download layout of `verifiable-programs-<sha>`,
 * the bundle job's "Assemble the Release bundle" and the publish job's
 * "Re-check the bundle", then loadRelease(dist, {requireSums: true}) on the
 * result. `solana-verify` is a PATH shim (sha256 without trailing zeros, the
 * definition executableHash() re-checks). The real runner, the artifact
 * transfer and the Release upload stay a merge gate (runbook section 0).
 */
describe("verifiable-build.yml shell steps, executed locally", () => {
  const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "verifiable-build.yml"), "utf8");
  const lines = workflow.split("\n");
  const indentOf = (line: string) => line.length - line.trimStart().length;
  const hasTools = ["bash", "sha256sum", "tee", "grep", "cp"].every(
    (tool) => spawnSync("bash", ["-c", `command -v ${tool}`], { encoding: "utf8" }).status === 0,
  );

  /** The `run:` script of the step named `name` (block or single-line scalar). */
  function stepRun(name: string): string {
    const at = lines.findIndex((line) => line.trim() === `- name: ${name}`);
    expect(at, `step "${name}"`).toBeGreaterThanOrEqual(0);
    const stepIndent = indentOf(lines[at]);
    for (let i = at + 1; i < lines.length && (lines[i].trim() === "" || indentOf(lines[i]) > stepIndent); i++) {
      const match = lines[i].match(/^(\s*)run:\s*(.*)$/);
      if (!match) continue;
      if (match[2] !== "|") return match[2];
      const body: string[] = [];
      for (let j = i + 1; j < lines.length && (lines[j].trim() === "" || indentOf(lines[j]) > match[1].length); j++) body.push(lines[j]);
      const pad = Math.min(...body.filter((line) => line.trim()).map(indentOf));
      return body.map((line) => line.slice(pad)).join("\n").trimEnd() + "\n";
    }
    throw new Error(`step "${name}" has no run`);
  }

  /** The `path:` list of the build job's upload-artifact step. */
  function uploadedPaths(): string[] {
    const at = lines.findIndex((line) => line.includes("name: verifiable-programs-${{ github.sha }}"));
    const start = lines.findIndex((line, i) => i > at && line.trim() === "path: |");
    const out: string[] = [];
    for (let i = start + 1; i < lines.length && indentOf(lines[i]) > indentOf(lines[start]); i++) out.push(lines[i].trim());
    return out;
  }

  function sh(script: string, cwd: string, env: Record<string, string>) {
    return spawnSync("bash", ["-e", "-c", script], { cwd, env: { ...process.env, ...env }, encoding: "utf8" });
  }

  const baseImage = workflow.match(/^\s+BASE_IMAGE: (\S+)$/m)![1];
  const commit = "c".repeat(40);

  /** A runner workspace after the build job and the bundle job's download. */
  function workspace(so: Record<"asset_registry" | "transfer_hook", Uint8Array>) {
    const ws = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "runner-"));
    const bin = path.join(ws, ".bin");
    fs.mkdirSync(bin);
    const shim = path.join(bin, "solana-verify");
    fs.writeFileSync(
      shim,
      `#!${process.execPath}\n` +
        `const [cmd, file] = process.argv.slice(2);\n` +
        `if (cmd !== "get-executable-hash") process.exit(2);\n` +
        `let b = require("fs").readFileSync(file); let e = b.length; while (e > 0 && b[e - 1] === 0) e--;\n` +
        `console.log(require("crypto").createHash("sha256").update(b.subarray(0, e)).digest("hex"));\n`,
    );
    fs.chmodSync(shim, 0o755);
    const env = { PATH: `${bin}:${process.env.PATH}`, BASE_IMAGE: baseImage, GITHUB_SHA: commit };
    const program = path.join(ws, "program");
    fs.mkdirSync(path.join(program, "target", "deploy"), { recursive: true });
    for (const name of ["asset_registry", "transfer_hook"] as const) {
      fs.writeFileSync(path.join(program, "target", "deploy", `${name}.so`), so[name]);
    }
    // Build job (working-directory: program): the sbf-sha256 line of the
    // test step (cargo test itself is program-ci's job) and "Executable hashes".
    const sbfLine = stepRun("Test the exact reproducible release artifacts")
      .split("\n")
      .find((line) => line.startsWith("sha256sum target/deploy/"))!;
    expect(sh(sbfLine, program, env).status).toBe(0);
    const hashes = sh(stepRun("Executable hashes"), program, env);
    expect(hashes.stderr).toBe("");
    expect(hashes.status).toBe(0);
    // upload-artifact roots a multi-path upload at the paths' common
    // ancestor; download-artifact unpacks it into `art`.
    const uploaded = uploadedPaths();
    expect(uploaded.length).toBe(4);
    const parts = uploaded.map((p) => p.split("/"));
    let common = 0;
    while (parts.every((p) => p.length > common + 1 && p[common] === parts[0][common])) common++;
    for (const p of parts) {
      const dest = path.join(ws, "art", ...p.slice(common));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(ws, ...p), dest);
    }
    fs.mkdirSync(path.join(ws, "front", "idl"), { recursive: true });
    for (const name of ["asset_registry", "transfer_hook"]) {
      fs.copyFileSync(path.join(root, "front", "idl", `${name}.json`), path.join(ws, "front", "idl", `${name}.json`));
    }
    return { ws, env };
  }

  it.skipIf(!hasTools)("the assembled bundle passes the publish re-check and loads as a mainnet Release", () => {
    // Trailing zeros: the solana-verify hash differs from sha256(.so).
    const so = { asset_registry: new Uint8Array([1, 2, 3, 0, 0]), transfer_hook: new Uint8Array([4, 5, 6, 0]) };
    const { ws, env } = workspace(so);
    // The raw CI artifact is the target/deploy layout the CLI also reads.
    const artifact = loadRelease(path.join(ws, "art"), { requireSums: false });
    expect(artifact.layout).toBe("target-deploy");
    expect(artifact.commit).toBe(commit);

    const assembled = sh(stepRun("Assemble the Release bundle"), ws, env);
    expect(assembled.stderr).toBe("");
    expect(assembled.status).toBe(0);
    // `path: dist` uploads the directory's contents; publish downloads into dist.
    expect(sh(stepRun("Re-check the bundle"), ws, env).status).toBe(0);

    const release = loadRelease(path.join(ws, "dist"), { requireSums: true });
    expect(release.layout).toBe("flat");
    expect(release.commit).toBe(commit);
    expect(release.baseImage).toBe(baseImage);
    expect(release.sha256Sums.files).toEqual([...RELEASE_FILES].sort());
    expect(release.verifyHashMatches).toEqual({ asset_registry: true, transfer_hook: true });
    expect(release.verifyHashes.asset_registry).not.toBe(sha256Hex(so.asset_registry));
    expect(fs.readdirSync(path.join(ws, "dist")).sort()).toEqual([...RELEASE_FILES, "SHA256SUMS"].sort());
  });

  it.skipIf(!hasTools)("the bundle step fails on a .so that changed after the build, or on another commit", () => {
    const so = { asset_registry: new Uint8Array([1, 2, 3]), transfer_hook: new Uint8Array([4, 5, 6]) };
    const swapped = workspace(so);
    fs.writeFileSync(path.join(swapped.ws, "art", "target", "deploy", "transfer_hook.so"), new Uint8Array([7]));
    const refused = sh(stepRun("Assemble the Release bundle"), swapped.ws, swapped.env);
    expect(refused.status).not.toBe(0);
    expect(fs.existsSync(path.join(swapped.ws, "dist", "SHA256SUMS"))).toBe(false);

    const other = workspace(so);
    const wrongCommit = sh(stepRun("Assemble the Release bundle"), other.ws, { ...other.env, GITHUB_SHA: "d".repeat(40) });
    expect(wrongCommit.status).not.toBe(0);
    expect(fs.existsSync(path.join(other.ws, "dist", "SHA256SUMS"))).toBe(false);

    // A bundle file changed between the jobs fails the publish re-check.
    const tampered = workspace(so);
    expect(sh(stepRun("Assemble the Release bundle"), tampered.ws, tampered.env).status).toBe(0);
    fs.appendFileSync(path.join(tampered.ws, "dist", "asset_registry.json"), " ");
    expect(sh(stepRun("Re-check the bundle"), tampered.ws, tampered.env).status).not.toBe(0);
  });
});
