// Holders on phones (Phantom in-app browser) could not reach "Deposit tokens":
// the trailing Actions column was clipped by an overflow-hidden container.
// The row actions now render under the status, and the table scrolls sideways.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const pages = ["conversion", "delivery"];
const read = (page: string) =>
  fs.readFileSync(path.join(__dirname, "..", "app", "portfolio", page, "page.tsx"), "utf8");

describe.each(pages)("/portfolio/%s holder actions", (page) => {
  const src = read(page);

  it("has no trailing Actions column and a horizontally scrollable table", () => {
    expect(src).not.toMatch(/>Actions<\/th>/);
    // The table scrolls sideways and never clips; its top margin follows what
    // sits above it (the conversion page's request toolbar, a heading elsewhere).
    expect(src).toMatch(/className="mt-\d+ overflow-x-auto rounded-xl/);
    expect(src).not.toMatch(/className="mt-\d+ overflow-hidden rounded-xl/);
  });

  it("renders each action once, inside the status cell (before the Transactions cell)", () => {
    const statusHint = src.indexOf("STATUS_HINT[r.status]");
    const txCell = src.indexOf('<TxLink sig={r.deposit_tx} label="deposit" />');
    expect(statusHint).toBeGreaterThan(-1);
    expect(txCell).toBeGreaterThan(statusHint);
    for (const label of [
      "Deposit tokens",
      "Reclaim tokens after deadline",
      "Cancel request\n",
      "Vault closed — deposit disabled",
      "Receipt saved — retry recording above",
    ]) {
      const at = src.indexOf(label);
      expect(at, label).toBeGreaterThan(statusHint);
      expect(at, label).toBeLessThan(txCell);
      expect(src.indexOf(label, at + 1), label).toBe(-1);
    }
  });
});

// The conversion page (the delivery page is its older mirror and keeps its
// header button for now): the request button sits with the requests it
// creates, the reason it is disabled is written next to it, the holder's next
// step is a card above the table, a chain-read failure never hides the
// requests, and background re-lists never raise a wallet prompt. The helpers
// behind it are covered by tests/conversion-holder.test.ts; the server
// verdict by tests/holder-conversion-list-mine.test.ts.
describe("/portfolio/conversion request toolbar and next step", () => {
  const src = read("conversion");
  /** Code without its comments (a label in a comment places nothing). */
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("renders '+ Request conversion' once, between the list banner and the table, as a real button with its reason beside it", () => {
    const button = code.indexOf("+ Request conversion");
    expect(button).toBeGreaterThan(code.indexOf("{listError &&"));
    expect(button).toBeLessThan(code.indexOf("overflow-x-auto rounded-xl"));
    expect(code.indexOf("+ Request conversion", button + 1)).toBe(-1);
    const tag = code.slice(code.lastIndexOf("<button", button), button);
    expect(tag).toContain("disabled={!canRequest}");
    expect(tag).toContain("aria-describedby={gateId}");
    for (const cls of ["min-h-10", "w-full", "shrink-0", "whitespace-nowrap", "sm:w-auto"]) expect(tag, cls).toContain(cls);
    expect(tag).not.toContain("title=");
  });

  it("writes exactly one reason next to the button, and the toolbar stacks on a phone", () => {
    expect(code).toContain("flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between");
    for (const text of [
      "Checking your verification and holdings…",
      "Sign in with your wallet to check eligibility",
      "Could not load —",
      "Could not check your verification —",
      "Verify your identity →",
      "You don&apos;t hold convertible tokens yet",
      "Ready — {gate.count} convertible",
    ]) expect(code, text).toContain(text);
    expect(code).toContain('href="/verify"');
    expect(code).toContain("conversionRequestGate({");
    expect(code).toContain('const canRequest = gate.kind === "ready"');
    expect(code).toMatch(/\{listBusy \? "Refreshing…" : "Refresh"\}/);
  });

  it("drives eligibility from the create gate's verdict, not from a raw status or a contact-Manci banner", () => {
    expect(code).toContain("kyc: verdict");
    expect(code).not.toContain('kycStatus === "verified"');
    expect(code).not.toContain("contact Manci to");
  });

  it("puts the holder's next step above the toolbar, with a deposit control of its own", () => {
    const card = code.indexOf("Your escrow is ready — deposit");
    expect(card).toBeGreaterThan(-1);
    expect(card).toBeLessThan(code.indexOf("+ Request conversion"));
    expect(code).toContain("Waiting for Manci to open your escrow");
    expect(code).toContain("Deposit received — waiting for Manci to confirm the conversion");
    expect(code).toContain("Deposit {nextStep.amount} units");
    expect(code).toContain("onClick={() => void deposit(nextStep)}");
    expect(code).toContain("sortConversionRequests(");
  });

  it("keeps the requests table when the chain read fails, with a retry, and loads the chain with a bounded retry", () => {
    expect(code).not.toMatch(/\{failed \? \(/);
    expect(code).not.toContain("data === null");
    expect(code).toContain("setHoldingsError(null)");
    expect(code).toMatch(/onClick=\{\(\) => void refresh\(\)\}/);
    expect(code).toContain("withRpcReadRetry(");
    expect(code).toContain("setRequestsLoaded(true)");
    expect(code).toContain("!requestsLoaded && !listError ?");
  });

  it("re-lists in the background without ever raising a wallet prompt, signs the read itself only for a click, and tells a lost session from other errors", () => {
    // first load: session-only (one prompt at most); click / own action: may sign the read; timer: never prompts
    expect(code).toContain('interactive: mode === "manual" ? true : mode === "interactive" ? "session-only" : false');
    expect(code).toContain('type ListMode = "interactive" | "manual" | "background";');
    expect(code).toContain('onClick={() => void loadRequests("manual")}');
    expect(code).not.toContain('onClick={() => void loadRequests("interactive")}');
    // the automatic first load is the only bare call
    expect(code.match(/void loadRequests\(\);/g) ?? []).toHaveLength(1);
    expect(code).toContain("shouldPollConversions({");
    expect(code).toContain('addEventListener("visibilitychange"');
    expect(code).toContain("HOLDER_CONVERSION_POLL_MS");
    expect(code).toContain("err instanceof WalletSessionRequiredError");
    expect(code).toContain('{listError.kind === "session" ? "Sign in" : "Retry loading"}');
  });

  it("gives Cancel its own busy state and the custody window its own words, in the branch order the row keeps", () => {
    expect(code).toContain("busy={cancelBusy !== null}");
    expect(code).not.toContain("busy={tx.isSending}");
    expect(code).toContain("pausedFlowFor(pauseFlags, AssetRegistryInstruction.DepositToCustodyVault)");
    expect(code).toContain("Custody window is closed — Manci opens it for your deposit.");
    expect(code).not.toContain("emergency");
    const order = [
      "Receipt saved — retry recording above",
      "Vault closed — deposit disabled",
      "Deposits are paused</span>",
      "entryClosed ? (",
      "Deposit tokens",
    ].map((label) => code.indexOf(label));
    expect(order.every((at) => at > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("requires a contact in the request form, says why Submit is disabled, and reloads before the form closes", () => {
    expect(code).toContain("Contact (email or phone)");
    expect(code).toContain('aria-required="true"');
    expect(code).toContain("Add a contact so Manci can reach you.");
    expect(code).toContain("await onSuccess(created)");
    expect(code).toContain('await loadRequests("manual");');
  });
});
