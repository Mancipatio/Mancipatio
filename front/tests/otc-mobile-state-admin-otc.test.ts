// /admin/otc, pinned as source (the style of tests/reclaim-ui-gates.test.ts):
//   - "Create contract" opens one deal per request: a synchronous lock is
//     taken before the first await and held through the finality wait and
//     the flip, the request is re-read right before signing, and an Open
//     deal with the request's terms that no request records blocks a second
//     one (F057);
//   - "Cancel & refund" reports the on-chain cancel and the request-row
//     bookkeeping separately: once the send landed, the dialog closes, the
//     audit and the success toast come first, and a failed flip is its own
//     persistent notice, never "Failed to cancel deal" (F065);
//   - the decline dialog says what happens: a generic notice, the reason
//     kept private (F058).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const page = readFileSync(join(process.cwd(), "app/admin/otc/page.tsx"), "utf8");
/** A slice without its line comments (they talk about awaits too). */
const code = (s: string) => s.replace(/^\s*\/\/.*$/gm, "");
const slice = (start: string, end: string) => {
  const from = page.indexOf(start);
  const to = page.indexOf(end, from);
  expect(from, start).toBeGreaterThan(-1);
  expect(to, end).toBeGreaterThan(from);
  return page.slice(from, to);
};

describe("Create contract opens one deal per request", () => {
  const create = slice("async function createContract(req: OtcRequest) {", "async function flipRequest(");

  it("takes the lock and marks the row before its first await, and releases both in finally", () => {
    const body = code(create);
    const firstAwait = body.indexOf("await ");
    expect(firstAwait).toBeGreaterThan(-1);
    expect(body).toMatch(/if \(createLock\.current \|\| !wallet \|\| !conn\.wallet\) return;/);
    expect(body.indexOf("createLock.current = true")).toBeLessThan(firstAwait);
    expect(body.indexOf("setCreatingId(req.id)")).toBeLessThan(firstAwait);
    expect(create).toMatch(/finally \{\s*createLock\.current = false;\s*setCreatingId\(null\);\s*\}/);
  });

  it("re-reads the request and scans for an unrecorded Open deal with its terms right before signing", () => {
    const send = create.indexOf("tx.send(");
    expect(send).toBeGreaterThan(-1);
    for (const check of [
      "pendingFlip(req)",
      'listOtcRequests(conn.wallet, "requested")',
      'listOtcRequests(conn.wallet, "created")',
      "if (!fresh || fresh.deal_pda) {",
      "dealMatchesRequest(d.deal, req)",
      "d.deal.status === OtcDealStatus.Open",
    ]) {
      const at = create.indexOf(check);
      expect(at, check).toBeGreaterThan(-1);
      expect(at, check).toBeLessThan(send);
    }
    expect(create).toContain('"This request is no longer waiting"');
    expect(create).toContain('"This request already has an on-chain deal"');
  });

  it("holds the lock until the row has left the queue (the refresh after the flip is awaited)", () => {
    const created = create.indexOf('toast.showTx(sig, { title: "Escrow deal created" })');
    expect(created).toBeGreaterThan(-1);
    expect(create.slice(created)).toMatch(/await refresh\(\);/);
    expect(create.slice(created)).not.toMatch(/void refresh\(\);/);
  });

  it("disables every Create contract while one runs, labels the running row, and parks Retry flip and Reject on it", () => {
    expect(page).toContain("disabled={creatingId !== null || tx.isSending || !wallet}");
    expect(page).toContain('{creatingId === r.id ? "Creating…" : "Create contract"}');
    expect(page).toContain("disabled={retrying === r.id || creatingId === r.id || !wallet}");
    expect(page).toContain(
      "disabled={tx.isSending || !wallet || creatingId === r.id || pendingFlip(r) !== null}",
    );
  });
});

describe("Cancel & refund separates the on-chain cancel from the request bookkeeping", () => {
  const cancel = slice("async function cancelDeal(", "async function closeAndReclaim(");
  const failed = cancel.indexOf('"Failed to cancel deal"');
  const flip = cancel.indexOf("flipCancelledDealRequest(");

  it("only the build and the send can fail the cancel: the catch returns before any bookkeeping", () => {
    expect(failed).toBeGreaterThan(-1);
    expect(flip).toBeGreaterThan(failed);
    expect(cancel.indexOf("listOtcRequests(")).toBeGreaterThan(failed);
    expect(cancel.slice(failed, flip)).toMatch(/console\.error\("\[cancel_otc_deal\]", err\);\s*return;\s*\}/);
  });

  it("once the send landed: closes the dialog, records the audit and reports success before any further await", () => {
    const sent = cancel.indexOf("sig = await tx.send(");
    const told = cancel.indexOf('toast.showTx(sig, { title: "Deal cancelled & refunded" })');
    expect(sent).toBeGreaterThan(-1);
    expect(told).toBeGreaterThan(sent);
    expect(told).toBeLessThan(flip);
    const between = code(cancel.slice(sent + "sig = await tx.send(".length, told));
    expect(between).not.toContain("await ");
    expect(between).toContain("setConfirmCancel(null)");
    expect(between).toContain('ix_name: "cancel_otc_deal"');
  });

  it("flips the created row best effort, with the reason capped as the route caps it, and names a failed flip for what it is", () => {
    const bookkeeping = cancel.slice(flip);
    expect(bookkeeping).toContain('listOtcRequests(conn.wallet, "created")');
    expect(bookkeeping).toContain("admin_note: reason.slice(0, 2000) || null");
    expect(bookkeeping).toMatch(/if \(bookkeeping === "failed"\) \{/);
    expect(bookkeeping).toContain('title: "Deal cancelled, but its request wasn\'t updated"');
    expect(bookkeeping).toContain("Do not cancel again");
    expect(bookkeeping).toContain("duration: 0");
    // The function's last statement is the refresh, whatever the flip did.
    const end = bookkeeping.indexOf("\n  }\n");
    expect(end).toBeGreaterThan(-1);
    expect(bookkeeping.slice(0, end).trimEnd().endsWith("void refresh();")).toBe(true);
  });
});

describe("the decline dialog tells the truth", () => {
  it("promises a generic notice and the in-app row, keeps the reason private, and is busy while declining", () => {
    expect(page).not.toMatch(/parties are notified and the request leaves the pending queue/);
    expect(page).toMatch(
      /Both\s+parties get a short decline notice by email when one is on file,\s+and see the request as declined in Portfolio → Deals\. Your reason\s+stays on the request row and in the audit log; it is not shown\s+to them\./,
    );
    expect(page).toContain("busy={declining}");
    const reject = slice("async function rejectRequest(", "async function cancelDeal(");
    expect(reject.indexOf("setDeclining(true)")).toBeLessThan(reject.indexOf("await "));
    expect(reject).toMatch(/finally \{\s*setDeclining\(false\);\s*\}/);
  });
});
