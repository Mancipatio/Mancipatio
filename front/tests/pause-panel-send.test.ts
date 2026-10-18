// The pause panel's send (components/pause-flags-panel.tsx): a set_pause_flags
// is reported only after the network's answer. tx.send returns at submission,
// so the success toast, the audit row's observed_after and the host page's
// refresh wait for the confirmation (settlePauseFlagsSend, over
// lib/send-outcome confirmThenReport); a refused send is a "failed" row, an
// unconfirmed one a "pending" row, and a failed re-read afterwards is an
// info, never a failed pause. The vitest environment is node (no DOM), so
// the outcome logic and the resume copy are tested as the pure functions the
// component uses, and the component's wiring is pinned from its source.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// The panel's hooks are not exercised here; the role hook's module pulls in
// the browser Supabase client, so it is replaced like tests/kyc-only-ui.test.ts does.
vi.mock("@/lib/auth", () => ({ useRole: () => ({ isAdmin: false }) }));

import {
  CUSTODY_ENTRY_CONVERSION_OFF,
  CUSTODY_ENTRY_KYC_ONLY,
  CUSTODY_ENTRY_OPENS,
  PAUSE_CONFIRM_TIMEOUT_MS,
  resumeNotice,
  settlePauseFlagsSend,
  type PauseSendHandlers,
} from "@/components/pause-flags-panel";
import { PAUSE_CUSTODY_ENTRY, PAUSE_SECONDARY, RESUME_EVERYTHING_MASK } from "@/lib/pause-flags";
import type { SignatureOutcome } from "@/lib/simulation-gate";

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
/** Lets every settled promise chain run. */
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

/** Fakes that record the order of every call. */
function handlers(wait: () => Promise<SignatureOutcome>, over: Partial<PauseSendHandlers> = {}) {
  const order: string[] = [];
  const audits: { status: string; detail: Record<string, unknown> }[] = [];
  const h: PauseSendHandlers = {
    wait: () => { order.push("wait"); return wait(); },
    observe: async () => { order.push("observe"); return 0x76; },
    audit: async (status, detail) => { order.push(`audit:${status}`); audits.push({ status, detail }); },
    confirmed: () => void order.push("toast:confirmed"),
    failed: () => void order.push("toast:failed"),
    unconfirmed: (outcome) => void order.push(`toast:unconfirmed:${outcome}`),
    clearCache: () => void order.push("clearCache"),
    refresh: async () => void order.push("refresh"),
    refreshFailed: () => void order.push("toast:refreshFailed"),
    ...over,
  };
  return { h, order, audits };
}

