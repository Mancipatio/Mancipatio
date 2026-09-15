"use client";

import Link from "next/link";
import { useState } from "react";
import { DOCUMENTATION_GROUPS } from "@/lib/documentation";
import { IconArrowUpRight, IconFile } from "@/components/icons";

export function DocumentationIndex() {
  const [query, setQuery] = useState("");
  const term = query.trim().toLowerCase();
  const words = term.split(/\s+/).filter(Boolean);
  const groups = DOCUMENTATION_GROUPS.map((group) => ({ ...group, topics: group.topics.filter((topic) => {
    const text = `${group.title} ${topic.title} ${topic.description} ${topic.keywords ?? ""}`.toLowerCase();
    return words.every((word) => text.includes(word));
  }) })).filter((group) => group.topics.length > 0);
  const total = groups.reduce((sum, group) => sum + group.topics.length, 0);
  return <div className="docs-index">
    <div className="docs-index-header"><span className="docs-eyebrow">MANCI KNOWLEDGE BASE</span><h1>Documentation<span>.</span></h1><p>Understand the assets. Learn the workflows. Find the terms.</p><Link href="/markets/whitepapers" className="docs-library-shortcut"><IconFile size={16} />Looking for an issuer’s whitepaper?<span>Open the library ↗</span></Link></div>
    <div className="docs-search-row"><label className="docs-search"><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4.5 4.5" /></svg><input value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search documentation topics" placeholder="Find a guide: vesting, buying, custody…" />{query && <button onClick={() => setQuery("")} aria-label="Clear documentation search">×</button>}</label></div>
    {term && <p className="docs-search-result" role="status">{total} {total === 1 ? "guide" : "guides"} found</p>}
    {groups.length === 0 ? <div className="docs-search-empty"><IconFile size={28} /><h2>No matching guides</h2><p>Try an asset type, a workflow or a shorter search.</p><button className="overview-button" onClick={() => setQuery("")}>Show all guides</button></div> : groups.map((group) => <section key={group.id} id={group.id} className="docs-topic-group"><div className="docs-topic-heading"><h2>{group.title}</h2><p>{group.description}</p></div><div className="docs-topic-grid">{group.topics.map((topic) => <Link className="docs-topic-link" key={topic.href} href={topic.href}><div><h3>{topic.title}</h3><p>{topic.description}</p></div><IconArrowUpRight size={16} /></Link>)}</div></section>)}
  </div>;
}
