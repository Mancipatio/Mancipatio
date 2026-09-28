"use client";

// The emergency pause for a page's own banner (lib/pause-gate.ts): the
// Platform's pause flags, re-read every 30 s through the gate's short cache.
// null until read, or when unreadable (fail open: the program decides, and
// the send path checks again before the wallet opens).
import { useSolanaClient } from "@solana/react-hooks";
import { useEffect, useState } from "react";
import { readPauseFlags } from "@/lib/pause-gate";

export const PAUSE_FLAGS_REFRESH_MS = 30_000;

export function usePauseFlags(): number | null {
  const client = useSolanaClient();
  const rpc = client.runtime.rpc;
  const [flags, setFlags] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => {
      void readPauseFlags(rpc).then((value) => {
        if (alive) setFlags(value);
      });
    };
    load();
    const id = setInterval(load, PAUSE_FLAGS_REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [rpc]);
  return flags;
}
