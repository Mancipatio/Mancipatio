// The escrow instruction the admin OTC page and the simulator's owner actor
// share (lib/otc-deal.ts): create_otc_deal's account order and PDAs, its
// arguments from the request row, and the deal-id and expiry rules the page
// used to keep inline. Offline (PDA derivations only).
import { describe, expect, it } from "vitest";
import { AccountRole, generateKeyPairSigner, type Address } from "@solana/kit";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  findAdminRecordPda,
  findDealPda,
  findEscrowMarkerPda,
  findPlatformPda,
  getCreateOtcDealInstructionDataDecoder,
} from "@/lib/generated/asset_registry";
import { DEFAULT_DEAL_SECONDS, createOtcDealInstruction, defaultDealExpiry, newDealId, resolveDealExpiry } from "@/lib/otc-deal";
import { TOKEN_2022, TOKEN_CLASSIC } from "@/lib/transaction-builders";

const CLASS_A = "AvQjGoQDreVZgsA4GJXndViY4qCBEYBBa1cJf9NJLAqg";
const MINT_A = "75CuSX8gJqtjNkPjz3jR7P9eFxGP9bR1wJ2ugoRw4Haf";
const PAYMENT = "6bJVcLbqrDFRAny97ppSKou8BrtAynegb2Wo45j3MQaM";
const SELLER = "8YnEMkoDmMknKqJuxdyeChV9GuafyMudYxdHcMYbFVVn";
const BUYER = "EVAiScjWTEhT9fweDht22jR3VK9M6KVpeMdrVu3dkGaK";
const request = { share_class_pda: CLASS_A, mint: MINT_A, payment_mint: PAYMENT, seller_wallet: SELLER, buyer_wallet: BUYER, amount: 5, price: 6_000_000 };

describe("createOtcDealInstruction", () => {
  it("builds create_otc_deal from the request row: the admin record of the signer, the deal PDA of (class, deal id), Token-2022, the payment program, platform last", async () => {
    const admin = await generateKeyPairSigner();
    const dealId = BigInt(1_790_000_000_123);
    const ix = await createOtcDealInstruction({ authority: admin, request, dealId, expiresAt: BigInt(1_790_259_200), paymentTokenProgram: TOKEN_CLASSIC });
    expect(ix.programAddress).toBe(ASSET_REGISTRY_PROGRAM_ADDRESS);
    const accounts = ix.accounts!.map((a) => a.address);
    const [adminRecord] = await findAdminRecordPda({ authority: admin.address });
    const [deal] = await findDealPda({ shareClass: CLASS_A as Address, dealId });
    const [marker] = await findEscrowMarkerPda({ offer: deal });
    const [platform] = await findPlatformPda();
    expect(accounts[0]).toBe(admin.address);
    expect(ix.accounts![0].role).toBe(AccountRole.WRITABLE_SIGNER);
    expect(accounts[1]).toBe(adminRecord);
    expect(accounts.slice(2, 6)).toEqual([CLASS_A, MINT_A, PAYMENT, deal]);
    expect(accounts[8]).toBe(marker);
    expect(accounts[9]).toBe(TOKEN_2022);
    expect(accounts[10]).toBe(TOKEN_CLASSIC);
    expect(accounts[accounts.length - 1]).toBe(platform);
    const data = getCreateOtcDealInstructionDataDecoder().decode(ix.data!);
    expect(data).toMatchObject({ dealId, buyer: BUYER, seller: SELLER, amount: BigInt(5), price: BigInt(6_000_000), paymentMint: PAYMENT, expiresAt: BigInt(1_790_259_200) });
  });
});

describe("deal id and expiry", () => {
  const now = Date.UTC(2026, 8, 25, 12, 0, 0);
  const nowSec = Math.floor(now / 1000);

  it("the deal id is the clock in ms; the default expiry is 7 days", () => {
    expect(newDealId(now)).toBe(BigInt(now));
    expect(defaultDealExpiry(now)).toBe(BigInt(nowSec + DEFAULT_DEAL_SECONDS));
  });

  it("keeps a request's future expiry and replaces a past or missing one with the 7-day default", () => {
    expect(resolveDealExpiry(new Date(now + 3 * 86_400_000).toISOString(), now)).toBe(BigInt(nowSec + 3 * 86_400));
    expect(resolveDealExpiry(new Date(now - 60_000).toISOString(), now)).toBe(BigInt(nowSec + DEFAULT_DEAL_SECONDS));
    expect(resolveDealExpiry(null, now)).toBe(BigInt(nowSec + DEFAULT_DEAL_SECONDS));
  });
});
