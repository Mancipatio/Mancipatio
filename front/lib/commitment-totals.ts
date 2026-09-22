/**
 * Public commitment totals for one sale (commitment_totals RPC).
 *
 * Since migration 0062, `pledged` / `confirmed` / `pledgers` count only
 * pledges from wallets with a live verified dossier, and
 * `unverifiedPledged` / `unverifiedPledgers` report the rest (pledging needs
 * no KYC since policy 2026-09-23, so those figures are not social proof).
 * Both are null when the server predates 0062; the UI then labels the
 * totals as before.
 */
export type CommitAggregate = { available:boolean; pledged:number; confirmed:number; settled:string; backers:number; pledgers:number; paymentMint:string|null; unverified:number;
  unverifiedPledged:number|null; unverifiedPledgers:number|null };
export const UNKNOWN_COMMITMENTS:CommitAggregate={available:false,pledged:0,confirmed:0,settled:"0",backers:0,pledgers:0,paymentMint:null,unverified:0,unverifiedPledged:null,unverifiedPledgers:null};
const DECIMAL=/^\d+(\.\d+)?$/;
const isDecimal=(value:unknown)=>typeof value==="string" && DECIMAL.test(value) && Number.isFinite(Number(value));
const isCount=(value:unknown)=>Number.isSafeInteger(value) && Number(value)>=0;
export function parseCommitmentTotals(value:unknown):CommitAggregate {
  if(!value || typeof value!=="object") return UNKNOWN_COMMITMENTS;
  const v=value as Record<string,unknown>;
  for(const key of ["pledged","confirmed","settled"]){
    if(!isDecimal(v[key])) return UNKNOWN_COMMITMENTS;
  }
  for(const key of ["backers","pledgers","unverified"]){if(!isCount(v[key]))return UNKNOWN_COMMITMENTS;}
  if(v.paymentMint!==null && typeof v.paymentMint!=="string")return UNKNOWN_COMMITMENTS;
  // Verified-only split (0062): absent on an older server; when present it
  // must be well formed, and both keys travel together.
  const hasSplit=v.unverifiedPledged!==undefined || v.unverifiedPledgers!==undefined;
  if(hasSplit && (!isDecimal(v.unverifiedPledged) || !isCount(v.unverifiedPledgers))) return UNKNOWN_COMMITMENTS;
  return {available:true,pledged:Number(v.pledged),confirmed:Number(v.confirmed),settled:v.settled as string,
    backers:Number(v.backers),pledgers:Number(v.pledgers),unverified:Number(v.unverified),paymentMint:v.paymentMint as string|null,
    unverifiedPledged:hasSplit?Number(v.unverifiedPledged):null,unverifiedPledgers:hasSplit?Number(v.unverifiedPledgers):null};
}
export function formatPaymentTotal(value:string){
  // Display only. Database and transaction evidence retain exact atomic units.
  return Number(value).toLocaleString(undefined,{maximumFractionDigits:6});
}
