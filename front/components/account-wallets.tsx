"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { isAddress } from "@solana/kit";
import type { AccountResponse, AccountWalletKycStatus, AccountWalletLinkAttempt } from "@/lib/account";
import type { WalletSession } from "@solana/client";
import { attachWalletToAccount, removeAccountWallet, setAccountPrimaryWallet, startAccountWalletLink } from "@/lib/account-client";
import { WalletButton } from "@/app/wallet-button";
import { useAccountOperation } from "@/components/account-session";
import { IconArrowUpRight, IconCheck, IconWallet } from "@/components/icons";

type Props = {
  data: AccountResponse;
  operation: ReturnType<typeof useAccountOperation>;
  onProfile: (value: AccountResponse) => void;
  onStartLink: (attempt: AccountWalletLinkAttempt) => void;
  /** "account" = signed in by email/Google (no acting wallet). */
  mode?: "wallet" | "account";
  /** The wallet connected in the browser (account mode: can be added). */
  connectedSession?: WalletSession | null;
};

const KYC_LABEL: Record<AccountWalletKycStatus, string> = {
  none: "No KYC", pending: "KYC in review", more_info: "KYC needs documents", verified: "KYC verified",
  expired: "KYC expired", suspended: "KYC suspended", rejected: "KYC rejected",
};

