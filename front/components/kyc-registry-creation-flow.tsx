"use client";

// /account/roles/kyc-registry (Talas 3.1 K5): create the platform KYC
// registry when the KYC authority and the Admin co-signer are separate keys.
// Prepare the typed terms, share the public document, let each key review
// and sign it, then submit. Modeled on /issuer/recovery; the checks live in
// lib/kyc-registry-creation. The runbook default (OD7) needs none of this:
// an Admin creates the registry alone on /admin/kyc and proposes the
// registry authority to the compliance key.

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { isAddress, type Address } from "@solana/kit";
import { useSolanaClient, useWalletConnection } from "@solana/react-hooks";
import { ConfirmModal } from "@/components/confirm-modal";
import { JurisdictionSelector } from "@/components/jurisdiction-selector";
import { WalletRequired } from "@/components/wallet-required";
import { invalidateRoles } from "@/lib/auth";
import { countryName } from "@/lib/countries";
import {
  invalidateKycAuthorityContext,
  waitForKycRegistry,
} from "@/lib/kyc-authority";
import {
  MAX_ENVELOPE_CU_PRICE,
  kycRegistryAddressFor,
  kycRegistryCreationSigned,
  parseKycRegistryCreation,
  prepareKycRegistryCreation,
  signKycRegistryCreation,
  submitKycRegistryCreation,
  type KycRegistryCreationEnvelope,
} from "@/lib/kyc-registry-creation";
import { configuredKycRegistry } from "@/lib/kyc-registry-pin";
import { toggleJurisdiction } from "@/lib/kyc-registry-rotation";
import { detectNetwork } from "@/lib/network";
import { DEFAULT_APPROVED_JURISDICTIONS } from "@/lib/passport";
import { recordAudit } from "@/lib/supabase";
import { useToast } from "@/lib/toast";
import { explainSendError } from "@/lib/tx-error";
import { walletSigner } from "@/lib/wallet-signer";

const EU_DEFAULTS = DEFAULT_APPROVED_JURISDICTIONS.map((c) => String(c).padStart(3, "0"));
const toCodes = (s: ReadonlySet<string>) => Array.from(s).map((c) => parseInt(c, 10));
const names = (codes: number[]) =>
  codes.length === 0 ? "none" : codes.map((c) => countryName(String(c).padStart(3, "0"))).join(", ");

