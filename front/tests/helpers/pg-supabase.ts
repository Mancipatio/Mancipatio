// A PostgREST-shaped client over the isolated test cluster (LocalPostgres),
// for suites that run the REAL server modules (indexer jobs, the gap scan,
// the full reconcile) against the REAL migration chain. It covers only the
// builder calls those modules make: rpc(name, args) and
// from(table).select / eq / in / gt / contains / order / limit / upsert /
// maybeSingle / single, each awaited directly or through abortSignal(). Every
// statement runs as service_role (the role the server key maps to), so the
// migrations' grants are part of what is tested. Errors come back the way
// supabase-js returns them ({ data: null, error: { code, message } }), with
// the SQLSTATE as the code.
//
// Values are sent as SQL literals the server casts to the column or
// argument type (argument types come from pg_proc), so no value is ever
// spliced into SQL unquoted.
import type { LocalPostgres } from "./local-postgres";

type Result = { data: unknown; error: { code: string; message: string } | null; count?: number | null };
/**
 * How many statements ran; `ms` is the server's time (psql \timing), `wallMs`
 * the client's, including the psql process each call starts (the benchmark
 * subtracts it: a deployment keeps its connections).
 */
export type PgStats = { calls: number; ms: number; wallMs: number; byName: Record<string, { calls: number; ms: number }> };

