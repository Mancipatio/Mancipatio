// POST /api/clients/export — GDPR access / portability export of ONE dossier:
// a JSON bundle of what the platform stores about the client.
// Signed with a fresh wallet signature (NOT a session read — this releases a
// whole dossier) + requireAdmin. Action: "clients.export".
// Params: { client_id }. Client half: lib/clients.ts adminExportClient().
//
// The bundle holds the clients row (without the onboarding token, which is a
// credential), client_verification_details, client_documents metadata with
// fresh signed URLs (KYC_EXPORT_URL_TTL_S), kyc_requirements, client_notes,
// Terms acceptances (linked to the dossier or signed by its wallet, including
// archived duplicates), passport requests of its wallet, the linked account
// (profile + wallets), raise-limit override, fee waivers, conversion and
// delivery requests, and the access log (when "kyc" audit rows targeting the
// dossier were written — document views, exports, erasures — without the
// operator's identity). What is deliberately NOT included is listed in the
// bundle's `not_included` section.
//
// Logged: a server-attributed audit row (ix_name "kyc_data_export") is
// written BEFORE the bundle is returned; if it cannot be written the route
// answers 503 and returns nothing.

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { actorSourceOf, writeServerAudit } from "@/lib/server/audit";
import { detectNetwork } from "@/lib/network";
import { CLIENT_EXPORT_FORMAT } from "@/lib/client-privacy";
import {
  assertUuid,
  fetchClientOr404,
  insertNote,
  KYC_EXPORT_URL_TTL_S,
  PRIVATE_BUCKET,
} from "../_helpers";
import { ownerFilter } from "../_privacy";

const ACCOUNT_COLUMNS =
  "id,network,wallet,primary_wallet,display_name,email,email_verified_at," +
  "pending_email,pending_email_expires_at,google_email,google_sub," +
  "google_linked_at,created_at,updated_at";

type Row = Record<string, unknown>;

// PostgREST / Postgres "no such table" (a migration not applied yet).
const MISSING_TABLE = new Set(["42P01", "PGRST205"]);

type Result = { data: unknown; error: { message?: string; code?: string } | null };

/** Rows of a list read; a failed read fails the whole export. */
function rows(section: string, res: Result, optionalTable = false): unknown[] {
  if (res.error) {
    if (optionalTable && res.error.code && MISSING_TABLE.has(res.error.code)) return [];
    console.error(`[api/clients/export] ${section} read failed:`, res.error.code ?? res.error.message);
    throw new SiwsError(500, "Could not assemble the export — try again");
  }
  return Array.isArray(res.data) ? res.data : [];
}

function row(section: string, res: Result): unknown {
  if (res.error) {
    console.error(`[api/clients/export] ${section} read failed:`, res.error.code ?? res.error.message);
    throw new SiwsError(500, "Could not assemble the export — try again");
  }
  return res.data ?? null;
}

