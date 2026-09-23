// POST /api/otc/admin-update — admin flips an OTC request's lifecycle status
// (created / cancelled / completed / expired) and records the on-chain deal
// coordinates. Signed (SIWS) + on-chain admin gate.
//
// Deal-created hook (item 6): when the status transitions TO 'created' (the
// admin just opened the on-chain escrow), both parties are notified — an
// email IF a clients row with an email is known for their wallet (silently
// skipped otherwise), and ALWAYS a notifications row per wallet as the
// in-app trace. Notification failures never fail the route.
//
// Archive (2D): `{ archive: true, deal_pda }` stores a terminal deal's bytes
// in indexer_closed_rows before the admin reclaims its rent.

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { sendEmail, escapeHtml } from "@/lib/server/email";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { archiveOtcDeal } from "@/lib/server/otc-archive";
import type { SupabaseClient } from "@supabase/supabase-js";

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const STATUSES = new Set(["created", "cancelled", "completed", "expired"]);

type OtcRow = {
  id: string;
  status: string;
  seller_wallet: string;
  buyer_wallet: string;
  asset_label: string;
  mint: string;
  amount: number;
  price: number;
};

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "otc.adminUpdate");
    await requireAdmin(wallet);

    // 2D: archive a terminal deal (deal.admin only) before its rent is
    // reclaimed; also closes the linked request. Keyed by deal_pda.
    if (params.archive === true) {
      return NextResponse.json({
        ok: true,
        data: await archiveOtcDeal(wallet, params.deal_pda),
      });
    }

    const id = typeof params.id === "string" ? params.id : "";
    if (id.length === 0 || id.length > 64) {
      throw new SiwsError(400, "id is required");
    }

    const patch: Record<string, unknown> = {};
    if (params.status !== undefined) {
      if (typeof params.status !== "string" || !STATUSES.has(params.status)) {
        throw new SiwsError(400, "status is not an allowed value");
      }
      patch.status = params.status;
    }
    if (params.deal_pda !== undefined) {
      if (
        typeof params.deal_pda !== "string" ||
        !BASE58_RE.test(params.deal_pda)
      ) {
        throw new SiwsError(400, "deal_pda is not a valid address");
      }
      patch.deal_pda = params.deal_pda;
    }
    if (params.deal_id !== undefined) {
      if (
        typeof params.deal_id !== "number" ||
        !Number.isSafeInteger(params.deal_id) ||
        params.deal_id < 0
      ) {
        throw new SiwsError(400, "deal_id must be a non-negative integer");
      }
      patch.deal_id = params.deal_id;
    }
    if (params.expires_at !== undefined) {
      if (params.expires_at === null) {
        patch.expires_at = null;
      } else if (
        typeof params.expires_at === "string" &&
        !Number.isNaN(new Date(params.expires_at).getTime())
      ) {
        patch.expires_at = params.expires_at;
      } else {
        throw new SiwsError(400, "expires_at is not a valid timestamp");
      }
    }
    if (params.admin_note !== undefined) {
      if (params.admin_note === null) {
        patch.admin_note = null;
      } else if (
        typeof params.admin_note === "string" &&
        params.admin_note.length <= 2000
      ) {
        patch.admin_note = params.admin_note;
      } else {
        throw new SiwsError(400, "admin_note must be at most 2000 characters");
      }
    }
    if (params.decide === true) {
      patch.decided_by = wallet;
      patch.decided_at = new Date().toISOString();
    }
    if (Object.keys(patch).length === 0) {
      throw new SiwsError(400, "Nothing to update");
    }

    const sb = getSupabaseAdmin();
    const { data: before, error: loadErr } = await sb
      .from("otc_requests")
      .select("id, status, seller_wallet, buyer_wallet, asset_label, mint, amount, price")
      .eq("id", id)
      .maybeSingle();
    if (loadErr) throw new SiwsError(500, "Request lookup failed");
    if (!before) throw new SiwsError(404, "OTC request not found");

    const { error } = await sb.from("otc_requests").update(patch).eq("id", id);
    if (error) {
      console.error("[api/otc/admin-update] update failed:", error.message);
      throw new SiwsError(500, "Could not update the OTC request");
    }

    // Deal-created notification hook — best-effort, never fails the route.
    let notified = false;
    if (patch.status === "created" && before.status !== "created") {
      try {
        await notifyDealCreated(
          sb,
          before as OtcRow,
          typeof patch.deal_pda === "string" ? patch.deal_pda : null,
          wallet,
        );
        notified = true;
      } catch (err) {
        console.warn("[api/otc/admin-update] notify failed:", err);
      }
    }

    return NextResponse.json({ ok: true, data: { id, notified } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}

async function notifyDealCreated(
  sb: SupabaseClient,
  row: OtcRow,
  dealPda: string | null,
  adminWallet: string,
): Promise<void> {
  const label =
    row.asset_label || `${row.mint.slice(0, 6)}…${row.mint.slice(-4)}`;
  const subject = "Your OTC escrow deal is ready";
  const body =
    `The escrow contract for ${label} (${row.amount} units for ${row.price} ` +
    `payment units) is live on-chain` +
    (dealPda ? ` at ${dealPda}` : "") +
    `. Open Portfolio → Deals on Manci to deposit your leg — the swap ` +
    `settles automatically once both legs are funded.`;

  for (const partyWallet of [row.seller_wallet, row.buyer_wallet]) {
    // Email if a client with an email is known for this wallet; skip silently
    // otherwise (per spec).
    let emailSent = false;
    let providerRef: string | null = null;
    const { data: client } = await sb
      .from("clients")
      .select("email")
      .eq("wallet", partyWallet)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    const email = (client?.email as string | null) ?? null;
    if (email) {
      const res = await sendEmail({
        to: email,
        subject,
        html:
          `<p>${body}</p>` +
          `<p><a href="${escapeHtml(new URL("/portfolio/deals", process.env.NEXT_PUBLIC_SITE_URL || "https://www.manci.io").toString())}">Open your deals</a></p>`,
      });
      emailSent = res.sent;
      providerRef = res.id ?? null;
    }

    // Always insert the in-app trace row.
    const { error } = await sb.from("notifications").insert({
      kind: emailSent ? "both" : "in-app",
      audience: "wallet",
      audience_param: partyWallet,
      subject,
      body,
      status: "sent",
      sent_at: new Date().toISOString(),
      recipient_count: 1,
      provider_ref: providerRef,
      author: adminWallet,
    });
    if (error) {
      console.warn(
        "[api/otc/admin-update] notifications insert failed:",
        error.message,
      );
    }
  }
}
