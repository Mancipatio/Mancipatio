// An in-memory stand-in for the service-role Supabase client, for route
// tests: tables are arrays of rows, and the query builder supports the calls
// the routes under test make (select / insert / update / upsert / delete,
// eq / neq / in / not in / lt / lte / gt / gte, order / limit, single /
// maybeSingle, `.select()` after a write, head counts) plus `rpc(name, args)`
// through registered handlers, opt-in per-table insert defaults
// (`defaults`) and opt-in primary-key uniqueness on `id` (`uniqueIds`).
// Filters are applied, ordering and limits are not (tests keep tables small).

export type Row = Record<string, unknown>;

export type MemorySupabase = {
  tables: Record<string, Row[]>;
  rpcs: Record<string, (args: Record<string, unknown>) => unknown>;
  /** Tables whose writes fail (DB error simulation). */
  failWrites: Set<string>;
  /** Tables whose reads fail. */
  failReads: Set<string>;
  /** The error code a failing read answers with (default XX000), e.g. 42P01 for a missing table. */
  readErrorCodes: Record<string, string>;
  /** Columns a table does not have (an older schema): a write that sends one fails with PGRST204. */
  missingColumns: Record<string, string[]>;
  /** Runs right before an update is applied (race simulation). */
  beforeUpdate: ((table: string) => void) | null;
  /** Runs right before an insert is applied (race simulation). */
  beforeInsert: ((table: string) => void) | null;
  /** Tables whose `id` is a primary key: an insert with a taken id fails with 23505 (opt-in). */
  uniqueIds: Set<string>;
  /** Column defaults an insert fills when the row leaves them out (like `created_at default now()`), per table. */
  defaults: Record<string, () => Row>;
  client: { from: (table: string) => unknown; rpc: (name: string, args?: Record<string, unknown>) => unknown };
  rows: (table: string) => Row[];
  reset: () => void;
};