describe("settlePauseFlagsSend: the outcome decides the report", () => {
  it("a delayed confirmation: no success toast, no observed read, no audit row and no refresh before the network answers", async () => {
    const gate = deferred<SignatureOutcome>();
    const { h, order, audits } = handlers(() => gate.promise);
    const done = settlePauseFlagsSend(h);
    await flush();
    expect(order).toEqual(["wait"]);
    expect(audits).toEqual([]);

    gate.resolve("confirmed");
    expect(await done).toBe("confirmed");
    await flush();
    // The toast first, then the read AFTER the confirmation, then the success row with what it saw.
    expect(order.slice(0, 3)).toEqual(["wait", "toast:confirmed", "observe"]);
    expect(order).toContain("audit:success");
    expect(audits).toEqual([{ status: "success", detail: { observed: 0x76 } }]);
    // The cache is forgotten and the page re-read after the report.
    expect(order.indexOf("clearCache")).toBeGreaterThan(order.indexOf("toast:confirmed"));
    expect(order.indexOf("refresh")).toBeGreaterThan(order.indexOf("clearCache"));
    expect(order).not.toContain("toast:failed");
    expect(order).not.toContain("toast:refreshFailed");
  });

  it("a send the network refused: the failed toast and a failed row (the flags are unchanged); the page is still re-read", async () => {
    const { h, order, audits } = handlers(async () => "failed");
    expect(await settlePauseFlagsSend(h)).toBe("failed");
    await flush();
    expect(order).toEqual(["wait", "toast:failed", "audit:failed", "clearCache", "refresh"]);
    expect(audits).toEqual([{ status: "failed", detail: { error: "refused by the network" } }]);
    expect(order).not.toContain("observe");
  });

  it.each(["timeout", "unknown"] as const)("an unconfirmed send (%s): the 'not confirmed' toast and a pending row, never a failed one", async (outcome) => {
    const { h, order, audits } = handlers(async () => outcome);
    expect(await settlePauseFlagsSend(h)).toBe(outcome);
    await flush();
    expect(order).toEqual(["wait", `toast:unconfirmed:${outcome}`, "audit:pending", "clearCache", "refresh"]);
    expect(audits).toEqual([{ status: "pending", detail: { confirmation: outcome } }]);
  });

  it("a failed re-read after a confirmed send is an info, not a failed pause: the success row stands, no failed row", async () => {
    const { h, order, audits } = handlers(async () => "confirmed", {
      refresh: async () => { order.push("refresh"); throw new Error("HTTP 429"); },
    });
    expect(await settlePauseFlagsSend(h)).toBe("confirmed");
    await flush();
    // The report, then the refresh and its info; the success row is written in the background.
    expect(order.slice(0, 5)).toEqual(["wait", "toast:confirmed", "observe", "clearCache", "refresh"]);
    expect(order.indexOf("toast:refreshFailed")).toBeGreaterThan(order.indexOf("refresh"));
    expect(audits.map((a) => a.status)).toEqual(["success"]);
    expect(order).not.toContain("toast:failed");
  });

  it("a read that fails after the confirmation records observed_after as null (the event stays authoritative); an audit write that throws is swallowed", async () => {
    const { h, audits } = handlers(async () => "confirmed", {
      observe: async () => { throw new Error("rpc"); },
    });
    expect(await settlePauseFlagsSend(h)).toBe("confirmed");
    await flush();
    expect(audits).toEqual([{ status: "success", detail: { observed: null } }]);
    const throwing = handlers(async () => "failed", { audit: async () => { throw new Error("audit down"); } });
    expect(await settlePauseFlagsSend(throwing.h)).toBe("failed");
    await flush();
    expect(throwing.order).toContain("refresh");
  });
});

describe("resumeNotice: the resume confirmation's copy", () => {
  const scope = (kycOnly: boolean, conversionOn: boolean) => ({ kycOnly, conversionOn });

  it("a single Custody entry (0x08) resume is the conversion window: what it opens, when to close it, no incident wording", () => {
    const n = resumeNotice(PAUSE_CUSTODY_ENTRY, 0x7e, scope(true, false));
    expect(n.resumes).toBe("Custody entry");
    expect(n.custody).toEqual([CUSTODY_ENTRY_OPENS, CUSTODY_ENTRY_KYC_ONLY]);
    expect(n.custody).not.toContain(CUSTODY_ENTRY_CONVERSION_OFF);
    expect(n.bootstrapCloses).toBe(false);
    expect(n.incident).toBe(false);
    expect(n.closing).toBe("The payout modules stay as they are. The reason is recorded in the audit log.");
    expect(n.closing).not.toMatch(/cause of the pause|bootstrap/);
    expect(CUSTODY_ENTRY_OPENS).toMatch(/close it \(Pause custody entry\) as soon as the deposit has landed/);
    expect(CUSTODY_ENTRY_OPENS).toMatch(/only for a specific conversion request/);
  });

  it("names the site's own refusal: KYC-only mode, else the conversion module off, else nothing", () => {
    expect(resumeNotice(PAUSE_CUSTODY_ENTRY, 0x7e, scope(false, true)).custody).toEqual([CUSTODY_ENTRY_OPENS]);
    expect(resumeNotice(PAUSE_CUSTODY_ENTRY, 0x7e, scope(false, false)).custody).toEqual([CUSTODY_ENTRY_OPENS, CUSTODY_ENTRY_CONVERSION_OFF]);
    expect(resumeNotice(PAUSE_CUSTODY_ENTRY, 0x7e, scope(true, true)).custody).toEqual([CUSTODY_ENTRY_OPENS, CUSTODY_ENTRY_KYC_ONLY]);
  });

  it("says the bootstrap window closes only while bit 7 is open", () => {
    const fresh = resumeNotice(PAUSE_CUSTODY_ENTRY, 0xff, scope(false, true));
    expect(fresh.bootstrapCloses).toBe(true);
    expect(fresh.closing).toContain("The bootstrap window closes for good.");
    expect(resumeNotice(PAUSE_CUSTODY_ENTRY, 0x7e, scope(false, true)).closing).not.toContain("bootstrap");
  });

  it("another area, or everything, is an incident: no custody sentences for 0x04, both for Resume everything", () => {
    const secondary = resumeNotice(PAUSE_SECONDARY, 0x7e, scope(false, true));
    expect(secondary).toMatchObject({ resumes: "Trading through Manci", custody: [], incident: true });
    expect(secondary.closing).toContain("Resume only once the cause of the pause is resolved.");
    const everything = resumeNotice(RESUME_EVERYTHING_MASK, 0x7e, scope(true, false));
    expect(everything.custody).toEqual([CUSTODY_ENTRY_OPENS, CUSTODY_ENTRY_KYC_ONLY]);
    expect(everything.incident).toBe(true);
    expect(everything.resumes).toContain("Custody entry");
    // 0x08 already clear: the resume clears nothing of it, so no custody sentence.
    expect(resumeNotice(PAUSE_CUSTODY_ENTRY, 0x76, scope(true, false))).toMatchObject({
      resumes: "nothing paused (it only closes the bootstrap window)", custody: [],
    });
  });
});

