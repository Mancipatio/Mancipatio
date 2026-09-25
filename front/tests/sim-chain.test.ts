// The simulator's transaction executor (scripts/sim/lib/chain.ts) on the
// chain CLI's in-memory FakeChain: the signature is saved before the send,
// a landed step is never re-sent, a dropped one is rebuilt, a resume resolves
// inflight signatures (also ones only the tx journal saw), and RPC 429s open
// the breaker. Offline: the RPC transport is the fake.
import path from "node:path";
import { describe, expect, it } from "vitest";
import { generateKeyPairSigner, type RpcTransport } from "@solana/kit";
import { CLUSTER_GENESIS_HASHES } from "@/lib/network-identity";
import { fundInstructions } from "@/scripts/chain/lib/e2e/fixtures";
import { Journal, readJournal } from "@/scripts/chain/lib/journal";
import { SimRetryLater, TxExecutor, createSimRpc } from "@/scripts/sim/lib/chain";
import { MemoryJournal } from "@/scripts/sim/lib/journal";
import { Limiter, type Clock } from "@/scripts/sim/lib/pacing";
import { newState, type TxOwner } from "@/scripts/sim/lib/state";
import { FakeChain, instantTiming, tempDir } from "./helpers/chain-fake";

const SOL = BigInt(1_000_000_000);
const meta = { cohort: "setup", wave: null };

function clock(): Clock & { t: number } {
  const c = { t: 0, now: () => c.t, sleep: async (ms: number) => void (c.t += ms) };
  return c;
}

async function setup(transport?: RpcTransport) {
  const chain = new FakeChain();
  const payer = await generateKeyPairSigner();
  chain.fund(payer.address, BigInt(10) * SOL);
  const fake = clock();
  const limiter = new Limiter({ clock: fake });
  const { rpc, drainRpc } = createSimRpc({
    url: "https://devnet.example.com/",
    expectedGenesis: CLUSTER_GENESIS_HASHES.devnet,
    rps: Infinity,
    limiter,
    transport: transport ?? chain.transport,
  });
  const dir = tempDir("sim-chain-");
  const txJournal = new Journal(path.join(dir, "tx-journal.jsonl"));
  const snapshots: string[] = [];
  const owner: TxOwner = { label: "funding", tx: {} };
  const exec = new TxExecutor({
    rpc,
    drainRpc,
    txJournal,
    journal: new MemoryJournal(),
    limiter,
    persist: () => snapshots.push(JSON.stringify(owner.tx)),
    timing: instantTiming(chain, BigInt(1)),
  });
  return { chain, payer, exec, owner, snapshots, txJournal, limiter, fake };
}

