"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import type { WalletSession } from "@solana/client";
import { useWalletConnection } from "@solana/react-hooks";
import { WalletRequired } from "@/components/wallet-required";
import { WalletButton } from "@/app/wallet-button";
import { AccountWallets } from "@/components/account-wallets";
import { AccountWalletLinkFlow } from "@/components/account-wallet-link-flow";
import { AccountFeedback, useAccountOperation } from "@/components/account-session";
import { IconArrowUpRight, IconCheck, IconLock, IconUsers, IconWallet } from "@/components/icons";
import type { AccountResponse, AccountWalletLinkAttempt } from "@/lib/account";
import { ACCOUNT_WALLET_LINK_STORAGE_KEY, restoreWalletLinkAttempt, serializeWalletLinkAttempt } from "@/lib/account-wallet-link";
import {
  cancelAccountEmail,
  openAccount,
  requestAccountEmail,
  startAccountGoogle,
  unlinkAccountGoogle,
  updateAccount,
} from "@/lib/account-client";
import { detectNetwork, networkLabel, type Network } from "@/lib/network";

const GOOGLE_RETURN_MESSAGES: Record<string, string> = {
  connected: "Returned from Google. Open your account to check the saved connection.",
  cancelled: "Google connection was cancelled. You can connect again when ready.",
  expired: "The Google connection request expired. Open your account to try again.",
  unavailable: "Google connection is currently unavailable. Your wallet account is still available.",
  failed: "Google could not be connected. Open your account to try again.",
};

function dateLabel(value: string, includeTime = false) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString("en-GB", {
    day: "numeric", month: "short", year: "numeric", timeZone: "UTC",
    ...(includeTime ? { hour: "2-digit", minute: "2-digit" } as const : {}),
  });
}

export function AccountProfile() {
  const network = detectNetwork();
  return <AccountWorkspace key={network} network={network} />;
}

function AccountWorkspace({ network }: { network: Network }) {
  const conn = useWalletConnection();
  const searchParams = useSearchParams();
  const [attempt, setAttempt] = useState<AccountWalletLinkAttempt | null>(null);
  const [restored, setRestored] = useState(false);
  const [flowMessage, setFlowMessage] = useState<string | null>(null);
  const [completion, setCompletion] = useState<{ session: WalletSession; data: AccountResponse } | null>(null);
  // Completion belongs only to the exact session that signed it. The private
  // profile itself otherwise lives entirely in the wallet-keyed child below.
  if (completion && completion.session !== conn.wallet) setCompletion(null);

  useEffect(() => {
    let saved: AccountWalletLinkAttempt | null = null;
    try {
      const raw = window.sessionStorage.getItem(ACCOUNT_WALLET_LINK_STORAGE_KEY);
      saved = restoreWalletLinkAttempt(raw, network);
      if (raw && !saved) window.sessionStorage.removeItem(ACCOUNT_WALLET_LINK_STORAGE_KEY);
    } catch { /* Storage unavailable: new linking attempts will explain the failure. */ }
    // Restore only the short-lived proof attempt, never private profile data.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAttempt(saved);
    setRestored(true);
  }, [network]);

  useEffect(() => {
    if (!attempt) return;
    const timeout = window.setTimeout(() => {
      try { window.sessionStorage.removeItem(ACCOUNT_WALLET_LINK_STORAGE_KEY); } catch { /* Best effort removal. */ }
      setAttempt(null);
      setFlowMessage("The wallet link request expired. Open your original account and start a new request.");
    }, Math.max(0, Date.parse(attempt.expires_at) - Date.now()));
    return () => window.clearTimeout(timeout);
  }, [attempt]);

  function startLink(value: AccountWalletLinkAttempt) {
    window.sessionStorage.setItem(ACCOUNT_WALLET_LINK_STORAGE_KEY, serializeWalletLinkAttempt(value, network));
    setFlowMessage(null);
    setCompletion(null);
    setAttempt(value);
  }

  function clearAttempt() {
    try { window.sessionStorage.removeItem(ACCOUNT_WALLET_LINK_STORAGE_KEY); } catch { /* Best effort removal. */ }
    setAttempt(null);
  }

  function completeLink(data: AccountResponse, session: WalletSession) {
    clearAttempt();
    setCompletion({ data, session });
    setFlowMessage("Wallet linked. Both wallets can now open this shared account.");
  }
  const googleStatus = searchParams.get("google") ?? "";
  const googleReturn = Object.hasOwn(GOOGLE_RETURN_MESSAGES, googleStatus)
    ? GOOGLE_RETURN_MESSAGES[googleStatus] : undefined;

  return (
    <div className="account-page">
      <header className="account-heading">
        <div><p className="account-eyebrow">YOUR WORKSPACE</p><h1>Your account<span>.</span></h1><p>Make it yours. Manage your profile and the ways we stay in touch.</p></div>
        <Link href="/portfolio" className="account-button account-button--secondary"><IconWallet size={16} />My portfolio<IconArrowUpRight size={15} /></Link>
      </header>
      {flowMessage && <AccountFeedback notice={{ tone: "info", text: flowMessage }} />}
      {!restored || !conn.isReady ? <p className="account-loading" role="status">Checking your wallet connection…</p> : attempt ? <AccountWalletLinkFlow attempt={attempt} network={network} onComplete={completeLink} onCancel={() => { clearAttempt(); setFlowMessage("The wallet link request has been cancelled."); }} onClose={() => { clearAttempt(); setFlowMessage("Setup closed. The outstanding link request will expire automatically; closing setup does not revoke it."); }} /> : !conn.connected || !conn.wallet ? (
        <div className="account-connect"><WalletRequired context="Connect any wallet linked to your account to manage your shared profile, contact email and Google connection." /></div>
      ) : (
        <ConnectedAccount
          key={`${network}:${conn.wallet.account.address}:${conn.wallet.connector.id}`}
          session={conn.wallet}
          network={network}
          googleReturn={googleReturn}
          initialData={completion?.session === conn.wallet ? completion.data : undefined}
          onStartLink={startLink}
        />
      )}
    </div>
  );
}

