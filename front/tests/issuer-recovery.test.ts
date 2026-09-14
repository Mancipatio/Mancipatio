import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  address,
  generateKeyPairSigner,
  getTransactionDecoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getBase58Decoder,
} from "@solana/kit";
const mocks = vi.hoisted(() => ({ platform: vi.fn(), issuer: vi.fn() }));
vi.mock("@/lib/generated/asset_registry", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchMaybePlatform: mocks.platform,
  fetchMaybeIssuer: mocks.issuer,
}));
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  getRecoverIssuerRegistrationInstructionDataDecoder,
  KybStatus,
} from "@/lib/generated/asset_registry";
import { CLUSTER_GENESIS_HASHES } from "@/lib/network-identity";
import {
  compileIssuerRecovery,
  parseIssuerRecovery,
  prepareIssuerRecovery,
  signIssuerRecovery,
  submitIssuerRecovery,
} from "@/lib/issuer-recovery";
const issuer = address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"),
  previousAuthority = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
async function fixture() {
  const admin = await generateKeyPairSigner(),
    next = await generateKeyPairSigner();
  mocks.platform.mockResolvedValue({
    exists: true,
    programAddress: ASSET_REGISTRY_PROGRAM_ADDRESS,
    data: { admin: admin.address },
  });
  mocks.issuer.mockResolvedValue({
    exists: true,
    programAddress: ASSET_REGISTRY_PROGRAM_ADDRESS,
    data: {
      authority: previousAuthority,
      assetsCount: BigInt(0),
      kybStatus: KybStatus.Pending,
    },
  });
  const sendTransaction = vi.fn(
    (wire: string) => (
      void wire,
      {
        send: async () => "signature",
      }
    ),
  );
  const rpc = {
    getGenesisHash: () => ({ send: async () => CLUSTER_GENESIS_HASHES.devnet }),
    isBlockhashValid: () => ({ send: async () => ({ value: true }) }),
    getLatestBlockhash: () => ({
      send: async () => ({
        value: {
          blockhash: "11111111111111111111111111111111",
          lastValidBlockHeight: BigInt(100),
        },
      }),
    }),
    sendTransaction,
  } as unknown as Parameters<typeof prepareIssuerRecovery>[0];
  const envelope = await prepareIssuerRecovery(rpc, "devnet", {
    issuer,
    newAuthority: next.address,
    jurisdiction: 688,
    kybDocHash: "ab".repeat(32),
  });
  return { admin, next, rpc, envelope, sendTransaction };
}
beforeEach(() => vi.clearAllMocks());
describe("issuer recovery co-signing", () => {
  it("collects two real signatures on one locally reconstructed recovery and sends only after both", async () => {
    const f = await fixture(),
      one = await signIssuerRecovery(f.rpc, f.envelope, f.admin);
    await expect(submitIssuerRecovery(f.rpc, one)).rejects.toThrow();
    expect(f.sendTransaction).not.toHaveBeenCalled();
    const two = await signIssuerRecovery(
      f.rpc,
      parseIssuerRecovery(JSON.stringify(one), "devnet"),
      f.next,
    );
    await submitIssuerRecovery(f.rpc, two);
    expect(f.sendTransaction).toHaveBeenCalledOnce();
    const tx = getTransactionDecoder().decode(
      getBase64Encoder().encode(f.sendTransaction.mock.calls[0][0]),
    );
    const message = getCompiledTransactionMessageDecoder().decode(
      tx.messageBytes,
    );
    expect(message.instructions).toHaveLength(1);
    const ix = message.instructions[0];
    expect(message.staticAccounts[ix.programAddressIndex]).toBe(
      ASSET_REGISTRY_PROGRAM_ADDRESS,
    );
    const args = getRecoverIssuerRegistrationInstructionDataDecoder().decode(
      ix.data!,
    );
    expect(args.jurisdiction).toBe(688);
    expect(Buffer.from(args.kybDocHash).toString("hex")).toBe("ab".repeat(32));
    expect(Object.values(tx.signatures).every(Boolean)).toBe(true);
  });
  it("rejects altered economic/legal terms, forged signatures, another network and unexpected signers", async () => {
    const f = await fixture(),
      one = await signIssuerRecovery(f.rpc, f.envelope, f.admin);
    await expect(
      compileIssuerRecovery({ ...one, jurisdiction: 840 }),
    ).rejects.toThrow("does not match");
    await expect(
      compileIssuerRecovery({
        ...one,
        signatures: {
          [f.admin.address]: getBase58Decoder().decode(
            new Uint8Array(64).fill(1),
          ),
        },
      }),
    ).rejects.toThrow("does not match");
    expect(() => parseIssuerRecovery(JSON.stringify(one), "mainnet")).toThrow(
      "network",
    );
    expect(() =>
      parseIssuerRecovery(
        JSON.stringify({
          ...one,
          signatures: { [previousAuthority]: "1".repeat(64) },
        }),
        "devnet",
      ),
    ).toThrow("Unexpected recovery signer");
  });
  it("rechecks live admin, unused registration and expiry before either signing or sending", async () => {
    const f = await fixture();
    mocks.issuer.mockResolvedValue({
      exists: true,
      programAddress: ASSET_REGISTRY_PROGRAM_ADDRESS,
      data: {
        authority: previousAuthority,
        assetsCount: BigInt(1),
        kybStatus: KybStatus.Pending,
      },
    });
    await expect(
      signIssuerRecovery(f.rpc, f.envelope, f.admin),
    ).rejects.toThrow("no longer recoverable");
    const g = await fixture();
    mocks.platform.mockResolvedValue({
      exists: true,
      programAddress: ASSET_REGISTRY_PROGRAM_ADDRESS,
      data: { admin: previousAuthority },
    });
    await expect(
      signIssuerRecovery(g.rpc, g.envelope, g.admin),
    ).rejects.toThrow("current Super Admin");
    const h = await fixture();
    vi.spyOn(h.rpc, "isBlockhashValid").mockReturnValue({
      send: async () => ({ value: false }),
    } as never);
    await expect(signIssuerRecovery(h.rpc, h.envelope, h.next)).rejects.toThrow(
      "expired",
    );
  });
  it("rejects a wallet adapter that signs changed transaction bytes", async () => {
    const f = await fixture();
    const wrong = await f.next.signTransactions([
      await compileIssuerRecovery({ ...f.envelope, jurisdiction: 840 }),
    ]);
    await expect(
      signIssuerRecovery(f.rpc, f.envelope, {
        address: f.next.address,
        signTransactions: async () => wrong,
      }),
    ).rejects.toThrow("does not match");
  });
});