function pinState(): { pin: Address | null; error: string | null } {
  try {
    return { pin: configuredKycRegistry(), error: null };
  } catch (err) {
    return { pin: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Worst-case priority fee of the envelope, in SOL. */
function priorityFeeSol(e: Pick<KycRegistryCreationEnvelope, "computeUnitLimit" | "computeUnitPriceMicroLamports">) {
  const lamports = (BigInt(e.computeUnitLimit) * BigInt(e.computeUnitPriceMicroLamports)) / BigInt(1_000_000);
  return (Number(lamports) / 1e9).toFixed(9).replace(/0+$/, "").replace(/\.$/, "");
}

export function KycRegistryCreationFlow() {
  const client = useSolanaClient();
  const conn = useWalletConnection();
  const toast = useToast();
  const network = detectNetwork();
  const rpc = client.runtime.rpc;
  const wallet = conn.wallet?.account.address?.toString() ?? null;
  const { pin, error: pinError } = useMemo(() => pinState(), []);

  const [kycAuthority, setKycAuthority] = useState("");
  const [adminAuthority, setAdminAuthority] = useState("");
  const [approved, setApproved] = useState<Set<string>>(() => new Set(EU_DEFAULTS));
  const [blocked, setBlocked] = useState<Set<string>>(new Set());
  const [showSelector, setShowSelector] = useState(false);
  // The registry derived from the typed KYC authority, keyed by that input.
  const [derivedFor, setDerivedFor] = useState<{ input: string; registry: Address } | null>(null);
  const [raw, setRaw] = useState("");
  const [envelope, setEnvelope] = useState<KycRegistryCreationEnvelope | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<"sign" | "send" | null>(null);

  const kycInput = kycAuthority.trim();
  useEffect(() => {
    if (!isAddress(kycInput)) return;
    let live = true;
    void kycRegistryAddressFor(kycInput).then((registry) => {
      if (live) setDerivedFor({ input: kycInput, registry });
    });
    return () => {
      live = false;
    };
  }, [kycInput]);
  const derived = derivedFor && derivedFor.input === kycInput ? derivedFor.registry : null;

  function save(e: KycRegistryCreationEnvelope) {
    setEnvelope(e);
    setRaw(JSON.stringify(e, null, 2));
  }

  function toggle(code: string, target: "approved" | "blocked") {
    const next = toggleJurisdiction(approved, blocked, code, target);
    setApproved(next.approved);
    setBlocked(next.blocked);
  }

  async function prepare() {
    setBusy(true);
    try {
      save(
        await prepareKycRegistryCreation(rpc, network, {
          kycAuthority: kycInput as Address,
          adminAuthority: adminAuthority.trim() as Address,
          approved: toCodes(approved),
          blocked: toCodes(blocked),
        }),
      );
    } catch (err) {
      toast.showError("Could not prepare the document", err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  }

  async function inspect() {
    try {
      setEnvelope(await parseKycRegistryCreation(raw, network));
    } catch (err) {
      toast.showError("Invalid registry creation document", err instanceof Error ? err.message : undefined);
    }
  }

  async function act() {
    if (!envelope || !conn.wallet || !confirm || !wallet) return;
    setBusy(true);
    const metadata = {
      registry: envelope.registry,
      kyc_authority: envelope.kycAuthority,
      admin_authority: envelope.adminAuthority,
      approved: envelope.approved.length,
      blocked: envelope.blocked.length,
      compute_unit_limit: envelope.computeUnitLimit,
      compute_unit_price: envelope.computeUnitPriceMicroLamports,
    };
    try {
      if (confirm === "sign") {
        save(await signKycRegistryCreation(rpc, envelope, walletSigner(conn.wallet)));
        toast.show({ kind: "success", title: "Signature added", description: "Share the updated document with the other signer." });
      } else {
        const sig = await submitKycRegistryCreation(rpc, envelope);
        toast.showTx(sig, { title: "KYC registry created" });
        void recordAudit({
          ix_name: "create_kyc_registry",
          category: "issuers",
          actor_wallet: wallet,
          reason: "Platform KYC registry created with two signers (/account/roles/kyc-registry)",
          target_label: envelope.registry,
          tx_signature: sig,
          status: "success",
          metadata,
        });
        invalidateKycAuthorityContext(rpc);
        await waitForKycRegistry(rpc).catch(() => null);
        invalidateKycAuthorityContext(rpc);
        invalidateRoles();
      }
      setConfirm(null);
    } catch (err) {
      const detail = explainSendError(err);
      toast.showError(confirm === "sign" ? "Not signed" : "Registry not created", detail);
      if (confirm === "send") {
        void recordAudit({
          ix_name: "create_kyc_registry",
          category: "issuers",
          actor_wallet: wallet,
          reason: "Platform KYC registry created with two signers (/account/roles/kyc-registry)",
          target_label: envelope.registry,
          status: "failed",
          metadata: { ...metadata, error: detail },
        });
      }
    } finally {
      setBusy(false);
    }
  }

  const maySign =
    !!envelope &&
    !!wallet &&
    (wallet === envelope.kycAuthority || wallet === envelope.adminAuthority) &&
    !envelope.signatures[wallet];
  const signed = !!envelope && kycRegistryCreationSigned(envelope);
  const pinMatch = derived && pin ? derived === pin : null;

  return (
    <section className="mx-auto w-full max-w-3xl space-y-5">
      <div>
        <p className="page-eyebrow">
          <Link href="/account/roles" className="hover:underline">On-chain roles</Link> · KYC registry
        </p>
        <h1 className="mt-1 text-xl font-semibold text-slate-900">Create the KYC registry with two signers</h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-slate-600">
          The KYC authority owns the registry (its address is derived from that
          key) and pays for it; any active Admin co-signs the creation, and has
          no say afterwards. Both keys sign the same transaction, each on its
          own device. The simpler default: an Admin creates the registry alone
          on /admin/kyc and proposes the registry authority to the compliance
          key, which accepts at /account/roles.
        </p>
      </div>

      {!conn.wallet ? (
        <WalletRequired />
      ) : (
        <>
          <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-5">
            <h2 className="text-sm font-semibold">1. Prepare the terms</h2>
            <label className="block text-xs text-slate-600">
              KYC authority (owns the registry, pays the fee)
              <input
                value={kycAuthority}
                onChange={(e) => setKycAuthority(e.target.value)}
                placeholder={wallet ?? ""}
                spellCheck={false}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs"
              />
            </label>
            <label className="block text-xs text-slate-600">
              Admin co-signer (holds an active Admin record)
              <input
                value={adminAuthority}
                onChange={(e) => setAdminAuthority(e.target.value)}
                spellCheck={false}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs"
              />
            </label>
            <div className="rounded-lg bg-slate-50 p-3 text-xs text-slate-700">
              <p className="break-all">
                Registry address: <span className="font-mono">{derived ?? "—"}</span>
              </p>
              {pinError ? (
                <p className="mt-1 text-red-700">{pinError}</p>
              ) : pin ? (
                <p className={`mt-1 ${pinMatch === false ? "text-red-700" : "text-emerald-700"}`}>
                  {pinMatch === null
                    ? `Pinned platform registry: ${pin}`
                    : pinMatch
                      ? "Matches the pinned platform registry."
                      : `Does NOT match the pinned platform registry (${pin}): creation will be refused. Use the KYC authority whose registry is pinned.`}
                </p>
              ) : (
                <p className="mt-1 text-amber-800">
                  No registry is pinned on this deployment
                  {network === "mainnet" ? ": mainnet refuses to create one without a pin." : " (devnet / preview only)."}
                </p>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <span className="text-slate-700">
                <strong>{approved.size}</strong> approved · <strong>{blocked.size}</strong> blocked
              </span>
              <button
                type="button"
                onClick={() => setShowSelector((s) => !s)}
                className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs text-slate-700 hover:bg-slate-50"
              >
                {showSelector ? "Hide" : "Edit"} jurisdiction list
              </button>
            </div>
            {showSelector && <JurisdictionSelector approved={approved} blocked={blocked} onToggle={toggle} />}
            <button
              type="button"
              disabled={busy || !isAddress(kycInput) || !isAddress(adminAuthority.trim()) || pinMatch === false}
              onClick={() => void prepare()}
              className="rounded-lg bg-brand-700 px-4 py-2 text-sm text-white disabled:opacity-50"
            >
              Prepare document
            </button>
          </div>

          <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-5">
            <h2 className="text-sm font-semibold">2. Share, review and sign the public document</h2>
            <p className="text-xs text-slate-500">
              Copy the document between the two wallets. It holds public terms
              and signatures, never a private key. Its blockhash expires within
              a minute or two: after that, prepare again and collect both
              signatures again. An imported document is rebuilt as exactly
              three instructions (compute limit, compute price, create
              registry).
            </p>
            <textarea
              aria-label="Public registry creation document"
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
              onClick={() => void inspect()}
              disabled={busy || !raw.trim()}
              className="text-sm font-semibold text-brand-800 underline"
            >
              Review imported document
            </button>
            {envelope && (
              <div className="space-y-2 rounded-lg bg-brand-50 p-3 text-xs text-brand-950">
                <p>Network: {envelope.network}</p>
                <p className="break-all">Registry: {envelope.registry}</p>
                <p className="break-all">
                  KYC authority (fee payer): {envelope.kycAuthority} —{" "}
                  {envelope.signatures[envelope.kycAuthority] ? "signature supplied (verified before use)" : "signature needed"}
                </p>
                <p className="break-all">
                  Admin co-signer: {envelope.adminAuthority}
                  {envelope.adminAuthority === envelope.kycAuthority
                    ? " (the same key: one signature)"
                    : ` — ${envelope.signatures[envelope.adminAuthority] ? "signature supplied (verified before use)" : "signature needed"}`}
                </p>
                <p>
                  Approved ({envelope.approved.length}): {names(envelope.approved)}
                </p>
                <p>
                  Blocked ({envelope.blocked.length}): {names(envelope.blocked)}
                </p>
                <p>
                  Compute budget: {envelope.computeUnitLimit.toLocaleString("en-US")} units at{" "}
                  {envelope.computeUnitPriceMicroLamports} micro-lamports per unit (priority fee at most{" "}
                  {priorityFeeSol(envelope)} SOL; the cap is {MAX_ENVELOPE_CU_PRICE.toString()}).
                </p>
                {pin && envelope.registry !== pin && (
                  <p className="text-red-700">This is not the pinned platform registry: signing and sending are refused.</p>
                )}
                <div className="flex flex-wrap gap-4">
                  {maySign && (
                    <button type="button" disabled={busy} onClick={() => setConfirm("sign")} className="font-semibold underline">
                      Sign reviewed terms
                    </button>
                  )}
                  {signed && (
                    <button type="button" disabled={busy} onClick={() => setConfirm("send")} className="font-semibold underline">
                      Submit {envelope.adminAuthority === envelope.kycAuthority ? "the signed" : "both signatures"}
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        </>
      )}
      <ConfirmModal
        open={confirm !== null}
        title={confirm === "sign" ? "Sign the registry creation?" : "Create the KYC registry?"}
        description={
          envelope
            ? `Create registry ${envelope.registry} on ${envelope.network}, owned by ${envelope.kycAuthority} and co-signed by the Admin ${envelope.adminAuthority}, with ${envelope.approved.length} approved and ${envelope.blocked.length} blocked jurisdictions. The KYC authority pays the rent and the fee (priority fee at most ${priorityFeeSol(envelope)} SOL).`
            : ""
        }
        kind="warning"
        requireReason={false}
        confirmLabel={confirm === "sign" ? "Sign" : "Create registry"}
        busy={busy}
        onConfirm={() => void act()}
        onClose={() => setConfirm(null)}
      />
    </section>
  );
}
