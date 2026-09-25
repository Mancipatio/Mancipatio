// The simulator's transaction executor (scripts/sim/lib/chain.ts) on the
// chain CLI's in-memory FakeChain: the signature is saved before the send,
// a landed step is never re-sent, a dropped one is rebuilt, a resume resolves
// inflight signatures (also ones only the tx journal saw) and journals the
// resolution, RPC 429s open the breaker, transfer probes are simulated and
// never sent, and a transfer reported dropped settles from its snapshot.
// Offline: the RPC transport is the fake.
import path from "node:path";
import { describe, expect, it } from "vitest";
import { generateKeyPairSigner, getAddressEncoder, type Address, type RpcTransport } from "@solana/kit";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  OtcDealStatus,
  findAdminRecordPda,
  findDealPda,
  findPlatformPda,
  getAdminEncoder,
  getKycRegistryEncoder,
  getOtcDealEncoder,
  getPlatformEncoder,
} from "@/lib/generated/asset_registry";
import { CLUSTER_GENESIS_HASHES } from "@/lib/network-identity";
import { TOKEN_2022 } from "@/lib/transaction-builders";
import { fundInstructions } from "@/scripts/chain/lib/e2e/fixtures";
import { Journal, readJournal } from "@/scripts/chain/lib/journal";
import { SimChainOps, SimRetryLater, TxExecutor, createSimRpc } from "@/scripts/sim/lib/chain";
import { buildRoster } from "@/scripts/sim/lib/identity";
import { MemoryJournal } from "@/scripts/sim/lib/journal";
import { Limiter, type Clock } from "@/scripts/sim/lib/pacing";
import { newState, newUserState, type TxOwner } from "@/scripts/sim/lib/state";
import { XferDiverged, buildDirectTransfer } from "@/scripts/sim/lib/transfers";
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
  const journal = new MemoryJournal();
  const exec = new TxExecutor({
    rpc,
    drainRpc,
    txJournal,
    journal,
    limiter,
    persist: () => snapshots.push(JSON.stringify(owner.tx)),
    timing: instantTiming(chain, BigInt(1)),
  });
  return { chain, payer, exec, owner, snapshots, txJournal, limiter, fake, journal, rpc };
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

