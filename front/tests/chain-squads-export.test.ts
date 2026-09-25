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
  getProgramDerivedAddress,
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
import {
  COMPUTE_BUDGET_PROGRAM_ADDRESS,
  setComputeUnitLimitInstruction,
  setComputeUnitPriceInstruction,
} from "@/lib/compute-budget";
import { runTool } from "@/scripts/chain/lib/context";
import { LOADER_V3, programDataAddress } from "@/scripts/chain/lib/loader-v3";
import { pmWrite } from "@/scripts/chain/lib/program-metadata";
import { type ChainEnv } from "@/scripts/chain/lib/safety";
import {
  MAX_EXTERNAL_TRANSFER_LAMPORTS,
  MULTISIG_DISCRIMINATOR,
  OTTERSEC_VERIFY_PROGRAM,
  SQUADS_V4_PROGRAM,
  assertOnlyVaultSigner,
  OTTER_VERIFY_IX,
  checkSquadsAccount,
  decodeMultisig,
  decodeVerifyInstructionData,
  encodeVaultTransaction,
  encodeVerifyInstructionData,
  inspectExternalTransaction,
  otterVerifyPda,
  splitBySize,
  squadsVaultPda,
  verifyParamProblems,
  type VerifyParams,
} from "@/scripts/chain/lib/squads";
import { assertSquadsVerified, squadsExportTool } from "@/scripts/chain/lib/squads-export";
import { HOOK, REGISTRY, key, rent } from "./helpers/chain-fake";
import { deps, env, releaseDir, seedIdl, world, type World } from "./helpers/chain-world";

