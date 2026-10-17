// /admin/custody request queues (F009, F197): the row's actions are real
// buttons in the FIRST cell, under the request label — a phone or a narrow
// window could not reach a trailing Actions column clipped by the card — the
// table scrolls sideways as a safety net, the rows that wait for the admin
// come first, and the conversion queue (the live mainnet flow) is rendered
// above the delivery queue. Same handlers, same disabled conditions.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { custodyQueueRank, sortCustodyQueue } from "@/lib/admin-badge-rules";

describe("sortCustodyQueue", () => {
  const row = (status: string, created_at: string, id = status + created_at) => ({ id, status, created_at });
  it("ranks a deposit to confirm first, then a request to approve, then the holder's turn, then history", () => {
    expect(["deposited", "in_delivery"].map(custodyQueueRank)).toEqual([0, 0]);
    expect(custodyQueueRank("requested")).toBe(1);
    expect(custodyQueueRank("vault_opened")).toBe(2);
    expect(["converted", "delivered", "returned", "cancelled", "approved", "whatever"].map(custodyQueueRank)).toEqual([3, 3, 3, 3, 3, 3]);
  });
  it("keeps newest-first inside a rank and is stable", () => {
    const rows = [
      row("converted", "2026-10-10T10:00:00Z", "a"),
      row("requested", "2026-10-11T10:00:00Z", "b"),
      row("vault_opened", "2026-10-12T10:00:00Z", "c"),
      row("deposited", "2026-10-09T10:00:00Z", "d"),
      row("requested", "2026-10-13T10:00:00Z", "e"),
      row("cancelled", "2026-10-14T10:00:00Z", "f"),
      row("deposited", "2026-10-08T10:00:00Z", "g"),
    ];
    expect(sortCustodyQueue(rows).map((r) => r.id)).toEqual(["d", "g", "e", "b", "c", "f", "a"]);
    // Unparseable dates fall back to the input order; the input is untouched.
    const odd = [row("requested", "x", "p"), row("requested", "y", "q"), row("deposited", "z", "r")];
    expect(sortCustodyQueue(odd).map((r) => r.id)).toEqual(["r", "p", "q"]);
    expect(odd.map((r) => r.id)).toEqual(["p", "q", "r"]);
    expect(sortCustodyQueue([])).toEqual([]);
  });
});

describe("/admin/custody queues (source)", () => {
  const page = readFileSync(join(process.cwd(), "app/admin/custody/page.tsx"), "utf8");
  const functionSource = (name: string) => {
    const start = page.indexOf(`\nfunction ${name}(`);
    expect(start, name).toBeGreaterThan(-1);
    const end = page.indexOf("\nfunction ", start + 1);
    return page.slice(start, end < 0 ? undefined : end);
  };
  const once = (src: string, text: string) => {
    const at = src.indexOf(text);
    expect(at, text).toBeGreaterThan(-1);
    expect(src.indexOf(text, at + 1), `${text} appears once`).toBe(-1);
    return at;
  };

  describe.each([
    ["ConversionRequestsSection", ["onClick={() => setApproveReq(r)}", "onClick={() => setRejectReq(r)}", "onClick={() => setCancelOpenReq(r)}", "onClick={() => setConfirmReq(r)}", "onClick={() => setReturnReq(r)}"]],
    ["DeliveryRequestsSection", ["onClick={() => setApproveReq(r)}", "onClick={() => setRejectReq(r)}", "onClick={() => setCancelOpenReq(r)}", "onClick={() => void markInDelivery(r)}", "onClick={() => setConfirmReq(r)}", "onClick={() => setReturnReq(r)}"]],
  ] as const)("%s", (name, handlers) => {
    const src = functionSource(name);

    it("has no trailing Actions column; Status is second; the table scrolls sideways", () => {
      expect(src).not.toMatch(/>Actions<\/th>/);
      const wrapper = once(src, '<div className="overflow-x-auto">');
      expect(wrapper).toBeLessThan(src.indexOf("<table"));
      const status = src.indexOf(">Status</th>");
      expect(status).toBeGreaterThan(src.indexOf(">Request</th>"));
      expect(status).toBeLessThan(src.indexOf(">Holder</th>"));
    });

    it("renders each action once, as a button in the first cell, before the holder cell", () => {
      const actions = once(src, '<div className="mt-2 flex flex-wrap items-center gap-2 empty:hidden">');
      const holderCell = src.indexOf("title={r.holder_wallet}");
      expect(holderCell).toBeGreaterThan(actions);
      for (const handler of handlers) {
        const at = once(src, handler);
        expect(at, handler).toBeGreaterThan(actions);
        expect(at, handler).toBeLessThan(holderCell);
      }
      // Buttons, not text links: at least 36 px tall, filled or bordered.
      expect(src).not.toMatch(/underline-offset-2 hover:underline disabled:opacity-50/);
      expect(src).toContain("className={ROW_ACTION_PRIMARY}");
      expect(src).toContain("className={ROW_ACTION_CONFIRM}");
      expect(src).toContain("className={ROW_ACTION_DANGER}");
      expect(page).toContain('"inline-flex min-h-9 items-center rounded-md px-3 text-xs font-medium disabled:opacity-50"');
    });

    it("lists actionable rows first", () => {
      expect(src).toContain("const ordered = useMemo(() => sortCustodyQueue(requests), [requests]);");
      expect(src).toContain("{ordered.map((r) => {");
      expect(src).not.toContain("{requests.map((r) => {");
    });
  });

  it("renders the conversion queue above the delivery queue, with an anchor, and the directory scrolls sideways", () => {
    const ops = functionSource("CustodyOps");
    const conversion = ops.indexOf("<ConversionRequestsSection");
    const delivery = ops.indexOf("<DeliveryRequestsSection");
    expect(conversion).toBeGreaterThan(-1);
    expect(delivery).toBeGreaterThan(conversion);
    expect(functionSource("ConversionRequestsSection")).toContain('id="conversion-requests"');
    expect(ops).toContain('<div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-card">');
    expect(ops).not.toContain('<div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-card">');
  });

  it("keeps the disabled reason visible under a disabled Confirm (phones show no title)", () => {
    expect(functionSource("ConversionRequestsSection")).toContain("Confirm is disabled: {confirmBlock}");
    expect(functionSource("DeliveryRequestsSection")).toContain("Confirm is disabled: {passportBlock}");
  });
});
