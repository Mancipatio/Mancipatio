"use client";
import { useState, useSyncExternalStore } from "react";
import Link from "next/link";
import {
  getLegacySnapshot,
  getLegacyServerSnapshot,
  subscribeLegacy,
} from "@/lib/legacy-accounts-store";
import {
  useSolanaClient,
  useWalletConnection,
  useSendTransaction,
} from "@solana/react-hooks";
import { address, isAddress, type Address } from "@solana/kit";
import { walletSigner } from "@/lib/wallet-signer";
import { useToast } from "@/lib/toast";
import { findShareClassPda } from "@/lib/pdas";
import { buildLegacyPreparation } from "@/lib/legacy-preparation";
import { detectNetwork } from "@/lib/network";
/** Old financial rights remain visible, separate from current action forms. */
export function LegacyAccountsNotice() {
  const client = useSolanaClient(),
    conn = useWalletConnection(),
    tx = useSendTransaction(),
    toast = useToast();
  const [manual, setManual] = useState("");
  async function prepare(target: Address | Promise<Address>) {
    if (!conn.wallet) return;
    try {
      const pda = await target,
        signer = walletSigner(conn.wallet),
        ix = await buildLegacyPreparation(client.runtime.rpc, pda, signer);
      const sig = await tx.send({ instructions: [ix], feePayer: signer });
      toast.showTx(sig, { title: "Legacy account preparation submitted" });
    } catch (error) {
      toast.showError(
        "Legacy preparation not completed",
        error instanceof Error ? error.message : undefined,
      );
    }
  }
  const state = useSyncExternalStore(
    subscribeLegacy,
    getLegacySnapshot,
    getLegacyServerSnapshot,
  );
  if (
    state.network !== detectNetwork() ||
    (!state.shareClasses.length && !state.payoutVaults.length)
  )
    return null;
  return (
    <aside
      className="mx-4 mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-950 sm:mx-7"
      aria-label="Legacy accounts"
    >
      <strong>Legacy v1 accounts · {state.network} · preserved rights</strong>
      <p className="mt-1">
        Current forms and v2 totals exclude these earlier accounts. Their
        recorded balances and rights remain visible below. Lifetime issuance and
        vote-round history require a separate verified migration.
      </p>
      <p className="mt-2 text-xs">
        Before an allowed legacy refund, prepare the affected share class,
        payout vault and original vote account as applicable. This pays
        additional account rent and normalizes unused padding; balances, rights
        and version remain unchanged. Frozen or pending v1 votes need a separate
        reviewed migration.
      </p>
      <Link
        href="/portfolio/rights"
        className="mt-2 inline-block font-medium underline underline-offset-4"
      >
        Review preserved payout rights and available legacy refunds
      </Link>
      <details className="mt-2">
        <summary className="cursor-pointer font-medium">
          View {state.shareClasses.length} legacy share classes and{" "}
          {state.payoutVaults.length} legacy payout vaults
        </summary>
        {state.shareClasses.length > 0 && (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <caption className="mb-2 text-left">
                Share-class values are exact recorded base units; lifetime
                issued is unknown.
              </caption>
              <thead>
                <tr>
                  <th>Asset / class</th>
                  <th>Mint</th>
                  <th>Circulating</th>
                  <th>Locked</th>
                  <th>Recorded cap</th>
                  <th>Lifetime issued</th>
                  <th>Preparation</th>
                </tr>
              </thead>
              <tbody>
                {state.shareClasses.map((s) => (
                  <tr
                    key={`${s.asset}:${s.classIndex}`}
                    className="border-t border-emerald-200"
                  >
                    <td className="max-w-64 break-all p-2">
                      {s.asset} / #{s.classIndex}
                    </td>
                    <td className="max-w-64 break-all p-2">{s.mint}</td>
                    <td className="p-2">{String(s.circulatingSupply)}</td>
                    <td className="p-2">{String(s.lockedSupply)}</td>
                    <td className="p-2">
                      {s.maxSupply.__option === "Some"
                        ? String(s.maxSupply.value)
                        : "Uncapped"}
                    </td>
                    <td className="p-2">Unknown (v1)</td>
                    <td className="p-2">
                      <button
                        type="button"
                        disabled={!conn.wallet || tx.isSending}
                        onClick={() =>
                          void prepare(findShareClassPda(s.asset, s.classIndex))
                        }
                        className="text-brand-800 underline disabled:opacity-50"
                      >
                        Prepare account
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {state.payoutVaults.length > 0 && (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <caption className="mb-2 text-left">
                Payout values are exact payment-mint base units; v2 vote rounds
                are unavailable.
              </caption>
              <thead>
                <tr>
                  <th>Vault / sale</th>
                  <th>Payment mint</th>
                  <th>Recorded total</th>
                  <th>Released</th>
                  <th>Investor yield pool</th>
                  <th>Version</th>
                  <th>Preparation</th>
                </tr>
              </thead>
              <tbody>
                {state.payoutVaults.map(
                  ({ address: vaultAddress, vault: v }) => (
                    <tr
                      key={vaultAddress}
                      className="border-t border-emerald-200"
                    >
                      <td className="max-w-64 break-all p-2">
                        {vaultAddress}
                        <br />
                        Sale: {v.sale}
                      </td>
                      <td className="max-w-64 break-all p-2">
                        {v.paymentMint}
                      </td>
                      <td className="p-2">{String(v.totalAmount)}</td>
                      <td className="p-2">{String(v.released)}</td>
                      <td className="p-2">{String(v.investorYieldPool)}</td>
                      <td className="p-2">v1 · read only</td>
                      <td className="p-2">
                        <button
                          type="button"
                          disabled={!conn.wallet || tx.isSending}
                          onClick={() => void prepare(address(vaultAddress))}
                          className="text-brand-800 underline disabled:opacity-50"
                        >
                          Prepare account
                        </button>
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
        )}
        <div className="mt-4 flex flex-wrap gap-2">
          <input
            aria-label="Original legacy account address"
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            placeholder="Original v1 account address"
            className="min-w-64 flex-1 rounded-lg border border-brand-200 bg-white px-3 py-2 font-mono text-xs"
          />
          <button
            type="button"
            disabled={!conn.wallet || tx.isSending || !isAddress(manual.trim())}
            onClick={() => void prepare(address(manual.trim()))}
            className="rounded-lg bg-brand-700 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
          >
            Prepare specified account
          </button>
        </div>
      </details>
    </aside>
  );
}
