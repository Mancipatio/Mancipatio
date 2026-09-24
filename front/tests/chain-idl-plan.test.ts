import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { runTool } from "@/scripts/chain/lib/context";
import {
  PROGRAM_IDS,
  classifyIdl,
  idlTool,
  resolveIdlSources,
  verifyIdl,
  type IdlProbe,
} from "@/scripts/chain/lib/idl-plan";
import { readJournal } from "@/scripts/chain/lib/journal";
import {
  PM_HEADER_LENGTH,
  PM_WRITE_CHUNK,
  compressIdl,
  decodePmBufferAccount,
  findCanonicalMetadataPda,
} from "@/scripts/chain/lib/program-metadata";
import { loadRelease } from "@/scripts/chain/lib/release";
import { ChainGateError, sha256Hex, type ChainEnv } from "@/scripts/chain/lib/safety";
import { squadsExportTool } from "@/scripts/chain/lib/squads-export";
import { HOOK, REGISTRY, instantTiming, key } from "./helpers/chain-fake";
import { deps, env, localIdl, releaseDir, root, seedIdl, sendEnv, world, type World } from "./helpers/chain-world";

const hookIdl = localIdl("transfer_hook");
const registryIdl = localIdl("asset_registry");

async function dry(w: World, extra: ChainEnv) {
  return runTool("idl", env(w, extra), idlTool, deps(w));
}

async function send(w: World, extra: ChainEnv, role: "deployer" | "bufferWriter" = "deployer", depsOverride = deps(w)) {
  const plan = await dry(w, extra);
  expect(plan.error ?? null).toBeNull();
  return runTool("idl", sendEnv(w, plan.planDigest as string, extra, role), idlTool, depsOverride);
}

const statuses = (evidence: Record<string, unknown>, field = "idl") =>
  Object.fromEntries((evidence[field] as { program: string; status: string }[]).map((p) => [p.program, p.status]));

