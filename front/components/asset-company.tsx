import { safeHttpUrl } from "@/lib/format";
import { COMPANY_LINKS, companyLinkHref, teamMember, type CompanyLinkColumn } from "@/lib/company-profile";

/**
 * "The company" on a token's page: who is behind the token. The company's
 * name, where it is registered, its website and its pages elsewhere, and the
 * people who run it, all from the published profile
 * (lib/company-profile.ts). Each link is shown only if it passes the same
 * rule it was written under (https, on that service's own host).
 *
 * Renders nothing without a name, a link or a team: a token whose profile
 * says none of it has no such section.
 */
export function AssetCompany({
  companyName,
  country,
  website,
  links,
  team,
}: {
  companyName: string | null | undefined;
  /** The issuer's country by name, or null. */
  country: string | null;
  website: string | null | undefined;
  links: Partial<Record<CompanyLinkColumn, string | null | undefined>>;
  team: readonly string[] | null | undefined;
}) {
  const name = companyName?.trim() || null;
  const site = safeHttpUrl(website);
  const elsewhere = COMPANY_LINKS.flatMap((link) => {
    const href = companyLinkHref(link.column, links[link.column]);
    return href ? [{ label: link.label, href }] : [];
  });
  const people = (team ?? []).map(teamMember).filter((person) => person.name);
  if (!name && !site && elsewhere.length === 0 && people.length === 0) return null;

  return (
    <section className="mt-10" aria-labelledby="asset-company-heading">
      <h2 id="asset-company-heading" className="text-xs font-semibold uppercase tracking-widest text-mx-ink-faint">
        The company
      </h2>
      <div className="mt-4 rounded-[3px] border border-mx-rule bg-white p-6">
        {name && <p className="text-lg font-semibold text-mx-ink">{name}</p>}
        {country && <p className="mt-0.5 text-sm text-mx-ink-faint">Registered in {country}</p>}
        {(site || elsewhere.length > 0) && (
          <ul className={`flex flex-wrap gap-x-5 gap-y-2 text-sm ${name || country ? "mt-4" : ""}`}>
            {site && (
              <li>
                <a href={site} target="_blank" rel="noopener noreferrer" className="text-mx-ink-soft underline-offset-2 hover:underline">
                  Website ↗
                </a>
              </li>
            )}
            {elsewhere.map((link) => (
              <li key={link.label}>
                <a href={link.href} target="_blank" rel="noopener noreferrer" className="text-mx-ink-soft underline-offset-2 hover:underline">
                  {link.label} ↗
                </a>
              </li>
            ))}
          </ul>
        )}
        {people.length > 0 && (
          <div className={name || country || site || elsewhere.length > 0 ? "mt-5 border-t border-mx-rule pt-5" : ""}>
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-mx-ink-faint">Team</p>
            <ul className="mt-3 grid gap-x-8 gap-y-3 sm:grid-cols-2">
              {people.map((person, index) => (
                <li key={`${person.name}:${index}`} className="text-sm">
                  <span className="font-medium text-mx-ink">{person.name}</span>
                  {person.role && <span className="block text-mx-ink-faint">{person.role}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
