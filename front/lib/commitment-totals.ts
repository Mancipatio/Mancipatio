export type CommitAggregate = { available:boolean; pledged:number; confirmed:number; settled:string; backers:number; pledgers:number; paymentMint:string|null; unverified:number };
export const UNKNOWN_COMMITMENTS:CommitAggregate={available:false,pledged:0,confirmed:0,settled:"0",backers:0,pledgers:0,paymentMint:null,unverified:0};
export function parseCommitmentTotals(value:unknown):CommitAggregate {
  if(!value || typeof value!=="object") return UNKNOWN_COMMITMENTS;
  const v=value as Record<string,unknown>;
  for(const key of ["pledged","confirmed","settled"]){
    if(typeof v[key]!=="string" || !/^\d+(\.\d+)?$/.test(v[key] as string) || !Number.isFinite(Number(v[key]))) return UNKNOWN_COMMITMENTS;
  }
  for(const key of ["backers","pledgers","unverified"]){if(!Number.isSafeInteger(v[key]) || Number(v[key])<0)return UNKNOWN_COMMITMENTS;}
  if(v.paymentMint!==null && typeof v.paymentMint!=="string")return UNKNOWN_COMMITMENTS;
  return {available:true,pledged:Number(v.pledged),confirmed:Number(v.confirmed),settled:v.settled as string,
    backers:Number(v.backers),pledgers:Number(v.pledgers),unverified:Number(v.unverified),paymentMint:v.paymentMint as string|null};
}
export function formatPaymentTotal(value:string){
  // Display only. Database and transaction evidence retain exact atomic units.
  return Number(value).toLocaleString(undefined,{maximumFractionDigits:6});
}