describe("chain:idl check", () => {
  it("reports init on a fresh chain and in-sync after the send", async () => {
    const w = await world();
    const before = await dry(w, {});
    expect(statuses(before)).toEqual({ transfer_hook: "init", asset_registry: "init" });
    expect(before.inSync).toBe(false);

    const plan = await dry(w, { CHAIN_IDL_MODE: "send" });
    const steps = (plan.plan as { id: string }[]).map((s) => s.id);
    const hookWrites = Math.ceil(compressIdl(hookIdl).length / PM_WRITE_CHUNK);
    const registryWrites = Math.ceil(compressIdl(registryIdl).length / PM_WRITE_CHUNK);
    expect(steps.filter((id) => id.startsWith("transfer_hook:write:"))).toHaveLength(hookWrites);
    expect(steps.filter((id) => id.startsWith("asset_registry:write:"))).toHaveLength(registryWrites);
    expect(steps.filter((id) => id.startsWith("transfer_hook:extend"))).toEqual([]);
    expect(steps.filter((id) => id.startsWith("asset_registry:extend")).length).toBe(Math.ceil(compressIdl(registryIdl).length / 10_240));
    expect(steps.slice(0, 2)).toEqual(["transfer_hook:fund", "transfer_hook:allocate"]);
    expect(steps).toContain("asset_registry:initialize");
    expect(plan.status).toBe("awaiting");
    // Each program's first transaction is simulated in the dry run.
    expect(plan.simulations).toEqual({
      "transfer_hook:fund": expect.stringMatching(/simulated ok/),
      "asset_registry:fund": expect.stringMatching(/simulated ok/),
    });
    expect(w.chain.calls).not.toContain("sendTransaction");

    const sent = await send(w, { CHAIN_IDL_MODE: "send" });
    expect(sent.error ?? null).toBeNull();
    expect(sent.status).toBe("completed");
    expect(sent.verifyFailures).toEqual([]);
    const after = await dry(w, {});
    expect(statuses(after)).toEqual({ transfer_hook: "in-sync", asset_registry: "in-sync" });
    expect(after.inSync).toBe(true);
    const evidence = (after.idl as { program: string; onChainSha256: string; trimmed: boolean }[]).find((p) => p.program === "asset_registry")!;
    expect(evidence.onChainSha256).toBe(sha256Hex(registryIdl));
    expect(evidence.trimmed).toBe(true);
  });

  it("in-sync-canonical when only the formatting differs; send replaces the bytes", async () => {
    const w = await world();
    const pretty = new Uint8Array(Buffer.from(JSON.stringify(JSON.parse(Buffer.from(hookIdl).toString("utf8")), null, 4)));
    await seedIdl(w, HOOK, pretty);
    const check = await dry(w, { CHAIN_IDL_PROGRAM: "transfer_hook" });
    expect(statuses(check)).toEqual({ transfer_hook: "in-sync-canonical" });
    const sent = await send(w, { CHAIN_IDL_MODE: "send", CHAIN_IDL_PROGRAM: "transfer_hook", CHAIN_SNAPSHOT_DIR: path.join(w.dir, "snap") });
    expect(sent.error ?? null).toBeNull();
    expect(statuses(sent, "idlAfter")).toEqual({ transfer_hook: "in-sync" });
    // The inflated pre-state was snapshotted, never overwritten.
    const snapshot = fs.readFileSync(path.join(w.dir, "snap", "transfer_hook-idl-pre.json"));
    expect(snapshot.equals(Buffer.from(pretty))).toBe(true);
  });

  it("grows an older, smaller IDL: rent top-up, extends, buffer, setData, close", async () => {
    const w = await world();
    const old = new Uint8Array(Buffer.from(JSON.stringify({ address: REGISTRY, metadata: { name: "asset_registry", version: "0.0.1" } })));
    await seedIdl(w, REGISTRY, old);
    const plan = await dry(w, { CHAIN_IDL_MODE: "send", CHAIN_IDL_PROGRAM: "asset_registry" });
    const steps = (plan.plan as { id: string }[]).map((s) => s.id);
    expect(steps[0]).toBe("asset_registry:top-up");
    expect(steps.filter((id) => id.includes(":extend:")).length).toBeGreaterThan(0);
    expect(steps).toEqual(expect.arrayContaining(["asset_registry:buffer", "asset_registry:set-data", "asset_registry:close-buffer"]));
    expect(steps).not.toContain("asset_registry:trim");
    const sent = await send(w, { CHAIN_IDL_MODE: "send", CHAIN_IDL_PROGRAM: "asset_registry", CHAIN_SNAPSHOT_DIR: path.join(w.dir, "snap") });
    expect(sent.error ?? null).toBeNull();
    expect(sent.verifyFailures).toEqual([]);
  });

  it("shrinks a larger IDL and trims the account", async () => {
    const w = await world();
    const parsed = JSON.parse(Buffer.from(hookIdl).toString("utf8"));
    // Incompressible padding, so the stored (zlib) bytes really are larger.
    const bigger = new Uint8Array(Buffer.from(JSON.stringify({ ...parsed, docs: [randomBytes(12_000).toString("base64")] })));
    const metadata = await seedIdl(w, HOOK, bigger);
    const plan = await dry(w, { CHAIN_IDL_MODE: "send", CHAIN_IDL_PROGRAM: "transfer_hook" });
    expect((plan.plan as { id: string }[]).map((s) => s.id)).toContain("transfer_hook:trim");
    const sent = await send(w, { CHAIN_IDL_MODE: "send", CHAIN_IDL_PROGRAM: "transfer_hook", CHAIN_SNAPSHOT_DIR: path.join(w.dir, "snap") });
    expect(sent.error ?? null).toBeNull();
    expect(w.chain.get(metadata)!.data.length).toBe(PM_HEADER_LENGTH + compressIdl(hookIdl).length);
  });

  it("an immutable, different IDL stops the tool", async () => {
    const w = await world();
    await seedIdl(w, HOOK, new Uint8Array(Buffer.from('{"address":"x"}')), { mutable: false });
    expect(statuses(await dry(w, { CHAIN_IDL_PROGRAM: "transfer_hook" }))).toEqual({ transfer_hook: "immutable" });
    const plan = await dry(w, { CHAIN_IDL_MODE: "send", CHAIN_IDL_PROGRAM: "transfer_hook" });
    expect(plan.status).toBe("failed");
    expect(plan.error).toMatch(/immutable; the tool stops/);
  });

  it("reports an extra metadata authority", async () => {
    const w = await world();
    await seedIdl(w, HOOK, hookIdl, { authority: key(60) });
    const lines: string[] = [];
    const check = await runTool("idl", env(w, { CHAIN_IDL_PROGRAM: "transfer_hook" }), idlTool, deps(w, lines));
    expect((check.idl as { extraAuthority: string }[])[0].extraAuthority).toBe(key(60));
    expect(lines.join("\n")).toMatch(/extra metadata authority .* is not in the role map/);
  });

  it("refuses to send when the UA is not the deployer, and prepare-export when it is not the vault", async () => {
    const w = await world();
    await w.chain.deployProgram(HOOK, { authority: key(61), payload: new Uint8Array([1]), capacity: 2048 });
    const sendPlan = await dry(w, { CHAIN_IDL_MODE: "send", CHAIN_IDL_PROGRAM: "transfer_hook" });
    expect(sendPlan.error).toMatch(/send needs the deployer/);
    const exportPlan = await dry(w, { CHAIN_IDL_MODE: "prepare-export", CHAIN_IDL_PROGRAM: "transfer_hook" });
    expect(exportPlan.error).toMatch(/prepare-export needs the vault/);
  });
});

