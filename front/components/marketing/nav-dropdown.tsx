"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";

export type NavDropdownItem = {
  href: string;
  label: string;
  sub?: string;
  icon?: ReactNode;
  /** Render a divider above this item (used to split primary items from
   *  board/whitepaper shortcuts at the bottom of the menu). */
  dividerBefore?: boolean;
};

/** How long the pointer may be outside the wrapper before the menu closes.
 *  Gives the hover an "intent" window so diagonal mouse travel to the panel
 *  doesn't collapse it. */
const CLOSE_DELAY_MS = 180;

/** Generic hover-or-click dropdown for the public header. Two details keep
 *  the panel reachable with a mouse:
 *  1. The gap between button and panel is padding (`pt-2` on a wrapper that
 *     spans both), not margin — so the hover area is one continuous surface
 *     and `onMouseLeave` never fires while crossing the gap.
 *  2. Closing is debounced by CLOSE_DELAY_MS and cancelled on re-enter. */
export function NavDropdown({
  label,
  items,
  active = false,
  variant = "list",
}: {
  label: string;
  items: NavDropdownItem[];
  active?: boolean;
  /** "list" = single column; "grid" = two compact columns for long menus
   *  (e.g. all eight asset categories) so the panel fits on small screens. */
  variant?: "list" | "grid";
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function clearCloseTimer() {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }

  function handleMouseEnter() {
    clearCloseTimer();
    setOpen(true);
  }

  function handleMouseLeave() {
    clearCloseTimer();
    closeTimer.current = setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  }

  // Click-outside closes the menu when it was opened via click/tap.
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  // Never leave a pending close behind on unmount.
  useEffect(() => clearCloseTimer, []);

  return (
    <div
      ref={ref}
      className="relative"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        className={`flex items-center gap-1 text-sm transition-colors ${
          active ? "text-slate-900" : "text-slate-600 hover:text-slate-900"
        }`}
      >
        {label}
        <svg
          className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          aria-hidden
        >
          <path
            d="m6 9 6 6 6-6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 pt-2">
          <div
            role="menu"
            className={`overflow-hidden rounded-lg border border-slate-200 bg-white shadow-card-lg ${
              variant === "grid" ? "w-[34rem]" : "w-80"
            }`}
          >
            <div
              className={variant === "grid" ? "grid grid-cols-2" : undefined}
            >
              {items.map((it) => (
                <div key={it.href}>
                  {it.dividerBefore && (
                    <div aria-hidden className="border-t border-slate-100" />
                  )}
                  <Link
                    href={it.href}
                    role="menuitem"
                    onClick={() => setOpen(false)}
                    className={`flex items-start gap-3 transition-colors hover:bg-slate-50 ${
                      variant === "grid" ? "px-3 py-2.5" : "px-4 py-3"
                    }`}
                  >
                    {it.icon && (
                      <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-md bg-brand-50 text-brand-700">
                        {it.icon}
                      </span>
                    )}
                    <span>
                      <span className="block text-[13px] font-medium text-slate-900">
                        {it.label}
                      </span>
                      {it.sub && (
                        <span className="mt-0.5 block text-[12px] leading-snug text-slate-500">
                          {it.sub}
                        </span>
                      )}
                    </span>
                  </Link>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
