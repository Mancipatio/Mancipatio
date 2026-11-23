"use client";

import { useState } from "react";
import { useWalletConnection } from "@solana/react-hooks";
import { signedUpload } from "@/lib/storage-client";
import { upsertAssetProfile, type AssetProfile, type NewAssetProfile } from "@/lib/asset-profiles";
import type { CategorySlug } from "@/lib/asset-types";
import { uploadedLogoUrl } from "@/lib/asset-branding";
import { LOGO_MAX_BYTES, LOGO_MIME_TYPES } from "@/lib/document-integrity";
import { useToast } from "@/lib/toast";

async function sha256Hex(file: File): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The company's logo on the asset's admin and issuer pages (migration 0093).
 *
 * The issuer of the asset, or an admin, uploads a PNG or JPEG of at most
 * 1 MB to logos/<asset PDA>/ (the type and size are checked before the
 * wallet is asked to sign, and again by /api/storage/upload). The public
 * pages show it only once an admin approved it; replacing or removing the
 * file withdraws the approval (POST /api/profiles/upsert). Until then the
 * token is listed under its initials.
 */
export function AssetLogoCard({
  variant,
  editable,
  assetPda,
  issuerPda,
  category,
  profile,
  onSaved,
}: {
  variant: "admin" | "issuer";
  /** Whether an issuer may make entries now (KYC-only mode switches them off); an admin always may. */
  editable: boolean;
  assetPda: string;
  issuerPda: string;
  category: CategorySlug | null;
  profile: AssetProfile | null;
  onSaved: () => void | Promise<void>;
}) {
  const conn = useWalletConnection();
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [fileInputKey, setFileInputKey] = useState(0);
  const [busy, setBusy] = useState<"upload" | "remove" | "approve" | "withdraw" | null>(null);

  const isAdmin = variant === "admin";
  const canChange = isAdmin || editable;
  const logoUrl = uploadedLogoUrl(assetPda, profile?.logo_path);
  const approved = Boolean(profile?.logo_path && profile.logo_approved_at);
  const fileProblem = !file
    ? null
    : !LOGO_MIME_TYPES.includes(file.type)
      ? "Choose a PNG or JPEG image."
      : file.size > LOGO_MAX_BYTES
        ? "The image is larger than 1 MB."
        : null;

  async function write(patch: Partial<NewAssetProfile>, done: string, action: NonNullable<typeof busy>) {
    if (!category) return;
    setBusy(action);
    try {
      const ok = await upsertAssetProfile(conn.wallet, { asset_pda: assetPda, category, issuer_pda: issuerPda, ...patch });
      if (!ok) throw new Error("The profile could not be saved");
      toast.show({ kind: "success", title: done });
      setFile(null);
      setFileInputKey((key) => key + 1);
      await onSaved();
    } catch (err) {
      toast.showError("Logo not saved", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function upload() {
    if (!file || fileProblem || !category) return;
    setBusy("upload");
    try {
      const sha = await sha256Hex(file);
      const safeName = file.name.replace(/[^A-Za-z0-9._-]+/g, "_");
      const uploaded = await signedUpload(conn.wallet, { path: `logos/${assetPda}/${sha.slice(0, 8)}-${safeName}`, file, sha256: sha });
      await write({ logo_path: uploaded.path, logo_sha256: uploaded.sha256 }, "Logo uploaded", "upload");
    } catch (err) {
      toast.showError("Logo not uploaded", err instanceof Error ? err.message : String(err));
      setBusy(null);
    }
  }

  return (
    <section className="mt-6 rounded-xl border border-slate-200 bg-white p-6 shadow-card">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Company logo</p>
        <span className={`rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${
          approved ? "border-emerald-200 bg-emerald-50 text-emerald-700"
            : profile?.logo_path ? "border-amber-200 bg-amber-50 text-amber-800"
              : "border-slate-200 bg-slate-50 text-slate-500"
        }`}>
          {approved ? "Approved" : profile?.logo_path ? "Waiting for approval" : "None"}
        </span>
      </div>
      <p className="mt-2 text-sm text-slate-600">
        Shown next to the token on the public pages once Manci has approved it. Until then the token is listed under its initials.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-4">
        <span className="asset-logo" style={{ width: 72, height: 72 }} aria-hidden="true">
          {logoUrl
            // The uploaded file in the storage bucket, approved or not: the issuer and the admin see what was sent.
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={logoUrl} width={72} height={72} alt="" />
            : "—"}
        </span>
        <div className="min-w-0 flex-1 text-xs text-slate-500">
          {profile?.logo_path ? (
            <>
              <p className="break-all font-mono text-[11px] text-slate-500">SHA-256 {profile.logo_sha256}</p>
              {approved && profile.logo_approved_at && (
                <p className="mt-1">Approved {new Date(profile.logo_approved_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}{isAdmin && profile.logo_approved_by ? ` by ${profile.logo_approved_by.slice(0, 4)}…${profile.logo_approved_by.slice(-4)}` : ""}.</p>
              )}
            </>
          ) : (
            <p>No logo uploaded.</p>
          )}
        </div>
      </div>

      {canChange && (
        <div className="mt-5 border-t border-slate-100 pt-4">
          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">{profile?.logo_path ? "Replace the logo" : "Upload a logo"} (PNG or JPEG, at most 1 MB)</span>
            <input
              key={fileInputKey}
              type="file"
              accept="image/png,image/jpeg"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              className="mt-1 block w-full text-sm text-slate-600 file:mr-3 file:rounded-md file:border file:border-slate-300 file:bg-white file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-slate-700"
            />
          </label>
          {fileProblem && <p className="mt-1 text-xs text-red-600">{fileProblem}</p>}
          {profile?.logo_path && approved && (
            <p className="mt-1 text-[11px] text-slate-400">A new file needs a new approval; the public pages show initials until then.</p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={!file || Boolean(fileProblem) || busy !== null || !category}
              onClick={() => void upload()}
              className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50"
            >
              {busy === "upload" ? "Uploading…" : "Upload logo"}
            </button>
            {profile?.logo_path && (
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void write({ logo_path: null, logo_sha256: null }, "Logo removed", "remove")}
                className="rounded-md border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 hover:border-slate-300 hover:bg-slate-50 disabled:opacity-50"
              >
                {busy === "remove" ? "Removing…" : "Remove logo"}
              </button>
            )}
            {isAdmin && profile?.logo_path && !approved && (
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void write({ logo_approved: true }, "Logo approved", "approve")}
                className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                title="Show this logo next to the token on the public pages"
              >
                {busy === "approve" ? "Approving…" : "Approve logo"}
              </button>
            )}
            {isAdmin && approved && (
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void write({ logo_approved: false }, "Approval withdrawn", "withdraw")}
                className="rounded-md border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 hover:border-slate-300 hover:bg-slate-50 disabled:opacity-50"
              >
                {busy === "withdraw" ? "Withdrawing…" : "Withdraw approval"}
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