export async function POST(request: Request) {
  try {
    const { wallet, params, via } = await verifySigned(request, "clients.export");
    await requireAdmin(wallet);

    const clientId = assertUuid(params.client_id, "client_id");
    const sb = getSupabaseAdmin();
    const network = detectNetwork();
    const client = await fetchClientOr404(sb, clientId);
    const clientWallet = typeof client.wallet === "string" ? client.wallet : null;

    // The account the dossier belongs to, else the account its wallet is in.
    let accountId = typeof client.account_id === "string" ? client.account_id : null;
    if (!accountId && clientWallet) {
      const member = await sb
        .from("account_wallets")
        .select("account_id")
        .eq("network", network)
        .eq("wallet", clientWallet)
        .maybeSingle();
      const found = row("account membership", member) as { account_id?: unknown } | null;
      accountId = typeof found?.account_id === "string" ? found.account_id : null;
    }

    const tosFilter = ownerFilter(clientId, clientWallet, "wallet");
    const [
      details, documents, requirements, notes, tos, tosArchived, limits,
      waivers, conversions, deliveries, accessLog, passports, profile, accountWallets,
    ] = await Promise.all([
      sb.from("client_verification_details").select("*").eq("client_id", clientId),
      sb.from("client_documents").select("*").eq("client_id", clientId).order("created_at", { ascending: true }),
      sb.from("kyc_requirements").select("*").eq("client_id", clientId).order("requested_at", { ascending: true }),
      sb.from("client_notes").select("*").eq("client_id", clientId).order("created_at", { ascending: true }),
      sb.from("tos_acceptances").select("*").or(tosFilter).order("created_at", { ascending: true }),
      sb.from("tos_acceptance_duplicates").select("*").or(tosFilter).order("created_at", { ascending: true }),
      sb.from("client_raise_limits").select("*").eq("client_id", clientId).maybeSingle(),
      sb.from("fee_waivers").select("*").eq("client_id", clientId).eq("network", network),
      sb.from("conversion_requests").select("*").eq("network", network)
        .or(ownerFilter(clientId, clientWallet, "holder_wallet")).order("created_at", { ascending: true }),
      sb.from("delivery_requests").select("*").eq("network", network)
        .or(ownerFilter(clientId, clientWallet, "holder_wallet")).order("created_at", { ascending: true }),
      sb.from("audit_events").select("id,created_at,ix_name,reason,status,metadata")
        .eq("network", network).eq("category", "kyc").eq("target_label", clientId)
        .order("created_at", { ascending: true }),
      clientWallet
        ? sb.from("passport_requests").select("*").eq("wallet", clientWallet).order("created_at", { ascending: true })
        : Promise.resolve({ data: [], error: null }),
      accountId
        ? sb.from("account_profiles").select(ACCOUNT_COLUMNS).eq("id", accountId).eq("network", network).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      accountId
        ? sb.from("account_wallets").select("wallet,linked_at").eq("account_id", accountId).eq("network", network)
        : Promise.resolve({ data: [], error: null }),
    ]);

    // Fresh short-lived URLs for the stored files (private bucket only).
    type DocRow = { storage_path?: unknown; [key: string]: unknown };
    const docRows = rows("documents", documents) as DocRow[];
    const paths = docRows
      .map((d) => d.storage_path)
      .filter((p): p is string => typeof p === "string" && p.length > 0);
    const signed = new Map<string, string>();
    if (paths.length > 0) {
      const { data: urls, error: signError } = await sb.storage
        .from(PRIVATE_BUCKET)
        .createSignedUrls(paths, KYC_EXPORT_URL_TTL_S);
      if (signError) {
        console.error("[api/clients/export] signing failed:", signError.message);
        throw new SiwsError(500, "Could not sign the document links — try again");
      }
      for (const item of urls ?? []) {
        if (!item.error && item.path && item.signedUrl) signed.set(item.path, item.signedUrl);
      }
    }
    const generatedAt = new Date();
    const expiresAt = new Date(generatedAt.getTime() + KYC_EXPORT_URL_TTL_S * 1000).toISOString();
    const documentEntries = docRows.map((d) => {
      const url = typeof d.storage_path === "string" ? signed.get(d.storage_path) ?? null : null;
      return {
        ...d,
        download_url: url,
        download_url_expires_at: url ? expiresAt : null,
        ...(url ? {} : { download_unavailable: "file not in the private bucket" }),
      };
    });

    // The onboarding token is a live credential, never data to hand out.
    const clientRecord: Record<string, unknown> = { ...client };
    const tokenPresent = typeof clientRecord.onboarding_token === "string" && clientRecord.onboarding_token.length > 0;
    delete clientRecord.onboarding_token;
    clientRecord.onboarding_token_present = tokenPresent;

    const bundle = {
      format: CLIENT_EXPORT_FORMAT,
      generated_at: generatedAt.toISOString(),
      generated_by: wallet,
      network,
      client_id: clientId,
      client: clientRecord,
      verification_details: rows("verification details", details),
      documents: documentEntries,
      document_links_expire_in_seconds: KYC_EXPORT_URL_TTL_S,
      kyc_requirements: rows("requirements", requirements),
      notes: rows("notes", notes),
      tos_acceptances: rows("terms acceptances", tos),
      tos_acceptances_archived_duplicates: rows("archived terms acceptances", tosArchived, true),
      passport_requests: rows("passport requests", passports),
      account: accountId
        ? { profile: row("account profile", profile), wallets: rows("account wallets", accountWallets) }
        : null,
      raise_limits: row("raise limits", limits),
      fee_waivers: rows("fee waivers", waivers),
      conversion_requests: rows("conversion requests", conversions),
      delivery_requests: rows("delivery requests", deliveries),
      // When the dossier's documents and data were opened or exported. Which
      // operator did it stays internal (it is in the audit log).
      access_log: (rows("access log", accessLog) as Row[]).map((e) => {
        const meta = (e.metadata ?? {}) as Row;
        return {
          at: e.created_at,
          action: e.ix_name,
          status: e.status,
          document_id: meta.document_id ?? null,
          document_kind: meta.kind ?? null,
        };
      }),
      not_included: [
        {
          record: "compliance_alerts",
          why: "AML / sanctions screening records. Whether any of it may be disclosed to the data subject (tipping-off rules) is a compliance decision made case by case.",
        },
        {
          record: "launch_applications, commitments, otc_requests, resell_listings, custom_inquiries",
          why: "Keyed by wallet or email rather than by this dossier; export them separately when the request covers them.",
        },
        {
          record: "on-chain data",
          why: "Public on the Solana blockchain (passport entry, transactions); it cannot be exported as stored data or erased.",
        },
      ],
    };

    // Logged before anything leaves the server; a failed write throws 503.
    await writeServerAudit(sb, {
      ix_name: "kyc_data_export",
      category: "kyc",
      actor_wallet: wallet,
      actor_source: actorSourceOf(via),
      reason: "Exported the client's stored data (GDPR access / portability)",
      target_label: clientId,
      metadata: {
        client_id: clientId,
        actor_wallet: wallet,
        documents: documentEntries.length,
        document_links: signed.size,
        ttl: KYC_EXPORT_URL_TTL_S,
        format: CLIENT_EXPORT_FORMAT,
      },
    });
    await insertNote(
      sb,
      clientId,
      wallet,
      `Data export generated (${documentEntries.length} document link${documentEntries.length === 1 ? "" : "s"}, valid ${Math.round(KYC_EXPORT_URL_TTL_S / 60)} min).`,
      "system",
    );

    return NextResponse.json(
      { ok: true, data: bundle },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