describe("IDL verification", () => {
  it("fails on a foreign header, an untrimmed account or different bytes", async () => {
    const w = await world();
    const metadata = await findCanonicalMetadataPda(HOOK);
    const probe = async (options: Parameters<typeof seedIdl>[3], content = hookIdl): Promise<IdlProbe> => {
      await seedIdl(w, HOOK, content, options);
      return classifyIdl("transfer_hook", metadata, { address: metadata, ...w.chain.get(metadata)!, executable: false }, { label: "head", bytes: hookIdl });
    };
    expect(verifyIdl(await probe({}))).toEqual([]);
    expect(verifyIdl(await probe({ extraBytes: 7 }))).toEqual(["transfer_hook: account is not trimmed"]);
    const differing = await probe({}, new Uint8Array(Buffer.from('{"address":"GBDy"}')));
    expect(differing.status).toBe("update");
    expect(verifyIdl(differing)).toEqual(["transfer_hook: inflated bytes differ from the source"]);
    const corrupt = await probe({ compressed: new Uint8Array([9, 9, 9]) });
    expect(corrupt.status).toBe("foreign-format");
  });
});

describe("IDL source rules (C10)", () => {
  const ctx = (network: "mainnet" | "devnet", source?: string) => ({
    env: source ? { CHAIN_IDL_SOURCE: source } : {},
    config: { network } as never,
    frontDir: path.join(root, "front"),
  });

  it("mainnet needs CHAIN_IDL_SOURCE=release and a Release with matching IDL addresses", async () => {
    expect(() => resolveIdlSources(ctx("mainnet"), null)).toThrow(/needs CHAIN_IDL_SOURCE=release/);
    expect(() => resolveIdlSources(ctx("mainnet", "release"), null)).toThrow(/needs a CHAIN_RELEASE_DIR with IDL files/);
    const release = releaseDir({ transfer_hook: new Uint8Array(Buffer.from(JSON.stringify({ address: REGISTRY }))) });
    expect(() => resolveIdlSources(ctx("mainnet", "release"), loadRelease(release, { requireSums: true }))).toThrow(
      /transfer_hook.json address is not the program ID/,
    );
    const good = loadRelease(releaseDir(), { requireSums: true });
    const sources = resolveIdlSources(ctx("mainnet", "release"), good);
    expect(sources.asset_registry.label).toBe("release");
    // Devnet defaults to HEAD.
    expect(resolveIdlSources(ctx("devnet"), null).transfer_hook.label).toBe("head");
  });

  it("a Release is verified against SHA256SUMS first", async () => {
    const dir = releaseDir();
    fs.appendFileSync(path.join(dir, "transfer_hook.json"), " ");
    expect(() => loadRelease(dir, { requireSums: true })).toThrow(ChainGateError);
    expect(() => loadRelease(dir, { requireSums: true })).toThrow(/SHA256SUMS mismatch for transfer_hook.json/);
    const noSums = releaseDir();
    fs.rmSync(path.join(noSums, "SHA256SUMS"));
    expect(() => loadRelease(noSums, { requireSums: true })).toThrow(/no SHA256SUMS/);
  });
});

