"use client";

// Admin clawback panel — clawback_from_holder: seize a revoked/expired
// holder's units on a KycGated mint into a burn-only quarantine vault (a
// RedemptionQueue + BurnAndAttest custody vault of the same share class) via
// the mint's permanent delegate. Regulatory path: sanctions, court order,
// compliance breach — every action is reason + audit-logged.

import { useCallback, useEffect, useState } from "react";
import {
  useSendTransaction,
  useSolanaClient,
  useWalletConnection,
} from "@solana/react-hooks";
import { address, type Address } from "@solana/kit";
import { findAssociatedTokenPda } from "@solana-program/token-2022";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  findKycEntryPda,
  fetchMaybeKycEntry,
  getCustodyVaultDecoder,
  getCustodyVaultDiscriminatorBytes,
  getOpenCustodyVaultInstructionAsync,
  KycStatus,
  RealizeAction,
  VaultState,
  VaultType,
  type CustodyVault,
  type ShareClass,
} from "@/lib/generated/asset_registry";
import {
  fetchMaybeTransferHookConfig,
  findConfigPda,
  RestrictionMode,
} from "@/lib/generated/transfer_hook";
import { loadNetworkPreferIndexer } from "@/lib/indexer";
import { loadNetwork } from "@/lib/enumerate";
import { buildClawbackInstruction } from "@/lib/transaction-builders";
import { recordAudit } from "@/lib/supabase";
import { walletSigner } from "@/lib/wallet-signer";
import { explainSendError } from "@/lib/tx-error";
import { useToast } from "@/lib/toast";
import { ConfirmModal } from "@/components/confirm-modal";
import { FieldLabel } from "@/components/field";

const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" as Address;
const SYSTEM_PROGRAM = "11111111111111111111111111111111" as Address;

type Preflight = {
  hookGated: boolean;
  kycRegistry: Address | null;
  entryStatus: "revoked" | "expired" | "eligible" | "missing";
  balance: bigint | null;
  vault: { pda: Address; data: CustodyVault } | null;
  scPda: string;
};

