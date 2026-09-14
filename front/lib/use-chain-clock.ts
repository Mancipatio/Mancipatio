"use client";
import { useEffect, useState } from "react";
/** Approximate display clock only. The program always enforces its own clock. */
export function useChainClock() {
  const [now, setNow] = useState(() => BigInt(Math.floor(Date.now() / 1000)));
  useEffect(() => {
    const interval = setInterval(
      () => setNow(BigInt(Math.floor(Date.now() / 1000))),
      15_000,
    );
    return () => clearInterval(interval);
  }, []);
  return now;
}
