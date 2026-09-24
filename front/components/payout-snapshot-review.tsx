"use client";
import { useState } from "react";
import { useWalletConnection } from "@solana/react-hooks";
import { preparePayoutSnapshot, bindPayoutSnapshot, readPayoutSnapshots, readOriginalPayoutEntries } from "@/lib/payout-snapshots-client";
import { parseWeightCsv } from "@/lib/distributions";
import type { PayoutSnapshotKind, PreparedPayoutSnapshot, SnapshotWeight } from "@/lib/payout-snapshots";
/** Stored rows are runtime data: an unknown kind is labelled, never assumed. */
function snapshotLabel(s: PreparedPayoutSnapshot) {
  const kind: string = s.kind;
  if (kind === "vault_vote") return `Vote round ${s.round}`;
  if (kind === "investor_yield") return "Original investor yield";
  return "Unsupported snapshot kind";
}
export function PayoutSnapshotReview({ vault, currentRound }: { vault: string; currentRound: bigint }) {
  const conn = useWalletConnection();
  const [rows, setRows] = useState<PreparedPayoutSnapshot[] | null>(null);
  const [entries, setEntries] = useState<{ id: string; rows: SnapshotWeight[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restoreKind, setRestoreKind] = useState<PayoutSnapshotKind>("vault_vote");
  const [restoreRound, setRestoreRound] = useState(String(currentRound));
  const [restoreCsv, setRestoreCsv] = useState("");
  async function restore() {
    setBusy(true); setError(null);
    try {
      if (restoreKind === "vault_vote" && (!/^[1-9]\d*$/.test(restoreRound) || BigInt(restoreRound) > currentRound)) throw new Error("Choose an existing vote round");
      const parsed = parseWeightCsv(restoreCsv); if (parsed.errors.length) throw new Error(parsed.errors.slice(0, 3).join(" · "));
      const saved = await preparePayoutSnapshot(conn.wallet, restoreKind, vault, restoreKind === "vault_vote" ? restoreRound : "0", parsed.rows.map((r) => ({ wallet: r.wallet, weight: String(r.weight) })));
      setRows((rows) => [saved, ...(rows ?? []).filter((r) => r.id !== saved.id)]);
      const bound = await bindPayoutSnapshot(conn.wallet, saved.id);
      setRows((rows) => rows?.map((r) => r.id === bound.id ? bound : r) ?? [bound]);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }
  async function load() {
    setBusy(true); setError(null);
    try { setRows((await readPayoutSnapshots(conn.wallet, vault)).snapshots); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }
  async function verify(id: string) {
    setBusy(true); setError(null);
    try { const bound = await bindPayoutSnapshot(conn.wallet, id); setRows((rows) => rows?.map((r) => r.id === id ? bound : r) ?? null); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }
  async function review(id: string) {
    setBusy(true); setError(null);
    try { setEntries({ id, rows: (await readOriginalPayoutEntries(conn.wallet, vault, id)).entries }); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }
  function download() {
    if (!entries) return;
    const csv = "wallet,weight\n" + entries.rows.map((r) => `${r.wallet},${r.weight}`).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a"); a.href = url; a.download = `original-investors-${entries.id}.csv`; a.click(); URL.revokeObjectURL(url);
  }
  return <section className="mt-4 rounded-lg border border-emerald-200 p-3 text-xs">
    <div className="flex items-center justify-between gap-3"><strong>Original investor snapshots</strong><button type="button" disabled={busy} onClick={() => void load()} className="rounded-md border border-emerald-200 px-3 py-2 text-emerald-800 disabled:opacity-50">{busy ? "Working…" : "Review saved snapshots"}</button></div>
    <p className="mt-2 text-slate-600">A saved list is separate from a verified on-chain root. Verification can be retried without resending a funding or vote transaction.</p>
    <details className="mt-3"><summary className="cursor-pointer font-medium">Restore a missing original snapshot</summary><p className="my-2 text-slate-600">Upload the original approved investor CSV for an existing on-chain root. Current holder balances cannot replace it.</p><div className="flex gap-2"><select value={restoreKind} onChange={(e) => setRestoreKind(e.target.value as PayoutSnapshotKind)} disabled={busy} aria-label="Snapshot type" className="rounded border border-slate-300 p-2"><option value="vault_vote">Vote / refund</option><option value="investor_yield">Investor yield</option></select>{restoreKind === "vault_vote" && <input value={restoreRound} onChange={(e) => setRestoreRound(e.target.value)} disabled={busy} aria-label="Existing vote round" inputMode="numeric" className="w-28 rounded border border-slate-300 p-2" />}</div><textarea value={restoreCsv} onChange={(e) => setRestoreCsv(e.target.value)} disabled={busy} rows={4} placeholder="wallet,weight" aria-label="Original investor CSV for restoration" className="mt-2 w-full rounded border border-slate-300 p-2 font-mono" /><button type="button" disabled={busy || !restoreCsv.trim()} onClick={() => void restore()} className="mt-2 rounded bg-emerald-700 px-3 py-2 text-white disabled:opacity-50">Restore and verify original snapshot</button></details>
    {error && <p role="alert" className="mt-2 text-rose-700">{error}</p>}
    {rows && <div className="mt-3 space-y-2">{rows.length === 0 && <p>No saved snapshots. Restore the original investor CSV in the relevant action.</p>}{rows.map((s) => <div key={s.id} className="rounded-md border border-slate-200 p-2"><strong>{snapshotLabel(s)} · {s.status === "bound" ? "Verified on chain" : "Saved, not yet verified"}</strong><p>{s.entry_count} investors · weight {s.total_weight}</p><p className="break-all text-slate-500">Root: {s.root_hex}</p><div className="mt-2 flex gap-3"><button type="button" disabled={busy} onClick={() => void verify(s.id)} className="underline">Verify on chain</button><button type="button" disabled={busy} onClick={() => void review(s.id)} className="underline">Review original entries</button></div></div>)}{rows.length === 100 && <p>Showing the latest 100 saved snapshots.</p>}</div>}
    {entries && <details open className="mt-3"><summary>Original entries · {entries.rows.length} investors</summary><button type="button" className="my-2 underline" onClick={download}>Download complete CSV</button><div className="max-h-64 overflow-auto"><table className="w-full text-left"><thead><tr><th>Investor wallet</th><th>Original weight</th></tr></thead><tbody>{entries.rows.slice(0, 100).map((r) => <tr key={r.wallet}><td className="break-all pr-3">{r.wallet}</td><td>{r.weight}</td></tr>)}</tbody></table></div>{entries.rows.length > 100 && <p>Preview: first 100 entries. The download contains the complete list.</p>}</details>}
  </section>;
}
