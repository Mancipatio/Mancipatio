import fs from "node:fs";
import path from "node:path";
import { createKeyPairSignerFromBytes, createNoopSigner, getAddressEncoder, signBytes, type Address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  findAdminRecordPda,
  findPendingAdminPda,
  getPendingAdminDecoder,
  getPendingAdminEncoder,
  getProposePlatformAdminInstructionAsync,
} from "@/lib/generated/asset_registry";
import { getProposeBlocklistAuthorityInstructionAsync } from "@/lib/generated/transfer_hook";
import { CLUSTER_GENESIS_HASHES } from "@/lib/network-identity";
import { ACCEPT_CHECKOUT, acceptTarget, acceptTool, readAcceptRequest } from "@/scripts/chain/lib/accept";
import { bootstrapTool, planRoleStep, probeBootstrapState, roleStepOp } from "@/scripts/chain/lib/bootstrap-plan";
import { runTool } from "@/scripts/chain/lib/context";
import { emergencyTool } from "@/scripts/chain/lib/emergency";
import { messageHash, type LedgerDevice } from "@/scripts/chain/lib/ledger";
import { validateRoleMap } from "@/scripts/chain/lib/role-map";
import type { ChainEnv } from "@/scripts/chain/lib/safety";
import { REGISTRY, key, roleMapJson } from "./helpers/chain-fake";
import { CAPACITY, deps, env, ledger, localIdl, rpcFor, seedIdl, sendEnv, signerOf, world, type World } from "./helpers/chain-world";

/** Every chain:accept run sends at most one transaction, but a full order is a dozen runs. */
const ORDER_TIMEOUT_MS = 30_000;

const op = (name: string, signer: Address): ChainEnv => ({ CHAIN_ACCEPT_OP: name, CHAIN_ACCEPT_SIGNER: signer });

async function dry(w: World, extra: ChainEnv, lines: string[] = []) {
  return runTool("accept", env(w, extra), acceptTool, deps(w, lines));
}

async function send(w: World, extra: ChainEnv, signer: ChainEnv, options: { ledger?: () => Promise<LedgerDevice>; lines?: string[] } = {}) {
  const plan = await dry(w, extra);
  expect(plan.error ?? null).toBeNull();
  expect(plan.status).toBe("awaiting");
  return runTool(
    "accept",
    env(w, { ...extra, CHAIN_SEND: "1", CHAIN_CONFIRM_PLAN: plan.planDigest as string, ...signer }),
    acceptTool,
    { ...deps(w, options.lines), ledger: options.ledger },
  );
}

/** One chain:bootstrap cycle by the deployer (dry run, then the reviewed send). */
async function cycle(w: World, lines: string[] = []) {
  const plan = await runTool("bootstrap", env(w), bootstrapTool, deps(w));
  expect(plan.error ?? null).toBeNull();
  const sent = await runTool("bootstrap", sendEnv(w, plan.planDigest as string), bootstrapTool, deps(w, lines));
  expect(sent.error ?? null).toBeNull();
  return (sent.steps as { id: string }[]).map((s) => s.id);
}

/**
 * A Ledger stand-in that signs with a test keypair file and records its calls.
 * `onAddress` runs once, when the tool reads the device's key: after the plan,
 * before the send re-probes (the chain moving while the device is open).
 */
function fakeLedger(file: string, calls: string[], onAddress?: () => void): () => Promise<LedgerDevice> {
  return async () => {
    const signer = await createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(fs.readFileSync(file, "utf8"))));
    let moved = false;
    return {
      getPublicKey: async (p) => {
        calls.push(`address ${p}`);
        if (onAddress && !moved) {
          moved = true;
          onAddress();
        }
        return new Uint8Array(getAddressEncoder().encode(signer.address));
      },
      signMessage: async (p, message) => {
        calls.push(`sign ${p} ${messageHash(message)}`);
        return new Uint8Array(await signBytes(signer.keyPair.privateKey, message));
      },
      close: async () => {
        calls.push("close");
      },
    };
  };
}

/**
 * The mainnet company model (Talas 8.2, ~/mancipatio-mainnet/role-map.json):
 * one company wallet is the super admin, the BA, the KYC authority and the
 * treasury; admins[] holds one more Admin (its own Ledger); unpauseMask 1.
 */
