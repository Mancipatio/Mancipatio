// Generates Kit-native TypeScript clients from the Anchor IDLs in `idl/`.
// Run: npm run codegen
import { renderVisitor } from "@codama/renderers-js";
import { rootNodeFromAnchor } from "@codama/nodes-from-anchor";
import { createFromRoot } from "codama";
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const check = process.argv.includes("--check");
const outputRoot = check
  ? mkdtempSync(path.join(tmpdir(), "manci-codegen-"))
  : path.join(root, "lib/generated");

function files(directory, prefix = "") {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const relative = path.join(prefix, entry.name);
      return entry.isDirectory()
        ? files(path.join(directory, entry.name), relative)
        : [relative];
    })
    .sort();
}
try {
  for (const name of ["asset_registry", "transfer_hook"]) {
    const idl = JSON.parse(
      readFileSync(path.join(root, `idl/${name}.json`), "utf-8"),
    );
    const codama = createFromRoot(rootNodeFromAnchor(idl));
    const generated = path.join(outputRoot, name);
    await codama.accept(renderVisitor(generated));
    if (check) {
      const committed = path.join(root, "lib/generated", name);
      const actualFiles = files(generated);
      const expectedFiles = files(committed);
      const different = actualFiles.filter(
        (file) =>
          !expectedFiles.includes(file) ||
          !readFileSync(path.join(generated, file)).equals(
            readFileSync(path.join(committed, file)),
          ),
      );
      const obsolete = expectedFiles.filter(
        (file) => !actualFiles.includes(file),
      );
      if (different.length || obsolete.length) {
        throw new Error(
          `${name} SDK drift. Run npm run codegen and review: ${[...different, ...obsolete].join(", ")}`,
        );
      }
      console.log(
        `${name}: ${actualFiles.length} generated SDK files match the IDL`,
      );
    } else {
      console.log(`generated lib/generated/${name}`);
    }
  }
} finally {
  if (check) rmSync(outputRoot, { recursive: true, force: true });
}
