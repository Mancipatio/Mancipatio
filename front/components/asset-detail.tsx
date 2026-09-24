"use client";

import { WalletRequired } from "@/components/wallet-required";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSolanaClient, useWalletConnection } from "@solana/react-hooks";
import {
  findAssetPda,
  findIssuerPda,
  type Asset,
  type Issuer,
} from "@/lib/generated/asset_registry";
import { loadNetwork, type NetworkData } from "@/lib/enumerate";
import { loadNetworkPreferIndexer } from "@/lib/indexer";
import {
  ASSET_STATUS_LABEL,
  ASSET_TYPE_LABEL,
  fromBytes32,
  safeHttpUrl,
} from "@/lib/format";
import { shareClassKey } from "@/lib/asset-links";
import { listSpvs, spvCapacity, type SpvCapacity, type SpvRow } from "@/lib/spvs";
import { signedUpload } from "@/lib/storage-client";
import { SkeletonCard } from "@/components/skeleton";
import { useToast } from "@/lib/toast";
import { COUNTRIES, countryName } from "@/lib/countries";
import {
  assetTypeBySlug,
  fieldsForCategory,
  slugForEnum,
  type CategorySlug,
  type FieldDef,
} from "@/lib/asset-types";
import {
  displayFieldValue,
  getPrivateAssetProfile as getAssetProfile,
  toColumnValue,
  toFormValue,
  upsertAssetProfile,
  type AssetProfile,
  type NewAssetProfile,
} from "@/lib/asset-profiles";

const STATUS_BADGE: Record<number, string> = {
  0: "bg-amber-100 text-amber-800 border-amber-200",
  1: "bg-emerald-100 text-emerald-800 border-emerald-200",
  2: "bg-brand-100 text-brand-800 border-brand-200",
  3: "bg-slate-200 text-slate-700 border-slate-300",
};

const PROFILE_STATUS_BADGE: Record<string, string> = {
  draft: "bg-amber-50 text-amber-700 border-amber-200",
  published: "bg-emerald-50 text-emerald-700 border-emerald-200",
  archived: "bg-slate-200 text-slate-600 border-slate-300",
};

type WhitepaperStatus = AssetProfile["whitepaper_status"];

const WHITEPAPER_STATUS_OPTIONS: Array<{
  value: WhitepaperStatus;
  label: string;
}> = [
  { value: "none", label: "None" },
  { value: "draft", label: "Draft" },
  { value: "published", label: "Published" },
  {
    value: "ssc_approval_pending",
    label: "Awaiting Securities Commission approval (Serbia)",
  },
  {
    value: "ssc_approved",
    label: "Approved by Securities Commission (Serbia)",
  },
];

const WHITEPAPER_STATUS_BADGE: Record<WhitepaperStatus, string> = {
  none: "bg-slate-100 text-slate-600 border-slate-200",
  draft: "bg-amber-50 text-amber-700 border-amber-200",
  published: "bg-emerald-50 text-emerald-700 border-emerald-200",
  ssc_approval_pending: "bg-brand-50 text-brand-700 border-brand-200",
  ssc_approved: "bg-emerald-50 text-emerald-700 border-emerald-200",
};

/** Public URL for a whitepaper file stored in the public `documents` bucket. */
function whitepaperFileUrl(path: string | null): string | null {
  if (!path) return null;
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  return base
    ? `${base}/storage/v1/object/public/documents/${path}`
    : null;
}

