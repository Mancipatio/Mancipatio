// SERVER-ONLY — raise limits for /apply (0056). The database trigger is the
// authority; these helpers give routes a readable answer before writing.

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SiwsError } from "@/lib/server/siws";

export type RaiseCapacity = {
  year: number;
  cap: number;
  used: number;
  remaining: number;
  max_equity_percent: number;
  cap_source: "platform" | "client";
};

export async function getRaiseCapacity(
  sb: SupabaseClient, wallet: string, network: string, excludeApplicationId?: string | null,
): Promise<RaiseCapacity> {
  const { data, error } = await sb.rpc("raise_capacity", {
    p_wallet: wallet, p_network: network, p_exclude: excludeApplicationId ?? null,
  });
  if (error || !data || typeof data !== "object") {
    console.error("[raise-limits] capacity lookup failed:", error?.code);
    throw new SiwsError(503, "Could not check your raise limit. Please try again.");
  }
  const d = data as Record<string, unknown>;
  return {
    year: Number(d.year), cap: Number(d.cap), used: Number(d.used), remaining: Number(d.remaining),
    max_equity_percent: Number(d.max_equity_percent), cap_source: d.cap_source === "client" ? "client" : "platform",
  };
}

const eur = (n: number) => `€${Math.round(n).toLocaleString("en-US")}`;

/** Friendly 400 before the write; the trigger still guards races. */
export function assertWithinCapacity(cap: RaiseCapacity, raiseAmount: number, equityOffered: number): void {
  if (raiseAmount > cap.remaining) {
    throw new SiwsError(400, cap.remaining <= 0
      ? `You have reached the ${eur(cap.cap)} raise limit for ${cap.year}.`
      : `You can raise at most ${eur(cap.remaining)} more in ${cap.year} (limit ${eur(cap.cap)} per calendar year).`);
  }
  if (equityOffered > cap.max_equity_percent) {
    throw new SiwsError(400, `Equity offered can be at most ${cap.max_equity_percent}%.`);
  }
}

/** Map the trigger's P0001 messages onto the same friendly errors. */
export function raiseLimitError(error: { code?: string; message?: string } | null | undefined): SiwsError | null {
  if (!error || error.code !== "P0001" || !error.message) return null;
  const cap = /RAISE_CAP_EXCEEDED remaining=([\d.]+) cap=([\d.]+)/.exec(error.message);
  if (cap) return new SiwsError(400, `You can raise at most ${eur(Number(cap[1]))} more this year (limit ${eur(Number(cap[2]))} per calendar year).`);
  const eq = /EQUITY_CAP_EXCEEDED max=([\d.]+)/.exec(error.message);
  if (eq) return new SiwsError(400, `Equity offered can be at most ${Number(eq[1])}%.`);
  return null;
}