describe("the tx journal agrees with state.json (the chain CLI lock rule)", () => {
  it("journals every resolution on resume and is then settled", async () => {
    const { chain, exec, txJournal } = await setup();
    const state = newState("abc123", CLUSTER_GENESIS_HASHES.devnet);
    const landedSig = "5".repeat(88);
    const lostSig = "4".repeat(88);
    chain.statuses.set(landedSig, { slot: 1, err: null, confirmationStatus: "finalized" } as never);
    txJournal.append({ event: "signed", step: "funding:sol.7", sig: landedSig, lastValidBlockHeight: "5000" });
    txJournal.append({ event: "signed", step: "funding:sol.8", sig: lostSig, lastValidBlockHeight: "10" });
    state.funding.tx["sol.7"] = { status: "inflight", sig: landedSig, lvbh: "5000", at: "" };
    state.funding.tx["sol.8"] = { status: "inflight", sig: lostSig, lvbh: "10", at: "" };
    expect(exec.settled(state)).toBe(false);
    await exec.resolveAll(state, () => meta);
    const recovered = readJournal(txJournal.path).filter((e) => e.event === "recover").map((e) => [e.step, e.status]);
    expect(recovered).toEqual([["funding:sol.7", "finalized"], ["funding:sol.8", "dropped"]]);
    expect(exec.settled(state)).toBe(true);
  });

  it("backfills a terminal event for a signature state.json settled without one", async () => {
    const { exec, txJournal } = await setup();
    const state = newState("abc123", CLUSTER_GENESIS_HASHES.devnet);
    const sig = "6".repeat(88);
    txJournal.append({ event: "signed", step: "market:open.9002", sig, lastValidBlockHeight: "5000" });
    state.market.tx["open.9002"] = { status: "landed", sig, at: "" };
    expect(exec.everSigned(state.market, "open.9002")).toBe(true);
    expect(exec.everSigned(state.market, "open.9003")).toBe(false);
    expect(exec.settled(state)).toBe(true);
    expect(readJournal(txJournal.path).at(-1)).toMatchObject({ event: "recover", step: "market:open.9002", status: "finalized" });
  });

  it("closes an earlier signature of a re-sent step on resume (an older build settled it without a journal event), so the lock can go", async () => {
    const { chain, exec, journal, txJournal } = await setup();
    const state = newState("abc123", CLUSTER_GENESIS_HASHES.devnet);
    const expired = "7".repeat(88);
    const young = "9".repeat(88);
    const resent = "8".repeat(88);
    // sol.9: the first signature was resolved as dropped by the older build, then the step was sent again.
    txJournal.append({ event: "signed", step: "funding:sol.9", sig: expired, lastValidBlockHeight: "10" });
    txJournal.append({ event: "signed", step: "funding:sol.9", sig: resent, lastValidBlockHeight: "5000" });
    txJournal.append({ event: "status", step: "funding:sol.9", sig: resent, status: "finalized" });
    state.funding.tx["sol.9"] = { status: "landed", sig: resent, at: "" };
    // sol.10: an earlier signature still inside its blockhash window.
    txJournal.append({ event: "signed", step: "funding:sol.10", sig: young, lastValidBlockHeight: "5000" });
    state.funding.tx["sol.10"] = { status: "landed", sig: null, at: "" };
    expect(exec.settled(state)).toBe(false);
    expect(await exec.resolveAll(state, () => meta)).toEqual({ pending: 0, orphans: 1 });
    expect(readJournal(txJournal.path).filter((e) => e.event === "recover").map((e) => [e.step, e.sig, e.status])).toEqual([["funding:sol.9", expired, "dropped"]]);
    // The state records belong to the other signatures and are left alone.
    expect(state.funding.tx["sol.9"]).toMatchObject({ status: "landed", sig: resent });
    expect(state.funding.tx["sol.10"]).toMatchObject({ status: "landed", sig: null });
    expect(exec.settled(state)).toBe(false); // sol.10's earlier signature could still land
    // It landed after all (the null record was a false drop settled from its effect): closed, no finding.
    chain.statuses.set(young, { slot: 1, err: null, confirmationStatus: "finalized" } as never);
    expect(await exec.resolveAll(state, () => meta)).toEqual({ pending: 0, orphans: 0 });
    expect(exec.settled(state)).toBe(true);
    expect(journal.entries.filter((e) => e.outcome === "tx-error")).toEqual([]);
  });

  it("an earlier signature that finalized beside another landed one of the same step is a possible double send", async () => {
    const { chain, exec, journal, txJournal } = await setup();
    const state = newState("abc123", CLUSTER_GENESIS_HASHES.devnet);
    const first = "6".repeat(88);
    const second = "5".repeat(88);
    txJournal.append({ event: "signed", step: "funding:sol.11", sig: first, lastValidBlockHeight: "5000" });
    txJournal.append({ event: "signed", step: "funding:sol.11", sig: second, lastValidBlockHeight: "5000" });
    txJournal.append({ event: "status", step: "funding:sol.11", sig: second, status: "finalized" });
    state.funding.tx["sol.11"] = { status: "landed", sig: second, at: "" };
    chain.statuses.set(first, { slot: 1, err: null, confirmationStatus: "finalized" } as never);
    expect(await exec.resolveAll(state, () => meta)).toEqual({ pending: 0, orphans: 0 });
    expect(exec.settled(state)).toBe(true);
    expect(journal.entries.filter((e) => e.outcome === "tx-error").map((e) => [e.step, e.txSig])).toEqual([["sol.11", first]]);
    expect(journal.entries[0].err).toMatch(/finalized too .*check for a double send/);
  });
});

