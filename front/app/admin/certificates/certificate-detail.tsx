"use client";

// One certificate on /admin/certificates: its facts and the step it waits for.
//   * draft: its signer signs it (the wallet signs the certificate's message,
//     lib/certificates-client.ts signCertificate), or an admin discards it;
//   * signed: the Super Admin anchors "<number> sha256:<hash>" on chain with
//     the document-anchor panel (the same send and record as Admin →
//     Platform), and the recorded anchor is attached here; another admin
//     sees the memo to give the Super Admin, and attaches the anchor once it
//     is recorded;
//   * signed or anchored: any admin may revoke it, with a reason.
// Always: the printable view, the JSON download (the exact signed bytes)
// and the public verification link.

import Link from "next/link";
import { useState, type ReactNode } from "react";
import type { WalletSession } from "@solana/client";
import { ConfirmModal } from "@/components/confirm-modal";
import { useRole } from "@/lib/auth";
import { documentAnchorMemoText } from "@/lib/document-anchor";
import {
  downloadCertificateJson,
  linkCertificateAnchor,
  revokeCertificate,
  signCertificate,
} from "@/lib/certificates-client";
import { certificateVerifyPath, type CertificateDetail } from "@/lib/certificates/payload";
import { explorerTxUrl, networkLabel } from "@/lib/network";
import { formatTokens } from "@/lib/tokenize-shares";
import { useToast } from "@/lib/toast";
import { DocumentAnchorPanel } from "../platform/document-anchor-panel";

const STATUS: Record<CertificateDetail["status"], { label: string; tone: string }> = {
  draft: { label: "Draft", tone: "border-slate-200 bg-slate-100 text-slate-700" },
  signed: { label: "Signed", tone: "border-brand-200 bg-brand-50 text-brand-800" },
  anchored: { label: "Anchored", tone: "border-emerald-200 bg-emerald-50 text-emerald-800" },
  revoked: { label: "Revoked", tone: "border-red-200 bg-red-50 text-red-800" },
};

