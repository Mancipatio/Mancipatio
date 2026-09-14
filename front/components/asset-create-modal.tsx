"use client";

import { useMemo, useState } from "react";
import { useSendTransaction, useWalletConnection } from "@solana/react-hooks";
import {
  AssetType,
  findAssetPda,
  findIssuerPda,
  getCreateAssetInstructionAsync,
} from "@/lib/generated/asset_registry";
import { ASSET_TYPE_LABEL, toBytes32 } from "@/lib/format";
import { walletSigner } from "@/lib/wallet-signer";
import { explainSendError } from "@/lib/tx-error";
import { useToast } from "@/lib/toast";
import { COUNTRIES } from "@/lib/countries";
import { JURISDICTION_BITMAP_BYTES } from "@/lib/passport";
import {
  fieldsForCategory,
  slugForEnum,
  type CategorySlug,
  type FieldDef,
} from "@/lib/asset-types";
import {
  toColumnValue,
  upsertAssetProfile,
  type NewAssetProfile,
} from "@/lib/asset-profiles";

type Variant = "admin" | "issuer";

export type AssetCreateModalProps = {
  variant: Variant;
  /** Issuer legal entity ID. Required (locked) for `issuer`; optional seed for
   *  `admin` (admin can type any verified issuer's ID). */
  issuerLegalId?: string;
  onClose: () => void;
  onSuccess: () => void;
};

/** Category-specific values keyed by FieldDef.key. Strings for text/number/
 *  date/select, booleans for boolean fields. */
type CategoryValues = Record<string, string | boolean>;

const inputClass =
  "mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none";
const labelSpan =
  "text-xs font-medium uppercase tracking-wide text-slate-500";

