#!/usr/bin/env node
/**
 * Ops targets: which Supabase project (and site) an ops tool acts on.
 *
 * scripts/ops/targets.json is tracked (project refs are public, D11). Every
 * ops tool (scripts/db.sh, scripts/ops/maintenance.sh, backup.sh,
 * supabase.sh, the live smoke and reconcile runners) resolves its target
 * here, and db.sh re-checks it against the database's own identity row
 * (scripts/ops/assert-target.sql) before any SQL runs.
 *
 * Usage:
 *   node scripts/ops/target.mjs <target>                  → network|projectRef|poolerHost|poolerPort|siteOrigin
 *   node scripts/ops/target.mjs <target> --age-recipient  → backupAgeRecipient
 * A null value prints as "-". Exit 1 on any refusal (invalid file, unknown
 * or unconfigured target, a mainnet target without MANCI_ALLOW_MAINNET=1),
 * 2 on a usage error. Messages never contain credentials: this file holds
 * none, and nothing else is read.
 */
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const NETWORKS = ["mainnet", "devnet", "testnet", "localnet"];
export const TARGETS_FILE = join(dirname(fileURLToPath(import.meta.url)), "targets.json");

const FIELDS = ["backupAgeRecipient", "network", "poolerHost", "poolerPort", "projectRef", "siteOrigin"];
const TARGET_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const PROJECT_REF = /^[a-z0-9]{20}$/;
const HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
/** The same rule scripts/ops/retry-scheduler.sql applies: https, a host, no port or path. */
export const SITE_ORIGIN = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const AGE_RECIPIENT = /^age1[02-9ac-hj-np-z]{58}$/;

export class TargetError extends Error {
  constructor(message) {
    super(message);
    this.name = "TargetError";
  }
}

/** Validates the whole file; returns it unchanged. */
export function validateTargets(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TargetError("targets.json must be an object of named targets");
  }
  const refs = new Map();
  const origins = new Map();
  for (const [name, target] of Object.entries(raw)) {
    if (!TARGET_NAME.test(name)) throw new TargetError(`Invalid target name "${name}"`);
    if (!target || typeof target !== "object" || Array.isArray(target)) {
      throw new TargetError(`Target ${name} must be an object`);
    }
    const fields = Object.keys(target).sort();
    if (fields.join(",") !== FIELDS.join(",")) {
      throw new TargetError(`Target ${name} must have exactly these fields: ${FIELDS.join(", ")}`);
    }
    if (!NETWORKS.includes(target.network)) {
      throw new TargetError(`Target ${name}: network must be one of ${NETWORKS.join(", ")}`);
    }
    // A target named after a network is that network: "devnet" can never be mainnet.
    if (NETWORKS.includes(name) && target.network !== name) {
      throw new TargetError(`Target ${name} must have network "${name}"`);
    }
    if (target.projectRef !== null) {
      if (typeof target.projectRef !== "string" || !PROJECT_REF.test(target.projectRef)) {
        throw new TargetError(`Target ${name}: projectRef must be 20 lowercase letters or digits, or null`);
      }
      if (refs.has(target.projectRef)) {
        throw new TargetError(`Targets ${refs.get(target.projectRef)} and ${name} share a projectRef`);
      }
      refs.set(target.projectRef, name);
    }
    if (target.poolerHost !== null && (typeof target.poolerHost !== "string" || !HOST.test(target.poolerHost))) {
      throw new TargetError(`Target ${name}: poolerHost must be a host name, or null`);
    }
    if (target.poolerPort !== 5432) {
      throw new TargetError(
        `Target ${name}: poolerPort must be 5432 (the session pooler; the ops scripts rely on session-level settings)`,
      );
    }
    if (target.siteOrigin !== null) {
      if (typeof target.siteOrigin !== "string" || !SITE_ORIGIN.test(target.siteOrigin)) {
        throw new TargetError(`Target ${name}: siteOrigin must be https://<host> with no port or path, or null`);
      }
      if (origins.has(target.siteOrigin)) {
        throw new TargetError(`Targets ${origins.get(target.siteOrigin)} and ${name} share a siteOrigin`);
      }
      origins.set(target.siteOrigin, name);
    }
    if (target.backupAgeRecipient !== null
      && (typeof target.backupAgeRecipient !== "string" || !AGE_RECIPIENT.test(target.backupAgeRecipient))) {
      throw new TargetError(`Target ${name}: backupAgeRecipient must be an age1… public key, or null`);
    }
  }
  return raw;
}

export function loadTargets(file = TARGETS_FILE) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new TargetError("scripts/ops/targets.json is missing or not valid JSON");
  }
  return validateTargets(raw);
}

/**
 * The named target, ready to connect to. Refuses an unknown target, a mainnet
 * target without MANCI_ALLOW_MAINNET=1, and a target whose project is not
 * recorded yet (null projectRef or poolerHost).
 * @param {Record<string, any>} targets
 * @param {string | undefined} name
 * @param {Record<string, string | undefined>} [env]
 */
export function resolveTarget(targets, name, env = process.env) {
  if (!name) {
    throw new TargetError("No target given. Set MANCI_TARGET (see scripts/ops/targets.json); there is no default.");
  }
  if (!Object.hasOwn(targets, name)) {
    throw new TargetError(`Unknown target "${name}". Known: ${Object.keys(targets).join(", ")}`);
  }
  const target = targets[name];
  if (target.network === "mainnet" && env.MANCI_ALLOW_MAINNET !== "1") {
    throw new TargetError(`Target ${name} is a mainnet project: set MANCI_ALLOW_MAINNET=1 for this command`);
  }
  if (target.projectRef === null || target.poolerHost === null) {
    throw new TargetError(`Target ${name} is not configured yet (projectRef or poolerHost is null in scripts/ops/targets.json)`);
  }
  return target;
}

/** network|projectRef|poolerHost|poolerPort|siteOrigin, "-" for null. */
export function targetLine(target) {
  return [target.network, target.projectRef, target.poolerHost, target.poolerPort, target.siteOrigin]
    .map((value) => (value === null ? "-" : String(value)))
    .join("|");
}

function main(args) {
  const [name, option, ...rest] = args;
  if (!name || rest.length > 0 || (option !== undefined && option !== "--age-recipient")) {
    process.stderr.write("usage: node scripts/ops/target.mjs <target> [--age-recipient]\n");
    return 2;
  }
  try {
    const target = resolveTarget(loadTargets(), name);
    process.stdout.write(`${option ? (target.backupAgeRecipient ?? "-") : targetLine(target)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`target: ${error instanceof TargetError ? error.message : "unexpected error"}\n`);
    return 1;
  }
}

/** Run as a script (not imported). Node resolves symlinks in the main module's
 * URL, so compare real paths: a checkout under a symlinked directory (macOS
 * /var → /private/var) must still run main(). */
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  process.exitCode = main(process.argv.slice(2));
}