export function memorySupabase(): MemorySupabase {
  let nextId = 1;
  const db: MemorySupabase = {
    tables: {},
    rpcs: {},
    failWrites: new Set(),
    failReads: new Set(),
    readErrorCodes: {},
    missingColumns: {},
    beforeUpdate: null,
    beforeInsert: null,
    uniqueIds: new Set(),
    defaults: {},
    client: { from: (table: string) => from(table), rpc: (name: string, args: Record<string, unknown> = {}) => rpc(name, args) },
    rows: (table) => (db.tables[table] ??= []),
    reset: () => {
      db.tables = {};
      db.rpcs = {};
      db.failWrites.clear();
      db.failReads.clear();
      db.readErrorCodes = {};
      db.missingColumns = {};
      db.beforeUpdate = null;
      db.beforeInsert = null;
      db.uniqueIds.clear();
      db.defaults = {};
    },
  };

  function rpc(name: string, args: Record<string, unknown>) {
    const run = async () => {
      const handler = db.rpcs[name];
      if (!handler) return { data: null, error: { message: `unknown rpc ${name}`, code: "PGRST202" } };
      try {
        return { data: await handler(args), error: null };
      } catch (err) {
        // A thrown error with a `code` (e.g. 23514) answers like PostgREST: message and SQLSTATE.
        const code = (err as { code?: unknown } | null)?.code;
        return {
          data: null,
          error: { message: err instanceof Error ? err.message : String(err), ...(typeof code === "string" ? { code } : {}) },
        };
      }
    };
    const promise = run();
    const b = {
      abortSignal: () => b,
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => promise.then(resolve, reject),
    };
    return b;
  }

  function from(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let op: "select" | "insert" | "update" | "upsert" | "delete" = "select";
    let payload: Row | Row[] | null = null;
    let returning = false;
    let head = false;
    const run = async (single: boolean) => {
      if (op !== "select" && db.failWrites.has(table)) return { data: null, error: { message: "write failed", code: "XX000" } };
      const unknown = (db.missingColumns[table] ?? []).find((column) =>
        (Array.isArray(payload) ? payload : payload ? [payload] : []).some((r) => column in r));
      if (op !== "select" && op !== "delete" && unknown) {
        return { data: null, error: { message: `Could not find the '${unknown}' column of '${table}' in the schema cache`, code: "PGRST204" } };
      }
      if (op === "select" && db.failReads.has(table)) {
        return { data: null, error: { message: "read failed", code: db.readErrorCodes[table] ?? "XX000" } };
      }
      if (op === "insert" || op === "upsert") {
        if (op === "insert") db.beforeInsert?.(table);
        const rows = (Array.isArray(payload) ? payload : [payload ?? {}]).map((r) => ({
          id: r.id ?? `row-${nextId++}`,
          ...(db.defaults[table]?.() ?? {}),
          ...r,
        }));
        if (op === "insert" && db.uniqueIds.has(table)) {
          const taken = new Set(db.rows(table).map((r) => r.id));
          const clash = rows.find((r) => taken.has(r.id));
          if (clash) {
            return { data: null, error: { message: `duplicate key value violates unique constraint "${table}_pkey"`, code: "23505" } };
          }
        }
        db.rows(table).push(...rows);
        return { data: returning ? (single ? rows[0] : rows) : null, error: null };
      }
      const matched = db.rows(table).filter((r) => filters.every((f) => f(r)));
      if (op === "update") {
        db.beforeUpdate?.(table);
        const now = db.rows(table).filter((r) => filters.every((f) => f(r)));
        for (const r of now) Object.assign(r, payload);
        return { data: returning ? (single ? now[0] ?? null : now) : null, error: null };
      }
      if (op === "delete") {
        db.tables[table] = db.rows(table).filter((r) => !matched.includes(r));
        return { data: null, error: null };
      }
      if (head) return { data: null, error: null, count: matched.length };
      // Copies, like a real response: a later update must not change them.
      const copies = matched.map((r) => ({ ...r }));
      return single ? { data: copies[0] ?? null, error: null } : { data: copies, error: null };
    };
    // A JSON path ("fields->sale_request->>status") reads into the row's jsonb like PostgREST (->> as text).
    const valueOf = (r: Row, c: string): unknown => {
      if (!c.includes("->")) return r[c];
      const [head, ...rest] = c.split(/->>?/);
      let v: unknown = r[head];
      for (const key of rest) v = v && typeof v === "object" ? (v as Record<string, unknown>)[key] : undefined;
      return c.includes("->>") && v !== undefined && v !== null && typeof v !== "string" ? JSON.stringify(v) : v;
    };
    const cmp = (c: string, test: (a: unknown) => boolean) => (filters.push((r) => test(valueOf(r, c))), b);
    const b: Record<string, unknown> = {};
    Object.assign(b, {
      select: (_cols?: string, opts?: { head?: boolean }) => {
        if (op === "select") head = Boolean(opts?.head);
        else returning = true;
        return b;
      },
      eq: (c: string, v: unknown) => cmp(c, (a) => a === v),
      neq: (c: string, v: unknown) => cmp(c, (a) => a !== v),
      in: (c: string, vs: unknown[]) => cmp(c, (a) => vs.includes(a)),
      lt: (c: string, v: never) => cmp(c, (a) => (a as never) < v),
      lte: (c: string, v: never) => cmp(c, (a) => (a as never) <= v),
      gt: (c: string, v: never) => cmp(c, (a) => (a as never) > v),
      gte: (c: string, v: never) => cmp(c, (a) => (a as never) >= v),
      is: (c: string, v: unknown) => cmp(c, (a) => (a ?? null) === v),
      not: (c: string, operator: string, value: string) => {
        if (operator !== "in") throw new Error(`memory supabase: not ${operator} is not supported`);
        const values = value.replace(/[()]/g, "").split(",");
        return cmp(c, (a) => !values.includes(String(a)));
      },
      order: () => b,
      limit: () => b,
      range: () => b,
      abortSignal: () => b,
      insert: (row: Row | Row[]) => ((op = "insert"), (payload = row), b),
      upsert: (row: Row | Row[]) => ((op = "upsert"), (payload = row), b),
      update: (patch: Row) => ((op = "update"), (payload = patch), b),
      delete: () => ((op = "delete"), b),
      maybeSingle: () => run(true),
      single: () => run(true),
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => run(false).then(resolve, reject),
    });
    return b;
  }

  return db;
}
