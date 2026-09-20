"use client";

import { useLayoutEffect, useRef, useState } from "react";
import type { WalletSession } from "@solana/client";
import { useSolanaClient } from "@solana/react-hooks";
import { accountErrorMessage, type AccountRequestContext } from "@/lib/account-client";
import { detectNetwork, type Network } from "@/lib/network";

export type AccountNotice = { tone: "success" | "error" | "info"; text: string };

/** One explicit operation at a time, bound to the exact connected session. */
export function useAccountOperation(session: WalletSession, network: Network) {
  const client = useSolanaClient();
  const mounted = useRef(false);
  const inFlight = useRef(false);
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<AccountNotice | null>(null);

  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  function isCurrent() {
    const current = client.store.getState().wallet;
    return mounted.current && detectNetwork() === network &&
      current.status === "connected" && current.session === session;
  }

  async function run<T>(
    operation: string,
    task: (context: AccountRequestContext) => Promise<T>,
    apply: (value: T) => void,
    fallback: string,
    success?: string,
  ) {
    if (inFlight.current || !isCurrent()) return;
    inFlight.current = true;
    setPending(operation);
    setNotice(null);
    try {
      const value = await task({ session, network, isCurrent });
      if (!isCurrent()) return;
      apply(value);
      if (success) setNotice({ tone: "success", text: success });
    } catch (error) {
      if (isCurrent()) setNotice({ tone: "error", text: accountErrorMessage(error, fallback) });
    } finally {
      inFlight.current = false;
      if (isCurrent()) setPending(null);
    }
  }

  return { pending, notice, run };
}

export function AccountFeedback({ notice }: { notice: AccountNotice | null }) {
  if (!notice) return null;
  return <div className={`account-notice account-notice--${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>{notice.text}</div>;
}
