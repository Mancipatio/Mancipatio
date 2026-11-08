// What a reader sees of an issuer update (components/issuer-updates), rendered
// to static markup (no jsdom here): kind, period and date; the holders-only
// badge; an excerpt that opens in full; each document's name, size, SHA-256
// (short, with the full value in its title) and the server's verification;
// the public link or the signed open; the anchor's explorer link. The asset
// page block starts with the issuer-content note and loads without a wallet
// prompt. And the browser half of the anchor: a send that may have landed
// keeps its signature for "Record it"; a refused one keeps nothing.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@solana/react-hooks", () => ({
  useWalletConnection: () => ({ isReady: true, connected: false, wallet: undefined }),
}));
vi.mock("@/lib/toast", () => ({
  useToast: () => ({ show: vi.fn(), showTx: vi.fn(), showError: vi.fn(), showPending: vi.fn(), dismiss: vi.fn(), toasts: [] }),
}));
vi.mock("@/lib/network", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/network")>()),
  detectNetwork: () => "devnet",
}));
const remote = vi.hoisted(() => ({ signedFetch: vi.fn() }));
vi.mock("@/lib/siws-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/siws-client")>()),
  signedFetch: remote.signedFetch,
}));

import { UpdateArticle } from "@/components/issuer-updates/update-article";
import { AssetUpdatesBlock } from "@/components/issuer-updates/asset-updates";
import { ISSUER_CONTENT_NOTE, type PublicIssuerUpdate } from "@/lib/issuer-updates";
import { anchorIssuerUpdate, publicDocumentHref, readPendingUpdateAnchor } from "@/lib/issuer-updates-client";

const SHA = "0123456789abcdef".repeat(4);
const TX = "5RBDZNDobPiJGpQsfcvPLuSdzyUXRxBnpXNU4sFQg2ud3sTiSPyWnPrfvyN4myMYTvEUWjtYnGijuryNNrXqeDqm";
const update = (over: Partial<PublicIssuerUpdate> = {}): PublicIssuerUpdate => ({
  id: "20000000-0000-4000-8000-000000000001", issuer_pda: "I", asset_pda: "A", kind: "quarterly_report",
  title: "Q3 report", body: "Revenue grew.\n\nThe second plant opened.", period_label: "Q3 2026", visibility: "public",
  published_at: "2026-11-08T10:00:00.000Z", anchor_tx: null,
  documents: [{ id: "30000000-0000-4000-8000-000000000001", file_name: "Q3 report.pdf", sha256: SHA, size_bytes: 1_250_000, content_type: "application/pdf" }],
  ...over,
});
const html = (u: PublicIssuerUpdate, props: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(UpdateArticle, { update: u, variant: "public", ...props }));

describe("an update as readers see it", () => {
  it("shows the kind, period, date, text and each document's hash with the server's verification", () => {
    const markup = html(update(), { documentHref: (doc: { id: string }) => publicDocumentHref(doc.id) });
    expect(markup).toContain("Quarterly report · Q3 2026");
    expect(markup).toContain("8 November 2026");
    expect(markup).toContain("<p class=\"whitespace-pre-line\">The second plant opened.</p>");
    expect(markup).toContain("Q3 report.pdf");
    expect(markup).toContain("1.2 MB");
    expect(markup).toContain(`title="${SHA}"`);
    expect(markup).toContain("0123456789…89abcdef");
    expect(markup).toContain("File bytes verified by the server");
    expect(markup).toContain(`href="/api/issuer-updates/document?id=30000000-0000-4000-8000-000000000001"`);
    expect(markup).not.toContain("Holders only");
    expect(markup).not.toContain("Anchored on chain");
  });

  it("marks holders-only updates, links the anchor on the explorer, and opens a long text on request", () => {
    const long = "word ".repeat(200);
    const markup = html(update({ visibility: "holders", anchor_tx: TX, body: long }), { onOpenDocument: () => undefined });
    expect(markup).toContain("Holders only");
    expect(markup).toContain(`https://explorer.solana.com/tx/${TX}?cluster=devnet`);
    expect(markup).toContain("Read the full update");
    expect(markup).toContain("aria-expanded=\"false\"");
    expect(markup).not.toContain("/api/issuer-updates/document?id="); // a holders-only file opens through the signed route
    expect(markup).toContain("Open ↗");
  });

  it("the asset page block says whose words they are and loads without asking the wallet", () => {
    const markup = renderToStaticMarkup(createElement(AssetUpdatesBlock, { assetPda: "A", issuerPda: "I" }));
    expect(markup).toContain("Updates from the issuer");
    expect(markup).toContain(ISSUER_CONTENT_NOTE);
    expect(markup).toContain("Loading updates");
    expect(remote.signedFetch).not.toHaveBeenCalled();
  });
});

describe("the issuer's anchor in the browser", () => {
  const storage = new Map<string, string>();
  beforeEach(() => {
    storage.clear();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (k: string) => storage.get(k) ?? null,
        setItem: (k: string, v: string) => void storage.set(k, v),
        removeItem: (k: string) => void storage.delete(k),
      },
    });
  });
  afterEach(() => vi.unstubAllGlobals());
  const context = { network: "devnet" as const, signer: "W", id: "u1" };

  it("keeps the signature of a send that may have landed, so the page can record it", async () => {
    await expect(anchorIssuerUpdate(null, context, {
      send: async (track) => {
        const signer = track({ address: "W", signTransactions: async () => [{ W: new Uint8Array(64).fill(7) }] } as never);
        await (signer as unknown as { signTransactions: (t: unknown[]) => Promise<unknown> }).signTransactions([{}]);
        throw new Error("connection dropped after signing");
      },
      wait: async () => "confirmed",
    })).rejects.toThrow(/connection dropped/);
    expect(readPendingUpdateAnchor("devnet", "u1")?.signer).toBe("W");
  });

  it("keeps nothing when the wallet refused, and forgets a transaction the network refused", async () => {
    await expect(anchorIssuerUpdate(null, context, {
      send: async () => { throw new Error("User rejected the request"); },
      wait: async () => "confirmed",
    })).rejects.toThrow(/rejected/);
    expect(readPendingUpdateAnchor("devnet", "u1")).toBeNull();
    await expect(anchorIssuerUpdate(null, context, { send: async () => TX, wait: async () => "failed" })).rejects.toThrow(/refused/);
    expect(readPendingUpdateAnchor("devnet", "u1")).toBeNull();
    await expect(anchorIssuerUpdate(null, context, { send: async () => TX, wait: async () => "timeout" })).rejects.toThrow(/not confirmed/);
    expect(readPendingUpdateAnchor("devnet", "u1")?.signature).toBe(TX);
  });
});
