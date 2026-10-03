// The off-platform buy alert (D2, lib/server/onchain-link-check.ts) against the
// real schema, on an isolated PostgreSQL built from the migration chain: no
// migration of its own, so the row the code inserts must pass the existing
// compliance_alerts constraints (0005, 0072), its dedup key must hit 0072's
// unique index (23505 on a second insert), and every column the check reads
// must exist (the in-memory client of the unit tests does not know columns).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { LocalPostgres } from "./helpers/local-postgres";
import { applyMigrations, SUPABASE_PLATFORM_SQL } from "./helpers/migrations";

vi.mock("server-only", () => ({}));

import { ASSET_REGISTRY_PROGRAM_ADDRESS, getBuyInstructionDataEncoder } from "@/lib/generated/asset_registry";
import { buysOf, unlinkedBuyAlertRow, unlinkedBuySeverity, unlinkedBuySummary } from "@/lib/server/onchain-link-check";
import { buildTx } from "./helpers/chain-tx";

const db = new LocalPostgres();
const q = (sql: string) => db.query(sql);
const BUYER = "DAWSeqUCPJRJ3CFSm8hfwrsu1LdhrvEQGv9K2864pMpp";
const SALE = "Pc4auCy8Fnwxs7EcFwBGKqV3SudxCKEEDLHbEHujBpK";
const CLASS = "6t3xLqAFPZoE4mzWzxabrKxK8cGoHxAmaCj3MigJpWh5";
const MINT = "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2";
const SIG = "5".repeat(88);

/** The exact row raiseUnlinkedBuyAlert inserts, for a realistic buy. */
function row() {
  const { tx } = buildTx({ signature: SIG, instructions: [{ ix: {
    program: ASSET_REGISTRY_PROGRAM_ADDRESS, accounts: [BUYER, SALE, CLASS, MINT],
    data: new Uint8Array(getBuyInstructionDataEncoder().encode({ amount: BigInt(250) })),
  } }] });
  const [{ buys }] = buysOf(tx);
  return unlinkedBuyAlertRow({
    network: "devnet", signature: SIG, buyer: BUYER, clientId: null, severity: unlinkedBuySeverity("devnet"),
    summary: unlinkedBuySummary(BUYER, buys, "2026-07-18"),
    evidence: { check: "platform-link (D2)", buyer: BUYER, buys, buys_total: 1, terms_accepted: null, purchase_recorded: false },
  }, new Date().toISOString());
}
/** INSERT of a JS row through jsonb_populate_record: only its own columns, the rest keep their defaults. */
function insert(values: Record<string, unknown>) {
  const columns = Object.keys(values).join(", ");
  return q(`insert into public.compliance_alerts (${columns})
    select ${columns} from jsonb_populate_record(null::public.compliance_alerts, $j$${JSON.stringify(values)}$j$::jsonb)
    returning id`);
}

describe.skipIf(process.env.RUN_LOCAL_POSTGRES_TESTS !== "1")("off-platform buy alert (D2) on the real schema", () => {
  beforeAll(() => {
    db.initialize();
    try {
      q(SUPABASE_PLATFORM_SQL);
      applyMigrations(db, { network: "devnet" });
    } catch (error) {
      db.close();
      throw error;
    }
  }, 90_000);
  afterAll(() => db.close());

  it("the row passes every compliance_alerts constraint, opens for the wallet and enters the outbox", () => {
    const id = insert(row());
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(q(`select status||'|'||severity||'|'||coalesce(category,'aml')||'|'||notify_state||'|'||(next_notify_at <= now())||'|'||wallet
              from public.compliance_alerts where id = '${id}'`)).toBe(`open|medium|aml|pending|true|${BUYER}`);
    expect(q(`select evidence->'buys'->0->>'units' from public.compliance_alerts where id = '${id}'`)).toBe("250");
    // The passport gate's question (an unresolved alert names the wallet).
    expect(q(`select count(*) from public.compliance_alerts where network = 'devnet' and wallet = '${BUYER}'
              and status in ('open', 'escalated')`)).toBe("1");
    // The outbox marks it sent like any row.
    q(`select public.finish_alert_notifications('devnet', '[{"id":"${id}","severity":"medium"}]'::jsonb, true, null)`);
    expect(q(`select notify_state from public.compliance_alerts where id = '${id}'`)).toBe("sent");
  });

  it("a second insert of the same (transaction, buyer) is a unique violation (the code treats 23505 as raised)", () => {
    expect(() => insert(row())).toThrow(/duplicate key value violates unique constraint "compliance_alerts_dedup_once"/);
    expect(q(`select count(*) from public.compliance_alerts where dedup_key = '${row().dedup_key}'`)).toBe("1");
  });

  it("every column the check reads exists", () => {
    for (const sql of [
      `select wallet, version, created_at from public.tos_acceptances where wallet in ('${BUYER}')`,
      `select id from public.tos_acceptances where version = '2026-07-18' and created_at <= now() limit 1`,
      `select id from public.purchase_evidence_jobs where network = 'devnet' and signature = '${SIG}' and buyer = '${BUYER}' limit 1`,
      `select wallet from public.account_wallets where network = 'devnet' and wallet = '${BUYER}' limit 1`,
      `select id from public.clients where network = 'devnet' and wallet = '${BUYER}' order by created_at limit 1`,
      `select id from public.compliance_alerts where network = 'devnet' and dedup_key = '${row().dedup_key}' limit 1`,
    ]) expect(() => q(sql), sql).not.toThrow();
  });
});
