// lib/kyc-registry-creation (Talas 3.1 K5): the dual-signed create_kyc_registry
// envelope. Real keypairs sign a locally rebuilt transaction; the RPC is an
// in-memory mock (no network).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  address,
  generateKeyPairSigner,
  getBase58Decoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  type Address,
  type KeyPairSigner,
} from "@solana/kit";

const mocks = vi.hoisted(() => ({ admin: vi.fn() }));
vi.mock("@/lib/generated/asset_registry", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchMaybeAdmin: mocks.admin,
}));

import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  findKycRegistryPda,
  getCreateKycRegistryInstructionDataDecoder,
} from "@/lib/generated/asset_registry";
import { CLUSTER_GENESIS_HASHES } from "@/lib/network-identity";
import {
  COMPUTE_BUDGET_PROGRAM_ADDRESS,
  decodeComputeBudgetInstruction,
  setComputeUnitLimitInstruction,
  setComputeUnitPriceInstruction,
} from "@/lib/compute-budget";
import { SEND_OVERHEAD_INSTRUCTIONS } from "@/lib/issuer-authority";
import { jurisdictionBitmap } from "@/lib/jurisdiction-bitmap";
import {
  DEFAULT_COMPUTE_UNIT_LIMIT,
  DEFAULT_MAINNET_CU_PRICE,
  MAX_ENVELOPE_CU_PRICE,
  compileKycRegistryCreation,
  defaultComputeBudget,
  inspectKycRegistryCreation,
  kycRegistryCreationSigned,
  parseKycRegistryCreation,
  prepareKycRegistryCreation,
  signKycRegistryCreation,
  submitKycRegistryCreation,
  type KycRegistryCreationEnvelope,
} from "@/lib/kyc-registry-creation";

const APPROVED = [40, 276, 688, 724];
const BLOCKED = [408, 364];

type Genesis = () => string;

function mockRpc(state: { registryExists: boolean; blockhashValid: boolean; genesis: Genesis }) {
  const sendTransaction = vi.fn((wire: string) => (void wire, { send: async () => "signature" }));
  const rpc = {
    getGenesisHash: () => ({ send: async () => state.genesis() }),
    isBlockhashValid: () => ({ send: async () => ({ value: state.blockhashValid }) }),
    getLatestBlockhash: () => ({
      send: async () => ({
        value: { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: BigInt(100) },
      }),
    }),
    getAccountInfo: () => ({
      send: async () => ({
        context: { slot: BigInt(1) },
        value: state.registryExists
          ? {
              data: ["", "base64"],
              executable: false,
              lamports: BigInt(1),
              owner: ASSET_REGISTRY_PROGRAM_ADDRESS,
              space: BigInt(0),
              rentEpoch: BigInt(0),
            }
          : null,
      }),
    }),
    sendTransaction,
  } as unknown as Parameters<typeof prepareKycRegistryCreation>[0];
  return { rpc, sendTransaction };
}

function adminRecord(admin: Address, owner: Address = ASSET_REGISTRY_PROGRAM_ADDRESS) {
  return { exists: true, programAddress: owner, data: { admin } };
}

async function fixture(opts: { sameKey?: boolean; network?: "devnet" | "mainnet"; pinned?: "registry" | null } = {}) {
  const network = opts.network ?? "devnet";
  const kyc = await generateKeyPairSigner();
  const admin: KeyPairSigner = opts.sameKey ? kyc : await generateKeyPairSigner();
  mocks.admin.mockResolvedValue(adminRecord(admin.address));
  const state = {
    registryExists: false,
    blockhashValid: true,
    genesis: (() => CLUSTER_GENESIS_HASHES[network]) as Genesis,
  };
  const { rpc, sendTransaction } = mockRpc(state);
  const [registry] = await findKycRegistryPda({ authority: kyc.address });
  const pinned = opts.pinned === "registry" ? registry : null;
  const envelope = await prepareKycRegistryCreation(
    rpc,
    network,
    { kycAuthority: kyc.address, adminAuthority: admin.address, approved: [724, 40, 688, 276, 688], blocked: BLOCKED },
    { pinned },
  );
  return { kyc, admin, rpc, state, sendTransaction, envelope, registry, pinned, network };
}

