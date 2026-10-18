"use client";

import Link from "next/link";
import { useWalletConnection } from "@solana/react-hooks";
import { useCallback, useEffect, useMemo, useState } from "react";
import { fromBytes32, KYB_LABEL } from "@/lib/format";
import { SkeletonCard } from "@/components/skeleton";
import { getIssuerProfile, upsertIssuerProfile, type IssuerProfile } from "@/lib/issuer-profiles";
import type { WalletSession } from "@solana/client";
import { useToast } from "@/lib/toast";
import { Kpi } from "@/components/kpi";
import { IssuerRecoveryBanner } from "@/components/issuer-recovery-banner";
import { scopeEnabled } from "@/lib/features";
import type { Address } from "@solana/kit";
import { useIssuerWorkflow } from "./use-issuer-workflow";
import { IssuerCompanyTools, IssuerWorkflow } from "./issuer-workflow";

export default function IssuerOverviewPage() {
  const conn = useWalletConnection();
  const wallet = conn.wallet?.account.address;
  const workflow = useIssuerWorkflow();
  const { data, me, refresh } = workflow;
  const issuerKey = me ? `${me.authority}:${fromBytes32(me.legalEntityId)}` : null;
  const [issuerAddress, setIssuerAddress] = useState<{ key: string; pda: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!me || !issuerKey) return;
    void import("@/lib/generated/asset_registry").then(async ({ findIssuerPda }) => {
      const [pda] = await findIssuerPda({ legalEntityId: me.legalEntityId });
      if (!cancelled) setIssuerAddress({ key: issuerKey, pda: pda.toString() });
    });
    return () => { cancelled = true; };
  }, [me, issuerKey]);
  const myIssuerPda = me && issuerAddress?.key === issuerKey ? issuerAddress.pda : null;
  const [profileRead, setProfileRead] = useState<{ key: string; profile: IssuerProfile | null; error: string | null } | null>(null);
  const [profileRevision, setProfileRevision] = useState(0);
  const loadProfile = useCallback(async () => { setProfileRevision((revision) => revision + 1); }, []);
  const profileKey = myIssuerPda && wallet ? `${myIssuerPda}:${wallet}:${profileRevision}` : null;
  useEffect(() => {
    if (!myIssuerPda || !conn.wallet || !profileKey) return;
    let cancelled = false;
    void getIssuerProfile(conn.wallet, myIssuerPda).then((profile) => {
      if (!cancelled) setProfileRead({ key: profileKey, profile, error: null });
    }).catch((error: unknown) => {
      if (!cancelled) setProfileRead({ key: profileKey, profile: null, error: error instanceof Error ? error.message : "Company profile unavailable" });
    });
    return () => { cancelled = true; };
  }, [myIssuerPda, conn.wallet, profileKey]);
  const currentProfile = profileRead?.key === profileKey ? profileRead : null;
  const myAssets = useMemo(() => data?.assets.filter((asset) => asset.issuer.toString() === myIssuerPda) ?? [], [data, myIssuerPda]);

  return <main className="min-w-0 flex-1">
    <IssuerWorkflow workflow={workflow} />
    {workflow.failed && <div role="alert" className="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-900">
      <p>Issuer assets could not be loaded. Your verification remains available above.</p>
      <button type="button" onClick={() => void refresh()} className="btn-brand mt-3">Try again</button>
    </div>}
    {me && <>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div><p className="text-xs font-semibold uppercase tracking-widest text-slate-500">Your company</p>
          <h2 className="mt-1 text-xl font-semibold text-slate-900">{fromBytes32(me.legalEntityId)}</h2>
          <p className="mt-1 text-xs text-slate-500">Authority: <code className="font-mono">{wallet?.toString().slice(0, 8)}…{wallet?.toString().slice(-6)}</code></p>
        </div>
        <span className={`rounded-full border px-3 py-1 text-xs font-semibold ${me.kybStatus === 1 ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-amber-200 bg-amber-50 text-amber-800"}`}>Issuer KYB: {KYB_LABEL[me.kybStatus] ?? "Unknown"}</span>
      </div>
      {myIssuerPda && <IssuerRecoveryBanner issuer={myIssuerPda as Address} issuerAuthority={me.authority} onChanged={refresh} />}
      {myIssuerPda && !currentProfile && <SkeletonCard className="mt-6" rows={3} />}
      {currentProfile?.error && <div role="alert" className="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-900"><p>{currentProfile.error}</p><button type="button" onClick={() => void loadProfile()} className="btn-brand mt-3">Try again</button></div>}
      {myIssuerPda && currentProfile && !currentProfile.error && <CompanyProfileCard key={myIssuerPda} issuerPda={myIssuerPda} profile={currentProfile.profile} session={conn.wallet} onSaved={loadProfile} />}
      <section className="mt-8 grid gap-4 sm:grid-cols-3">
        <Link href="/issuer/assets" className="contents"><Kpi label="My assets" value={String(myAssets.length)} /></Link>
        <Kpi label="Assets registered" value={String(me.assetsCount)} /><Kpi label="Jurisdiction" value={String(me.jurisdiction)} />
      </section>
      {scopeEnabled("issuance") && <IssuerCompanyTools />}
      <p className="mt-8 text-xs text-slate-400">Issuer reference: <code className="font-mono">{myIssuerPda ?? "…"}</code></p>
    </>}
  </main>;
}

