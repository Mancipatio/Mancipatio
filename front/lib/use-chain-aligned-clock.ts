"use client";
// Chain-aligned clock for the issuer-recovery countdowns (2C-2). Unlike
// `useChainClock` (local time, 15 s ticks), this measures the skew between the
// latest block time and the local clock once per `rpc`, then ticks every
// second, so a wrong browser clock cannot show a recovery as executable early.
// The program's Clock stays the only source of truth.
import { useCallback, useEffect, useState } from "react";
import type { SolanaClient } from "@solana/client";
import { fetchChainNow } from "@/lib/issuer-authority";

type Rpc = SolanaClient["runtime"]["rpc"];

const localNow = () => Math.floor(Date.now() / 1000);

/** `now` in chain seconds (null until the first block time is read). */
export function useChainAlignedClock(rpc: Rpc): { now: number | null; resync: () => void } {
  const [skew, setSkew] = useState<number | null>(null);
  const [local, setLocal] = useState(localNow);
  const resync = useCallback(() => {
    void fetchChainNow(rpc).then((chain) => setSkew(chain - localNow()));
  }, [rpc]);
  useEffect(() => {
    resync();
  }, [resync]);
  useEffect(() => {
    const id = setInterval(() => setLocal(localNow()), 1_000);
    return () => clearInterval(id);
  }, []);
  return { now: skew === null ? null : local + skew, resync };
}
