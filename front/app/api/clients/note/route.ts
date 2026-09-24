// POST /api/clients/note — an admin or the KYC provider posts an internal
// note on a client timeline (SIWS + requireAdminOrKycProvider, Talas 3.1 K6).
// Action: "clients.note". Client half: lib/clients.ts addNote(). The author
// is ALWAYS the verified signing wallet.

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse } from "@/lib/server/siws";
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

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "clients.note");
    await requireAdminOrKycProvider(wallet);

    const clientId = assertUuid(params.client_id, "client_id");
    const body = reqString(params, "body", 4000);
    const kind =
      params.kind === undefined || params.kind === null
        ? "note"
        : oneOf(params.kind, NOTE_KINDS, "kind");

    const sb = getSupabaseAdmin();
    await fetchClientOr404(sb, clientId);
    await insertNote(sb, clientId, wallet, body, kind);

    return NextResponse.json({ ok: true, data: { posted: true } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
