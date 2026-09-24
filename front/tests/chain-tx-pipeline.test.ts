import fs from "node:fs";
import path from "node:path";
import {
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  signTransactionMessageWithSigners,
  type KeyPairSigner,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { describe, expect, it } from "vitest";
import { CLUSTER_GENESIS_HASHES } from "@/lib/network-identity";
import { runTool } from "@/scripts/chain/lib/context";
import { inventoryTool } from "@/scripts/chain/lib/inventory";
import { Journal, acquireLock, lockPath, readJournal, unresolvedSignatures } from "@/scripts/chain/lib/journal";
import { createChainRpc } from "@/scripts/chain/lib/rpc";
import { ChainGateError, repoRoot } from "@/scripts/chain/lib/safety";
import { buildMessage, submitAndConfirm, type Timing } from "@/scripts/chain/lib/tx";
import { FakeChain, key, tempDir } from "./helpers/chain-fake";

type Harness = {
  chain: FakeChain;
  payer: KeyPairSigner;
  journal: Journal;
  dir: string;
  drainRpc: ReturnType<typeof createChainRpc>["drainRpc"];
};

async function harness(): Promise<Harness> {
  const chain = new FakeChain();
  const payer = await generateKeyPairSigner();
  chain.fund(payer.address, BigInt(10_000_000_000));
  const dir = tempDir();
  const journal = new Journal(path.join(dir, "run.journal.jsonl"));
  const { drainRpc } = createChainRpc({
    url: "https://rpc.example.test/",
    network: "devnet",
    expectedGenesis: CLUSTER_GENESIS_HASHES.devnet,
    mode: "send",
    rps: Infinity,
    transport: chain.transport,
    retryDelayMs: 0,
    sleep: async () => {},
  });
  return { chain, payer, journal, dir, drainRpc };
}

async function signedTransfer(h: Harness, lamports = BigInt(1000)) {
  const blockhash = (await h.drainRpc.getLatestBlockhash().send()).value;
  const message = buildMessage({
    feePayer: h.payer,
    ixs: [getTransferSolInstruction({ source: h.payer, destination: key(9), amount: lamports })],
    blockhash,
  });
  const signed = await signTransactionMessageWithSigners(message);
  return {
    wire: getBase64EncodedWireTransaction(signed),
    signature: getSignatureFromTransaction(signed),
    lastValidBlockHeight: blockhash.lastValidBlockHeight,
  };
}

/** Deterministic clock; `onTick` runs after every sleep. */
function timing(onTick: (tick: number) => void = () => {}): Partial<Timing> {
  let now = 0;
  let tick = 0;
  return {
    pollMs: 2_000,
    rebroadcastMs: 5_000,
    finalizeBudgetMs: 120_000,
    maxPollFailures: 5,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
      onTick(++tick);
    },
  };
}

async function submit(h: Harness, tx: Awaited<ReturnType<typeof signedTransfer>>, t: Partial<Timing>, required: "confirmed" | "finalized" = "finalized") {
  return submitAndConfirm({
    drainRpc: h.drainRpc,
    journal: h.journal,
    step: "T1",
    wire: tx.wire,
    signature: tx.signature,
    lastValidBlockHeight: tx.lastValidBlockHeight,
    required,
    timing: t,
  });
}

