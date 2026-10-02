// Postgres intervals as PostgREST returns them. Pure and isomorphic (moved
// out of lib/server/health.ts so lib/fx-effective.ts can use it too; health
// re-exports it).

const INTERVAL_UNITS: Record<string, number> = {
  year: 365 * 86_400, years: 365 * 86_400, mon: 30 * 86_400, mons: 30 * 86_400,
  day: 86_400, days: 86_400,
};

/**
 * Seconds in a Postgres interval as PostgREST returns it: the default
 * "postgres" style ("7 days", "1 day 12:00:00", "12:00:00", "1 mon") or ISO
 * 8601 ("P7D", "PT12H"). Months count 30 days, years 365. Null when it is
 * not a positive interval in either form.
 */
export function intervalSeconds(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  const iso = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(text);
  let total: number | null = null;
  if (iso && text !== "P" && !text.endsWith("T")) {
    const [, y, mo, w, d, h, mi, s] = iso.map((part) => Number(part ?? 0));
    total = y * 365 * 86_400 + mo * 30 * 86_400 + w * 7 * 86_400 + d * 86_400 + h * 3_600 + mi * 60 + s;
  } else {
    const parts = text.split(/\s+/);
    let seconds = 0;
    let i = 0;
    for (; i + 1 < parts.length && /^\d+$/.test(parts[i]) && INTERVAL_UNITS[parts[i + 1]] !== undefined; i += 2) {
      seconds += Number(parts[i]) * INTERVAL_UNITS[parts[i + 1]];
    }
    const rest = parts.slice(i);
    if (rest.length === 1) {
      const clock = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(rest[0]);
      if (!clock) return null;
      seconds += Number(clock[1]) * 3_600 + Number(clock[2]) * 60 + Number(clock[3]);
    } else if (rest.length > 1 || i === 0) {
      return null;
    }
    total = seconds;
  }
  return Number.isFinite(total) && total > 0 ? total : null;
}
