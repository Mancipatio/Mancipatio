"use client";

// "Anchor a document" (MAINNET-PLAN step 3): the Super Admin writes the
// SHA-256 of an off-chain document, with a reference, into one Memo v2
// transaction it signs itself (lib/document-anchor.ts), so anyone can check
// the hash and the time on an explorer later. The file is hashed here, in the
// browser, and never leaves it; a hash can be pasted instead.
//
// The exact memo text, the signer and the fee are shown before the wallet
// opens. The send is the site's normal one (tx.send → the verified client:
// network, maintenance, simulation gate, wallet check, then the wallet); the
// page waits for the network's confirmation and then asks the server to
// verify the transaction and record it in the audit log
// (/api/admin/document-anchor). An anchor sent but not recorded yet is kept
// in this browser and can be recorded again.
//
// Shown only when the connected wallet is the on-chain Super Admin
// (Platform.admin, read by the page).

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { WalletSession } from "@solana/client";
import { useSendTransaction, useSolanaClient, useWalletConnection } from "@solana/react-hooks";
import { ConfirmModal } from "@/components/confirm-modal";
import {
  DOCUMENT_ANCHOR_COMPUTE_UNIT_LIMIT,
  MEMO_PROGRAM_ADDRESS,
  documentAnchorFee,
  documentAnchorInstruction,
  documentAnchorMemoText,
  documentAnchorPanelVisible,
  documentAnchorReferenceError,
  normalizeSha256Input,
  type DocumentAnchorRecord,
} from "@/lib/document-anchor";
import {
  clearPendingAnchor,
  listDocumentAnchors,
  readPendingAnchor,
  recordDocumentAnchorWithRetry,
  savePendingAnchor,
  type PendingAnchor,
  type RecordedAnchor,
} from "@/lib/document-anchor-client";
import { formatLamportsAsSol } from "@/lib/compute-budget";
import { PRIORITY_FEE_POLICY, resolveComputeUnitPrice } from "@/lib/priority-fee";
import { WalletSessionRequiredError, type SignedFetchInteractive } from "@/lib/siws-client";
import { sha256HexOfFile } from "@/lib/storage-client";
import { waitForSignature, type SignatureOutcome } from "@/lib/simulation-gate";
import { detectNetwork, explorerAddressUrl, explorerTxUrl, networkLabel, type Network } from "@/lib/network";
import { explainSendError } from "@/lib/tx-error";
import { walletSigner } from "@/lib/wallet-signer";
import { useToast } from "@/lib/toast";

const CARD = "mt-6 rounded-xl border border-slate-200 bg-white shadow-card p-6";
const INPUT =
  "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none";
const SMALL_BTN =
  "rounded-md border border-slate-300 px-2 py-0.5 text-xs font-medium text-slate-700 hover:border-slate-400 disabled:opacity-50";

type AnchorResult = {
  anchor: PendingAnchor;
  memo: string;
  /** null while the network is asked; "restored" = sent earlier from this browser, status not read here. */
  outcome: SignatureOutcome | "restored" | null;
  record: RecordedAnchor | null;
  recordError: string | null;
};

type AnchorList =
  | { state: "loading" }
  | { state: "signin" }
  | { state: "error"; text: string }
  | { state: "ready"; rows: DocumentAnchorRecord[] };

export function DocumentAnchorPanel({ superAdmin }: { superAdmin: string }) {
  const conn = useWalletConnection();
  const session = conn.wallet;
  const wallet = session?.account.address.toString() ?? null;
  if (!session || !wallet || !documentAnchorPanelVisible(wallet, superAdmin)) return null;
  return <AnchorForm key={wallet} session={session} wallet={wallet} />;
}

