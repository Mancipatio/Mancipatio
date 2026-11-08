"use client";

// The public certificate check (/certificates/verify, ?number= from the
// printed certificate's URL): the number, and optionally the SHA-256 printed
// on the certificate or the certificate's JSON file. The file is read and
// hashed in this browser and never uploaded: only its hash goes to the
// server (POST /api/certificates/verify), which answers what the operator
// issued and whether the hash matches. When the file's content matches, the
// holder's name and ID number are shown from the file itself; the server
// never returns them.

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { readCertificateFile, verifyCertificate } from "@/lib/certificates/public-check";
import {
  CERTIFICATE_MESSAGE_HEADER,
  formatUnits,
  normalizeCertificateNumber,
  normalizeCertificateSha256,
  type PublicCertificateView,
} from "@/lib/certificates/payload";
import { explorerAddressUrl, explorerTxUrl, networkLabel, type Network } from "@/lib/network";

const INPUT_CLASS =
  "mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-slate-400";

type FileCheck = Awaited<ReturnType<typeof readCertificateFile>> & { name: string };
type Result = { view: PublicCertificateView; file: FileCheck | null; pasted: boolean };

function utc(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : `${date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "")} UTC`;
}

const units = (value: string) => `${formatUnits(BigInt(value))} ${value === "1" ? "unit" : "units"}`;