// Signing and sending read the maintenance flag in the browser first (fail
// closed); by default the site is not in maintenance.
const flag = vi.hoisted(() => ({
  state: { enabled: false, message: null } as { enabled: boolean; message: string | null } | "down",
}));
const maintenanceFetch = vi.fn(async () => {
  if (flag.state === "down") throw new TypeError("Failed to fetch");
  return Response.json({ ...flag.state, network: "devnet" });
});
beforeEach(() => {
  vi.clearAllMocks();
  flag.state = { enabled: false, message: null };
  vi.stubGlobal("window", { dispatchEvent: () => true });
  vi.stubGlobal("fetch", maintenanceFetch);
});
afterEach(() => vi.unstubAllGlobals());

function decodeSent(sendTransaction: ReturnType<typeof vi.fn>) {
  const tx = getTransactionDecoder().decode(getBase64Encoder().encode(sendTransaction.mock.calls[0][0] as string));
  const message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  return { tx, message };
}

describe("compute budget helper", () => {
  it("encodes the same bytes the send path measures, and decodes them back", () => {
    expect(Array.from(setComputeUnitLimitInstruction(0).data!)).toEqual(Array.from(SEND_OVERHEAD_INSTRUCTIONS[0].data!));
    expect(Array.from(setComputeUnitPriceInstruction(BigInt(0)).data!)).toEqual(
      Array.from(SEND_OVERHEAD_INSTRUCTIONS[1].data!),
    );
    expect(decodeComputeBudgetInstruction(setComputeUnitLimitInstruction(100_000))).toEqual({ kind: "limit", units: 100_000 });
    expect(decodeComputeBudgetInstruction(setComputeUnitPriceInstruction(BigInt(12345)))).toEqual({
      kind: "price",
      microLamports: BigInt(12345),
    });
    expect(() => setComputeUnitLimitInstruction(1_400_001)).toThrow();
    expect(() => setComputeUnitLimitInstruction(1.5)).toThrow();
    expect(() => setComputeUnitPriceInstruction(BigInt(-1))).toThrow();
    expect(decodeComputeBudgetInstruction({ programAddress: ASSET_REGISTRY_PROGRAM_ADDRESS, data: [2, 0, 0, 0, 0] })).toBeNull();
  });

  it("defaults: 100k units; price 0 off mainnet, a capped constant on mainnet", () => {
    expect(defaultComputeBudget("devnet")).toEqual({ computeUnitLimit: DEFAULT_COMPUTE_UNIT_LIMIT, computeUnitPriceMicroLamports: "0" });
    expect(defaultComputeBudget("localnet").computeUnitPriceMicroLamports).toBe("0");
    expect(BigInt(defaultComputeBudget("mainnet").computeUnitPriceMicroLamports)).toBe(DEFAULT_MAINNET_CU_PRICE);
    expect(DEFAULT_MAINNET_CU_PRICE <= MAX_ENVELOPE_CU_PRICE).toBe(true);
  });
});

