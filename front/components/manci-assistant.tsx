"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import type { AssistantMessage as ChatMessage, AssistantSource as Source, AssistantAnswer as Answer, AssistantInput as RetryRequest } from "@/lib/assistant/types";
import styles from "./manci-assistant.module.css";

type DisplayMessage = ChatMessage & { id: number; sources?: Source[]; mode?: Answer["mode"] };

const MAX_INPUT = 1_200;
const COPY = {
  title: "Ask Manci", subtitle: "Understand what you own.", close: "Close assistant", clear: "Clear chat",
  greeting: "Make sense of tokenized ownership.",
  intro: "Ask about ownership, jurisdictions and the legal process behind Manci.",
  starters: ["What do I actually own with a Manci token?", "How does jurisdiction affect a tokenized asset?", "How are lawyers involved?"],
  placeholder: "What would you like to understand?", question: "Your question", send: "Send question",
  thinking: "Finding an answer…", you: "You", assistant: "Manci", materials: "From Manci materials", sources: "Sources",
  retry: "Try again", error: "The answer could not be loaded. Please try again.",
  rateLimit: "Please wait a moment before asking again.", stopped: "The response was stopped. You can try again.",
  unavailable: "Manci is temporarily unavailable. Try again or contact the team.",
  privacy: "Questions may be sent to Anthropic to generate an answer. Do not send personal documents or wallet secrets.",
  basis: "Based on Manci materials. For terms of a specific offer,", contact: "contact the team.",
  chars: "characters", keyboard: "Enter to send · Shift + Enter for a new line",
} as const;

/** Sources are links only: neither model prose nor URLs are rendered as HTML. */
function safeSourceHref(href: string): string | null {
  if (href.startsWith("/") && !href.startsWith("//") && !href.includes("\\")) return href;
  try {
    const url = new URL(href);
    return url.protocol === "https:" ? url.href : null;
  } catch { return null; }
}

function readAnswer(value: unknown): Answer | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Partial<Answer>;
  if (typeof data.answer !== "string" || !data.answer.trim() ||
      !Array.isArray(data.sources) || (data.mode !== "claude" && data.mode !== "knowledge") ||
      typeof data.knowledgeVersion !== "string") return null;
  return {
    answer: data.answer,
    mode: data.mode,
    knowledgeVersion: data.knowledgeVersion,
    sources: data.sources.filter((source): source is Source => !!source &&
      typeof source.title === "string" && typeof source.href === "string" &&
      (source.section === undefined || typeof source.section === "string") &&
      safeSourceHref(source.href) !== null),
  };
}