async function sha256Hex(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
  let out = "";
  for (let i = 0; i < bytes.length; i += 1)
    out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

const SHARE_CLASS_LABEL = [
  "Common",
  "Pref A",
  "Pref B",
  "Sr debt",
  "Jr debt",
  "Rev",
  "Royalty",
];

const inputClass =
  "mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none";
const selectClass =
  "mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-400 focus:outline-none";
const labelSpan = "text-xs font-medium uppercase tracking-wide text-slate-500";

type Variant = "admin" | "issuer";

type CategoryValues = Record<string, string | boolean>;

export function AssetDetail({
  id,
  variant,
  /** When set (issuer view), the asset's issuer authority must equal this wallet
   *  or the detail is treated as not-yours. */
  gateWallet,
}: {
  id: string;
  variant: Variant;
  gateWallet?: string | null;
}) {
  const client = useSolanaClient();
  const conn = useWalletConnection();
  const toast = useToast();

  const [data, setData] = useState<NetworkData | null>(null);
  const [failed, setFailed] = useState(false);
  const [asset, setAsset] = useState<Asset | null | undefined>(undefined);
  const [issuer, setIssuer] = useState<Issuer | null>(null);
  const [profile, setProfile] = useState<AssetProfile | null | undefined>(
    undefined,
  );

  const baseHref = variant === "admin" ? "/admin" : "/issuer";

  const refresh = useCallback(async () => {
    try {
      const network = await loadNetworkPreferIndexer(() =>
        loadNetwork(client.runtime.rpc),
      );
      setData(network);

      // Match the on-chain Asset by deriving each asset's PDA and comparing to `id`.
      let matched: Asset | null = null;
      for (const a of network.assets) {
        const [pda] = await findAssetPda({
          issuer: a.issuer,
          assetId: a.assetId,
        });
        if (pda.toString() === id) {
          matched = a;
          break;
        }
      }
      setAsset(matched);

      if (matched) {
        // Resolve the issuer record by matching derived issuer PDA.
        let matchedIssuer: Issuer | null = null;
        for (const i of network.issuers) {
          const [pda] = await findIssuerPda({ legalEntityId: i.legalEntityId });
          if (pda.toString() === matched.issuer.toString()) {
            matchedIssuer = i;
            break;
          }
        }
        setIssuer(matchedIssuer);
      } else {
        setIssuer(null);
      }

      const row = conn.wallet ? await getAssetProfile(conn.wallet, id) : null;
      setProfile(row);
    } catch {
      setFailed(true);
      setAsset(null);
      setProfile(null);
    }
  }, [client, id, conn.wallet]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  // Issuer-view gating: the asset must belong to the connected wallet's issuer.
  const ownedByMe = useMemo(() => {
    if (variant === "admin") return true;
    if (!asset || !issuer) return false;
    if (!gateWallet) return false;
    return issuer.authority.toString() === gateWallet;
  }, [variant, asset, issuer, gateWallet]);

  // ── Category + common edit state ──
  const [editing, setEditing] = useState(false);
  const [editDisplayName, setEditDisplayName] = useState("");
  const [editSummary, setEditSummary] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editWebsite, setEditWebsite] = useState("");
  const [editJurisdiction, setEditJurisdiction] = useState("");
  const [catValues, setCatValues] = useState<CategoryValues>({});
  const [saving, setSaving] = useState(false);

  const category: CategorySlug | null = useMemo(() => {
    if (profile?.category) return profile.category;
    if (asset) return (slugForEnum(asset.assetType) || null) as CategorySlug | null;
    return null;
  }, [profile, asset]);

  const fields = useMemo(
    () => (category ? fieldsForCategory(category) : []),
    [category],
  );

  function openEdit() {
    if (!asset) return;
    setEditDisplayName(profile?.display_name ?? asset.name);
    setEditSummary(profile?.summary ?? "");
    setEditDescription(profile?.description ?? "");
    setEditWebsite(profile?.website ?? "");
    setEditJurisdiction(profile?.jurisdiction ?? "");
    const next: CategoryValues = {};
    for (const f of fields) {
      const stored = (profile as Record<string, unknown> | null)?.[f.key];
      // For a boolean whose stored value is null (never set), honour the field's
      // default rather than coercing to false — otherwise opening + saving an
      // untouched field silently flips a non-false DB default (e.g. kyb_gated).
      next[f.key] =
        f.type === "boolean" && (stored === null || stored === undefined)
          ? (f.default ?? false)
          : toFormValue(f, stored);
    }
    setCatValues(next);
    setEditing(true);
  }

  function setCat(key: string, value: string | boolean) {
    setCatValues((prev) => ({ ...prev, [key]: value }));
  }

  const [publishing, setPublishing] = useState(false);
  /** Flip the off-chain profile between draft and published. Published profiles
   *  appear on the public /markets/[slug] category pages and the marketplace
   *  asset detail; drafts stay private to admin/issuer. */
  async function setPublished(published: boolean) {
    if (!asset || !category) return;
    setPublishing(true);
    try {
      const ok = await upsertAssetProfile(conn.wallet, {
        asset_pda: id,
        category,
        issuer_pda: asset.issuer.toString(),
        status: published ? "published" : "draft",
        is_published: published,
      });
      if (!ok) throw new Error("Upsert returned false");
      toast.show({
        kind: "success",
        title: published ? "Profile published" : "Profile unpublished",
      });
      await refresh();
    } catch (err) {
      toast.showError(
        "Failed to update visibility",
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setPublishing(false);
    }
  }

  async function save() {
    if (!asset || !category) return;
    setSaving(true);
    try {
      const profileFields: Record<string, string | number | boolean | null> = {};
      for (const f of fields) {
        const raw = catValues[f.key];
        if (raw === undefined) continue;
        profileFields[f.key] = toColumnValue(f, raw);
      }
      const row: NewAssetProfile = {
        asset_pda: id,
        category,
        issuer_pda: asset.issuer.toString(),
        display_name: editDisplayName.trim() || asset.name,
        summary: editSummary.trim() || null,
        description: editDescription.trim() || null,
        website: editWebsite.trim() || null,
        jurisdiction: editJurisdiction || null,
      };
      Object.assign(row, profileFields);
      const ok = await upsertAssetProfile(conn.wallet, row);
      if (!ok) throw new Error("Upsert returned false");
      toast.show({ kind: "success", title: "Profile saved" });
      setEditing(false);
      await refresh();
    } catch (err) {
      toast.showError(
        "Failed to save profile",
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setSaving(false);
    }
  }

  if (variant === "issuer" && !gateWallet) {
    return <WalletRequired context="Use the issuer wallet that registered this asset to manage it." />;
  }

  if (failed) {
    return (
      <div className="mt-4">
        <p className="text-sm text-red-600">Failed to load asset.</p>
      </div>
    );
  }

  if (asset === undefined || profile === undefined) {
    return (
      <div className="mt-4 space-y-6">
        <SkeletonCard rows={6} />
      </div>
    );
  }

  if (asset === null) {
    return (
      <div className="mt-4">
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
          Asset
        </p>
        <h1 className="mt-1 text-xl font-semibold text-slate-900">Not found</h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-slate-600">
          No on-chain asset matches this PDA on this network.
        </p>
        <Link
          href={`${baseHref}/assets`}
          className="mt-4 inline-block text-sm text-slate-600 underline-offset-2 hover:underline"
        >
          ← Back to assets
        </Link>
      </div>
    );
  }

  if (variant === "issuer" && !ownedByMe) {
    return (
      <div className="mt-4">
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
          Asset
        </p>
        <h1 className="mt-1 text-xl font-semibold text-slate-900">
          Not your asset
        </h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-slate-600">
          This asset is registered under another issuer authority.
        </p>
        <Link
          href="/issuer/assets"
          className="mt-4 inline-block text-sm text-slate-600 underline-offset-2 hover:underline"
        >
          ← Back to my assets
        </Link>
      </div>
    );
  }

  const typeRecord = category ? assetTypeBySlug(category) : undefined;
  const canEdit =
    variant === "admin" || profile === null || profile.status === "draft";
  const displayName = profile?.display_name || asset.name;
  const issuerLegalId = issuer ? fromBytes32(issuer.legalEntityId) : null;

  // Lifecycle shortcuts: deep-link into the management surfaces for this asset.
  const shortcuts =
    variant === "admin"
      ? [
          { href: "/admin/share-classes", label: "Share classes" },
          { href: "/admin/launchpad", label: "Launchpad" },
          { href: "/admin/custody", label: "Custody" },
          { href: "/admin/governance", label: "Governance" },
        ]
      : [
          { href: "/issuer/share-classes", label: "Share classes" },
          { href: "/issuer/launchpad", label: "Launchpad" },
          { href: "/issuer/vesting", label: "Vesting" },
        ];

  return (
    <div className="mt-4">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-1.5">
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
              Asset
            </p>
            <span className="inline-flex rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-slate-600">
              {ASSET_TYPE_LABEL[asset.assetType] ?? "?"}
            </span>
            {profile && (
              <span
                className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                  PROFILE_STATUS_BADGE[profile.status] ??
                  PROFILE_STATUS_BADGE.draft
                }`}
              >
                {profile.status}
              </span>
            )}
          </div>
          <h1 className="mt-1 text-xl font-semibold text-slate-900">
            {displayName}
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            {asset.assetId} · {asset.symbolPrefix}
            {issuerLegalId ? <> · {issuerLegalId}</> : null}
          </p>
        </div>
        <span
          className={`shrink-0 rounded-full border px-3 py-1 text-xs font-semibold ${
            STATUS_BADGE[asset.status] ?? STATUS_BADGE[0]
          }`}
        >
          {ASSET_STATUS_LABEL[asset.status] ?? "?"}
        </span>
      </div>

      {/* Lifecycle shortcuts */}
      <div className="mt-5 flex flex-wrap gap-2">
        {shortcuts.map((s) => (
          <Link
            key={s.href}
            href={s.href}
            className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:border-slate-300 hover:bg-slate-50"
          >
            {s.label} →
          </Link>
        ))}
      </div>

      {/* Product profile (common + category) */}
      <section className="mt-6 rounded-xl border border-slate-200 bg-white p-6 shadow-card">
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            Product profile
          </p>
          {!editing && (
            <div className="flex items-center gap-2">
              {profile && (variant === "admin" || ownedByMe) && (
                <button
                  type="button"
                  disabled={publishing}
                  onClick={() => void setPublished(!profile.is_published)}
                  className={`rounded-md px-3 py-1 text-xs font-medium disabled:opacity-50 ${
                    profile.is_published
                      ? "border border-slate-200 text-slate-600 hover:border-slate-300 hover:bg-slate-50"
                      : "bg-emerald-600 text-white hover:bg-emerald-700"
                  }`}
                  title={
                    profile.is_published
                      ? "Hide from the public marketplace and category pages"
                      : "Make this profile visible on the public marketplace and /markets pages"
                  }
                >
                  {publishing
                    ? "…"
                    : profile.is_published
                      ? "Unpublish"
                      : "Publish"}
                </button>
              )}
              {canEdit && (
                <button
                  type="button"
                  onClick={openEdit}
                  className="rounded-md border border-slate-200 px-3 py-1 text-xs font-medium text-slate-600 hover:border-slate-300 hover:bg-slate-50"
                >
                  Edit
                </button>
              )}
            </div>
          )}
        </div>

        {editing ? (
          <div className="mt-4 space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className={labelSpan}>Display name</span>
                <input
                  value={editDisplayName}
                  maxLength={120}
                  onChange={(e) => setEditDisplayName(e.target.value)}
                  placeholder={asset.name}
                  className={inputClass}
                />
              </label>
              <label className="block">
                <span className={labelSpan}>Jurisdiction</span>
                <select
                  value={editJurisdiction}
                  onChange={(e) => setEditJurisdiction(e.target.value)}
                  className={selectClass}
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
                  value={editSummary}
                  maxLength={200}
                  onChange={(e) => setEditSummary(e.target.value)}
                  placeholder="One-line description for listings"
                  className={inputClass}
                />
              </label>
              <label className="block sm:col-span-2">
                <span className={labelSpan}>Description</span>
                <textarea
                  value={editDescription}
                  rows={3}
                  onChange={(e) => setEditDescription(e.target.value)}
                  placeholder="Longer description, terms, context…"
                  className={inputClass}
                />
              </label>
              <label className="block sm:col-span-2">
                <span className={labelSpan}>Website</span>
                <input
                  value={editWebsite}
                  onChange={(e) => setEditWebsite(e.target.value)}
                  placeholder="https://"
                  className={inputClass}
                />
              </label>
            </div>

            {fields.length > 0 && (
              <div className="space-y-3 border-t border-slate-100 pt-4">
                <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                  {typeRecord?.title ?? "Category"} details
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

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                disabled={saving}
                onClick={() => setEditing(false)}
                className="rounded-md px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={() => void save()}
                className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
              >
                {saving ? "Saving…" : "Save profile"}
              </button>
            </div>
          </div>
        ) : profile === null ? (
          <p className="mt-4 text-sm text-slate-500">
            No off-chain product profile yet.
            {canEdit ? " Use Edit to add display details and category facts." : ""}
          </p>
        ) : (
          <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
            <Field label="Display name" value={profile.display_name || asset.name} />
            <Field
              label="Jurisdiction"
              value={countryName(profile.jurisdiction)}
            />
            <Field
              label="Summary"
              value={profile.summary || "—"}
              wide
            />
            <Field
              label="Description"
              value={profile.description || "—"}
              wide
            />
            <Field
              label="Website"
              value={profile.website || "—"}
              wide
            />
            {profile.legal_doc_sha256 && (
              <Field
                label="Legal doc SHA-256"
                value={profile.legal_doc_sha256}
                mono
                wide
              />
            )}
          </dl>
        )}
      </section>

      {/* Category facts */}
      {!editing && profile && fields.length > 0 && (
        <section className="mt-6 rounded-xl border border-slate-200 bg-white p-6 shadow-card">
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            {typeRecord?.title ?? "Category"} facts
          </p>
          <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
            {fields.map((f) => (
              <Field
                key={f.key}
                label={f.label}
                value={displayFieldValue(
                  f,
                  (profile as Record<string, unknown>)[f.key],
                )}
                wide={f.type === "textarea"}
              />
            ))}
          </dl>
        </section>
      )}

      {/* Whitepaper & disclosure (admin always; issuer for their own asset —
          the issuer variant already early-returns when the asset isn't theirs) */}
      <WhitepaperCard
        variant={variant}
        assetPda={id}
        issuerPda={asset.issuer.toString()}
        category={category}
        profile={profile}
        onSaved={refresh}
      />

      {/* On-chain facts */}
      <section className="mt-6 rounded-xl border border-slate-200 bg-white p-6 shadow-card">
        <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
          On-chain
        </p>
        <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
          <Field label="Asset ID" value={asset.assetId} />
          <Field label="Symbol prefix" value={asset.symbolPrefix} />
          <Field
            label="Type"
            value={ASSET_TYPE_LABEL[asset.assetType] ?? "?"}
          />
          <Field
            label="Status"
            value={ASSET_STATUS_LABEL[asset.status] ?? "?"}
          />
          <Field
            label="Share classes"
            value={String(asset.shareClassesCount)}
          />
          <Field
            label="Allows P2P"
            value={asset.jurisdictionRules.allowP2p ? "Yes" : "No"}
          />
          <Field
            label="Max holders"
            value={
              asset.jurisdictionRules.maxHolders === 0
                ? "unlimited"
                : String(asset.jurisdictionRules.maxHolders)
            }
          />
          <Field label="Issuer PDA" value={asset.issuer.toString()} mono />
          <Field label="Asset PDA" value={id} mono />
        </dl>
      </section>

      {/* Share classes */}
      {data && (
        <ShareClassesBlock
          assetPda={id}
          data={data}
          shareClassesHref={`${baseHref}/share-classes`}
        />
      )}
    </div>
  );
}

/** Whitepaper & disclosure management (Flows doc section 10) + SPV linkage.
 *  An issuer either publishes a proper whitepaper (preferred) or the platform
 *  publishes the submitted form information on the public asset page. */
function WhitepaperCard({
  variant,
  assetPda,
  issuerPda,
  category,
  profile,
  onSaved,
}: {
  variant: Variant;
  assetPda: string;
  issuerPda: string;
  category: CategorySlug | null;
  profile: AssetProfile | null;
  onSaved: () => Promise<void>;
}) {
  const conn = useWalletConnection();
  const toast = useToast();
  const isAdmin = variant === "admin";

  const [file, setFile] = useState<File | null>(null);
  const [externalUrl, setExternalUrl] = useState("");
  const [status, setStatus] = useState<WhitepaperStatus>("none");
  const [spvId, setSpvId] = useState("");
  const [spvs, setSpvs] = useState<SpvRow[]>([]);
  const [sscRef, setSscRef] = useState("");
  const [sscFile, setSscFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  // Reset the file inputs after a successful save.
  const [fileInputKey, setFileInputKey] = useState(0);

  // Sync form state from the loaded profile.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setExternalUrl(profile?.whitepaper_url ?? "");
    setStatus(profile?.whitepaper_status ?? "none");
    setSpvId(profile?.spv_id ?? "");
    setSscRef(profile?.ssc_decision_ref ?? "");
  }, [profile]);

  useEffect(() => {
    let cancelled = false;
    void listSpvs().then((rows) => {
      if (!cancelled) setSpvs(rows);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // The rolling 12-month raise limit of the asset's subject (its SPV), from
  // the signed route (the admin or the asset's issuer), so the issuer sees the
  // headroom before a sale approval or a close would need it.
  const [spvCap, setSpvCap] = useState<SpvCapacity | null>(null);
  const linkedSpvId = profile?.spv_id ?? "";
  useEffect(() => {
    let cancelled = false;
    if (!linkedSpvId || !conn.wallet) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSpvCap(null);
      return;
    }
    void spvCapacity(conn.wallet, { asset: assetPda }).then((capacity) => {
      if (!cancelled) setSpvCap(capacity);
    });
    return () => {
      cancelled = true;
    };
  }, [linkedSpvId, assetPda, conn.wallet]);

  const fileUrl = whitepaperFileUrl(profile?.whitepaper_path ?? null);
  const currentStatus = profile?.whitepaper_status ?? "none";
  const statusLabel =
    WHITEPAPER_STATUS_OPTIONS.find((o) => o.value === currentStatus)?.label ??
    currentStatus;
  const selectedSpv = spvs.find((s) => s.id === spvId);
  const currentSpv = spvs.find((s) => s.id === (profile?.spv_id ?? ""));
  const currentIsSsc =
    currentStatus === "ssc_approval_pending" || currentStatus === "ssc_approved";
  // The SSC statuses are set by the platform (admin) only — the issuer variant
  // never offers them and shows a read-only badge instead when one is set.
  const statusOptions = isAdmin
    ? WHITEPAPER_STATUS_OPTIONS
    : WHITEPAPER_STATUS_OPTIONS.filter(
        (o) =>
          o.value !== "ssc_approval_pending" && o.value !== "ssc_approved",
      );
  const sscDecisionDocUrl = whitepaperFileUrl(
    profile?.ssc_decision_doc_path ?? null,
  );

  async function save() {
    if (!category) {
      toast.showError(
        "Cannot save",
        "This asset has no resolvable category yet. Save the product profile first.",
      );
      return;
    }
    // The ssc_approved status must be backed by a decision reference.
    if (isAdmin && status === "ssc_approved" && !sscRef.trim()) {
      toast.showError(
        "Decision reference required",
        "Setting the status to Securities Commission approved requires the SSC decision reference (e.g. the decision number).",
      );
      return;
    }
    setSaving(true);
    const t = toast.showPending("Saving whitepaper & disclosure…");
    try {
      const row: NewAssetProfile = {
        asset_pda: assetPda,
        category,
        issuer_pda: issuerPda,
        whitepaper_url: externalUrl.trim() || null,
        whitepaper_status: status,
        spv_id: spvId || null,
      };
      if (isAdmin) {
        row.ssc_decision_ref = sscRef.trim() || null;
      }

      if (file) {
        const sha = await sha256Hex(file);
        const safeName = file.name.replace(/[^A-Za-z0-9._-]+/g, "_");
        const storagePath = `whitepapers/${assetPda}/${sha.slice(0, 8)}-${safeName}`;
        // Signed upload route (admin OR issuer-authority for this asset).
        // The server verifies actual bytes and returns the immutable full-hash path.
        const uploaded = await signedUpload(conn.wallet, { path: storagePath, file, sha256: sha });
        row.whitepaper_path = uploaded.path;
        row.whitepaper_sha256 = uploaded.sha256;
      }

      // Optional SSC decision document (admin only) — stored alongside the
      // whitepaper with the same content-addressed path pattern.
      if (isAdmin && sscFile) {
        const sha = await sha256Hex(sscFile);
        const safeName = sscFile.name.replace(/[^A-Za-z0-9._-]+/g, "_");
        const storagePath = `whitepapers/${assetPda}/ssc-decision/${sha.slice(0, 8)}-${safeName}`;
        const uploaded = await signedUpload(conn.wallet, {
          path: storagePath,
          file: sscFile,
          sha256: sha,
        });
        row.ssc_decision_doc_path = uploaded.path;
        row.ssc_decision_doc_sha256 = uploaded.sha256;
      }

      // Stamp the publication moment when the whitepaper first goes live
      // (published or Securities Commission approved).
      const goesLive = status === "published" || status === "ssc_approved";
      const wasLive =
        currentStatus === "published" || currentStatus === "ssc_approved";
      if (goesLive && (!wasLive || !profile?.whitepaper_published_at)) {
        row.whitepaper_published_at = new Date().toISOString();
      }

      const ok = await upsertAssetProfile(conn.wallet, row);
      if (!ok) throw new Error("Upsert returned false");
      toast.dismiss(t);
      toast.show({ kind: "success", title: "Whitepaper & disclosure saved" });
      setFile(null);
      setSscFile(null);
      setFileInputKey((k) => k + 1);
      await onSaved();
    } catch (err) {
      toast.dismiss(t);
      toast.showError(
        "Failed to save whitepaper",
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="mt-6 rounded-xl border border-slate-200 bg-white p-6 shadow-card">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
          Whitepaper &amp; disclosure
        </p>
        <span
          className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
            WHITEPAPER_STATUS_BADGE[currentStatus]
          }`}
        >
          {statusLabel}
        </span>
      </div>

      <p className="mt-2 text-[12.5px] leading-relaxed text-slate-500">
        A proper whitepaper is the preferred option and is published on the
        Manci website. Without one, the platform publishes the submitted
        form information as the token&apos;s official basic information.
      </p>

      {/* Current state */}
      <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
        {fileUrl && (
          <div className="sm:col-span-2">
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Uploaded document
            </dt>
            <dd className="mt-0.5 text-sm">
              <a
                href={fileUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-slate-700 underline-offset-2 hover:underline"
              >
                {profile?.whitepaper_path?.split("/").pop() ?? "Whitepaper"} ↗
              </a>
            </dd>
          </div>
        )}
        {profile?.whitepaper_sha256 && (
          <Field
            label={profile.whitepaper_version_id ? "Server-verified whitepaper SHA-256" : "Declared whitepaper SHA-256 (unverified)"}
            value={profile.whitepaper_sha256}
            mono
            wide
          />
        )}
        {profile?.whitepaper_url && (
          <div className="sm:col-span-2">
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
              External whitepaper URL
            </dt>
            <dd className="mt-0.5 break-all text-sm">
              {safeHttpUrl(profile.whitepaper_url) ? (
                <a
                  href={safeHttpUrl(profile.whitepaper_url)!}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-slate-700 underline-offset-2 hover:underline"
                >
                  {profile.whitepaper_url} ↗
                </a>
              ) : (
                <span className="text-slate-700">{profile.whitepaper_url}</span>
              )}
            </dd>
          </div>
        )}
        {profile?.whitepaper_published_at && (
          <Field
            label="Published at"
            value={new Date(profile.whitepaper_published_at).toLocaleString(
              "en-US",
            )}
          />
        )}
        {profile?.ssc_decision_ref && (
          <Field
            label="SSC decision reference"
            value={profile.ssc_decision_ref}
          />
        )}
        {sscDecisionDocUrl && (
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
              SSC decision document
            </dt>
            <dd className="mt-0.5 text-sm">
              <a
                href={sscDecisionDocUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-slate-700 underline-offset-2 hover:underline"
              >
                {profile?.ssc_decision_doc_path?.split("/").pop() ??
                  "Decision document"}{" "}
                ↗
              </a>
            </dd>
          </div>
        )}
        {currentSpv && (
          <Field
            label="Issued through SPV"
            value={`${currentSpv.name} (${currentSpv.status})`}
          />
        )}
      </dl>

      {/* Edit form */}
      <div className="mt-4 grid gap-3 border-t border-slate-100 pt-4 sm:grid-cols-2">
        <label className="block">
          <span className={labelSpan}>Upload whitepaper (PDF / DOCX)</span>
          <input
            key={fileInputKey}
            type="file"
            accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="mt-1 block w-full text-sm text-slate-600 file:mr-3 file:rounded-md file:border file:border-slate-300 file:bg-white file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-slate-700 hover:file:bg-slate-50"
          />
          <span className="mt-1 block text-[11px] text-slate-400">
            Stored in the public documents bucket; the SHA-256 is recorded for
            integrity.
          </span>
        </label>
        <label className="block">
          <span className={labelSpan}>Or external whitepaper URL</span>
          <input
            value={externalUrl}
            onChange={(e) => setExternalUrl(e.target.value)}
            placeholder="https://"
            className={inputClass}
          />
        </label>
        {!isAdmin && currentIsSsc ? (
          /* Issuer view of an SSC status: read-only — only the platform
             (admin) can set or change Securities Commission statuses. */
          <div className="block">
            <span className={labelSpan}>Whitepaper status</span>
            <div className="mt-1">
              <span
                className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                  WHITEPAPER_STATUS_BADGE[currentStatus]
                }`}
              >
                {statusLabel}
              </span>
            </div>
            <span className="mt-1 block text-[11px] text-slate-400">
              Securities Commission statuses are managed by Manci and
              cannot be changed here.
            </span>
          </div>
        ) : (
          <label className="block">
            <span className={labelSpan}>Whitepaper status</span>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as WhitepaperStatus)}
              className={selectClass}
            >
              {statusOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-[11px] text-slate-400">
              Some tokens issued in Serbia need Securities Commission approval
              for the whitepaper.
              {!isAdmin &&
                " SSC statuses are set by Manci once the Commission decides."}
            </span>
          </label>
        )}
        {isAdmin &&
          (status === "ssc_approval_pending" ||
            status === "ssc_approved" ||
            Boolean(profile?.ssc_decision_ref)) && (
            <>
              <label className="block">
                <span className={labelSpan}>SSC decision reference</span>
                <input
                  value={sscRef}
                  onChange={(e) => setSscRef(e.target.value)}
                  placeholder="Decision no. …"
                  className={inputClass}
                />
                <span className="mt-1 block text-[11px] text-slate-400">
                  Required to set the status to Securities Commission approved.
                  Shown publicly next to the approval badge.
                </span>
              </label>
              <label className="block">
                <span className={labelSpan}>
                  SSC decision document (optional)
                </span>
                <input
                  key={`ssc-${fileInputKey}`}
                  type="file"
                  accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                  onChange={(e) => setSscFile(e.target.files?.[0] ?? null)}
                  className="mt-1 block w-full text-sm text-slate-600 file:mr-3 file:rounded-md file:border file:border-slate-300 file:bg-white file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-slate-700 hover:file:bg-slate-50"
                />
                <span className="mt-1 block text-[11px] text-slate-400">
                  The Commission&apos;s decision, stored alongside the
                  whitepaper; the SHA-256 is recorded for integrity.
                </span>
              </label>
            </>
          )}
        <label className="block">
          <span className={labelSpan}>SPV</span>
          {isAdmin ? (
            <>
              <select
                value={spvId}
                onChange={(e) => setSpvId(e.target.value)}
                className={selectClass}
              >
                <option value="">— none —</option>
                {spvs.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.status})
                  </option>
                ))}
              </select>
              <span className="mt-1 flex items-center gap-1.5 text-[11px] text-slate-400">
                Serbian SPV this issuance runs through (EUR 3M/year cap)
                {selectedSpv && (
                  <span
                    className={`inline-flex rounded-full border px-1.5 py-px text-[9px] font-semibold uppercase ${
                      selectedSpv.status === "active"
                        ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                        : selectedSpv.status === "retired"
                          ? "border-slate-300 bg-slate-100 text-slate-600"
                          : "border-amber-200 bg-amber-50 text-amber-700"
                    }`}
                  >
                    {selectedSpv.status}
                  </span>
                )}
              </span>
            </>
          ) : (
            // SPV assignment is a Manci-team operation (server-enforced:
            // /api/profiles/upsert drops issuer-path spv_id changes). Show the
            // linked SPV read-only.
            <div className="mt-1 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
              {currentSpv ? (
                <span className="flex items-center gap-1.5">
                  {currentSpv.name}
                  <span className="text-[11px] uppercase text-slate-400">
                    ({currentSpv.status})
                  </span>
                </span>
              ) : (
                "Not yet assigned"
              )}
              {currentSpv && spvCap !== null && (
                <span className="mt-1.5 block text-[11px]">
                  <span className="text-slate-500">
                    Last 12 months: issued €{spvCap.issued.toLocaleString("en-US")}
                    {spvCap.reserved > 0 ? ` + reserved €${spvCap.reserved.toLocaleString("en-US")}` : ""} of €
                    {spvCap.cap.toLocaleString("en-US")}
                  </span>{" "}
                  <span
                    className={
                      spvCap.remaining <= 0
                        ? "font-medium text-red-600"
                        : spvCap.remaining < spvCap.cap * 0.1
                          ? "font-medium text-amber-700"
                          : "text-emerald-700"
                    }
                  >
                    (€{Math.max(0, spvCap.remaining).toLocaleString("en-US")} remaining)
                  </span>
                  {spvCap.holds > 0 && (
                    <span className="mt-0.5 block font-medium text-red-600">
                      On hold until an on-chain sale or mint is counted.
                    </span>
                  )}
                </span>
              )}
              <span className="mt-1 block text-[11px] text-slate-400">
                Serbian SPV this issuance runs through (EUR 3M limit over the
                last 12 months) — assigned by the Manci team.
              </span>
            </div>
          )}
        </label>
      </div>

      <div className="mt-4 flex justify-end">
        <button
          type="button"
          disabled={saving}
          onClick={() => void save()}
          className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save whitepaper & disclosure"}
        </button>
      </div>
    </section>
  );
}

function ShareClassesBlock({
  assetPda,
  data,
  shareClassesHref,
}: {
  assetPda: string;
  data: NetworkData;
  shareClassesHref: string;
}) {
  const linked = useMemo(
    () =>
      data.shareClasses
        .filter((sc) => sc.asset.toString() === assetPda)
        .sort((a, b) => a.classIndex - b.classIndex),
    [data, assetPda],
  );

  return (
    <section className="mt-6 rounded-xl border border-slate-200 bg-white p-6 shadow-card">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
          Share classes ({linked.length})
        </p>
        <Link
          href={shareClassesHref}
          className="text-xs text-slate-500 underline-offset-2 hover:underline"
        >
          Manage →
        </Link>
      </div>
      {linked.length === 0 ? (
        <p className="mt-4 text-sm text-slate-500">
          No share classes registered yet.
        </p>
      ) : (
        <div className="mt-4 overflow-hidden rounded-lg border border-slate-200">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-3 py-2 font-medium">#</th>
                <th className="px-3 py-2 font-medium">Type</th>
                <th className="px-3 py-2 text-right font-medium">Circulating</th>
                <th className="px-3 py-2 font-medium">Mint</th>
                <th className="px-3 py-2 font-medium">State</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {linked.map((sc) => (
                <tr key={shareClassKey(sc.asset, sc.classIndex)} className="text-slate-700">
                  <td className="px-3 py-2 font-mono">#{sc.classIndex}</td>
                  <td className="px-3 py-2">
                    {SHARE_CLASS_LABEL[sc.classType] ?? "?"}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">
                    {String(sc.circulatingSupply)}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">
                    {sc.mintInitialized
                      ? `${sc.mint.toString().slice(0, 6)}…${sc.mint.toString().slice(-4)}`
                      : "—"}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {sc.supplyLocked
                      ? "locked"
                      : sc.mintInitialized
                        ? "active"
                        : "pending mint"}
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

/** Renders one category field input keyed on FieldDef.type. Mirrors the
 *  renderer in asset-create-modal so edit + create feel identical. */
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
          className={selectClass}
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

function Field({
  label,
  value,
  mono = false,
  wide = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
  wide?: boolean;
}) {
  return (
    <div className={wide ? "sm:col-span-2" : undefined}>
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </dt>
      <dd
        className={`mt-0.5 break-all text-slate-800 ${mono ? "font-mono text-xs" : "text-sm"}`}
      >
        {value}
      </dd>
    </div>
  );
}
