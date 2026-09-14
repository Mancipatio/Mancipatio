// lib/escrow-ledger.ts — the deposit-ledger arithmetic the UI shares with the
// asset_registry program. These are the numbers the chain acts on (refund cap,
// takeability, whether an exit closes the account), so they are pinned here
// against the program's own rules rather than left to a page-local expression.
import { describe, expect, it } from "vitest";

import {
  isOfferFunded,
  previewEscrowRelease,
  remainingDeposit,
} from "@/lib/escrow-ledger";

const n = (v: number | string) => BigInt(v);

describe("remainingDeposit", () => {
  it("is the gap between the offer amount and what is already recorded", () => {
    expect(remainingDeposit(n(5), n(2))).toBe(n(3));
    expect(remainingDeposit(n(5), n(0))).toBe(n(5));
  });

  it("is zero once the ledger reaches the amount", () => {
    // `deposit_to_offer_escrow` caps the running total at `offer.amount`, so a
    // funded offer must offer no further input at all.
    expect(remainingDeposit(n(5), n(5))).toBe(n(0));
  });

  it("saturates at zero rather than going negative", () => {
    // The program's cap makes this unreachable on-chain, but a stale/rebuilt
    // row must never produce a negative "remaining" that a form would render.
    expect(remainingDeposit(n(5), n(9))).toBe(n(0));
  });

  it("handles u64-scale values without precision loss", () => {
    const max = n("18446744073709551615");
    expect(remainingDeposit(max, n(1))).toBe(n("18446744073709551614"));
  });
});

describe("isOfferFunded", () => {
  it("mirrors take_offer's `deposited >= amount`", () => {
    expect(isOfferFunded(n(5), n(4))).toBe(false);
    expect(isOfferFunded(n(5), n(5))).toBe(true);
  });

  it("treats a zero-amount offer as funded", () => {
    expect(isOfferFunded(n(0), n(0))).toBe(true);
  });

  it("does not consider a partially funded offer takeable", () => {
    // The whole point of the ledger: a maker cannot sell units they never put
    // in, no matter what the escrow's token balance shows.
    expect(isOfferFunded(n(100), n(99))).toBe(false);
  });
});

describe("previewEscrowRelease", () => {
  it("releases the whole balance when the ledger covers it", () => {
    expect(previewEscrowRelease(n(10), n(10))).toEqual({
      fromLedger: n(10),
      surplus: n(0),
    });
  });

  it("caps the unconditional release at the ledger and reports the surplus", () => {
    // 3 units were raw-transferred in by somebody else: releasing those is a
    // DELIVERY and needs the receiver's KycEntry to pass.
    expect(previewEscrowRelease(n(13), n(10))).toEqual({
      fromLedger: n(10),
      surplus: n(3),
    });
  });

  it("releases only what is actually there when the escrow is short", () => {
    // A partially-drained escrow (e.g. a fill already happened) must not claim
    // more than the balance.
    expect(previewEscrowRelease(n(4), n(10))).toEqual({
      fromLedger: n(4),
      surplus: n(0),
    });
  });

  it("reports the full balance as surplus when nothing was ledgered", () => {
    // The laundering case the ledger exists to stop: units pushed into an
    // escrow whose beneficiary never deposited anything.
    expect(previewEscrowRelease(n(1_000_000), n(0))).toEqual({
      fromLedger: n(0),
      surplus: n(1_000_000),
    });
  });

  it("is a no-op on an empty escrow", () => {
    expect(previewEscrowRelease(n(0), n(0))).toEqual({
      fromLedger: n(0),
      surplus: n(0),
    });
  });

  it("always splits the balance exactly — no unit is created or lost", () => {
    for (const [balance, deposited] of [
      [0, 0],
      [7, 0],
      [7, 3],
      [7, 7],
      [7, 12],
      [1, 1],
    ] as const) {
      const r = previewEscrowRelease(n(balance), n(deposited));
      expect(r.fromLedger + r.surplus).toBe(n(balance));
      expect(r.surplus >= n(0)).toBe(true);
      expect(r.fromLedger >= n(0)).toBe(true);
    }
  });
});
