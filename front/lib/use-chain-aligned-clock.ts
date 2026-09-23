"use client";
// Chain-aligned clock for the issuer-recovery countdowns (2C-2). Unlike
// `useChainClock` (local time, 15 s ticks), this measures the skew between the
// latest block time and the local clock, then ticks every second, so a wrong
// browser clock does not skew the countdown. The skew is re-measured every 5
// minutes (every 30 s while the RPC cannot give a block time, when the
// countdown falls back to the local clock and says so via `fromChain`) and on
// `resync()`. The program's Clock stays the only source of truth.
import { useCallback, useEffect, useState } from "react";
import type { SolanaClient } from "@solana/client";
import { fetchChainNow } from "@/lib/issuer-authority";

type Rpc = SolanaClient["runtime"]["rpc"];

const localNow = () => Math.floor(Date.now() / 1000);
const RESYNC_MS = 5 * 60_000;
const RETRY_MS = 30_000;

/**
 * `now` in chain seconds (null until the first read). `fromChain` is false
 * while the countdown runs on the local clock because no block time could be
 * read.
 */
export function useChainAlignedClock(rpc: Rpc): {
  now: number | null;
  fromChain: boolean;
  resync: () => void;
} {
  const [skew, setSkew] = useState<{ seconds: number; fromChain: boolean } | null>(null);
  const [local, setLocal] = useState(localNow);
  const resync = useCallback(() => {
    void fetchChainNow(rpc).then(({ now, fromChain }) => setSkew({ seconds: now - localNow(), fromChain }));
  }, [rpc]);
  useEffect(() => {
    resync();
  }, [resync]);
  const fromChain = skew?.fromChain ?? true;
  useEffect(() => {
    const id = setInterval(resync, fromChain ? RESYNC_MS : RETRY_MS);
    return () => clearInterval(id);
  }, [resync, fromChain]);
  useEffect(() => {
    const id = setInterval(() => setLocal(localNow()), 1_000);
    return () => clearInterval(id);
  }, []);
  return { now: skew === null ? null : local + skew.seconds, fromChain, resync };
}

/** The label a countdown shows while it runs on the local clock. */
export const LOCAL_CLOCK_NOTE = "Chain time unavailable: this countdown uses your device clock.";