function CompanyProfileCard({
  issuerPda,
  profile,
  session,
  onSaved,
}: {
  issuerPda: string;
  profile: IssuerProfile | null;
  session: WalletSession | null | undefined;
  onSaved: () => Promise<void>;
}) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [companyName, setCompanyName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [website, setWebsite] = useState("");
  const [saving, setSaving] = useState(false);

  const hasContent = !!(
    profile?.company_name ||
    profile?.contact_email ||
    profile?.website
  );

  function openEdit() {
    setCompanyName(profile?.company_name ?? "");
    setContactEmail(profile?.contact_email ?? "");
    setWebsite(profile?.website ?? "");
    setEditing(true);
  }

  async function save() {
    setSaving(true);
    const ok = await upsertIssuerProfile(session, {
      issuer_pda: issuerPda,
      company_name: companyName.trim() || null,
      contact_email: contactEmail.trim() || null,
      website: website.trim() || null,
    });
    setSaving(false);
    if (!ok) {
      toast.showError(
        "Could not save profile",
        "Please try again in a moment.",
      );
      return;
    }
    toast.show({ kind: "success", title: "Company profile saved" });
    setEditing(false);
    await onSaved();
  }

  return (
    <section className="mt-6 rounded-xl border border-slate-200 bg-white p-5 shadow-card">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-500">
          Company profile
        </h2>
        {/* KYC-only mode: editing the company profile is an issuance entry. */}
        {!editing && scopeEnabled("issuance") && (
          <button
            type="button"
            onClick={openEdit}
            className="rounded-md border border-slate-300 px-3 py-1 text-xs font-medium text-slate-700 hover:border-slate-400"
          >
            {hasContent ? "Edit" : "Add company profile"}
          </button>
        )}
      </div>

      {editing ? (
        <div className="mt-4 space-y-3">
          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Company name
            </span>
            <input
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Contact email
            </span>
            <input
              value={contactEmail}
              onChange={(e) => setContactEmail(e.target.value)}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Website
            </span>
            <input
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
              placeholder="https://…"
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
            />
          </label>
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => setEditing(false)}
              disabled={saving}
              className="rounded-md px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving}
              className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      ) : hasContent ? (
        <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-3">
          {profile?.company_name && (
            <ProfileField label="Company" value={profile.company_name} />
          )}
          {profile?.contact_email && (
            <ProfileField label="Contact" value={profile.contact_email} />
          )}
          {profile?.website && (
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Website
              </dt>
              <dd className="mt-0.5 break-all text-sm">
                <a
                  href={
                    /^https?:\/\//i.test(profile.website)
                      ? profile.website
                      : `https://${profile.website}`
                  }
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-slate-800 underline decoration-slate-300 underline-offset-2 hover:text-slate-900"
                >
                  {profile.website}
                </a>
              </dd>
            </div>
          )}
        </dl>
      ) : (
        <p className="mt-2 text-sm text-slate-500">
          No company profile yet — add your company name, contact email and
          website so they appear on your issuer and marketplace pages.
        </p>
      )}
    </section>
  );
}

function ProfileField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </dt>
      <dd className="mt-0.5 break-all text-sm text-slate-800">{value}</dd>
    </div>
  );
}
