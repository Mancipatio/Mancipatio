// Applies the repository's migration files to an isolated test cluster the
// way the rollout does: the deployment identity row (scripts/ops/
// deployment-identity.sql, with the psql variables db.sh passes) goes in right
// after 0070, so 0071 and every later migration see a configured project.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PsqlVariables } from "./local-postgres";

export type TestNetwork = "mainnet" | "devnet" | "testnet" | "localnet";
type Database = { query(sql: string, vars?: PsqlVariables): string };

export const MIGRATIONS_DIR = join(process.cwd(), "supabase/migrations");
export const IDENTITY_SQL = join(process.cwd(), "scripts/ops/deployment-identity.sql");
/** Refs only need the Supabase format here; tests never reach a project. */
export const TEST_PROJECT_REFS: Record<TestNetwork, string> = {
  devnet: "devnettestprojectref",
  mainnet: "mainnettestproject01",
  testnet: "testnettestproject01",
  localnet: "localnettestproject1",
};

/** Every numbered migration file, in apply order. */
export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+.*\.sql$/.test(f)).sort();
}

export function migrationNumber(file: string): number {
  return Number.parseInt(file, 10);
}

/** Inserts the identity row through the real ops script. */
export function insertDeploymentIdentity(db: Database, network: TestNetwork, projectRef = TEST_PROJECT_REFS[network]) {
  return db.query(readFileSync(IDENTITY_SQL, "utf8"), { target_network: network, target_ref: projectRef });
}

/**
 * Applies `files` (default: all) in order and returns them. When 0070 is among
 * them, the identity for `network` is inserted right after it.
 */
export function applyMigrations(
  db: Database,
  options: { network: TestNetwork; projectRef?: string; files?: string[] },
): string[] {
  const applied: string[] = [];
  for (const file of options.files ?? migrationFiles()) {
    try {
      db.query(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    } catch (error) {
      throw new Error(`Migration ${file} failed: ${error instanceof Error ? error.message : error}`);
    }
    applied.push(file);
    if (migrationNumber(file) === 70) insertDeploymentIdentity(db, options.network, options.projectRef);
  }
  return applied;
}

/** The platform model the full-chain suites share: Supabase's API roles, the
 * platform-owned Storage schema and its default grants. Everything else comes
 * from the actual migrations. */
export const SUPABASE_PLATFORM_SQL = `create role anon;create role authenticated;create role service_role bypassrls;
  create schema storage;
  create table storage.buckets(id text primary key,name text,public boolean default false,file_size_limit bigint,allowed_mime_types text[]);
  create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text);
  alter table storage.objects enable row level security;
  grant usage on schema public,storage to anon,authenticated,service_role;
  alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
  alter default privileges in schema public grant all on sequences to anon,authenticated,service_role;
  grant all on storage.objects,storage.buckets to service_role;
  grant all on storage.objects to anon,authenticated;`;

/** The 33 `network` columns whose literal 'devnet' default 0071 replaces. */
export const DYNAMIC_DEFAULT_TABLES = [
  "audit_events",
  "platforms", "issuers", "assets", "share_classes", "sales", "custody_vaults", "offers", "proposals",
  "vote_records", "rights_issuances", "milestones", "milestone_claims", "indexer_events",
  "clients",
  "fee_config", "fee_waivers",
  "compliance_alerts",
  "asset_profiles",
  "issuer_profiles",
  "spvs",
  "delivery_requests",
  "resell_listings",
  "custom_inquiries",
  "otc_requests",
  "conversion_requests",
  "kyc_registries", "kyc_entries",
  "vesting_series",
  "commitments",
  "launch_applications", "launch_listings", "launch_updates",
] as const;

/** New `network` columns after 0071 (rule 1: default public.deployment_network()). */
export const POST_0071_DYNAMIC_DEFAULT_TABLES = [
  // 0072 on-chain alarms
  "onchain_event_jobs", "worker_leases", "worker_heartbeats", "alarm_incidents",
  // 0073 ledger jobs and holds
  "spv_issuance_jobs", "sale_capacity_holds",
  // 0075 indexer freshness heartbeat
  "indexer_heartbeat_state", "indexer_heartbeat_watermarks",
] as const;

/** Every `network` column that defaults to public.deployment_network(). */
export const ALL_DYNAMIC_DEFAULT_TABLES = [...DYNAMIC_DEFAULT_TABLES, ...POST_0071_DYNAMIC_DEFAULT_TABLES] as const;
