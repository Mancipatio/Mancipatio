import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Pinned toolchain for IDL generation; keep in step with
// program/scripts/install-ci-toolchain.sh.
const toolchain = JSON.parse(
  readFileSync(path.join(root, "idl/program-toolchain.json"), "utf8"),
);
const args = process.argv.slice(2);
const directoryIndex = args.indexOf("--program-dir");
const workingTree = args.includes("--working-tree");
const programDir = path.resolve(
  directoryIndex < 0
    ? path.join(root, "../program")
    : args[directoryIndex + 1],
);

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: programDir,
    encoding: "utf8",
    ...options,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${command} failed${result.error ? `: ${result.error.message}` : ` (exit ${result.status})`}`,
    );
  }
  return result.stdout?.trim();
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

if (workingTree) {
  if (process.env.CI)
    throw new Error("CI may not skip the committed program source check.");
  console.log(
    "Checking the local program working tree, including uncommitted changes.",
  );
} else {
  // The program and this client live in the same repository, so the release
  // revision is simply the commit that is checked out. Only require that the
  // program source under test is exactly the committed one.
  run("git", [
    "diff",
    "--quiet",
    "HEAD",
    "--",
    "programs",
    "Cargo.toml",
    "Cargo.lock",
    "Anchor.toml",
    "rust-toolchain.toml",
  ]);
}
if (run("anchor", ["--version"]) !== `anchor-cli ${toolchain.anchorVersion}`) {
  throw new Error(
    `IDL verification requires Anchor CLI ${toolchain.anchorVersion}.`,
  );
}
const temp = mkdtempSync(path.join(tmpdir(), "manci-idl-check-"));
try {
  for (const name of ["asset_registry", "transfer_hook"]) {
    const output = path.join(temp, `${name}.json`);
    run(
      "anchor",
      ["idl", "build", "-p", name, "-o", output, "--", "--locked", "--lib"],
      {
        stdio: "inherit",
        env: {
          ...process.env,
          RUSTUP_TOOLCHAIN: toolchain.rustVersion,
          CARGO_TARGET_DIR: path.join(temp, "target"),
        },
      },
    );
    const fresh = canonical(JSON.parse(readFileSync(output, "utf8")));
    const checkedIn = canonical(
      JSON.parse(readFileSync(path.join(root, `idl/${name}.json`), "utf8")),
    );
    if (JSON.stringify(fresh) !== JSON.stringify(checkedIn)) {
      throw new Error(
        `${name} IDL drift: regenerate the frontend IDL/SDK from this program source before release.`,
      );
    }
    console.log(`${name}: source IDL matches the frontend snapshot`);
  }
  run(process.execPath, [path.join(root, "codegen.mjs"), "--check"], {
    cwd: root,
    stdio: "inherit",
  });
} finally {
  rmSync(temp, { recursive: true, force: true });
}
