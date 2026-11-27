"use client";

import { useSyncExternalStore } from "react";
import { hasWalletSession, subscribeWalletSession } from "@/lib/siws-client";

export function useWalletSession(wallet: string | null): boolean {
  return useSyncExternalStore(subscribeWalletSession, () => !!wallet && hasWalletSession(wallet), () => false);
}
