import { describe,expect,it } from "vitest";
import { purchaseQuote,paymentTokenLabel } from "@/lib/purchase-quote";
import { parseCommitmentTotals,UNKNOWN_COMMITMENTS } from "@/lib/commitment-totals";
describe("exact purchase budget",()=>{
  it("does not round up the token budget or lose large integer precision",()=>{
    expect(purchaseQuote("0.3",6,BigInt(100000))).toEqual({budget:BigInt(300000),units:BigInt(3),cost:BigInt(300000)});
    expect(purchaseQuote("9007199254740993",0,BigInt(1))?.units.toString()).toBe("9007199254740993");
    const quote=purchaseQuote("0.299999",6,BigInt(100000))!;
    expect(quote.units).toBe(BigInt(2));expect(quote.cost<=quote.budget).toBe(true);
  });
  it.each(["1e5","Infinity","-1","0","1.0000001","18446744073709551616", "", "1..2"])("rejects invalid/out-of-range budget %s",input=>{
    expect(purchaseQuote(input,6,BigInt(1))).toBeNull();
  });
  it("does not infer USDC from a symbol or a mint on another network",()=>{
    const mint="4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
    expect(paymentTokenLabel(mint,"devnet")).toBe("test USDC");
    expect(paymentTokenLabel(mint,"mainnet")).toBe("payment tokens");
  });
});
describe("honest aggregate states",()=>{
  it("keeps unavailable totals separate from a verified empty result",()=>{
    expect(parseCommitmentTotals(null)).toEqual(UNKNOWN_COMMITMENTS);
    expect(parseCommitmentTotals({pledged:"0",confirmed:"0",settled:"0",backers:0,pledgers:0,unverified:0,paymentMint:null}).available).toBe(true);
  });
  it("does not combine pledges or historical records into settlement",()=>{
    const totals=parseCommitmentTotals({pledged:"1000",confirmed:"2000",settled:"0.75",backers:1,pledgers:3,unverified:7,paymentMint:"mint"});
    expect(totals.settled).toBe("0.75");expect(totals.pledged).toBe(1000);expect(totals.confirmed).toBe(2000);
  });
  it("does not turn malformed totals into a valid zero",()=>{
    expect(parseCommitmentTotals({pledged:"NaN",confirmed:"0",settled:"0",backers:0,pledgers:0,unverified:0,paymentMint:null}).available).toBe(false);
  });
  it("reads the verified-only pledge split (0061) and tolerates an older server without it",()=>{
    const base={pledged:"100",confirmed:"0",settled:"0",backers:0,pledgers:1,unverified:0,paymentMint:null};
    expect(parseCommitmentTotals(base)).toMatchObject({available:true,unverifiedPledged:null,unverifiedPledgers:null});
    expect(parseCommitmentTotals({...base,unverifiedPledged:"2500",unverifiedPledgers:40}))
      .toMatchObject({available:true,pledged:100,pledgers:1,unverifiedPledged:2500,unverifiedPledgers:40});
  });
  it("does not accept a malformed or half-present verified-only split",()=>{
    const base={pledged:"100",confirmed:"0",settled:"0",backers:0,pledgers:1,unverified:0,paymentMint:null};
    expect(parseCommitmentTotals({...base,unverifiedPledged:"x",unverifiedPledgers:1}).available).toBe(false);
    expect(parseCommitmentTotals({...base,unverifiedPledged:"10",unverifiedPledgers:-1}).available).toBe(false);
    expect(parseCommitmentTotals({...base,unverifiedPledged:"10"}).available).toBe(false);
    expect(parseCommitmentTotals({...base,unverifiedPledgers:3}).available).toBe(false);
  });
});