const fixture = JSON.parse(fs.readFileSync(path.resolve(__dirname, "fixtures/squads-multisig-v4.json"), "utf8"));
const blockhash = { blockhash: "11111111111111111111111111111111" as never, lastValidBlockHeight: BigInt(100) };
/** discriminator, create_key, config_authority, threshold, time_lock, 2 × u64, rent_collector None, bump, member count. */
const MULTISIG_HEADER = 8 + 32 + 32 + 2 + 4 + 8 + 8 + 1 + 1 + 4;
/** The Release base image of the test Release (tests/helpers/chain-world releaseDir). */
const BASE_IMAGE = "solanafoundation/solana-verifiable-build:3.1.13";
/** Build arguments as `solana-verify export-pda-tx … --base-image <image>` stores them. */
function verifyParams(library: string, overrides: Partial<VerifyParams> = {}): VerifyParams {
  return {
    version: "0.5.1",
    gitUrl: "https://github.com/Mancipatio/Mancipatio",
    commit: "a".repeat(40),
    args: ["--mount-path", "program", "--library-name", library, "--base-image", BASE_IMAGE],
    deployedSlot: BigInt(4000),
    ...overrides,
  };
}

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
  it("decodes the real v4 account dump from the 6.1 rehearsal", () => {
    const bytes = new Uint8Array(Buffer.from(fixture.dataBase64, "base64"));
    const decoded = decodeMultisig(bytes);
    expect({
      ...decoded,
      transactionIndex: decoded.transactionIndex.toString(),
      staleTransactionIndex: decoded.staleTransactionIndex.toString(),
    }).toEqual(fixture.expected);
    expect(fixture.owner).toBe(SQUADS_V4_PROGRAM);
    expect([...MULTISIG_DISCRIMINATOR]).toEqual([224, 116, 121, 186, 68, 161, 79, 236]);
    // Sized for Some(rent_collector): 32 unused zero bytes after the members.
    expect(bytes.length).toBe(MULTISIG_HEADER + 32 + 33 * decoded.members.length);
    expect(bytes.subarray(bytes.length - 32).every((b) => b === 0)).toBe(true);
    // Squads keeps the members sorted by key.
    const raw = decoded.members.map((m) => Buffer.from(getAddressEncoder().encode(m.key)));
    expect(raw).toEqual([...raw].sort(Buffer.compare));
  });

  it("refuses a wrong discriminator, truncation and unknown permission bits", () => {
    const bytes = new Uint8Array(Buffer.from(fixture.dataBase64, "base64"));
    const wrong = new Uint8Array(bytes);
    wrong[0] ^= 1;
    expect(() => decodeMultisig(wrong)).toThrow(/Not a Squads v4 Multisig/);
    expect(() => decodeMultisig(bytes.subarray(0, 120))).toThrow(/truncated/);
    const bits = new Uint8Array(bytes);
    // The last member's mask byte (the account ends in 32 bytes of Option space).
    bits[MULTISIG_HEADER + 33 * 3 - 1] = 0x08;
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
    expect((await exportOp(w, "upgrade", { buffers: { transferHook: key(74) } }, { CHAIN_RELEASE_DIR: big })).error).toMatch(/extend it first with solana program extend/);
    await w.chain.deployProgram(HOOK, { authority: w.keys.deployer, payload: new Uint8Array([4, 5, 6]), capacity: 2048 });
    loaderBuffer(w, key(75), w.keys.vault, new Uint8Array([4, 5, 6]));
    expect((await exportOp(w, "upgrade", { buffers: { transferHook: key(75) } }, { CHAIN_RELEASE_DIR: release })).error).toMatch(/upgrade authority .* not the vault/);
  });

  it("extend-program is refused: a vault cannot extend a program (EXTERNAL #2, 6.1 rehearsal)", async () => {
    const w = await handedOver();
    const refused = await exportOp(w, "extend-program", { program: "transfer_hook", bytes: 10_240 });
    expect(refused.status).toBe("failed");
    expect(refused.error).toMatch(/cannot extend transfer_hook: loader-v3 ExtendProgram is not callable through CPI/);
    expect(refused.error).toContain(`solana program extend ${HOOK} <bytes ≥ 10240>`);
    expect(refused.export).toBeUndefined();
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

  it("wrap-external: vault-signed verify instructions for our programs; System only as a capped transfer into the derived verify PDA", async () => {
    const w = await handedOver();
    const vault = w.keys.vault;
    const vaultSigner = createNoopSigner(vault);
    const external = (ixs: Instruction[], feePayer: Address = vault) =>
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
    const pda = await otterVerifyPda(vault, REGISTRY);
    const hookPda = await otterVerifyPda(vault, HOOK);
    const SYSTEM = "11111111111111111111111111111111" as Address;
    const verify = (
      opts: { program?: Address; withVault?: boolean; pda?: Address | null; extra?: { address: Address; role: AccountRole }[] } = {},
    ): Instruction => {
      const program = opts.program ?? REGISTRY;
      const target = opts.pda === undefined ? pda : opts.pda;
      const library = program === HOOK ? "transfer_hook" : "asset_registry";
      return {
        programAddress: OTTERSEC_VERIFY_PROGRAM,
        accounts: [
          ...(target ? [{ address: target, role: AccountRole.WRITABLE }] : []),
          ...(opts.withVault === false ? [] : [{ address: vault, role: AccountRole.WRITABLE_SIGNER }]),
          { address: program, role: AccountRole.READONLY },
          { address: SYSTEM, role: AccountRole.READONLY },
          ...(opts.extra ?? []),
        ],
        data: encodeVerifyInstructionData("initialize", verifyParams(library)),
      };
    };
    const wrap = (ixs: Instruction[]) => exportOp(w, "wrap-external", { transactionBase58: external(ixs) });
    const transfer = (destination: Address, amount = BigInt(2_000_000)) =>
      getTransferSolInstruction({ source: vaultSigner, destination, amount });

    // The PDA is ("otter_verify", uploader, program) under the verify program.
    expect(pda).toBe(
      (
        await getProgramDerivedAddress({
          programAddress: OTTERSEC_VERIFY_PROGRAM,
          seeds: [new TextEncoder().encode("otter_verify"), getAddressEncoder().encode(vault), getAddressEncoder().encode(REGISTRY)],
        })
      )[0],
    );
    expect(hookPda).not.toBe(pda);

    const ok = await wrap([verify()]);
    expect(ok.error ?? null).toBeNull();
    const reemitted = (ok.export as Exported).transactions[0];
    expect(reemitted.instructions[0].program).toBe(OTTERSEC_VERIFY_PROGRAM);
    expect(reemitted.transactionBase58).not.toBe(external([verify()]));
    const okPre = (ok.export as Exported).header.preconditions.join("\n");
    expect(okPre).toMatch(new RegExp(`for ${REGISTRY}.*\\n.*${REGISTRY} → ${pda}.*\\n.*no top-level System instruction`));

    const funded = await wrap([transfer(pda), verify()]);
    expect(funded.error ?? null).toBeNull();
    expect((funded.export as Exported).header.preconditions.join("\n")).toMatch(new RegExp(`2000000 lamports → ${pda} \\(PDA of ${REGISTRY}\\)`));
    // The initialize-with-signer shape also names the program's ProgramData (read-only).
    const withProgramData = await wrap([verify({ extra: [{ address: await programDataAddress(REGISTRY), role: AccountRole.READONLY }] })]);
    expect(withProgramData.error ?? null).toBeNull();

    // A tampered transaction: the vault (the treasury, D5) pays someone else.
    const theft = transfer(key(81), BigInt(5));
    expect((await wrap([theft, verify()])).error).toMatch(/only a transfer from the vault into the derived verify PDA/);
    expect((await wrap([theft])).error).toMatch(/no verify instruction/);
    // The same theft with the attacker's key added to the verify instruction's
    // accounts (roles are message-wide, so "writable in a verify instruction"
    // is not a proof of being the PDA): refused by the closed account set.
    const attacker = key(86);
    const bypass = [
      transfer(attacker, MAX_EXTERNAL_TRANSFER_LAMPORTS),
      verify({ extra: [{ address: attacker, role: AccountRole.WRITABLE }] }),
    ];
    expect((await wrap(bypass)).error).toMatch(new RegExp(`has the account ${attacker}, which is not the vault`));
    await expect(inspectExternalTransaction(external(bypass), vault, [REGISTRY, HOOK])).rejects.toThrow(/not the vault, a referenced program/);
    // Accounts that are allowed in the verify instruction but are not the PDA
    // never receive a transfer: ProgramData, our program ID, the other
    // program's PDA (not carried by any verify instruction).
    const programData = await programDataAddress(REGISTRY);
    const intoProgramData = [transfer(programData), verify({ extra: [{ address: programData, role: AccountRole.READONLY }] })];
    expect((await wrap(intoProgramData)).error).toMatch(/only a transfer from the vault into the derived verify PDA/);
    expect((await wrap([transfer(REGISTRY), verify()])).error).toMatch(/only a transfer from the vault into the derived verify PDA/);
    expect((await wrap([transfer(hookPda), verify()])).error).toMatch(/only a transfer from the vault into the derived verify PDA/);
    // A PDA derived for another uploader is not in the account set.
    const foreignPda = await otterVerifyPda(key(81), REGISTRY);
    expect((await wrap([verify({ pda: foreignPda })])).error).toMatch(new RegExp(`has the account ${foreignPda}`));
    // Every verify instruction carries the PDA of a program it references.
    expect((await wrap([verify({ pda: null })])).error).toMatch(/does not carry the verify PDA/);
    expect((await wrap([verify({ pda: hookPda })])).error).toMatch(new RegExp(`has the account ${hookPda}`));
    const tooMuch = transfer(pda, MAX_EXTERNAL_TRANSFER_LAMPORTS + BigInt(1));
    expect((await wrap([tooMuch, verify()])).error).toMatch(/at most 50000000 are allowed/);
    const assign = getAssignInstruction({ account: vaultSigner, programAddress: key(84) });
    expect((await wrap([assign, verify()])).error).toMatch(/System instruction other than a transfer/);
    expect((await wrap([verify({ program: key(85) })])).error).toMatch(/none of our program IDs/);
    expect((await wrap([verify({ withVault: false })])).error).toMatch(/does not name the vault/);

    // solana-verify export-pda-tx 0.5.1 prepends SetComputeUnitPrice(100000) by
    // default (6.1 rehearsal): dropped from the vault transaction and reported.
    const priced = await wrap([setComputeUnitPriceInstruction(BigInt(100_000)), setComputeUnitLimitInstruction(200_000), verify()]);
    expect(priced.error ?? null).toBeNull();
    expect((priced.export as Exported).transactions[0].instructions.map((ix) => ix.program)).toEqual([OTTERSEC_VERIFY_PROGRAM]);
    expect((priced.export as Exported).header.preconditions.join("\n")).toMatch(/dropped SetComputeUnitPrice\(100000\), SetComputeUnitLimit\(200000\)/);
    const inspected = await inspectExternalTransaction(external([setComputeUnitPriceInstruction(BigInt(1)), verify()]), vault, [REGISTRY]);
    expect(inspected.droppedComputeBudget).toEqual([{ kind: "price", microLamports: BigInt(1) }]);
    expect(inspected.instructions.map((ix) => ix.programAddress)).toEqual([OTTERSEC_VERIFY_PROGRAM]);
    // Any other ComputeBudget instruction (RequestHeapFrame, or one with accounts) is refused.
    const heap: Instruction = { programAddress: COMPUTE_BUDGET_PROGRAM_ADDRESS, data: new Uint8Array([1, 0, 0, 4, 0]) };
    expect((await wrap([heap, verify()])).error).toMatch(/ComputeBudget instruction other than SetComputeUnitLimit or SetComputeUnitPrice/);
    const withAccount: Instruction = { ...setComputeUnitPriceInstruction(BigInt(5)), accounts: [{ address: key(81), role: AccountRole.WRITABLE }] };
    expect((await wrap([withAccount, verify()])).error).toMatch(/ComputeBudget instruction other than/);

    const foreign: Instruction = { programAddress: key(82), accounts: [{ address: vault, role: AccountRole.WRITABLE_SIGNER }], data: new Uint8Array([1]) };
    expect((await wrap([foreign, verify()])).error).toMatch(/only the verify and System programs/);
    const other = createNoopSigner(key(83));
    const twoSigners = getTransferSolInstruction({ source: other, destination: key(81), amount: BigInt(5) });
    expect((await wrap([verify(), twoSigners])).error).toMatch(/vault as its only signer/);
    await expect(inspectExternalTransaction("not-base58!", vault, [REGISTRY])).rejects.toThrow(/not a base58 wire transaction/);
  });

  it("verify instruction data: initialize/update/close as solana-verify 0.5.1 builds them", () => {
    // The instruction data of the 6.1 rehearsal's export-pda-tx for asset_registry (no --base-image).
    const rehearsal = Buffer.from(
      "afaf6d1f0d989bed05000000302e352e312800000068747470733a2f2f6769746875622e636f6d2f4d616e6369706174" +
        "696f2f4d616e6369706174696f2800000065356334643161653165323034383033643237353262376632663865643932" +
        "626365333739323337040000000c0000002d2d6d6f756e742d706174680700000070726f6772616d0e0000002d2d6c69" +
        "62726172792d6e616d650e00000061737365745f7265676973747279b901000000000000",
      "hex",
    );
    const decoded = decodeVerifyInstructionData(new Uint8Array(rehearsal));
    expect(decoded).toEqual({
      kind: "initialize",
      params: {
        version: "0.5.1",
        gitUrl: "https://github.com/Mancipatio/Mancipatio",
        commit: "e5c4d1ae1e204803d2752b7f2f8ed92bce379237",
        args: ["--mount-path", "program", "--library-name", "asset_registry"],
        deployedSlot: BigInt(441),
      },
    });
    // Without --base-image the remote build infers another image: refused.
    const expected = { libraryName: "asset_registry", commit: "e5c4d1ae1e204803d2752b7f2f8ed92bce379237", baseImage: BASE_IMAGE };
    if (decoded.kind === "close") throw new Error("unreachable");
    expect(verifyParamProblems(decoded.params, expected)).toEqual([
      "--base-image is missing (the remote build would infer another image from Cargo.lock)",
    ]);
    const params = verifyParams("asset_registry");
    for (const kind of ["initialize", "update"] as const) {
      expect(decodeVerifyInstructionData(encodeVerifyInstructionData(kind, params))).toEqual({ kind, params });
    }
    expect(decodeVerifyInstructionData(OTTER_VERIFY_IX.close)).toEqual({ kind: "close" });
    expect(() => decodeVerifyInstructionData(Uint8Array.of(...OTTER_VERIFY_IX.close, 0))).toThrow(/unexpected data/);
    expect(() => decodeVerifyInstructionData(new Uint8Array([1, 2, 3]))).toThrow(/not initialize, update or close/);
    const data = encodeVerifyInstructionData("initialize", params);
    expect(() => decodeVerifyInstructionData(Uint8Array.of(...data, 0))).toThrow(/trailing bytes/);
    expect(() => decodeVerifyInstructionData(data.subarray(0, data.length - 1))).toThrow(/truncated/);
  });

  it("verify build arguments must reproduce the Release: mount path, library, base image, commit", () => {
    const expected = { libraryName: "transfer_hook", commit: "b".repeat(40), baseImage: BASE_IMAGE };
    const ok = verifyParams("transfer_hook", { commit: "b".repeat(40) });
    expect(verifyParamProblems(ok, expected)).toEqual([]);
    expect(verifyParamProblems({ ...ok, args: [...ok.args, "--arch", "v3"] }, expected)).toEqual([]);
    const problems = (args: string[], overrides: Partial<VerifyParams> = {}) => verifyParamProblems({ ...ok, args, ...overrides }, expected);
    expect(problems(["--mount-path", "program", "--library-name", "asset_registry", "--base-image", BASE_IMAGE])).toEqual([
      "--library-name is asset_registry, not transfer_hook",
    ]);
    expect(problems(["--library-name", "transfer_hook", "--base-image", BASE_IMAGE])).toEqual(["--mount-path is missing, not program"]);
    expect(problems([...ok.args.slice(0, 4), "--base-image", "solanafoundation/solana-verifiable-build:3.0.1"])).toEqual([
      `--base-image is solanafoundation/solana-verifiable-build:3.0.1, not the Release's ${BASE_IMAGE}`,
    ]);
    expect(problems([...ok.args, "--bpf"])).toEqual(['unexpected build argument "--bpf" (only --mount-path, --library-name, --base-image, --arch)']);
    expect(problems([...ok.args, "--", "--features", "x"])[0]).toMatch(/unexpected build argument "--"/);
    expect(problems([...ok.args, "--arch", "v9"])).toEqual(["--arch v9 is not v0..v3"]);
    expect(problems([...ok.args, "--base-image", BASE_IMAGE])).toEqual(["--base-image is given twice"]);
    expect(problems([...ok.args.slice(0, 4), "--base-image"])).toEqual([
      "--base-image has no value",
      "--base-image is missing (the remote build would infer another image from Cargo.lock)",
    ]);
    expect(problems(ok.args, { commit: "c".repeat(40) })).toEqual([`commit ${"c".repeat(40)} is not the Release commit ${"b".repeat(40)}`]);
    expect(problems(ok.args, { commit: "HEAD" })).toEqual(['commit "HEAD" is not a full 40-hex commit']);
    // Without a Release, the base image must still be pinned.
    expect(verifyParamProblems(ok, { libraryName: "transfer_hook", commit: null, baseImage: null })).toEqual([]);
    expect(verifyParamProblems({ ...ok, args: ok.args.slice(0, 4) }, { libraryName: "transfer_hook", commit: null, baseImage: null })).toEqual([
      "--base-image is missing (the remote build would infer another image from Cargo.lock)",
    ]);
  });

  it("wrap-external refuses verify args that would not reproduce the Release, and a stale deployed_slot", async () => {
    const w = await handedOver();
    const vault = w.keys.vault;
    const release = releaseDir();
    const pda = await otterVerifyPda(vault, HOOK);
    const verifyIx = (params: VerifyParams, kind: "initialize" | "update" = "initialize"): Instruction => ({
      programAddress: OTTERSEC_VERIFY_PROGRAM,
      accounts: [
        { address: pda, role: AccountRole.WRITABLE },
        { address: vault, role: AccountRole.READONLY_SIGNER },
        { address: HOOK, role: AccountRole.READONLY },
        { address: "11111111111111111111111111111111" as Address, role: AccountRole.READONLY },
      ],
      data: encodeVerifyInstructionData(kind, params),
    });
    const closeIx: Instruction = {
      programAddress: OTTERSEC_VERIFY_PROGRAM,
      accounts: [
        { address: pda, role: AccountRole.WRITABLE },
        { address: vault, role: AccountRole.READONLY_SIGNER },
        { address: HOOK, role: AccountRole.READONLY },
      ],
      data: OTTER_VERIFY_IX.close,
    };
    const external = (ix: Instruction) =>
      getBase58Decoder().decode(
        getTransactionEncoder().encode(
          compileTransaction(
            pipe(
              createTransactionMessage({ version: "legacy" }),
              (m) => setTransactionMessageFeePayer(vault, m),
              (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
              (m) => appendTransactionMessageInstructions([setComputeUnitPriceInstruction(BigInt(100_000)), ix], m),
            ),
          ),
        ),
      );
    const wrap = (ix: Instruction, withRelease = true) =>
      exportOp(w, "wrap-external", { transactionBase58: external(ix) }, withRelease ? { CHAIN_RELEASE_DIR: release } : {});

    const ok = await wrap(verifyIx(verifyParams("transfer_hook")));
    expect(ok.error ?? null).toBeNull();
    expect((ok.export as Exported).header.preconditions.join("\n")).toContain(
      `transfer_hook verify initialize: https://github.com/Mancipatio/Mancipatio at ${"a".repeat(40)}, build args [--mount-path program --library-name transfer_hook --base-image ${BASE_IMAGE}], deployed_slot 4000, solana-verify 0.5.1 (commit and base image = the Release's hashes.txt)`,
    );
    const noRelease = await wrap(verifyIx(verifyParams("transfer_hook")), false);
    expect((noRelease.export as Exported).header.preconditions.join("\n")).toContain("(not checked against a Release: no CHAIN_RELEASE_DIR)");
    expect((await wrap(verifyIx(verifyParams("transfer_hook"), "update"))).error ?? null).toBeNull();

    // What export-pda-tx writes without --base-image (the 6.1 rehearsal's PDAs).
    const unpinned = await wrap(verifyIx(verifyParams("transfer_hook", { args: ["--mount-path", "program", "--library-name", "transfer_hook"] })));
    expect(unpinned.status).toBe("failed");
    expect(unpinned.error).toMatch(/transfer_hook verify initialize: --base-image is missing/);
    expect(unpinned.export).toBeUndefined();
    expect((await wrap(verifyIx(verifyParams("transfer_hook", { commit: "d".repeat(40) })))).error).toMatch(/is not the Release commit/);
    expect((await wrap(verifyIx(verifyParams("asset_registry")))).error).toMatch(/--library-name is asset_registry, not transfer_hook/);
    // deployed_slot must be the ProgramData's last deploy slot (4000 in the fake).
    expect((await wrap(verifyIx(verifyParams("transfer_hook", { deployedSlot: BigInt(3999) })))).error).toMatch(
      /deployed_slot 3999 is not the ProgramData's last deploy slot 4000/,
    );
    // A close carries no build arguments.
    const closed = await wrap(closeIx);
    expect(closed.error ?? null).toBeNull();
    expect((closed.export as Exported).header.preconditions.join("\n")).toContain(`transfer_hook: close the verify PDA ${pda}`);
    // One verify instruction per program.
    const both: Instruction = {
      ...verifyIx(verifyParams("transfer_hook")),
      accounts: [...verifyIx(verifyParams("transfer_hook")).accounts!, { address: REGISTRY, role: AccountRole.READONLY }],
    };
    expect((await wrap(both)).error).toMatch(/more than one of our program IDs/);
  });

  it("refuses when the multisig does not match the role map (override off mainnet only)", async () => {
    const w = await handedOver();
    await w.chain.seedMultisig({ multisig: w.keys.multisig, threshold: 3, members: w.keys.members.map((k) => ({ key: k, mask: 7 })) });
    const immutable = { programs: ["transfer_hook"], newAuthority: null, confirmImmutable: true };
    const refused = await exportOp(w, "set-upgrade-authority", immutable);
    expect(refused.status).toBe("failed");
    expect(refused.error).toMatch(/does not match the role map: threshold 3 ≠ map 2/);
    const overridden = await exportOp(w, "set-upgrade-authority", immutable, { CHAIN_SQUADS_CONFIG_UNVERIFIED: "1" });
    expect(overridden.status).toBe("completed");
  });

  it("never loads a keypair and never sends", async () => {
    const w = await handedOver();
    await exportOp(w, "set-upgrade-authority", { programs: ["transfer_hook"], newAuthority: null, confirmImmutable: true });
    expect(w.chain.calls).not.toContain("sendTransaction");
    expect(w.chain.calls).not.toContain("simulateTransaction");
  });
});
