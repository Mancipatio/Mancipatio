/**
 * The simulator's step journal (design-sim §6): one JSON line per HTTP
 * request, transaction or consistency check, fsync'd, in
 * `<run>/journal.ndjson` and again in the user's own `<run>/users/<label>.ndjson`.
 * Bodies are redacted (tokens, cookies, signatures) and capped at 2 KB before
 * they reach this module. The transaction lifecycle (signed → sent → status)
 * lives in the chain CLI's Journal (`<run>/tx-journal.jsonl`).
 *
 * The owner actor (SIM_OWNER=1) journals as user `owner` with the user its
 * request is about as `target`: the line lands in `users/owner.ndjson` and in
 * the target's own file too, so each user's file shows the decisions about it.
 */
import fs from "node:fs";
import path from "node:path";
import { ensurePrivateDir } from "./safety";

/**
 * How a step ended, compared with what it expected:
 * ok / expected-error — as expected; the rest are findings for the report.
 * `unexpected-accept`: a transfer probe the chain should refuse simulated OK
 * (it is never sent).
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
  | "unexpected-accept"
  | "info";

export const FINDING_OUTCOMES: ReadonlySet<Outcome> = new Set([
  "unexpected-2xx",
  "unexpected-4xx",
  "5xx",
  "network",
  "tx-error",
  "consistency",
  "unexpected-accept",
]);

export type JournalEntry = {
  ts: string;
  wave: number | null;
  user: string;
  cohort: string;
  step: string;
  kind: "http" | "tx" | "probe" | "check" | "note";
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
  /** The user an owner-actor line is about (`user` is then "owner"). */
  target?: string;
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
    if (entry.target && entry.target !== entry.user) fs.writeSync(this.userFd(entry.target), line);
    this.entries.push(full);
  }

  close(): void {
    fs.closeSync(this.fd);
    for (const fd of this.userFds.values()) fs.closeSync(fd);
    this.userFds.clear();
  }
}

/** The same sink, with `observe` told about every line after it is written (the owner actor's activity counts). */
export function teeJournal(sink: JournalSink, observe: (entry: Omit<JournalEntry, "ts">) => void): JournalSink {
  return {
    append(entry) {
      sink.append(entry);
      observe(entry);
    },
  };
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