export function AccountWallets({ data, operation, onProfile, onStartLink, mode = "wallet", connectedSession = null }: Props) {
  const accountMode = mode === "account";
  const [adding, setAdding] = useState(false);
  const [targetWallet, setTargetWallet] = useState("");
  const [removeWallet, setRemoveWallet] = useState<string | null>(null);
  const [primaryWarning, setPrimaryWarning] = useState<string | null>(null);
  const { profile } = data;
  const kycOf = (wallet: string): AccountWalletKycStatus | null =>
    data.kyc?.find((entry) => entry.wallet === wallet)?.status ?? null;
  const verifiedWallets = profile.wallets.filter(({ wallet }) => kycOf(wallet) === "verified").map(({ wallet }) => wallet);
  const primaryKyc = kycOf(profile.primary_wallet);
  function setPrimary(wallet: string) {
    setPrimaryWarning(null);
    void run("primary-wallet", (context) => setAccountPrimaryWallet(context, wallet), onProfile,
      "The primary wallet could not be changed. Open your account again and try again.", "Primary wallet saved. Connect that wallet when you want to transact.");
  }
  const { pending, run } = operation;
  const busy = pending !== null;
  const target = targetWallet.trim();
  const validTarget = isAddress(target) && !profile.wallets.some((entry) => entry.wallet === target);

  function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!validTarget || profile.wallets.length >= 10) return;
    void run("link-wallet", (context) => startAccountWalletLink(context, target), onStartLink,
      "The link request could not be started. Check the address and try again. A wallet with an existing populated account cannot be linked.");
  }

  return <section className="account-card" aria-labelledby="account-wallets-heading">
    <div className="account-card-heading"><div><p className="account-eyebrow">ONE ACCOUNT, YOUR WALLETS</p><h2 id="account-wallets-heading">Linked wallets <span className="account-wallet-count">{profile.wallets.length} / 10</span></h2></div><IconWallet size={21} /></div>
    <p className="account-card-description">{accountMode ? "Add as many wallets as you like. Your verification covers all of them; assets and balances stay with each wallet." : "Any linked wallet can open and edit this shared profile. Your assets and balances stay with each wallet."}</p>
    <div className="account-wallet-list">
      {profile.wallets.map(({ wallet }) => {
        const connected = wallet === profile.wallet;
        const primary = wallet === profile.primary_wallet;
        const canRemove = accountMode ? (!primary || profile.wallets.length === 1) : !connected && !primary && profile.wallets.length > 1;
        return <div className="account-wallet-row" key={wallet}>
          <div className="account-wallet-row-labels">{primary && <span className="account-status account-status--verified"><IconCheck size={12} />Primary for transactions</span>}{connected && <span className="account-status">Connected</span>}{kycOf(wallet) && <span className={`account-status${kycOf(wallet) === "verified" ? " account-status--verified" : ""}`}>{KYC_LABEL[kycOf(wallet)!]}</span>}</div>
          <code>{wallet}</code>
          <div className="account-wallet-row-actions">
            {!primary && <button type="button" className="account-text-button" disabled={busy} onClick={() => {
              // KYC passports are per wallet: warn before a verified wallet stops being the transaction wallet.
              if (kycOf(wallet) !== "verified" && verifiedWallets.length > 0) setPrimaryWarning(wallet);
              else setPrimary(wallet);
            }}>Set as primary</button>}
            <button type="button" className="account-text-button account-text-button--muted" disabled={busy || !canRemove} onClick={() => setRemoveWallet(wallet)} title={connected ? "The connected wallet cannot be removed." : primary ? "Choose another primary wallet before removing this one." : undefined}>Remove</button>
          </div>
          {primaryWarning === wallet && <div className="account-wallet-confirm" role="group" aria-label="Confirm primary wallet change"><p>This wallet has not completed KYC itself. The investor passport is issued per wallet, so KYC-gated classes will be refused to this wallet until it has its own passport. Conversions and deliveries use your account&apos;s identity verification, and buying and trading other tokens does not need KYC.</p><div className="account-wallet-row-actions"><button type="button" className="account-button account-button--secondary" disabled={busy} onClick={() => setPrimary(wallet)}>Make primary anyway</button><button type="button" className="account-text-button" disabled={busy} onClick={() => setPrimaryWarning(null)}>Keep current primary</button></div></div>}
          {removeWallet === wallet && canRemove && <div className="account-wallet-confirm" role="group" aria-label="Confirm wallet removal"><p>This wallet will lose access to your shared profile. Its assets{kycOf(wallet) === "verified" ? " and its KYC passport" : ""} stay in the wallet.</p><div className="account-wallet-row-actions"><button type="button" className="account-button account-button--secondary" disabled={busy} onClick={() => void run("remove-wallet", (context) => removeAccountWallet(context, wallet), (value) => { setRemoveWallet(null); onProfile(value); }, "The wallet could not be removed. Open your account again and try again.", "The wallet has been removed from this account.")}>Confirm removal</button><button type="button" className="account-text-button" disabled={busy} onClick={() => setRemoveWallet(null)}>Keep wallet</button></div></div>}
        </div>;
      })}
    </div>
    <p className="account-field-help">Your primary wallet signs transactions. Selecting it here does not switch the account in your wallet extension.</p>
    {primaryKyc !== null && primaryKyc !== "verified" && <div className="account-notice account-notice--info" role="note">
      {primaryKyc === "none" || primaryKyc === "expired"
        ? <>Your primary wallet {primaryKyc === "expired" ? "has an expired KYC passport" : "has not completed KYC"}. The investor passport is issued per wallet, so KYC-gated classes need it on this wallet. Converting tokens into company shares and taking delivery of physical goods need your account&apos;s identity verification (KYC). Buying and trading other tokens needs neither. {profile.wallet === profile.primary_wallet ? <Link href="/portfolio" className="account-text-button">Start KYC with this wallet</Link> : "Connect your primary wallet and open Portfolio to apply."}</>
        : primaryKyc === "pending" || primaryKyc === "more_info"
          ? <>KYC for your primary wallet is {primaryKyc === "pending" ? "in review" : "waiting for documents"}. {profile.wallet === profile.primary_wallet && <Link href="/portfolio" className="account-text-button">Open Portfolio</Link>}</>
          : <>KYC for your primary wallet is {primaryKyc}. Contact the compliance team.</>}
    </div>}
    {accountMode ? (() => {
      const connectedAddress = connectedSession?.account.address.toString() ?? null;
      const alreadyLinked = !!connectedAddress && profile.wallets.some((entry) => entry.wallet === connectedAddress);
      return <div className="account-form-actions">
        {profile.wallets.length === 0 && <p className="account-field-help">No wallet yet. You can verify and manage your account without one; a wallet is needed to buy, trade or receive tokens.</p>}
        {!connectedAddress ? <><WalletButton /><p className="account-field-help">Connect a wallet in your browser, then add it here with one signature.</p></>
          : alreadyLinked ? <p className="account-field-help">The connected wallet <code>{connectedAddress.slice(0, 4)}…{connectedAddress.slice(-4)}</code> is already linked. Switch to another wallet in your extension to add it.</p>
          : <button type="button" className="account-button account-button--primary" disabled={busy || profile.wallets.length >= 10}
              onClick={() => void run("attach-wallet", () => attachWalletToAccount(connectedSession!, profile.id), onProfile,
                "The wallet could not be added. It may already belong to another account with its own data.", "Wallet added to your account.")}>
              {pending === "attach-wallet" ? "Approve in wallet…" : `Add connected wallet ${connectedAddress.slice(0, 4)}…${connectedAddress.slice(-4)}`}<IconArrowUpRight size={15} /></button>}
      </div>;
    })() : adding ? <form className="account-form account-add-wallet" onSubmit={start}>
      <label htmlFor="account-link-target">Wallet address to add</label>
      <input id="account-link-target" value={targetWallet} onChange={(event) => setTargetWallet(event.target.value)} placeholder="Solana wallet address" maxLength={44} autoComplete="off" autoCapitalize="off" spellCheck={false} disabled={busy} required aria-describedby="account-link-help" />
      <p id="account-link-help" className="account-field-help">First approve with your connected wallet. Then switch to this exact new wallet and approve there. Both signatures are required.</p>
      {target && !validTarget && <p className="account-field-help">{profile.wallets.some((entry) => entry.wallet === target) ? "This wallet is already linked." : "Enter a valid Solana wallet address."}</p>}
      <div className="account-link-addresses"><div><span>1 · Request signed by</span><code>{profile.wallet}</code></div><div><span>2 · New wallet to confirm</span><code>{validTarget ? target : "Enter the address above"}</code></div></div>
      <p className="account-field-help">The new wallet will have access to this account&apos;s profile, email and connected Google account. Existing populated accounts cannot be merged.</p>
      <div className="account-form-actions"><button className="account-button account-button--primary" disabled={busy || !validTarget || profile.wallets.length >= 10}>{pending === "link-wallet" ? "Starting…" : "Approve link request"}<IconArrowUpRight size={16} /></button><button type="button" className="account-text-button" disabled={busy} onClick={() => { setAdding(false); setTargetWallet(""); }}>Cancel</button></div>
    </form> : <div className="account-form-actions"><button type="button" className="account-button account-button--secondary" disabled={busy || profile.wallets.length >= 10} onClick={() => setAdding(true)}>Add a wallet<IconArrowUpRight size={15} /></button>{profile.wallets.length >= 10 && <p className="account-field-help">This account has reached its 10-wallet limit.</p>}</div>}
  </section>;
}