describe("dual-signed create_kyc_registry", () => {
  it("prepares canonical terms: sorted unique codes, the derived registry, default budget", async () => {
    const f = await fixture();
    expect(f.envelope.approved).toEqual([40, 276, 688, 724]);
    expect(f.envelope.blocked).toEqual([364, 408]);
    expect(f.envelope.registry).toBe(f.registry);
    expect(f.envelope.computeUnitLimit).toBe(DEFAULT_COMPUTE_UNIT_LIMIT);
    expect(f.envelope.computeUnitPriceMicroLamports).toBe("0");
    expect(f.envelope.signatures).toEqual({});
  });

  it("two keys: both must sign; the fee payer is the KYC authority; compute budget first; bitmaps rebuilt", async () => {
    const f = await fixture();
    const one = await signKycRegistryCreation(f.rpc, f.envelope, f.kyc, { pinned: null });
    expect(kycRegistryCreationSigned(one)).toBe(false);
    await expect(submitKycRegistryCreation(f.rpc, one, { pinned: null })).rejects.toThrow();
    expect(f.sendTransaction).not.toHaveBeenCalled();
    const imported = await parseKycRegistryCreation(JSON.stringify(one), "devnet");
    const two = await signKycRegistryCreation(f.rpc, imported, f.admin, { pinned: null });
    expect(kycRegistryCreationSigned(two)).toBe(true);
    await submitKycRegistryCreation(f.rpc, two, { pinned: null });
    expect(f.sendTransaction).toHaveBeenCalledOnce();
    const { tx, message } = decodeSent(f.sendTransaction);
    expect(message.staticAccounts[0]).toBe(f.kyc.address);
    expect(Object.keys(tx.signatures).sort()).toEqual([f.kyc.address, f.admin.address].sort());
    expect(Object.values(tx.signatures).every(Boolean)).toBe(true);
    expect(message.instructions).toHaveLength(3);
    const [limit, price, create] = message.instructions;
    for (const ix of [limit, price]) expect(message.staticAccounts[ix.programAddressIndex]).toBe(COMPUTE_BUDGET_PROGRAM_ADDRESS);
    expect(decodeComputeBudgetInstruction({ programAddress: COMPUTE_BUDGET_PROGRAM_ADDRESS, data: limit.data })).toEqual({
      kind: "limit",
      units: DEFAULT_COMPUTE_UNIT_LIMIT,
    });
    expect(decodeComputeBudgetInstruction({ programAddress: COMPUTE_BUDGET_PROGRAM_ADDRESS, data: price.data })).toEqual({
      kind: "price",
      microLamports: BigInt(0),
    });
    expect(message.staticAccounts[create.programAddressIndex]).toBe(ASSET_REGISTRY_PROGRAM_ADDRESS);
    const data = getCreateKycRegistryInstructionDataDecoder().decode(create.data!);
    expect(Array.from(data.approvedJurisdictions)).toEqual(Array.from(jurisdictionBitmap(APPROVED)));
    expect(Array.from(data.blockedJurisdictions)).toEqual(Array.from(jurisdictionBitmap(BLOCKED)));
    expect(create.accountIndices?.map((i) => message.staticAccounts[i])).toContain(f.registry);
  });

  it("the same key for both roles signs once", async () => {
    const f = await fixture({ sameKey: true });
    const signed = await signKycRegistryCreation(f.rpc, f.envelope, f.kyc, { pinned: null });
    expect(Object.keys(signed.signatures)).toEqual([f.kyc.address]);
    expect(kycRegistryCreationSigned(signed)).toBe(true);
    await submitKycRegistryCreation(f.rpc, signed, { pinned: null });
    const { tx } = decodeSent(f.sendTransaction);
    expect(Object.keys(tx.signatures)).toEqual([f.kyc.address]);
  });

  it("carries the reviewed compute budget into the transaction", async () => {
    const f = await fixture();
    const custom = await prepareKycRegistryCreation(
      f.rpc,
      "devnet",
      {
        kycAuthority: f.kyc.address,
        adminAuthority: f.admin.address,
        approved: APPROVED,
        blocked: BLOCKED,
        computeUnitLimit: 60_000,
        computeUnitPriceMicroLamports: "2500",
      },
      { pinned: null },
    );
    const tx = await compileKycRegistryCreation(custom);
    const message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    const decoded = message.instructions
      .slice(0, 2)
      .map((ix) => decodeComputeBudgetInstruction({ programAddress: message.staticAccounts[ix.programAddressIndex], data: ix.data }));
    expect(decoded).toEqual([
      { kind: "limit", units: 60_000 },
      { kind: "price", microLamports: BigInt(2500) },
    ]);
  });

  it("tampered codes or fees, and forged signatures, fail verification", async () => {
    const f = await fixture();
    const one = await signKycRegistryCreation(f.rpc, f.envelope, f.kyc, { pinned: null });
    await expect(compileKycRegistryCreation({ ...one, approved: [40, 276, 688] })).rejects.toThrow("does not match");
    await expect(compileKycRegistryCreation({ ...one, blocked: [364] })).rejects.toThrow("does not match");
    await expect(compileKycRegistryCreation({ ...one, computeUnitPriceMicroLamports: "1" })).rejects.toThrow("does not match");
    await expect(compileKycRegistryCreation({ ...one, computeUnitLimit: 99_999 })).rejects.toThrow("does not match");
    await expect(
      compileKycRegistryCreation({
        ...one,
        signatures: { [f.kyc.address]: getBase58Decoder().decode(new Uint8Array(64).fill(1)) },
      }),
    ).rejects.toThrow("does not match");
    // A wallet adapter that signs other bytes is caught before the document changes.
    const wrong = await f.admin.signTransactions([await compileKycRegistryCreation({ ...f.envelope, approved: [40] })]);
    await expect(
      signKycRegistryCreation(f.rpc, f.envelope, { address: f.admin.address, signTransactions: async () => wrong }, { pinned: null }),
    ).rejects.toThrow("does not match");
  });

  it("an imported document is refused at inspection when a stored signature does not verify", async () => {
    const f = await fixture();
    const one = await signKycRegistryCreation(f.rpc, f.envelope, f.kyc, { pinned: null });
    // The genuine document passes inspection with its signature.
    const ok = await inspectKycRegistryCreation(JSON.stringify(one), "devnet");
    expect(ok.signatures[f.kyc.address]).toBe(one.signatures[f.kyc.address]);
    // A forged signature, or a genuine one over other terms, is refused here
    // (before any review or Submit), not only at sign / submit time.
    const forged = { ...one, signatures: { [f.kyc.address]: getBase58Decoder().decode(new Uint8Array(64).fill(1)) } };
    await expect(inspectKycRegistryCreation(JSON.stringify(forged), "devnet")).rejects.toThrow("does not match");
    await expect(
      inspectKycRegistryCreation(JSON.stringify({ ...one, blocked: [364] }), "devnet"),
    ).rejects.toThrow("does not match");
    // Inspection never sends anything.
    expect(f.sendTransaction).not.toHaveBeenCalled();
  });

  it("parse rejects bad documents", async () => {
    const f = await fixture();
    const raw = (over: Partial<Record<keyof KycRegistryCreationEnvelope, unknown>>) =>
      JSON.stringify({ ...f.envelope, ...over });
    const bad: [string, string, RegExp][] = [
      ["too large", JSON.stringify({ ...f.envelope, pad: "x".repeat(17_000) }), /too large/],
      ["not JSON", "{", /not valid JSON/],
      ["another network", raw({ network: "mainnet" }), /another network/],
      ["another genesis", raw({ genesisHash: CLUSTER_GENESIS_HASHES.testnet }), /another network/],
      ["another kind", raw({ kind: "recover_issuer" }), /kind/],
      ["invalid address", raw({ adminAuthority: "not-a-key" }), /Admin co-signer is not a valid address/],
      ["default address", raw({ kycAuthority: "11111111111111111111111111111111" }), /default address/],
      ["wrong registry", raw({ registry: f.admin.address }), /not the address the KYC authority creates/],
      ["code 0", raw({ approved: [0, 40] }), /outside 1..1023/],
      ["code 1024", raw({ blocked: [1024] }), /outside 1..1023/],
      ["fractional code", raw({ approved: [40.5] }), /outside 1..1023/],
      ["unsorted", raw({ approved: [276, 40] }), /sorted/],
      ["duplicate", raw({ approved: [40, 40] }), /sorted/],
      ["overlap", raw({ approved: [40, 364], blocked: [364] }), /both approved and blocked/],
      ["limit 0", raw({ computeUnitLimit: 0 }), /compute unit limit/],
      ["limit too high", raw({ computeUnitLimit: 1_400_001 }), /compute unit limit/],
      ["price too high", raw({ computeUnitPriceMicroLamports: (MAX_ENVELOPE_CU_PRICE + BigInt(1)).toString() }), /compute unit price/],
      ["price not canonical", raw({ computeUnitPriceMicroLamports: "01" }), /compute unit price/],
      ["price as number", raw({ computeUnitPriceMicroLamports: 5 }), /compute unit price/],
      ["bad height", raw({ lastValidBlockHeight: "-1" }), /block height/],
      ["unexpected signer", raw({ signatures: { [f.registry]: "1".repeat(64) } }), /Unexpected registry creation signer/],
    ];
    for (const [label, doc, message] of bad) {
      await expect(parseKycRegistryCreation(doc, "devnet"), label).rejects.toThrow(message);
    }
    // Unknown extra fields never reach the rebuilt transaction.
    const extra = await parseKycRegistryCreation(raw({ instructions: ["transfer"] } as never), "devnet");
    expect(Object.keys(extra)).not.toContain("instructions");
  });

  it("re-checks the live state before preparing, signing and sending", async () => {
    // Registry already exists.
    const a = await fixture();
    a.state.registryExists = true;
    await expect(signKycRegistryCreation(a.rpc, a.envelope, a.kyc, { pinned: null })).rejects.toThrow("already exists");
    // Co-signer lost its Admin record, or the record is foreign-owned / names another key.
    const b = await fixture();
    mocks.admin.mockResolvedValue({ exists: false });
    await expect(signKycRegistryCreation(b.rpc, b.envelope, b.kyc, { pinned: null })).rejects.toThrow("no active Admin record");
    mocks.admin.mockResolvedValue(adminRecord(b.admin.address, b.kyc.address));
    await expect(signKycRegistryCreation(b.rpc, b.envelope, b.kyc, { pinned: null })).rejects.toThrow("no active Admin record");
    mocks.admin.mockResolvedValue(adminRecord(b.kyc.address));
    await expect(signKycRegistryCreation(b.rpc, b.envelope, b.kyc, { pinned: null })).rejects.toThrow("no active Admin record");
    // A pin that is another registry.
    const c = await fixture();
    await expect(
      signKycRegistryCreation(c.rpc, c.envelope, c.kyc, { pinned: address("SysvarRent111111111111111111111111111111111") }),
    ).rejects.toThrow("not the pinned platform registry");
    // Expired blockhash.
    const d = await fixture();
    d.state.blockhashValid = false;
    await expect(submitKycRegistryCreation(d.rpc, d.envelope, { pinned: null })).rejects.toThrow("expired");
    expect(d.sendTransaction).not.toHaveBeenCalled();
  });

  it("mainnet requires the pin, and the pin must be this registry", async () => {
    await expect(fixture({ network: "mainnet", pinned: null })).rejects.toThrow(/Mainnet requires the pinned platform registry/);
    const f = await fixture({ network: "mainnet", pinned: "registry" });
    expect(f.envelope.network).toBe("mainnet");
    expect(BigInt(f.envelope.computeUnitPriceMicroLamports)).toBe(DEFAULT_MAINNET_CU_PRICE);
  });

  it("only the two named keys, with a sign-without-send wallet, may sign", async () => {
    const f = await fixture();
    const stranger = await generateKeyPairSigner();
    await expect(signKycRegistryCreation(f.rpc, f.envelope, stranger, { pinned: null })).rejects.toThrow(
      "Connect the KYC authority or the Admin co-signer",
    );
    const sendOnly = { address: f.kyc.address, signAndSendTransactions: async () => [] } as never;
    await expect(signKycRegistryCreation(f.rpc, f.envelope, sendOnly, { pinned: null })).rejects.toThrow(
      "signing without sending",
    );
  });

  it("in maintenance, neither prompts the wallet nor sends", async () => {
    const f = await fixture();
    const one = await signKycRegistryCreation(f.rpc, f.envelope, f.kyc, { pinned: null });
    const two = await signKycRegistryCreation(f.rpc, one, f.admin, { pinned: null });
    flag.state = { enabled: true, message: "Program upgrade" };
    const signer = { address: f.admin.address, signTransactions: vi.fn(f.admin.signTransactions) };
    await expect(signKycRegistryCreation(f.rpc, f.envelope, signer, { pinned: null })).rejects.toThrow(
      "Manci is in maintenance: Program upgrade",
    );
    expect(signer.signTransactions).not.toHaveBeenCalled();
    await expect(submitKycRegistryCreation(f.rpc, two, { pinned: null })).rejects.toThrow("Manci is in maintenance");
    expect(f.sendTransaction).not.toHaveBeenCalled();
  });

  it("fails closed when the maintenance flag cannot be read (the server never sees this send)", async () => {
    const f = await fixture();
    const one = await signKycRegistryCreation(f.rpc, f.envelope, f.kyc, { pinned: null });
    const two = await signKycRegistryCreation(f.rpc, one, f.admin, { pinned: null });
    flag.state = "down";
    await expect(submitKycRegistryCreation(f.rpc, two, { pinned: null })).rejects.toThrow("could not confirm");
    maintenanceFetch.mockResolvedValueOnce(new Response("{}", { status: 503 }));
    await expect(signKycRegistryCreation(f.rpc, f.envelope, f.admin, { pinned: null })).rejects.toThrow("could not confirm");
    expect(f.sendTransaction).not.toHaveBeenCalled();
    flag.state = { enabled: false, message: null };
    await submitKycRegistryCreation(f.rpc, two, { pinned: null });
    expect(f.sendTransaction).toHaveBeenCalledOnce();
  });

  it("submit needs every signature and re-verifies the network right before sending", async () => {
    const f = await fixture();
    const one = await signKycRegistryCreation(f.rpc, f.envelope, f.kyc, { pinned: null });
    await expect(submitKycRegistryCreation(f.rpc, one, { pinned: null })).rejects.toThrow();
    const two = await signKycRegistryCreation(f.rpc, one, f.admin, { pinned: null });
    // The live check sees devnet, the final check before the send does not.
    let calls = 0;
    f.state.genesis = () => (calls++ === 0 ? CLUSTER_GENESIS_HASHES.devnet : CLUSTER_GENESIS_HASHES.testnet);
    await expect(submitKycRegistryCreation(f.rpc, two, { pinned: null })).rejects.toThrow(/different network/);
    expect(calls).toBe(2);
    expect(f.sendTransaction).not.toHaveBeenCalled();
    f.state.genesis = () => CLUSTER_GENESIS_HASHES.devnet;
    await submitKycRegistryCreation(f.rpc, two, { pinned: null });
    expect(f.sendTransaction).toHaveBeenCalledOnce();
  });
});
