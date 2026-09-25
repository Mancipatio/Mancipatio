// POST /api/clients/passport-sync — write the on-chain passport outcome back
// into the off-chain clients dossier so the two KYC systems cannot diverge.
//
// SIWS-signed + requireKycProvider: only the live `KycRegistry.authority` can
// have sent the approve_holder / revoke_holder transaction this route
// mirrors, and that key is a SEPARATE on-chain role from `Platform.admin`
// (e2e §5) — after a platform-admin rotation the provider is no longer the
// super admin but is still the only wallet that issues/revokes passports, so
// the write-back (and every "Retry off-chain sync") must keep working for it,
// while a new super admin who never held the registry must be refused.
// Action: "clients.passport-sync".
// Client half: lib/clients.ts syncPassportToClient().
//
// Params: { client_id, event: "issued" | "revoked", tx_signature, expires_at? }
//   * issued  → kyc_provider='manual', kyc_provider_ref=tx signature,
//               kyc_expires_at=on-chain expiry; approval email (best-effort);
//               the wallet's undecided passport request(s) → 'approved', so
//               a passport issued from the dossier page also clears the
//               /admin/kyc queue (best-effort).
//   * revoked → kyc_status='suspended' (a revoked passport is an operator
//               action against a previously verified client — suspension, not
//               'rejected', which describes a failed application) +
//               kyc_provider_ref=tx signature; notification email.
//
// Both events drop a kyc-event note on the client timeline. Email and note
// are best-effort — the on-chain transaction already succeeded.

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireKycProvider } from "@/lib/server/kyc-provider-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { sendEmail, escapeHtml } from "@/lib/server/email";
import {
  applyClientStatus,
  assertUuid,
  fetchClientOr404,
  insertNote,
  oneOf,
  reqString,
} from "../_helpers";

const EVENTS = ["issued", "revoked"] as const;
// Base58 transaction signatures are 87–88 chars; accept a safe range.
const TX_SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{64,96}$/;

/**
 * An issued passport decides the wallet's undecided passport request(s): the
 * /admin/kyc queue (and its menu badge) must not keep offering a request the
 * dossier page already issued — the only other way out of `new` is Reject,
 * which emails the applicant "not approved". Same stamp as the queue's own
 * approval (handled_by = the signer). Best-effort: the passport exists
 * on-chain and the dossier is already synced; a failure is logged and the
 * queue can still close the row by hand.
 */
async function closeOpenPassportRequests(
  sb: ReturnType<typeof getSupabaseAdmin>,
  holder: string | null | undefined,
  signer: string,
): Promise<void> {
  if (!holder) return;
  try {
    const { error } = await sb
      .from("passport_requests")
      .update({ status: "approved", handled_by: signer, handled_at: new Date().toISOString() })
      .eq("wallet", holder)
      .in("status", ["new", "in_review"]);
    if (error) console.warn("[api/clients/passport-sync] passport request close failed:", error.code ?? error.message);
  } catch (err) {
    console.warn("[api/clients/passport-sync] passport request close failed:", err instanceof Error ? err.message : err);
  }
}

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "clients.passport-sync");
    await requireKycProvider(wallet);

    const clientId = assertUuid(params.client_id, "client_id");
    const event = oneOf(params.event, EVENTS, "event");
    const txSignature = reqString(params, "tx_signature", 96);
    if (!TX_SIG_RE.test(txSignature)) {
      throw new SiwsError(400, "tx_signature is not a valid transaction signature");
    }

    let expiresAt: string | null = null;
    if (event === "issued") {
      if (
        typeof params.expires_at !== "string" ||
        Number.isNaN(Date.parse(params.expires_at))
      ) {
        throw new SiwsError(400, "expires_at must be an ISO timestamp");
      }
      expiresAt = new Date(Date.parse(params.expires_at)).toISOString();
    }

    const sb = getSupabaseAdmin();
    const client = await fetchClientOr404(sb, clientId);

    if (event === "issued") {
      const { error } = await sb
        .from("clients")
        .update({
          kyc_provider: "manual",
          kyc_provider_ref: txSignature,
          kyc_expires_at: expiresAt,
        })
        .eq("id", clientId);
      if (error) {
        console.error("[api/clients/passport-sync] issued update failed:", error.message);
        throw new SiwsError(500, "Passport sync failed");
      }
      await closeOpenPassportRequests(sb, client.wallet, wallet);
      await insertNote(
        sb,
        clientId,
        wallet,
        `On-chain passport issued (tx ${txSignature.slice(0, 8)}…, expires ${expiresAt?.slice(0, 10)})`,
        "kyc-event",
      );
      if (client.email) {
        await sendEmail({
          to: client.email,
          subject: "Your Manci investor passport has been issued",
          html:
            `<p>Hi${client.display_name ? ` ${escapeHtml(client.display_name)}` : ""},</p>` +
            `<p>Good news — your on-chain investor passport has been issued` +
            (expiresAt ? ` and is valid until <strong>${expiresAt.slice(0, 10)}</strong>` : "") +
            `.</p>` +
            `<p>You can now buy and receive KYC-gated classes with this wallet in the marketplace. Converting tokens into company shares and requesting delivery of physical goods are available from your portfolio while your identity verification is current.</p>` +
            `<p style="color:#64748b;font-size:12px;">— The Manci team</p>`,
        });
      }
    } else {
      // revoked → suspension of the off-chain verdict (see header rationale).
      await applyClientStatus(sb, clientId, "suspended");
      const { error } = await sb
        .from("clients")
        .update({ kyc_provider_ref: txSignature })
        .eq("id", clientId);
      if (error) {
        console.warn("[api/clients/passport-sync] revoke ref update failed:", error.message);
      }
      await insertNote(
        sb,
        clientId,
        wallet,
        `On-chain passport revoked (tx ${txSignature.slice(0, 8)}…) — client suspended`,
        "kyc-event",
      );
      if (client.email) {
        await sendEmail({
          to: client.email,
          subject: "Your Manci investor passport has been revoked",
          html:
            `<p>Hi${client.display_name ? ` ${escapeHtml(client.display_name)}` : ""},</p>` +
            `<p>Your on-chain investor passport has been revoked and your account is suspended. ` +
            `Contact the Manci compliance team for details.</p>` +
            `<p style="color:#64748b;font-size:12px;">— The Manci team</p>`,
        });
      }
    }

    return NextResponse.json({ ok: true, data: { client_id: clientId, event } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
