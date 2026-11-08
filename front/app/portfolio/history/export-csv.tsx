"use client";

// "Export CSV" on /portfolio/history: the holder's purchases, OTC deals,
// conversions and transfers, one row per event, with a FIFO cost-basis
// summary per share class (lib/portfolio-export.ts), generated in the
// browser and downloaded. Records for the holder's own bookkeeping, not tax
// advice: the button says so, and so does the file's first line.
//
// One click reads, in order: the holder's own records (a signed session
// read: one wallet sign-in at most, nothing sent on-chain), the share-class
// labels (network data, indexer first) and the wallet's on-chain history
// (lib/portfolio-chain.ts, with progress). A history that cannot be read
// still gives a file, from the records alone, with a note saying what is
// missing. The records must belong to the wallet and network the click
// started with, or nothing is downloaded.

import { useRef, useState } from "react";
import { useSolanaClient, useWalletConnection } from "@solana/react-hooks";
import { loadNetwork } from "@/lib/enumerate";
import { loadNetworkPreferIndexer } from "@/lib/indexer";
import { detectNetwork } from "@/lib/network";
import { loadShareHistory } from "@/lib/portfolio-chain";
import {
  buildPortfolioExport,
  portfolioExportCsv,
  portfolioExportFileName,
  type ChainHistory,
} from "@/lib/portfolio-export";
import { downloadCsv, loadPortfolioExportRecords, shareClassLabels } from "@/lib/portfolio-export-client";
import { withRpcReadRetry } from "@/lib/rpc-retry";
import { WalletSessionRequiredError } from "@/lib/siws-client";

type ExportState =
  | { phase: "idle" }
  | { phase: "busy"; step: string }
  | { phase: "done"; notes: string[] }
  | { phase: "error"; message: string };

export function PortfolioExportButton() {
  const conn = useWalletConnection();
  const client = useSolanaClient();
  const [state, setState] = useState<ExportState>({ phase: "idle" });
  const running = useRef(false);

  async function exportCsv() {
    const session = conn.wallet;
    const wallet = session?.account.address;
    if (!session || !wallet || running.current) return;
    running.current = true;
    const network = detectNetwork();
    setState({ phase: "busy", step: "Reading your records…" });
    try {
      const records = await loadPortfolioExportRecords(session);
      if (records.wallet !== wallet.toString() || records.network !== network) {
        throw new Error("Your connected wallet or network changed. Try again.");
      }
      setState({ phase: "busy", step: "Reading share classes…" });
      const networkData = await loadNetworkPreferIndexer(() => withRpcReadRetry(() => loadNetwork(client.runtime.rpc))).catch(() => {
        // Without the share classes no transfer can be told apart: no file rather than a wrong one.
        throw new Error("Could not read the share classes from the network. Try again in a moment.");
      });
      const labels = await shareClassLabels(networkData);
      const recordMints = new Set(
        [...records.purchases.map((p) => p.mint), ...records.otc.map((o) => o.mint), ...records.conversions.map((c) => c.mint)]
          .filter((mint): mint is string => typeof mint === "string" && mint.length > 0),
      );
      const shareMints = new Set([...networkData.shareClasses.map((sc) => sc.mint.toString()), ...recordMints]);
      const recordSignatures = new Set(
        [...records.purchases.map((p) => p.signature), ...records.conversions.flatMap((c) => [c.deposit_tx, c.outcome_tx])]
          .filter((signature): signature is string => typeof signature === "string" && signature.length > 0),
      );
      let chain: ChainHistory | null = null;
      try {
        chain = await loadShareHistory(client.runtime.rpc, wallet, {
          shareMints,
          recordMints,
          recordSignatures,
          onProgress: (done, total) =>
            setState({ phase: "busy", step: `Reading on-chain history (${done} of ${total} transactions)…` }),
        });
      } catch {
        // The file still comes, from the records, and its notes say what is missing.
        chain = null;
      }
      const generatedAt = new Date();
      const data = buildPortfolioExport({ records, chain, labels });
      const csv = portfolioExportCsv(data, { wallet: wallet.toString(), network, generatedAt, fx: records.fx.rates, labels });
      downloadCsv(csv, portfolioExportFileName(network, wallet.toString(), generatedAt));
      setState({ phase: "done", notes: data.notes });
    } catch (err) {
      setState({
        phase: "error",
        message:
          err instanceof WalletSessionRequiredError
            ? "Sign in with your wallet to export: one signature, nothing is sent on-chain."
            : err instanceof Error
              ? err.message
              : "The export failed. Try again.",
      });
    } finally {
      running.current = false;
    }
  }

  return (
    <div className="flex max-w-xs flex-col items-start gap-1 sm:items-end">
      <button
        type="button"
        onClick={() => void exportCsv()}
        disabled={state.phase === "busy" || !conn.wallet}
        className="min-h-10 w-full shrink-0 whitespace-nowrap rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:border-slate-400 disabled:opacity-50 sm:w-auto"
      >
        {state.phase === "busy" ? "Preparing CSV…" : "Export CSV"}
      </button>
      <p className="text-[11px] leading-snug text-slate-500 sm:text-right">
        Purchases, OTC deals, conversions and transfers with a FIFO cost basis. Records for your own bookkeeping, not
        tax advice.
      </p>
      {state.phase === "busy" && (
        <p role="status" className="text-[11px] text-slate-500 sm:text-right">
          {state.step}
        </p>
      )}
      {state.phase === "error" && (
        <p role="alert" className="text-[11px] text-red-700 sm:text-right">
          {state.message}
        </p>
      )}
      {state.phase === "done" && (
        <p role="status" className="text-[11px] text-slate-600 sm:text-right">
          CSV downloaded.{state.notes.length > 0 ? ` ${state.notes.join(" ")}` : ""}
        </p>
      )}
    </div>
  );
}
