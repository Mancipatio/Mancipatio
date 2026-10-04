// The "Anchor a document" panel on /admin/platform, rendered to static markup
// (no jsdom here): nothing for a wallet that is not the on-chain Super Admin
// (or no wallet), the panel for the Super Admin; the page mounts it with
// Platform.admin. And the page's recording retry: only "not yet" is retried.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const SA = "8TEmJBkcoBsUjRPftZ3kdWb9NmZDy7Zy3a7GqFCK5Nx9";
const ADMIN = "6AnFbinF7X12mACTVEGfjWZyzYGAShEscAB5UgV3vHsP";

const hooks = vi.hoisted(() => ({ wallet: null as string | null }));
vi.mock("@solana/react-hooks", () => ({
  useWalletConnection: () => ({
    isReady: true,
    connected: hooks.wallet !== null,
    wallet: hooks.wallet === null ? undefined : { account: { address: hooks.wallet } },
  }),
  useSolanaClient: () => ({ runtime: { rpc: {} } }),
  useSendTransaction: () => ({ send: vi.fn(), isSending: false, signature: null, error: null }),
}));
vi.mock("@/lib/toast", () => ({
  useToast: () => ({ show: vi.fn(), showTx: vi.fn(), showError: vi.fn(), showPending: vi.fn(), dismiss: vi.fn(), toasts: [] }),
}));
const fetches = vi.hoisted(() => ({ results: [] as (unknown | Error)[], calls: 0 }));
vi.mock("@/lib/siws-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/siws-client")>()),
  signedFetch: vi.fn(async () => {
    const next = fetches.results[fetches.calls++];
    if (next instanceof Error) throw next;
    return next;
  }),
}));

import { DocumentAnchorPanel } from "@/app/admin/platform/document-anchor-panel";
import { recordDocumentAnchorWithRetry } from "@/lib/document-anchor-client";
import { DOCUMENT_ANCHOR_NOT_YET } from "@/lib/document-anchor";

const render = (superAdmin: string) => renderToStaticMarkup(createElement(DocumentAnchorPanel, { superAdmin }));

describe("DocumentAnchorPanel gating", () => {
  it("renders nothing for a wallet that is not the Super Admin, or no wallet", () => {
    hooks.wallet = ADMIN;
    expect(render(SA)).toBe("");
    hooks.wallet = null;
    expect(render(SA)).toBe("");
  });

  it("renders the panel for the Super Admin: reference, file picker, pasted hash", () => {
    hooks.wallet = SA;
    const markup = render(SA);
    expect(markup).toContain("Anchor a document");
    expect(markup).toContain('type="file"');
    expect(markup).toContain('placeholder="MANCI-2026-0001"');
    expect(markup).toContain("paste its SHA-256");
    expect(markup).toContain("Review and anchor");
    // Nothing to sign before both inputs are valid.
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Review and anchor<\/button>/);
  });

  it("the platform page mounts it with the on-chain Platform.admin", () => {
    const page = readFileSync(join(process.cwd(), "app/admin/platform/page.tsx"), "utf8");
    expect(page).toContain('import { DocumentAnchorPanel } from "./document-anchor-panel";');
    expect(page).toContain("<DocumentAnchorPanel superAdmin={platform.admin} />");
  });
});

describe("recordDocumentAnchorWithRetry", () => {
  const input = { signature: "sig", reference: "MANCI-2026-0001", sha256: "a".repeat(64) };
  const sleep = vi.fn(async () => {});
  beforeEach(() => {
    fetches.results = [];
    fetches.calls = 0;
    sleep.mockClear();
  });

  it("waits and posts again while the server's node does not show the transaction yet", async () => {
    fetches.results = [new Error(`${DOCUMENT_ANCHOR_NOT_YET} — try again`), new Error(`${DOCUMENT_ANCHOR_NOT_YET} — try again`), { id: "row-1" }];
    await expect(recordDocumentAnchorWithRetry(null, input, [1, 2, 3], sleep)).resolves.toEqual({ id: "row-1" });
    expect(fetches.calls).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("throws any other refusal at once, and gives up after the last wait", async () => {
    fetches.results = [new Error("Not recorded: The memo text is not the expected anchor text")];
    await expect(recordDocumentAnchorWithRetry(null, input, [1, 2], sleep)).rejects.toThrow(/memo text/);
    expect(fetches.calls).toBe(1);
    fetches.results = [new Error(DOCUMENT_ANCHOR_NOT_YET), new Error(DOCUMENT_ANCHOR_NOT_YET), new Error(DOCUMENT_ANCHOR_NOT_YET)];
    fetches.calls = 0;
    await expect(recordDocumentAnchorWithRetry(null, input, [1, 2], sleep)).rejects.toThrow(DOCUMENT_ANCHOR_NOT_YET);
    expect(fetches.calls).toBe(3);
  });
});
