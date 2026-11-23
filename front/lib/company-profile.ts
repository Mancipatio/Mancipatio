// The company behind a token, as its published profile states it: the
// company's name, the people who run it, where to find it, and its logo.
//
// These are the profile's deliberately public fields (migration 0093). The
// same rules run where a value is written (POST /api/profiles/upsert), where
// it is projected for the public (lib/profile-public.ts) and where it is
// shown, so a value that slipped past one of them is still not rendered:
//   company_name   at most COMPANY_NAME_MAX characters, one line
//   team           at most TEAM_MAX entries of "Name — Role" (the role is
//                  optional), each one line of at most TEAM_ENTRY_MAX
//   link_x / link_linkedin / link_github
//                  an https address on that service's own host, nothing else
//   logo_path      a file under logos/<asset PDA>/ in the public bucket;
//                  shown to the public only once an admin approved it
//
// No dependency: next.config-free, server and client alike.

export const COMPANY_NAME_MAX = 200;
export const TEAM_MAX = 12;
export const TEAM_ENTRY_MAX = 120;
export const LINK_MAX = 300;

/** The profile's link columns and the hosts each one accepts. */
export const COMPANY_LINKS = [
  { column: "link_x", label: "X", hosts: ["x.com", "twitter.com"] },
  { column: "link_linkedin", label: "LinkedIn", hosts: ["linkedin.com"] },
  { column: "link_github", label: "GitHub", hosts: ["github.com"] },
] as const;
export type CompanyLinkColumn = (typeof COMPANY_LINKS)[number]["column"];

const oneLine = (value: string) => value.replace(/\s+/g, " ").trim();
const hasControl = (value: string) => /[\u0000-\u001f\u007f]/.test(value);

/** The company name as stored, or null when blank. Throws on a value that cannot be stored. */
export function normalizeCompanyName(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || hasControl(value.replace(/[\t\n\r]/g, " "))) throw new Error("company_name must be text");
  const name = oneLine(value);
  if (!name) return null;
  if (name.length > COMPANY_NAME_MAX) throw new Error(`company_name is at most ${COMPANY_NAME_MAX} characters`);
  return name;
}

/**
 * The team as stored: trimmed one-line entries, blanks dropped. Throws on a
 * value that cannot be stored (not a list of text, too many or too long).
 */
export function normalizeTeam(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) throw new Error("team must be a list of text entries");
  const team = (value as string[]).map((entry) => {
    if (hasControl(entry.replace(/[\t\n\r]/g, " "))) throw new Error("team entries must be text");
    return oneLine(entry);
  }).filter(Boolean);
  if (team.length > TEAM_MAX) throw new Error(`team has at most ${TEAM_MAX} people`);
  if (team.some((entry) => entry.length > TEAM_ENTRY_MAX)) throw new Error(`a team entry is at most ${TEAM_ENTRY_MAX} characters`);
  return team;
}

/** The edit form's textarea (one person per line) as a team list. */
export function teamFromLines(text: string): string[] {
  return text.split(/\r?\n/).map(oneLine).filter(Boolean);
}

/** "Name — Role" (an em dash, an en dash or a spaced hyphen) as its parts. */
export function teamMember(entry: string): { name: string; role: string | null } {
  const match = /^(.*?)\s+[—–-]\s+(.+)$/.exec(oneLine(entry));
  return match && match[1] ? { name: match[1], role: match[2] } : { name: oneLine(entry), role: null };
}

/**
 * A link as stored and shown: https, on one of the column's hosts (or its
 * `www.`), with a path. null for a blank value; throws on anything else, so a
 * profile cannot carry a look-alike address.
 */
export function normalizeCompanyLink(column: CompanyLinkColumn, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error(`${column} must be an address`);
  const raw = value.trim();
  if (!raw) return null;
  const spec = COMPANY_LINKS.find((link) => link.column === column)!;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${column} is not a valid address`);
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (url.protocol !== "https:" || url.username || url.password || url.port || !(spec.hosts as readonly string[]).includes(host)) {
    throw new Error(`${column} must be an https address on ${spec.hosts.join(" or ")}`);
  }
  if (url.pathname === "/" || raw.length > LINK_MAX) throw new Error(`${column} must point to the company's page`);
  return url.href;
}

/** The link to render, or null when the stored value does not pass the rule above. */
export function companyLinkHref(column: CompanyLinkColumn, value: unknown): string | null {
  try {
    return normalizeCompanyLink(column, value);
  } catch {
    return null;
  }
}

/** Whether `path` is a logo file of this asset: under logos/<asset PDA>/, with no traversal. */
export function isLogoPathOf(assetPda: string, path: unknown): path is string {
  if (typeof path !== "string" || !assetPda || path.length > 400) return false;
  const prefix = `logos/${assetPda}/`;
  if (!path.startsWith(prefix)) return false;
  const rest = path.slice(prefix.length).split("/");
  return rest.length >= 1 && rest.every((part) => part.length > 0 && part !== "." && part !== ".." && /^[A-Za-z0-9._-]+$/.test(part));
}