function ConnectedAccount({ session, network, googleReturn, initialData, onStartLink }: {
  session: WalletSession;
  network: Network;
  googleReturn?: string;
  initialData?: AccountResponse;
  onStartLink: (attempt: AccountWalletLinkAttempt) => void;
}) {
  const [data, setData] = useState<AccountResponse | null>(initialData ?? null);
  const [displayName, setDisplayName] = useState(initialData?.profile.display_name ?? "");
  const [email, setEmail] = useState("");
  const [copied, setCopied] = useState(false);
  const operation = useAccountOperation(session, network, data?.profile.id);
  const { pending, notice, run } = operation;
  const wallet = session.account.address.toString();
  const busy = pending !== null;
  const canSign = typeof session.signMessage === "function";

  function applyProfile(value: AccountResponse) {
    setData(value);
    setDisplayName(value.profile.display_name);
    setEmail("");
  }

  function open() {
    void run("open", openAccount, applyProfile,
      "Your account could not be opened. Please try again in a moment.");
  }

  function saveName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!data || displayName.trim() === data.profile.display_name) return;
    const name = displayName.trim();
    void run("name", (context) => updateAccount(context, name), applyProfile,
      "Your display name could not be saved. Please try again.", "Your display name has been saved.");
  }

  function sendEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!data?.features.email || !email.trim()) return;
    const nextEmail = email.trim();
    void run("email", (context) => requestAccountEmail(context, nextEmail), applyProfile,
      "We could not send the confirmation email. Check the address and try again.",
      "Confirmation email sent. Open the link and confirm with a wallet linked to this account.");
  }

  function connectGoogle() {
    if (!data?.features.google) return;
    void run("google", startAccountGoogle, ({ url }) => {
      const destination = new URL(url);
      if (destination.protocol !== "https:" || destination.hostname !== "accounts.google.com") {
        throw new Error("Google connection is unavailable");
      }
      window.location.assign(destination.href);
    }, "Google connection could not be started. Please try again later.");
  }

  async function copyWallet() {
    try {
      await navigator.clipboard.writeText(wallet);
      setCopied(true);
    } catch {
      // The complete address remains selectable when clipboard access is unavailable.
      setCopied(false);
    }
  }

  if (!data) {
    return (
      <>
        {googleReturn && <AccountFeedback notice={{ tone: "info", text: googleReturn }} />}
        <div className="account-unlock-grid">
          <section className="account-card account-unlock" aria-labelledby="account-open-heading">
            <span className="account-feature-icon"><IconLock size={23} /></span>
            <p className="account-eyebrow">PRIVATE TO YOUR WALLET</p>
            <h2 id="account-open-heading">A little more personal.</h2>
            <p>Your profile is private. Approve a message in any linked wallet to open it. An unlinked wallet starts a separate account.</p>
            <div className="account-wallet-preview"><span>Connected wallet · {networkLabel(network)}</span><code>{wallet}</code></div>
            <AccountFeedback notice={notice} />
            {!canSign && <p className="account-unavailable">This wallet does not support message signing. Connect a wallet that does to continue.</p>}
            <button type="button" className="account-button account-button--primary" onClick={open} disabled={busy || !canSign}>{busy ? "Waiting for wallet…" : "Open your account"}<IconArrowUpRight size={16} /></button>
            <span className="account-fineprint">A message signature. No transaction or network fee.</span>
          </section>
          <aside className="account-intro" aria-label="What you can manage">
            <p className="account-eyebrow">ONE PLACE FOR YOUR DETAILS</p>
            <h2>Your wallets.<br />One profile.</h2>
            <ul>
              <li><span>01</span><div><strong>A name that feels like you</strong><p>Add an optional display name to your account.</p></div></li>
              <li><span>02</span><div><strong>A verified contact email</strong><p>Choose an email address and confirm it from your inbox.</p></div></li>
              <li><span>03</span><div><strong>Your wallets and connections</strong><p>Link wallets and Google to one profile. A linked wallet is always required to access your account.</p></div></li>
            </ul>
          </aside>
        </div>
      </>
    );
  }

  const { profile, features } = data;
  const nameChanged = displayName.trim() !== profile.display_name;

  return (
    <>
      <section className="account-identity" aria-label="Account identity">
        <span className="account-avatar" aria-hidden="true">{profile.display_name ? profile.display_name.slice(0, 1).toUpperCase() : <IconUsers size={24} />}</span>
        <div className="account-identity-details"><h2>{profile.display_name || "Your wallet account"}</h2><div><code>{wallet}</code><button type="button" onClick={() => void copyWallet()} className="account-text-button" aria-label="Copy wallet address">{copied ? "Copied" : "Copy"}</button></div></div>
        <span className="account-badge"><span />{networkLabel(network)}</span>
      </section>
      {profile.wallet !== profile.primary_wallet && <section className="account-primary-notice" aria-label="Primary transaction wallet"><div><strong>Connect your primary wallet to transact.</strong><p>You can manage this profile with your connected wallet. Transactions require the primary wallet below.</p><code>{profile.primary_wallet}</code></div><details><summary>Switch wallet</summary><p>Disconnect, select your primary account in the wallet extension, then reconnect.</p><WalletButton /></details></section>}
      <AccountFeedback notice={notice} />
      {busy && <p className="account-operation-status" role="status">Approve the message in your wallet, then wait for confirmation.</p>}
      <div className="account-grid" aria-busy={busy}>
        <div className="account-main-column">
          <AccountWallets data={data} operation={operation} onProfile={applyProfile} onStartLink={onStartLink} />
          <section className="account-card" aria-labelledby="account-profile-heading">
            <div className="account-card-heading"><div><p className="account-eyebrow">THE BASICS</p><h2 id="account-profile-heading">Profile details</h2></div><IconUsers size={21} /></div>
            <form onSubmit={saveName} className="account-form">
              <label htmlFor="account-display-name">Display name <span>Optional</span></label>
              <input id="account-display-name" autoComplete="nickname" maxLength={100} value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="What should we call you?" disabled={busy} aria-describedby="account-name-help" />
              <p id="account-name-help" className="account-field-help">This is your account name. It does not change your wallet or verified identity details.</p>
              <div className="account-form-actions"><button className="account-button account-button--primary" disabled={busy || !nameChanged}>{pending === "name" ? "Saving…" : "Save name"}</button>{nameChanged && <button type="button" className="account-text-button" onClick={() => setDisplayName(profile.display_name)} disabled={busy}>Discard changes</button>}</div>
            </form>
          </section>

          <section className="account-card" aria-labelledby="account-email-heading">
            <div className="account-card-heading"><div><p className="account-eyebrow">STAY IN TOUCH</p><h2 id="account-email-heading">Contact email</h2></div><span className={`account-status ${profile.email_verified_at ? "account-status--verified" : ""}`}>{profile.email_verified_at ? <><IconCheck size={13} />Verified</> : "Not added"}</span></div>
            <p className="account-card-description">Choose the address we can contact you on. This is separate from your Google connection.</p>
            {profile.email && <div className="account-saved-email"><strong>{profile.email}</strong><span>{profile.email_verified_at ? `Verified${dateLabel(profile.email_verified_at) ? ` · ${dateLabel(profile.email_verified_at)}` : ""}` : "Awaiting verification"}</span></div>}
            {profile.pending_email && <div className="account-pending-email"><span className="account-status">Awaiting confirmation</span><strong>{profile.pending_email}</strong><p>Open the confirmation link sent to this address, then approve it with any wallet linked to this account.{profile.email_verified_at ? " Your current verified email stays active until then." : ""}</p>{profile.pending_email_expires_at && dateLabel(profile.pending_email_expires_at) && <p>Link expires {dateLabel(profile.pending_email_expires_at, true)} (UTC). A new link replaces the previous one.</p>}<div className="account-pending-actions"><button type="button" className="account-text-button" disabled={busy || !features.email} onClick={() => void run("resend", (context) => requestAccountEmail(context, profile.pending_email!), applyProfile, "We could not resend the email. Please wait a moment and try again.", "A new confirmation email has been sent. Use the latest link.")}>{pending === "resend" ? "Sending…" : "Resend email"}</button><button type="button" className="account-text-button account-text-button--muted" disabled={busy} onClick={() => void run("cancel-email", cancelAccountEmail, applyProfile, "The email change could not be cancelled. Please try again.", "The pending email change has been cancelled.")}>Cancel change</button></div></div>}
            {!features.email && <p className="account-unavailable">Email verification is not available on this deployment yet. You can add or change your contact email once it is enabled.</p>}
            <form onSubmit={sendEmail} className="account-form">
              <label htmlFor="account-contact-email">{profile.email || profile.pending_email ? "New contact email" : "Email address"}</label>
              <input id="account-contact-email" type="email" autoComplete="email" inputMode="email" maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" required disabled={busy || !features.email} aria-describedby="account-email-help" />
              <p id="account-email-help" className="account-field-help">{profile.email_verified_at ? "Your current address stays verified until you confirm a replacement." : "We will send a link to verify that this address belongs to you."}</p>
              <div className="account-form-actions"><button className="account-button account-button--primary" disabled={busy || !features.email || !email.trim() || email.trim().toLowerCase() === profile.email?.toLowerCase()}>{pending === "email" ? "Sending…" : "Send confirmation email"}</button></div>
            </form>
          </section>
        </div>

        <aside className="account-side-column" aria-label="Connections and portfolio">
          <section className="account-card" aria-labelledby="account-google-heading">
            <div className="account-card-heading"><span className="account-google-mark" aria-hidden="true">G</span><span className={`account-status ${profile.google_linked_at ? "account-status--verified" : ""}`}>{profile.google_linked_at ? "Connected" : "Not connected"}</span></div>
            <h2 id="account-google-heading">Google account</h2>
            <p className="account-card-description">Link Google to your shared profile. A linked wallet remains required to access your account.</p>
            {profile.google_email && <div className="account-saved-email"><strong>{profile.google_email}</strong>{profile.google_linked_at && dateLabel(profile.google_linked_at) && <span>Connected {dateLabel(profile.google_linked_at)}</span>}</div>}
            {profile.google_linked_at ? <button type="button" className="account-button account-button--secondary account-button--full" disabled={busy} onClick={() => void run("unlink-google", unlinkAccountGoogle, applyProfile, "Google could not be disconnected. Please try again.", "Google has been disconnected. Your contact email is unchanged.")}>{pending === "unlink-google" ? "Disconnecting…" : "Disconnect Google"}</button> : <><button type="button" className="account-button account-button--secondary account-button--full" disabled={busy || !features.google} onClick={connectGoogle}>{pending === "google" ? "Opening Google…" : "Connect Google"}<IconArrowUpRight size={15} /></button>{!features.google && <p className="account-unavailable">Google connection is not available on this deployment yet.</p>}</>}
            <p className="account-fineprint account-google-note">Google linking does not change your contact email or provide wallet recovery.</p>
          </section>
          <section className="account-portfolio-card"><span className="account-feature-icon"><IconWallet size={21} /></span><p className="account-eyebrow">YOUR NEXT MOVE</p><h2>Everything you own.<br />One place.</h2><p>Review your holdings, income and pending actions in your portfolio.</p><Link href="/portfolio" className="account-button account-button--primary account-button--full">Open portfolio<IconArrowUpRight size={16} /></Link></section>
          <p className="account-signature-note"><IconLock size={15} />Saving account changes asks for a wallet message signature. No transaction fee.</p>
        </aside>
      </div>
    </>
  );
}
