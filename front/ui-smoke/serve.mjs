// `next start` for the UI smoke (playwright.config.ts webServer):
//   node ui-smoke/serve.mjs <localnet|mainnet> <port>
// It refuses a .next/ that is not the placeholder build of that network, and
// starts the server with the hermetic environment of hermetic-env.mjs rather
// than the shell's: Playwright hands a web server its whole process.env.
import { spawn } from "node:child_process";
import { FRONT, NEXT_BIN, assertSmokeBuild, hermeticEnv, smokeNetwork } from "./hermetic-env.mjs";

let env;
let port;
try {
  const network = smokeNetwork(process.argv[2]);
  port = process.argv[3];
  if (!/^\d+$/.test(port ?? "")) throw new Error(`usage: node ui-smoke/serve.mjs <localnet|mainnet> <port>`);
  assertSmokeBuild(network);
  env = hermeticEnv(network);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
const server = spawn(process.execPath, [NEXT_BIN, "start", "-H", "127.0.0.1", "-p", port], {
  cwd: FRONT,
  stdio: "inherit",
  env,
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => server.kill(signal));
server.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
