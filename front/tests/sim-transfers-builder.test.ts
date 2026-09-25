// The cohort-X transfer builder (scripts/sim/lib/transfers.ts): the exact
// account order Token-2022 and the hook expect (Open and KycGated tails),
// the idempotent ATA create, every probe's single intended defect, and the
// tri-state resume rule. Offline: the RPC is a stub answering the hook
// config read (none = Open, or an encoded KycGated config) and the rent.
import { describe, expect, it } from "vitest";
import {
  AccountRole,
  compileTransaction,
  generateKeyPairSigner,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  type Address,
  type Blockhash,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";
import { ASSOCIATED_TOKEN_PROGRAM_ADDRESS, getTransferCheckedInstructionDataDecoder } from "@solana-program/token-2022";
import { ASSET_REGISTRY_PROGRAM_ADDRESS, findEscrowMarkerPda, findKycEntryPda } from "@/lib/generated/asset_registry";
import { RestrictionMode, TRANSFER_HOOK_PROGRAM_ADDRESS, findConfigPda, getTransferHookConfigEncoder } from "@/lib/generated/transfer_hook";
import { findBlockEntryPda, findExtraMetasPda } from "@/lib/pdas";
import { TOKEN_2022 } from "@/lib/transaction-builders";
import type { ChainRpc } from "@/scripts/chain/lib/rpc";
import { buildMessage } from "@/scripts/chain/lib/tx";
import { FAKE_MINT_B } from "./helpers/sim-fake-site";
import {
  PLAIN_HOOK_ACCOUNT_SIZE,
  PROBES,
  XferDiverged,
  ataOf,
  buildDirectTransfer,
  transferLanded,
  type ProbePair,
  type TransferSpec,
} from "@/scripts/sim/lib/transfers";

const MINT = "HRcahPjAhX9ssiY5WvNJxHmy5vuDL7Q6GF6J5gNGjgwC" as Address;
const REGISTRY = "5MofiJNCoCRkNg1f2Yd7368WkjiNxkZZmUTaQo7xLhku" as Address;
const SYSTEM = "11111111111111111111111111111111";

/** A fresh stub per test: lib/hook-metas caches the config per rpc object for 30 s. */
function rpcStub(mode: "open" | "kyc" = "open"): ChainRpc {
  const config =
    mode === "kyc"
      ? Buffer.from(
          getTransferHookConfigEncoder().encode({
            mint: MINT,
            shareClass: MINT,
            blocklist: MINT,
            restrictionMode: RestrictionMode.KycGated,
            kycRegistry: REGISTRY,
            version: 1,
            bump: 255,
          }),
        ).toString("base64")
      : null;
  return {
    getAccountInfo: () => ({
      send: async () => ({
        context: { slot: BigInt(1) },
        value: config ? { data: [config, "base64"], executable: false, lamports: BigInt(1), owner: TRANSFER_HOOK_PROGRAM_ADDRESS, space: BigInt(0) } : null,
      }),
    }),
    getMinimumBalanceForRentExemption: () => ({ send: async () => BigInt(2_039_280) }),
  } as unknown as ChainRpc;
}

type Pair = { hub: KeyPairSigner; peer: KeyPairSigner };
async function pair(): Promise<Pair> {
  return { hub: await generateKeyPairSigner(), peer: await generateKeyPairSigner() };
}

const transferIx = (ixs: Instruction[]) => ixs.at(-1)!;
const addresses = (ix: Instruction) => (ix.accounts ?? []).map((a) => a.address);

describe("buildDirectTransfer", () => {
  it("Open: [src, mint, dst, authority, BlockEntry(src owner), ExtraMetas(mint), hook], the tail read-only, decimals 0", async () => {
    const { hub, peer } = await pair();
    const ixs = await buildDirectTransfer(rpcStub(), { mint: MINT, srcOwner: hub.address, dstOwner: peer.address, authority: hub, payer: hub, amount: BigInt(2) });
    expect(ixs).toHaveLength(1);
    const ix = ixs[0];
    expect(ix.programAddress).toBe(TOKEN_2022);
    expect(addresses(ix)).toEqual([
      await ataOf(hub.address, MINT),
      MINT,
      await ataOf(peer.address, MINT),
      hub.address,
      await findBlockEntryPda(hub.address),
      await findExtraMetasPda(MINT),
      TRANSFER_HOOK_PROGRAM_ADDRESS,
    ]);
    expect(ix.accounts!.slice(4).every((a) => a.role === AccountRole.READONLY)).toBe(true);
    expect(ix.accounts![3].role).toBe(AccountRole.READONLY_SIGNER);
    const data = getTransferCheckedInstructionDataDecoder().decode(ix.data!);
    expect([data.amount, data.decimals]).toEqual([BigInt(2), 0]);
  });

  it("KycGated: the 9-account tail, KycEntry of the destination owner and both owners' markers", async () => {
    const { hub, peer } = await pair();
    const ix = transferIx(await buildDirectTransfer(rpcStub("kyc"), { mint: MINT, srcOwner: hub.address, dstOwner: peer.address, authority: hub, payer: hub, amount: BigInt(1) }));
    expect(addresses(ix).slice(4)).toEqual([
      await findBlockEntryPda(hub.address),
      (await findConfigPda({ mint: MINT }))[0],
      REGISTRY,
      ASSET_REGISTRY_PROGRAM_ADDRESS,
      (await findKycEntryPda({ kycRegistry: REGISTRY, holder: peer.address }))[0],
      (await findEscrowMarkerPda({ offer: peer.address }))[0],
      (await findEscrowMarkerPda({ offer: hub.address }))[0],
      await findExtraMetasPda(MINT),
      TRANSFER_HOOK_PROGRAM_ADDRESS,
    ]);
  });

  it("createDst prepends the idempotent ATA create paid by the sender; an authority other than the payer signs too", async () => {
    const { hub, peer } = await pair();
    const donor = await generateKeyPairSigner();
    const ixs = await buildDirectTransfer(rpcStub(), { mint: MINT, srcOwner: donor.address, dstOwner: hub.address, authority: donor, payer: hub, amount: BigInt(3), createDst: true });
    expect(ixs).toHaveLength(2);
    expect(ixs[0].programAddress).toBe(ASSOCIATED_TOKEN_PROGRAM_ADDRESS);
    expect(ixs[0].data).toEqual(new Uint8Array([1])); // CreateIdempotent
    expect(addresses(ixs[0]).slice(0, 4)).toEqual([hub.address, await ataOf(hub.address, MINT), hub.address, MINT]);
    const blockhash = { blockhash: "11111111111111111111111111111111" as Blockhash, lastValidBlockHeight: BigInt(100) };
    const tx = compileTransaction(buildMessage({ feePayer: hub, ixs, blockhash, cuLimit: 200_000 }));
    expect(Object.keys(tx.signatures).sort()).toEqual([donor.address, hub.address].sort());
    void peer;
  });
});

describe("probe variants change one thing each", () => {
  const base = async (p: Pair): Promise<TransferSpec> => ({ mint: MINT, srcOwner: p.peer.address, dstOwner: p.hub.address, authority: p.peer, payer: p.peer, amount: BigInt(1) });
  const probePair = (p: Pair, offer?: ProbePair["offer"]): ProbePair => ({
    hub: p.hub,
    peer: p.peer,
    mint: MINT,
    mintB: FAKE_MINT_B,
    registry: REGISTRY,
    peerBalance: async () => BigInt(2),
    offer,
  });
  const build = async (id: string, p: Pair, offer?: ProbePair["offer"]) => {
    const spec = await PROBES.find((d) => d.id === id)!.spec(probePair(p, offer));
    return { spec: spec!, ixs: await buildDirectTransfer(rpcStub(), spec!) };
  };

  it("has the design's rows plus the delegate and legacy ones, each expecting a program and code (or a name)", () => {
    expect(PROBES.map((d) => d.id)).toEqual(["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "B1", "B2", "B3", "B4", "D1", "D2", "L1", "E1", "E2"]);
    for (const d of PROBES) if (!d.expect.ok) expect(d.expect.code !== null || d.expect.names.length > 0).toBe(true);
  });

  it("P1 builds no ATA create; P2 is a self-transfer; P3 sends 0; P4 one more than the peer holds", async () => {
    const p = await pair();
    const p1 = await build("P1", p);
    expect(p1.ixs).toHaveLength(1);
    expect(addresses(p1.ixs[0])[2]).toBe(await ataOf(p.peer.address, MINT));
    const p2 = await build("P2", p);
    expect(addresses(p2.ixs[0])[0]).toBe(addresses(p2.ixs[0])[2]);
    expect(getTransferCheckedInstructionDataDecoder().decode((await build("P3", p)).ixs[0].data!).amount).toBe(BigInt(0));
    expect(getTransferCheckedInstructionDataDecoder().decode((await build("P4", p)).ixs[0].data!).amount).toBe(BigInt(3));
  });

  it("P5 signs for the hub's ATA; P6 says decimals 6; P7 names class B; everything else is the base", async () => {
    const p = await pair();
    const baseIx = transferIx(await buildDirectTransfer(rpcStub(), await base(p)));
    const p5 = transferIx((await build("P5", p)).ixs);
    expect(addresses(p5)[0]).toBe(await ataOf(p.hub.address, MINT));
    expect(addresses(p5)[3]).toBe(p.peer.address);
    const p6 = transferIx((await build("P6", p)).ixs);
    expect(addresses(p6)).toEqual(addresses(baseIx));
    expect(getTransferCheckedInstructionDataDecoder().decode(p6.data!).decimals).toBe(6);
    const p7 = transferIx((await build("P7", p)).ixs);
    expect(addresses(p7)[1]).toBe(FAKE_MINT_B);
    expect([addresses(p7)[0], ...addresses(p7).slice(2)]).toEqual([addresses(baseIx)[0], ...addresses(baseIx).slice(2)]);
  });

  it("P8 creates a hub-owned account without ImmutableOwner in the same transaction and sends to it", async () => {
    const p = await pair();
    const { ixs } = await build("P8", p);
    expect(ixs).toHaveLength(3);
    const [create, init, transfer] = ixs;
    expect(create.programAddress).toBe(SYSTEM);
    const space = Number(Buffer.from(create.data!).readBigUInt64LE(12));
    expect(space).toBe(PLAIN_HOOK_ACCOUNT_SIZE);
    expect(space).toBe(165 + 1 + 4 + 1); // base + account type + TransferHookAccount TLV: no ImmutableOwner
    // System CreateAccount: tag u32 | lamports u64 | space u64 | owner program.
    expect(Buffer.from(create.data!).subarray(20, 52)).toEqual(Buffer.from(getAddressEncoder().encode(TOKEN_2022)));
    expect(init.programAddress).toBe(TOKEN_2022);
    expect(addresses(init)[0]).toBe(addresses(create)[1]);
    expect(addresses(transfer)[2]).toBe(addresses(create)[1]);
    expect(addresses(transfer)[2]).not.toBe(await ataOf(p.hub.address, MINT));
  });

  it("B1 has no tail, B2 only the hook program, B3 keys the BlockEntry on the destination owner, B4 is KycGated-shaped", async () => {
    const p = await pair();
    expect(addresses(transferIx((await build("B1", p)).ixs))).toHaveLength(4);
    expect(addresses(transferIx((await build("B2", p)).ixs)).slice(4)).toEqual([TRANSFER_HOOK_PROGRAM_ADDRESS]);
    expect(addresses(transferIx((await build("B3", p)).ixs))[4]).toBe(await findBlockEntryPda(p.hub.address));
    const b4 = addresses(transferIx((await build("B4", p)).ixs));
    expect(b4).toHaveLength(4 + 9);
    expect(b4[4]).toBe(await findBlockEntryPda(p.peer.address));
    expect(b4[6]).toBe(REGISTRY);
  });

  it("D1 approves a fresh delegate that signs, BlockEntry of the owner; D2 keys it on the delegate", async () => {
    const p = await pair();
    const d1 = await build("D1", p);
    expect(d1.ixs).toHaveLength(2);
    const [approve, transfer] = d1.ixs;
    expect(approve.programAddress).toBe(TOKEN_2022);
    const delegate = d1.spec.authority.address;
    expect(delegate).not.toBe(p.peer.address);
    expect(addresses(approve)).toEqual([await ataOf(p.peer.address, MINT), delegate, p.peer.address]);
    expect(addresses(transfer)[3]).toBe(delegate);
    expect(addresses(transfer)[4]).toBe(await findBlockEntryPda(p.peer.address));
    const d2 = await build("D2", p);
    expect(addresses(transferIx(d2.ixs))[4]).toBe(await findBlockEntryPda(d2.spec.authority.address));
  });

  it("L1 is the unchecked Transfer (no mint account) with the same tail", async () => {
    const p = await pair();
    const ix = transferIx((await build("L1", p)).ixs);
    expect(ix.data![0]).toBe(3); // Transfer
    expect(addresses(ix).slice(0, 3)).toEqual([await ataOf(p.peer.address, MINT), await ataOf(p.hub.address, MINT), p.peer.address]);
  });

  it("E1 signs for the offer escrow; E2 sends into it; neither exists without a live offer", async () => {
    const p = await pair();
    expect(await PROBES.find((d) => d.id === "E1")!.spec(probePair(p))).toBeNull();
    const offer = { pda: (await generateKeyPairSigner()).address, escrow: (await generateKeyPairSigner()).address };
    const e1 = transferIx((await build("E1", p, offer)).ixs);
    expect([addresses(e1)[0], addresses(e1)[3], addresses(e1)[4]]).toEqual([offer.escrow, p.peer.address, await findBlockEntryPda(offer.pda)]);
    const e2 = transferIx((await build("E2", p, offer)).ixs);
    expect([addresses(e2)[0], addresses(e2)[2]]).toEqual([await ataOf(p.peer.address, MINT), offer.escrow]);
  });
});

describe("packet size", () => {
  it("every probe and the largest send (a KycGated tail with the ATA create) fit one packet at MAX CU with a CU price", async () => {
    const p = await pair();
    const blockhash = { blockhash: "11111111111111111111111111111111" as Blockhash, lastValidBlockHeight: BigInt(100) };
    const wireBytes = (ixs: Instruction[], payer: KeyPairSigner) =>
      Buffer.from(getBase64EncodedWireTransaction(compileTransaction(buildMessage({ feePayer: payer, ixs, blockhash, cuLimit: 1_400_000, cuPrice: BigInt(1_000) })))).length;
    const offer = { pda: (await generateKeyPairSigner()).address, escrow: (await generateKeyPairSigner()).address };
    for (const def of PROBES) {
      const spec = await def.spec({ hub: p.hub, peer: p.peer, mint: MINT, mintB: FAKE_MINT_B, registry: REGISTRY, peerBalance: async () => BigInt(2), offer });
      const ixs = await buildDirectTransfer(rpcStub(), spec!);
      expect(wireBytes(ixs, spec!.payer as KeyPairSigner), def.id).toBeLessThanOrEqual(1_232);
    }
    const donor = await generateKeyPairSigner();
    const seed = await buildDirectTransfer(rpcStub("kyc"), { mint: MINT, srcOwner: donor.address, dstOwner: p.hub.address, authority: donor, payer: p.hub, amount: BigInt(3), createDst: true });
    expect(wireBytes(seed, p.hub)).toBeLessThanOrEqual(1_232);
  });
});

describe("transferLanded (the resume rule of a sent transfer)", () => {
  const snap = { srcOwner: "a", srcAta: "A", dstOwner: "b", dstAta: "B", amount: "2", srcBefore: "3", dstBefore: "0" };
  it("post-state → landed (never re-sent), pre-state → send, anything else → diverged", () => {
    expect(transferLanded("xfer.s2", snap, [BigInt(1), BigInt(2)])).toBe(true);
    expect(transferLanded("xfer.s2", snap, [BigInt(3), null])).toBe(false);
    expect(() => transferLanded("xfer.s2", snap, [BigInt(3), BigInt(5)])).toThrow(XferDiverged);
    expect(() => transferLanded("xfer.s2", snap, [BigInt(0), BigInt(2)])).toThrow(/moved outside the simulator/);
  });
});
