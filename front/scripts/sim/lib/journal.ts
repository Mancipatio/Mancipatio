/**
 * The simulator's step journal (design-sim §6): one JSON line per HTTP
 * request, transaction or consistency check, fsync'd, in
 * `<run>/journal.ndjson` and again in the user's own `<run>/users/<label>.ndjson`.
 * Bodies are redacted (tokens, cookies, signatures) and capped at 2 KB before
 * they reach this module. The transaction lifecycle (signed → sent → status)
 * lives in the chain CLI's Journal (`<run>/tx-journal.jsonl`).
 */
import fs from "node:fs";
import path from "node:path";
import { ensurePrivateDir } from "./safety";

/**
 * How a step ended, compared with what it expected:
 * ok / expected-error — as expected; the rest are findings for the report.
 */
export type Outcome =
  | "ok"
  | "expected-error"
  | "unexpected-2xx"
  | "unexpected-4xx"
  | "5xx"
  | "network"
  | "tx-error"
  | "consistency"
  | "info";

export const FINDING_OUTCOMES: ReadonlySet<Outcome> = new Set([
  "unexpected-2xx",
  "unexpected-4xx",
  "5xx",
  "network",
  "tx-error",
  "consistency",
]);

export type JournalEntry = {
  ts: string;
  wave: number | null;
  user: string;
  cohort: string;
  step: string;
  kind: "http" | "tx" | "check" | "note";
  route?: string;
  action?: string;
  ix?: string;
  httpStatus?: number;
  ms?: number;
  expected?: string;
  outcome: Outcome;
  body?: string;
  txSig?: string | null;
  err?: string;
  logMessages?: string[];
};

export interface JournalSink {
  append(entry: Omit<JournalEntry, "ts">): void;
}

export class SimJournal implements JournalSink {
  private readonly fd: number;
  private readonly userFds = new Map<string, number>();
  readonly entries: JournalEntry[] = [];

  constructor(private readonly runDir: string) {
    ensurePrivateDir(runDir);
    this.fd = fs.openSync(path.join(runDir, "journal.ndjson"), "a", 0o600);
  }

  private userFd(user: string): number {
    const known = this.userFds.get(user);
    if (known !== undefined) return known;
    const dir = path.join(this.runDir, "users");
    ensurePrivateDir(dir);
    const fd = fs.openSync(path.join(dir, `${user.replace(/[^a-z0-9-]/gi, "_")}.ndjson`), "a", 0o600);
    this.userFds.set(user, fd);
    return fd;
  }

  append(entry: Omit<JournalEntry, "ts">): void {
    const full: JournalEntry = { ts: new Date().toISOString(), ...entry };
    const line = `${JSON.stringify(full)}\n`;
    fs.writeSync(this.fd, line);
    fs.fsyncSync(this.fd);
    fs.writeSync(this.userFd(entry.user), line);
    this.entries.push(full);
  }

  close(): void {
    fs.closeSync(this.fd);
    for (const fd of this.userFds.values()) fs.closeSync(fd);
    this.userFds.clear();
  }
}

/** In-memory sink (tests, plan). */
export class MemoryJournal implements JournalSink {
  readonly entries: JournalEntry[] = [];
  append(entry: Omit<JournalEntry, "ts">): void {
    this.entries.push({ ts: new Date().toISOString(), ...entry });
  }
}

export function readSimJournal(file: string): JournalEntry[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as JournalEntry];
      } catch {
        return []; // a torn last line after a crash
      }
    });
}
