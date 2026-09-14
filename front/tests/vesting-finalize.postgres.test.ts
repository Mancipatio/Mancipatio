// Executes the real 0043 -> 0046 upgrade against a socket-only temporary DB.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LocalPostgres } from "./helpers/local-postgres";
const enabled = process.env.RUN_LOCAL_POSTGRES_TESTS === "1",
  db = new LocalPostgres();
const id = "10000000-0000-4000-8000-000000000001",
  hash = "a".repeat(64);
const sql = (q: string) => db.query(q);
describe.skipIf(!enabled)(
  "0046 stable vesting intents and review locking",
  () => {
    beforeAll(() => {
      try {
        db.initialize();
        sql(
          `create role anon;create role authenticated;create role service_role bypassrls;create table public.clients(id uuid primary key);create function public.touch_updated_at() returns trigger language plpgsql as $$begin new.updated_at=now();return new;end;$$;`,
        );
        sql(
          readFileSync(
            join(process.cwd(), "supabase/migrations/0043_vesting_series.sql"),
            "utf8",
          ),
        );
        sql(
          readFileSync(
            join(
              process.cwd(),
              "supabase/migrations/0046_vesting_finalize.sql",
            ),
            "utf8",
          ),
        );
      } catch (error) {
        db.close();
        throw error;
      }
    }, 30000);
    afterAll(() => db.close());
    beforeEach(() =>
      sql(
        `delete from public.vesting_creation_steps;delete from public.vesting_series;insert into public.vesting_series(id,network,client_wallet,token_mint,timing_mode,delivery_mode,schedule,recipients) values('${id}','devnet','wallet','mint','auto','claim','[{"unlock_ts":2000000000,"amount":"10"}]','[{"wallet":"holder","allocation":"10"}]');`,
      ),
    );
    function approve() {
      sql(
        `update public.vesting_series set status='approved',approved_terms_hash='${hash}' where id='${id}';`,
      );
    }
    function prepare(seriesId = "18446744073709551615", pda = "series") {
      return `update public.vesting_series set series_id='${seriesId}',series_pda='${pda}',escrow='escrow',creation_terms_hash='${hash}',creation_prepared_at=now() where id='${id}' and creation_prepared_at is null returning series_id;`;
    }
    it("requires an approval hash, locks all terms and preserves exact u64 ids", () => {
      expect(() =>
        sql(
          `update public.vesting_series set status='approved' where id='${id}';`,
        ),
      ).toThrow(/canonical terms hash/);
      approve();
      expect(sql(prepare())).toBe("18446744073709551615");
      for (const assignment of [
        "network='mainnet'",
        "client_wallet='other'",
        "token_mint='other'",
        "approval_window_secs=5",
        "recipients='[]'::jsonb",
        "schedule='[]'::jsonb",
        "pre_cliff_bps=500",
        "recovery_enabled=true",
        "cancellation_enabled=true",
        "delivery_mode='push'",
      ])
        expect(() =>
          sql(
            `update public.vesting_series set ${assignment} where id='${id}';`,
          ),
        ).toThrow(/terms are locked/);
      expect(() =>
        sql(`update public.vesting_series set series_id='2' where id='${id}';`),
      ).toThrow(/intent is immutable/);
      expect(() =>
        sql(
          `update public.vesting_series set approved_terms_hash='${"b".repeat(64)}' where id='${id}';`,
        ),
      ).toThrow(/hash is immutable/);
    });
    it("concurrent prepare attempts persist exactly one intent", async () => {
      approve();
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          db.queryAsync(prepare(String(i + 1), `series-${i}`)),
        ),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(
        sql(
          "select count(*) from public.vesting_series where creation_prepared_at is not null;",
        ),
      ).toBe("1");
    });
    it("requires prepared intent and receipt for creation but allows aborting an incomplete Draft", () => {
      approve();
      expect(() =>
        sql(
          `update public.vesting_series set status='created',created_tx='sig' where id='${id}';`,
        ),
      ).toThrow(/prepared intent/);
      sql(prepare());
      expect(() =>
        sql(
          `update public.vesting_series set status='created' where id='${id}';`,
        ),
      ).toThrow(/receipt/);
      sql(
        `update public.vesting_series set status='cancelled',cancelled_tx='cancel' where id='${id}';`,
      );
      expect(() =>
        sql(
          `update public.vesting_series set status='approved' where id='${id}';`,
        ),
      ).toThrow(/illegal/);
    });
    it("stores creation receipts once per network and denies anonymous reads/writes", () => {
      approve();
      sql(prepare());
      sql(
        `insert into public.vesting_creation_steps(request_id,network,step_key,signature) values('${id}','devnet','create','sig');`,
      );
      expect(() =>
        sql(
          `insert into public.vesting_creation_steps(request_id,network,step_key,signature) values('${id}','devnet','finalize','sig');`,
        ),
      ).toThrow(/duplicate/);
      expect(() =>
        sql("set role anon;select * from public.vesting_creation_steps;"),
      ).toThrow(/permission denied/);
      expect(() =>
        sql(
          `set role authenticated;insert into public.vesting_creation_steps(request_id,network,step_key,signature) values('${id}','devnet','create','bad');`,
        ),
      ).toThrow(/permission denied/);
    });
    it("lets an earlier approval without a hash return to review without altering its reviewed terms", () => {
      sql(
        `alter table public.vesting_series disable trigger vesting_series_status_guard;update public.vesting_series set status='approved' where id='${id}';alter table public.vesting_series enable trigger vesting_series_status_guard;`,
      );
      sql(
        `update public.vesting_series set status='needs_changes' where id='${id}';update public.vesting_series set status='submitted',token_label='revised' where id='${id}';`,
      );
      approve();
      expect(
        sql(`select token_label from public.vesting_series where id='${id}';`),
      ).toBe("revised");
    });
  },
);