describe("the owner actor's chain reads (SimChainOps)", () => {
  const PROGRAM = ASSET_REGISTRY_PROGRAM_ADDRESS;
  const put = (chain: FakeChain, address: Address, data: Uint8Array) => chain.accounts.set(address, { owner: PROGRAM, lamports: SOL, data: new Uint8Array(data) });
  const market = (classA: Address) => ({ issuer: classA, asset: classA, classA, mintA: classA, paymentMint: classA, kycRegistry: null, classB: null, mintB: null, donor: null });

  it("otcDeals reads only the class's OTC deals (one filtered getProgramAccounts) with every field C-O7 compares", async () => {
    const { chain, exec } = await setup();
    const [classA, classB, seller, buyer, admin, mint, pay] = await Promise.all(Array.from({ length: 7 }, async () => (await generateKeyPairSigner()).address));
    const deal = (shareClass: Address, dealId: bigint) =>
      getOtcDealEncoder().encode({
        admin,
        buyer,
        seller,
        shareClass,
        mint,
        paymentMint: pay,
        assetEscrow: mint,
        paymentEscrow: pay,
        amount: BigInt(5),
        price: BigInt(6_000_000),
        assetDeposited: false,
        paymentDeposited: false,
        status: OtcDealStatus.Open,
        dealId,
        expiresAt: BigInt(1_790_259_200),
        version: 1,
        bump: 255,
        assetDepositedAmount: BigInt(0),
        paymentDepositedAmount: BigInt(0),
      });
    const [pdaA] = await findDealPda({ shareClass: classA, dealId: BigInt(7) });
    const [pdaB] = await findDealPda({ shareClass: classB, dealId: BigInt(8) });
    put(chain, pdaA, new Uint8Array(deal(classA, BigInt(7))));
    put(chain, pdaB, new Uint8Array(deal(classB, BigInt(8))));
    const ops = new SimChainOps(exec, market(classA));
    const rows = await ops.otcDeals(classA);
    expect(rows).toEqual([
      { pda: pdaA, status: OtcDealStatus.Open, assetDeposited: false, paymentDeposited: false, seller, buyer, amount: BigInt(5), price: BigInt(6_000_000), admin, paymentMint: pay, mint, shareClass: classA, expiresAt: BigInt(1_790_259_200), dealId: BigInt(7) },
    ]);
    expect(await ops.dealPda(classA, BigInt(7))).toBe(pdaA);
    expect(chain.calls.filter((m) => m === "getProgramAccounts")).toHaveLength(1);
  });

  it("journals an owner-actor transaction as user owner with the requester as target (it stays on the requester's record)", async () => {
    const { payer, exec, journal } = await setup();
    const to = (await generateKeyPairSigner()).address;
    const requester: TxOwner = { label: "u049", tx: {} };
    await exec.run(requester, { cohort: "owner", wave: 3, actor: "owner", target: "u049" }, "owner.otc.create", payer, async () => fundInstructions(payer, [{ to, lamports: BigInt(1_000_000) }]));
    expect(requester.tx["owner.otc.create"]).toMatchObject({ status: "landed" });
    expect(journal.entries.at(-1)).toMatchObject({ user: "owner", target: "u049", cohort: "owner", ix: "owner.otc.create", outcome: "ok" });
  });

  it("ownerView: an Admin record naming the wallet is an Admin; Platform.admin, the registry authority and the SOL are read", async () => {
    const { chain, exec } = await setup();
    const [admin, superAdmin, provider, registry] = await Promise.all(Array.from({ length: 4 }, async () => (await generateKeyPairSigner()).address));
    const [platformPda] = await findPlatformPda();
    put(chain, platformPda, new Uint8Array(getPlatformEncoder().encode({ admin: superAdmin, protocolTreasury: superAdmin, protocolFeeBps: 0, pauseFlags: 0, issuersCount: 1, version: 1, bump: 255 })));
    put(chain, registry, new Uint8Array(getKycRegistryEncoder().encode({ authority: provider, approvedJurisdictions: new Uint8Array(128), blockedJurisdictions: new Uint8Array(128), entriesCount: 0, version: 1, bump: 255 })));
    chain.fund(admin, SOL / BigInt(10));
    const ops = new SimChainOps(exec, market(registry));
    expect(await ops.ownerView(admin, registry)).toEqual({ isAdmin: false, platformAdmin: superAdmin, kycAuthority: provider, lamports: SOL / BigInt(10) });
    const [record] = await findAdminRecordPda({ authority: admin });
    put(chain, record, new Uint8Array(getAdminEncoder().encode({ admin, addedBy: superAdmin, bump: 255 })));
    expect((await ops.ownerView(admin, registry)).isAdmin).toBe(true);
  });
});

