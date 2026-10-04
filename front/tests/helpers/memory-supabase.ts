// An in-memory stand-in for the service-role Supabase client, for route
// tests: tables are arrays of rows, and the query builder supports the calls
// the routes under test make (select / insert / update / upsert / delete,
// eq / neq / in / not in / lt / lte / gt / gte, order / limit, single /
// maybeSingle, `.select()` after a write, head counts) plus `rpc(name, args)`
// through registered handlers and opt-in per-table insert defaults
// (`defaults`). Filters are applied; ordering and limits are not (tests keep
// tables small) unless a test turns `ordered` on: then a select applies its
// order() keys (ascending or not, in turn), then range() and limit(), like
// PostgREST, so paging and ordering bugs show.

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
  /** Column defaults an insert fills when the row leaves them out (like `created_at default now()`), per table. */
  defaults: Record<string, () => Row>;
  /** Selects apply order() / range() / limit() (off by default: answers keep insertion order and every match). */
  ordered: boolean;
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
    defaults: {},
    ordered: false,
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
      db.defaults = {};
      db.ordered = false;
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
    const orders: { column: string; ascending: boolean }[] = [];
    let offset = 0;
    let limit: number | null = null;
    /** order() keys in turn (PostgREST: ascending unless asked; nulls last ascending, first descending), then range/limit. */
    const shape = (rows: Row[]): Row[] => {
      if (!db.ordered) return rows;
      const sorted = [...rows].sort((a, b) => {
        for (const { column, ascending } of orders) {
          const x = valueOf(a, column);
          const y = valueOf(b, column);
          if (x === y) continue;
          if (x === null || x === undefined) return ascending ? 1 : -1;
          if (y === null || y === undefined) return ascending ? -1 : 1;
          const lt = (x as never) < (y as never);
          return (lt ? -1 : 1) * (ascending ? 1 : -1);
        }
        return 0;
      });
      return sorted.slice(offset, limit === null ? undefined : offset + limit);
    };
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
        const rows = (Array.isArray(payload) ? payload : [payload ?? {}]).map((r) => ({
          id: r.id ?? `row-${nextId++}`,
          ...(db.defaults[table]?.() ?? {}),
          ...r,
        }));
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
      const copies = shape(matched).map((r) => ({ ...r }));
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
      order: (column: string, options?: { ascending?: boolean }) => {
        orders.push({ column, ascending: options?.ascending ?? true });
        return b;
      },
      limit: (n: number) => ((limit = n), b),
      range: (from: number, to: number) => ((offset = from), (limit = to - from + 1), b),
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
