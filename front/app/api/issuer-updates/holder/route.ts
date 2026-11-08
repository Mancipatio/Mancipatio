// POST /api/issuer-updates/holder — the published updates, public and
// holders-only, of the assets the signer holds. Signed
// "issuerUpdates.holderRead" (a session read, lib/siws-session.ts).
//
// params: { assets: [<Asset PDA>, …] } (1–20): what the page believes the
// wallet holds. Nothing is taken on trust: verifyHeldAssets reads each asset,
// its share classes and the wallet's Token-2022 balances on chain now, and
// only assets with a balance above zero count (an RPC failure is a 503,
// never a holding). For those assets the answer has their own updates and the
// issuer-wide updates of their issuers (the issuer read from chain), each with
// via_asset, the held asset that lets the wallet read it (sent back to open a
// document), newest first, at most HOLDER_LIMIT. A wallet that holds none of
// them gets holder_assets [] and no update. Drafts and withdrawn updates
// never appear. Open in KYC-only mode (a read).
import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse } from "@/lib/server/siws";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";
import { byPublicationDesc, type HolderIssuerUpdate } from "@/lib/issuer-updates";
import {
  UPDATES_TABLE,
  UPDATE_COLUMNS,
  loadDocuments,
  readHolderAssets,
  toPublic,
  unavailable,
  verifyHeldAssets,
  type IssuerUpdateRow,
} from "@/lib/server/issuer-updates";

// One chain read per asset and its classes, and the balances: room for a slow RPC.
export const maxDuration = 30;

const HOLDER_LIMIT = 50;

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "issuerUpdates.holderRead");
    const assets = readHolderAssets(params.assets);
    const held = await verifyHeldAssets(wallet, assets);
    const answer = (updates: HolderIssuerUpdate[]) => NextResponse.json(
      { ok: true, data: { holder_assets: held.map((h) => h.asset), updates } },
      { headers: { "Cache-Control": "private, no-store" } },
    );
    if (held.length === 0) return answer([]);

    const issuerOf = new Map(held.map((h) => [h.asset, h.issuer]));
    // The first held asset of each issuer qualifies the wallet for its issuer-wide updates.
    const viaIssuer = new Map<string, string>();
    for (const h of held) if (!viaIssuer.has(h.issuer)) viaIssuer.set(h.issuer, h.asset);

    const sb = getSupabaseAdmin(AbortSignal.timeout(8_000));
    const published = () => sb.from(UPDATES_TABLE).select(UPDATE_COLUMNS)
      .eq("network", detectNetwork()).eq("status", "published");
    const [own, wide] = await Promise.all([
      published().in("asset_pda", [...issuerOf.keys()]).order("published_at", { ascending: false }).limit(HOLDER_LIMIT),
      published().is("asset_pda", null).in("issuer_pda", [...viaIssuer.keys()])
        .order("published_at", { ascending: false }).limit(HOLDER_LIMIT),
    ]);
    if (own.error || wide.error) unavailable();
    // An asset's update counts only under the asset's issuer on chain (the
    // write routes ensure it; a read never relies on that alone).
    const rows = [
      ...((own.data ?? []) as unknown as IssuerUpdateRow[]).filter((r) => r.asset_pda && issuerOf.get(r.asset_pda) === r.issuer_pda),
      ...((wide.data ?? []) as unknown as IssuerUpdateRow[]).filter((r) => r.asset_pda === null && viaIssuer.has(r.issuer_pda)),
    ].sort(byPublicationDesc).slice(0, HOLDER_LIMIT);

    const docs = await loadDocuments(sb, rows.map((r) => r.id));
    const updates = rows.flatMap((r): HolderIssuerUpdate[] => {
      const update = toPublic(r, docs.get(r.id));
      const via = r.asset_pda ?? viaIssuer.get(r.issuer_pda);
      return update && via ? [{ ...update, via_asset: via }] : [];
    });
    return answer(updates);
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