describe("transfer probes and sends (cohort X)", () => {
  const T22_LOGS = (code: number) => [`Program ${TOKEN_2022} invoke [1]`, `Program ${TOKEN_2022} failed: custom program error: 0x${code.toString(16)}`];
  const probeSetup = async () => {
    const s = await setup();
    const hub = s.payer;
    const peer = await generateKeyPairSigner();
    const mint = (await generateKeyPairSigner()).address;
    const spec = { mint, srcOwner: peer.address, dstOwner: hub.address, authority: peer, payer: hub, amount: BigInt(3) };
    const user = { label: "u102", tx: {} } as TxOwner;
    return { ...s, hub, peer, mint, spec, user, build: () => buildDirectTransfer(s.rpc, spec) };
  };

  it("a probe is simulated and never sent: no send, no state record, no tx-journal line; a match is expected-error", async () => {
    const { chain, exec, journal, txJournal, hub, user, build } = await probeSetup();
    chain.simulateOverride = () => ({ err: { InstructionError: [1, { Custom: 1 }] }, logs: T22_LOGS(1) });
    const outcome = await exec.probe(user, { cohort: "X", wave: 6 }, "P4", hub, build, { ok: false, program: "token_2022", code: 1, names: ["InsufficientFunds"] });
    expect(outcome).toBe("expected-error");
    expect(chain.sends).toHaveLength(0);
    expect(chain.calls.filter((m) => m === "sendTransaction")).toHaveLength(0);
    expect(user.tx).toEqual({});
    expect(readJournal(txJournal.path)).toEqual([]);
    expect(journal.entries).toHaveLength(1);
    expect(journal.entries[0]).toMatchObject({ kind: "probe", step: "xfer.P4", outcome: "expected-error", body: "token_2022: InsufficientFunds (1)" });
  });

  it("a refusal that simulates OK is an unexpected accept (still never sent), and runs beside a held tx lock", async () => {
    const { chain, exec, journal, limiter, hub, user, build } = await probeSetup();
    chain.simulateOverride = () => ({ err: null, logs: [`Program ${TOKEN_2022} invoke [1]`, `Program ${TOKEN_2022} success`] });
    const unlock = await limiter.lockTx(); // another transaction in flight
    const outcome = await exec.probe(user, { cohort: "X", wave: 6 }, "P4", hub, build, { ok: false, program: "token_2022", code: 1, names: ["InsufficientFunds"] });
    unlock();
    expect(outcome).toBe("unexpected-accept");
    expect(chain.sends).toHaveLength(0);
    expect(journal.entries[0]).toMatchObject({ kind: "probe", outcome: "unexpected-accept" });
    expect(journal.entries[0].err).toBe("expected token_2022: InsufficientFunds (1), simulated ok, hook not invoked");
    expect(limiter.granted.probe).toBe(1);
    expect(limiter.granted.tx).toBe(0);
  });

  it("a simulation that says nothing (BlockhashNotFound) is retried later, never a finding", async () => {
    const { chain, exec, journal, hub, user, build } = await probeSetup();
    chain.simulateOverride = () => ({ err: "BlockhashNotFound", logs: [] });
    await expect(exec.probe(user, { cohort: "X", wave: 6 }, "P1", hub, build, { ok: true })).rejects.toBeInstanceOf(SimRetryLater);
    expect(journal.entries).toEqual([]);
  });

  it("a transfer that landed but was reported dropped settles from its snapshot: one send, never two", async () => {
    const { chain, exec, txJournal, hub, peer, mint } = await probeSetup();
    const market = { issuer: mint, asset: mint, classA: mint, mintA: mint, paymentMint: mint, kycRegistry: null, classB: null, mintB: null, donor: null };
    const ops = new SimChainOps(exec, market);
    const [hubAta, peerAta] = await Promise.all([ops.ata(hub.address), ops.ata(peer.address)]);
    const tokenAccount = (owner: string, amount: number) => {
      const data = new Uint8Array(165);
      data.set(getAddressEncoder().encode(mint), 0);
      data.set(getAddressEncoder().encode(owner as Address), 32);
      new DataView(data.buffer).setBigUint64(64, BigInt(amount), true);
      return { owner: TOKEN_2022, lamports: BigInt(2_039_280), data };
    };
    chain.set(hubAta, tokenAccount(hub.address, 3));
    const u = { ...newUserState(buildRoster().find((p) => p.label === "u101")!, hub.address) };
    const snap = { srcOwner: hub.address, srcAta: hubAta, dstOwner: peer.address, dstAta: peerAta, amount: "2", srcBefore: "3", dstBefore: "0" };
    chain.simulateOverride = () => ({ err: null, logs: ["Program log: ok"] });
    chain.behavior = () => "throw-and-drop";
    await expect(ops.transfer(u, "xfer.s2", snap, { authority: hub, payer: hub, createDst: true })).rejects.toBeInstanceOf(SimRetryLater);
    expect(u.tx["xfer.s2"]).toBeUndefined();
    // Rebroadcasts re-send the identical wire: one signature.
    const signatures = () => new Set(chain.sends.map((x) => x.sig));
    expect(signatures().size).toBe(1);
    const sent = chain.sends.length;
    // It had landed after all (the node lost the status): the balances show the post-state.
    chain.set(hubAta, tokenAccount(hub.address, 1));
    chain.set(peerAta, tokenAccount(peer.address, 2));
    await ops.transfer(u, "xfer.s2", snap, { authority: hub, payer: hub, createDst: true });
    expect(u.tx["xfer.s2"]).toMatchObject({ status: "landed", sig: null });
    expect(chain.sends).toHaveLength(sent);
    expect(signatures().size).toBe(1);
    expect(readJournal(txJournal.path).filter((e) => e.event === "signed")).toHaveLength(1);
    expect(await ops.balances([hubAta, peerAta])).toEqual([BigInt(1), BigInt(2)]);
  });

  it("balances that are neither the pre- nor the post-state stop the send (XferDiverged)", async () => {
    const { chain, exec, hub, peer, mint } = await probeSetup();
    const market = { issuer: mint, asset: mint, classA: mint, mintA: mint, paymentMint: mint, kycRegistry: null, classB: null, mintB: null, donor: null };
    const ops = new SimChainOps(exec, market);
    const [hubAta, peerAta] = await Promise.all([ops.ata(hub.address), ops.ata(peer.address)]);
    const data = new Uint8Array(165);
    new DataView(data.buffer).setBigUint64(64, BigInt(7), true);
    chain.set(hubAta, { owner: TOKEN_2022, lamports: BigInt(1), data });
    const u = { ...newUserState(buildRoster().find((p) => p.label === "u101")!, hub.address) };
    const snap = { srcOwner: hub.address, srcAta: hubAta, dstOwner: peer.address, dstAta: peerAta, amount: "2", srcBefore: "3", dstBefore: "0" };
    await expect(ops.transfer(u, "xfer.s2", snap, { authority: hub, payer: hub })).rejects.toBeInstanceOf(XferDiverged);
    expect(chain.sends).toHaveLength(0);
  });

  it("the seed leg needs the donor signer inside the chain layer", async () => {
    const { exec, hub, mint } = await probeSetup();
    const market = { issuer: mint, asset: mint, classA: mint, mintA: mint, paymentMint: mint, kycRegistry: null, classB: null, mintB: null, donor: mint };
    const ops = new SimChainOps(exec, market, null);
    expect(ops.donor).toBeNull();
    const u = { ...newUserState(buildRoster().find((p) => p.label === "u101")!, hub.address) };
    const snap = { srcOwner: mint, srcAta: mint, dstOwner: hub.address, dstAta: mint, amount: "3", srcBefore: "5", dstBefore: "0" };
    await expect(ops.seedFromDonor(u, "xfer.s1", snap, hub)).rejects.toThrow(/donor signer is not loaded/);
    // A landed seed needs no signer: a resume without SIM_DONOR_KEYPAIR goes on (to its C1 re-reads).
    u.tx["xfer.s1"] = { status: "landed", sig: "4".repeat(88), at: "" };
    await expect(ops.seedFromDonor(u, "xfer.s1", snap, hub)).resolves.toBeUndefined();
  });
});
