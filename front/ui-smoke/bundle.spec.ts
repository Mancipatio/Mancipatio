// The mock wallet and the test keypair live in ui-smoke/ only: the production
// build under test must not carry them (no app module may import ui-smoke/;
// eslint.config.mjs refuses such an import). The whole build output is read,
// not only the client chunks: with Turbopack the server code is in
// .next/server/chunks (the files under server/app are loaders), plus the
// proxy and instrumentation bundles. Only .next/cache is left out.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { MOCK_WALLET_NAME } from "./support/mock-wallet";
import { expect, test } from "@playwright/test";

const NEXT = path.resolve(__dirname, "../.next");

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return full === path.join(NEXT, "cache") ? [] : files(full);
    return /\.(c?m?js|html|rsc|json|body|meta)$/.test(entry.name) ? [full] : [];
  });
}

test("the production build carries no smoke-test code", () => {
  const output = files(NEXT);
  expect(output.length).toBeGreaterThan(100);
  expect(output.some((file) => file.startsWith(path.join(NEXT, "server", "chunks")))).toBe(true);
  const markers = [MOCK_WALLET_NAME, "manci-ui-smoke:", "__uiSmokeWallet"];
  const hits = output.filter((file) => {
    const text = readFileSync(file, "utf8");
    return markers.some((marker) => text.includes(marker));
  });
  expect(hits.map((file) => path.relative(NEXT, file))).toEqual([]);
});
