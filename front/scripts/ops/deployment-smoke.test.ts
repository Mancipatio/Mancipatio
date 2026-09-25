import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { getAddressDecoder } from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";
import { networkLabel } from "@/lib/network";
import { siwsMessage, type SiwsPayload } from "@/lib/siws-client";
import { otherNetwork, smokeTarget } from "./live-targets";

// No existing wallet or Solana asset mutation is used. The worker may update
// verified DB records. This key lives only in memory and has no funds/roles.
//
// MANCIPATIO_LIVE_SMOKE=<devnet|mainnet> picks the target (mainnet also needs
// MANCI_ALLOW_MAINNET=1). The origin is that target's siteOrigin in
// scripts/ops/targets.json; SMOKE_ORIGIN may point at a preview instead, but
// never at another target's origin. Every network expectation below follows
// the selected target.
let network: "devnet" | "mainnet" = "devnet";
let origin = "";
const ephemeral = generateKeyPairSync("ed25519");
const wallet = getAddressDecoder().decode(
  ephemeral.publicKey.export({ format: "der", type: "spki" }).subarray(-32),
);
function envelope(action: string, override: Partial<SiwsPayload> = {}) {
  const payload: SiwsPayload = {
    v: 2,
    origin,
    network,
    action,
    wallet,
    ts: new Date().toISOString(),
    nonce: randomUUID(),
    params: {},
    ...override,
  };
  return {
    payload,
    signature: sign(
      null,
      Buffer.from(siwsMessage(payload)),
      ephemeral.privateKey,
    ).toString("base64"),
    publicKey: wallet,
  };
}
async function post(path: string, body: unknown) {
  return fetch(origin + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(55_000),
    redirect: "error",
  });
}
beforeAll(async () => {
  // Throws before any request without an explicit, configured target.
  ({ network, origin } = smokeTarget(process.env));
  const response = await fetch(origin, { signal: AbortSignal.timeout(15_000) });
  expect(response.status).toBe(200);
  // Stop if this deployment serves a different network than the target.
  const page = await response.text();
  expect(page).toContain(networkLabel(network));
  // The build's network, as the server reports it (page markup changes with the layout).
  const health = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(15_000), redirect: "error" });
  expect(health.status).toBe(200);
  expect(((await health.json()) as { network?: string }).network).toBe(network);
});

describe("deployed release: public access and SIWS boundaries", () => {
  it("serves the new pilot documentation", async () => {
    const response = await fetch(origin + "/docs/pilot", {
      signal: AbortSignal.timeout(15_000),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Run a controlled pilot");
  });
  it("reads the public published-profile projection", async () => {
    const response = await post("/api/profiles/public", {});
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
  });
  it("executes the migrated aggregate function", async () => {
    const response = await post("/api/launchpad/commitment-aggregate", {
      sale_pubkey: wallet,
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.data).toMatchObject({ pledged: "0", settled: "0", backers: 0 });
  });
  it("rejects an unsigned private reader", async () => {
    expect((await post("/api/clients/me", {})).status).toBe(400);
  });
  it("accepts a real disposable signature then rejects replay of its nonce", async () => {
    const body = envelope("clients.me");
    const first = await post("/api/clients/me", body);
    expect(first.status).toBe(200);
    const result = await first.json();
    expect(result.ok).toBe(true);
    expect(result.data.client).toBeNull();
    const replay = await post("/api/clients/me", body);
    expect(replay.status).toBe(401);
    expect((await replay.json()).error).toMatch(/Nonce already used/);
  });
  it("rejects a signature for a different origin", async () => {
    const response = await post(
      "/api/clients/me",
      envelope("clients.me", { origin: "https://invalid.example" }),
    );
    expect(response.status).toBe(401);
  });
  it("rejects a signature for a different network", async () => {
    const response = await post(
      "/api/clients/me",
      envelope("clients.me", { network: otherNetwork(network) }),
    );
    expect(response.status).toBe(401);
  });
  it("denies the admin reader to the unprivileged disposable wallet", async () => {
    const response = await post("/api/audit/list", envelope("audit.list"));
    expect(response.status).toBe(403);
  });
  it("requires the configured worker credential", async () => {
    expect((await post("/api/internal/retry?limit=1", {})).status).toBe(401);
  });
  it("executes a bounded authenticated worker run", async () => {
    const secretFile = process.env.MANCIPATIO_RETRY_SECRET_FILE;
    if (!secretFile)
      throw new Error(
        "MANCIPATIO_RETRY_SECRET_FILE is required; never pass a secret value in the command",
      );
    const line = readFileSync(secretFile, "utf8").trim();
    const secret = line.startsWith("RETRY_WORKER_SECRET=")
      ? line.slice("RETRY_WORKER_SECRET=".length)
      : "";
    if (!/^[A-Za-z0-9_-]{32,}$/.test(secret))
      throw new Error("Invalid worker credential file");
    const response = await fetch(origin + "/api/internal/retry?limit=1", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: "{}",
      signal: AbortSignal.timeout(55_000),
      redirect: "error",
    });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.ok).toBe(true);
    expect(["processed", "busy"]).toContain(result.data.status);
    expect(result.data.network).toBe(network);
  });
});
