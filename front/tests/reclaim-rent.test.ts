import { describe, expect, it } from "vitest";
import {
  AccountRole,
  createNoopSigner,
  getAddressDecoder,
  type Address,
} from "@solana/kit";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  RECLAIM_RENT_DISCRIMINATOR,
} from "@/lib/generated/asset_registry";
import {
  reclaimCustodyVault,
  reclaimOffer,
  reclaimOtcDeal,
  SHARE_TOKEN_PROGRAM,
} from "@/lib/reclaim-rent";
import { buildClosePassport, getEntryPda } from "@/lib/passport";

const key = (n: number) =>
  getAddressDecoder().decode(new Uint8Array(32).fill(n)) as Address;
const SPL_TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;
const ORDER = ["caller", "owner", "target", "linked", "linked_b", "token_program", "token_program_b"];

function metas(ix: { accounts: readonly { address: string; role: AccountRole }[] }) {
  expect(ix.accounts).toHaveLength(ORDER.length);
  return Object.fromEntries(ix.accounts.map((a, i) => [ORDER[i], a]));
}

describe("reclaim_rent builders (2D)", () => {
  it("Offer: a crank signs, the maker is a non-signing writable owner, None accounts are the program id", () => {
    const crank = createNoopSigner(key(1));
    const ix = reclaimOffer({
      caller: crank,
      offer: key(2),
      data: { maker: key(3), escrow: key(4) },
    });
    expect(ix.programAddress).toBe(ASSET_REGISTRY_PROGRAM_ADDRESS);
    expect(Array.from(ix.data)).toEqual(Array.from(RECLAIM_RENT_DISCRIMINATOR));
    const m = metas(ix);
    expect(m.caller).toMatchObject({ address: key(1), role: AccountRole.READONLY_SIGNER });
    expect(m.owner).toMatchObject({ address: key(3), role: AccountRole.WRITABLE });
    expect(m.target).toMatchObject({ address: key(2), role: AccountRole.WRITABLE });
    expect(m.linked).toMatchObject({ address: key(4), role: AccountRole.WRITABLE });
    expect(m.linked_b.address).toBe(ASSET_REGISTRY_PROGRAM_ADDRESS);
    expect(m.token_program.address).toBe(SHARE_TOKEN_PROGRAM);
    expect(m.token_program_b.address).toBe(ASSET_REGISTRY_PROGRAM_ADDRESS);
  });

  it("OtcDeal: only deal.admin, with both escrows and the payment token program", () => {
    const admin = createNoopSigner(key(5));
    const data = { admin: key(5), assetEscrow: key(6), paymentEscrow: key(7) };
    const m = metas(
      reclaimOtcDeal({ admin, deal: key(8), data, paymentTokenProgram: SPL_TOKEN }),
    );
    expect(m.caller.address).toBe(key(5));
    expect(m.owner.address).toBe(key(5));
    expect(m.linked.address).toBe(key(6));
    expect(m.linked_b).toMatchObject({ address: key(7), role: AccountRole.WRITABLE });
    expect(m.token_program.address).toBe(SHARE_TOKEN_PROGRAM);
    expect(m.token_program_b.address).toBe(SPL_TOKEN);
    expect(() =>
      reclaimOtcDeal({
        admin: createNoopSigner(key(9)),
        deal: key(8),
        data,
        paymentTokenProgram: SPL_TOKEN,
      }),
    ).toThrow(/admin/);
  });

  it("CustodyVault: only the current vault authority", () => {
    const data = { authority: key(10), escrow: key(11) };
    const m = metas(
      reclaimCustodyVault({ authority: createNoopSigner(key(10)), vault: key(12), data }),
    );
    expect(m.owner.address).toBe(key(10));
    expect(m.target.address).toBe(key(12));
    expect(m.linked.address).toBe(key(11));
    expect(m.linked_b.address).toBe(ASSET_REGISTRY_PROGRAM_ADDRESS);
    expect(() =>
      reclaimCustodyVault({ authority: createNoopSigner(key(13)), vault: key(12), data }),
    ).toThrow(/authority/);
  });

  it("KycEntry (close passport): the registry authority closes the entry against the registry", async () => {
    const provider = createNoopSigner(key(14));
    const registry = key(15);
    const holder = key(16);
    const m = metas(
      await buildClosePassport({ authoritySigner: provider, registry, holder }),
    );
    expect(m.caller.address).toBe(key(14));
    expect(m.owner).toMatchObject({ address: key(14), role: AccountRole.WRITABLE });
    expect(m.target.address).toBe(await getEntryPda(registry, holder));
    expect(m.linked).toMatchObject({ address: registry, role: AccountRole.WRITABLE });
    for (const name of ["linked_b", "token_program", "token_program_b"])
      expect(m[name].address).toBe(ASSET_REGISTRY_PROGRAM_ADDRESS);
  });
});
