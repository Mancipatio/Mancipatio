// POST /api/archive/set — archive or unarchive an asset or issuer (soft
// delete, off chain; lib/archive.ts). Signed ("archive.set").
//
// params: { kind: "asset" | "issuer", pda, archive: boolean, reason, confirm? }
//
//   asset  — super admin, or the asset's issuer authority for its own Draft /
//            never-minted asset (lib/server/archive-actions). An Open sale, a
//            live sale approval or circulating supply refuse the archive
//            unless the SUPER admin sends `confirm: true` (409 says why); the
//            confirmed blockers are kept with the record. The row:
//            status 'archived', is_published false, fields.archive = record;
//            unarchive restores the previous status (or removes a row the
//            archive created). In KYC-only mode an issuer's unarchive that
//            would re-publish the profile answers 403 (a publish is an
//            issuance entry, as on profiles/upsert); archiving stays open.
//   issuer — super admin only; refused while an asset of it that is not
//            archived has tokens in circulation. issuer_profiles.archive
//            (migration 0081); 503 with a plain message before 0081 exists.
//
// Every change writes a server audit event (assets / issuers). If the audit
// row cannot be written the change is undone and the route answers 503, so
// no archive exists without its audit trail. Nothing on chain is touched:
// the optional lock at 0 is a separate, admin-signed lock_supply.
import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireSuperAdmin } from "@/lib/server/admin-gate";
import { actorSourceOf, writeServerAudit } from "@/lib/server/audit";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";
import {
  ISSUER_ARCHIVE_UNAVAILABLE,
  assetArchiveState,
  issuerArchiveState,
  readKind,
  readPda,
} from "@/lib/server/archive-actions";
import { isMissingArchiveColumn } from "@/lib/server/archive";
import { assetArchiveRecord, checkArchiveReason, unarchiveRepublishes, type ArchiveRecord } from "@/lib/archive";
import { requireArea } from "@/lib/server/feature-gate";

type Undo = () => Promise<unknown>;

