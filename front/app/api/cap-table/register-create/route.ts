// POST /api/cap-table/register-create — record the company-register entry
// behind converted units (register_entries, 0086), after the registry
// decision (ops/runbook-mainnet.md §21). Signed with a fresh wallet signature
// (capTable.registerCreate, never a session action: it writes the register)
// + requireAdmin. Params: share_class_pda, units, percent_bps, registry,
// decision_ref, decision_date, decision_doc_sha256, and optionally
// conversion_request_id, realize_tx, holder_client_id, note.
//
// The server derives the asset from the on-chain share class, never from the
// caller. A linked request must be this network's, of the same class and
// converted; its realize signature and dossier fill the entry when left out
// (lib/server/cap-table.ts recordRegisterEntry). The database guard re-checks
// the link and keeps the entry immutable: a correction is a void plus a new
// entry. One recorded entry per request (409).

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { recordRegisterEntry } from "@/lib/server/cap-table";

export const maxDuration = 30;

export async function POST(request: Request) {
  try {
    const { wallet, params, via } = await verifySigned(request, "capTable.registerCreate");
    await requireAdmin(wallet);
    const entry = await recordRegisterEntry(params, wallet, via);
    return NextResponse.json({ ok: true, data: { entry } }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
