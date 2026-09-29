// The guard itself (support/test.ts): traffic from the page to a host that is
// neither the server under test nor a mock, over HTTP or a WebSocket, never
// connects and is reported.
import { expect, test } from "./support/test";

const ELSEWHERE = "elsewhere.ui-smoke.invalid";

test("the guard refuses and reports HTTP and WebSocket traffic to another host", async ({ page, guard }) => {
  guard.allowConsole(new RegExp(ELSEWHERE.replaceAll(".", "\\.")));
  await page.goto("/robots.txt");
  const outcome = await page.evaluate(async (host) => {
    const http = await fetch(`https://${host}/probe`).then(
      () => "answered",
      () => "refused",
    );
    const ws = await new Promise<string>((resolve) => {
      const socket = new WebSocket(`wss://${host}/socket`);
      socket.onmessage = () => resolve("answered");
      socket.onclose = (event) => resolve(`closed ${event.code}`);
    });
    return { http, ws };
  }, ELSEWHERE);

  expect(outcome).toEqual({ http: "refused", ws: "closed 1008" });
  // Reported, then taken out of the record so the guard's own check passes.
  expect(guard.externalRequests.splice(0)).toEqual([`https://${ELSEWHERE}/probe`, `wss://${ELSEWHERE}/socket`]);
});