describe("transaction pipeline (§3.6)", () => {
  it("journals the signature (fsync) before the first send", async () => {
    const h = await harness();
    const tx = await signedTransfer(h);
    let seen = false;
    h.chain.onSend = (sig) => {
      const events = readJournal(h.journal.path);
      seen = events.some((e) => e.event === "signed" && e.sig === sig && e.lastValidBlockHeight && e.wireSha256);
    };
    const outcome = await submit(h, tx, timing());
    expect(seen).toBe(true);
    expect(outcome.status).toBe("finalized");
    expect(unresolvedSignatures(readJournal(h.journal.path))).toEqual([]);
  });

  it("confirmed near expiry → LANDED: no resend, never declared dropped", async () => {
    const h = await harness();
    const tx = await signedTransfer(h);
    h.chain.behavior = () => "processed-only";
    const outcome = await submit(
      h,
      tx,
      timing((tick) => {
        // Landed (processed) at the first send; the height then passes the
        // blockhash expiry, and only later does the signature finalize.
        h.chain.blockHeight += BigInt(100);
        const status = h.chain.statuses.get(tx.signature)!;
        if (tick === 3) status.confirmationStatus = "confirmed";
        if (tick === 8) status.confirmationStatus = "finalized";
      }),
    );
    expect(outcome.status).toBe("finalized");
    expect(h.chain.sends).toHaveLength(1);
    expect(h.chain.calls).not.toContain("getBlockHeight");
  });

  it("a sendTransaction timeout that still lands resolves as finalized without a rebuild", async () => {
    const h = await harness();
    const tx = await signedTransfer(h);
    h.chain.behavior = () => "throw-then-land";
    const outcome = await submit(h, tx, timing());
    expect(outcome.status).toBe("finalized");
    const sent = readJournal(h.journal.path).find((e) => e.event === "sent");
    expect(sent?.sendCallFailed).toBe(true);
    expect(new Set(h.chain.sends.map((s) => s.wire)).size).toBe(1);
  });

  it("truly dropped: rebroadcasts identical bytes, then finalized height > LVBH and a null history → dropped", async () => {
    const h = await harness();
    const tx = await signedTransfer(h);
    h.chain.behavior = () => "drop";
    const outcome = await submit(h, tx, timing(() => (h.chain.blockHeight += BigInt(10))));
    expect(outcome.status).toBe("dropped");
    expect(h.chain.sends.length).toBeGreaterThan(2);
    expect(new Set(h.chain.sends.map((s) => s.wire))).toEqual(new Set([tx.wire]));
    const dropped = readJournal(h.journal.path).find((e) => e.status === "dropped");
    expect(BigInt(dropped!.finalizedBlockHeight as string)).toBeGreaterThan(tx.lastValidBlockHeight);
    expect(unresolvedSignatures(readJournal(h.journal.path))).toEqual([]);
  });

  it("an execution error halts as failed", async () => {
    const h = await harness();
    const tx = await signedTransfer(h, BigInt(100_000_000_000));
    const outcome = await submit(h, tx, timing());
    expect(outcome.status).toBe("failed");
    expect(readJournal(h.journal.path).some((e) => e.status === "failed" && e.err)).toBe(true);
  });

  it("landed but not finalized within the budget halts as landed-unfinalized (never re-sent)", async () => {
    const h = await harness();
    const tx = await signedTransfer(h);
    h.chain.behavior = () => "processed-only";
    const outcome = await submit(h, tx, timing());
    expect(outcome.status).toBe("landed-unfinalized");
    expect(h.chain.sends).toHaveLength(1);
    expect(unresolvedSignatures(readJournal(h.journal.path)).map((u) => u.sig)).toEqual([tx.signature]);
  });

  it("replay-safe steps may stop at confirmed", async () => {
    const h = await harness();
    const tx = await signedTransfer(h);
    h.chain.behavior = () => "processed-only";
    const outcome = await submit(
      h,
      tx,
      timing((tick) => {
        if (tick === 2) h.chain.statuses.get(tx.signature)!.confirmationStatus = "confirmed";
      }),
      "confirmed",
    );
    expect(outcome.status).toBe("confirmed");
  });
});

describe("lock and recovery (§3.7)", () => {
  it("a second process is refused by the lock", () => {
    const dir = tempDir();
    const input = { stateDir: dir, network: "devnet", genesis: CLUSTER_GENESIS_HASHES.devnet, tool: "bootstrap", journalPath: path.join(dir, "j") };
    const first = acquireLock(input);
    expect(fs.existsSync(first.path)).toBe(true);
    expect(() => acquireLock(input)).toThrow(ChainGateError);
    expect(() => acquireLock(input)).toThrow(/CHAIN_RECOVER=1/);
  });

  it("CHAIN_RECOVER resolves the journalled signatures and removes the lock", async () => {
    const h = await harness();
    const landed = await signedTransfer(h);
    const dropped = await signedTransfer(h, BigInt(2000));
    // Simulate a crash: both journalled, one landed, one never did.
    h.journal.append({ event: "signed", step: "S1", sig: landed.signature, lastValidBlockHeight: landed.lastValidBlockHeight.toString() });
    h.journal.append({ event: "signed", step: "S2", sig: dropped.signature, lastValidBlockHeight: dropped.lastValidBlockHeight.toString() });
    h.chain.statuses.set(landed.signature, { slot: 1, err: null, confirmationStatus: "finalized" });
    h.chain.blockHeight = dropped.lastValidBlockHeight + BigInt(1);
    const stateDir = path.join(h.dir, "state");
    acquireLock({ stateDir, network: "devnet", genesis: CLUSTER_GENESIS_HASHES.devnet, tool: "bootstrap", journalPath: h.journal.path });
    const file = lockPath(stateDir, "devnet", CLUSTER_GENESIS_HASHES.devnet);
    expect(fs.existsSync(file)).toBe(true);

    const evidence = await runTool(
      "inventory",
      {
        CHAIN_NETWORK: "devnet",
        CHAIN_RPC_URL: "https://rpc.example.test/",
        CHAIN_OUTPUT: path.join(h.dir, "recover.json"),
        CHAIN_STATE_DIR: stateDir,
        CHAIN_RECOVER: "1",
      },
      inventoryTool,
      { transport: h.chain.transport, rps: Infinity, timing: timing(), root: repoRoot(), log: () => {} },
    );
    expect(evidence.status).toBe("completed");
    const recovery = evidence.recovery as { outcomes: { step: string; status: string }[]; lockRemoved: boolean };
    expect(recovery.outcomes).toEqual([
      expect.objectContaining({ step: "S1", status: "finalized" }),
      expect.objectContaining({ step: "S2", status: "dropped" }),
    ]);
    expect(recovery.lockRemoved).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    expect(h.chain.calls).not.toContain("sendTransaction");
    expect(unresolvedSignatures(readJournal(h.journal.path))).toEqual([]);
  });
});