function AnchorForm({ session, wallet }: { session: WalletSession; wallet: string }) {
  const client = useSolanaClient();
  const tx = useSendTransaction();
  const toast = useToast();
  const rpc = client.runtime.rpc;
  const [network] = useState<Network>(() => detectNetwork());
  const [referenceInput, setReferenceInput] = useState("");
  const [hashInput, setHashInput] = useState("");
  const [file, setFile] = useState<{ name: string; size: number; sha256: string } | null>(null);
  const [hashing, setHashing] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [price, setPrice] = useState<bigint | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState<null | "sending" | "confirming" | "recording">(null);
  const [result, setResult] = useState<AnchorResult | null>(() => {
    const pending = readPendingAnchor(network, wallet);
    if (!pending) return null;
    let memo = "";
    try {
      memo = documentAnchorMemoText(pending);
    } catch {
      return null;
    }
    return { anchor: pending, memo, outcome: "restored", record: null, recordError: null };
  });
  const [anchors, setAnchors] = useState<AnchorList>({ state: "loading" });
  const fileInput = useRef<HTMLInputElement>(null);

  // The priority fee at the current rate (the send re-reads it; the same 10 s cache).
  useEffect(() => {
    let cancelled = false;
    void resolveComputeUnitPrice(network).then((value) => {
      if (!cancelled) setPrice(value);
    });
    return () => {
      cancelled = true;
    };
  }, [network]);

  const loadAnchors = useCallback(
    async (interactive: SignedFetchInteractive) => {
      try {
        setAnchors({ state: "ready", rows: await listDocumentAnchors(session, interactive) });
      } catch (err) {
        setAnchors(listFailure(err));
      }
    },
    [session],
  );

  // An existing wallet session only: opening the page never prompts.
  useEffect(() => {
    let cancelled = false;
    void listDocumentAnchors(session, false).then(
      (rows) => {
        if (!cancelled) setAnchors({ state: "ready", rows });
      },
      (err) => {
        if (!cancelled) setAnchors(listFailure(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [session]);

  const reference = referenceInput.trim();
  const referenceError = referenceInput === "" ? null : documentAnchorReferenceError(reference);
  const sha256 = normalizeSha256Input(hashInput);
  const hashError =
    hashInput.trim() === "" || sha256 ? null : "Paste the 64-character SHA-256 in hex, or choose the file above.";
  let memo: string | null = null;
  if (reference && !referenceError && sha256) {
    try {
      memo = documentAnchorMemoText({ reference, sha256 });
    } catch {
      memo = null;
    }
  }
  const fileMatches = file !== null && file.sha256 === sha256;
  const fee = price === null ? null : documentAnchorFee(price);
  const capFee = documentAnchorFee(PRIORITY_FEE_POLICY[network].cap);
  const working = busy !== null || tx.isSending;

  async function onFile(chosen: File | undefined) {
    if (!chosen) return;
    setHashing(true);
    setFileError(null);
    try {
      const digest = await sha256HexOfFile(chosen);
      setFile({ name: chosen.name, size: chosen.size, sha256: digest });
      setHashInput(digest);
    } catch {
      setFile(null);
      setFileError("This browser could not read or hash the file. Paste its SHA-256 instead.");
    } finally {
      setHashing(false);
      // The same file can be chosen again after the field was edited.
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function record(pending: PendingAnchor) {
    setBusy("recording");
    setResult((r) => (r && r.anchor.signature === pending.signature ? { ...r, recordError: null } : r));
    try {
      const recorded = await recordDocumentAnchorWithRetry(session, pending);
      clearPendingAnchor(pending.signature);
      setResult((r) =>
        r && r.anchor.signature === pending.signature
          ? { ...r, outcome: r.outcome === "restored" || r.outcome === null ? "confirmed" : r.outcome, record: recorded, recordError: null }
          : r,
      );
      void loadAnchors(false);
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      setResult((r) => (r && r.anchor.signature === pending.signature ? { ...r, recordError: text } : r));
    } finally {
      setBusy(null);
    }
  }

  async function anchor() {
    if (working || !memo || !sha256 || !reference) return;
    const input = { reference, sha256 };
    const text = memo;
    setBusy("sending");
    let pendingId = toast.showPending("Anchoring the document…", "Approve the transaction in your wallet.");
    let signature: string;
    try {
      const signer = walletSigner(session);
      const sent = await tx.send({ instructions: [documentAnchorInstruction({ ...input, signer })], feePayer: signer });
      signature = typeof sent === "string" ? sent : String(sent ?? "");
      if (!signature) throw new Error("The wallet returned no transaction signature.");
    } catch (err) {
      toast.dismiss(pendingId);
      toast.showError("Nothing was anchored", explainSendError(err));
      setBusy(null);
      return;
    }
    const pending: PendingAnchor = { ...input, signature, network, signer: wallet };
    savePendingAnchor(pending);
    setConfirmOpen(false);
    setResult({ anchor: pending, memo: text, outcome: null, record: null, recordError: null });
    toast.dismiss(pendingId);
    pendingId = toast.showPending("Confirming the anchor on the network…");
    setBusy("confirming");
    const outcome = await waitForSignature(rpc, signature, { timeoutMs: 60_000 });
    toast.dismiss(pendingId);
    setResult((r) => (r && r.anchor.signature === signature ? { ...r, outcome } : r));
    if (outcome === "failed") {
      clearPendingAnchor(signature);
      toast.show({
        kind: "error",
        title: "The anchor failed on the network",
        description: "Your wallet sent it, but the network refused it. Nothing was anchored; open the explorer link for details.",
        signature,
      });
      setBusy(null);
      return;
    }
    if (outcome !== "confirmed") {
      toast.show({
        kind: "error",
        title: "Not confirmed yet",
        description: "The network has not confirmed the anchor yet. Check the explorer link, then record it below. Do not send it again.",
        signature,
      });
      setBusy(null);
      return;
    }
    toast.showTx(signature, { title: "Document anchored" });
    setReferenceInput("");
    setHashInput("");
    setFile(null);
    await record(pending);
  }

  return (
    <div className={CARD}>
      <h2 className="text-lg font-semibold text-slate-900">Anchor a document</h2>
      <p className="mt-1 text-[13px] leading-relaxed text-slate-600">
        Writes a document&apos;s SHA-256 fingerprint with a reference on chain, in a memo signed by the Super Admin
        wallet, so anyone can later check the fingerprint and the time on an explorer. The document itself is never
        uploaded: a chosen file is hashed in this browser.
      </p>

      <div className="mt-4 space-y-4">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-600">Reference</span>
          <input
            value={referenceInput}
            onChange={(e) => setReferenceInput(e.target.value)}
            placeholder="MANCI-2026-0001"
            spellCheck={false}
            autoComplete="off"
            maxLength={80}
            disabled={working}
            className={`${INPUT} font-mono`}
            aria-invalid={referenceError ? true : undefined}
          />
          <span className="mt-1 block text-xs text-slate-500">
            Up to 64 characters: letters, digits and . _ : / - (no spaces), starting with a letter or a digit.
          </span>
          {referenceError && <span className="mt-1 block text-xs text-red-600">{referenceError}</span>}
        </label>

        <div>
          <span className="mb-1 block text-xs font-medium text-slate-600">Document</span>
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileInput}
              type="file"
              aria-label="Document file (hashed in this browser, not uploaded)"
              disabled={working || hashing}
              onChange={(e) => void onFile(e.target.files?.[0])}
              className="block max-w-full text-xs text-slate-600 file:mr-3 file:rounded-md file:border file:border-slate-300 file:bg-white file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-slate-800 hover:file:border-slate-400"
            />
            {hashing && <span className="text-xs text-slate-500">Hashing…</span>}
          </div>
          {fileError && <p className="mt-1 text-xs text-red-600">{fileError}</p>}
          {fileMatches && file && (
            <p className="mt-1 text-xs text-emerald-700">
              SHA-256 of <span className="font-medium">{file.name}</span> ({file.size.toLocaleString("en-US")} bytes),
              computed in this browser.
            </p>
          )}
          <label className="mt-3 block">
            <span className="mb-1 block text-xs text-slate-500">…or paste its SHA-256 (64 hex characters)</span>
            <input
              value={hashInput}
              onChange={(e) => setHashInput(e.target.value)}
              placeholder="a2546dd318ea95b210a4eb62a45b8434…"
              spellCheck={false}
              autoComplete="off"
              disabled={working}
              className={`${INPUT} font-mono text-xs`}
              aria-invalid={hashError ? true : undefined}
            />
          </label>
          {hashError && <p className="mt-1 text-xs text-red-600">{hashError}</p>}
        </div>

        {memo && (
          <dl className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-3 text-[13px]">
            <Fact label="Memo text (exactly)">
              <code className="block break-all font-mono text-xs text-slate-900">{memo}</code>
            </Fact>
            <Fact label="Signer">
              <span className="break-all font-mono text-xs text-slate-800">{wallet}</span>{" "}
              <span className="text-xs text-slate-500">(Super Admin, fee payer)</span>
            </Fact>
            <Fact label="Program">
              <span className="break-all font-mono text-xs text-slate-800">{MEMO_PROGRAM_ADDRESS}</span>{" "}
              <span className="text-xs text-slate-500">(Memo v2)</span>
            </Fact>
            <Fact label="Expected fee">
              <FeeText fee={fee} capFee={capFee} network={network} />
            </Fact>
          </dl>
        )}

        <button
          type="button"
          disabled={!memo || working || hashing}
          onClick={() => setConfirmOpen(true)}
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          {busy === "sending" ? "Waiting for the wallet…" : busy === "confirming" ? "Confirming…" : busy === "recording" ? "Recording…" : "Review and anchor"}
        </button>
      </div>

      {result && (
        <AnchorResultCard
          result={result}
          network={network}
          busy={busy}
          onRecord={() => void record(result.anchor)}
          onDismiss={() => {
            if (!result.record) clearPendingAnchor(result.anchor.signature);
            setResult(null);
          }}
        />
      )}

      <div className="mt-6 border-t border-slate-100 pt-4">
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Recent anchors · {networkLabel(network)}</p>
          {anchors.state === "ready" && (
            <button type="button" className={SMALL_BTN} onClick={() => void loadAnchors(false)}>
              Refresh
            </button>
          )}
        </div>
        <AnchorListView anchors={anchors} network={network} onSignIn={() => void loadAnchors("session-only")} onRetry={() => void loadAnchors(true)} />
      </div>

      <ConfirmModal
        open={confirmOpen && !!memo}
        onClose={() => setConfirmOpen(false)}
        onConfirm={() => anchor()}
        title="Anchor this document on chain"
        kind="info"
        requireReason={false}
        confirmLabel="Sign and anchor"
        busy={working}
        description={
          memo && (
            <div className="space-y-2">
              <p>The memo will read exactly:</p>
              <code className="block break-all rounded-md border border-slate-200 bg-white px-2 py-1.5 font-mono text-xs text-slate-900">
                {memo}
              </code>
              <ul className="list-disc space-y-1 pl-5 text-[13px]">
                <li>
                  Signed by <span className="break-all font-mono text-xs">{wallet}</span> (Super Admin) on{" "}
                  {networkLabel(network)}.
                </li>
                <li>
                  Fee: <FeeText fee={fee} capFee={capFee} network={network} />
                </li>
                <li>A memo cannot be changed or deleted once it is on chain. Check the reference and the hash.</li>
                <li>Your wallet shows the transaction next; nothing is sent until you approve it there.</li>
              </ul>
            </div>
          )
        }
      />
    </div>
  );
}

function listFailure(err: unknown): AnchorList {
  if (err instanceof WalletSessionRequiredError) return { state: "signin" };
  return { state: "error", text: err instanceof Error ? err.message : String(err) };
}

function FeeText({ fee, capFee, network }: { fee: ReturnType<typeof documentAnchorFee> | null; capFee: ReturnType<typeof documentAnchorFee>; network: Network }) {
  if (!fee) return <span className="text-xs text-slate-500">reading the current priority fee…</span>;
  return (
    <span className="text-xs text-slate-700">
      about <span className="font-mono">{formatLamportsAsSol(fee.total)}</span> SOL ({formatLamportsAsSol(fee.base)} SOL
      network fee + {formatLamportsAsSol(fee.priority)} SOL priority fee for {DOCUMENT_ANCHOR_COMPUTE_UNIT_LIMIT.toLocaleString("en-US")}{" "}
      compute units at the current rate; it is read again when you sign, at most {formatLamportsAsSol(capFee.total)} SOL on{" "}
      {networkLabel(network)}).
    </span>
  );
}

function AnchorResultCard({
  result,
  network,
  busy,
  onRecord,
  onDismiss,
}: {
  result: AnchorResult;
  network: Network;
  busy: string | null;
  onRecord: () => void;
  onDismiss: () => void;
}) {
  const { anchor, memo, outcome, record, recordError } = result;
  const heading =
    outcome === "failed"
      ? "The anchor failed on the network"
      : outcome === "confirmed"
        ? "Anchored on chain"
        : outcome === null
          ? "Sent — waiting for the network"
          : outcome === "restored"
            ? "Sent earlier from this browser, not recorded yet"
            : "Sent — not confirmed yet";
  const tone = outcome === "failed" ? "border-red-200 bg-red-50" : outcome === "confirmed" ? "border-emerald-200 bg-emerald-50" : "border-amber-200 bg-amber-50";
  const canRecord = outcome !== "failed" && outcome !== null && !record;
  return (
    <div className={`mt-5 rounded-lg border px-4 py-3 text-[13px] ${tone}`} role="status">
      <p className="font-semibold text-slate-900">{heading}</p>
      <dl className="mt-2 space-y-2">
        <Fact label="Signature">
          <span className="break-all font-mono text-xs text-slate-900">{anchor.signature}</span>
          <span className="mt-1 flex flex-wrap items-center gap-2">
            <CopyButton text={anchor.signature} label="Copy signature" />
            <a className="text-xs font-medium text-slate-700 underline hover:text-slate-900" href={explorerTxUrl(anchor.signature, network)} target="_blank" rel="noreferrer">
              View on explorer
            </a>
          </span>
        </Fact>
        <Fact label="Memo">
          <code className="block break-all font-mono text-xs text-slate-900">{memo}</code>
        </Fact>
      </dl>
      {record ? (
        <p className="mt-2 text-xs text-emerald-800">
          ✓ Verified on chain by the server and recorded in the audit log
          {recordFacts(record) ? ` (${recordFacts(record)})` : ""}.{record.duplicate ? " It was already recorded." : ""}
        </p>
      ) : busy === "recording" ? (
        <p className="mt-2 text-xs text-slate-600">Recording in the audit log…</p>
      ) : recordError ? (
        <p className="mt-2 break-words text-xs text-red-700">Not recorded in the audit log: {recordError}</p>
      ) : null}
      {outcome === "confirmed" || record ? (
        <p className="mt-2 text-xs text-slate-600">
          To check it later: open the transaction on the explorer; its memo must read exactly the text above, signed by{" "}
          <a className="break-all font-mono underline" href={explorerAddressUrl(anchor.signer, network)} target="_blank" rel="noreferrer">
            {anchor.signer}
          </a>
          , and the document&apos;s SHA-256 (for example <code className="font-mono">shasum -a 256 &lt;file&gt;</code>) must equal the
          hash in it.
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        {canRecord && (
          <button type="button" className={SMALL_BTN} disabled={busy !== null} onClick={onRecord}>
            Record in the audit log
          </button>
        )}
        {(record || outcome === "failed" || recordError) && (
          <button type="button" className={SMALL_BTN} disabled={busy !== null} onClick={onDismiss}>
            {record || outcome === "failed" ? "Done" : "Forget it"}
          </button>
        )}
      </div>
    </div>
  );
}

function AnchorListView({
  anchors,
  network,
  onSignIn,
  onRetry,
}: {
  anchors: AnchorList;
  network: Network;
  onSignIn: () => void;
  onRetry: () => void;
}) {
  if (anchors.state === "loading") return <p className="mt-2 text-xs text-slate-500">Loading…</p>;
  if (anchors.state === "signin") {
    return (
      <p className="mt-2 text-xs text-slate-600">
        The list needs a wallet sign-in (one message, no transaction).{" "}
        <button type="button" className={SMALL_BTN} onClick={onSignIn}>
          Show recent anchors
        </button>
      </p>
    );
  }
  if (anchors.state === "error") {
    return (
      <p className="mt-2 break-words text-xs text-red-700">
        {anchors.text}{" "}
        <button type="button" className={SMALL_BTN} onClick={onRetry}>
          Try again
        </button>
      </p>
    );
  }
  if (anchors.rows.length === 0) return <p className="mt-2 text-xs text-slate-500">No document has been anchored on this network yet.</p>;
  return (
    <ul className="mt-2 divide-y divide-slate-100">
      {anchors.rows.map((row) => (
        <li key={row.id} className="py-2.5 text-[13px]">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="font-mono font-medium text-slate-900">{row.reference}</span>
            <span className="text-xs text-slate-500">
              {row.blockTime !== null ? formatBlockTime(row.blockTime) : row.recordedAt ? `recorded ${row.recordedAt}` : ""}
            </span>
          </div>
          <p className="mt-0.5 break-all font-mono text-xs text-slate-600">sha256:{row.sha256}</p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <a className="break-all font-mono text-xs text-slate-700 underline hover:text-slate-900" href={explorerTxUrl(row.signature, network)} target="_blank" rel="noreferrer">
              {`${row.signature.slice(0, 10)}…${row.signature.slice(-10)}`}
            </a>
            <CopyButton text={row.signature} label="Copy signature" />
          </div>
        </li>
      ))}
    </ul>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <button
      type="button"
      className={SMALL_BTN}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setState("copied");
        } catch {
          setState("failed");
        }
        setTimeout(() => setState("idle"), 1_500);
      }}
    >
      {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : label}
    </button>
  );
}

/** "finalized, slot 123, 2026-10-05 14:03:21 UTC" — what the server read. */
function recordFacts(record: RecordedAnchor): string {
  return [
    record.commitment,
    record.slot !== null ? `slot ${record.slot.toLocaleString("en-US")}` : null,
    record.blockTime !== null ? formatBlockTime(record.blockTime) : null,
  ]
    .filter(Boolean)
    .join(", ");
}

/** Unix seconds as "2026-10-05 14:03:21 UTC" (the block time the explorer shows). */
function formatBlockTime(seconds: number): string {
  return `${new Date(seconds * 1000).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "")} UTC`;
}
