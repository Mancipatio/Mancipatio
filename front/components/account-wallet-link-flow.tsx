"use client";

import { useWalletConnection } from "@solana/react-hooks";
import type { WalletSession } from "@solana/client";
import { WalletButton } from "@/app/wallet-button";
import { AccountFeedback, useAccountOperation } from "@/components/account-session";
import { IconCheck, IconWallet } from "@/components/icons";
import type { AccountResponse, AccountWalletLinkAttempt } from "@/lib/account";
import { cancelAccountWalletLink, completeAccountWalletLink } from "@/lib/account-client";
import { networkLabel, type Network } from "@/lib/network";

type Props = {
  attempt: AccountWalletLinkAttempt;
  network: Network;
  onComplete: (response: AccountResponse, session: WalletSession) => void;
  onCancel: () => void;
  onClose: () => void;
};

export function AccountWalletLinkFlow({ attempt, network, onComplete, onCancel, onClose }: Props) {
  const conn = useWalletConnection();
  const session = conn.connected ? conn.wallet : undefined;
  const targetConnected = session?.account.address.toString() === attempt.target_wallet;

  return <section className="account-card account-link-flow" aria-labelledby="wallet-link-heading">
    <span className="account-feature-icon"><IconWallet size={23} /></span>
    <p className="account-eyebrow">STEP 2 OF 2 · {networkLabel(network).toUpperCase()}</p>
    <h2 id="wallet-link-heading">Confirm with the new wallet.</h2>
    <p className="account-card-description">The first wallet approved this request. Connect the exact wallet below and approve one more message to finish linking.</p>
    <div className="account-link-addresses"><div><span>Request approved by</span><code>{attempt.requested_by}</code></div><div><span>New wallet that must confirm</span><code>{attempt.target_wallet}</code></div></div>
    <p className="account-field-help">Expires {new Date(attempt.expires_at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" })} UTC. This request is saved in this browser tab until then.</p>
    {!targetConnected && <div className="account-link-switch"><h3>Switch your connected wallet</h3><p>{session ? "Disconnect below, select the new account in your wallet extension, then reconnect here." : "Select the new account in your wallet extension, then connect it here."}</p><WalletButton />{session && session.account.address.toString() !== attempt.requested_by && <p className="account-unavailable">The connected address does not match the requested wallet. Switch to the exact address above.</p>}</div>}
    {session && (targetConnected || session.account.address.toString() === attempt.requested_by) ? <ConfirmWalletLink key={`${session.account.address}:${session.connector.id}`} session={session} attempt={attempt} network={network} onComplete={onComplete} onCancel={onCancel} onClose={onClose} /> : <div className="account-form-actions"><button type="button" className="account-button account-button--primary" disabled>Confirm wallet link</button><button type="button" className="account-text-button" onClick={onClose}>Close setup</button><p className="account-field-help">Closing this setup does not revoke the request. Connect one of the two wallets to cancel it, or let it expire.</p></div>}
    <p className="account-fineprint account-google-note">Linked wallets share profile access. Linking does not transfer assets or change your primary transaction wallet.</p>
  </section>;
}

function ConfirmWalletLink({ session, attempt, network, onComplete, onCancel, onClose }: Props & { session: WalletSession }) {
  const { run, pending, notice } = useAccountOperation(session, network, attempt.account_id);
  const canSign = typeof session.signMessage === "function";
  const targetConnected = session.account.address.toString() === attempt.target_wallet;

  return <>
    {targetConnected && <p className="account-link-ready"><IconCheck size={16} />The requested wallet is connected.</p>}
    <AccountFeedback notice={notice} />
    {!canSign && <><p className="account-unavailable">This wallet cannot sign messages. Reconnect it using a supported wallet application.</p><button type="button" className="account-text-button" onClick={onClose}>Close setup</button><p className="account-field-help">Closing setup does not revoke the request; it expires automatically.</p></>}
    <div className="account-form-actions"><button type="button" className="account-button account-button--primary" disabled={!!pending || !canSign || !targetConnected} onClick={() => void run("complete-link", (context) => completeAccountWalletLink(context, attempt), (response) => onComplete(response, session), "The wallet could not be linked. The request may have expired, or this wallet may belong to an existing populated account. Start again from the original wallet.")}>{pending === "complete-link" ? "Confirming…" : "Confirm wallet link"}<IconCheck size={16} /></button><button type="button" className="account-text-button" disabled={!!pending || !canSign} onClick={() => void run("cancel-link", (context) => cancelAccountWalletLink(context, attempt), onCancel, "The request could not be cancelled. It may have expired or already been completed. Open your account to check its linked wallets.")}>{pending === "cancel-link" ? "Cancelling…" : "Cancel request"}</button></div>
  </>;
}
