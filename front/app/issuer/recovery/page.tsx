"use client";
import { useState } from "react";
import { address, isAddress } from "@solana/kit";
import { useSolanaClient, useWalletConnection } from "@solana/react-hooks";
import { WalletRequired } from "@/components/wallet-required";
import { ConfirmModal } from "@/components/confirm-modal";
import { detectNetwork } from "@/lib/network";
import { walletSigner } from "@/lib/wallet-signer";
import { useToast } from "@/lib/toast";
import {
  prepareIssuerRecovery,
  parseIssuerRecovery,
  signIssuerRecovery,
  submitIssuerRecovery,
  type IssuerRecoveryEnvelope,
} from "@/lib/issuer-recovery";
export default function IssuerRecoveryPage() {
  const client = useSolanaClient(),
    conn = useWalletConnection(),
    toast = useToast(),
    network = detectNetwork();
  const [issuer, setIssuer] = useState(""),
    [authority, setAuthority] = useState(""),
    [jurisdiction, setJurisdiction] = useState(""),
    [hash, setHash] = useState(""),
    [raw, setRaw] = useState(""),
    [envelope, setEnvelope] = useState<IssuerRecoveryEnvelope | null>(null),
    [busy, setBusy] = useState(false),
    [confirm, setConfirm] = useState<"sign" | "send" | null>(null);
  function save(e: IssuerRecoveryEnvelope) {
    setEnvelope(e);
    setRaw(JSON.stringify(e, null, 2));
  }
  async function prepare() {
    setBusy(true);
    try {
      save(
        await prepareIssuerRecovery(client.runtime.rpc, network, {
          issuer: address(issuer.trim()),
          newAuthority: address(authority.trim()),
          jurisdiction: Number(jurisdiction),
          kybDocHash: hash.trim(),
        }),
      );
    } catch (error) {
      toast.showError(
        "Recovery preparation failed",
        error instanceof Error ? error.message : undefined,
      );
    } finally {
      setBusy(false);
    }
  }
  function inspect() {
    try {
      setEnvelope(parseIssuerRecovery(raw, network));
    } catch (error) {
      toast.showError(
        "Invalid recovery document",
        error instanceof Error ? error.message : undefined,
      );
    }
  }
  async function act() {
    if (!envelope || !conn.wallet || !confirm) return;
    setBusy(true);
    try {
      if (confirm === "sign")
        save(
          await signIssuerRecovery(
            client.runtime.rpc,
            envelope,
            walletSigner(conn.wallet),
          ),
        );
      else {
        const sig = await submitIssuerRecovery(client.runtime.rpc, envelope);
        toast.showTx(sig, {
          title: "Issuer recovery submitted; KYB returns to Pending",
        });
      }
      setConfirm(null);
    } catch (error) {
      toast.showError(
        "Recovery was not completed",
        error instanceof Error ? error.message : undefined,
      );
    } finally {
      setBusy(false);
    }
  }
  const wallet = conn.wallet?.account.address,
    maySign =
      envelope &&
      (wallet === envelope.superAdmin || wallet === envelope.newAuthority),
    signed =
      envelope &&
      [envelope.superAdmin, envelope.newAuthority].every(
        (key) => !!envelope.signatures[key],
      );
  return (
    <section className="mx-auto w-full max-w-3xl space-y-5">
      <h1 className="text-xl font-semibold text-slate-900">
        Recover an unused issuer registration
      </h1>
      <p className="text-sm text-slate-600">
        Only an unused Pending or Rejected registration can be recovered. The
        current Super Admin and the replacement issuer wallet both sign the same
        transaction. Recovery preserves the legal entity ID and requires a fresh
        KYB review.
      </p>
      {!conn.wallet ? (
        <WalletRequired />
      ) : (
        <div className="space-y-5">
          <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-5">
            <h2 className="text-sm font-semibold">
              1. Prepare the recovery terms
            </h2>
            {[
              ["Issuer account", issuer, setIssuer],
              ["Replacement issuer wallet", authority, setAuthority],
              ["Jurisdiction (ISO numeric)", jurisdiction, setJurisdiction],
              ["KYB document SHA-256", hash, setHash],
            ].map(([label, value, set]) => (
              <label
                key={label as string}
                className="block text-xs text-slate-600"
              >
                {label as string}
                <input
                  value={value as string}
                  onChange={(e) => (set as (v: string) => void)(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs"
                />
              </label>
            ))}
            <button
              type="button"
              disabled={
                busy ||
                !isAddress(issuer.trim()) ||
                !isAddress(authority.trim()) ||
                !jurisdiction ||
                !/^[a-fA-F0-9]{64}$/.test(hash.trim())
              }
              onClick={() => void prepare()}
              className="rounded-lg bg-brand-700 px-4 py-2 text-sm text-white disabled:opacity-50"
            >
              Prepare recovery document
            </button>
          </div>
          <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-5">
            <h2 className="text-sm font-semibold">
              2. Share and review the public document
            </h2>
            <p className="text-xs text-slate-500">
              Copy the document between the two wallets. It contains public
              terms and signatures, never private keys. The blockhash expires
              quickly; after expiry prepare again and collect both signatures
              again. Imported content is rebuilt as a single recovery
              instruction.
            </p>
            <textarea
              aria-label="Public recovery document"
              rows={10}
              value={raw}
              onChange={(e) => {
                setRaw(e.target.value);
                setEnvelope(null);
              }}
              className="w-full rounded-lg border border-slate-300 p-3 font-mono text-xs"
            />
            <button
              type="button"
              onClick={inspect}
              disabled={busy || !raw.trim()}
              className="text-sm font-semibold text-brand-800 underline"
            >
              Review imported document
            </button>
            {envelope && (
              <div className="space-y-2 rounded-lg bg-brand-50 p-3 text-xs text-brand-950">
                <p>Network: {envelope.network}</p>
                <p className="break-all">Issuer: {envelope.issuer}</p>
                <p className="break-all">
                  Previous authority: {envelope.previousAuthority}
                </p>
                <p className="break-all">
                  Replacement: {envelope.newAuthority}
                </p>
                <p>Jurisdiction: {envelope.jurisdiction}</p>
                <p className="break-all">KYB SHA-256: {envelope.kybDocHash}</p>
                <p className="break-all">
                  Super Admin: {envelope.superAdmin} —{" "}
                  {envelope.signatures[envelope.superAdmin]
                    ? "signature supplied (verified before use)"
                    : "signature needed"}
                </p>
                <p>
                  Replacement signature:{" "}
                  {envelope.signatures[envelope.newAuthority]
                    ? "supplied (verified before use)"
                    : "needed"}
                </p>
                <div className="flex flex-wrap gap-4">
                  {maySign && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setConfirm("sign")}
                      className="font-semibold underline"
                    >
                      Sign reviewed recovery
                    </button>
                  )}
                  {signed && (
                    <button
                      type="button"
                      disabled={busy || !maySign}
                      onClick={() => setConfirm("send")}
                      className="font-semibold underline"
                    >
                      Submit both signatures
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
      <ConfirmModal
        open={confirm !== null}
        title={
          confirm === "sign"
            ? "Sign the recovery terms?"
            : "Submit issuer recovery?"
        }
        description={
          envelope
            ? `Reassign issuer ${envelope.issuer} to ${envelope.newAuthority} on ${envelope.network}, reset KYB to Pending, jurisdiction ${envelope.jurisdiction}, document hash ${envelope.kybDocHash}. The Super Admin pays the network fee.`
            : ""
        }
        kind="warning"
        requireReason={false}
        confirmLabel={confirm === "sign" ? "Sign recovery" : "Submit recovery"}
        busy={busy}
        onConfirm={() => void act()}
        onClose={() => setConfirm(null)}
      />
    </section>
  );
}