const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const ident = (name: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Unsupported identifier ${name}`);
  return name;
};

/** A value as a literal of `type` (a pg_proc argument type or an untyped column literal). */
function valueSql(value: unknown, type: string | null): string {
  if (value === null || value === undefined) return type ? `null::${type}` : "null";
  if (type === "jsonb" || type === "json") return `${literal(JSON.stringify(value))}::${type}`;
  if (Array.isArray(value)) {
    if (type && !type.endsWith("[]")) throw new Error(`An array for a ${type} argument`);
    const element = type ? type.slice(0, -2) : "text";
    return `array[${value.map((v) => valueSql(v, element)).join(",")}]::${type ?? "text[]"}`;
  }
  if (typeof value === "object") return `${literal(JSON.stringify(value))}${type ? `::${type}` : "::jsonb"}`;
  return type ? `${literal(String(value))}::${type}` : literal(String(value));
}

function parseError(error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  const match = /ERROR:\s+([0-9A-Z]{5}):\s+([^\n]*)/.exec(text);
  return { code: match?.[1] ?? "XX000", message: (match?.[2] ?? text).slice(0, 500) };
}

export function pgSupabase(db: LocalPostgres, options: { role?: string } = {}) {
  const role = options.role ?? "service_role";
  const stats: PgStats = { calls: 0, ms: 0, wallMs: 0, byName: {} };
  const signatures = new Map<string, Promise<{ set: boolean; args: Map<string, string> }>>();

  /** One statement; `ms` is the server's time (psql \timing), not the psql process start. */
  async function run(name: string, sql: string): Promise<string> {
    const started = performance.now();
    let out: string;
    try {
      out = await db.queryAsync(`\\set VERBOSITY verbose\n\\timing on\nset role ${role};\n${sql}`);
    } finally {
      stats.wallMs += performance.now() - started;
    }
    let ms = 0;
    const kept: string[] = [];
    for (const line of out.split("\n")) {
      const time = /^Time: ([0-9.]+) ms/.exec(line);
      if (time) ms += Number(time[1]);
      else kept.push(line);
    }
    stats.calls++;
    stats.ms += ms;
    const entry = (stats.byName[name] ??= { calls: 0, ms: 0 });
    entry.calls++;
    entry.ms += ms;
    return kept.join("\n").trim();
  }

  function signature(fn: string) {
    let found = signatures.get(fn);
    if (!found) {
      found = db.queryAsync(`select json_build_object('set', p.proretset, 'names', p.proargnames,
          'types', array(select format_type(t, null) from unnest(p.proargtypes::oid[]) with ordinality u(t, i) order by i))
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = ${literal(fn)}`)
        .then((out) => {
          if (!out) throw new Error(`public.${fn} does not exist`);
          if (out.includes("\n")) throw new Error(`public.${fn} is overloaded`);
          const meta = JSON.parse(out) as { set: boolean; names: string[] | null; types: string[] };
          return { set: meta.set, args: new Map((meta.names ?? []).map((n, i) => [n, meta.types[i]])) };
        });
      signatures.set(fn, found);
    }
    return found;
  }

  /** A thenable that also takes abortSignal(), like the supabase-js builders. */
  function thenable(exec: () => Promise<Result>) {
    let pending: Promise<Result> | null = null;
    const start = () => (pending ??= exec());
    const self = {
      abortSignal: () => self,
      then: <A, B>(ok?: (v: Result) => A | PromiseLike<A>, bad?: (e: unknown) => B | PromiseLike<B>) => start().then(ok, bad),
    };
    return self;
  }

  function rpc(fn: string, args: Record<string, unknown> = {}) {
    return thenable(async () => {
      try {
        const meta = await signature(ident(fn));
        const list = Object.entries(args).map(([name, value]) => {
          const type = meta.args.get(name);
          if (!type) throw new Error(`public.${fn} has no argument ${name}`);
          return `${ident(name)} => ${valueSql(value, type)}`;
        }).join(", ");
        const call = `public.${fn}(${list})`;
        const out = await run(fn, meta.set
          ? `select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) from ${call} r;`
          : `select to_jsonb(${call});`);
        return { data: out === "" ? null : JSON.parse(out), error: null };
      } catch (error) {
        return { data: null, error: parseError(error) };
      }
    });
  }

  function from(table: string) {
    const where: string[] = [];
    const order: string[] = [];
    let columns = "*";
    let limit: number | null = null;
    let upsert: { rows: Record<string, unknown>[]; conflict: string } | null = null;
    let head = false;
    let counted = false;
    const execute = async (mode: "many" | "maybe" | "single"): Promise<Result> => {
      try {
        if (upsert) {
          const cols = [...new Set(upsert.rows.flatMap((r) => Object.keys(r)))].map(ident);
          const values = upsert.rows.map((r) => `(${cols.map((c) => valueSql(r[c] ?? null, null)).join(",")})`).join(",");
          const conflict = upsert.conflict.split(",").map((c) => ident(c.trim()));
          const updates = cols.filter((c) => !conflict.includes(c)).map((c) => `${c} = excluded.${c}`).join(", ");
          await run(`upsert:${table}`, `insert into public.${ident(table)} (${cols.join(",")}) values ${values}
            on conflict (${conflict.join(",")}) do ${updates ? `update set ${updates}` : "nothing"};`);
          return { data: null, error: null };
        }
        const filter = where.length ? ` where ${where.join(" and ")}` : "";
        const sql = `select ${columns} from public.${ident(table)}${filter}${order.length ? ` order by ${order.join(", ")}` : ""}${limit === null ? "" : ` limit ${limit}`}`;
        if (head || counted) {
          const count = Number(await run(`count:${table}`, `select count(*) from (${sql}) t;`));
          if (head) return { data: null, error: null, count };
        }
        const out = await run(`select:${table}`, `select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (${sql}) t;`);
        const rows = JSON.parse(out) as unknown[];
        if (mode === "many") return { data: rows, error: null };
        if (rows.length > 1) return { data: null, error: { code: "PGRST116", message: "More than one row" } };
        if (mode === "single" && rows.length === 0) return { data: null, error: { code: "PGRST116", message: "No rows" } };
        return { data: rows[0] ?? null, error: null };
      } catch (error) {
        return { data: null, error: parseError(error) };
      }
    };
    const base = thenable(() => execute("many"));
    const builder = {
      ...base,
      abortSignal: () => builder,
      select(cols = "*", opts?: { count?: string; head?: boolean }) {
        columns = cols === "*" ? "*" : cols.split(",").map((c) => ident(c.trim())).join(", ");
        head = opts?.head === true;
        counted = opts?.count !== undefined;
        return builder;
      },
      eq(column: string, value: unknown) { where.push(`${ident(column)} = ${valueSql(value, null)}`); return builder; },
      gt(column: string, value: unknown) { where.push(`${ident(column)} > ${valueSql(value, null)}`); return builder; },
      in(column: string, values: unknown[]) {
        where.push(values.length ? `${ident(column)} in (${values.map((v) => valueSql(v, null)).join(",")})` : "false");
        return builder;
      },
      contains(column: string, values: unknown[]) { where.push(`${ident(column)} @> ${valueSql(values, "text[]")}`); return builder; },
      order(column: string, opts?: { ascending?: boolean }) { order.push(`${ident(column)} ${opts?.ascending === false ? "desc" : "asc"}`); return builder; },
      limit(n: number) { limit = n; return builder; },
      upsert(value: Record<string, unknown> | Record<string, unknown>[], opts?: { onConflict?: string }) {
        upsert = { rows: Array.isArray(value) ? value : [value], conflict: opts?.onConflict ?? "id" };
        return builder;
      },
      maybeSingle: () => thenable(() => execute("maybe")),
      single: () => thenable(() => execute("single")),
    };
    return builder;
  }

  return { client: { rpc, from }, stats };
}
