import { KNOWLEDGE_ENTRIES, KNOWLEDGE_VERSION, type KnowledgeEntry } from "./knowledge";
import type { AssistantAnswer, AssistantInput, AssistantSource } from "./types";

const CYRILLIC: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", ђ: "dj", е: "e", ж: "z", з: "z", и: "i", ј: "j",
  к: "k", л: "l", љ: "lj", м: "m", н: "n", њ: "nj", о: "o", п: "p", р: "r", с: "s",
  т: "t", ћ: "c", у: "u", ф: "f", х: "h", ц: "c", ч: "c", џ: "dz", ш: "s",
};
export function normalizeQuestion(value: string) {
  return value.toLowerCase().replace(/[а-яђјљњћџ]/g, (letter) => CYRILLIC[letter] ?? letter)
    .replace(/đ/g, "dj").normalize("NFD").replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, " ").trim();
}
const STOP_WORDS = new Set("a an and are as at be can do does for from have how i in is it me my of on or the to we what where which who with you your da li je se u i za na od do kako koja koje koji nas nasa mi vi sta to a the manci mancipatio".split(" "));
function score(entry: KnowledgeEntry, query: string) {
  const normalized = normalizeQuestion(query);
  const words = normalized.split(" ").filter((word) => word.length >= 3 && !STOP_WORDS.has(word));
  if (!words.length) return 0;
  let total = 0;
  for (const keyword of entry.keywords) {
    const term = normalizeQuestion(keyword);
    if (!term || STOP_WORDS.has(term)) continue;
    if (` ${normalized} `.includes(` ${term} `)) {
      total += term.includes(" ") ? 8 : 3;
    } else if (!term.includes(" ") && term.length >= 4 && words.some((word) => word.length >= 4 && word.startsWith(term))) {
      total += 3;
    }
  }
  const title = normalizeQuestion(entry.title);
  // Admin-authored entries can have no keywords. A full title phrase is a
  // strong match even when a short title contains fewer than three words.
  if (title && ` ${normalized} `.includes(` ${title} `)) total += 8;
  total += words.filter((word) => title.split(" ").includes(word)).length;
  return total;
}

/** Rank the current question first. Short follow-ups can reuse a previous user
 * question; client-supplied assistant statements never become factual context. */
export function retrieveKnowledge(input: AssistantInput, corpus: readonly KnowledgeEntry[] = KNOWLEDGE_ENTRIES): KnowledgeEntry[] {
  const questions = input.messages.filter((message) => message.role === "user").map((message) => message.content);
  const current = questions.at(-1) ?? "";
  const normalized = normalizeQuestion(current);
  if (/^(hi|hello|hey|zdravo|cao|dobar dan|manci|mancipatio|what is manci|what is mancipatio|sta je manci|sta je mancipatio)$/.test(normalized)) {
    return corpus.filter((entry) => entry.id === "what-is-manci");
  }
  const followUp = normalized.split(" ").length <= 10 && /\b(it|that|those|them|this|to|toga|tome|njima|njih|onda)\b/.test(normalized);
  const previous = followUp ? questions.slice(-3, -1).join(" ") : "";
  return corpus.map((entry) => ({
    entry,
    score: score(entry, current) + (previous ? score(entry, previous) * 0.25 : 0),
    direct: score(entry, current),
    previous: previous ? score(entry, previous) : 0,
  })).filter((hit) => hit.direct >= 3 || (followUp && hit.previous >= 3))
    .sort((a, b) => b.score - a.score).slice(0, 5).map((hit) => hit.entry);
}

export function knowledgeSources(entries: readonly KnowledgeEntry[]): AssistantSource[] {
  return entries.map((entry) => ({
    title: entry.title,
    href: `/docs/manci-answers#${entry.id}`,
  }));
}

export function handoffAnswer(): AssistantAnswer {
  return {
    answer: "I can help you understand token rights, the legal steps and how to get started on Manci. I don't have a confirmed answer to this specific question yet.\n\nFor details about an issuance, contact the team with the asset or instrument and the country involved. Keep personal documents and confidential information out of the chat.",
    sources: [{ title: "Contact the Manci team", href: "/contact" }],
    mode: "knowledge", knowledgeVersion: KNOWLEDGE_VERSION,
  };
}

/** A useful, explicitly labelled answer even before a provider key is set.
 * Never fabricate a generative response or an unverified source URL. */
export function knowledgeAnswer(entries: readonly KnowledgeEntry[]): AssistantAnswer {
  if (!entries.length) return handoffAnswer();
  // The published body is the answer: keep its qualifications and authored
  // paragraphs/steps intact, without repeating a FAQ heading or blending topics.
  const selected = entries.slice(0, 1);
  return {
    answer: selected[0].answer.trim(),
    sources: knowledgeSources(selected),
    mode: "knowledge", knowledgeVersion: KNOWLEDGE_VERSION,
  };
}