/** SHA-256 → 32-byte Uint8Array. */
async function sha256Bytes(input: ArrayBuffer | Uint8Array): Promise<Uint8Array> {
  const buf =
    input instanceof Uint8Array
      ? (input.buffer.slice(
          input.byteOffset,
          input.byteOffset + input.byteLength,
        ) as ArrayBuffer)
      : input;
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return new Uint8Array(digest);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function AssetCreateModal({
  variant,
  issuerLegalId,
  onClose,
  onSuccess,
}: AssetCreateModalProps) {
  const conn = useWalletConnection();
  const tx = useSendTransaction();
  const toast = useToast();
  const wallet = conn.wallet?.account.address;

  const lockedIssuer = variant === "issuer";

  // On-chain core args.
  const [issuerId, setIssuerId] = useState(issuerLegalId ?? "");
  const [assetId, setAssetId] = useState("");
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [type, setType] = useState<AssetType>(AssetType.Equity);
  const [allowP2P, setAllowP2P] = useState(true);
  const [maxHolders, setMaxHolders] = useState("0");

  // Common off-chain profile fields.
  const [displayName, setDisplayName] = useState("");
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [website, setWebsite] = useState("");
  const [jurisdiction, setJurisdiction] = useState("");
  const [legalDoc, setLegalDoc] = useState<File | null>(null);

  // Category-specific values.
  const [catValues, setCatValues] = useState<CategoryValues>({});

  const slug = slugForEnum(type) as CategorySlug;
  const fields = useMemo(() => fieldsForCategory(slug), [slug]);

  const effectiveIssuerId = lockedIssuer ? (issuerLegalId ?? "") : issuerId;

  function setCat(key: string, value: string | boolean) {
    setCatValues((prev) => ({ ...prev, [key]: value }));
  }

  async function create() {
    if (!wallet || !conn.wallet) return;
    const trimmedIssuer = effectiveIssuerId.trim();
    const trimmedAssetId = assetId.trim();
    if (!trimmedIssuer || !trimmedAssetId || !name.trim()) return;

    const pendingId = toast.showPending(`Creating asset ${trimmedAssetId}…`);
    try {
      const [issuerPda] = await findIssuerPda({
        legalEntityId: toBytes32(trimmedIssuer),
      });
      const signer = walletSigner(conn.wallet);

      // Build the off-chain profile row up front so we can hash it deterministically.
      const profileFields: Record<string, string | number | boolean | null> =
        {};
      for (const f of fields) {
        const raw = catValues[f.key];
        if (raw === undefined) continue;
        profileFields[f.key] = toColumnValue(f, raw);
      }

      // Compute a REAL legal-doc hash:
      //  • SHA-256 of the uploaded legal document bytes, if provided; else
      //  • SHA-256 of a canonical JSON of the collected profile.
      let legalDocHash: Uint8Array;
      if (legalDoc) {
        const fileBuf = await legalDoc.arrayBuffer();
        legalDocHash = await sha256Bytes(fileBuf);
      } else {
        const canonical = JSON.stringify({
          assetId: trimmedAssetId,
          category: slug,
          name: name.trim(),
          symbolPrefix: symbol.trim(),
          displayName: displayName.trim() || name.trim(),
          summary: summary.trim(),
          description: description.trim(),
          website: website.trim(),
          jurisdiction: jurisdiction || null,
          fields: profileFields,
        });
        legalDocHash = await sha256Bytes(new TextEncoder().encode(canonical));
      }
      const legalDocHex = bytesToHex(legalDocHash);

      const ix = await getCreateAssetInstructionAsync({
        authority: signer,
        issuer: issuerPda,
        assetId: trimmedAssetId,
        assetType: type,
        name: name.trim(),
        symbolPrefix: symbol.trim(),
        legalDocHash,
        jurisdictionRules: {
          allowedCountries: new Uint8Array(JURISDICTION_BITMAP_BYTES),
          maxHolders: Number(maxHolders) || 0,
          restrictedPeriodEnd: BigInt(0),
          allowP2p: allowP2P,
        },
      });
      const sig = await tx.send({ instructions: [ix], feePayer: signer });
      toast.dismiss(pendingId);
      toast.showTx(sig, { title: "Asset created" });

      // Off-chain profile write — never fail the whole flow on this.
      try {
        const [assetPda] = await findAssetPda({
          issuer: issuerPda,
          assetId: trimmedAssetId,
        });
        const row: NewAssetProfile = {
          asset_pda: assetPda.toString(),
          category: slug,
          issuer_pda: issuerPda.toString(),
          display_name: displayName.trim() || name.trim(),
          summary: summary.trim() || null,
          description: description.trim() || null,
          website: website.trim() || null,
          jurisdiction: jurisdiction || null,
          legal_doc_sha256: legalDocHex,
          status: "draft",
        };
        // Merge category-specific columns (dynamic keys → asset_profiles columns).
        Object.assign(row, profileFields);
        const ok = await upsertAssetProfile(conn.wallet, row);
        if (!ok) {
          toast.showError(
            "Asset created — profile not saved",
            "The on-chain asset exists, but the off-chain product profile could not be written. Edit it later from the admin console.",
          );
        }
      } catch (offErr) {
        console.warn("[asset-profile] write failed", offErr);
        toast.showError(
          "Asset created — profile not saved",
          "The on-chain asset exists, but the off-chain product profile failed to save.",
        );
      }

      onSuccess();
    } catch (err) {
      toast.dismiss(pendingId);
      toast.showError("Failed to create asset", explainSendError(err));
      console.error("[create_asset]", err);
    }
  }

  if (!wallet) return null;

  const canSubmit =
    !tx.isSending &&
    effectiveIssuerId.trim().length > 0 &&
    assetId.trim().length > 0 &&
    name.trim().length > 0;

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center overflow-y-auto bg-slate-900/40 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !tx.isSending) onClose();
      }}
    >
      <div className="mx-auto my-8 w-full max-w-2xl overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl">
        <div className="border-b border-slate-100 px-5 py-4">
          <p className="text-sm font-semibold uppercase tracking-wide text-slate-700">
            Create asset
          </p>
          {lockedIssuer && (
            <p className="mt-1 text-xs text-slate-500">
              Issuer:{" "}
              <strong className="font-mono">{issuerLegalId}</strong>
            </p>
          )}
        </div>

        <div className="space-y-6 px-5 py-4">
          {/* ── Core on-chain identity ── */}
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              {!lockedIssuer && (
                <label className="block sm:col-span-2">
                  <span className={labelSpan}>Issuer legal entity ID</span>
                  <input
                    value={issuerId}
                    maxLength={32}
                    onChange={(e) => setIssuerId(e.target.value)}
                    placeholder="e.g. ACME-DOO-2026"
                    className={inputClass}
                  />
                  <span className="mt-1 block text-[11px] text-slate-400">
                    Issuer must be KYB-verified.
                  </span>
                </label>
              )}
              <label className="block">
                <span className={labelSpan}>Asset ID (max 32 chars)</span>
                <input
                  value={assetId}
                  maxLength={32}
                  onChange={(e) => setAssetId(e.target.value)}
                  placeholder="SERIES-A"
                  className={inputClass}
                />
                <span className="mt-1 block text-[11px] text-slate-400">
                  Stable, unique identifier — also the PDA seed.
                </span>
              </label>
              <label className="block">
                <span className={labelSpan}>Symbol prefix</span>
                <input
                  value={symbol}
                  maxLength={10}
                  onChange={(e) => setSymbol(e.target.value)}
                  placeholder="ACME-A"
                  className={inputClass}
                />
              </label>
              <label className="block sm:col-span-2">
                <span className={labelSpan}>Name (on-chain)</span>
                <input
                  value={name}
                  maxLength={64}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="ACME Industries — Series A"
                  className={inputClass}
                />
              </label>
              <label className="block">
                <span className={labelSpan}>Asset type</span>
                <select
                  value={type}
                  onChange={(e) =>
                    setType(Number(e.target.value) as AssetType)
                  }
                  className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
                >
                  {ASSET_TYPE_LABEL.map((label, i) => (
                    <option key={i} value={i}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className={labelSpan}>Max holders (0 = unlimited)</span>
                <input
                  value={maxHolders}
                  inputMode="numeric"
                  onChange={(e) =>
                    setMaxHolders(e.target.value.replace(/\D/g, ""))
                  }
                  className={inputClass}
                />
              </label>
            </div>
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={allowP2P}
                onChange={(e) => setAllowP2P(e.target.checked)}
              />
              Allow peer-to-peer transfers
            </label>
          </div>

          {/* ── Product profile (off-chain, common) ── */}
          <div className="space-y-4 border-t border-slate-100 pt-5">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              Product profile
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className={labelSpan}>Display name</span>
                <input
                  value={displayName}
                  maxLength={120}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder={name.trim() || "Public-facing name"}
                  className={inputClass}
                />
              </label>
              <label className="block">
                <span className={labelSpan}>Jurisdiction</span>
                <select
                  value={jurisdiction}
                  onChange={(e) => setJurisdiction(e.target.value)}
                  className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
                >
                  <option value="">— select —</option>
                  {COUNTRIES.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block sm:col-span-2">
                <span className={labelSpan}>Summary</span>
                <input
                  value={summary}
                  maxLength={200}
                  onChange={(e) => setSummary(e.target.value)}
                  placeholder="One-line description for listings"
                  className={inputClass}
                />
              </label>
              <label className="block sm:col-span-2">
                <span className={labelSpan}>Description</span>
                <textarea
                  value={description}
                  rows={3}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Longer description, terms, context…"
                  className={inputClass}
                />
              </label>
              <label className="block">
                <span className={labelSpan}>Website</span>
                <input
                  value={website}
                  onChange={(e) => setWebsite(e.target.value)}
                  placeholder="https://"
                  className={inputClass}
                />
              </label>
              <label className="block">
                <span className={labelSpan}>Legal document (optional)</span>
                <input
                  type="file"
                  onChange={(e) =>
                    setLegalDoc(e.target.files?.[0] ?? null)
                  }
                  className="mt-1 w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-600 file:mr-3 file:rounded file:border-0 file:bg-slate-100 file:px-3 file:py-1 file:text-xs file:font-medium file:text-slate-700 hover:file:bg-slate-200 focus:border-slate-400 focus:outline-none"
                />
                <span className="mt-1 block text-[11px] text-slate-400">
                  Hashed (SHA-256) into the on-chain legal-doc field.
                </span>
              </label>
            </div>
          </div>

          {/* ── Category-specific sub-form ── */}
          {fields.length > 0 && (
            <div className="space-y-4 border-t border-slate-100 pt-5">
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                {ASSET_TYPE_LABEL[type]} details
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                {fields.map((f) => (
                  <CategoryField
                    key={f.key}
                    field={f}
                    value={catValues[f.key]}
                    onChange={(v) => setCat(f.key, v)}
                  />
                ))}
              </div>
            </div>
          )}

          <p className="text-[11px] text-slate-400">
            Allowed-countries bitmap uses permissive v0.1 defaults; the legal-doc
            hash is computed from your upload (or a canonical hash of the profile
            when no file is attached). The product profile is saved off-chain as
            a draft and can be edited later.
          </p>
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-100 bg-slate-50 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={tx.isSending}
            className="rounded-md px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-200 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void create()}
            disabled={!canSubmit}
            className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {tx.isSending ? "Sending…" : "Create asset"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Renders one category field input keyed on FieldDef.type. */
function CategoryField({
  field,
  value,
  onChange,
}: {
  field: FieldDef;
  value: string | boolean | undefined;
  onChange: (value: string | boolean) => void;
}) {
  if (field.type === "boolean") {
    return (
      <label className="flex items-center gap-2 self-end pb-1 text-sm text-slate-700 sm:col-span-2">
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
        />
        {field.label}
        {field.help && (
          <span className="text-[11px] text-slate-400">— {field.help}</span>
        )}
      </label>
    );
  }

  const strValue = typeof value === "string" ? value : "";
  const isWide = field.type === "textarea";

  return (
    <label className={`block ${isWide ? "sm:col-span-2" : ""}`}>
      <span className={labelSpan}>{field.label}</span>
      {field.type === "textarea" ? (
        <textarea
          value={strValue}
          rows={2}
          placeholder={field.placeholder}
          onChange={(e) => onChange(e.target.value)}
          className={inputClass}
        />
      ) : field.type === "select" ? (
        <select
          value={strValue}
          onChange={(e) => onChange(e.target.value)}
          className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
        >
          <option value="">— select —</option>
          {(field.options ?? []).map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      ) : field.type === "date" ? (
        <input
          type="date"
          value={strValue}
          onChange={(e) => onChange(e.target.value)}
          className={inputClass}
        />
      ) : (
        <input
          value={strValue}
          inputMode={
            field.type === "number" ||
            field.type === "bps" ||
            field.type === "mult"
              ? "decimal"
              : undefined
          }
          placeholder={field.placeholder}
          onChange={(e) => onChange(e.target.value)}
          className={inputClass}
        />
      )}
      {field.help && (
        <span className="mt-1 block text-[11px] text-slate-400">
          {field.help}
        </span>
      )}
    </label>
  );
}
