"use client";

import { useId, type ReactNode } from "react";
import { WalletButton } from "@/app/wallet-button";
import { IconWallet } from "@/components/icons";
import { WALLET_CONNECT_DESCRIPTION, WALLET_CONNECT_LABEL } from "@/lib/wallet-copy";

/** A connection prompt only; callers retain their own role and eligibility checks. */
export function WalletRequired({
  context,
  className = "",
}: {
  context?: ReactNode;
  className?: string;
}) {
  const titleId = useId();
  return (
    <section className={`wallet-access-card ${className}`} aria-labelledby={titleId}>
      <div className="wallet-access-icon" aria-hidden="true"><IconWallet size={22} /></div>
      <h2 id={titleId} className="wallet-access-title">{WALLET_CONNECT_LABEL}</h2>
      <p className="wallet-access-description">{WALLET_CONNECT_DESCRIPTION}</p>
      {context && <p className="wallet-access-context">{context}</p>}
      <div className="wallet-access-actions"><WalletButton /></div>
    </section>
  );
}
