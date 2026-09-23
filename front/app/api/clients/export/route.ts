// POST /api/clients/export — GDPR access / portability export of ONE dossier:
// a JSON bundle of what the platform stores about the client.
// Signed with a fresh wallet signature (NOT a session read — this releases a
// whole dossier) + requireAdmin. Action: "clients.export".
// Params: { client_id }. Client half: lib/clients.ts adminExportClient().
//
// The bundle holds the clients row (without the onboarding token, which is a
// credential), client_verification_details, client_documents metadata with
// fresh signed URLs (KYC_EXPORT_URL_TTL_S; a pre-P1 file still in the old
// public bucket gets the same short-lived link, marked `stored_in`),
// kyc_requirements, client_notes, the linked account (profile + wallets),
// raise-limit override, fee waivers, SPVs and vesting series linked to the
// dossier, and — matched by the dossier
// OR by any of the person's wallets (the dossier's wallet plus every wallet of
// its account) — Terms acceptances (including archived duplicates), passport
// requests, conversion and delivery requests. Plus the access log: when "kyc"
// audit rows targeting the dossier were written (document views, exports,
// erasures).
//
// Operator identities: every column naming the staff member who acted
// (author, uploaded_by, requested_by, decided_by, …) reads "operator" unless
// it is one of the person's own wallets, and the exporting admin is not named
// (GDPR art. 15(4): staff wallets are other people's data; the audit log keeps
// who did what). Free text — note bodies, a request's admin_note — is not
// rewritten and must be reviewed before handover. What is deliberately NOT
// included is listed in the bundle's `not_included` section.
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
import {
  LEGACY_KYC_BUCKET,
  isRepositoryPath,
  ownerFilter,
  redactOperators,
  walletSet,
} from "../_privacy";

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

    // Every wallet of the person: the dossier's plus its account's.
    const accountWallets = accountId
      ? await sb.from("account_wallets").select("wallet,linked_at").eq("account_id", accountId).eq("network", network)
      : { data: [], error: null };
    const accountWalletRows = rows("account wallets", accountWallets) as Row[];
    const wallets = walletSet([clientWallet, ...accountWalletRows.map((w) => w.wallet)]);
    const ownWallets = new Set(wallets);

    const tosFilter = ownerFilter(clientId, wallets, "wallet");
    const [
      details, documents, requirements, notes, tos, tosArchived, limits,
      waivers, conversions, deliveries, accessLog, passports, profile, spvs, vestingSeries,
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
        .or(ownerFilter(clientId, wallets, "holder_wallet")).order("created_at", { ascending: true }),
      sb.from("delivery_requests").select("*").eq("network", network)
        .or(ownerFilter(clientId, wallets, "holder_wallet")).order("created_at", { ascending: true }),
      sb.from("audit_events").select("id,created_at,ix_name,reason,status,metadata")
        .eq("network", network).eq("category", "kyc").eq("target_label", clientId)
        .order("created_at", { ascending: true }),
      wallets.length > 0
        ? sb.from("passport_requests").select("*").in("wallet", wallets).order("created_at", { ascending: true })
        : Promise.resolve({ data: [], error: null }),
      accountId
        ? sb.from("account_profiles").select(ACCOUNT_COLUMNS).eq("id", accountId).eq("network", network).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      sb.from("spvs").select("*").eq("network", network).eq("client_id", clientId).order("created_at", { ascending: true }),
      sb.from("vesting_series").select("*").eq("network", network)
        .or(ownerFilter(clientId, wallets, "client_wallet")).order("created_at", { ascending: true }),
    ]);

    // Fresh short-lived URLs for the stored files (private bucket only).
    type DocRow = { storage_path?: unknown; [key: string]: unknown };
    const docRows = rows("documents", documents) as DocRow[];
    const paths = docRows
      .map((d) => d.storage_path)
      .filter((p): p is string => typeof p === "string" && p.length > 0);
    const signed = new Map<string, string>();
    const legacy = new Set<string>();
    const sign = async (bucket: string, list: string[]) => {
      if (list.length === 0) return;
      const { data: urls, error: signError } = await sb.storage
        .from(bucket)
        .createSignedUrls(list, KYC_EXPORT_URL_TTL_S);
      if (signError) {
        console.error("[api/clients/export] signing failed:", signError.message);
        throw new SiwsError(500, "Could not sign the document links — try again");
      }
      for (const item of urls ?? []) {
        if (!item.error && item.path && item.signedUrl) signed.set(item.path, item.signedUrl);
      }
    };
    await sign(PRIVATE_BUCKET, paths);
    // Pre-P1 files still in the old public bucket are the client's data too:
    // same short-lived signed link (never a repository-folder path).
    const legacyPaths = paths.filter((p) => !signed.has(p) && !isRepositoryPath(p));
    await sign(LEGACY_KYC_BUCKET, legacyPaths);
    for (const p of legacyPaths) if (signed.has(p)) legacy.add(p);
    const generatedAt = new Date();
    const expiresAt = new Date(generatedAt.getTime() + KYC_EXPORT_URL_TTL_S * 1000).toISOString();
    const documentEntries = docRows.map((d) => {
      const path = typeof d.storage_path === "string" ? d.storage_path : null;
      const url = path ? signed.get(path) ?? null : null;
      return {
        ...d,
        download_url: url,
        download_url_expires_at: url ? expiresAt : null,
        ...(path && legacy.has(path) ? { stored_in: "legacy public bucket (to be moved)" } : {}),
        ...(url ? {} : { download_unavailable: "file not found in storage" }),
      };
    });

    // The onboarding token is a live credential, never data to hand out.
    const clientRecord: Record<string, unknown> = { ...client };
    const tokenPresent = typeof clientRecord.onboarding_token === "string" && clientRecord.onboarding_token.length > 0;
    delete clientRecord.onboarding_token;
    clientRecord.onboarding_token_present = tokenPresent;

    // Staff wallets read "operator" everywhere (see the header).
    const own = <T,>(value: T): T => redactOperators(value, ownWallets);
    const bundle = {
      format: CLIENT_EXPORT_FORMAT,
      generated_at: generatedAt.toISOString(),
      network,
      client_id: clientId,
      client: own(clientRecord),
      verification_details: own(rows("verification details", details)),
      documents: own(documentEntries),
      document_links_expire_in_seconds: KYC_EXPORT_URL_TTL_S,
      kyc_requirements: own(rows("requirements", requirements)),
      notes: own(rows("notes", notes)),
      tos_acceptances: rows("terms acceptances", tos),
      tos_acceptances_archived_duplicates: rows("archived terms acceptances", tosArchived, true),
      passport_requests: own(rows("passport requests", passports)),
      account: accountId
        ? { profile: own(row("account profile", profile)), wallets: accountWalletRows }
        : null,
      raise_limits: own(row("raise limits", limits)),
      fee_waivers: own(rows("fee waivers", waivers)),
      conversion_requests: own(rows("conversion requests", conversions)),
      delivery_requests: own(rows("delivery requests", deliveries)),
      spvs: own(rows("spvs", spvs)),
      vesting_series: own(rows("vesting series", vestingSeries)),
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
        {
          record: "operator identities",
          why: "Staff wallets are shown as \"operator\" (they are other people's data); the audit log keeps who did what. Note bodies and admin notes are free text written by staff — review them before handing this file over.",
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
