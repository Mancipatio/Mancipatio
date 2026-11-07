import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { DocumentationFrame } from "@/components/documentation-frame";
import { PageHeader, Section, H2, Body } from "@/components/mx";
import type { KnowledgeEntry } from "@/lib/assistant/knowledge";
import { loadPublishedAssistantKnowledge } from "@/lib/server/assistant-knowledge";
import { publishedKnowledgeVersion } from "@/lib/assistant/version";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Manci answer library · Manci",
  description: "Source-backed explanations of token rights, registered ownership, jurisdictions and the Manci process in English.",
};

export default async function ManciAnswerLibrary() {
  let entries: KnowledgeEntry[] = [];
  let unavailable = false;
  try { entries = await loadPublishedAssistantKnowledge(); } catch { unavailable = true; }
  return (
    <AppShell section="documentation">
      <DocumentationFrame>
        <PageHeader eyebrow="Manci knowledge" title="Understand what you own."
          lede="The published explanations, policies and procedures behind Ask Manci. Follow the source material for each topic." />
        <Section>
          <Body>These explanations describe the Manci model. The documents for each issuance define its rights, conditions and legal process. Historical examples do not establish current availability in every country.</Body>
          {unavailable ? <Body className="mt-4">The answer library is temporarily unavailable. Please try again shortly or contact our team.</Body>
            : entries.length === 0 ? <Body className="mt-4">New answers are being prepared. Our team can help with your question in the meantime.</Body>
            : <p className="mt-3 text-xs text-slate-500">Knowledge edition: {publishedKnowledgeVersion(entries).slice(0, 10)}</p>}
          <nav aria-label="Answer topics" className="mt-6 grid gap-2 sm:grid-cols-2">
            {entries.map((entry) => <Link key={entry.id} href={`#${entry.id}`} className="text-sm text-brand-700 hover:underline">{entry.title} →</Link>)}
          </nav>
        </Section>
        {entries.map((entry) => (
          <Section key={entry.id}>
            <article id={entry.id} className="scroll-mt-24">
              <p className="mb-2 text-xs uppercase tracking-wide text-slate-500">{entry.category === "procedure" ? "Procedure" : entry.category === "policy" ? "Policy" : "Explanation"}</p>
              <H2>{entry.title}</H2>
              <Body className="mt-4 whitespace-pre-line">{entry.answer}</Body>
              {entry.provenance?.map((source, index) => <p key={index} className="mt-3 text-xs leading-relaxed text-slate-500">Material: {source.title} · {source.date} · {source.section}</p>)}
              <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
                {entry.sources.map((source) => <li key={source.href}><Link href={source.href} className="text-xs text-brand-700 underline underline-offset-2">{source.title}{source.section ? ` · ${source.section}` : ""}</Link></li>)}
              </ul>
            </article>
          </Section>
        ))}
        <Section><H2>Need the terms for a specific issuance?</H2><Body className="mt-4">Tell the Manci team which asset, instrument and country you are considering.</Body><Link href="/contact" className="btn-brand mt-4 inline-flex">Contact the team →</Link></Section>
      </DocumentationFrame>
    </AppShell>
  );
}
