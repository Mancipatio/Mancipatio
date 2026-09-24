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
import { getAssignInstruction, getTransferSolInstruction } from "@solana-program/system";
import { describe, expect, it } from "vitest";
import { runTool } from "@/scripts/chain/lib/context";
import { LOADER_V3 } from "@/scripts/chain/lib/loader-v3";
import { pmWrite } from "@/scripts/chain/lib/program-metadata";
import { type ChainEnv } from "@/scripts/chain/lib/safety";
import {
  MAX_EXTERNAL_TRANSFER_LAMPORTS,
  MULTISIG_DISCRIMINATOR,
  OTTERSEC_VERIFY_PROGRAM,
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
import { deps, env, releaseDir, seedIdl, world, type World } from "./helpers/chain-world";

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
    const ok = await exportOp(w, "registry-ix", { instruction: "add_admin", args: { newAdmin: w.keys.admins[0] } });
    expect(ok.error ?? null).toBeNull();
    const ix = (ok.export as Exported).transactions[0].instructions[0];
    expect(ix.program).toBe(REGISTRY);
    expect(ix.accounts.filter((a) => a.signer).map((a) => a.address)).toEqual([w.keys.vault]);
    expect((ok.export as Exported).header.preconditions.join("\n")).toMatch(/is in role-map admins/);
  });

  it("registry-ix: arguments are checked against the role map (targets, treasury, fee, masks)", async () => {
    const w = await handedOver();
    const run = (instruction: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      exportOp(w, "registry-ix", { instruction, args, ...extra });
    // Targets outside the map need an explicit confirmTarget; hot keys never.
    expect((await run("add_admin", { newAdmin: key(80) })).error).toMatch(/not the role-map key .*confirmTarget/);
    expect((await run("add_admin", { newAdmin: key(80) }, { confirmTarget: key(80) })).error ?? null).toBeNull();
    expect((await run("add_admin", { newAdmin: w.keys.deployer }, { confirmTarget: w.keys.deployer })).error).toMatch(/hot key/);
    expect((await run("add_admin", { newAdmin: w.keys.kycAuthority }, { confirmTarget: w.keys.kycAuthority })).error).toMatch(/allowKycAdmin/);
    expect((await run("propose_platform_admin", { newAdmin: key(88) })).error).toMatch(/not the role-map key/);
    expect((await run("propose_platform_admin", { newAdmin: w.keys.superAdmin })).error ?? null).toBeNull();
    expect((await run("initialize_blocklist_authority", { authority: key(87) })).error).toMatch(/not the role-map key/);
    expect((await run("initialize_blocklist_authority", {})).error ?? null).toBeNull();
    expect((await run("set_protocol_treasury", { newTreasury: key(89) })).error).toMatch(/not the role-map key/);
    // initialize_platform: treasury = vault and fee = map (no setter).
    expect((await run("initialize_platform", { protocolTreasury: key(86) })).error).toMatch(/must be the role-map treasury/);
    expect((await run("initialize_platform", { protocolFeeBps: 5 })).error).toMatch(/must equal the role-map protocolFeeBps 0/);
    expect((await run("initialize_platform", { protocolFeeBps: "0" })).error).toMatch(/must equal the role-map protocolFeeBps/);
    const platform = await run("initialize_platform", {});
    expect(platform.error ?? null).toBeNull();
    expect((platform.export as Exported).header.preconditions.join("\n")).toMatch(/protocol fee 0 bps = role map/);
    // Pause masks: integers 0..255, no coercion, not both zero.
    expect((await run("set_pause_flags", { clearMask: "all" })).error).toMatch(/clearMask must be an integer from 0 to 255/);
    expect((await run("set_pause_flags", { setMask: 0x13f })).error).toMatch(/setMask must be an integer from 0 to 255/);
    expect((await run("set_pause_flags", { setMask: 1.5 })).error).toMatch(/setMask must be an integer/);
    expect((await run("set_pause_flags", {})).error).toMatch(/both masks 0 changes nothing/);
    const resume = await run("set_pause_flags", { clearMask: 0x3f });
    expect(resume.error ?? null).toBeNull();
    expect((resume.export as Exported).header.preconditions.join("\n")).toMatch(/pause set 0x00 .*clear 0x3f \(Onboarding/);
  });

  it("set-upgrade-authority and metadata-set-authority: hot keys refused, a new key must be confirmed", async () => {
    const w = await handedOver();
    const op = "set-upgrade-authority";
    expect((await exportOp(w, op, { programs: ["transfer_hook"], newAuthority: key(90) })).error).toMatch(/confirmNewAuthority/);
    expect((await exportOp(w, op, { programs: ["transfer_hook"], newAuthority: w.keys.deployer, confirmNewAuthority: w.keys.deployer })).error).toMatch(/hot key/);
    expect((await exportOp(w, op, { programs: ["transfer_hook"], newAuthority: w.keys.vault })).error).toMatch(/already the vault/);
    const moved = await exportOp(w, op, { programs: ["transfer_hook"], newAuthority: key(90), confirmNewAuthority: key(90) });
    expect(moved.error ?? null).toBeNull();
    expect((moved.export as Exported).header.postconditions).toEqual([`transfer_hook: upgrade authority = ${key(90)}`]);

    await seedIdl(w, HOOK, new Uint8Array(Buffer.from(JSON.stringify({ address: HOOK }))));
    const meta = "metadata-set-authority";
    expect((await exportOp(w, meta, { program: "transfer_hook", newAuthority: key(91) })).error).toMatch(/not the role-map metadataAuthority/);
    expect((await exportOp(w, meta, { program: "transfer_hook", newAuthority: w.keys.bufferWriter, confirmNewAuthority: w.keys.bufferWriter })).error).toMatch(/hot key/);
    expect((await exportOp(w, meta, { program: "transfer_hook", newAuthority: key(91), confirmNewAuthority: key(91) })).error ?? null).toBeNull();
    expect((await exportOp(w, meta, { program: "transfer_hook", newAuthority: null })).error ?? null).toBeNull();
  });

  it("extend-program refuses more bytes than the 10 MiB account limit leaves", async () => {
    const w = await handedOver();
    expect((await exportOp(w, "extend-program", { program: "transfer_hook", bytes: 2 ** 32 })).error).toMatch(/exceed the \d+ B left under the 10 MiB/);
    expect((await exportOp(w, "extend-program", { program: "transfer_hook", bytes: 10 * 1024 * 1024 - 45 - 2048 })).error ?? null).toBeNull();
  });

  it("wrap-external: vault-signed verify instructions for our programs; System only as a capped transfer into the verify PDA", async () => {
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
    const pda = key(90);
    const verify = (program: Address = REGISTRY, withVault = true): Instruction => ({
      programAddress: OTTERSEC_VERIFY_PROGRAM,
      accounts: [
        { address: pda, role: AccountRole.WRITABLE },
        ...(withVault ? [{ address: w.keys.vault, role: AccountRole.WRITABLE_SIGNER }] : []),
        { address: program, role: AccountRole.READONLY },
        { address: "11111111111111111111111111111111" as Address, role: AccountRole.READONLY },
      ],
      data: new Uint8Array([1, 2, 3]),
    });
    const wrap = (ixs: Instruction[]) => exportOp(w, "wrap-external", { transactionBase58: external(ixs) });

    const ok = await wrap([verify()]);
    expect(ok.error ?? null).toBeNull();
    const reemitted = (ok.export as Exported).transactions[0];
    expect(reemitted.instructions[0].program).toBe(OTTERSEC_VERIFY_PROGRAM);
    expect(reemitted.transactionBase58).not.toBe(external([verify()]));
    expect((ok.export as Exported).header.preconditions.join("\n")).toMatch(new RegExp(`for ${REGISTRY}.*\\n.*no top-level System instruction`));

    const rent = getTransferSolInstruction({ source: vaultSigner, destination: pda, amount: BigInt(2_000_000) });
    const funded = await wrap([rent, verify()]);
    expect(funded.error ?? null).toBeNull();
    expect((funded.export as Exported).header.preconditions.join("\n")).toMatch(new RegExp(`2000000 lamports → ${pda}`));

    // A tampered transaction: the vault (the treasury, D5) pays someone else.
    const theft = getTransferSolInstruction({ source: vaultSigner, destination: key(81), amount: BigInt(5) });
    expect((await wrap([theft, verify()])).error).toMatch(/not into a verify-instruction account/);
    expect((await wrap([theft])).error).toMatch(/no verify instruction/);
    const tooMuch = getTransferSolInstruction({ source: vaultSigner, destination: pda, amount: MAX_EXTERNAL_TRANSFER_LAMPORTS + BigInt(1) });
    expect((await wrap([tooMuch, verify()])).error).toMatch(/at most 50000000 are allowed/);
    const assign = getAssignInstruction({ account: vaultSigner, programAddress: key(84) });
    expect((await wrap([assign, verify()])).error).toMatch(/System instruction other than a transfer/);
    expect((await wrap([verify(key(85))])).error).toMatch(/none of our program IDs/);
    expect((await wrap([verify(REGISTRY, false)])).error).toMatch(/does not name the vault/);

    const foreign: Instruction = { programAddress: key(82), accounts: [{ address: w.keys.vault, role: AccountRole.WRITABLE_SIGNER }], data: new Uint8Array([1]) };
    expect((await wrap([foreign, verify()])).error).toMatch(/only the verify and System programs/);
    const other = createNoopSigner(key(83));
    const twoSigners = getTransferSolInstruction({ source: other, destination: key(81), amount: BigInt(5) });
    expect((await wrap([verify(), twoSigners])).error).toMatch(/vault as its only signer/);
    expect(() => inspectExternalTransaction("not-base58!", w.keys.vault, [REGISTRY])).toThrow(/not a base58 wire transaction/);
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
