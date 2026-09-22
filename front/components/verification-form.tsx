"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useWalletConnection } from "@solana/react-hooks";
import { WalletRequired } from "@/components/wallet-required";
import { VERIFICATION_LABEL } from "@/components/account-verification";
import { IconArrowUpRight, IconBuilding, IconCheck, IconShield, IconUsers } from "@/components/icons";
import type { AccountResponse, AccountWalletKycStatus } from "@/lib/account";
import { COUNTRIES } from "@/lib/countries";
import { getMyOnboardingPath } from "@/lib/clients";
import { isDefaultApprovedJurisdiction } from "@/lib/passport";
import { signedFetch } from "@/lib/siws-client";
import { accountFetch, useSignedInAccount } from "@/lib/account-login";

type Kind = "kyc" | "kyb";
type Fields = Record<string, string>;

const APPROVED = COUNTRIES.filter((c) => isDefaultApprovedJurisdiction(Number.parseInt(c.code, 10)));
const EMPTY: Fields = {
  legal_name: "", date_of_birth: "", nationality: "", residence_country: "", address_line: "", city: "",
  postal_code: "", phone: "", email: "", company_name: "", company_reg_number: "", company_country: "",
  company_address: "", company_website: "", representative_role: "",
};
const SAFE_NEXT = /^\/(apply|portfolio|account|marketplace)(\/[A-Za-z0-9/_-]*)?$/;

function Field({ id, label, hint, wide, children }: { id: string; label: string; hint?: string; wide?: boolean; children: React.ReactNode }) {
  return <div className={`verify-field${wide ? " verify-wide" : ""}`}><label htmlFor={id}>{label}{hint && <span>{hint}</span>}</label>{children}</div>;
}