describe("the panel's wiring (source pins, as tests/send-outcome.test.ts does)", () => {
  const src = readFileSync(join(process.cwd(), "components/pause-flags-panel.tsx"), "utf8");
  const start = src.indexOf("async function apply(");
  const apply = src.slice(start, src.indexOf("\n  return (", start));

  it("waits for the confirmation after the send, with nothing reported in between", () => {
    const send = apply.indexOf("await tx.send(");
    const settle = apply.indexOf("await settlePauseFlagsSend(");
    expect(send).toBeGreaterThan(-1);
    expect(settle).toBeGreaterThan(send);
    const between = apply.slice(send, settle);
    for (const forbidden of ["clearPauseFlagsCache()", "toast.showTx(", "onChanged()", "observedFlags()", 'status: "success"']) {
      expect(between, forbidden).not.toContain(forbidden);
    }
    expect(apply).toContain("waitForSignature(rpc, sig, { timeoutMs: PAUSE_CONFIRM_TIMEOUT_MS, retryReads: true })");
    expect(PAUSE_CONFIRM_TIMEOUT_MS).toBe(30_000);
    // The success toast only in the confirmed handler; the audit rows through the one closure.
    expect(apply.indexOf("toast.showTx(sig")).toBeGreaterThan(apply.indexOf("confirmed: () => {"));
    expect(apply).toContain("audit: (status, detail) => audit(status, sig, detail)");
    expect(apply).toContain("refresh: onChanged");
    expect(apply).toContain('kind: "info"');
    // The wallet's or preflight's refusal is the only "failed" row written here (no signature).
    expect(apply.match(/audit\("failed"/g)).toHaveLength(1);
    expect(apply).not.toMatch(/status: "failed"/);
  });

  it("holds every button and the modal while the send is confirming", () => {
    expect(src).toContain("const busy = tx.isSending || confirming;");
    expect(src.match(/disabled=\{busy\}/g)).toHaveLength(5);
    expect(src).toContain("busy={busy}");
    expect(src).not.toContain("disabled={tx.isSending}");
    expect(apply).toContain("|| confirming) return;");
  });

  it("renders the resume copy from resumeNotice under the site's own scope", () => {
    expect(src).toContain("<ResumeDescription bits={pending.bits} flags={flags} />");
    expect(src).toContain("kycOnly: kycOnly()");
    expect(src).toContain('conversionOn: moduleEnabled("custodyConversion")');
  });
});