export async function POST(request: Request) {
  try {
    const { wallet, params, via } = await verifySigned(request, "archive.set");
    const kind = readKind(params.kind);
    const pda = readPda(params.pda);
    if (typeof params.archive !== "boolean") throw new SiwsError(400, "archive must be true or false");
    const archive = params.archive;
    const reasonCheck = checkArchiveReason(params.reason);
    if (!reasonCheck.ok) throw new SiwsError(400, reasonCheck.error);
    const reason = reasonCheck.reason;
    const confirm = params.confirm === true;
    const sb = getSupabaseAdmin();
    const network = detectNetwork();
    const now = new Date();
    let undo: Undo;
    let audit: { ix_name: string; category: "assets" | "issuers"; metadata: Record<string, unknown> };

    if (kind === "asset") {
      const state = await assetArchiveState(sb, wallet, pda);
      if (state.actor === "admin") throw new SiwsError(403, "Only the super admin or the asset's issuer can archive it");
      const fields = { ...(state.row?.fields ?? {}) };
      if (archive) {
        if (state.archived) throw new SiwsError(409, "This asset is already archived");
        if (state.actor === "issuer" && state.refusal) throw new SiwsError(403, state.refusal);
        if (state.blockers.length && !confirm) {
          throw new SiwsError(409, `Confirm explicitly to archive anyway — ${state.blockers.map((b) => b.message).join(" ")}`);
        }
        const record = assetArchiveRecord({
          reason, wallet, now, existing: state.row, overridden: state.blockers.map((b) => b.code),
        });
        if (state.row) {
          const before = { status: state.row.status, is_published: state.row.is_published, fields: state.row.fields };
          const { error } = await sb.from("asset_profiles")
            .update({ status: "archived", is_published: false, fields: { ...fields, archive: record } })
            .eq("network", network).eq("asset_pda", pda);
          if (error) throw new SiwsError(500, "Archive not saved — try again");
          undo = () => Promise.resolve(sb.from("asset_profiles").update(before).eq("network", network).eq("asset_pda", pda));
        } else {
          const { error } = await sb.from("asset_profiles").insert({
            network, asset_pda: pda, issuer_pda: state.chain.issuer, category: "other",
            display_name: state.chain.name, status: "archived", is_published: false,
            fields: { archive: record }, created_by: wallet,
          });
          if (error) throw new SiwsError(500, "Archive not saved — try again");
          undo = () => Promise.resolve(sb.from("asset_profiles").delete().eq("network", network).eq("asset_pda", pda));
        }
        audit = {
          ix_name: "asset_archive",
          category: "assets",
          metadata: {
            network, asset_name: state.chain.name, asset_id: state.chain.assetId, issuer_pda: state.chain.issuer,
            overridden: record.overridden ?? [], row_created: record.row_created === true, actor: state.actor,
          },
        };
      } else {
        if (!state.archived || !state.row) throw new SiwsError(409, "This asset is not archived");
        if (!state.canUnarchive) throw new SiwsError(403, state.unarchiveRefusal ?? "You cannot unarchive this asset");
        // KYC-only mode (lib/features.ts): an issuer's unarchive that puts a
        // published profile back on the public lists is an issuance entry
        // (assetArchiveState refuses it already; the route does not rely on it).
        if (state.actor === "issuer" && unarchiveRepublishes(state.record)) requireArea("issuance");
        const record = state.record;
        const before = { status: state.row.status, is_published: state.row.is_published, fields: state.row.fields };
        if (record?.row_created) {
          const { error } = await sb.from("asset_profiles").delete().eq("network", network).eq("asset_pda", pda);
          if (error) throw new SiwsError(500, "Unarchive not saved — try again");
          undo = () => Promise.resolve(sb.from("asset_profiles").insert({
            network, asset_pda: pda, issuer_pda: state.chain.issuer, category: "other",
            display_name: state.chain.name, ...before, created_by: record.archived_by,
          }));
        } else {
          const rest = { ...fields };
          delete rest.archive;
          const { error } = await sb.from("asset_profiles")
            .update({
              status: record?.previous_status ?? "draft",
              is_published: unarchiveRepublishes(record),
              fields: rest,
            })
            .eq("network", network).eq("asset_pda", pda);
          if (error) throw new SiwsError(500, "Unarchive not saved — try again");
          undo = () => Promise.resolve(sb.from("asset_profiles").update(before).eq("network", network).eq("asset_pda", pda));
        }
        audit = {
          ix_name: "asset_unarchive",
          category: "assets",
          metadata: {
            network, asset_name: state.chain.name, asset_id: state.chain.assetId, issuer_pda: state.chain.issuer,
            archived_by: record?.archived_by ?? null, archived_at: record?.archived_at ?? null, actor: state.actor,
          },
        };
      }
    } else {
      await requireSuperAdmin(wallet);
      const state = await issuerArchiveState(sb, wallet, pda);
      if (!state.available) throw new SiwsError(503, ISSUER_ARCHIVE_UNAVAILABLE);
      if (archive) {
        if (state.archived) throw new SiwsError(409, "This issuer is already archived");
        if (state.blockers.length) throw new SiwsError(409, state.blockers.map((b) => b.message).join(" "));
        const record: ArchiveRecord = {
          reason, archived_by: wallet, archived_at: now.toISOString(), row_created: !state.rowExists,
        };
        const write = state.rowExists
          ? await sb.from("issuer_profiles").update({ archive: record }).eq("network", network).eq("issuer_pda", pda)
          : await sb.from("issuer_profiles").insert({ network, issuer_pda: pda, archive: record, created_by: wallet });
        if (write.error) {
          if (isMissingArchiveColumn(write.error)) throw new SiwsError(503, ISSUER_ARCHIVE_UNAVAILABLE);
          throw new SiwsError(500, "Archive not saved — try again");
        }
        undo = () => Promise.resolve(state.rowExists
          ? sb.from("issuer_profiles").update({ archive: null }).eq("network", network).eq("issuer_pda", pda)
          : sb.from("issuer_profiles").delete().eq("network", network).eq("issuer_pda", pda));
        audit = { ix_name: "issuer_archive", category: "issuers", metadata: { network, row_created: !state.rowExists } };
      } else {
        if (!state.archived || !state.record) throw new SiwsError(409, "This issuer is not archived");
        const record = state.record;
        // The row stays (an admin may have filled the onboarding profile since
        // the archive created it); only the record is cleared.
        const write = await sb.from("issuer_profiles").update({ archive: null }).eq("network", network).eq("issuer_pda", pda);
        if (write.error) throw new SiwsError(500, "Unarchive not saved — try again");
        undo = () => Promise.resolve(sb.from("issuer_profiles").update({ archive: record }).eq("network", network).eq("issuer_pda", pda));
        audit = {
          ix_name: "issuer_unarchive",
          category: "issuers",
          metadata: { network, archived_by: record.archived_by, archived_at: record.archived_at },
        };
      }
    }

    try {
      await writeServerAudit(sb, {
        ...audit,
        actor_wallet: wallet,
        actor_source: actorSourceOf(via),
        reason,
        target_label: pda,
      });
    } catch {
      // No archive without its audit trail: undo the write and say so.
      try { await undo(); } catch (undoErr) {
        console.error("[api/archive/set] undo after audit failure failed:", undoErr instanceof Error ? undoErr.message : String(undoErr));
      }
      throw new SiwsError(503, "Audit log unavailable — nothing was changed; try again");
    }

    return NextResponse.json({ ok: true, data: { kind, pda, archived: archive } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