describe("TxExecutor", () => {
  it("saves the signature (inflight) before the send, lands at finalized, and never re-sends", async () => {
    const { chain, payer, exec, owner, snapshots, txJournal } = await setup();
    const to = (await generateKeyPairSigner()).address;
    let atSend: string | null = null;
    chain.onSend = (sig) => {
      atSend = sig;
      const last = JSON.parse(snapshots.at(-1)!) as Record<string, { status: string; sig: string }>;
      expect(last["sol.1"]).toMatchObject({ status: "inflight", sig });
      expect(readJournal(txJournal.path).some((e) => e.event === "signed" && e.sig === sig)).toBe(true);
    };
    const first = await exec.run(owner, meta, "sol.1", payer, async () => fundInstructions(payer, [{ to, lamports: BigInt(30_000_000) }]));
    expect(first.skipped).toBe(false);
    expect(first.signature).toBe(atSend);
    expect(owner.tx["sol.1"]).toMatchObject({ status: "landed", sig: atSend });
    expect(chain.get(to)?.lamports).toBe(BigInt(30_000_000));
    const again = await exec.run(owner, meta, "sol.1", payer, async () => {
      throw new Error("must not rebuild a landed step");
    });
    expect(again).toEqual({ signature: atSend, skipped: true });
    expect(chain.sends).toHaveLength(1);
  });

  it("records a step as landed without sending when `done` shows its effect", async () => {
    const { chain, payer, exec, owner } = await setup();
    const result = await exec.run(owner, meta, "open.1", payer, async () => [], { done: async () => true });
    expect(result).toEqual({ signature: null, skipped: true });
    expect(chain.sends).toHaveLength(0);
  });

  it("refuses to send when the simulation fails and journals the failure", async () => {
    const { chain, payer, exec, owner } = await setup();
    const to = (await generateKeyPairSigner()).address;
    await expect(
      exec.run(owner, meta, "sol.big", payer, async () => fundInstructions(payer, [{ to, lamports: BigInt(1_000) * SOL }])),
    ).rejects.toThrow(/simulation failed/);
    expect(chain.sends).toHaveLength(0);
    expect(owner.tx["sol.big"]).toBeUndefined();
  });

  it("drops an expired signature and rebuilds the step on the next call", async () => {
    const { chain, payer, exec, owner } = await setup();
    const to = (await generateKeyPairSigner()).address;
    chain.behavior = () => "drop";
    const build = async () => fundInstructions(payer, [{ to, lamports: BigInt(1_000_000) }]);
    // Each poll advances the fake block height by 1; the blockhash expires after 150.
    await expect(exec.run(owner, meta, "sol.2", payer, build)).rejects.toBeInstanceOf(SimRetryLater);
    expect(owner.tx["sol.2"]).toBeUndefined();
    chain.behavior = () => "land";
    const retried = await exec.run(owner, meta, "sol.2", payer, build);
    expect(retried.skipped).toBe(false);
    expect(chain.get(to)?.lamports).toBe(BigInt(1_000_000));
  });

  it("resolves inflight signatures on resume, including one only the tx journal saw", async () => {
    const { chain, payer, exec, txJournal } = await setup();
    const state = newState("abc123", CLUSTER_GENESIS_HASHES.devnet);
    const landedSig = "5".repeat(88);
    const lostSig = "4".repeat(88);
    const orphanSig = "3".repeat(88);
    chain.statuses.set(landedSig, { slot: 1, err: null, confirmationStatus: "finalized" } as never);
    state.funding.tx["sol.7"] = { status: "inflight", sig: landedSig, lvbh: "5000", at: "" };
    state.funding.tx["sol.8"] = { status: "inflight", sig: lostSig, lvbh: "10", at: "" };
    chain.statuses.set(orphanSig, { slot: 1, err: { InstructionError: [0, { Custom: 1 }] }, confirmationStatus: "finalized" } as never);
    txJournal.append({ event: "signed", step: "market:open.9001", sig: orphanSig, lastValidBlockHeight: "5000" });
    const result = await exec.resolveAll(state, () => meta);
    expect(result.pending).toBe(0);
    expect(state.funding.tx["sol.7"].status).toBe("landed");
    expect(state.funding.tx["sol.8"]).toBeUndefined(); // block height 1000 > 10 and never seen: dropped
    expect(state.market.tx["open.9001"]).toMatchObject({ status: "failed", sig: orphanSig });
    void payer;
  });
});

describe("RPC breaker", () => {
  it("two HTTP 429s from the RPC pause every chain call for 120 s", async () => {
    const chain = new FakeChain();
    let throttled = 2;
    const transport = (async (config: Parameters<RpcTransport>[0]) => {
      const method = (config.payload as { method: string }).method;
      if (method === "getBalance" && throttled > 0) {
        throttled -= 1;
        return { jsonrpc: "2.0", id: 1, error: { code: 429, message: "Too many requests" } };
      }
      return chain.transport(config);
    }) as RpcTransport;
    const { exec, fake } = await setup(transport);
    // The CLI transport retries a 429; the third attempt waits out the open breaker.
    const balance = await exec.rpc.getBalance((await generateKeyPairSigner()).address).send();
    expect(balance.value).toBe(BigInt(0));
    expect(fake.t).toBeGreaterThanOrEqual(120_000);
  });
});
