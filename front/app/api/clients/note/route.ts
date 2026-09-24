// POST /api/clients/note — an admin or the KYC provider posts an internal
// note on a client timeline (SIWS + requireAdminOrKycProvider, Talas 3.1 K6).
// Action: "clients.note". Client half: lib/clients.ts addNote(). The author
// is ALWAYS the verified signing wallet.
//
// A KYC provider (no Admin record) posts only "note" / "communication":
// "kyc-event" and "system" entries record decisions and system actions,
// which the provider makes through their own routes (status, request-docs).
// The "[KYC provider]" prefix is reserved for /api/clients/status, so no
// posted note can imitate a provider decision.

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdminOrKycProvider } from "@/lib/server/kyc-provider-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import {
  NOTE_KINDS,
  assertUuid,
  fetchClientOr404,
  insertNote,
  oneOf,
  reqString,
} from "../_helpers";

const PROVIDER_NOTE_KINDS: ReadonlySet<string> = new Set(["note", "communication"]);
const PROVIDER_DECISION_MARKER = "[KYC provider]";

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "clients.note");
    const role = await requireAdminOrKycProvider(wallet);

    const clientId = assertUuid(params.client_id, "client_id");
    const body = reqString(params, "body", 4000);
    const kind =
      params.kind === undefined || params.kind === null
        ? "note"
        : oneOf(params.kind, NOTE_KINDS, "kind");
    if (role === "kycProvider" && !PROVIDER_NOTE_KINDS.has(kind)) {
      throw new SiwsError(403, "The KYC provider posts notes and communications only");
    }
    if (body.trimStart().startsWith(PROVIDER_DECISION_MARKER)) {
      throw new SiwsError(400, `"${PROVIDER_DECISION_MARKER}" is reserved for status decisions`);
    }

    const sb = getSupabaseAdmin();
    await fetchClientOr404(sb, clientId);
    await insertNote(sb, clientId, wallet, body, kind);

    return NextResponse.json({ ok: true, data: { posted: true } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
