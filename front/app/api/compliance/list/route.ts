// POST /api/compliance/list — admin read of AML/sanctions and system alerts.
//
// Signed + requireAdmin. compliance_alerts is the single most sensitive table
// in the schema (subject wallets, sanctions hit lists, screening evidence,
// resolver wallets and resolution notes — regulated AML data), so reads sit
// behind the on-chain admin gate exactly like fee_config/integrations reads.
// The residual anon SELECT policy is dropped in 0031: the shipped anon key
// can no longer dump the table.
//
// Two bounded reads (Talas 4.4b): every open or escalated alert (up to
// 1000), plus the newest 200 others. Merged: open and escalated first, then
// by severity, then newest first, so an old open critical alert never hides
// behind hundreds of newer low ones. `truncated` says a read hit its limit.
// Optional `category` (onchain | indexer | worker | ledger | fx | aml, the
// last meaning rows without a system category).
//
// Client wrapper: listAlerts() in lib/compliance.ts (action "compliance.list").

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";

const OPEN_LIMIT = 1000;
const OTHER_LIMIT = 200;
const CATEGORIES = new Set(["onchain", "indexer", "worker", "ledger", "fx", "aml"]);
const SEVERITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const UNRESOLVED = ["open", "escalated"];

type Row = { id: string; status: string; severity: string; created_at: string };

function orderAlerts<T extends Row>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const openA = UNRESOLVED.includes(a.status) ? 0 : 1;
    const openB = UNRESOLVED.includes(b.status) ? 0 : 1;
    if (openA !== openB) return openA - openB;
    const sev = (SEVERITY_RANK[a.severity] ?? 4) - (SEVERITY_RANK[b.severity] ?? 4);
    if (sev) return sev;
    return a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0;
  });
}

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "compliance.list");
    await requireAdmin(wallet);

    const category = typeof params.category === "string" && params.category ? params.category : null;
    if (category !== null && !CATEGORIES.has(category)) throw new SiwsError(400, "Unknown category");

    const sb = getSupabaseAdmin();
    const base = () => {
      let q = sb.from("compliance_alerts").select("*").eq("network", detectNetwork());
      if (category === "aml") q = q.is("category", null);
      else if (category) q = q.eq("category", category);
      return q;
    };
    const [open, other] = await Promise.all([
      base().in("status", UNRESOLVED).order("created_at", { ascending: false }).limit(OPEN_LIMIT),
      base().not("status", "in", `(${UNRESOLVED.join(",")})`).order("created_at", { ascending: false }).limit(OTHER_LIMIT),
    ]);
    if (open.error || other.error) {
      console.error("[api/compliance/list] query failed");
      throw new SiwsError(500, "Could not load compliance alerts");
    }
    const openRows = (open.data ?? []) as Row[];
    const otherRows = (other.data ?? []) as Row[];
    return NextResponse.json({
      ok: true,
      data: {
        alerts: orderAlerts([...openRows, ...otherRows]),
        truncated: { open: openRows.length >= OPEN_LIMIT, other: otherRows.length >= OTHER_LIMIT },
      },
    });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