describe("IDL update after handover (C14): prepare-export → Squads idl-update", () => {
  it("the bufferWriter fills a buffer, hands it to the vault and the export carries setData/close for the vault", async () => {
    const w = await world();
    await w.chain.deployProgram(HOOK, { authority: w.keys.vault, payload: new Uint8Array([4, 5, 6]), capacity: 2048 });
    const old = new Uint8Array(Buffer.from(JSON.stringify({ address: HOOK, metadata: { name: "transfer_hook" } })));
    await seedIdl(w, HOOK, old);
    const extra = { CHAIN_IDL_MODE: "prepare-export", CHAIN_IDL_PROGRAM: "transfer_hook" };
    const prepared = await send(w, extra, "bufferWriter");
    expect(prepared.error ?? null).toBeNull();
    expect(prepared.status).toBe("awaiting");
    const specFile = path.join(w.dir, `evidence-${w.outputs}.json.idl-export.json`);
    const [spec] = JSON.parse(fs.readFileSync(specFile, "utf8"));
    expect(spec).toMatchObject({ program: "transfer_hook", vault: w.keys.vault, spill: w.keys.bufferWriter, trim: false });
    const buffer = w.chain.get(spec.buffer)!;
    expect(decodePmBufferAccount(buffer.data)!.authority).toBe(w.keys.vault);
    // The metadata is untouched until the vault executes the export.
    expect(statuses(await dry(w, { CHAIN_IDL_PROGRAM: "transfer_hook" }))).toEqual({ transfer_hook: "update" });

    const exported = await runTool(
      "squads-export",
      env(w, { CHAIN_SQUADS_OP: "idl-update", CHAIN_SQUADS_INPUT: specFile }),
      squadsExportTool,
      deps(w),
    );
    expect(exported.error ?? null).toBeNull();
    const txs = (exported.export as { transactions: { instructions: { program: string; accounts: { address: string; signer: boolean }[] }[] }[] }).transactions;
    const instructions = txs.flatMap((t) => t.instructions);
    expect(instructions.map((ix) => ix.program)).toEqual(["ProgM6JCCvbYkfKqJYHePx4xxSUSqJp7rh8Lyv7nk7S", "ProgM6JCCvbYkfKqJYHePx4xxSUSqJp7rh8Lyv7nk7S"]);
    const signers = new Set(instructions.flatMap((ix) => ix.accounts.filter((a) => a.signer).map((a) => a.address)));
    expect([...signers]).toEqual([w.keys.vault]);
  });
});

describe("resume after a crash (C7)", () => {
  it("CHAIN_IDL_RESUME_BUFFER rewrites only the chunks that did not land", async () => {
    const w = await world();
    const old = new Uint8Array(Buffer.from(JSON.stringify({ address: HOOK })));
    await seedIdl(w, HOOK, old);
    const extra = { CHAIN_IDL_MODE: "send", CHAIN_IDL_PROGRAM: "transfer_hook", CHAIN_SNAPSHOT_DIR: path.join(w.dir, "snap") };
    // The 4th transaction (top-up, buffer, write 0, write 900 …) never lands.
    let count = 0;
    const doomed = new Set<string>();
    w.chain.behavior = (sig, attempt) => {
      if (attempt === 1 && ++count === 4) doomed.add(sig);
      return doomed.has(sig) ? "drop" : "land";
    };
    const failed = await send(w, extra, "deployer", { ...deps(w), timing: instantTiming(w.chain, BigInt(20)) });
    expect(failed.status).toBe("failed");
    expect(failed.error).toMatch(/expired without landing/);
    const journal = readJournal(path.join(w.dir, `evidence-${w.outputs}.json.journal.jsonl`));
    const buffer = journal.find((e) => e.event === "buffer")!.address as Address;
    expect(decodePmBufferAccount(w.chain.get(buffer)!.data)!.authority).toBe(w.keys.deployer);

    w.chain.behavior = () => "land";
    const resume = { ...extra, CHAIN_IDL_RESUME_BUFFER: buffer, CHAIN_SNAPSHOT_DIR: path.join(w.dir, "snap2") };
    const plan = await dry(w, resume);
    const steps = (plan.plan as { id: string }[]).map((s) => s.id);
    expect(steps).not.toContain("transfer_hook:buffer");
    expect(steps).not.toContain("transfer_hook:top-up");
    expect(steps).not.toContain("transfer_hook:write:0");
    expect(steps).toContain(`transfer_hook:write:${PM_WRITE_CHUNK}`);
    const resumed = await send(w, resume);
    expect(resumed.error ?? null).toBeNull();
    expect(statuses(resumed, "idlAfter")).toEqual({ transfer_hook: "in-sync" });
    expect(w.chain.get(buffer)).toBeUndefined();
  });
});

describe("program IDs", () => {
  it("match the committed IDL addresses", () => {
    expect(JSON.parse(Buffer.from(registryIdl).toString("utf8")).address).toBe(PROGRAM_IDS.asset_registry);
    expect(JSON.parse(Buffer.from(hookIdl).toString("utf8")).address).toBe(PROGRAM_IDS.transfer_hook);
  });
});
