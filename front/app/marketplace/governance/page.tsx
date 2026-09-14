"use client";

import Link from "next/link";
import { useSolanaClient } from "@solana/react-hooks";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ProposalOutcome,
  ProposalStatus,
} from "@/lib/generated/asset_registry";
import { loadProposalsFromIndexer } from "@/lib/indexer";
import { SkeletonTable } from "@/components/skeleton";

type Lifecycle = "Active" | "Passed" | "Rejected" | "Pending";

const BADGE: Record<Lifecycle, string> = {
  Active: "bg-emerald-100 text-emerald-800 border-emerald-200",
  Passed: "bg-brand-100 text-brand-800 border-brand-200",
  Rejected: "bg-red-100 text-red-800 border-red-200",
  Pending: "bg-mx-rule text-mx-ink-soft border-mx-rule-strong",
};

export default function PublicGovernancePage() {
  const client = useSolanaClient();
  const [proposals, setProposals] = useState<
    Awaited<ReturnType<typeof loadProposalsFromIndexer>> | null
  >(null);
  const [failed, setFailed] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const data = await loadProposalsFromIndexer();
      setProposals(data);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  void client;

  const rows = useMemo(() => {
    if (!proposals) return [];
    return proposals
      .map((p) => {
        const lc: Lifecycle =
          p.status === ProposalStatus.Active
            ? "Active"
            : p.outcome === ProposalOutcome.Passed
              ? "Passed"
              : p.outcome === ProposalOutcome.Rejected
                ? "Rejected"
                : "Pending";
        return { p, lc };
      })
      .sort((a, b) => Number(b.p.proposalId - a.p.proposalId));
  }, [proposals]);

  return (
    <section>
      <div>
        <p className="text-xs font-semibold uppercase tracking-widest text-mx-ink-faint">
          Governance
        </p>
        <h1 className="mt-1 text-2xl font-semibold text-mx-ink">
          Active proposals
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-mx-ink-soft">
          Snapshot-weighted advisory votes per share class. Outcomes are
          signaling — issuers act on them off-chain (no automatic execution in
          v0.1).
        </p>
      </div>

      {failed ? (
        <p className="mt-8 text-sm text-red-600">Failed to load.</p>
      ) : proposals === null ? (
        <div className="mt-8">
          <SkeletonTable rows={3} cols={4} />
        </div>
      ) : rows.length === 0 ? (
        <Empty />
      ) : (
        <div className="mt-8 overflow-hidden rounded-[3px] border border-mx-rule bg-white">
          <table className="w-full text-sm">
            <thead className="border-b border-mx-rule bg-mx-paper text-left text-xs uppercase tracking-wider text-mx-ink-faint">
              <tr>
                <th className="px-4 py-3 font-medium">Proposal</th>
                <th className="px-4 py-3 text-right font-medium">For</th>
                <th className="px-4 py-3 text-right font-medium">Against</th>
                <th className="px-4 py-3 text-right font-medium">Abstain</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 text-right font-medium">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-mx-rule">
              {rows.map(({ p, lc }, i) => (
                <tr key={i} className="text-mx-ink-soft">
                  <td className="px-4 py-3">
                    <p className="font-mono text-xs font-semibold text-mx-ink">
                      proposal #{String(p.proposalId)}
                    </p>
                    <p className="mt-0.5 font-mono text-[11px] text-mx-ink-faint">
                      share-class {p.shareClass.toString().slice(0, 6)}…
                      {p.shareClass.toString().slice(-4)}
                    </p>
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-emerald-700">
                    {String(p.forWeight)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-red-700">
                    {String(p.againstWeight)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-mx-ink-faint">
                    {String(p.abstainWeight)}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${BADGE[lc]}`}
                    >
                      {lc}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      href="/portfolio/governance"
                      className="text-xs text-mx-ink-soft underline-offset-2 hover:underline"
                    >
                      Vote →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Empty() {
  return (
    <div className="mt-8 rounded-[3px] border border-mx-rule bg-white p-12 text-center">
      <p className="text-sm text-mx-ink-soft">No proposals yet.</p>
    </div>
  );
}
