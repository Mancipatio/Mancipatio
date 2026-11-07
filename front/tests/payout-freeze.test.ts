import { describe, expect, it } from "vitest";
import { address } from "@solana/kit";
import {
  getPayoutVaultDecoder,
  getPayoutVaultEncoder,
  PayoutVaultState,
  RaiseType,
  type PayoutVaultArgs,
} from "@/lib/generated/asset_registry";
import {
  isFreezable,
  MONTH_SECONDS,
  periodsOverdue,
} from "@/lib/payout-vault";

const KEY = address("11111111111111111111111111111111");
const START = 1_800_000_000;
const MONTH = MONTH_SECONDS;

function vault(overrides: Partial<PayoutVaultArgs> = {}) {
  return getPayoutVaultDecoder().decode(getPayoutVaultEncoder().encode({
    sale: KEY,
    shareClass: KEY,
    paymentMint: KEY,
    escrow: KEY,
    founder: KEY,
    raiseType: RaiseType.Startup,
    totalAmount: 1_200,
    released: 0,
    startTs: START,
    cliffMonths: 0,
    vestingMonths: 12,
    numTranches: 12,
    trancheAmount: 100,
    tranchesReleased: 0,
    updatesPosted: 0,
    lastUpdateTs: 0,
    founderYieldClaimable: 0,
    investorYieldPool: 0,
    investorYieldRoot: new Uint8Array(32),
    totalWeight: 0,
    state: PayoutVaultState.Active,
    metadataHash: new Uint8Array(32),
    version: 2,
    bump: 255,
    voteRound: 0,
    votePending: false,
    ...overrides,
  }));
}

describe("payout freeze follows the oldest unfulfilled update", () => {
  // These boundaries match the current program's freeze_vault and
  // PayoutVault::overdue_periods, including the due instant itself.
  it.each([
    [-1, 0, false],
    [0, 1, false],
    [MONTH - 1, 1, false],
    [MONTH, 2, false],
    [2 * MONTH - 1, 2, false],
    [2 * MONTH, 3, true],
  ])("at due + %i seconds: %i periods, freezable=%s", (offset, periods, freezable) => {
    const v = vault({ updatesPosted: 5, tranchesReleased: 5, released: 500 });
    const now = START + 5 * MONTH + offset;
    expect(periodsOverdue(v, now)).toBe(periods);
    expect(isFreezable(v, now)).toBe(freezable);
  });

  it.each([1, 2])("allows freezing a %i-tranche plan after prolonged silence", (numTranches) => {
    const v = vault({ numTranches, vestingMonths: numTranches });
    expect(periodsOverdue(v, START)).toBe(1);
    expect(isFreezable(v, START + 2 * MONTH - 1)).toBe(false);
    expect(isFreezable(v, START + 2 * MONTH)).toBe(true);
    expect(periodsOverdue(v, START + 120 * MONTH)).toBe(121);
    expect(isFreezable(v, START + 120 * MONTH)).toBe(true);
  });

  it.each([10, 11])("keeps the exit reachable after %i of 12 updates", (updatesPosted) => {
    const v = vault({ updatesPosted, tranchesReleased: updatesPosted, released: updatesPosted * 100 });
    const due = START + updatesPosted * MONTH;
    expect(isFreezable(v, due + 2 * MONTH - 1)).toBe(false);
    expect(isFreezable(v, due + 2 * MONTH)).toBe(true);
    expect(isFreezable(v, START + 120 * MONTH)).toBe(true);
  });

  it("does not freeze a founder who posted every update but has not withdrawn every tranche", () => {
    const v = vault({ updatesPosted: 12, tranchesReleased: 11, released: 1_100 });
    expect(periodsOverdue(v, START + 120 * MONTH)).toBe(0);
    expect(isFreezable(v, START + 120 * MONTH)).toBe(false);
  });

  it("does not freeze or show overdue principal after it has all been released", () => {
    const v = vault({ released: 1_200 });
    expect(periodsOverdue(v, START + 120 * MONTH)).toBe(0);
    expect(isFreezable(v, START + 120 * MONTH)).toBe(false);
  });

  it.each([
    { state: PayoutVaultState.Frozen },
    { state: PayoutVaultState.Completed },
    { state: PayoutVaultState.Cancelled },
    { version: 1 },
    { version: 3 },
  ])("keeps inactive or unsupported vaults out of the freeze action: %j", (overrides) => {
    expect(isFreezable(vault(overrides), START + 120 * MONTH)).toBe(false);
  });

  it("respects the extended schedule instead of immediately re-freezing", () => {
    // The Rust Extend outcome moves start forward by the uncapped overdue
    // count: at original start + 14 months, update 10 is five periods late.
    const v = vault({ updatesPosted: 10, tranchesReleased: 10, released: 1_000 });
    const now = START + 14 * MONTH;
    expect(periodsOverdue(v, now)).toBe(5);
    expect(isFreezable(v, now)).toBe(true);
    const extended = { ...v, startTs: BigInt(START + 5 * MONTH) };
    expect(periodsOverdue(extended, now)).toBe(0);
    expect(isFreezable(extended, now)).toBe(false);
    expect(isFreezable(extended, START + 17 * MONTH - 1)).toBe(false);
    expect(isFreezable(extended, START + 17 * MONTH)).toBe(true);
  });
});