export function ClawbackPanel() {
  const conn = useWalletConnection();
  const client = useSolanaClient();
  const tx = useSendTransaction();
  const toast = useToast();

  const [classes, setClasses] = useState<ShareClass[] | null>(null);
  const [selected, setSelected] = useState("");
  const [holder, setHolder] = useState("");
  const [amount, setAmount] = useState("");
  const [checking, setChecking] = useState(false);
  const [pre, setPre] = useState<Preflight | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  const sc = classes?.find((c) => c.mint.toString() === selected) ?? null;

  useEffect(() => {
    (async () => {
      try {
        const network = await loadNetworkPreferIndexer(() =>
          loadNetwork(client.runtime.rpc),
        );
        setClasses(network.shareClasses.filter((c) => c.mintInitialized));
      } catch {
        setClasses([]);
      }
    })();
  }, [client]);

  /** On-chain scan for custody vaults of the selected share class. */
  const loadVaults = useCallback(
    async (shareClassPda: string): Promise<{ pda: Address; data: CustodyVault }[]> => {
      const res = await client.runtime.rpc
        .getProgramAccounts(ASSET_REGISTRY_PROGRAM_ADDRESS, { encoding: "base64" })
        .send();
      const disc = getCustodyVaultDiscriminatorBytes();
      const dec = getCustodyVaultDecoder();
      const out: { pda: Address; data: CustodyVault }[] = [];
      for (const r of res) {
        const b64 = (r.account.data as readonly [string, string])[0];
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
        let match = bytes.length >= 8;
        for (let i = 0; i < 8 && match; i += 1) match = bytes[i] === disc[i];
        if (!match) continue;
        try {
          const data = dec.decode(bytes);
          if (data.shareClass.toString() === shareClassPda)
            out.push({ pda: r.pubkey, data });
        } catch {
          // short/legacy row — skip
        }
      }
      return out;
    },
    [client],
  );

  async function runPreflight() {
    if (!sc) return;
    setChecking(true);
    setPre(null);
    try {
      const h = address(holder.trim());
      // 1. Hook mode + KYC registry (clawback is KycGated-only).
      const [configPda] = await findConfigPda({ mint: sc.mint });
      const config = await fetchMaybeTransferHookConfig(client.runtime.rpc, configPda);
      const gated =
        config.exists && config.data.restrictionMode === RestrictionMode.KycGated;
      const registry =
        config.exists && config.data.kycRegistry.__option === "Some"
          ? config.data.kycRegistry.value
          : null;

      // 2. Holder's KYC entry — must be Revoked or expired.
      let entryStatus: Preflight["entryStatus"] = "missing";
      if (gated && registry) {
        const [entryPda] = await findKycEntryPda({ kycRegistry: registry, holder: h });
        const entry = await fetchMaybeKycEntry(client.runtime.rpc, entryPda);
        if (entry.exists) {
          if (entry.data.status === KycStatus.Revoked) entryStatus = "revoked";
          else if (
            entry.data.status === KycStatus.Expired ||
            (entry.data.status === KycStatus.Approved &&
              Number(entry.data.expiry) <= Math.floor(Date.now() / 1000))
          )
            entryStatus = "expired";
          else entryStatus = "eligible";
        }
      }

      // 3. Holder's balance.
      let balance: bigint | null = null;
      const [holderAta] = await findAssociatedTokenPda({
        mint: sc.mint,
        owner: h,
        tokenProgram: TOKEN_2022,
      });
      try {
        const bal = await client.runtime.rpc
          .getTokenAccountBalance(holderAta)
          .send();
        balance = BigInt(bal.value.amount);
      } catch {
        balance = null; // ATA may not exist
      }

      // 4. Quarantine vault of this share class (RedemptionQueue +
      //    BurnAndAttest + Active).
      const { findShareClassPda } = await import("@/lib/pdas");
      const scPda = await findShareClassPda(sc.asset, sc.classIndex);
      const vaults = await loadVaults(scPda.toString());
      const vault =
        vaults.find(
          (v) =>
            v.data.vaultType === VaultType.RedemptionQueue &&
            v.data.realizeAction === RealizeAction.BurnAndAttest &&
            v.data.state === VaultState.Active,
        ) ?? null;

      setPre({
        hookGated: gated,
        kycRegistry: registry,
        entryStatus,
        balance,
        vault,
        scPda: scPda.toString(),
      });
    } catch (err) {
      toast.showError("Preflight failed", err instanceof Error ? err.message : undefined);
    } finally {
      setChecking(false);
    }
  }

  async function openQuarantineVault() {
    if (!conn.wallet || !sc || !pre?.scPda) return;
    const signer = walletSigner(conn.wallet);
    const pendingId = toast.showPending("Opening the quarantine vault…");
    try {
      const ix = await getOpenCustodyVaultInstructionAsync({
        authority: signer,
        shareClass: address(pre.scPda),
        mint: sc.mint,
        tokenProgram: TOKEN_2022,
        vaultId: BigInt(Date.now()),
        vaultType: VaultType.RedemptionQueue,
        realizeAction: RealizeAction.BurnAndAttest,
        amount: BigInt(0),
        deadline: BigInt(0),
        metadataHash: new Uint8Array(32),
        beneficiary: SYSTEM_PROGRAM,
      });
      const sig = await tx.send({ instructions: [ix], feePayer: signer });
      toast.dismiss(pendingId);
      toast.showTx(sig, { title: "Quarantine vault opened" });
      await runPreflight();
    } catch (err) {
      toast.dismiss(pendingId);
      toast.showError("Failed to open vault", explainSendError(err));
    }
  }

  async function clawback(reason: string) {
    if (!conn.wallet || !sc || !pre?.vault) return;
    const h = address(holder.trim());
    const signer = walletSigner(conn.wallet);
    setBusy(true);
    const pendingId = toast.showPending("Clawing back the holder's units…");
    try {
      const [holderAta] = await findAssociatedTokenPda({
        mint: sc.mint,
        owner: h,
        tokenProgram: TOKEN_2022,
      });
      const ix = await buildClawbackInstruction(client.runtime.rpc, {
        authority: signer,
        shareClass: address(pre.scPda),
        mint: sc.mint,
        holderShareAccount: holderAta,
        destination: pre.vault.data.escrow,
        custodyVault: pre.vault.pda,
        kycRegistry: pre.kycRegistry!,
        holder: h,
        amount: amount.trim() === "" ? BigInt(0) : BigInt(amount.trim()),
      });
      const sig = await tx.send({
        instructions: [ix],
        feePayer: signer,
      });
      toast.dismiss(pendingId);
      toast.showTx(sig, { title: "Units seized into quarantine" });
      void recordAudit({
        ix_name: "clawback_from_holder",
        category: "other",
        actor_wallet: signer.address.toString(),
        reason,
        target_label: `${sc.mint.toString()} holder ${h.toString()}`,
        tx_signature: sig,
        metadata: {
          mint: sc.mint.toString(),
          holder: h.toString(),
          amount: amount.trim() === "" ? "full sweep" : amount.trim(),
          quarantine_vault: pre.vault.pda.toString(),
        },
      });
      setConfirm(false);
      setPre(null);
      setHolder("");
      setAmount("");
    } catch (err) {
      toast.dismiss(pendingId);
      toast.showError("Clawback failed", explainSendError(err));
    } finally {
      setBusy(false);
    }
  }

  const eligible =
    pre && pre.hookGated && (pre.entryStatus === "revoked" || pre.entryStatus === "expired");

  return (
    <section className="mt-8 rounded-xl border border-slate-200 bg-white p-5 shadow-card">
      <p className="text-xs font-semibold uppercase tracking-widest text-slate-500">
        Clawback
      </p>
      <h2 className="mt-1 text-lg font-semibold text-slate-900">
        Seize a revoked holder&apos;s units
      </h2>
      <p className="mt-2 max-w-3xl text-[13px] leading-relaxed text-slate-600">
        Regulatory path (sanctions / court order / compliance breach). Works on
        KYC-gated mints only, after the holder&apos;s passport is revoked or has
        expired. Units move into a burn-only quarantine vault — they cannot
        come back out through any wallet exit.
      </p>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="block">
          <FieldLabel>Share class (mint)</FieldLabel>
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
          >
            <option value="">
              {classes === null ? "Loading…" : "Select share class…"}
            </option>
            {(classes ?? []).map((c) => (
              <option key={c.mint.toString()} value={c.mint.toString()}>
                #{c.classIndex} · {c.mint.toString().slice(0, 8)}…
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <FieldLabel>Holder wallet</FieldLabel>
          <input
            value={holder}
            onChange={(e) => setHolder(e.target.value)}
            placeholder="Revoked / expired holder's wallet"
            className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-xs focus:border-slate-400 focus:outline-none"
          />
        </label>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          disabled={!sc || holder.trim().length < 32 || checking}
          onClick={() => void runPreflight()}
          className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-900 hover:border-slate-400 disabled:opacity-50"
        >
          {checking ? "Checking…" : "Check holder"}
        </button>
        {pre && (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span
              className={`rounded-full border px-2 py-0.5 font-semibold ${
                pre.hookGated
                  ? "border-brand-200 bg-brand-50 text-brand-800"
                  : "border-red-200 bg-red-50 text-red-800"
              }`}
            >
              {pre.hookGated ? "KYC-gated" : "Not KYC-gated — clawback unavailable"}
            </span>
            <span
              className={`rounded-full border px-2 py-0.5 font-semibold ${
                pre.entryStatus === "revoked" || pre.entryStatus === "expired"
                  ? "border-red-200 bg-red-50 text-red-800"
                  : "border-emerald-200 bg-emerald-50 text-emerald-800"
              }`}
            >
              {pre.entryStatus === "revoked"
                ? "Passport revoked"
                : pre.entryStatus === "expired"
                  ? "Passport expired"
                  : pre.entryStatus === "eligible"
                    ? "Holder still eligible — cannot claw back"
                    : "No KYC entry for this holder"}
            </span>
            <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 font-mono text-slate-700">
              balance {pre.balance === null ? "—" : pre.balance.toString()}
            </span>
            <span
              className={`rounded-full border px-2 py-0.5 font-semibold ${
                pre.vault
                  ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                  : "border-amber-200 bg-amber-50 text-amber-800"
              }`}
            >
              {pre.vault ? "Quarantine vault ready" : "No quarantine vault"}
            </span>
          </div>
        )}
      </div>

      {pre && eligible && !pre.vault && (
        <button
          type="button"
          disabled={tx.isSending}
          onClick={() => void openQuarantineVault()}
          className="mt-3 rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-900 hover:border-slate-400 disabled:opacity-50"
        >
          Open quarantine vault
        </button>
      )}

      {pre && eligible && pre.vault && (
        <div className="mt-4 flex flex-wrap items-end gap-2 border-t border-slate-100 pt-4">
          <label className="block">
            <FieldLabel>Amount (empty = full sweep)</FieldLabel>
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ""))}
              placeholder={pre.balance?.toString() ?? "0"}
              className="w-48 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
            />
          </label>
          <button
            type="button"
            disabled={tx.isSending || (pre.balance !== null && pre.balance === BigInt(0))}
            onClick={() => setConfirm(true)}
            className="rounded-lg bg-red-700 px-4 py-2 text-sm font-medium text-white hover:bg-red-800 disabled:opacity-50"
          >
            Claw back into quarantine
          </button>
        </div>
      )}

      <ConfirmModal
        open={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={(reason) => void clawback(reason)}
        title="Claw back this holder's units?"
        kind="destructive"
        confirmLabel="Claw back"
        description={
          <>
            <p>
              Seize{" "}
              <strong>
                {amount.trim() === "" ? "ALL" : amount.trim()} units
              </strong>{" "}
              of the mint from wallet{" "}
              <code className="break-all rounded bg-slate-100 px-1 font-mono text-xs">
                {holder.trim()}
              </code>{" "}
              into the burn-only quarantine vault. The holder&apos;s passport is{" "}
              {pre?.entryStatus}. This uses the mint&apos;s permanent delegate —
              no holder signature — and cannot be reversed through the platform.
            </p>
            <p className="mt-2 text-xs text-slate-500">
              Reason (regulatory reference) will be recorded in the audit log.
            </p>
          </>
        }
        busy={busy || tx.isSending}
      />
    </section>
  );
}