async function companyWorld(): Promise<World & { company: Address }> {
  const w = await world();
  const company = w.keys.superAdmin;
  const json = JSON.parse(fs.readFileSync(w.mapFile, "utf8"));
  json.blocklistAuthority = company;
  json.kyc.authority = company;
  json.protocolTreasury = company;
  json.acknowledgedRoleOverlaps = [
    { key: company, roles: ["superAdmin", "kyc.authority", "blocklistAuthority", "protocolTreasury"], reason: "test: the company wallet holds every operational role" },
  ];
  json.unpauseMask = 1;
  fs.writeFileSync(w.mapFile, JSON.stringify(json));
  w.map = (await validateRoleMap(json, { network: "devnet", genesis: CLUSTER_GENESIS_HASHES.devnet })).map;
  return Object.assign(w, { company });
}

async function platformFlags(w: World) {
  return (await probeBootstrapState(rpcFor(w), w.map)).platform?.pauseFlags;
}

describe("chain:accept inputs", () => {
  it("parses the op and the typed-out signer; maps every role step id to its op", () => {
    expect(readAcceptRequest(op("accept-platform-admin", key(1)))).toEqual({ op: "accept-platform-admin", signer: key(1) });
    expect(() => readAcceptRequest(op("accept-everything", key(1)))).toThrow(/CHAIN_ACCEPT_OP must be one of add-admin, accept-blocklist-authority/);
    expect(() => readAcceptRequest({ CHAIN_ACCEPT_OP: "add-admin" })).toThrow(/CHAIN_ACCEPT_SIGNER must be a valid address/);
    expect(() => readAcceptRequest(op("add-admin", "11111111111111111111111111111111" as Address))).toThrow(/CHAIN_ACCEPT_SIGNER/);
    expect([`A3:${key(5)}`, "A3k", "X3", "X2", "X1", "S5c", "S6"].map(roleStepOp)).toEqual([
      "add-admin",
      "add-admin",
      "accept-blocklist-authority",
      "accept-kyc-registry-authority",
      "accept-platform-admin",
      "close-bootstrap-window",
      "first-unpause",
    ]);
    expect(["S1", "S3:x", "S5", "S6d", "S7"].map(roleStepOp)).toEqual([null, null, null, null, null]);
  });

  it("refuses a signer that is not the role map's key for the op (wrong signer), before any probe", async () => {
    const w = await world();
    const { keys } = w;
    const refuse = (name: string, signer: Address, pattern: RegExp) => expect(() => acceptTarget({ op: name as never, signer }, w.map)).toThrow(pattern);
    refuse("add-admin", keys.blocklistAuthority, /add-admin: .* is not an Admin of the role map \(admins\[\]: /);
    refuse("accept-blocklist-authority", keys.superAdmin, /is not the role map's blocklistAuthority/);
    refuse("accept-kyc-registry-authority", keys.blocklistAuthority, /is not the role map's kyc\.authority/);
    refuse("accept-platform-admin", keys.admins[0], /is not the role map's superAdmin/);
    refuse("close-bootstrap-window", keys.deployer, /is not the role map's superAdmin/);
    refuse("first-unpause", keys.kycAuthority, /is not the role map's superAdmin/);
    expect(acceptTarget({ op: "add-admin", signer: keys.admins[0] }, w.map)).toMatchObject({ stepId: `A3:${keys.admins[0]}`, program: "asset_registry", instruction: "add_admin" });
    expect(acceptTarget({ op: "accept-blocklist-authority", signer: keys.blocklistAuthority }, w.map)).toMatchObject({ stepId: "X3", program: "transfer_hook" });
    // Through the tool: refused in the inputs phase, nothing read or simulated.
    const refused = await dry(w, op("accept-platform-admin", keys.blocklistAuthority));
    expect(refused.status).toBe("failed");
    expect(refused.error).toMatch(/accept-platform-admin: .* is not the role map's superAdmin/);
    expect(w.chain.calls).not.toContain("getMultipleAccounts");
    expect(w.chain.calls).not.toContain("simulateTransaction");
    // A role map whose deployer is the super admin (off mainnet) unpauses by
    // the deployer (S6d) and has no X1: chain:bootstrap runs those.
    const own = { ...w.map, superAdmin: keys.deployer, unpauseBy: "deployer" as const };
    expect(() => acceptTarget({ op: "first-unpause", signer: keys.deployer }, own)).toThrow(/unpauses by the deployer \(S6d, a chain:bootstrap step\)/);
    expect(() => acceptTarget({ op: "accept-platform-admin", signer: keys.deployer }, own)).toThrow(/the deployer is the super admin in this role map; there is no X1/);
  });
});

describe("chain:accept: the bootstrap order on the CLI (runbook §5)", () => {
  it(
    "company model: cycle 1, A3 (keypair), X3 and X2 (Ledger), cycle 2 (S5), X1, S5c, S6 (Ledger); then chain:bootstrap plans only S7",
    async () => {
      const w = await companyWorld();
      const admin = w.keys.admins[0];
      const sendLines: string[] = [];
      expect(await cycle(w, sendLines)).toEqual(["S1", "S2", "S2b", `S3:${admin}`, "S4", "S4b"]);
      // chain:bootstrap names the CLI path next to each operator-front action, after a send too.
      // The reviewed plan (A3, X3, X2), then the same three after the send.
      expect(sendLines.filter((line) => line.includes("npm run chain:accept"))).toHaveLength(6);
      const lines: string[] = [];
      await runTool("bootstrap", env(w), bootstrapTool, deps(w, lines));
      const text = lines.join("\n");
      expect(text).toContain(`or with that key's Ledger on the CLI: CHAIN_ACCEPT_OP=add-admin CHAIN_ACCEPT_SIGNER=${admin} npm run chain:accept`);
      expect(text).toContain(`CHAIN_ACCEPT_OP=accept-blocklist-authority CHAIN_ACCEPT_SIGNER=${w.company}`);
      expect(text).toContain(`CHAIN_ACCEPT_OP=accept-kyc-registry-authority CHAIN_ACCEPT_SIGNER=${w.company}`);

      // A3: the new Admin's own key (here its keypair file).
      const a3Lines: string[] = [];
      const a3 = await send(w, op("add-admin", admin), { CHAIN_KEYPAIR: w.pairs.admin.path }, { lines: a3Lines });
      expect(a3.error ?? null).toBeNull();
      // X3 and X2 can run now; X1 only after the deployer's S5 (cycle 2).
      const a3Text = a3Lines.join("\n");
      expect(a3Text).toContain("next: chain:bootstrap (deployer) plans S5");
      expect(a3Text).toContain(`next: X3: CHAIN_ACCEPT_OP=accept-blocklist-authority CHAIN_ACCEPT_SIGNER=${w.company} npm run chain:accept`);
      expect(a3Text).toMatch(/later: X1 \(CHAIN_ACCEPT_OP=accept-platform-admin\): X1 cannot run: platform\.proposed=.* \(no live super admin proposal \(S5 of chain:bootstrap cycle 2 proposes it\)\)/);
      expect(a3.status).toBe("completed");
      expect(a3.step).toBe(`A3:${admin}`);
      expect((a3.steps as { id: string; outcome: string; postCheck: boolean }[])[0]).toMatchObject({ id: `A3:${admin}`, outcome: "finalized", postCheck: true });
      expect((await probeBootstrapState(rpcFor(w), w.map)).adminRecords[admin]).toBe(true);
      // Run again: nothing to do.
      const again = await dry(w, op("add-admin", admin));
      expect(again).toMatchObject({ status: "completed", noop: "Admin record exists" });

      // X3 and X2 by the company wallet's Ledger: the device's key is checked first.
      const calls: string[] = [];
      const x3 = await send(w, op("accept-blocklist-authority", w.company), { CHAIN_SIGNER: "usb://ledger?key=0" }, { ledger: fakeLedger(w.pairs.superAdmin.path, calls) });
      expect(x3.error ?? null).toBeNull();
      expect(calls[0]).toBe("address 44'/501'/0'");
      expect(calls[1]).toMatch(/^sign 44'\/501'\/0' [1-9A-HJ-NP-Za-km-z]{32,44}$/);
      expect(calls.at(-1)).toBe("close");
      const x2 = await send(w, op("accept-kyc-registry-authority", w.company), { CHAIN_SIGNER: "usb://ledger?key=0" }, { ledger: fakeLedger(w.pairs.superAdmin.path, []) });
      expect(x2.error ?? null).toBeNull();
      // The next step is the deployer's cycle 2; X1 before S5 has no proposal to accept.
      expect((x2.next as { deployerSteps: string[] }).deployerSteps).toEqual(["S5"]);
      const early = await dry(w, op("accept-platform-admin", w.company));
      expect(early.error).toMatch(/X1 cannot run: platform\.proposed=.* does not hold \(no live super admin proposal \(S5 of chain:bootstrap cycle 2 proposes it\)\)/);
      let state = await probeBootstrapState(rpcFor(w), w.map);
      expect(state.blocklist).toEqual({ authority: w.company, proposed: null });
      expect(state.registry?.authority).toBe(w.company);

      expect(await cycle(w)).toEqual(["S5"]);
      // S6 before S5c (and X1) is refused: any clear closes the bootstrap window.
      const s6early = await dry(w, op("first-unpause", w.company));
      expect(s6early.error).toMatch(/S6 waits for X1, S5c: each of them lands first/);
      const x1 = await send(w, op("accept-platform-admin", w.company), { CHAIN_SIGNER: "usb://ledger?key=0" }, { ledger: fakeLedger(w.pairs.superAdmin.path, []) });
      expect(x1.error ?? null).toBeNull();
      expect((x1.next as { roleSteps: unknown[] }).roleSteps).toEqual([{ id: "S5c", op: "close-bootstrap-window", key: w.company, now: true, blocker: null }]);
      state = await probeBootstrapState(rpcFor(w), w.map);
      expect(state.platform?.admin).toBe(w.company);
      expect(state.adminRecords[w.keys.deployer]).toBe(false);
      expect(await platformFlags(w)).toBe(0xff);

      const s5c = await send(w, op("close-bootstrap-window", w.company), { CHAIN_SIGNER: "usb://ledger?key=0" }, { ledger: fakeLedger(w.pairs.superAdmin.path, []) });
      expect(s5c.error ?? null).toBeNull();
      expect(await platformFlags(w)).toBe(0x7f);
      const lines6: string[] = [];
      const s6plan = await dry(w, op("first-unpause", w.company), lines6);
      expect(lines6.join("\n")).toMatch(/S6 clears exactly the role map's unpauseMask 0x01/);
      expect((s6plan.plan as { preconditions: string[] }).preconditions).toEqual(
        expect.arrayContaining([`platform.admin=${w.company}`, "X3:landed", "X2:landed", `A3:${admin}:landed`, "X1:landed", "S5c:landed"]),
      );
      const s6 = await send(w, op("first-unpause", w.company), { CHAIN_SIGNER: "usb://ledger?key=0" }, { ledger: fakeLedger(w.pairs.superAdmin.path, []) });
      expect(s6.error ?? null).toBeNull();
      // Exactly unpauseMask (0x01): the pilot areas and the payout modules stay set.
      expect(await platformFlags(w)).toBe(0x7e);
      expect((s6.next as { handover: { reason: string } }).handover.reason).toMatch(/CHAIN_HANDOVER=1/);

      const final: string[] = [];
      const plan = await runTool("bootstrap", env(w), bootstrapTool, deps(w, final));
      expect(plan.error ?? null).toBeNull();
      expect((plan.plan as { steps: unknown[]; awaiting: unknown[]; blocked: unknown[] })).toMatchObject({ steps: [], awaiting: [], blocked: [] });
      expect(final.join("\n")).toMatch(/S7 pending: set CHAIN_HANDOVER=1/);
      expect(fs.readdirSync(path.join(w.dir, "state"))).toEqual([]);
    },
    ORDER_TIMEOUT_MS,
  );

  it("separate role keys: each accept is signed by its own key and refused for any other", async () => {
    const w = await world();
    await cycle(w);
    const x3Wrong = await dry(w, op("accept-blocklist-authority", w.keys.kycAuthority));
    expect(x3Wrong.error).toMatch(/is not the role map's blocklistAuthority/);
    const x3 = await send(w, op("accept-blocklist-authority", w.keys.blocklistAuthority), { CHAIN_KEYPAIR: w.pairs.blocklistAuthority.path });
    expect(x3.error ?? null).toBeNull();
    const x2 = await send(w, op("accept-kyc-registry-authority", w.keys.kycAuthority), { CHAIN_KEYPAIR: w.pairs.kycAuthority.path });
    expect(x2.error ?? null).toBeNull();
    // The keypair file must hold the typed-out key.
    const a3plan = await dry(w, op("add-admin", w.keys.admins[0]));
    const swapped = await runTool(
      "accept",
      env(w, { ...op("add-admin", w.keys.admins[0]), CHAIN_SEND: "1", CHAIN_CONFIRM_PLAN: a3plan.planDigest as string, CHAIN_KEYPAIR: w.pairs.kycAuthority.path }),
      acceptTool,
      deps(w),
    );
    expect(swapped.error).toMatch(/keypair is not the expected key/);
    expect(w.chain.calls.filter((c) => c === "sendTransaction")).toHaveLength(6 + 2);
  }, ORDER_TIMEOUT_MS);
});

describe("chain:accept refusals", () => {
  it("X1 before A3: the accept would make the staged grant stale (6152), so it waits; S5c waits for X1", async () => {
    const w = await companyWorld();
    await cycle(w);
    // Someone proposes the super admin before the Admin's add_admin ran.
    const deployer = await signerOf(w, "deployer");
    await ledger(w, deployer, [await getProposePlatformAdminInstructionAsync({ authority: deployer, newAdmin: w.company })]);
    const x1 = await dry(w, op("accept-platform-admin", w.company));
    expect(x1.status).toBe("failed");
    expect(x1.error).toBe(`X1 waits for A3:${w.keys.admins[0]}: each of them lands first (the order of runbook §5)`);
    const s5c = await dry(w, op("close-bootstrap-window", w.company));
    expect(s5c.error).toMatch(new RegExp(`S5c waits for A3:${w.keys.admins[0]}, X1`));
    // Once A3 landed, X1 plans; its digest covers the landed A3.
    await send(w, op("add-admin", w.keys.admins[0]), { CHAIN_KEYPAIR: w.pairs.admin.path });
    const ready = await dry(w, op("accept-platform-admin", w.company));
    expect(ready.error ?? null).toBeNull();
    expect((ready.plan as { preconditions: string[] }).preconditions).toEqual([`platform.proposed=${w.company}`, `A3:${w.keys.admins[0]}:landed`, "X1:window-open"]);
  }, ORDER_TIMEOUT_MS);

  it("no proposal, a proposal to another key, an expired one and a stale Admin grant are refused before any signature", async () => {
    const w = await world();
    // Nothing deployed on chain yet beyond the programs: no BlocklistAuthority.
    const none = await dry(w, op("accept-blocklist-authority", w.keys.blocklistAuthority));
    expect(none.error).toMatch(/X3 cannot run: blocklist\.proposed=.* does not hold \(no live blocklist authority proposal \(S2b of chain:bootstrap proposes it\)\)/);
    const noGrant = await dry(w, op("add-admin", w.keys.admins[0]));
    expect(noGrant.error).toMatch(/A3:.* cannot run: pendingAdmin\(.*\) does not hold \(no live Admin grant for this key/);
    await cycle(w);

    // A stale grant: staged by a key that is not the platform admin (6152).
    const [pending] = await findPendingAdminPda({ newAdmin: w.keys.admins[0] });
    const account = w.chain.get(pending)!;
    const value = getPendingAdminDecoder().decode(account.data);
    const original = account.data;
    account.data = new Uint8Array(getPendingAdminEncoder().encode({ ...value, proposedBy: key(99) }));
    const stale = await dry(w, op("add-admin", w.keys.admins[0]));
    expect(stale.error).toMatch(/a grant staged by an earlier super admin is stale, 6152/);
    account.data = original;

    // A blocklist proposal to another key.
    const deployer = await signerOf(w, "deployer");
    await ledger(w, deployer, [await getProposeBlocklistAuthorityInstructionAsync({ authority: deployer, newAuthority: key(77) })]);
    const foreign = await dry(w, op("accept-blocklist-authority", w.keys.blocklistAuthority));
    expect(foreign.error).toMatch(new RegExp(`the pending proposal names ${key(77)}, not this key`));
    await ledger(w, deployer, [await getProposeBlocklistAuthorityInstructionAsync({ authority: deployer, newAuthority: w.keys.blocklistAuthority })]);

    // 14 days later both proposals have expired: chain:bootstrap proposes them again.
    w.chain.now += 1_209_600 + 60;
    const expired = await dry(w, op("accept-blocklist-authority", w.keys.blocklistAuthority));
    expect(expired.error).toMatch(/^X3 cannot run now: the proposal expired on .* S2b proposes it again$/);
    const kyc = await dry(w, op("accept-kyc-registry-authority", w.keys.kycAuthority));
    expect(kyc.error).toMatch(/^X2 cannot run now: the proposal expired on .* S4b proposes it again$/);
    // Only cycle 1 went through the tools (the two proposals above are direct sends).
    expect(w.chain.calls.filter((c) => c === "sendTransaction")).toHaveLength(6);
  });

  it("a send started after the window closed is refused when it plans, before the signer is loaded", async () => {
    const w = await world();
    await cycle(w);
    const extra = op("accept-blocklist-authority", w.keys.blocklistAuthority);
    const plan = await dry(w, extra);
    expect(plan.error ?? null).toBeNull();
    w.chain.now += 1_209_600 + 60;
    const late = await runTool(
      "accept",
      env(w, { ...extra, CHAIN_SEND: "1", CHAIN_CONFIRM_PLAN: plan.planDigest as string, CHAIN_KEYPAIR: w.pairs.blocklistAuthority.path }),
      acceptTool,
      deps(w),
    );
    expect(late.error).toMatch(/X3 cannot run now: the proposal expired/);
    expect(late.journal).toBeUndefined();
    expect(w.chain.calls.filter((c) => c === "sendTransaction")).toHaveLength(6);
  });

  it("a window that closes while the Ledger is open is refused at the finalized re-check (X3:window-open), before the device signs", async () => {
    const w = await world();
    await cycle(w);
    const calls: string[] = [];
    // The device answers with its key after the send planned; meanwhile the 14 days run out.
    const late = await send(w, op("accept-blocklist-authority", w.keys.blocklistAuthority), { CHAIN_SIGNER: "usb://ledger?key=0" }, {
      ledger: fakeLedger(w.pairs.blocklistAuthority.path, calls, () => {
        w.chain.now += 1_209_600 + 60;
      }),
    });
    expect(late.status).toBe("failed");
    expect(late.error).toBe("state diverged from reviewed plan at X3: X3:window-open");
    expect(calls).toEqual(["address 44'/501'/0'", "close"]);
    expect(w.chain.calls.filter((c) => c === "sendTransaction")).toHaveLength(6);
    // A refused re-check leaves no signature behind, so the lock is released.
    expect(fs.readdirSync(path.join(w.dir, "state"))).toEqual([]);
  });

  it(
    "a step it waits for that stops holding while the Ledger is open is refused at the re-check (A3:<key>:landed for X1 and S6)",
    async () => {
      const w = await companyWorld();
      const admin = w.keys.admins[0];
      const [record] = await findAdminRecordPda({ authority: admin });
      const company = { CHAIN_SIGNER: "usb://ledger?key=0" };
      const device = () => fakeLedger(w.pairs.superAdmin.path, []);
      let saved: ReturnType<typeof w.chain.get>;
      /** The second Admin's record disappears (as a remove_admin would) while the device is open. */
      const removing = (calls: string[]) =>
        fakeLedger(w.pairs.superAdmin.path, calls, () => {
          saved = w.chain.get(record);
          w.chain.accounts.delete(record);
        });
      const ok = (result: Record<string, unknown>) => expect(result.error ?? null).toBeNull();
      await cycle(w);
      ok(await send(w, op("add-admin", admin), { CHAIN_KEYPAIR: w.pairs.admin.path }));
      expect(await cycle(w)).toEqual(["S5"]);

      const x1calls: string[] = [];
      const x1 = await send(w, op("accept-platform-admin", w.company), company, { ledger: removing(x1calls) });
      expect(x1.error).toBe(`state diverged from reviewed plan at X1: A3:${admin}:landed`);
      expect(x1calls).toEqual(["address 44'/501'/0'", "close"]);
      w.chain.set(record, saved!);
      ok(await send(w, op("accept-platform-admin", w.company), company, { ledger: device() }));
      ok(await send(w, op("accept-blocklist-authority", w.company), company, { ledger: device() }));
      ok(await send(w, op("accept-kyc-registry-authority", w.company), company, { ledger: device() }));
      ok(await send(w, op("close-bootstrap-window", w.company), company, { ledger: device() }));
      const sent = w.chain.calls.filter((c) => c === "sendTransaction").length;

      const s6calls: string[] = [];
      const s6 = await send(w, op("first-unpause", w.company), company, { ledger: removing(s6calls) });
      // S6 waits for the grant's propose (S3) and its execution (A3): neither holds without the record.
      expect(s6.error).toBe(`state diverged from reviewed plan at S6: S3:${admin}:landed; A3:${admin}:landed`);
      expect(s6calls).toEqual(["address 44'/501'/0'", "close"]);
      expect(w.chain.calls.filter((c) => c === "sendTransaction")).toHaveLength(sent);
      expect(await platformFlags(w)).toBe(0x7f);
      w.chain.set(record, saved!);
      ok(await send(w, op("first-unpause", w.company), company, { ledger: device() }));
      expect(await platformFlags(w)).toBe(0x7e);
    },
    ORDER_TIMEOUT_MS,
  );

  it("S5c and S6 before S1 (no Platform yet) are refused, not recorded as done", async () => {
    const w = await companyWorld();
    for (const [name, id] of [
      ["close-bootstrap-window", "S5c"],
      ["first-unpause", "S6"],
    ]) {
      const early = await dry(w, op(name, w.company));
      expect(early.status).toBe("failed");
      expect(early.noop).toBeUndefined();
      expect(early.error).toBe(`${id} cannot run: the Platform does not exist yet (S1 of chain:bootstrap cycle 1 creates it)`);
    }
    expect(w.chain.calls).not.toContain("simulateTransaction");
  });

  it("the role step plan refuses a signer the step does not name and an underfunded key", async () => {
    const w = await world();
    await cycle(w);
    const state = await probeBootstrapState(rpcFor(w), w.map);
    await expect(planRoleStep(state, w.map, "X3", createNoopSigner(w.keys.superAdmin), rpcFor(w))).rejects.toThrow(/X3 is signed by the blocklistAuthority, not by/);
    await expect(planRoleStep(state, w.map, "S9", createNoopSigner(w.keys.superAdmin), rpcFor(w))).rejects.toThrow(/S9 is not a step of this role map's bootstrap/);
    // The new Admin pays its Admin record: an empty key is refused with the amount.
    w.chain.get(w.keys.admins[0])!.lamports = BigInt(0);
    const poor = await dry(w, op("add-admin", w.keys.admins[0]));
    expect(poor.error).toMatch(/holds 0 lamports, below the \d+ this step needs \(fee and the rent of its Admin record\)/);
  });
});

describe("chain:accept digest and signer", () => {
  it("the digest is stable, covers the role map, and a wrong digest or a Ledger with another key sends nothing", async () => {
    const w = await world();
    await cycle(w);
    const extra = op("add-admin", w.keys.admins[0]);
    const first = await dry(w, extra);
    const second = await dry(w, extra);
    expect(first.planDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(second.planDigest).toBe(first.planDigest);
    expect(first.simulation).toMatch(/simulated ok/);
    expect(first.roleMapSha256).toMatch(/^[0-9a-f]{64}$/);
    // Another op has another digest; a different role map file another one.
    const x3 = await dry(w, op("accept-blocklist-authority", w.keys.blocklistAuthority));
    expect(x3.planDigest).not.toBe(first.planDigest);
    const json = JSON.parse(fs.readFileSync(w.mapFile, "utf8"));
    fs.writeFileSync(w.mapFile, JSON.stringify({ ...json, $comment: "reviewed again" }));
    const remapped = await dry(w, extra);
    expect(remapped.planDigest).not.toBe(first.planDigest);

    const wrong = await runTool(
      "accept",
      env(w, { ...extra, CHAIN_SEND: "1", CHAIN_CONFIRM_PLAN: "0".repeat(64), CHAIN_KEYPAIR: w.pairs.admin.path }),
      acceptTool,
      deps(w),
    );
    expect(wrong.error).toMatch(/CHAIN_CONFIRM_PLAN does not match/);
    const calls: string[] = [];
    const device = await runTool(
      "accept",
      env(w, { ...extra, CHAIN_SEND: "1", CHAIN_CONFIRM_PLAN: remapped.planDigest as string, CHAIN_SIGNER: "usb://ledger?key=1" }),
      acceptTool,
      { ...deps(w), ledger: fakeLedger(w.pairs.kycAuthority.path, calls) },
    );
    expect(device.error).toMatch(/The Ledger key at 44'\/501'\/1' is .*, not the expected signer/);
    expect(calls).toEqual(["address 44'/501'/1'", "close"]);
    expect(w.chain.calls.filter((c) => c === "sendTransaction")).toHaveLength(6);
  });

  it("chain:emergency clears while the bootstrap window is open only with CHAIN_EMERGENCY_CLOSE_BOOTSTRAP=1 (recorded), and without the order: chain:accept is the bootstrap path", async () => {
    const w = await companyWorld();
    await cycle(w);
    const simulations = () => w.chain.calls.filter((c) => c === "simulateTransaction").length;
    const before = simulations();
    // Before X1 the deployer is still the super admin; an emergency clear by it
    // would close the window early (then every A3 and X1 waits 48 hours).
    const unpause = { CHAIN_EMERGENCY_OP: "unpause", CHAIN_EMERGENCY_SIGNER: w.keys.deployer, CHAIN_PAUSE_BITS: "0x80" };
    const early = await runTool("emergency", env(w, unpause), emergencyTool, deps(w));
    expect(early.status).toBe("failed");
    expect(early.error).toMatch(/^The bootstrap window is open \(0xff\): any clear closes it for good.*CHAIN_ACCEPT_OP=close-bootstrap-window, S5c.*set CHAIN_EMERGENCY_CLOSE_BOOTSTRAP=1 \(recorded\)$/);
    expect(simulations()).toBe(before);
    const forced = await runTool("emergency", env(w, { ...unpause, CHAIN_EMERGENCY_CLOSE_BOOTSTRAP: "1" }), emergencyTool, deps(w));
    expect(forced.error ?? null).toBeNull();
    expect(forced.closeBootstrapOverride).toBe(true);
    expect(forced.simulation).toMatch(/simulated ok/);
    const refused = await dry(w, op("close-bootstrap-window", w.company));
    expect(refused.error).toMatch(/S5c waits for A3:.*, X1/);
  });
});

describe("chain:accept on mainnet", () => {
  async function mainnetWorld() {
    const w = await world();
    await cycle(w);
    const json = await roleMapJson(w.keys, "mainnet", CLUSTER_GENESIS_HASHES.mainnet, { programDataMaxLen: CAPACITY });
    const mapFile = path.join(w.dir, "role-map.mainnet.json");
    fs.writeFileSync(mapFile, JSON.stringify(json));
    w.chain.genesis = CLUSTER_GENESIS_HASHES.mainnet;
    return { w, mapFile };
  }
  const mainnetEnv = (w: World, mapFile: string, extra: ChainEnv) => {
    const { CHAIN_STATE_DIR: _state, ...rest } = env(w, { CHAIN_NETWORK: "mainnet", CHAIN_ALLOW_MAINNET: "1", CHAIN_ROLE_MAP: mapFile, ...extra });
    void _state;
    return rest;
  };

  it("needs a clean guarded source and the live canonical IDL, with no override; then plans with the reviewed digest", async () => {
    const { w, mapFile } = await mainnetWorld();
    const extra = op("add-admin", w.keys.admins[0]);
    const dirty = [" M front/scripts/chain/lib/accept.ts"];
    const opts = { ...deps(w), home: w.dir };
    const refused = await runTool("accept", mainnetEnv(w, mapFile, { ...extra, CHAIN_EMERGENCY_DIRTY_OK: "1" }), acceptTool, { ...opts, sourceDirty: () => dirty });
    // The live Release tag predates chain:accept: the refusals name the reviewed commit instead.
    expect(refused.error).toMatch(/uncommitted changes under front\/idl, front\/lib, front\/scripts\/chain.* \(1 paths\): run from a clean checkout of the reviewed chain:accept commit/);
    expect(String(refused.error).endsWith(`: run from a clean checkout of ${ACCEPT_CHECKOUT}`)).toBe(true);
    expect(refused.sourceDirtyOverride).toBeUndefined();
    const clean = { ...opts, sourceDirty: () => [] };
    const noIdl = await runTool("accept", mainnetEnv(w, mapFile, { ...extra, CHAIN_EMERGENCY_IDL_UNCHECKED: "1" }), acceptTool, clean);
    expect(noIdl.error).toMatch(/cannot confirm add_admin against front\/idl \(no-canonical-idl\); run the checkout of the reviewed chain:accept commit/);
    expect(String(noIdl.error).endsWith(`; run the checkout of ${ACCEPT_CHECKOUT}`)).toBe(true);
    await seedIdl(w, REGISTRY, localIdl("asset_registry"));
    const plan = await runTool("accept", mainnetEnv(w, mapFile, extra), acceptTool, clean);
    expect(plan.error ?? null).toBeNull();
    expect(plan.status).toBe("awaiting");
    expect((plan.idl as { check: string }).check).toBe("match");
    expect(plan.simulation).toMatch(/simulated ok/);
    // Sending on mainnet needs a priority fee, like every chain tool.
    await expect(
      runTool("accept", mainnetEnv(w, mapFile, { ...extra, CHAIN_SEND: "1", CHAIN_CONFIRM_PLAN: plan.planDigest as string, CHAIN_SIGNER: "usb://ledger?key=0" }), acceptTool, clean),
    ).rejects.toThrow(/CHAIN_CU_PRICE is required/);
  });
});