export function CertificateStatusBadge({ status }: { status: CertificateDetail["status"] }) {
  return <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold ${STATUS[status].tone}`}>{STATUS[status].label}</span>;
}

function utc(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : `${date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "")} UTC`;
}

function Fact({ label, children, mono = false }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <>
      <dt className="text-slate-500">{label}</dt>
      <dd className={`min-w-0 break-words text-slate-900 ${mono ? "break-all font-mono text-xs" : ""}`}>{children}</dd>
    </>
  );
}

export function CertificateDetailPanel({
  session,
  detail,
  onChange,
}: {
  session: WalletSession;
  detail: CertificateDetail;
  onChange: (detail: CertificateDetail) => void;
}) {
  const role = useRole();
  const toast = useToast();
  const [busy, setBusy] = useState<null | "sign" | "anchor" | "revoke">(null);
  const [error, setError] = useState<string | null>(null);
  const [anchorSignature, setAnchorSignature] = useState("");
  const [revokeOpen, setRevokeOpen] = useState(false);
  const wallet = session.account.address.toString();
  const p = detail.payload;
  const memo = documentAnchorMemoText({ reference: detail.number, sha256: detail.payload_sha256 });

  async function run(step: "sign" | "anchor" | "revoke", action: () => Promise<CertificateDetail>, done: string) {
    if (busy) return;
    setBusy(step);
    setError(null);
    try {
      const next = await action();
      onChange(next);
      toast.show({ kind: "success", title: done });
      return next;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  const sign = () => run("sign", () => signCertificate(session, detail), `${detail.number} signed`);
  const link = (signature?: string) =>
    run("anchor", () => linkCertificateAnchor(session, detail.id, signature), `Anchor attached to ${detail.number}`);
  const revoke = async (reason: string) => {
    const next = await run("revoke", () => revokeCertificate(session, detail.id, reason), detail.status === "draft" ? "Draft discarded" : `${detail.number} revoked`);
    if (next) setRevokeOpen(false);
  };

  const holder = p.holder;
  return (
    <section className="panel min-w-0" aria-labelledby="certificate-detail-heading">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 p-5">
        <div>
          <h2 id="certificate-detail-heading" className="font-mono text-base font-semibold text-slate-900">
            {detail.number}
          </h2>
          <p className="mt-1 text-xs text-slate-500">
            {p.kind === "holding" ? "Holding certificate" : "Issuance certificate"} · issued {utc(p.issued_at)} · {networkLabel(p.network)}
          </p>
        </div>
        <CertificateStatusBadge status={detail.status} />
      </div>

      <div className="space-y-5 p-5">
        <dl className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13px]">
          <Fact label="Asset">
            {p.asset.asset_id} · {p.asset.name} · {p.asset.symbol}, class {p.share_class.class_index}
          </Fact>
          <Fact label="Company">
            {p.company.legal_name}, {p.company.registration_number}, {p.company.address}
          </Fact>
          {holder && p.holding && (
            <>
              <Fact label="Holder's wallet" mono>{holder.wallet}</Fact>
              {(holder.name || holder.id_number) && (
                <Fact label="Holder (personal data)">{[holder.name, holder.id_number].filter(Boolean).join(" · ")}</Fact>
              )}
              <Fact label="Units held">
                {formatTokens(BigInt(p.holding.units))} = {p.holding.percent_of_company} % of the company (slot {p.holding.slot})
              </Fact>
            </>
          )}
          {p.supply && (
            <Fact label="Supply">
              {formatTokens(BigInt(p.supply.circulating))} in circulation = {p.supply.circulating_percent} %, {formatTokens(BigInt(p.supply.lifetime_minted))}{" "}
              issued to date (slot {p.supply.slot})
            </Fact>
          )}
          <Fact label="SHA-256" mono>{detail.payload_sha256}</Fact>
          <Fact label="Signer" mono>{detail.signer}</Fact>
          {detail.signature && <Fact label="Signature" mono>{detail.signature}</Fact>}
          {detail.anchor_tx && (
            <Fact label="Anchor" mono>
              <a className="underline hover:text-slate-700" href={explorerTxUrl(detail.anchor_tx, p.network)} target="_blank" rel="noreferrer">
                {detail.anchor_tx}
              </a>
            </Fact>
          )}
          {detail.status === "revoked" && (
            <Fact label="Revoked">
              {utc(detail.revoked_at)} by <span className="break-all font-mono text-xs">{detail.revoked_by}</span>: {detail.revoke_reason}
            </Fact>
          )}
        </dl>

        <div className="flex flex-wrap gap-2">
          <Link className="btn-ghost" href={`/admin/certificates/print?id=${encodeURIComponent(detail.id)}`} target="_blank" rel="noreferrer">
            Print view
          </Link>
          <button type="button" className="btn-ghost" onClick={() => downloadCertificateJson(detail)}>
            Download JSON
          </button>
          {detail.status !== "draft" && (
            <Link className="btn-ghost" href={certificateVerifyPath(detail.number)} target="_blank" rel="noreferrer">
              Public check
            </Link>
          )}
        </div>

        {error && (
          <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
            {error}
          </p>
        )}

        {detail.status === "draft" && (
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-[13px]">
            <p className="font-medium text-slate-900">Sign the certificate</p>
            <p className="mt-1 text-xs text-slate-600">
              Your wallet signs a three-line message: &quot;Manci certificate v1&quot;, the number and the SHA-256 above. The
              server checks the signature before it records it; from then on the certificate is public on the verification page.
            </p>
            {wallet === detail.signer ? (
              <button type="button" className="btn-brand mt-3" disabled={busy !== null} onClick={() => void sign()}>
                {busy === "sign" ? "Waiting for the wallet…" : "Sign with your wallet"}
              </button>
            ) : (
              <p className="mt-2 text-xs text-amber-800">
                This draft names <span className="break-all font-mono">{detail.signer}</span> as its signer: connect that wallet to
                sign it.
              </p>
            )}
          </div>
        )}

        {detail.status === "signed" && (
          <div className="space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-4 text-[13px]">
            <p className="font-medium text-slate-900">Anchor on chain</p>
            <p className="text-xs text-slate-600">
              The Super Admin&apos;s wallet writes this memo on chain; once the network finalizes it and the anchor is recorded, it is
              attached to the certificate.
            </p>
            <code className="block break-all rounded-md border border-slate-200 bg-white px-2 py-1.5 font-mono text-xs text-slate-900">{memo}</code>
            {role.isSuperAdmin && role.walletAddress === wallet ? (
              <DocumentAnchorPanel
                superAdmin={wallet}
                preset={{ reference: detail.number, sha256: detail.payload_sha256 }}
                onRecorded={(record) => void link(record.signature)}
              />
            ) : (
              <p className="text-xs text-slate-600">
                Only the Super Admin can send it: from this page, or from Admin → Platform → Anchor a document with the reference{" "}
                <span className="font-mono">{detail.number}</span> and the SHA-256 above.
              </p>
            )}
            <div className="flex flex-wrap items-end gap-2 border-t border-slate-200 pt-3">
              <label className="min-w-0 flex-1">
                <span className="mb-1 block text-xs font-medium text-slate-700">Recorded anchor (optional transaction signature)</span>
                <input className="input-base w-full font-mono text-xs" value={anchorSignature} onChange={(event) => setAnchorSignature(event.target.value)} placeholder="Leave empty to find it by number and hash" spellCheck={false} autoComplete="off" />
              </label>
              <button type="button" className="btn-ghost" disabled={busy !== null} onClick={() => void link(anchorSignature.trim() || undefined)}>
                {busy === "anchor" ? "Attaching…" : "Attach recorded anchor"}
              </button>
            </div>
          </div>
        )}

        {detail.status !== "revoked" && (
          <div className="flex justify-end">
            <button type="button" className="text-xs font-medium text-red-700 hover:underline disabled:opacity-50" disabled={busy !== null} onClick={() => setRevokeOpen(true)}>
              {detail.status === "draft" ? "Discard draft" : "Revoke certificate"}
            </button>
          </div>
        )}
      </div>

      <ConfirmModal
        open={revokeOpen}
        onClose={() => setRevokeOpen(false)}
        onConfirm={(reason) => revoke(reason)}
        title={detail.status === "draft" ? `Discard draft ${detail.number}` : `Revoke ${detail.number}`}
        kind="destructive"
        requireReason
        reasonMinLength={4}
        reasonPlaceholder="Why? (kept with the certificate and in the audit log, never shown publicly)"
        confirmLabel={detail.status === "draft" ? "Discard" : "Revoke"}
        busy={busy === "revoke"}
        description={
          <p className="text-[13px]">
            {detail.status === "draft"
              ? "The number stays on record as discarded; the draft was never a certificate."
              : `The public verification page will answer "revoked" for ${detail.number} from now on.${detail.anchor_tx ? " The anchor stays on chain; the revocation is recorded here." : ""} This cannot be undone.`}
          </p>
        }
      />
    </section>
  );
}