export function ManciAssistant() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState<RetryRequest | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const nextMessageId = useRef(0);
  const id = useId();
  const copy = COPY;

  const closePanel = useCallback(() => {
    if (requestRef.current) {
      requestRef.current.abort();
      requestRef.current = null;
      setBusy(false);
      setError(COPY.stopped);
    }
    setOpen(false);
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open) {
      if (!dialog.open) dialog.showModal();
      inputRef.current?.focus({ preventScroll: true });
    } else if (dialog.open) {
      dialog.close();
      const target = returnFocusRef.current;
      (target?.isConnected ? target : launcherRef.current)?.focus({ preventScroll: true });
    }
  }, [open]);

  useEffect(() => () => {
    requestRef.current?.abort();
    requestRef.current = null;
  }, []);

  useEffect(() => {
    if (open && transcriptRef.current) transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
  }, [messages, busy, error, open]);

  async function requestAnswer(request: RetryRequest) {
    if (requestRef.current) return;
    const controller = new AbortController();
    requestRef.current = controller;
    setBusy(true);
    setError(null);
    setRetry(request);
    const timeout = window.setTimeout(() => controller.abort(), 45_000);
    let failureMessage: string = COPY.error;
    try {
      const response = await fetch("/api/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      const body: unknown = await response.json();
      if (requestRef.current !== controller) return;
      if (!response.ok) {
        failureMessage = response.status === 429 ? COPY.rateLimit
          : response.status === 503 ? COPY.unavailable : COPY.error;
        throw new Error(failureMessage);
      }
      const result = body && typeof body === "object" && "ok" in body && body.ok === true && "data" in body
        ? readAnswer(body.data) : null;
      if (!result) throw new Error(COPY.error);
      setMessages((current) => [...current, {
        id: nextMessageId.current++, role: "assistant", content: result.answer,
        sources: result.sources, mode: result.mode,
      }]);
      setRetry(null);
    } catch {
      if (requestRef.current === controller) {
        setError(failureMessage);
      }
    } finally {
      window.clearTimeout(timeout);
      if (requestRef.current === controller) {
        requestRef.current = null;
        setBusy(false);
      }
    }
  }

  function send(question = input) {
    const content = question.trim();
    if (!content || content.length > MAX_INPUT || requestRef.current) return;
    const message: DisplayMessage = { id: nextMessageId.current++, role: "user", content };
    // A failed or stopped question can be retried, or replaced by a new one.
    const history = messages.at(-1)?.role === "user" ? messages.slice(0, -1) : messages;
    const next = [...history, message];
    setMessages(next);
    setInput("");
    const recent = next.slice(-8).map(({ role, content: text }) => ({ role, content: text }));
    // Keep a long answer from making the next valid question exceed the API's
    // conversation budget. The complete transcript remains visible locally.
    while (recent.length > 1 && recent.reduce((total, item) => total + item.content.length, 0) > 16_000) recent.shift();
    void requestAnswer({ messages: recent });
    inputRef.current?.focus();
  }

  function clearChat() {
    requestRef.current?.abort();
    requestRef.current = null;
    setBusy(false);
    setMessages([]);
    setInput("");
    setError(null);
    setRetry(null);
    inputRef.current?.focus();
  }

  function trapFocus(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key !== "Tab") return;
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], textarea:not([disabled]), select:not([disabled]), [tabindex="0"]',
    )).filter((element) => element.getClientRects().length > 0);
    const first = items[0];
    const last = items.at(-1);
    if (!first || !last) { event.preventDefault(); return; }
    if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault(); first.focus();
    }
  }

  return (
    <>
      <button ref={launcherRef} className={styles.launcher} type="button" aria-haspopup="dialog"
        aria-expanded={open} aria-controls={id} onClick={() => {
          returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          setOpen(true);
        }}>
        <ChatIcon /><span>{copy.title}</span><span className={styles.launcherDot} aria-hidden="true" />
      </button>
      <dialog ref={dialogRef} id={id} className={styles.dialog} aria-labelledby={`${id}-title`}
        lang="en" onCancel={(event) => { event.preventDefault(); closePanel(); }}
        onClose={closePanel} onKeyDown={trapFocus} onClick={(event) => {
          if (event.target === event.currentTarget) {
            const box = event.currentTarget.getBoundingClientRect();
            if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) closePanel();
          }
        }}>
        <div className={styles.panel}>
          <header className={styles.header}>
            <div className={styles.identity}><span className={styles.avatar}><ChatIcon /></span><div>
              <h2 id={`${id}-title`}>{copy.title}</h2><p>{copy.subtitle}</p>
            </div></div>
            <button type="button" className={styles.iconButton} onClick={closePanel} aria-label={copy.close} title={copy.close}><CloseIcon /></button>
          </header>
          <div className={styles.toolbar}>
            <span className={styles.toolbarNote}>Your Manci guide</span>
            <button type="button" className={styles.clear} onClick={clearChat} disabled={!messages.length && !input && !busy}>{copy.clear}</button>
          </div>
          <div ref={transcriptRef} className={styles.transcript} role="log" aria-label={copy.title} aria-live="polite" aria-relevant="additions text">
            {messages.length === 0 && <div className={styles.welcome}>
              <span className={styles.eyebrow}>MANCI</span><h3>{copy.greeting}</h3><p>{copy.intro}</p>
              <div className={styles.starters}>{copy.starters.map((question) => <button type="button" key={question} onClick={() => send(question)} disabled={busy}><span>{question}</span><ArrowIcon /></button>)}</div>
            </div>}
            {messages.map((message) => <article key={message.id} className={message.role === "user" ? styles.userMessage : styles.answerMessage} lang="en">
              <p className={styles.messageLabel}>{message.role === "user" ? COPY.you
                : message.mode === "knowledge" ? COPY.materials : COPY.assistant}</p>
              <p className={styles.messageContent}>{message.content}</p>
              {!!message.sources?.length && <div className={styles.sources}><p>{COPY.sources}</p><ul>
                {message.sources.map((source, index) => {
                  const href = safeSourceHref(source.href);
                  if (!href) return null;
                  return <li key={`${href}-${index}`}><Link href={href} onClick={closePanel}>{source.title}{source.section && <span> · {source.section}</span>}<ArrowIcon /></Link></li>;
                })}
              </ul></div>}
            </article>)}
            {busy && <div className={styles.loading} role="status"><span aria-hidden="true"><i /><i /><i /></span>{copy.thinking}</div>}
            {error && <div className={styles.error} role="alert"><p>{error}</p>{retry && <button type="button" onClick={() => void requestAnswer(retry)} disabled={busy}>{copy.retry}<ArrowIcon /></button>}</div>}
          </div>
          <form className={styles.composer} onSubmit={(event) => { event.preventDefault(); send(); }}>
            <label className={styles.srOnly} htmlFor={`${id}-input`}>{copy.question}</label>
            <div className={styles.inputWrap}>
              <textarea ref={inputRef} id={`${id}-input`} value={input} onChange={(event) => setInput(event.target.value)}
                placeholder={copy.placeholder} maxLength={MAX_INPUT} rows={2} aria-describedby={`${id}-privacy`}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send(); }
                }} />
              <button type="submit" disabled={busy || !input.trim()} aria-label={copy.send} title={copy.send}><ArrowIcon /></button>
            </div>
            <div className={styles.inputMeta}><span>{copy.keyboard}</span><span aria-label={`${input.length} / ${MAX_INPUT} ${copy.chars}`}>{input.length}/{MAX_INPUT}</span></div>
            <p id={`${id}-privacy`} className={styles.privacy}>{copy.privacy}</p>
          </form>
          <footer className={styles.footer}>{copy.basis} <Link href="/contact" onClick={closePanel}>{copy.contact}</Link>{" · "}<Link href="/legal/privacy" onClick={closePanel}>Privacy</Link></footer>
        </div>
      </dialog>
    </>
  );
}

function ChatIcon() {
  return <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M20 11.5a8 8 0 0 1-8 8H4l1.7-4.1A8 8 0 1 1 20 11.5Z" strokeLinejoin="round" /><path d="M8.5 10.5h7M8.5 13.5h4" strokeLinecap="round" /></svg>;
}
function ArrowIcon() {
  return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M5 12h14m-5-5 5 5-5 5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
function CloseIcon() {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" strokeLinecap="round" /></svg>;
}