export function CertificateVerifier() {
  const params = useSearchParams();
  const initial = params.get("number") ?? "";
  // The printed URL carries the certificate's hash too: numbers restart on
  // every network, so the check is of THIS certificate, not just its number.
  const initialHash = params.get("sha256") ?? "";
  const [number, setNumber] = useState(initial);
  const [hash, setHash] = useState(initialHash);
  const [file, setFile] = useState<FileCheck | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const ran = useRef(false);

  async function check(typed: string, typedHash: string, chosen: FileCheck | null) {
    setError(null);
    const normalized = normalizeCertificateNumber(typed);
    if (!normalized) {
      setResult(null);
      setError("Enter a certificate number such as MC-2026-0001.");
      return;
    }
    let pasted: string | null = null;
    if (!chosen && typedHash.trim()) {
      pasted = normalizeCertificateSha256(typedHash);
      if (!pasted) {
        setResult(null);
        setError("The SHA-256 is 64 hex characters, as printed on the certificate.");
        return;
      }
    }
    setBusy(true);
    try {
      const sha = chosen ? (chosen.canonicalSha256 ?? chosen.rawSha256) : pasted;
      const view = await verifyCertificate(normalized, sha ?? undefined);
      setNumber(normalized);
      setResult({ view, file: chosen, pasted: !chosen && pasted !== null });
    } catch (err) {
      setResult(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  // A link from a printed certificate checks its number at once.
  useEffect(() => {
    if (ran.current || !initial) return;
    ran.current = true;
    void check(initial, initialHash, null);
  }, [initial, initialHash]);

  async function onFile(chosen: File | undefined) {
    setFileError(null);
    setFile(null);
    setResult(null);
    if (!chosen) return;
    try {
      const read = await readCertificateFile(chosen);
      setFile({ ...read, name: chosen.name });
      if (read.number && !number.trim()) setNumber(read.number);
    } catch (err) {
      setFileError(err instanceof Error ? err.message : String(err));
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!busy) void check(number, hash, file);
  }

  return (
    <div className="space-y-6">
      <form onSubmit={onSubmit} className="panel panel-pad space-y-4" noValidate>
        <label className="block">
          <span className="text-sm font-medium text-slate-800">Certificate number</span>
          <input className={`${INPUT_CLASS} font-mono`} value={number} onChange={(e) => setNumber(e.target.value)} placeholder="MC-2026-0001" autoComplete="off" spellCheck={false} />
        </label>
        <label className="block">
          <span className="text-sm font-medium text-slate-800">
            SHA-256 printed on the certificate <span className="font-normal text-slate-500">(optional)</span>
          </span>
          <input className={`${INPUT_CLASS} font-mono text-xs`} value={hash} onChange={(e) => setHash(e.target.value)} placeholder="64 hex characters" autoComplete="off" spellCheck={false} disabled={file !== null} />
        </label>
        <div>
          <span className="text-sm font-medium text-slate-800">
            Or the certificate&apos;s JSON file <span className="font-normal text-slate-500">(optional; read in your browser, not uploaded)</span>
          </span>
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            aria-label="Certificate JSON file (read in your browser, not uploaded)"
            onChange={(e) => void onFile(e.target.files?.[0])}
            className="mt-1 block max-w-full text-xs text-slate-600 file:mr-3 file:rounded-md file:border file:border-slate-300 file:bg-white file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-slate-800 hover:file:border-slate-400"
          />
          {file && (
            <p className="mt-1 text-xs text-slate-600">
              {file.name}: SHA-256 <span className="break-all font-mono">{file.rawSha256}</span>
              {file.canonicalSha256 === null ? " (not in the certificate format)" : ""}{" "}
              <button
                type="button"
                className="ml-1 underline"
                onClick={() => {
                  setFile(null);
                  if (fileInput.current) fileInput.current.value = "";
                }}
              >
                Remove
              </button>
            </p>
          )}
          {fileError && <p className="mt-1 text-xs text-red-700">{fileError}</p>}
        </div>
        <button type="submit" className="btn-brand disabled:opacity-50" disabled={busy}>
          {busy ? "Checking…" : "Check certificate"}
        </button>
        {error && (
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
        )}
      </form>

      {result && <CertificateResult result={result} />}
    </div>
  );
}

function Fact({ label, children, mono = false }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <>
      <dt className="text-slate-500">{label}</dt>
      <dd className={`min-w-0 break-words text-slate-900 ${mono ? "break-all font-mono text-xs" : ""}`}>{children}</dd>
    </>
  );
}

function AddressLink({ address, network }: { address: string; network: Network }) {
  return (
    <a className="underline hover:text-slate-700" href={explorerAddressUrl(address, network)} target="_blank" rel="noreferrer">
      {address}
    </a>
  );
}

function CertificateResult({ result }: { result: Result }) {
  const { view, file, pasted } = result;
  if (!view.found) {
    return (
      <div className="panel panel-pad text-sm" role="status">
        <p className="font-semibold text-slate-900">No certificate {view.number} on this network</p>
        <p className="mt-1 text-slate-600">
          Check the number on the certificate. A draft that was never signed is not a certificate, and a certificate of another
          network (for example the devnet pilot) is checked on that network&apos;s site.
        </p>
      </div>
    );
  }

  const fileExact = file !== null && file.rawSha256 === view.payload_sha256;
  const fileSameContent = file !== null && !fileExact && file.canonicalSha256 === view.payload_sha256;
  // The certificate in hand is not the one this number names here (another
  // network's certificate of the same number, or a forged copy): say that
  // first, whatever the found certificate's own status.
  const mismatch = (file !== null && !fileExact && !fileSameContent) || (pasted && view.hash_matches === false);
  const banner = mismatch
    ? {
        tone: "border-red-300 bg-red-50 text-red-900",
        title: "This is not the certificate you have",
        text: `Certificate ${view.number} on this network has a different SHA-256 from yours. Check the number and the network printed on your certificate; the facts below are of the certificate this site holds.`,
      }
    : view.status === "valid"
      ? {
          tone: "border-emerald-300 bg-emerald-50 text-emerald-900",
          title: "Valid certificate",
          text: `Signed ${utc(view.signed_at)}; ${view.anchored ? "anchored on chain" : "not anchored on chain yet"}. It states the facts below at the slot shown; a holding may have changed since.`,
        }
      : view.status === "revoked"
        ? { tone: "border-red-300 bg-red-50 text-red-900", title: `Revoked on ${utc(view.revoked_at)}`, text: "The operator revoked this certificate: it no longer certifies anything. Contact the operator for details." }
        : { tone: "border-red-300 bg-red-50 text-red-900", title: "This certificate did not pass the check", text: "Its stored signature or hash does not verify. Do not rely on it, and contact the operator." };
  const holderFromFile =
    (fileExact || fileSameContent) && file?.payload && typeof file.payload.holder === "object" && file.payload.holder !== null
      ? (file.payload.holder as { name?: unknown; id_number?: unknown })
      : null;
  const message = `${CERTIFICATE_MESSAGE_HEADER}\nNumber: ${view.number}\nSHA-256: ${view.payload_sha256}`;

  return (
    <div className="space-y-4">
      <div className={`rounded-xl border px-5 py-4 ${banner.tone}`} role="status">
        <p className="text-base font-semibold">{banner.title}</p>
        <p className="mt-1 text-sm">{banner.text}</p>
        {file && (
          <p className="mt-2 text-sm font-medium">
            {fileExact
              ? "Your file is exactly the signed JSON of this certificate."
              : fileSameContent
                ? "Your file has the same content as the signed JSON of this certificate (formatted differently)."
                : "Your file does NOT match this certificate."}
          </p>
        )}
        {pasted && view.hash_matches !== null && (
          <p className="mt-2 text-sm font-medium">
            {view.hash_matches ? "The SHA-256 you entered matches this certificate." : "The SHA-256 you entered does NOT match this certificate."}
          </p>
        )}
      </div>

      <div className="panel panel-pad">
        <dl className="grid grid-cols-[minmax(0,11rem)_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
          <Fact label="Number">{view.number}</Fact>
          <Fact label="Kind">{view.kind === "holding" ? "Holding certificate" : "Issuance certificate"}</Fact>
          <Fact label="Issued">{utc(view.issued_at)}</Fact>
          <Fact label="Network">Solana {networkLabel(view.network)}</Fact>
          <Fact label="Company">
            {view.company.legal_name}, registration number {view.company.registration_number}, {view.company.address}
          </Fact>
          <Fact label="Asset">
            {view.asset.asset_id} · {view.asset.name} · {view.asset.symbol}, share class {view.share_class.class_index}
          </Fact>
          <Fact label="Token mint" mono>
            <AddressLink address={view.share_class.mint} network={view.network} />
          </Fact>
          <Fact label="Scale">
            {units(view.share_class.units_for_100_percent)} = 100 % of the company (1 unit = {view.share_class.unit_percent} %)
          </Fact>
          {view.share_class.max_supply !== null && <Fact label="Maximum supply">{units(view.share_class.max_supply)}</Fact>}
          {view.holding && view.holder_wallet && (
            <>
              <Fact label="Holder's wallet" mono>
                <AddressLink address={view.holder_wallet} network={view.network} />
              </Fact>
              <Fact label="Units held">
                {units(view.holding.units)} = {view.holding.percent_of_company} % of the company, at slot {view.holding.slot}
              </Fact>
            </>
          )}
          {view.supply && (
            <Fact label="Supply">
              {units(view.supply.circulating)} in circulation ({view.supply.circulating_percent} %), {units(view.supply.lifetime_minted)} issued to
              date, at slot {view.supply.slot}
            </Fact>
          )}
          {holderFromFile && (typeof holderFromFile.name === "string" || typeof holderFromFile.id_number === "string") && (
            <Fact label="Holder (from your file)">
              {[holderFromFile.name, holderFromFile.id_number].filter((v): v is string => typeof v === "string").join(" · ")}
            </Fact>
          )}
          <Fact label="SHA-256" mono>{view.payload_sha256}</Fact>
          <Fact label="Signer" mono>
            <AddressLink address={view.signer} network={view.network} />
          </Fact>
          <Fact label="Signature">
            {view.signature_valid ? "Verified for the signer above" : "Does not verify"}
            <span className="mt-1 block break-all font-mono text-xs text-slate-700">{view.signature}</span>
          </Fact>
          <Fact label="Signed message" mono>
            <span className="whitespace-pre-line">{message}</span>
            {view.signature_format !== "raw" && (
              <span className="mt-1 block font-sans text-xs text-slate-500">Signed inside a Solana off-chain message ({view.signature_format}).</span>
            )}
          </Fact>
          <Fact label="On-chain anchor" mono>
            {view.anchor ? (
              <>
                <a className="underline hover:text-slate-700" href={explorerTxUrl(view.anchor.tx, view.network)} target="_blank" rel="noreferrer">
                  {view.anchor.tx}
                </a>
                <span className="mt-1 block font-sans text-xs text-slate-500">
                  Memo &quot;{view.number} sha256:{view.payload_sha256}&quot;
                  {view.anchor.block_time ? `, ${utc(view.anchor.block_time)}` : ""}
                  {view.anchor.slot !== null ? `, slot ${view.anchor.slot}` : ""}
                </span>
              </>
            ) : (
              <span className="font-sans">Not anchored yet</span>
            )}
          </Fact>
        </dl>
      </div>
    </div>
  );
}
