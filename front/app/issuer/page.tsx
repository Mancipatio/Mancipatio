"use client";

import { WalletRequired } from "@/components/wallet-required";

import Link from "next/link";
import { useSolanaClient, useWalletConnection } from "@solana/react-hooks";
import { useCallback, useEffect, useMemo, useState } from "react";
import { loadNetwork, type NetworkData } from "@/lib/enumerate";
import { loadNetworkPreferIndexer } from "@/lib/indexer";
import { fromBytes32, KYB_LABEL } from "@/lib/format";
import { SkeletonCard } from "@/components/skeleton";
import {
  getIssuerProfile,
  upsertIssuerProfile,
  type IssuerProfile,
} from "@/lib/issuer-profiles";
import type { Issuer } from "@/lib/generated/asset_registry";
import type { WalletSession } from "@solana/client";
import { useToast } from "@/lib/toast";

import { Kpi } from "@/components/kpi";
import { IssuerRecoveryBanner } from "@/components/issuer-recovery-banner";
import type { Address } from "@solana/kit";
const KYB_BADGE: Record<number, string> = {
  0: "bg-amber-100 text-amber-800 border-amber-200",
  1: "bg-emerald-100 text-emerald-800 border-emerald-200",
  2: "bg-red-100 text-red-800 border-red-200",
  3: "bg-slate-200 text-slate-700 border-slate-300",
};

export default function IssuerOverviewPage() {
  const conn = useWalletConnection();
  const client = useSolanaClient();
  const wallet = conn.wallet?.account.address;
  const [data, setData] = useState<NetworkData | null>(null);
  const [failed, setFailed] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const network = await loadNetworkPreferIndexer(() =>
        loadNetwork(client.runtime.rpc),
      );
      setData(network);
    } catch {
      setFailed(true);
    }
  }, [client]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  // Find this wallet's issuer record (if any).
  const me: Issuer | undefined = useMemo(() => {
    if (!data || !wallet) return undefined;
    return data.issuers.find((i) => i.authority.toString() === wallet.toString());
  }, [data, wallet]);

  // Asset.issuer is the Issuer PDA — we need to derive ours.
  const [myIssuerPda, setMyIssuerPda] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!me) {
        if (!cancelled) setMyIssuerPda(null);
        return;
      }
      const { findIssuerPda } = await import("@/lib/generated/asset_registry");
      const [pda] = await findIssuerPda({
        legalEntityId: me.legalEntityId,
      });
      if (!cancelled) setMyIssuerPda(pda.toString());
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [me]);

  // Off-chain onboarding profile (company / contact / website), keyed by PDA.
  const [profile, setProfile] = useState<IssuerProfile | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileLoading, setProfileLoading] = useState(true);
  const loadProfile = useCallback(async () => {
    if (!myIssuerPda) {
      setProfile(null);
      return;
    }
    setProfile(null);
    setProfileLoading(true);
    if (!conn.wallet) return;
    try {
      setProfile(await getIssuerProfile(conn.wallet, myIssuerPda));
      setProfileError(null);
    } catch (err) {
      setProfileError(err instanceof Error ? err.message : "Company profile unavailable");
    } finally { setProfileLoading(false); }
  }, [myIssuerPda, conn.wallet]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadProfile();
  }, [loadProfile]);

  const myAssets = useMemo(() => {
    if (!data || !myIssuerPda) return [];
    return data.assets.filter((a) => a.issuer.toString() === myIssuerPda);
  }, [data, myIssuerPda]);

  if (!conn.isReady) {
    return (
      <main className="min-w-0 flex-1">
        <SkeletonCard className="max-w-md" rows={4} />
      </main>
    );
  }

  if (!wallet) {
    return (
      <main className="min-w-0 flex-1">
        <WalletRequired />
      </main>
    );
  }

  if (failed) {
    return (
      <main className="min-w-0 flex-1">
        <p className="text-sm text-red-600">Failed to load issuer state.</p>
      </main>
    );
  }

  if (data === null) {
    return (
      <main className="min-w-0 flex-1">
        <SkeletonCard rows={4} />
      </main>
    );
  }

  if (!me) {
    return (
      <main className="min-w-0 flex-1">
        <NotRegistered />
      </main>
    );
  }

  const legalId = fromBytes32(me.legalEntityId);
  const kybLabel = KYB_LABEL[me.kybStatus] ?? "Unknown";
  const verified = me.kybStatus === 1;

  return (
    <main className="min-w-0 flex-1">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-slate-500">
            Issuer
          </p>
          <h1 className="mt-1 text-2xl font-semibold text-slate-900">
            {legalId}
          </h1>
          <p className="mt-1 text-xs text-slate-500">
            Authority: <code className="font-mono">{wallet.toString().slice(0, 8)}…{wallet.toString().slice(-6)}</code>
          </p>
        </div>
        <span
          className={`shrink-0 rounded-full border px-3 py-1 text-xs font-semibold ${KYB_BADGE[me.kybStatus] ?? KYB_BADGE[0]}`}
        >
          KYB: {kybLabel}
        </span>
      </div>

      {!verified && (
        <div className="mt-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm">
          <p className="font-semibold text-amber-900">
            KYB verification pending
          </p>
          <p className="mt-1 text-xs text-amber-900/90">
            You can browse the dashboard but cannot create assets, share classes
            or open primary sales until Super Admin verifies KYB documents
            off-chain. We&apos;ll email you when status changes.
          </p>
        </div>
      )}

      {myIssuerPda && (
        <IssuerRecoveryBanner
          issuer={myIssuerPda as Address}
          issuerAuthority={me.authority}
          onChanged={refresh}
        />
      )}

      {myIssuerPda && profileLoading && <SkeletonCard className="mt-6" rows={3} />}
      {myIssuerPda && !profileLoading && profileError && (
        <div role="alert" className="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-900">
          <p>{profileError}</p>
          <button type="button" onClick={() => void loadProfile()} className="btn-brand mt-3">Try again</button>
        </div>
      )}
      {myIssuerPda && !profileLoading && !profileError && (
        <CompanyProfileCard
          issuerPda={myIssuerPda}
          profile={profile}
          session={conn.wallet}
          onSaved={loadProfile}
        />
      )}

      <section className="mt-8 grid gap-4 sm:grid-cols-3">
        <Link href="/issuer/assets" className="contents">
          <Kpi label="My assets" value={String(myAssets.length)} />
        </Link>
        <Kpi
          label="Assets registered (on-chain)"
          value={String(me.assetsCount)}
        />
        <Kpi label="Jurisdiction" value={String(me.jurisdiction)} />
      </section>

      <section className="mt-10">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-500">
          Quick actions
        </h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <ActionCard
            href="/issuer/assets"
            title="Create an asset"
            body="Tokenize a company, an instrument or a real-world asset under this issuer."
            disabled={!verified}
            disabledHint="Verify KYB to unlock"
          />
          <ActionCard
            href="/issuer/share-classes"
            title="Add share classes"
            body="Define Common, Preferred A/B, Debt, Royalty… with rights and voting weights."
            disabled={!verified}
            disabledHint="Verify KYB to unlock"
          />
          <ActionCard
            href="/issuer/launchpad"
            title="Open a sale"
            body="Run a primary sale of share-class units in USDC or SOL."
            disabled={!verified}
            disabledHint="Verify KYB to unlock"
          />
        </div>
      </section>

      <p className="mt-10 text-xs text-slate-400">
        Issuer PDA: <code className="font-mono">{myIssuerPda ?? "…"}</code>
      </p>
    </main>
  );
}

