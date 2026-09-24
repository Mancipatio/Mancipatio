import fs from "node:fs";
import path from "node:path";
import {
  AccountRole,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getAddressEncoder,
  getBase58Decoder,
  getBase58Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Instruction,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { describe, expect, it } from "vitest";
import { runTool } from "@/scripts/chain/lib/context";
import { LOADER_V3 } from "@/scripts/chain/lib/loader-v3";
import { pmWrite } from "@/scripts/chain/lib/program-metadata";
import { type ChainEnv } from "@/scripts/chain/lib/safety";
import {
  MULTISIG_DISCRIMINATOR,
  SQUADS_V4_PROGRAM,
  assertOnlyVaultSigner,
  checkSquadsAccount,
  decodeMultisig,
  encodeVaultTransaction,
  inspectExternalTransaction,
  splitBySize,
  squadsVaultPda,
} from "@/scripts/chain/lib/squads";
import { assertSquadsVerified, squadsExportTool } from "@/scripts/chain/lib/squads-export";
import { HOOK, REGISTRY, key, rent } from "./helpers/chain-fake";
import { deps, env, releaseDir, world, type World } from "./helpers/chain-world";

const fixture = JSON.parse(fs.readFileSync(path.resolve(__dirname, "fixtures/squads-multisig-v4.json"), "utf8"));
const blockhash = { blockhash: "11111111111111111111111111111111" as never, lastValidBlockHeight: BigInt(100) };

type Exported = {
  header: { preconditions: string[]; postconditions: string[]; feePayer: string };
  transactions: {
    index: number;
    executeOrder: string;
    messageBytes: number;
    instructions: { program: string; accounts: { address: string; signer: boolean; writable: boolean }[]; dataBase58: string; dataBase64: string }[];
    transactionBase58: string;
    transactionBase64: string;
  }[];
};

async function handedOver(): Promise<World> {
  const w = await world();
  await w.chain.deployProgram(REGISTRY, { authority: w.keys.vault, payload: new Uint8Array([1, 2, 3]), capacity: 4096 });
  await w.chain.deployProgram(HOOK, { authority: w.keys.vault, payload: new Uint8Array([4, 5, 6]), capacity: 2048 });
  return w;
}

function input(w: World, value: unknown): string {
  const file = path.join(w.dir, `input-${w.outputs + 1}.json`);
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

async function exportOp(w: World, op: string, value: unknown, extra: ChainEnv = {}) {
  return runTool("squads-export", env(w, { CHAIN_SQUADS_OP: op, CHAIN_SQUADS_INPUT: input(w, value), ...extra }), squadsExportTool, deps(w));
}

function loaderBuffer(w: World, address: Address, authority: Address, payload: Uint8Array) {
  const data = new Uint8Array(37 + payload.length);
  new DataView(data.buffer).setUint32(0, 1, true);
  data[4] = 1;
  data.set(getAddressEncoder().encode(authority), 5);
  data.set(payload, 37);
  w.chain.set(address, { owner: LOADER_V3, lamports: rent(data.length), data });
}

describe("Squads v4 multisig decoder (EXTERNAL #4)", () => {
  it("decodes the synthesized v4 account fixture", () => {
    const decoded = decodeMultisig(new Uint8Array(Buffer.from(fixture.dataBase64, "base64")));
    expect({
      ...decoded,
      transactionIndex: decoded.transactionIndex.toString(),
      staleTransactionIndex: decoded.staleTransactionIndex.toString(),
    }).toEqual(fixture.expected);
    expect(fixture.owner).toBe(SQUADS_V4_PROGRAM);
    expect([...MULTISIG_DISCRIMINATOR]).toEqual([224, 116, 121, 186, 68, 161, 79, 236]);
  });

  it("refuses a wrong discriminator, truncation and unknown permission bits", () => {
    const bytes = new Uint8Array(Buffer.from(fixture.dataBase64, "base64"));
    const wrong = new Uint8Array(bytes);
    wrong[0] ^= 1;
    expect(() => decodeMultisig(wrong)).toThrow(/Not a Squads v4 Multisig/);
    expect(() => decodeMultisig(bytes.subarray(0, 120))).toThrow(/truncated/);
    const bits = new Uint8Array(bytes);
    bits[bits.length - 1] = 0x08;
    expect(() => decodeMultisig(bits)).toThrow(/Unknown permission bits/);
  });

  it("checks owner, vault derivation and the exact config against the map", async () => {
    const w = await world();
    const account = w.chain.get(w.keys.multisig)!;
    expect((await checkSquadsAccount(account, w.map.squads)).ok).toBe(true);
    expect((await checkSquadsAccount({ ...account, owner: key(3) }, w.map.squads)).errors.join()).toMatch(/not the Squads v4 program/);
    expect((await checkSquadsAccount(account, { ...w.map.squads, threshold: 3 })).errors.join()).toMatch(/threshold 2 ≠ map 3/);
    expect((await checkSquadsAccount(account, { ...w.map.squads, timeLock: 60 })).errors.join()).toMatch(/time_lock 0 ≠ map 60/);
    expect((await checkSquadsAccount(account, { ...w.map.squads, configAuthority: key(4) })).errors.join()).toMatch(/config_authority none ≠ map/);
    const narrower = { ...w.map.squads, members: w.map.squads.members.map((m, i) => (i ? m : { ...m, permissions: ["vote"] })) };
    expect((await checkSquadsAccount(account, narrower)).errors.join()).toMatch(/permissions initiate\+vote\+execute ≠ map vote/);
    expect((await checkSquadsAccount(account, { ...w.map.squads, vault: key(5) })).errors.join()).toMatch(/vault is not PDA/);
    expect((await checkSquadsAccount(null, w.map.squads)).errors.join()).toMatch(/multisig account not found/);
    expect(await squadsVaultPda(w.keys.multisig, 0)).toBe(w.keys.vault);
  });

  it("an unverified config is refused, overridable off mainnet only", async () => {
    const w = await world();
    const bad = await checkSquadsAccount(w.chain.get(w.keys.multisig)!, { ...w.map.squads, threshold: 3 });
    expect(() => assertSquadsVerified(bad, "devnet", false)).toThrow(/does not match the role map/);
    expect(assertSquadsVerified(bad, "devnet", true)).toBe("unverified");
    expect(() => assertSquadsVerified(bad, "mainnet", true)).toThrow(/does not match the role map/);
  });
});

describe("vault transactions", () => {
  it("only the vault may sign; the vault pays", async () => {
    const vault = key(40);
    const other = createNoopSigner(key(41));
    const ix = pmWrite({ buffer: key(42), authority: other, offset: 0, data: new Uint8Array([1]) });
    expect(() => assertOnlyVaultSigner([ix], vault)).toThrow(/Only the Squads vault may sign/);
    expect(() => encodeVaultTransaction({ vault, ixs: [ix], blockhash })).toThrow(/Only the Squads vault may sign/);
    const ok = pmWrite({ buffer: key(42), authority: createNoopSigner(vault), offset: 0, data: new Uint8Array([1]) });
    const encoded = encodeVaultTransaction({ vault, ixs: [ok], blockhash });
    const tx = getTransactionDecoder().decode(getBase58Encoder().encode(encoded.transactionBase58));
    const message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    expect(message.version).toBe("legacy");
    expect(message.staticAccounts[0]).toBe(vault);
    expect(message.header.numSignerAccounts).toBe(1);
    expect(Object.values(tx.signatures).every((sig) => sig === null || sig.every((b) => b === 0))).toBe(true);
  });

  it("splits by the 800-byte inner budget, keeps order, refuses one oversized instruction", () => {
    const vault = key(40);
    const signer = createNoopSigner(vault);
    const ixs: Instruction[] = Array.from({ length: 6 }, (_, i) =>
      pmWrite({ buffer: key(50 + i), authority: signer, offset: i, data: new Uint8Array(150).fill(i) }),
    );
    const groups = splitBySize(ixs, vault, blockhash);
    expect(groups.length).toBeGreaterThan(1);
    expect(groups.flat()).toEqual(ixs);
    for (const group of groups) expect(encodeVaultTransaction({ vault, ixs: group, blockhash }).messageBytes).toBeLessThanOrEqual(800);
    const huge = pmWrite({ buffer: key(60), authority: signer, offset: 0, data: new Uint8Array(900) });
    expect(() => splitBySize([huge], vault, blockhash)).toThrow(/exceeds the Squads inner message budget/);
  });
});

describe("chain:squads-export ops", () => {
  it("upgrade: one vault transaction, hook before registry, buffers checked against the Release", async () => {
    const w = await handedOver();
    const release = releaseDir();
    loaderBuffer(w, key(70), w.keys.vault, new Uint8Array([4, 5, 6]));
    loaderBuffer(w, key(71), w.keys.vault, new Uint8Array([1, 2, 3]));
    const evidence = await exportOp(w, "upgrade", { buffers: { assetRegistry: key(71), transferHook: key(70) } }, { CHAIN_RELEASE_DIR: release });
    expect(evidence.error ?? null).toBeNull();
    const exported = evidence.export as Exported;
    expect(exported.transactions).toHaveLength(1);
    const [hookUpgrade, registryUpgrade] = exported.transactions[0].instructions;
    expect(hookUpgrade.program).toBe(LOADER_V3);
    expect(hookUpgrade.accounts[1].address).toBe(HOOK);
    expect(registryUpgrade.accounts[1].address).toBe(REGISTRY);
    expect(hookUpgrade.accounts[3].address).toBe(w.keys.bufferWriter);
    expect(hookUpgrade.dataBase64).toBe(Buffer.from([3, 0, 0, 0]).toString("base64"));
    expect(exported.header.feePayer).toBe(w.keys.vault);
    expect(exported.header.preconditions.join("\n")).toMatch(/bytes = Release .so/);
  });

  it("upgrade preconditions: buffer authority, buffer bytes, capacity and the UA", async () => {
    const w = await handedOver();
    const release = releaseDir();
    loaderBuffer(w, key(72), w.keys.deployer, new Uint8Array([4, 5, 6]));
    expect((await exportOp(w, "upgrade", { buffers: { transferHook: key(72) } }, { CHAIN_RELEASE_DIR: release })).error).toMatch(/buffer authority .* not the vault/);
    loaderBuffer(w, key(73), w.keys.vault, new Uint8Array([4, 5, 7]));
    expect((await exportOp(w, "upgrade", { buffers: { transferHook: key(73) } }, { CHAIN_RELEASE_DIR: release })).error).toMatch(/buffer bytes differ from the Release/);
    const big = releaseDir({}, { transfer_hook: new Uint8Array(4000).fill(1) });
    loaderBuffer(w, key(74), w.keys.vault, new Uint8Array(4000).fill(1));
    expect((await exportOp(w, "upgrade", { buffers: { transferHook: key(74) } }, { CHAIN_RELEASE_DIR: big })).error).toMatch(/export extend-program first/);
    await w.chain.deployProgram(HOOK, { authority: w.keys.deployer, payload: new Uint8Array([4, 5, 6]), capacity: 2048 });
    loaderBuffer(w, key(75), w.keys.vault, new Uint8Array([4, 5, 6]));
    expect((await exportOp(w, "upgrade", { buffers: { transferHook: key(75) } }, { CHAIN_RELEASE_DIR: release })).error).toMatch(/upgrade authority .* not the vault/);
  });

  it("extend-program enforces the SIMD-0431 minimum and uses ExtendProgramChecked", async () => {
    const w = await handedOver();
    expect((await exportOp(w, "extend-program", { program: "transfer_hook", bytes: 10_239 })).error).toMatch(/≥ 10240 \(SIMD-0431\)/);
    const ok = await exportOp(w, "extend-program", { program: "transfer_hook", bytes: 10_240 });
    expect(ok.error ?? null).toBeNull();
    const ix = (ok.export as Exported).transactions[0].instructions[0];
    expect(Buffer.from(ix.dataBase64, "base64").toString("hex")).toBe("0900000000280000");
    expect(ix.accounts.filter((a) => a.signer).map((a) => a.address)).toEqual([w.keys.vault, w.keys.vault]);
  });

  it("set-upgrade-authority to none needs confirmImmutable", async () => {
    const w = await handedOver();
    expect((await exportOp(w, "set-upgrade-authority", { programs: ["transfer_hook"], newAuthority: null })).error).toMatch(/confirmImmutable/);
    const ok = await exportOp(w, "set-upgrade-authority", { programs: ["transfer_hook"], newAuthority: null, confirmImmutable: true });
    expect(ok.error ?? null).toBeNull();
    expect((ok.export as Exported).transactions[0].instructions[0].accounts).toHaveLength(2);
  });

  it("registry-ix: only the allowlist, built with the vault as signer", async () => {
    const w = await handedOver();
    expect((await exportOp(w, "registry-ix", { instruction: "close_sale", args: {} })).error).toMatch(/registry-ix instruction must be one of/);
    const ok = await exportOp(w, "registry-ix", { instruction: "add_admin", args: { newAdmin: key(80) } });
    expect(ok.error ?? null).toBeNull();
    const ix = (ok.export as Exported).transactions[0].instructions[0];
    expect(ix.program).toBe(REGISTRY);
    expect(ix.accounts.filter((a) => a.signer).map((a) => a.address)).toEqual([w.keys.vault]);
  });

  it("wrap-external: only verify/System programs and the vault as sole signer; re-emitted with a fresh blockhash", async () => {
    const w = await handedOver();
    const vaultSigner = createNoopSigner(w.keys.vault);
    const external = (ixs: Instruction[], feePayer: Address = w.keys.vault) =>
      getBase58Decoder().decode(
        getTransactionEncoder().encode(
          compileTransaction(
            pipe(
              createTransactionMessage({ version: "legacy" }),
              (m) => setTransactionMessageFeePayer(feePayer, m),
              (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
              (m) => appendTransactionMessageInstructions(ixs, m),
            ),
          ),
        ),
      );
    const transfer = getTransferSolInstruction({ source: vaultSigner, destination: key(81), amount: BigInt(5) });
    const ok = await exportOp(w, "wrap-external", { transactionBase58: external([transfer]) });
    expect(ok.error ?? null).toBeNull();
    const reemitted = (ok.export as Exported).transactions[0];
    expect(reemitted.instructions[0].program).toBe("11111111111111111111111111111111");
    expect(reemitted.transactionBase58).not.toBe(external([transfer]));

    const foreign: Instruction = { programAddress: key(82), accounts: [{ address: w.keys.vault, role: AccountRole.WRITABLE_SIGNER }], data: new Uint8Array([1]) };
    expect((await exportOp(w, "wrap-external", { transactionBase58: external([foreign]) })).error).toMatch(/only the verify and System programs/);
    const other = createNoopSigner(key(83));
    const twoSigners = getTransferSolInstruction({ source: other, destination: key(81), amount: BigInt(5) });
    expect((await exportOp(w, "wrap-external", { transactionBase58: external([transfer, twoSigners]) })).error).toMatch(/vault as its only signer/);
    expect(() => inspectExternalTransaction("not-base58!", w.keys.vault)).toThrow(/not a base58 wire transaction/);
  });

  it("refuses when the multisig does not match the role map (override off mainnet only)", async () => {
    const w = await handedOver();
    await w.chain.seedMultisig({ multisig: w.keys.multisig, threshold: 3, members: w.keys.members.map((k) => ({ key: k, mask: 7 })) });
    const refused = await exportOp(w, "extend-program", { program: "transfer_hook", bytes: 10_240 });
    expect(refused.status).toBe("failed");
    expect(refused.error).toMatch(/does not match the role map: threshold 3 ≠ map 2/);
    const overridden = await exportOp(w, "extend-program", { program: "transfer_hook", bytes: 10_240 }, { CHAIN_SQUADS_CONFIG_UNVERIFIED: "1" });
    expect(overridden.status).toBe("completed");
  });

  it("never loads a keypair and never sends", async () => {
    const w = await handedOver();
    await exportOp(w, "extend-program", { program: "transfer_hook", bytes: 10_240 });
    expect(w.chain.calls).not.toContain("sendTransaction");
    expect(w.chain.calls).not.toContain("simulateTransaction");
  });
});
