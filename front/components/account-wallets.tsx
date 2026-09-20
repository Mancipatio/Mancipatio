"use client";

import { useState, type FormEvent } from "react";
import { isAddress } from "@solana/kit";
import type { AccountResponse, AccountWalletLinkAttempt } from "@/lib/account";
import { removeAccountWallet, setAccountPrimaryWallet, startAccountWalletLink } from "@/lib/account-client";
import { useAccountOperation } from "@/components/account-session";
import { IconArrowUpRight, IconCheck, IconWallet } from "@/components/icons";

type Props = {
  data: AccountResponse;
  operation: ReturnType<typeof useAccountOperation>;
  onProfile: (value: AccountResponse) => void;
  onStartLink: (attempt: AccountWalletLinkAttempt) => void;
};

export function AccountWallets({ data, operation, onProfile, onStartLink }: Props) {
  const [adding, setAdding] = useState(false);
  const [targetWallet, setTargetWallet] = useState("");
  const [removeWallet, setRemoveWallet] = useState<string | null>(null);
  const { profile } = data;
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
    <p className="account-card-description">Any linked wallet can open and edit this shared profile. Your assets and balances stay with each wallet.</p>
    <div className="account-wallet-list">
      {profile.wallets.map(({ wallet }) => {
        const connected = wallet === profile.wallet;
        const primary = wallet === profile.primary_wallet;
        const canRemove = !connected && !primary && profile.wallets.length > 1;
        return <div className="account-wallet-row" key={wallet}>
          <div className="account-wallet-row-labels">{primary && <span className="account-status account-status--verified"><IconCheck size={12} />Primary for transactions</span>}{connected && <span className="account-status">Connected</span>}</div>
          <code>{wallet}</code>
          <div className="account-wallet-row-actions">
            {!primary && <button type="button" className="account-text-button" disabled={busy} onClick={() => void run("primary-wallet", (context) => setAccountPrimaryWallet(context, wallet), onProfile,
              "The primary wallet could not be changed. Open your account again and try again.", "Primary wallet saved. Connect that wallet when you want to transact.")}>Set as primary</button>}
            <button type="button" className="account-text-button account-text-button--muted" disabled={busy || !canRemove} onClick={() => setRemoveWallet(wallet)} title={connected ? "The connected wallet cannot be removed." : primary ? "Choose another primary wallet before removing this one." : undefined}>Remove</button>
          </div>
          {removeWallet === wallet && canRemove && <div className="account-wallet-confirm" role="group" aria-label="Confirm wallet removal"><p>This wallet will lose access to your shared profile. Its assets stay in the wallet.</p><div className="account-wallet-row-actions"><button type="button" className="account-button account-button--secondary" disabled={busy} onClick={() => void run("remove-wallet", (context) => removeAccountWallet(context, wallet), (value) => { setRemoveWallet(null); onProfile(value); }, "The wallet could not be removed. Open your account again and try again.", "The wallet has been removed from this account.")}>Confirm removal</button><button type="button" className="account-text-button" disabled={busy} onClick={() => setRemoveWallet(null)}>Keep wallet</button></div></div>}
        </div>;
      })}
    </div>
    <p className="account-field-help">Your primary wallet signs transactions. Selecting it here does not switch the account in your wallet extension.</p>
    {adding ? <form className="account-form account-add-wallet" onSubmit={start}>
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
