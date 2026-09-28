// The mock wallet and the test keypair live in ui-smoke/ only: the production
// build under test must not carry them (no app module may import ui-smoke/).
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { MOCK_WALLET_NAME } from "./support/mock-wallet";
import { expect, test } from "@playwright/test";

const NEXT = path.resolve(__dirname, "../.next");

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? files(full) : /\.(js|html|rsc|json)$/.test(entry.name) ? [full] : [];
  });
}

test("the production build carries no smoke-test code", () => {
  const output = [...files(path.join(NEXT, "static")), ...files(path.join(NEXT, "server", "app"))];
  expect(output.length).toBeGreaterThan(100);
  const markers = [MOCK_WALLET_NAME, "manci-ui-smoke:", "__uiSmokeWallet"];
  const hits = output.filter((file) => {
    const text = readFileSync(file, "utf8");
    return markers.some((marker) => text.includes(marker));
  });
  expect(hits.map((file) => path.relative(NEXT, file))).toEqual([]);
});