function ActionCard({
  href,
  title,
  body,
  disabled = false,
  disabledHint,
}: {
  href: string;
  title: string;
  body: string;
  disabled?: boolean;
  disabledHint?: string;
}) {
  if (disabled) {
    return (
      <div
        className="rounded-xl border border-slate-200 bg-white p-5 opacity-60 shadow-card"
        title={disabledHint}
      >
        <div className="flex items-baseline justify-between">
          <h3 className="text-base font-semibold text-slate-900">{title}</h3>
          <span className="text-[10px] uppercase tracking-wide text-amber-700">
            Locked
          </span>
        </div>
        <p className="mt-2 text-sm leading-relaxed text-slate-600">{body}</p>
        {disabledHint && (
          <p className="mt-2 text-[11px] text-amber-700">{disabledHint}</p>
        )}
      </div>
    );
  }
  return (
    <Link
      href={href}
      className="block rounded-xl border border-slate-200 bg-white p-5 shadow-card transition-colors hover:border-slate-300"
    >
      <h3 className="text-base font-semibold text-slate-900">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-slate-600">{body}</p>
    </Link>
  );
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
        {!editing && (
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


function NotRegistered() {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-widest text-slate-500">
        Issuer
      </p>
      <h1 className="mt-1 text-2xl font-semibold text-slate-900">
        Welcome — your wallet is not yet an issuer
      </h1>
      <p className="mt-2 max-w-prose text-sm text-slate-600">
        Manci issuers tokenize companies, instruments and real-world assets
        on Solana. Onboarding takes a single on-chain registration plus an
        off-chain KYB review by the Super Admin.
      </p>
      <div className="mt-6">
        <Link
          href="/issuer/onboarding"
          className="inline-flex items-center rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
        >
          Start onboarding →
        </Link>
      </div>
    </div>
  );
}
