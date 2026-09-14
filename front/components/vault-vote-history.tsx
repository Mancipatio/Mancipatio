"use client";
import type { VaultVoteRecord } from "@/lib/payout-vault";
import { VaultVoteOutcome } from "@/lib/generated/asset_registry";
export function VaultVoteHistory({ records, currentRound }: { records: VaultVoteRecord[]; currentRound: bigint }) {
  if (!records.length) return <p className="mt-3 text-xs text-slate-500">No recorded v2 vote rounds.</p>;
  return <details className="mt-3 rounded-lg border border-slate-200 p-3 text-xs"><summary className="cursor-pointer font-medium">Vote history · {records.length} rounds</summary><div className="mt-2 overflow-x-auto"><table className="w-full text-left"><thead><tr><th>Round</th><th>Outcome</th><th>Return weight</th><th>Extend weight</th><th>Ended</th></tr></thead><tbody>{records.map(({ address, vote }) => <tr key={address} className="border-t border-slate-100"><td className="py-2">#{String(vote.round)}{vote.round === currentRound ? " · current" : ""}</td><td>{VaultVoteOutcome[vote.outcome]}</td><td>{String(vote.returnWeight)}</td><td>{String(vote.extendWeight)}</td><td>{new Date(Number(vote.endTs) * 1000).toLocaleString()}</td></tr>)}</tbody></table></div></details>;
}
