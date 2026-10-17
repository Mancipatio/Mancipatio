// The public OTC lists (the resell board and /marketplace/otc) showed every
// Open offer as takeable, so an unfunded, expired or foreign-payment-mint
// offer sent "Take →" to a dead end. offerHold is the one rule both lists
// now apply; it lives in the resell board module because a page module
// exports only its page (natural home: lib/offer-availability.ts).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAddressDecoder, type Address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { OfferStatus, type Offer } from "@/lib/generated/asset_registry";
import { USDC } from "@/lib/payment-mints";
import {
  listedOpenOffer,
  offerHold,
} from "@/app/(marketing)/markets/resell/resell-board";

const key = (n: number) =>
  getAddressDecoder().decode(new Uint8Array(32).fill(n)) as Address;
const NOW = BigInt(1_800_000_000);

function offer(overrides: Partial<Offer> = {}): Offer {
  return {
    maker: key(1),
    shareClass: key(2),
    mint: key(3),
    escrow: key(4),
    paymentMint: key(5),
    amount: BigInt(8),
    deposited: BigInt(8),
    price: BigInt(90),
    status: OfferStatus.Open,
    offerId: BigInt(7),
    expiresAt: BigInt(0),
    version: 1,
    bump: 255,
    ...overrides,
  } as Offer;
}

describe("offerHold: why an Open offer cannot be taken right now", () => {
  it("a funded, unexpired offer can be taken", () => {
    expect(offerHold(offer(), NOW, "devnet")).toBeNull();
  });

  it("an expiry equal to now can still be taken; one second later it is expired (take_offer.rs)", () => {
    expect(offerHold(offer({ expiresAt: NOW }), NOW, "devnet")).toBeNull();
    expect(offerHold(offer({ expiresAt: NOW }), NOW + BigInt(1), "devnet")).toBe("expired");
  });

  it("expiresAt 0 never expires", () => {
    expect(offerHold(offer(), BigInt(Number.MAX_SAFE_INTEGER), "devnet")).toBeNull();
  });

  it("the deposit ledger decides funding: below the amount is unfunded, equal or above is funded", () => {
    expect(offerHold(offer({ deposited: BigInt(7) }), NOW, "devnet")).toBe("unfunded");
    expect(offerHold(offer({ deposited: BigInt(8) }), NOW, "devnet")).toBeNull();
    expect(offerHold(offer({ deposited: BigInt(9) }), NOW, "devnet")).toBeNull();
  });

  it("mainnet takes only an allowlisted payment mint; every other network takes any mint", () => {
    expect(offerHold(offer({ paymentMint: USDC.mainnet!.mint }), NOW, "mainnet")).toBeNull();
    expect(offerHold(offer(), NOW, "mainnet")).toBe("payment-token");
    expect(offerHold(offer(), NOW, "devnet")).toBeNull();
    expect(offerHold(offer(), NOW, "localnet")).toBeNull();
  });

  it("reports the take page's first reason: expired before unfunded before the payment token", () => {
    expect(
      offerHold(offer({ expiresAt: NOW - BigInt(1), deposited: BigInt(0) }), NOW, "mainnet"),
    ).toBe("expired");
    expect(offerHold(offer({ deposited: BigInt(0) }), NOW, "mainnet")).toBe("unfunded");
  });
});

describe("listedOpenOffer: what the public lists show at all", () => {
  it("is true only for an Open offer with a non-zero amount", () => {
    expect(listedOpenOffer(offer())).toBe(true);
    for (const status of [OfferStatus.Filled, OfferStatus.Cancelled, OfferStatus.Expired]) {
      expect(listedOpenOffer(offer({ status }))).toBe(false);
    }
    expect(listedOpenOffer(offer({ amount: BigInt(0), deposited: BigInt(0) }))).toBe(false);
  });
});

describe("both public lists apply the rule", () => {
  const read = (file: string) => readFileSync(join(process.cwd(), file), "utf8");

  it("/marketplace/otc splits takeable from held offers and shows each reason, never a bare Open filter", () => {
    const page = read("app/marketplace/otc/page.tsx");
    expect(page).toMatch(
      /import \{\s*listedOpenOffer,\s*offerHold,\s*type OfferHold,?\s*\} from "@\/app\/\(marketing\)\/markets\/resell\/resell-board";/,
    );
    expect(page).not.toMatch(/\.filter\(\(o\) => o\.status === OfferStatus\.Open\)/);
    expect(page).toContain("const hold = offerHold(o, nowSec, network);");
    expect(page).toContain("Not takeable right now ({rows.length})");
    expect(page).toContain('"No takeable OTC offers right now."');
    for (const text of [
      "Past its expiry. Anyone can expire it to refund the maker.",
      "Escrow not funded: ",
      "Priced in a token Manci does not accept on mainnet.",
    ]) {
      expect(page).toContain(text);
    }
    expect(page).toContain('{hold === "expired" ? "Expire →" : "View →"}');
    // The page module exports only its page.
    expect(page.match(/^export /gm)).toEqual(["export "]);
    expect(page).toMatch(/^export default function PublicOtcPage/m);
  });

  it("the resell board lists and counts only takeable offers, and says how many are held back", () => {
    const board = read("app/(marketing)/markets/resell/resell-board.tsx");
    expect(board).toContain(
      ".filter((o) => listedOpenOffer(o) && offerHold(o, nowSec, network) === null)",
    );
    expect(board).not.toContain('label="Open offers"');
    expect(board).toContain('label="Funded offers"');
    expect(board).not.toMatch(/\(o\) => o\.status === OfferStatus\.Open\)\.length/);
    expect(board).toContain("not takeable yet");
    expect(board).toContain('"No takeable offers right now."');
  });
});
