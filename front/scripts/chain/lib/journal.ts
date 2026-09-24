/**
 * Per-network lock and append-only, fsync'd JSONL journal (design-3.3 §3.7).
 *
 * The lock `<stateDir>/<network>-<genesis[0..8]>.lock` is created with `wx`.
 * It is removed only after every journalled signature is resolved; a leftover
 * lock blocks every send run on that network until `CHAIN_RECOVER=1` resolves
 * the in-flight signatures.
 */
import fs from "node:fs";
import path from "node:path";
import { ChainGateError } from "./safety";

export type JournalEventName =
  | "plan"
  | "simulated"
  | "signed"
  | "sent"
  | "status"
  | "post-check"
  | "abort"
  | "recover"
  | "buffer";

export type JournalEvent = {
  t: string;
  event: JournalEventName;
  step?: string;
  sig?: string;
  lastValidBlockHeight?: string;
  wireSha256?: string;
  status?: string;
  [key: string]: unknown;
};

/** Statuses after which a signature needs no more polling. */
export const TERMINAL_STATUSES = new Set(["finalized", "confirmed", "failed", "dropped"]);

export class Journal {
  readonly path: string;
  private fd: number;
  constructor(file: string) {
    this.path = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // 'a': append; the file may already hold events of this run's plan.
    this.fd = fs.openSync(file, "a", 0o600);
  }
  append(event: Omit<JournalEvent, "t">): void {
    const line = `${JSON.stringify({ t: new Date().toISOString(), ...event })}\n`;
    fs.writeSync(this.fd, line);
    fs.fsyncSync(this.fd);
  }
  close(): void {
    if (this.fd >= 0) {
      fs.closeSync(this.fd);
      this.fd = -1;
    }
  }
}

export function readJournal(file: string): JournalEvent[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as JournalEvent;
      } catch {
        // A torn last line from a crash: ignore it, the signature (if any) was
        // journalled on its own line before the send.
        return null;
      }
    })
    .filter((event): event is JournalEvent => event !== null);
}

export type InFlight = { step: string; sig: string; lastValidBlockHeight: bigint };

/** Signed signatures that have no terminal status yet. */
export function unresolvedSignatures(events: JournalEvent[]): InFlight[] {
  const signed = new Map<string, InFlight>();
  const done = new Set<string>();
  for (const event of events) {
    if (event.event === "signed" && event.sig && event.lastValidBlockHeight) {
      signed.set(event.sig, {
        step: event.step ?? "unknown",
        sig: event.sig,
        lastValidBlockHeight: BigInt(event.lastValidBlockHeight),
      });
    }
    if ((event.event === "status" || event.event === "recover") && event.sig && event.status) {
      if (TERMINAL_STATUSES.has(event.status)) done.add(event.sig);
    }
  }
  return [...signed.values()].filter((entry) => !done.has(entry.sig));
}

// ── Lock ─────────────────────────────────────────────────────────────────────

export type LockInfo = {
  pid: number;
  tool: string;
  journalPath: string;
  startedUtc: string;
};

export function lockPath(stateDir: string, network: string, genesis: string): string {
  return path.join(stateDir, `${network}-${genesis.slice(0, 8)}.lock`);
}

export function readLock(file: string): LockInfo | null {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as LockInfo;
  } catch {
    return { pid: -1, tool: "unknown", journalPath: "", startedUtc: "" };
  }
}

export type HeldLock = { path: string; info: LockInfo; released: boolean };

export function acquireLock(input: {
  stateDir: string;
  network: string;
  genesis: string;
  tool: string;
  journalPath: string;
}): HeldLock {
  fs.mkdirSync(input.stateDir, { recursive: true, mode: 0o700 });
  const file = lockPath(input.stateDir, input.network, input.genesis);
  const info: LockInfo = {
    pid: process.pid,
    tool: input.tool,
    journalPath: input.journalPath,
    startedUtc: new Date().toISOString(),
  };
  let fd: number;
  try {
    fd = fs.openSync(file, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
      throw new ChainGateError(
        `A chain lock for ${input.network} already exists (another run, or a crash). Resolve it with CHAIN_RECOVER=1 before sending again`,
      );
    }
    throw new ChainGateError("Cannot create the chain lock file");
  }
  fs.writeSync(fd, `${JSON.stringify(info)}\n`);
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  return { path: file, info, released: false };
}

/** True when `info` (pid and start time) still describes the lock file on disk. */
export function lockMatches(file: string, info: Pick<LockInfo, "pid" | "startedUtc">): boolean {
  const current = readLock(file);
  return Boolean(current && current.pid === info.pid && current.startedUtc === info.startedUtc);
}

/**
 * Removes the lock only if it is still this run's lock: a lock file that a
 * later run created (after a recovery removed ours) is left alone.
 */
export function releaseLock(lock: HeldLock): void {
  if (lock.released) return;
  if (lockMatches(lock.path, lock.info)) fs.rmSync(lock.path, { force: true });
  lock.released = true;
}

/** Whether a process with this pid exists (EPERM: it exists, owned by someone else). */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/** A second, short-lived lock so two recoveries never run at once. */
export function acquireRecoveryLock(lockFile: string): () => void {
  const file = `${lockFile}.recover`;
  let fd: number;
  try {
    fd = fs.openSync(file, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
      throw new ChainGateError("Another CHAIN_RECOVER run holds the recovery lock (or one crashed; remove the .recover file after checking)");
    }
    throw new ChainGateError("Cannot create the recovery lock file");
  }
  fs.writeSync(fd, `${JSON.stringify({ pid: process.pid, startedUtc: new Date().toISOString() })}\n`);
  fs.closeSync(fd);
  return () => fs.rmSync(file, { force: true });
}
