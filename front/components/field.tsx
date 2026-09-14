"use client";

import type { ReactNode } from "react";

// Minimal field wrapper that shows a label, the input, and an inline
// validation error. Error only shows after the user has touched the
// field (typically wired through useState in the parent), which keeps
// fresh forms quiet until the user actually tries something.

export function FieldError({ error }: { error: string | null | undefined }) {
  if (!error) return null;
  return (
    <p className="mt-1 text-[11px] text-red-700" role="alert">
      {error}
    </p>
  );
}

export function FieldLabel({
  children,
  required = false,
}: {
  children: ReactNode;
  required?: boolean;
}) {
  return (
    <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
      {children}
      {required && <span className="ml-0.5 text-red-600">*</span>}
    </span>
  );
}

export function FieldHelp({ children }: { children: ReactNode }) {
  return (
    <p className="mt-1 text-[11px] text-slate-400">{children}</p>
  );
}
