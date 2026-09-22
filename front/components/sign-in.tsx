"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { WalletButton } from "@/app/wallet-button";
import { IconArrowUpRight, IconCheck } from "@/components/icons";
import { completeEmailSignIn, startEmailSignIn, startGoogleSignIn, useSignedInAccount } from "@/lib/account-login";

const SAFE_NEXT = /^\/(account|verify|apply|portfolio|marketplace)(\/[A-Za-z0-9/_-]*)?(\?[A-Za-z0-9=&_/-]*)?$/;

function safeNext(value: string | null) {
  return value && SAFE_NEXT.test(value) ? value : "/account";
}

export function SignIn() {
  const router = useRouter();
  const search = useSearchParams();
  const next = safeNext(search.get("next"));
  const signedIn = useSignedInAccount();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  const [busy, setBusy] = useState<"email" | "google" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (signedIn.status === "signed_in") router.replace(next);
  }, [signedIn.status, next, router]);

  async function sendLink(event: FormEvent) {
    event.preventDefault();
    setBusy("email");
    setError(null);
    try {
      try { window.sessionStorage.setItem("manci:login-next", next); } catch { /* optional */ }
      await startEmailSignIn(email.trim());
      setSent(email.trim());
    } catch (e) {
      setError(e instanceof Error ? e.message : "We could not send the sign-in email. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  async function google() {
    setBusy("google");
    setError(null);
    try {
      try { window.sessionStorage.setItem("manci:login-next", next); } catch { /* optional */ }
      await startGoogleSignIn("login");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Google sign-in is unavailable right now.");
      setBusy(null);
    }
  }

  return <div className="account-page verify-page">
    <header className="account-heading">
      <div><p className="account-eyebrow">WELCOME</p><h1>Sign in<span>.</span></h1><p>Create your account or sign in with email or Google. No wallet needed to get started — add wallets whenever you are ready.</p></div>
    </header>
    <section className="account-card">
      {error && <p className="account-notice account-notice--error" role="alert">{error}</p>}
      {sent ? (
        <div className="account-notice account-notice--success" role="status">
          <IconCheck size={14} /> <strong>Check your inbox.</strong> We sent a sign-in link to <strong>{sent}</strong>. It works once and expires in 20 minutes.
          <div className="account-form-actions" style={{ marginTop: 10 }}>
            <button type="button" className="account-text-button" onClick={() => setSent(null)}>Use a different email</button>
          </div>
        </div>
      ) : (
        <form className="account-form" onSubmit={(e) => void sendLink(e)}>
          <label htmlFor="login-email">Email</label>
          <input id="login-email" type="email" autoComplete="email" inputMode="email" required maxLength={254}
            value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" disabled={busy !== null} />
          <div className="account-form-actions" style={{ marginTop: 14 }}>
            <button className="account-button account-button--primary" disabled={busy !== null || !email.trim()}>
              {busy === "email" ? "Sending…" : "Email me a sign-in link"}<IconArrowUpRight size={15} />
            </button>
          </div>
        </form>
      )}
      <div className="sign-in-divider"><span>or</span></div>
      <button type="button" className="account-button account-button--secondary account-button--full" onClick={() => void google()} disabled={busy !== null}>
        <span className="account-google-mark" aria-hidden="true">G</span>{busy === "google" ? "Opening Google…" : "Continue with Google"}
      </button>
      <div className="sign-in-divider"><span>or use a wallet</span></div>
      <WalletButton />
      <p className="account-field-help" style={{ marginTop: 16 }}>
        By continuing you agree to the <Link href="/legal/terms" className="account-text-button">Terms of Service</Link> and the <Link href="/legal/privacy" className="account-text-button">Privacy Policy</Link>.
      </p>
    </section>
  </div>;
}

export function EmailSignInLanding() {
  const router = useRouter();
  const search = useSearchParams();
  const token = search.get("token");
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (!token) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setError("This sign-in link is incomplete. Request a new one.");
      return;
    }
    // Drop the one-time token from the address bar and history.
    window.history.replaceState(null, "", "/login/email");
    let next = "/account";
    try { next = safeNext(window.sessionStorage.getItem("manci:login-next")); window.sessionStorage.removeItem("manci:login-next"); } catch { /* optional */ }
    completeEmailSignIn(token).then(() => router.replace(next))
      .catch((e) => setError(e instanceof Error ? e.message : "This sign-in link is invalid or expired."));
  }, [token, router]);

  return <div className="account-page verify-page">
    <section className="account-card account-unlock">
      {error ? <>
        <h2>We could not sign you in.</h2>
        <p className="account-notice account-notice--error" role="alert">{error}</p>
        <Link href="/login" className="account-button account-button--primary">Request a new link<IconArrowUpRight size={15} /></Link>
      </> : <p className="account-loading" role="status">Signing you in…</p>}
    </section>
  </div>;
}
