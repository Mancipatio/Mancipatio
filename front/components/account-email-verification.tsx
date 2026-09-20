"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import type { WalletSession } from "@solana/client";
import { useWalletConnection } from "@solana/react-hooks";
import { WalletRequired } from "@/components/wallet-required";
import { AccountFeedback, useAccountOperation } from "@/components/account-session";
import { IconArrowUpRight, IconCheck, IconLock } from "@/components/icons";
import { verifyAccountEmail } from "@/lib/account-client";
import { detectNetwork, networkLabel, type Network } from "@/lib/network";

export function AccountEmailVerification() {
  const conn = useWalletConnection();
  const searchParams = useSearchParams();
  // The token is used only by the explicit signed operation, never rendered.
  const token = searchParams.getAll("token").length === 1 ? searchParams.get("token") : null;
  const validToken = token !== null && /^[A-Za-z0-9_-]{43}$/.test(token);
  const network = detectNetwork();

  return <div className="account-page account-verify-page">
    <header className="account-heading"><div><p className="account-eyebrow">YOUR ACCOUNT</p><h1>Confirm your email<span>.</span></h1><p>One final step to verify your contact address.</p></div></header>
    {!conn.isReady ? <p className="account-loading" role="status">Checking your wallet connection…</p> : !conn.connected || !conn.wallet ? validToken ? <WalletRequired context="Connect the same wallet you used to request this email change. Opening the link does not confirm your email automatically." /> : <MissingConfirmationLink /> : <EmailConfirmation key={`${network}:${conn.wallet.account.address}:${conn.wallet.connector.id}`} session={conn.wallet} network={network} token={validToken ? token : null} />}
  </div>;
}

function MissingConfirmationLink() {
  return <section className="account-card account-unlock"><span className="account-feature-icon"><IconLock size={23} /></span><h2>A confirmation link is needed.</h2><p>Open the full link from your confirmation email. If it has expired, request a new email from your account.</p><Link href="/account" className="account-button account-button--primary">Go to your account<IconArrowUpRight size={16} /></Link></section>;
}

function EmailConfirmation({ session, network, token }: { session: WalletSession; network: Network; token: string | null }) {
  const [confirmed, setConfirmed] = useState<{ email: string; token: string } | null>(null);
  const { pending, notice, run } = useAccountOperation(session, network);
  const canSign = typeof session.signMessage === "function";

  function confirm() {
    if (!token) return;
    void run("verify", (context) => verifyAccountEmail(context, token), (response) => {
      if (!response.profile.email || !response.profile.email_verified_at) throw new Error("Email confirmation is incomplete");
      setConfirmed({ email: response.profile.email, token });
      // Remove the one-time token from this history entry after confirmation.
      // replaceState does not load a URL or perform any account mutation.
      window.history.replaceState(window.history.state, "", "/account/verify");
    }, "This link could not be confirmed. Check that you connected the wallet that requested it, or request a new link from your account.");
  }

  if (confirmed && (!token || token === confirmed.token)) return <section className="account-card account-unlock"><span className="account-feature-icon"><IconCheck size={26} /></span><p className="account-eyebrow">ALL SET</p><h2>Your email is verified.</h2><p className="account-confirmed-address">{confirmed.email}</p><p>This address is now saved as the contact email for your wallet profile.</p><Link href="/account" className="account-button account-button--primary">Back to your account<IconArrowUpRight size={16} /></Link></section>;
  if (!token) return <MissingConfirmationLink />;

  return <section className="account-card account-unlock">
    <span className="account-feature-icon"><IconLock size={23} /></span>
    <h2>Confirm with your wallet.</h2><p>Use the same wallet that requested this change. Approve a message to verify the email address from this link.</p>
    <div className="account-wallet-preview"><span>Connected wallet · {networkLabel(network)}</span><code>{session.account.address.toString()}</code></div>
    <AccountFeedback notice={notice} />
    {!canSign && <p className="account-unavailable">This wallet cannot sign messages. Connect a wallet that supports message signing.</p>}
    <button type="button" className="account-button account-button--primary" onClick={confirm} disabled={!!pending || !canSign}>{pending ? "Confirming…" : "Confirm email"}<IconCheck size={16} /></button>
    <p className="account-fineprint">No transaction or network fee. The change happens only after you confirm.</p>
    <Link href="/account" className="account-text-button">Back to your account</Link>
  </section>;
}