export function VerificationForm() {
  const conn = useWalletConnection();
  const router = useRouter();
  const search = useSearchParams();
  const next = search.get("next");
  const safeNext = next && SAFE_NEXT.test(next) ? next : null;
  const [kind, setKind] = useState<Kind>(search.get("type") === "kyb" ? "kyb" : "kyc");
  const [fields, setFields] = useState<Fields>(EMPTY);
  const [consent, setConsent] = useState(false);
  const [status, setStatus] = useState<{ kyc: AccountWalletKycStatus; kyb: AccountWalletKycStatus } | null>(null);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ path: string | null; notice: string | null } | null>(null);
  const signedIn = useSignedInAccount();
  // Signed in by email/Google: the account verifies itself, no wallet needed.
  const accountMode = signedIn.status === "signed_in";
  const session = conn.wallet;
  const wallet = session?.account.address.toString();
  const actorKey = accountMode ? `account:${signedIn.account?.id}` : wallet ?? null;
  const actorFetch = <T,>(path: string, action: string, params: Record<string, unknown> = {}): Promise<T> =>
    accountMode ? accountFetch<T>(path, action, params) : signedFetch<T>(session, path, action, params);

  useEffect(() => {
    if (!actorKey) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    void actorFetch<AccountResponse>("/api/account/me", "account.me").then((data) => {
      if (cancelled) return;
      if (data.verification) setStatus({ kyc: data.verification.kyc, kyb: data.verification.kyb });
      if (data.profile.email) setFields((f) => (f.email ? f : { ...f, email: data.profile.email! }));
    }).catch(() => { if (!cancelled) setStatus(null); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actorKey]);

  const current = status?.[kind] ?? "none";
  const inProgress = current === "pending" || current === "more_info";
  const showForm = !done && (current === "none" || current === "expired" || editing);
  const set = (key: string) => (event: { target: { value: string } }) => setFields((f) => ({ ...f, [key]: event.target.value }));
  const maxDob = useMemo(() => { const d = new Date(); d.setFullYear(d.getFullYear() - 18); return d.toISOString().slice(0, 10); }, []);

  async function openDocuments() {
    if (!actorKey) return;
    setError(null);
    try {
      const result = accountMode
        ? await accountFetch<{ onboarding_path: string | null; onboarding_notice?: string | null }>("/api/clients/me", "clients.me")
          .then((d) => ({ path: d.onboarding_path ?? null, notice: d.onboarding_notice ?? null }))
        : await getMyOnboardingPath(session);
      if (result.path) router.push(result.path);
      else setError(result.notice ?? "No documents are waiting for upload. We will contact you if anything else is needed.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not open the document upload. Please try again.");
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!actorKey || !consent) return;
    setSubmitting(true);
    setError(null);
    const keys = kind === "kyc"
      ? ["legal_name", "date_of_birth", "nationality", "residence_country", "address_line", "city", "postal_code", "phone", "email"]
      : ["legal_name", "residence_country", "address_line", "city", "postal_code", "phone", "email", "company_name", "company_reg_number", "company_country", "company_address", "company_website", "representative_role"];
    const params: Record<string, unknown> = { kind };
    for (const key of keys) {
      const value = fields[key].trim();
      if (!value) continue;
      params[key] = ["nationality", "residence_country", "company_country"].includes(key) ? Number.parseInt(value, 10) : value;
    }
    try {
      const data = await actorFetch<{ onboarding_path: string | null; onboarding_notice: string | null }>(
        "/api/verification/submit", "verification.submit", params);
      setDone({ path: data.onboarding_path, notice: data.onboarding_notice });
      setStatus((s) => ({ kyc: s?.kyc ?? "none", kyb: s?.kyb ?? "none", [kind]: "more_info" }));
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Your details could not be submitted. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return <div className="account-page verify-page">
    <header className="account-heading">
      <div><p className="account-eyebrow">TRUST &amp; COMPLIANCE</p><h1>Get verified<span>.</span></h1><p>Buying and trading tokens does not require verification. You need it to convert tokens into company shares, take delivery of physical goods, buy or receive KYC-gated classes, raise capital or issue assets. It takes a few minutes.</p></div>
    </header>
    {!conn.isReady ? <p className="account-loading" role="status">Checking your wallet connection…</p>
      : signedIn.status === "loading" ? <p className="account-loading" role="status">Checking your sign-in…</p>
      : !actorKey ? <div className="account-connect">
          <section className="account-card account-unlock">
            <h2>Sign in to get verified.</h2>
            <p>Use your email or Google — no wallet needed. Your verification will cover every wallet you add later.</p>
            <Link href="/login?next=/verify" className="account-button account-button--primary">Sign in<IconArrowUpRight size={16} /></Link>
          </section>
          <WalletRequired context="Or connect a wallet that is linked to your account." />
        </div>
      : <section className="account-card">
        <div className="verify-kinds" role="group" aria-label="What do you want to verify?">
          {(["kyc", "kyb"] as const).map((k) => <button key={k} type="button" className="verify-kind" aria-pressed={kind === k} onClick={() => { setKind(k); setDone(null); setError(null); setEditing(false); }}>
            {k === "kyc" ? <IconUsers size={20} /> : <IconBuilding size={20} />}
            <strong>{k === "kyc" ? "Individual (KYC)" : "Company (KYB)"}</strong>
            <span>{k === "kyc" ? "Verify yourself to convert tokens into shares or take delivery." : "Verify your company to raise capital or issue assets."}</span>
            {status && <span className={`account-status ${status[k] === "verified" ? "account-status--verified" : ""}`} style={{ marginTop: 10 }}>{VERIFICATION_LABEL[status[k]]}</span>}
          </button>)}
        </div>

        {error && <p className="account-notice account-notice--error" role="alert">{error}</p>}
        {loading && <p className="account-loading" role="status">Loading your verification status…</p>}

        {done && <div className="account-notice account-notice--success" role="status">
          <strong>Details received.</strong> Next, start the verification: accept the terms and upload the requested documents so our compliance team can review your {kind === "kyc" ? "identity" : "company"}.
          <div className="account-form-actions" style={{ marginTop: 12 }}>
            {done.path ? <Link href={done.path} className="account-button account-button--primary">Start verification<IconArrowUpRight size={15} /></Link> : <span>{done.notice}</span>}
            {safeNext && <Link href={safeNext} className="account-text-button">Back to where you were</Link>}
          </div>
        </div>}

        {!loading && !done && current === "verified" && <div className="account-notice account-notice--success"><IconCheck size={14} /> {kind === "kyc" ? "Your identity is verified." : "Your company is verified."} {safeNext && <Link href={safeNext} className="account-text-button">Continue</Link>}</div>}
        {!loading && !done && (current === "suspended" || current === "rejected") && <div className="account-notice account-notice--error">Your verification is {current}. Please contact the compliance team.</div>}
        {!loading && !done && inProgress && !editing && <div className="account-notice account-notice--info">
          {current === "more_info" ? "We are waiting for your documents." : "Your submission is being reviewed."}
          <div className="account-form-actions" style={{ marginTop: 12 }}>
            <button type="button" className="account-button account-button--primary" onClick={() => void openDocuments()}>Continue verification<IconArrowUpRight size={15} /></button>
            <button type="button" className="account-text-button" onClick={() => setEditing(true)}>Update my details</button>
          </div>
        </div>}

        {!loading && showForm && <form className="account-form" onSubmit={(e) => void submit(e)}>
          {kind === "kyb" && <>
            <p className="verify-section-title">COMPANY</p>
            <div className="verify-grid">
              <Field id="v-company" label="Registered company name" wide><input id="v-company" value={fields.company_name} onChange={set("company_name")} required maxLength={200} autoComplete="organization" /></Field>
              <Field id="v-reg" label="Registration number"><input id="v-reg" value={fields.company_reg_number} onChange={set("company_reg_number")} required maxLength={64} /></Field>
              <Field id="v-ccountry" label="Country of incorporation"><select id="v-ccountry" value={fields.company_country} onChange={set("company_country")} required><option value="">Select…</option>{APPROVED.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</select></Field>
              <Field id="v-caddr" label="Registered address" wide><input id="v-caddr" value={fields.company_address} onChange={set("company_address")} required maxLength={300} /></Field>
              <Field id="v-web" label="Website" hint="Optional"><input id="v-web" value={fields.company_website} onChange={set("company_website")} placeholder="https://" maxLength={300} inputMode="url" /></Field>
              <Field id="v-role" label="Your role in the company"><input id="v-role" value={fields.representative_role} onChange={set("representative_role")} required maxLength={120} placeholder="Director, CEO…" /></Field>
            </div>
          </>}
          <p className="verify-section-title">{kind === "kyc" ? "ABOUT YOU" : "COMPANY REPRESENTATIVE"}</p>
          <div className="verify-grid">
            <Field id="v-name" label="Full legal name" hint="As in your passport" wide><input id="v-name" value={fields.legal_name} onChange={set("legal_name")} required maxLength={200} autoComplete="name" /></Field>
            {kind === "kyc" && <>
              <Field id="v-dob" label="Date of birth"><input id="v-dob" type="date" value={fields.date_of_birth} onChange={set("date_of_birth")} required max={maxDob} min="1900-01-01" /></Field>
              <Field id="v-nat" label="Nationality"><select id="v-nat" value={fields.nationality} onChange={set("nationality")} required><option value="">Select…</option>{COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</select></Field>
            </>}
            <Field id="v-res" label="Country of residence"><select id="v-res" value={fields.residence_country} onChange={set("residence_country")} required><option value="">Select…</option>{(kind === "kyc" ? APPROVED : COUNTRIES).map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</select></Field>
            <Field id="v-city" label="City"><input id="v-city" value={fields.city} onChange={set("city")} required maxLength={120} autoComplete="address-level2" /></Field>
            <Field id="v-addr" label="Residential address" wide><input id="v-addr" value={fields.address_line} onChange={set("address_line")} required maxLength={300} autoComplete="street-address" /></Field>
            <Field id="v-zip" label="Postal code"><input id="v-zip" value={fields.postal_code} onChange={set("postal_code")} required maxLength={20} autoComplete="postal-code" /></Field>
            <Field id="v-phone" label="Phone" hint="Optional"><input id="v-phone" type="tel" value={fields.phone} onChange={set("phone")} maxLength={32} autoComplete="tel" placeholder="+381…" /></Field>
            <Field id="v-email" label="Email" wide><input id="v-email" type="email" value={fields.email} onChange={set("email")} required maxLength={254} autoComplete="email" /></Field>
          </div>
          <p className="account-field-help" style={{ marginTop: 14 }}>
            {kind === "kyc" ? "Next you will upload your passport, a proof of address and a selfie." : "Next you will upload the registry extract, the ownership structure, your ID and the company's proof of address."}
            {kind === "kyc" && " Only countries we currently support are listed for residence."}
          </p>
          <label className="verify-consent"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} required /> I confirm these details are accurate and agree that Manci processes them to verify {kind === "kyc" ? "my identity" : "my company"}, as described in the <Link href="/legal/privacy" className="account-text-button">privacy policy</Link>.</label>
          <div className="account-form-actions" style={{ marginTop: 18 }}>
            <button className="account-button account-button--primary" disabled={submitting || !consent}>{submitting ? "Submitting…" : "Submit and continue"}<IconShield size={15} /></button>
            {editing && <button type="button" className="account-text-button" onClick={() => setEditing(false)}>Cancel</button>}
          </div>
          {!accountMode && <p className="account-field-help">Your wallet will ask you to approve this submission.</p>}
        </form>}
      </section>}
  </div>;
}
