"use client";

import Link from "next/link";
import { useState } from "react";
import { FieldError, FieldLabel } from "@/components/field";
import { TurnstileWidget } from "@/components/turnstile-widget";
import { combine, maxLength, minLength, required, type Validator } from "@/lib/form-validation";
import { ASSET_TYPES } from "@/lib/asset-types";
import { createInquiry } from "@/lib/inquiries";
import { useToast } from "@/lib/toast";
import { TURNSTILE_ACTIONS, turnstileSiteKey } from "@/lib/turnstile";

const email: Validator = (v) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim())
    ? null
    : "Enter a valid email address";

const VALIDATORS: Record<string, Validator> = {
  email: combine(required("Email"), email),
  idea: combine(required("Your idea"), minLength(20, "Your idea"), maxLength(5000, "Your idea")),
};

const ASSET_KIND_OPTIONS = [
  ...ASSET_TYPES.map((t) => t.title),
  "Something else",
];

const INPUT_CLASS =
  "mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-slate-400";

export function ContactForm() {
  const { showError } = useToast();
  const [name, setName] = useState("");
  const [emailValue, setEmailValue] = useState("");
  const [company, setCompany] = useState("");
  const [assetKind, setAssetKind] = useState("");
  const [idea, setIdea] = useState("");
  // Honeypot — invisible to humans; bots that fill it are silently dropped
  // server-side.
  const [website, setWebsite] = useState("");
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  // Turnstile (only when this build has a site key). Tokens are single-use:
  // every attempt remounts the widget for a new one.
  const challenge = turnstileSiteKey() !== null;
  const [challengeToken, setChallengeToken] = useState<string | null>(null);
  const [challengeRound, setChallengeRound] = useState(0);

  const errors: Record<string, string | null> = {
    email: VALIDATORS.email(emailValue),
    idea: VALIDATORS.idea(idea),
  };
  const hasErrors = Object.values(errors).some(Boolean);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setTouched({ email: true, idea: true });
    if (hasErrors || busy) return;
    if (challenge && !challengeToken) {
      showError("Complete the security check", "Finish the check above the Send button, then send again.");
      return;
    }
    setBusy(true);
    try {
      const id = await createInquiry({
        name: name.trim(),
        email: emailValue.trim(),
        company: company.trim() || undefined,
        asset_kind: assetKind || undefined,
        idea: idea.trim(),
        website,
        turnstile_token: challengeToken ?? undefined,
      });
      if (id) {
        setSent(true);
      } else {
        showError(
          "Could not send your inquiry",
          "Something went wrong on our side — please try again in a moment.",
        );
      }
    } finally {
      setBusy(false);
      if (challenge) {
        setChallengeToken(null);
        setChallengeRound((round) => round + 1);
      }
    }
  }

  if (sent) {
    return (
      <div className="panel panel-pad text-center">
        <p className="text-lg font-semibold text-slate-900">
          Thanks — our team will get back to you.
        </p>
        <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-slate-600">
          We&apos;ll evaluate your idea and reply to{" "}
          <span className="font-medium text-slate-900">{emailValue.trim()}</span>{" "}
          with a proposed solution.
        </p>
        <Link href="/markets/types" className="btn-ghost mt-5 inline-block">
          Browse asset types meanwhile
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="panel panel-pad space-y-4" noValidate>
      {/* Honeypot field — visually hidden, ignored by humans. */}
      <div
        aria-hidden="true"
        className="absolute h-px w-px overflow-hidden"
        style={{ position: "absolute", left: "-9999px" }}
      >
        <label>
          Website
          <input
            type="text"
            name="website"
            tabIndex={-1}
            autoComplete="off"
            value={website}
            onChange={(e) => setWebsite(e.target.value)}
          />
        </label>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <FieldLabel>Name</FieldLabel>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Jane Doe"
            className={INPUT_CLASS}
            autoComplete="name"
          />
        </label>
        <label className="block">
          <FieldLabel required>Email</FieldLabel>
          <input
            type="email"
            value={emailValue}
            onChange={(e) => setEmailValue(e.target.value)}
            onBlur={() => setTouched((t) => ({ ...t, email: true }))}
            placeholder="jane@company.com"
            className={INPUT_CLASS}
            autoComplete="email"
          />
          <FieldError error={touched.email ? errors.email : null} />
        </label>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <FieldLabel>Company</FieldLabel>
          <input
            value={company}
            onChange={(e) => setCompany(e.target.value)}
            placeholder="Optional"
            className={INPUT_CLASS}
            autoComplete="organization"
          />
        </label>
        <label className="block">
          <FieldLabel>What kind of asset?</FieldLabel>
          <select
            value={assetKind}
            onChange={(e) => setAssetKind(e.target.value)}
            className={INPUT_CLASS}
          >
            <option value="">Select a category (optional)</option>
            {ASSET_KIND_OPTIONS.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="block">
        <FieldLabel required>Your idea</FieldLabel>
        <textarea
          value={idea}
          onChange={(e) => setIdea(e.target.value)}
          onBlur={() => setTouched((t) => ({ ...t, idea: true }))}
          rows={6}
          placeholder="What do you want to tokenize, and how should it work for holders?"
          className={INPUT_CLASS}
        />
        <FieldError error={touched.idea ? errors.idea : null} />
      </label>

      {challenge && (
        <TurnstileWidget key={challengeRound} action={TURNSTILE_ACTIONS.inquiry} onToken={setChallengeToken} />
      )}

      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] leading-relaxed text-slate-400">
          We evaluate every inquiry and reply by email.
        </p>
        <button type="submit" disabled={busy || (challenge && !challengeToken)} className="btn-brand disabled:opacity-60">
          {busy ? "Sending…" : "Send inquiry"}
        </button>
      </div>
    </form>
  );
}
