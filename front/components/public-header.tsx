"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { AccountMenu } from "@/components/account-menu";
import { BrandLogo } from "@/components/brand-logo";
import {
  MX_INSTRUMENTS,
  MX_PRIMARY_NAV,
  MX_ROUTES,
} from "@/components/mx/nav";

/** Marks the "What we tokenize" trigger active on any instrument page. */
function isInstrumentPath(path: string) {
  return path.startsWith(MX_ROUTES.instruments);
}

/**
 * Public header, ported from the structural prototype: paper bar, hairline
 * bottom rule, mono wordmark, one dropdown, five links, one CTA.
 *
 * The prototype's inline JS is a demo; this is the real implementation —
 * the dropdown and the mobile panel are disclosure widgets with
 * `aria-expanded` / `aria-controls`, they close on Escape (returning focus to
 * their trigger), on an outside click, and on navigation.
 *
 * The wallet / account control is unchanged behaviour — `AccountMenu` still
 * renders the connect button when disconnected and the account dropdown when
 * connected.
 */
export function PublicHeader() {
  const path = usePathname();
  const [dropOpen, setDropOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  const dropId = useId();
  const mobileId = useId();
  const dropWrapRef = useRef<HTMLDivElement>(null);
  const dropBtnRef = useRef<HTMLButtonElement>(null);
  const burgerRef = useRef<HTMLButtonElement>(null);

  // Close both panels whenever the route changes — adjusted during render
  // (not in an effect) so the reset happens before paint.
  const [prevPath, setPrevPath] = useState(path);
  if (prevPath !== path) {
    setPrevPath(path);
    setDropOpen(false);
    setMobileOpen(false);
  }

  useEffect(() => {
    if (!dropOpen && !mobileOpen) return;

    function onPointerDown(e: MouseEvent) {
      const target = e.target as Node;
      if (dropWrapRef.current?.contains(target)) return;
      if (burgerRef.current?.contains(target)) return;
      setDropOpen(false);
      setMobileOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      // Return focus to whichever trigger owns the open panel.
      if (dropOpen) dropBtnRef.current?.focus();
      else if (mobileOpen) burgerRef.current?.focus();
      setDropOpen(false);
      setMobileOpen(false);
    }

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [dropOpen, mobileOpen]);

  return (
    <header className="mx-head">
      <div className="mx-head-in">
        <Link href={MX_ROUTES.home} className="mx-logo">
          <BrandLogo />
        </Link>

        <nav className="mx-nav" aria-label="Main">
          <div className="mx-drop mx-collapse" ref={dropWrapRef}>
            <button
              type="button"
              ref={dropBtnRef}
              className={`mx-navlink ${isInstrumentPath(path) ? "is-on" : ""}`}
              aria-expanded={dropOpen}
              aria-controls={dropId}
              onClick={() => {
                setDropOpen((v) => !v);
                setMobileOpen(false);
              }}
            >
              What we tokenize <span aria-hidden>▾</span>
            </button>
            {dropOpen && (
              <div className="mx-drop-menu" id={dropId}>
                {MX_INSTRUMENTS.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setDropOpen(false)}
                  >
                    {item.label}
                  </Link>
                ))}
                <div className="mx-drop-sep" />
                <Link
                  href={MX_ROUTES.instruments}
                  className="mx-drop-all"
                  onClick={() => setDropOpen(false)}
                >
                  Compare all eight →
                </Link>
              </div>
            )}
          </div>

          {MX_PRIMARY_NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="mx-navlink mx-collapse"
              aria-current={path === item.href ? "page" : undefined}
            >
              {item.label}
            </Link>
          ))}

          <Link href={MX_ROUTES.apply} className="mx-btn mx-btn--sm ml-1.5">
            Apply to issue
          </Link>

          <AccountMenu />

          <button
            type="button"
            ref={burgerRef}
            className="mx-burger"
            aria-label="Menu"
            aria-expanded={mobileOpen}
            aria-controls={mobileId}
            onClick={() => {
              setMobileOpen((v) => !v);
              setDropOpen(false);
            }}
          >
            <span aria-hidden>{mobileOpen ? "✕" : "☰"}</span>
          </button>
        </nav>
      </div>

      {mobileOpen && (
        <nav
          className="mx-mobile"
          id={mobileId}
          aria-label="Main (compact)"
          // Tapping any entry closes the panel, including a link to the page
          // you are already on (where no route change would fire).
          onClick={() => setMobileOpen(false)}
        >
          <Link href={MX_ROUTES.instruments}>What we tokenize</Link>
          {MX_PRIMARY_NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              aria-current={path === item.href ? "page" : undefined}
            >
              {item.label}
            </Link>
          ))}
          <Link href={MX_ROUTES.invest}>For investors</Link>
          <Link href={MX_ROUTES.apply} className="mx-mobile-cta">
            Apply to issue →
          </Link>
        </nav>
      )}
    </header>
  );
}
